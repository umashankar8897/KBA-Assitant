// Storage layer.
//
// Everything that touches saved data goes through this file. It reads and writes
// three Supabase tables — `organisations`, `profiles` and `kbas` — see
// supabase-setup.sql for the schema and the row level security policies that
// scope every query to the caller's organisation and role.
//
// All of these functions are async now, so every caller has to await them. They
// still hand back the same thing they always did: the full list of KBAs in the
// app's own shape, so app.js never sees a database row.
//
// The database and the app disagree about two field names:
//
//   database                              app
//   id             uuid                   (not used by the app at all)
//   reference      "kba-till-power"       id
//   flow           jsonb decision tree    steps
//   start_step     text                   start          ("start" is reserved in SQL)
//   issue_example  text                   issueExample
//   source_text    text                   sourceText     (text pulled out of a source PDF)
//
// rowToKBA and kbaToRow below are the only two places that know about any of
// that. Everything else in the file — and all of app.js — works in the app shape.

// Three ways the client can fail to exist before a single request is made: the
// library never arrived, config.js was never filled in, or the values in it are
// not something createClient will accept. Each needs a different thing from
// whoever is looking at the screen, so the reason is recorded rather than being
// flattened into a null.
//
// Left null in all three cases, so the app can say what happened instead of
// dying on load with an unexplained error.
let supabaseClientProblem = null;

function createSupabaseClient() {
  if (typeof supabase === "undefined") {
    supabaseClientProblem = "library-missing";
    return null;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    supabaseClientProblem = "config-missing";
    return null;
  }

  try {
    return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (error) {
    // A malformed project URL throws here rather than at the first request.
    console.error("Supabase rejected the values in config.js.", error);
    supabaseClientProblem = "config-invalid";
    return null;
  }
}

const supabaseClient = createSupabaseClient();

function rowToKBA(row) {
  return {
    id: row.reference,
    title: row.title,
    keywords: row.keywords || [],
    ...(row.issue_example ? { issueExample: row.issue_example } : {}),
    ...(row.source_text ? { sourceText: row.source_text } : {}),
    start: row.start_step,
    steps: row.flow
  };
}

function kbaToRow(kba) {
  return {
    reference: kba.id,
    title: kba.title,
    keywords: kba.keywords,
    issue_example: kba.issueExample || null,
    source_text: kba.sourceText || null,
    start_step: kba.start,
    flow: kba.steps
  };
}

// Only admins may change the KBA library. That is enforced by the security
// policies, not by this file, and it surfaces in two different ways:
//
//   - an insert blocked by a WITH CHECK policy comes back as an error, 42501
//   - an update or delete the USING clause hides simply matches no rows, and
//     reports success having changed nothing
//
// The second is the one worth being careful about: without checking how many
// rows came back, a blocked delete looks exactly like a successful one. Every
// write below therefore asks for the affected rows and treats an empty result
// as a refusal.

const NOT_ALLOWED =
  "Your account cannot change the KBA library. Ask an admin in your organisation to make the change.";

function throwIfBlocked(error) {
  if (!error) return;
  // Storage reports a refused write as a 403 rather than a Postgres error code.
  if (error.code === "42501" || String(error.statusCode) === "403" ||
      /row-level security|violates row-level/i.test(error.message || "")) {
    throw new Error(NOT_ALLOWED);
  }
  throw error;
}

// The signed-in user's profile: which organisation they are in and what they may
// do. Returned in the app's own wording rather than the row's.
async function loadProfile() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error("Not signed in.");

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, org_id, role")
    .eq("id", session.user.id)
    .single();

  if (error) throw error;
  return { id: data.id, email: session.user.email, orgId: data.org_id, role: data.role };
}

// The organisation row, for the team screen. Only admins can read it — the join
// code it carries is what lets someone add themselves to the organisation.
async function loadOrganisation() {
  const { data, error } = await supabaseClient
    .from("organisations")
    .select("id, name, join_code")
    .single();

  if (error) throw error;
  return { id: data.id, name: data.name, joinCode: data.join_code };
}

// ---------------------------------------------------------------------------
// Step screenshots
// ---------------------------------------------------------------------------
//
// Files live in a private bucket at <org_id>/<kba_reference>/<filename>, and the
// step in the flow JSON stores that path. Private means a path is not a URL: it
// has to be signed before a browser can load it.
//
// The signing happens once per library load, in a single batch, and never during
// a call. An analyst working through a KBA is on the phone; a step must not sit
// there waiting on the network to show its screenshot.

const IMAGE_BUCKET = "kba-images";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Long enough to outlast any call, short enough that a copied link goes stale.
// Re-signed on every load and after every save.
const SIGNED_URL_SECONDS = 60 * 60 * 8;

// Every screenshot path referenced by these KBAs. Used both for signing and for
// working out which files nothing points at any more.
function imagePathsIn(kbas) {
  const paths = [];

  kbas.forEach(kba => {
    Object.values(kba.steps).forEach(step => {
      if (step.image) paths.push(step.image);
    });
  });

  return paths;
}

async function signImageUrls(kbas) {
  const paths = [...new Set(imagePathsIn(kbas))];
  if (!paths.length) return {};

  const { data, error } = await supabaseClient.storage
    .from(IMAGE_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_SECONDS);

  if (error) throw error;

  const urls = {};
  data.forEach(entry => {
    // A file that has gone missing comes back carrying an error instead of a URL.
    if (entry.signedUrl && !entry.error) urls[entry.path] = entry.signedUrl;
  });
  return urls;
}

// Why a file cannot be accepted, or null if it can. Checked in the browser before
// anything is uploaded, so the admin hears about it immediately.
function describeImageProblem(file) {
  if (!file.type.startsWith("image/")) {
    return `${file.name} is not an image${file.type ? ` (it is ${file.type})` : ""}. ` +
           `A screenshot needs to be a PNG, JPEG, GIF or WebP.`;
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB and the limit is 2 MB. ` +
           `Crop it to the part that matters, or save it as a JPEG.`;
  }

  return null;
}

async function uploadStepImage(reference, file) {
  const orgId = await currentOrgId();

  // Two steps can easily hold files both called "screenshot.png", so the name is
  // prefixed rather than trusted to be unique on its own.
  const safeName = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const path = `${orgId}/${reference}/${unique}-${safeName}`;

  const { error } = await supabaseClient.storage
    .from(IMAGE_BUCKET)
    .upload(path, file, { contentType: file.type });

  throwIfBlocked(error);
  return path;
}

// Tidying up must never turn a save that worked into a save that failed, so this
// reports rather than throws. It does not pass quietly either: a file nobody
// points at, in a bucket nobody can browse, is invisible until it is a problem.
async function removeImages(paths) {
  if (!paths.length) return true;

  const { error } = await supabaseClient.storage.from(IMAGE_BUCKET).remove(paths);

  if (error) {
    console.error("Screenshots left behind in storage:", paths, error);
    return false;
  }
  return true;
}

// Everything filed under one KBA, for when the KBA itself is going.
async function removeKBAImages(reference) {
  const orgId = await currentOrgId();
  const folder = `${orgId}/${reference}`;

  const { data, error } = await supabaseClient.storage.from(IMAGE_BUCKET).list(folder);

  if (error) {
    console.error("Could not list screenshots for", folder, error);
    return false;
  }

  return removeImages(data.map(entry => `${folder}/${entry.name}`));
}

// Which organisation the signed-in user belongs to. Reads are already scoped by
// the security policies, but writes have to name the organisation explicitly so
// the upserts below have something to match on.
async function currentOrgId() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error("Not signed in.");

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("org_id")
    .eq("id", session.user.id)
    .single();

  if (error) throw error;
  return data.org_id;
}

// The single read every function returns through, so callers always get the list
// in the same order. Seeded KBAs share a timestamp, hence the tie-break on
// reference — without it their order would drift between page loads.
async function fetchKBAs() {
  const { data, error } = await supabaseClient
    .from("kbas")
    .select("*")
    .order("created_at", { ascending: true })
    .order("reference", { ascending: true });

  if (error) throw error;
  return data.map(rowToKBA);
}

async function loadKBAs(profile) {
  const kbas = await fetchKBAs();
  if (kbas.length) return kbas;

  // Nothing here yet. Only an admin seeds — that is someone who has just created
  // an organisation. An analyst joining an existing organisation takes it as it
  // is, even when that means an empty library, rather than filling someone
  // else's team with the stock KBAs.
  if (!profile || profile.role !== "admin") return [];

  return saveKBAs(DEFAULT_KBAS);
}

async function saveKBAs(kbas) {
  const orgId = await currentOrgId();

  const { data, error } = await supabaseClient
    .from("kbas")
    .upsert(kbas.map(kba => ({ ...kbaToRow(kba), org_id: orgId })), { onConflict: "org_id,reference" })
    .select("id");

  throwIfBlocked(error);
  if (!data || data.length !== kbas.length) throw new Error(NOT_ALLOWED);

  return fetchKBAs();
}

// Insert or replace one KBA, matched on its reference. Used by the editor form
// for both adding a new KBA and saving an edit to an existing one.
async function saveKBA(kba) {
  const orgId = await currentOrgId();

  const { data, error } = await supabaseClient
    .from("kbas")
    .upsert({ ...kbaToRow(kba), org_id: orgId }, { onConflict: "org_id,reference" })
    .select("id");

  throwIfBlocked(error);
  if (!data || !data.length) throw new Error(NOT_ALLOWED);

  return fetchKBAs();
}

async function deleteKBA(id) {
  // No organisation filter needed: the delete policy already limits this to the
  // caller's own rows, so a reference belonging to another organisation matches
  // nothing rather than deleting it.
  const { data, error } = await supabaseClient
    .from("kbas")
    .delete()
    .eq("reference", id)
    .select("id");

  throwIfBlocked(error);
  if (!data || !data.length) throw new Error(NOT_ALLOWED);

  return fetchKBAs();
}

async function resetKBAs() {
  const orgId = await currentOrgId();

  const { data, error } = await supabaseClient
    .from("kbas")
    .delete()
    .eq("org_id", orgId)
    .select("id");

  throwIfBlocked(error);
  // An empty library is a legitimate starting point for a reset, so only an
  // error counts as a refusal here. saveKBAs catches the blocked case next.
  if (!data) throw new Error(NOT_ALLOWED);

  return saveKBAs(DEFAULT_KBAS);
}
