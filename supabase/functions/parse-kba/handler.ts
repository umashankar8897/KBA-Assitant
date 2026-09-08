// Request handling for parse-kba: who is allowed, what is sent to Gemini, and
// what comes back.
//
// Everything the outside world provides — the environment, the Supabase client,
// fetch — arrives as a dependency rather than being reached for directly, so
// this file has no import that ties it to one runtime and can be exercised
// without a network or a project.

import { PROMPT, RESPONSE_SCHEMA, checkDraft } from "./draft.ts";

export type Deps = {
  env: (name: string) => string | undefined;
  createClient: (url: string, key: string, options: unknown) => any;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

// Gemini accepts around 20MB in a request. This leaves room for the prompt and
// base64's overhead, and a KBA far larger than this is a different problem from
// the one being solved here.
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, ...extra, "Content-Type": "application/json" }
  });
}

// One shape for every failure so the client has one thing to read. `retryable`
// says whether the same request could work on a second attempt.
function fail(status: number, error: string, detail: unknown = null, retryable = false,
              extra: Record<string, string> = {}): Response {
  return json({ error, detail, retryable }, status, extra);
}

// Signed in, and an admin of their organisation. Checked with the caller's own
// token against the anon key, so the row level security policies apply exactly
// as they do in the browser.
async function requireAdmin(req: Request, deps: Deps): Promise<Response | null> {
  const authorization = req.headers.get("Authorization");
  if (!authorization) return fail(401, "Not signed in.");

  const supabase = deps.createClient(
    deps.env("SUPABASE_URL") || "",
    deps.env("SUPABASE_ANON_KEY") || "",
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return fail(401, "Your session is not valid. Sign in again.");

  const { data: profile, error: profileError } = await supabase
    .from("profiles").select("role").eq("id", userData.user.id).single();

  if (profileError || !profile) return fail(403, "No profile found for your account.");
  if (profile.role !== "admin") return fail(403, "Only an admin can draft a KBA from a document.");

  return null;
}

async function askGemini(pdfBase64: string, deps: Deps): Promise<Response | { text: string }> {
  const model = deps.env("GEMINI_MODEL") || "gemini-2.0-flash";
  const apiKey = deps.env("GEMINI_API_KEY") || "";

  const response = await deps.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            // Sent whole. Gemini reads the pages itself, scans included, which is
            // the point of not extracting text first.
            { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
            { text: PROMPT }
          ]
        }],
        generationConfig: {
          // Reading a document, not writing prose: the same PDF should give the
          // same draft twice.
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA
        }
      })
    }
  );

  if (response.status === 429) {
    // The free tier allows roughly ten to fifteen a minute across everyone using
    // the project. Passing the hint through lets the client say how long.
    const retryAfter = response.headers.get("Retry-After");
    return fail(429,
      "The drafting service is busy. It takes about ten to fifteen documents a minute across " +
      "everyone using this project, so wait a moment and try again.",
      retryAfter ? { retryAfterSeconds: Number(retryAfter) } : null,
      true,
      retryAfter ? { "Retry-After": retryAfter } : {});
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Gemini returned", response.status, detail.slice(0, 500));

    // A rejected key is not something waiting will fix.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return fail(502, "The drafting service rejected the request. Its API key may be wrong, " +
        "or the project may be out of quota.", null, false);
    }
    return fail(502, "The drafting service could not be reached. Try again in a moment.", null, true);
  }

  const body = await response.json().catch(() => null);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== "string" || !text.trim()) {
    const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason || null;
    console.error("Gemini returned nothing usable.", JSON.stringify(body).slice(0, 1000));
    return fail(502,
      reason === "SAFETY" || reason === "PROHIBITED_CONTENT"
        ? "The drafting service declined to read this document."
        : "The drafting service returned nothing usable for this document.",
      reason, true);
  }

  return { text };
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "Use POST.");

  if (!deps.env("GEMINI_API_KEY")) {
    console.error("GEMINI_API_KEY is not set on this function.");
    return fail(500, "Drafting is not set up on the server: GEMINI_API_KEY is missing.");
  }

  // Before the file is even looked at, let alone sent anywhere.
  const refusal = await requireAdmin(req, deps);
  if (refusal) return refusal;

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "The request body was not JSON.");
  }

  const pdfBase64 = typeof payload?.pdf === "string" ? payload.pdf.trim() : "";
  if (!pdfBase64) return fail(400, "No PDF was sent.");

  // base64 carries three bytes in every four characters.
  const approximateBytes = Math.floor(pdfBase64.length * 3 / 4);
  if (approximateBytes > MAX_PDF_BYTES) {
    return fail(413,
      `That PDF is about ${(approximateBytes / 1024 / 1024).toFixed(1)} MB and the limit is ` +
      `${MAX_PDF_BYTES / 1024 / 1024} MB. Send just the pages describing the procedure.`);
  }

  const answer = await askGemini(pdfBase64, deps);
  if (answer instanceof Response) return answer;

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    console.error("Gemini did not return JSON:", answer.text.slice(0, 1000));
    return fail(502, "The drafting service did not return a usable draft for this document.", null, true);
  }

  // Either the draft would build a sound flow, or this is an error. Nothing
  // half-formed goes back for an admin to save by accident.
  const { draft, problems } = checkDraft(parsed);

  if (!draft) {
    console.error("Draft rejected:", problems.join("; "));
    return fail(422,
      "This document could not be read as a KBA. It may not describe a procedure with steps to " +
      "work through, or it may be too unclear to draft from. Fill the form in by hand.",
      problems, true);
  }

  return json({ draft, uncertain: draft.uncertain }, 200);
}
