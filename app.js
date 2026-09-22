// The live list of KBAs, in the app's own shape. Filled in from storage once the
// user signs in, and reassigned whenever KBAs are added, edited or deleted.
// Empty until then, so nothing here reads it before showSignedIn has run.
let KBAS = [];

// The signed-in user: id, email, orgId and role ("admin" or "analyst"). Null
// while signed out. Everything role-dependent reads isAdmin() rather than this
// directly, so a missing profile falls to the smaller set of permissions.
let profile = null;

// Screenshot path -> signed URL, for every KBA currently loaded. Filled in once
// per library load so the call screen never waits on the network.
let IMAGE_URLS = {};

function isAdmin() {
  return profile !== null && profile.role === "admin";
}

function showMessage(slotId, text, kind) {
  const el = document.getElementById(slotId);
  if (!el) return;
  el.className = `message message-${kind || "problem"}`;
  el.textContent = text;
  el.hidden = false;
}

// Not a retry — the action here changes screens entirely rather than trying
// the same thing again, so this is its own small helper rather than a reuse
// of showRetryableMessage's disable-and-relabel behaviour.
function showActionNotice(slotId, text, actionLabel, onAction) {
  const el = document.getElementById(slotId);
  if (!el) return;

  el.className = "message message-notice";
  el.innerHTML = `<p class="message-text"></p><button class="btn btn-primary btn-small" data-action></button>`;
  el.querySelector(".message-text").textContent = text;

  const button = el.querySelector("[data-action]");
  button.textContent = actionLabel;
  button.addEventListener("click", onAction);

  el.hidden = false;
}

function showRetryableMessage(slotId, text, actionLabel, onRetry) {
  const el = document.getElementById(slotId);
  if (!el) return;

  el.className = "message message-problem";
  el.innerHTML = `<p class="message-text"></p><button class="btn btn-ghost btn-small" data-retry></button>`;
  el.querySelector(".message-text").textContent = text;

  const button = el.querySelector("[data-retry]");
  button.textContent = actionLabel;
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Trying\u2026";
    onRetry();
  });

  el.hidden = false;
}

function clearMessage(slotId) {
  const el = document.getElementById(slotId);
  if (el) el.hidden = true;
}

// Every storage call is a network round trip now, and any of them can fail. This
// keeps that handling in one place: on success the caller gets true and the KBA
// list is already up to date, on failure it gets false and KBAS is untouched.
// slotId says where a failure should be reported, so the message lands beside
// whatever the analyst was doing rather than in a dialog over the whole page.
async function runStorageAction(action, slotId = "app-message", retry = null) {
  document.body.classList.add("is-busy");

  try {
    KBAS = await action();

    // Signing is a separate concern from the write that just succeeded. If it
    // fails, screenshots go missing; the KBA itself is still fine.
    try {
      IMAGE_URLS = await signImageUrls(KBAS);
    } catch (error) {
      console.error("Could not sign screenshot URLs.", error);
      IMAGE_URLS = {};
    }

    clearMessage(slotId);
    return true;
  } catch (error) {
    console.error(error);

    const configuration = classifyFailure(error) === FAILURE_CONFIGURATION;
    const text = configuration
      ? `Supabase refused the request. That usually means the project URL or anon key in config.js ` +
        `is wrong, or your account no longer has access. ${error.message || error}`
      : `The KBA library could not be reached. That is usually a connection problem rather than ` +
        `anything wrong with the app. ${error.message || error}`;

    if (retry) showRetryableMessage(slotId, text, configuration ? "Reload" : "Try again",
      configuration ? () => window.location.reload() : retry);
    else showMessage(slotId, text);

    return false;
  } finally {
    document.body.classList.remove("is-busy");
  }
}

const state = {
  issueText: "",
  matches: [],
  selectedKBA: null,
  currentStepId: null,
  log: [],
  captured: {},
  // The label of the check the issue resolved after, when an analyst ends the
  // call early. Empty on every other path, including a normal resolve at the
  // final question.
  resolvedAfter: "",
  // Why a step could not be carried out, when that is what ended the call.
  // Empty on every other path. Never set at the same time as resolvedAfter:
  // a call either got fixed or got stuck, not both.
  blockedReason: "",
  // What the analyst noted at each record step, keyed by that step's label.
  // Held here rather than on the log entries so those stay {label, answer},
  // and so a capture field of the same name can be filled in from it.
  recorded: {}
};

// ---------------------------------------------------------------------------
// Warning before an in-progress call is lost
// ---------------------------------------------------------------------------
//
// Armed as soon as the analyst has answered the first step of a matched KBA,
// and stays armed through the review screen until the description has been
// copied out — that is the point a call is actually done with, not merely the
// point a ticket badge appears on screen.
//
// The browser's own beforeunload confirmation is used rather than a custom
// modal: a page cannot reliably stop a refresh, tab close or back button with
// anything it draws itself, and the native prompt is the one thing that can.
// This only warns — it never persists or recovers the call, so a confirmed
// refresh still discards everything.
let callGuardArmed = false;

function armCallGuard() {
  callGuardArmed = true;
}

function disarmCallGuard() {
  callGuardArmed = false;
}

window.addEventListener("beforeunload", event => {
  if (!callGuardArmed) return;
  event.preventDefault();
  // Chrome has not shown a custom string here in years, but still requires
  // returnValue to be set before it will show its own confirmation.
  event.returnValue = "";
});

// Every place a step gets logged during the flow goes through here, so arming
// the guard is not something each of those call sites has to remember to do.
function logStep(entry) {
  state.log.push(entry);
  if (!previewMode) armCallGuard();
}

// The one place a capture field's value changes from something the analyst
// typed, so a future way of rendering the review fields cannot bypass arming
// the guard the way a stray state.captured[f] = ... assignment could. Covers
// the KBA that goes straight from selection to an outcome with no steps
// logged at all — without this, typing into its capture fields would leave
// the call unguarded.
function recordCapturedField(field, value, outcomeStep) {
  state.captured[field] = value;
  if (!previewMode) armCallGuard();
  renderDescription(outcomeStep);
}

// Used only when a KBA offers no resolve outcome at all from where the analyst
// is standing. Every KBA the form builds has one, so this is a backstop for
// hand-authored flows rather than something the app expects to reach.
const FALLBACK_RESOLVE = { type: "outcome", outcome: "resolve" };
const FALLBACK_ESCALATE = { type: "outcome", outcome: "escalate" };

// The outcome of a given kind this call was heading for. Ending a call early
// lands on the ending the KBA defines, so the review screen asks for that
// outcome's capture fields and carries its note, exactly as working through
// every step would.
//
// Breadth first, so when a KBA branches to several endings of the same kind the
// nearest one along the paths still ahead wins rather than whichever happens to
// be first in the object.
function findOutcome(kba, fromStepId, outcome) {
  const queue = [fromStepId];
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const step = kba.steps[id];
    if (!step) continue;

    if (step.type === "outcome") {
      if (step.outcome === outcome) return step;
      continue;                                   // an ending of some other kind
    }

    if (step.type === "question") (step.options || []).forEach(option => queue.push(option.next));
    else queue.push(step.next);
  }

  return null;
}

function findResolveOutcome(kba, fromStepId) {
  return findOutcome(kba, fromStepId, "resolve");
}

function findEscalateOutcome(kba, fromStepId) {
  return findOutcome(kba, fromStepId, "escalate");
}

// Words that carry nothing about the fault. Stripped from what the analyst types
// before any word-by-word scoring, so a sentence of scene-setting does not
// dilute the two or three words that actually name the symptom.
//
// Only the typed text is filtered, never the KBA's keywords, and never before
// the whole-phrase check below — so "turn on" still matches even though "on" is
// in here.
const NOISE_WORDS = new Set([
  // How an analyst frames what they were told.
  "user", "users", "caller", "customer", "colleague", "store", "mentioned",
  "said", "says", "saying", "told", "reported", "reports", "reporting",
  "called", "calling", "rang", "raised", "asked", "asking", "wants", "needs",
  // Pronouns and articles.
  "i", "me", "my", "we", "our", "us", "you", "your", "he", "him", "his",
  "she", "her", "hers", "they", "them", "their", "it", "its",
  "a", "an", "the", "this", "that", "these", "those", "there", "here",
  // Verbs and helpers that appear in nearly every sentence.
  "is", "are", "was", "were", "be", "been", "being", "am",
  "has", "have", "had", "do", "does", "did", "doing", "done",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "get", "gets", "getting", "got", "go", "goes", "going", "went",
  "able", "unable", "trying", "tried", "try", "keeps", "keep",
  // Joining words.
  "and", "or", "but", "so", "then", "than", "if", "when", "while", "because",
  "as", "of", "in", "on", "at", "to", "into", "onto", "for", "with", "from",
  "by", "about", "after", "before", "over", "under", "up", "down", "out",
  "off", "again", "still", "also", "just", "very", "really", "any", "some",
  "no", "not", "now", "today", "yesterday", "morning", "please", "thanks",
  "hi", "hello", "issue", "issues", "problem", "problems", "help"
]);

// Two points a word for a whole phrase, one for a word found on its own, so a
// KBA whose exact phrase appears always outscores one that only shares words
// with the sentence.
const PHRASE_POINTS = 2;
const WORD_POINTS = 1;

// One exact single-word keyword is worth showing. Below that a match is a guess,
// and a guess sends an analyst down the wrong procedure with a caller waiting.
// Nothing above this bar means the honest "no confident match", which already
// offers the library to search.
const MINIMUM_SCORE = 2;

function wordsIn(text) {
  return String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
}

// Does this run of words appear in that one, consecutively? Whole words rather
// than a substring, so the keyword "bo" no longer matches inside "about".
function containsPhrase(words, phrase) {
  if (!phrase.length || phrase.length > words.length) return false;

  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

function scoreKBA(kba, text) {
  // Phrases are looked for in what was actually typed; single words in what is
  // left once the filler is gone.
  const spoken = wordsIn(text);
  const meaningful = new Set(spoken.filter(word => !NOISE_WORDS.has(word)));

  let score = 0;

  (kba.keywords || []).forEach(keyword => {
    const parts = wordsIn(keyword);
    if (!parts.length) return;

    if (containsPhrase(spoken, parts)) {
      score += PHRASE_POINTS * parts.length;
      return;
    }

    // Partial credit: how much of this keyword turned up anywhere in the text.
    score += WORD_POINTS * parts.filter(part => meaningful.has(part)).length;
  });

  return score;
}

function findMatches(text) {
  return KBAS
    .map(kba => ({ kba, score: scoreKBA(kba, text) }))
    .filter(m => m.score >= MINIMUM_SCORE)
    .sort((a, b) => b.score - a.score);
}

// KBA text is written by analysts through the editor now, so anything that ends up
// inside innerHTML has to be escaped first — a title with a quote or an angle
// bracket in it would otherwise break the markup around it.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Search is deliberately not the same thing as matching. findMatches scores a
// description of a call against keywords; this looks for text the analyst typed
// on purpose, across the three fields they would recognise a KBA by.
//
// Every term has to appear somewhere, so "till power" finds a KBA whose title
// carries one word and whose keywords carry the other.
function searchKBAs(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return KBAS.filter(kba => {
    const haystack = [kba.id, kba.title, ...kba.keywords].join(" ").toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

// One card per result, shared by the intake search and any other list of KBAs
// the analyst picks from.
function kbaResultCards(kbas, buttonLabel) {
  return kbas.map(kba => `
    <div class="match-card alt">
      <div class="match-head">
        <div>
          <p class="match-title small">${escapeHtml(kba.title)}</p>
          <p class="match-sub">${escapeHtml(kba.id)}</p>
        </div>
        <button class="btn btn-ghost btn-small" data-select="${escapeHtml(kba.id)}">${buttonLabel}</button>
      </div>
    </div>
  `).join("");
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function setPrimary(id, isPrimary) {
  const el = document.getElementById(id);
  el.classList.toggle("btn-primary", isPrimary);
  el.classList.toggle("btn-ghost", !isPrimary);
}

function renderIntake() {
  const results = document.getElementById("match-results");
  results.innerHTML = "";
  setPrimary("find-kba", !state.matches.length);
  if (!state.matches.length) {
    // The library used to be tipped out in full at this point. Searching it is
    // the better answer, and the box for that is directly below.
    results.innerHTML = state.issueText.trim()
      ? `<p class="muted">No confident match for that description. Try searching the library below.</p>`
      : `<p class="muted">Describe the call above, or search the library below.</p>`;
    return;
  }
  const [top, ...rest] = state.matches;
  const topDiv = document.createElement("div");
  topDiv.className = "match-card top";
  topDiv.innerHTML = `
    <div class="match-head">
      <div>
        <p class="match-title">${escapeHtml(top.kba.title)}</p>
        <p class="match-sub">${escapeHtml(top.kba.id)}</p>
      </div>
      <span class="badge badge-success">Best match</span>
    </div>
    <button class="btn btn-primary" data-select="${escapeHtml(top.kba.id)}">Start troubleshooting</button>
  `;
  results.appendChild(topDiv);

  if (rest.length) {
    const altLabel = document.createElement("p");
    altLabel.className = "muted small";
    altLabel.textContent = "Other possible matches";
    results.appendChild(altLabel);
    rest.forEach(m => {
      const div = document.createElement("div");
      div.className = "match-card alt";
      div.innerHTML = `
        <p class="match-title small">${escapeHtml(m.kba.title)}</p>
        <button class="btn btn-ghost btn-small" data-select="${escapeHtml(m.kba.id)}">Use this instead</button>
      `;
      results.appendChild(div);
    });
  }
  results.querySelectorAll("[data-select]").forEach(btn => {
    btn.addEventListener("click", () => selectKBA(btn.dataset.select));
  });
}

function renderSearchResults() {
  const query = document.getElementById("kba-search").value;
  const resultsEl = document.getElementById("search-results");
  const found = searchKBAs(query);

  if (!query.trim()) {
    resultsEl.innerHTML = `<p class="muted small">${KBAS.length} KBA${KBAS.length === 1 ? "" : "s"} in the library.</p>`;
    return;
  }

  if (!found.length) {
    resultsEl.innerHTML = `<p class="muted small">Nothing matches &ldquo;${escapeHtml(query.trim())}&rdquo;.</p>`;
    return;
  }

  resultsEl.innerHTML =
    `<p class="muted small">${found.length} of ${KBAS.length} KBAs</p>` +
    kbaResultCards(found, "Start");

  resultsEl.querySelectorAll("[data-select]").forEach(btn => {
    btn.addEventListener("click", () => selectKBA(btn.dataset.select));
  });
}

function selectKBA(id) {
  // The intake box has nothing to do with a preview — there was no intake
  // screen on the way here — so this is the one line of the real selection
  // path that previewing has to answer differently rather than reuse.
  state.issueText = previewMode ? "" : document.getElementById("issue-text").value;
  state.selectedKBA = KBAS.find(k => k.id === id);
  state.currentStepId = state.selectedKBA.start;
  state.log = [];
  state.captured = {};
  state.resolvedAfter = "";
  state.blockedReason = "";
  state.recorded = {};
  showScreen("screen-flow");
  renderFlowStep();
}

// ---------------------------------------------------------------------------
// Previewing a KBA
// ---------------------------------------------------------------------------
//
// Runs the exact same guided flow a real call uses — selectKBA and
// renderFlowStep below are not touched for this, beyond the one line above
// that has no intake box to read from here. Three narrow differences are
// threaded through the few places that need to know about them: nothing here
// arms the call-in-progress guard, the flag control does not appear (an admin
// previewing can fix the KBA directly rather than flag it), and the review
// screen leads back to the library instead of offering a description there
// is no ticket to copy.

let previewMode = false;

function enterPreview(kba) {
  previewMode = true;
  document.getElementById("preview-banner").hidden = false;
  selectKBA(kba.id);
}

function exitPreview() {
  previewMode = false;
  document.getElementById("preview-banner").hidden = true;
}

// ---------------------------------------------------------------------------
// Recovering from a Supabase failure mid-call
// ---------------------------------------------------------------------------
//
// Two things in the call flow reach Supabase on their own, separately from
// the KBA fetch at the start of the call: flagging a step, and loading a
// step's screenshot. Either can fail because the analyst's session has
// expired, because the network dropped, or for some other reason — and those
// need different responses. An expired session is fixed by signing back in;
// a dropped connection is fixed by trying again once it is back; neither is
// helped by discarding the call or leaving the step, so nothing here does
// that. state.log, state.selectedKBA and state.captured are never touched by
// any of this — there is still no persistence for an in-progress call.

// Distinguishes what actually went wrong from the shape of the error alone.
// Separate from classifyFailure, which answers a different question — that
// one runs before any session exists at all, so a 401 there can only mean a
// bad anon key. Here a session already exists, so the same kind of error
// almost always means it has expired rather than that the app is misconfigured.
function classifySessionError(error) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network";

  // Storage errors carry their HTTP status as a string ("403", not 403) —
  // the same reason throwIfBlocked in storage.js coerces before comparing.
  // Missing this meant a real expired-session error from loading a
  // screenshot never matched here, and fell through to the generic message
  // instead of the sign-in prompt.
  const status = String(
    (error && (error.status || error.statusCode || (error.context && error.context.status))) || ""
  );
  // error.code carries PostgREST's own short codes (PGRST301 for an expired
  // JWT); error.message is not always where that shows up.
  const text = String((error && (error.message || error.code)) || error || "").toLowerCase();

  if (status === "401" || status === "403" ||
      /jwt|pgrst301|unauthorized|forbidden|not authenticated|not signed in|no session|refresh_token|invalid refresh token|session.*expired|expired.*session/.test(text)) {
    return "auth";
  }

  if (/failed to fetch|networkerror|network request failed|load failed|err_|timeout|timed out|offline|dns/.test(text)) {
    return "network";
  }

  return "other";
}

// Classifies the error and renders whichever recovery belongs in container:
// the shared sign-in overlay for an expired session, or a message with a
// plain retry button for a dropped connection or anything else. retry is
// called with no arguments and is expected to run the whole attempt over
// again — including this same recovery step, if it fails again the same way.
// onCancel is optional and only used by the auth case: it runs if the
// analyst backs out of the sign-in overlay without signing in, for a caller
// that needs to undo something — like re-enabling a disabled Send button —
// left over from the attempt that failed in the first place.
function renderSessionRecovery(container, error, retry, onCancel) {
  console.error(error);
  const kind = classifySessionError(error);

  if (kind === "auth") {
    // The overlay is shared and page-level, not written into container — the
    // point of it is to sit on top of the step, not replace whatever was
    // already showing in the popover or image slot underneath.
    container.hidden = true;
    openReauthModal(retry, onCancel);
    return;
  }

  const message = kind === "network"
    ? "Could not reach the server. Check the connection and try again."
    : `Something went wrong. ${error.message || error}`;

  container.innerHTML = `
    <p class="errors small tight" data-recovery-message></p>
    <button type="button" class="btn btn-ghost btn-small" data-recovery-retry>Try again</button>
  `;
  container.querySelector("[data-recovery-message]").textContent = message;
  container.querySelector("[data-recovery-retry]").addEventListener("click", retry, { once: true });
  container.hidden = false;
}

// ---------------------------------------------------------------------------
// Signing back in mid-call
// ---------------------------------------------------------------------------
//
// One shared overlay for exactly one situation: the analyst's own session has
// expired while flagging a step or loading a screenshot. Reuses the same
// email and password fields as the main sign-in form on #screen-auth — not
// that form itself, since nobody creating an account or joining an
// organisation belongs here, only signing back into the one already in use —
// laid over the step with the same modal the "cannot perform this check"
// prompt already uses, so the step underneath is never replaced, only
// covered until this closes.

// { retry, onCancel, returnFocus } while the modal is open, otherwise null.
// retry is called with no arguments on a successful sign-in — it is whatever
// failed the first time, run again. onCancel is different: it only runs if
// the analyst backs out without signing in, and exists for exactly one
// reason — the flag popover's Send button and reason box are disabled from
// the moment Send was first clicked, and this overlay is now independent of
// that popover's own open/close lifecycle, so nothing else would re-enable
// them if this closes without a retry ever running.
let reauthContext = null;

function openReauthModal(retry, onCancel) {
  reauthContext = { retry, onCancel, returnFocus: document.activeElement };

  document.getElementById("reauth-email").value = "";
  document.getElementById("reauth-password").value = "";
  document.getElementById("reauth-error").hidden = true;
  document.getElementById("reauth-modal").hidden = false;
  document.getElementById("reauth-email").focus();
}

// Used by the successful sign-in path only — deliberately does not run
// onCancel, since signing in is the opposite of backing out.
function closeReauthModal() {
  document.getElementById("reauth-modal").hidden = true;

  const returnFocus = reauthContext && reauthContext.returnFocus;
  reauthContext = null;

  // Back to whatever had focus before this opened — the flag's Send button,
  // or nothing in particular for an image — rather than dropping a keyboard
  // user at the top of the page.
  if (returnFocus && returnFocus.isConnected) returnFocus.focus();
}

// Cancel, the backdrop and Escape all back out without signing in.
function cancelReauthModal() {
  const onCancel = reauthContext && reauthContext.onCancel;
  closeReauthModal();
  if (onCancel) onCancel();
}

document.getElementById("reauth-cancel").addEventListener("click", cancelReauthModal);

// The backdrop only — a click inside the dialog should not dismiss it.
document.getElementById("reauth-modal").addEventListener("click", event => {
  if (event.target.id === "reauth-modal") cancelReauthModal();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && reauthContext) cancelReauthModal();
});

document.getElementById("reauth-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!reauthContext) return;

  const email = document.getElementById("reauth-email").value.trim();
  const password = document.getElementById("reauth-password").value;
  const button = document.getElementById("reauth-submit");
  const errorEl = document.getElementById("reauth-error");

  button.disabled = true;
  button.textContent = "Signing in\u2026";
  errorEl.hidden = true;

  // Deliberately the plain call, not the main auth form's submit handler —
  // that one also carries sign-up, join codes and organisation names, none
  // of which apply to signing back into an account already in use. Signing
  // in as the same user this quietly resumes into is a no-op for the rest
  // of the app: applySession already skips re-loading anything when the
  // signed-in user id has not changed, which is exactly what leaves the
  // current step undisturbed.
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

  button.disabled = false;
  button.textContent = "Sign in";

  if (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    return;
  }

  // Signed back in. Close the overlay, then retry the one thing that
  // actually failed — and nothing else — leaving the step exactly as it was.
  const retry = reauthContext.retry;
  closeReauthModal();
  retry();
});

// ---------------------------------------------------------------------------
// A step's screenshot
// ---------------------------------------------------------------------------
//
// The library's whole set of screenshots is still signed once, up front,
// when the KBA is fetched at the start of a call — that has not changed.
// This is only for when a single step's cached URL turns out not to work by
// the time the analyst actually reaches it: the session may have expired
// since, or the link may simply have run past its 8 hours. Either way, the
// fix is scoped to the one image, never a re-fetch of the whole KBA.

function loadStepImage(step, slot) {
  const cached = IMAGE_URLS[step.image];

  if (cached) {
    showStepImage(slot, cached, step, false);
    return;
  }

  slot.innerHTML = `<p class="muted small tight">Loading screenshot&hellip;</p>`;
  trySigningStepImage(step, slot, false);
}

function showStepImage(slot, url, step, isRetry) {
  slot.innerHTML = `<figure class="step-image"><img src="${escapeHtml(url)}" alt="Screenshot for this step" /></figure>`;

  slot.querySelector("img").addEventListener("error", () => {
    if (isRetry) {
      // Already tried signing it again once for this render; a second broken
      // load in a row means the file itself is the problem, not the link.
      slot.innerHTML = "";
      return;
    }
    trySigningStepImage(step, slot, true);
  }, { once: true });
}

async function trySigningStepImage(step, slot, isRetry) {
  try {
    const urls = await signImagePaths([step.image]);

    if (urls[step.image]) {
      // Kept for the rest of the library too, not just this one render — the
      // next step with the same screenshot, or a later visit to this one,
      // should not have to sign it again a moment later.
      IMAGE_URLS[step.image] = urls[step.image];
      showStepImage(slot, urls[step.image], step, isRetry);
    } else {
      // Signed without error, but the file itself is not there any more.
      slot.innerHTML = "";
    }
  } catch (error) {
    slot.innerHTML = `<div data-recovery></div>`;
    renderSessionRecovery(slot.querySelector("[data-recovery]"), error,
      () => trySigningStepImage(step, slot, isRetry));
  }
}

// ---------------------------------------------------------------------------
// Flagging a step
// ---------------------------------------------------------------------------
//
// A quiet, always-available way to say "something is wrong with this step"
// without breaking off a live call to explain it. One optional line, sent the
// moment it is submitted — there is no confirmation to get past, and nothing
// here waits on, or is waited on by, any of the step's other buttons.
//
// The write is durable the instant it succeeds, so unlike the rest of the
// call's state this never needs to arm the call-in-progress guard: closing
// the tab after flagging loses nothing, because there is nothing left to lose.

// Icon-sized, so this reads as a utility next to "mark done" and "issue
// resolved" rather than a third option of the same weight. U+2691, a plain
// flag glyph rather than a coloured emoji, to stay in the same quiet,
// monochrome register as the rest of the app's icon-free buttons.
function flagControlMarkup() {
  if (previewMode) return "";
  return `
    <div class="flag-control">
      <button type="button" class="btn btn-quiet btn-icon" id="flow-flag-toggle"
              title="Flag this step" aria-label="Flag this step" aria-expanded="false">&#9873;</button>
    </div>
  `;
}

function flagPopoverMarkup() {
  if (previewMode) return "";
  return `
    <div class="flag-popover" id="flow-flag-popover" hidden>
      <label class="field-label" for="flow-flag-reason">What's wrong, briefly? <span class="hint">optional</span></label>
      <div class="flag-popover-row">
        <input type="text" id="flow-flag-reason" maxlength="${MAX_FLAG_REASON_LENGTH}" autocomplete="off"
               placeholder="A word or two is enough" />
        <button type="button" class="btn btn-primary btn-small" id="flow-flag-send">Send</button>
      </div>
      <p class="muted small tight" id="flow-flag-note" hidden></p>
    </div>
  `;
}

// Wires up whichever flag control is currently in the DOM. Both step branches
// in renderFlowStep insert exactly one of these, so there is only ever one to
// wire — this does not need to know which kind of step it is attached to.
function wireFlagControl(kba, step) {
  if (previewMode) return;                 // there is no control in the DOM to wire

  const toggle = document.getElementById("flow-flag-toggle");
  const popover = document.getElementById("flow-flag-popover");
  const input = document.getElementById("flow-flag-reason");
  const send = document.getElementById("flow-flag-send");
  const note = document.getElementById("flow-flag-note");

  const openPopover = () => {
    popover.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    input.value = "";
    // Reopening always starts clean, even if the last attempt from here
    // ended mid-recovery — otherwise a closed, disabled input from a failed
    // send would stay disabled and unfocusable the next time this opens.
    input.disabled = false;
    send.disabled = false;
    note.hidden = true;
    input.focus();
  };

  const closePopover = () => {
    popover.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", () => {
    if (popover.hidden) openPopover();
    else closePopover();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); send.click(); }
    if (event.key === "Escape") { event.preventDefault(); closePopover(); toggle.focus(); }
  });

  // input.value is re-read fresh each time this runs, so a retry — whether
  // from signing back in or from a plain "try again" — resubmits exactly
  // what was typed the first time, without the analyst having to type it in
  // again or the popover needing to remember it separately.
  const trySendingFlag = async () => {
    try {
      await flagStep(kba.id, step.label || step.text, input.value);

      closePopover();
      // A quiet, momentary acknowledgement rather than anything that needs
      // dismissing — the call carries straight on regardless of whether
      // anyone notices it.
      toggle.classList.add("flag-toggle-sent");
      toggle.title = "Flagged";
      toggle.setAttribute("aria-label", "Flagged");
    } catch (error) {
      renderSessionRecovery(note, error, trySendingFlag, () => {
        // Only reached if the sign-in overlay is cancelled rather than
        // completed — a successful sign-in retries the flag instead, which
        // leaves the popover in whatever state that attempt ends in.
        send.disabled = false;
        input.disabled = false;
      });
    }
  };

  send.addEventListener("click", () => {
    send.disabled = true;
    input.disabled = true;
    note.hidden = true;
    trySendingFlag();
  });
}

// ---------------------------------------------------------------------------
// An optional note on a step
// ---------------------------------------------------------------------------
//
// Separate from flagging and from "cannot perform this check" — both of
// those exist because something is wrong enough to need attention or to end
// the call. This is for a step that went fine but not cleanly: completed,
// but worth a line explaining how. Always visible, since it's one field, but
// its placeholder and label make clear it's optional. Only ever attached at
// the moment the step is actually completed — "Issue resolved" and "cannot
// perform" are their own endings with their own wording, and do not pick
// this up.

function stepCommentMarkup() {
  return `
    <div class="step-comment">
      <label class="field-label" for="step-comment-input">
        Note <span class="hint">optional — shown under this check in the description</span>
      </label>
      <input type="text" id="step-comment-input" autocomplete="off"
             placeholder="Optional note — e.g. took three attempts, base unit was warm to touch" />
    </div>
  `;
}

// Whatever is currently typed in the step's note field, trimmed — "" if the
// step doesn't render one at all, same as if it was left empty.
function currentStepComment() {
  const input = document.getElementById("step-comment-input");
  return input ? input.value.trim() : "";
}

// Folds a comment into a log entry only if there is one, so an entry with
// nothing typed comes out exactly as it always has — {label, answer}, no
// comment key at all — rather than carrying an empty or undefined one.
function withComment(entry, comment) {
  const trimmed = (comment || "").trim();
  return trimmed ? { ...entry, comment: trimmed } : entry;
}

function renderFlowStep() {
  const kba = state.selectedKBA;
  const step = kba.steps[state.currentStepId];

  document.getElementById("flow-title").textContent = kba.title;

  const logEl = document.getElementById("flow-log");
  logEl.innerHTML = state.log
    .map((e, i) => `<div class="log-item"><i class="ti ti-check"></i><span>${i + 1} - ${escapeHtml(e.label)}${e.answer !== undefined ? ` - ${escapeHtml(e.answer)}` : ""}</span></div>`)
    .join("");

  const stepEl = document.getElementById("flow-step");

  if (!step) {
    stepEl.innerHTML = `
      <div class="message message-problem">
        <p class="message-text">This KBA is broken: step "${escapeHtml(state.currentStepId)}" does not exist.</p>
        <p>Something earlier points at it with a "next" that does not match any real step id.
        Check the KBA's steps${previewMode ? " and fix the pointer" : ""}.</p>
      </div>
    `;
    return;
  }

  if (step.type === "outcome") {
    goToReview(step);
    return;
  }

  if (step.type === "action" || step.type === "record") {
    // A record step asks for a value rather than a confirmation. Everything else
    // about the two is the same, including the two ways out of the call.
    const recording = step.type === "record";

    stepEl.innerHTML = `
      <p class="step-text">${escapeHtml(step.text)}</p>
      ${step.image ? `<div class="step-image-slot" data-image-slot></div>` : ""}
      ${recording ? `
        <label class="field-label" for="flow-record">${escapeHtml(step.label || "What did you find?")}</label>
        <input type="text" id="flow-record" autocomplete="off"
               placeholder="${escapeHtml(step.placeholder || "")}" />
        <p class="errors" id="flow-record-error" hidden></p>
      ` : ""}
      ${stepCommentMarkup()}
      <div class="option-row">
        <button class="btn btn-primary" id="flow-next">${recording ? "Continue" : "Mark done and continue"}</button>
        <button class="btn btn-ghost" id="flow-resolved">Issue resolved</button>
        <button class="btn btn-ghost" id="flow-blocked">Cannot perform this check</button>
        ${flagControlMarkup()}
      </div>
      ${flagPopoverMarkup()}
    `;

    if (step.image) loadStepImage(step, stepEl.querySelector("[data-image-slot]"));

    // What a record step has been given so far, or "" for an action step.
    const recordedValue = () => recording ? document.getElementById("flow-record").value.trim() : "";

    const continueOn = () => {
      const label = step.label || step.text;

      if (recording) {
        const value = recordedValue();
        if (!value) {
          const errorEl = document.getElementById("flow-record-error");
          errorEl.textContent = "Note what you found before carrying on.";
          errorEl.hidden = false;
          document.getElementById("flow-record").focus();
          return;
        }
        // Kept by label as well as logged, so an outcome asking for the same
        // thing by name can be filled in without asking twice.
        state.recorded[label] = value;
        logStep(withComment({ label, answer: value }, currentStepComment()));
      } else {
        // A plain action step has no real answer to report — completing it
        // was the only possible outcome — so no answer key at all, rather
        // than a meaningless "Yes" standing in for one.
        logStep(withComment({ label }, currentStepComment()));
      }

      state.currentStepId = step.next;
      renderFlowStep();
    };

    document.getElementById("flow-next").addEventListener("click", continueOn);

    if (recording) {
      const input = document.getElementById("flow-record");
      input.focus();
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); continueOn(); }
      });
      // Clear a complaint as soon as the analyst starts answering it.
      input.addEventListener("input", () => { document.getElementById("flow-record-error").hidden = true; });
    }

    document.getElementById("flow-resolved").addEventListener("click", () => {
      const label = step.label || step.text;

      // A misclick here closes a call that is still open, so it asks first.
      if (!confirm(
        `End the call here?\n\n` +
        `The checks you have completed will be recorded, with "${label}" as the one ` +
        `that fixed it. Any steps after this one will not be recorded as performed.`)) return;

      // This step was carried out — it is what resolved the issue. The ones
      // after it are simply never reached, so they never reach the log either.
      //
      // On a record step the value is logged if there is one. It is not demanded:
      // an issue that fixes itself mid-call leaves nothing to note, and the
      // alternative is an analyst inventing a reading.
      const value = recordedValue();
      if (recording && value) state.recorded[label] = value;
      logStep({ label, answer: recording ? (value || "Not recorded") : "Yes" });
      state.resolvedAfter = label;

      goToReview(findResolveOutcome(kba, step.next) || FALLBACK_RESOLVE);
    });

    document.getElementById("flow-blocked").addEventListener("click", () => {
      openBlockedModal(kba, step);
    });

    wireFlagControl(kba, step);
    return;
  }

  stepEl.innerHTML = `
    <p class="step-text">${escapeHtml(step.text)}</p>
    ${stepCommentMarkup()}
    <div class="option-row">
      ${step.options.map(o => `<button class="btn btn-ghost" data-next="${escapeHtml(o.next)}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`).join("")}
      ${flagControlMarkup()}
    </div>
    ${flagPopoverMarkup()}
  `;

  stepEl.querySelectorAll("[data-next]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!step.outcomeCheck) {
        logStep(withComment({
          label: step.label || step.text,
          answer: btn.dataset.label
        }, currentStepComment()));
      }
      state.currentStepId = btn.dataset.next;
      renderFlowStep();
    });
  });

  wireFlagControl(kba, step);
}

// ---------------------------------------------------------------------------
// A step that cannot be carried out
// ---------------------------------------------------------------------------
//
// Sometimes the procedure cannot be finished: the user is not at the till, the
// back office is down, nobody has the key to the cabinet. The call still has to
// go somewhere, and second line still has to know why it arrived with half the
// checks done.
//
// The reason is required, because an escalation that says only "could not do it"
// is the thing second line bounces straight back.

// Which step the modal is asking about, and what to put focus back on when it
// closes. Null whenever the modal is shut.
let blockedContext = null;

function openBlockedModal(kba, step) {
  blockedContext = { kba, step, returnFocus: document.activeElement };

  document.getElementById("blocked-modal-step").textContent = step.label || step.text;
  document.getElementById("blocked-reason").value = "";
  document.getElementById("blocked-error").hidden = true;
  document.getElementById("blocked-modal").hidden = false;
  document.getElementById("blocked-reason").focus();
}

function closeBlockedModal() {
  document.getElementById("blocked-modal").hidden = true;

  const returnFocus = blockedContext && blockedContext.returnFocus;
  blockedContext = null;

  // Back to the button that opened it, so a keyboard user is not dropped at the
  // top of the page.
  if (returnFocus && returnFocus.isConnected) returnFocus.focus();
}

document.getElementById("blocked-cancel").addEventListener("click", closeBlockedModal);

// The backdrop only — a click inside the dialog should not dismiss it.
document.getElementById("blocked-modal").addEventListener("click", event => {
  if (event.target.id === "blocked-modal") closeBlockedModal();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && blockedContext) closeBlockedModal();
});

// Not being able to do a step does not always mean somebody else has to. The
// user rings off, or says it started working, or the check turns out not to
// apply to their setup — and the call is simply done. Both endings record the
// same thing against the step; they differ only in where the call goes next.
function endBlockedCall(outcome) {
  if (!blockedContext) return;

  const reason = document.getElementById("blocked-reason").value.trim();
  const errorEl = document.getElementById("blocked-error");

  if (!reason) {
    errorEl.textContent = "Say why the step cannot be done. Whoever reads the ticket needs this, " +
                          "whether it is second line or the next person to take the call.";
    errorEl.hidden = false;
    document.getElementById("blocked-reason").focus();
    return;
  }

  const { kba, step } = blockedContext;
  const label = step.label || step.text;

  closeBlockedModal();

  // Recorded against the step it happened on, in the same list as the checks
  // that were carried out, so the ticket reads in order.
  logStep({ label, answer: `Cannot perform (${reason})` });
  state.blockedReason = reason;

  // The KBA's own outcome, so its team and capture fields come with it. Its note
  // is left alone rather than overwritten: outcome objects are shared with the
  // loaded library, and writing to one would change the KBA itself.
  goToReview(outcome === "resolve"
    ? findResolveOutcome(kba, step.next) || FALLBACK_RESOLVE
    : findEscalateOutcome(kba, step.next) || FALLBACK_ESCALATE);
}

document.getElementById("blocked-confirm").addEventListener("click", () => endBlockedCall("escalate"));
document.getElementById("blocked-resolve").addEventListener("click", () => endBlockedCall("resolve"));

function goToReview(outcomeStep) {
  showScreen("screen-review");

  document.getElementById("copy-description").textContent =
    previewMode ? "Back to KBA library" : "Copy description";

  const badge = document.getElementById("review-badge");
  const fieldsEl = document.getElementById("review-fields");
  fieldsEl.innerHTML = "";

  if (outcomeStep.outcome === "resolve") {
    badge.textContent = "Resolved";
    badge.className = "badge badge-success";
  } else if (outcomeStep.outcome === "callback") {
    badge.textContent = "Callback required";
    badge.className = "badge badge-warning";
  } else {
    badge.textContent = "Escalate";
    badge.className = "badge badge-danger";
  }

  (outcomeStep.captureFields || []).forEach(f => {
    // A record step earlier in the call may already have asked for this by name.
    // Matched loosely on purpose: the same thing gets typed into a KBA's steps
    // and its capture fields by different people on different days.
    const recorded = recordedValueFor(f);
    if (recorded) state.captured[f] = recorded;

    const row = document.createElement("div");
    row.className = "field-row";
    row.innerHTML = `
      <label>${escapeHtml(f)}</label>
      <input type="text" data-field="${escapeHtml(f)}" value="${escapeHtml(state.captured[f] || "")}"
             placeholder="Enter ${escapeHtml(f.toLowerCase())}" />
      ${recorded ? `<p class="muted small tight prefilled">Noted during the call. Change it if it is wrong.</p>` : ""}
    `;
    fieldsEl.appendChild(row);
  });
  fieldsEl.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", () => {
      recordCapturedField(input.dataset.field, input.value, outcomeStep);
    });
  });

  renderDescription(outcomeStep);
}

// The value noted at a record step whose label is this capture field, if there
// was one. Trimmed and case-insensitive, so "Till number" finds "till number".
function recordedValueFor(field) {
  const wanted = field.trim().toLowerCase();
  const match = Object.keys(state.recorded).find(label => label.trim().toLowerCase() === wanted);
  return match ? state.recorded[match] : "";
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function renderDescription(outcomeStep) {
  const raw = state.issueText.trim().replace(/\.$/, "");
  const issueLine = `User contacted to report ${raw ? lowerFirst(raw) : "an issue"}`;

  const parts = [issueLine];

  const checks = state.log
    .map((e, i) => {
      const line = e.answer !== undefined ? `${i + 1} - ${e.label} - ${e.answer}` : `${i + 1} - ${e.label}`;
      return e.comment ? `${line}\n    Note: ${e.comment}` : line;
    })
    .join("\n");
  if (checks) parts.push("", "Checks performed", checks);

  if (state.resolvedAfter) parts.push("", `Resolved after this check - ${state.resolvedAfter}`);

  const fields = (outcomeStep.captureFields || [])
    .map(f => `${f} - ${state.captured[f] || ""}`)
    .join("\n");
  if (fields) parts.push("", fields);

  if (outcomeStep.note) parts.push("", outcomeStep.note);

  if (outcomeStep.outcome === "resolve") {
    parts.push("", "Issue resolved");
    // Closed without working through the whole KBA, so the ticket says which
    // check stopped and why rather than reading as a clean run.
    if (state.blockedReason) parts.push(`Reason: Resolved without completing all checks — ${state.blockedReason}`);
    parts.push("Shared the reference number");
  } else if (outcomeStep.outcome === "callback") {
    parts.push("", "Shared the reference number");
  } else {
    parts.push("", "Assigning to the second line team");
    // Second line needs to know the procedure was not finished, and why, before
    // they read a list of checks that stops short.
    if (state.blockedReason) parts.push(`Reason: Unable to complete troubleshooting — ${state.blockedReason}`);
    parts.push("Shared the reference number");
  }

  document.getElementById("review-description").value = parts.join("\n");
}

// ---------------------------------------------------------------------------
// Manage KBAs screen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The manage screen's flag backlog
// ---------------------------------------------------------------------------
//
// Fetched only when something could plausibly have changed it — opening the
// manage screen, deleting or resetting the library, marking one resolved —
// never on every re-render, so filtering the KBA list or saving an edit does
// not fire a network call that has nothing to do with either.

let openFlags = [];
// null until the Resolved tab has actually been opened once during this visit
// to the manage screen — that is the thing that decides whether opening it
// fetches, or just re-renders what is already in hand.
let resolvedFlags = null;
let flagsTab = "open";

function formatFlagTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function updateFlagsBadge() {
  const badge = document.getElementById("flags-badge");
  badge.textContent = openFlags.length;
  badge.hidden = openFlags.length === 0;
}

function setFlagsTab(tab) {
  flagsTab = tab;
  document.getElementById("flags-tab-open").setAttribute("aria-selected", String(tab === "open"));
  document.getElementById("flags-tab-resolved").setAttribute("aria-selected", String(tab === "resolved"));
}

async function renderFlagsPanel() {
  const section = document.getElementById("flags-section");
  if (!isAdmin()) { section.hidden = true; return; }

  section.hidden = false;

  // Whatever brought the admin back to this screen — opening it fresh,
  // deleting or resetting the library, recovering from a failed load — could
  // have changed what is resolved, so any cached Resolved-tab data is no
  // longer trustworthy and the view falls back to Open until asked again.
  resolvedFlags = null;
  setFlagsTab("open");

  try {
    openFlags = await loadOpenFlags();
  } catch (error) {
    console.error(error);
    openFlags = [];
    document.getElementById("flags-tab-content").innerHTML =
      `<p class="muted small tight">Flags could not be loaded. ${escapeHtml(error.message || error)}</p>`;
    updateFlagsBadge();
    return;
  }

  updateFlagsBadge();
  renderFlagsTabContent();
}

// Renders whichever tab is currently selected. Fetches the resolved list only
// the first time it is asked for — the one requirement this feature adds
// beyond the open list that already existed — and reuses it after that for
// as long as it stays valid.
async function renderFlagsTabContent() {
  const content = document.getElementById("flags-tab-content");

  if (flagsTab === "open") {
    renderFlagsGroup(content, openFlags, "open");
    return;
  }

  if (resolvedFlags === null) {
    content.innerHTML = `<p class="muted small tight">Loading&hellip;</p>`;
    try {
      resolvedFlags = await loadResolvedFlags();
    } catch (error) {
      console.error(error);
      resolvedFlags = [];
      content.innerHTML =
        `<p class="muted small tight">Resolved flags could not be loaded. ${escapeHtml(error.message || error)}</p>`;
      return;
    }
  }

  renderFlagsGroup(content, resolvedFlags, "resolved");
}

// The half of a flag row that is the same regardless of tab. What differs is
// which action it offers: an optional note plus Mark resolved on an open
// flag, or Reopen plus who cleared it and when on a resolved one.
function flagRowMarkup(flag, kind) {
  const actions = kind === "open"
    ? `
      <div class="flag-row-actions">
        <input type="text" data-resolve-note="${escapeHtml(flag.id)}" maxlength="${MAX_FLAG_REASON_LENGTH}"
               autocomplete="off" placeholder="Optional note" />
        <button class="btn btn-quiet btn-small" data-resolve-flag="${escapeHtml(flag.id)}">Mark resolved</button>
      </div>
    `
    : `
      <div class="flag-row-actions">
        <button class="btn btn-quiet btn-small" data-reopen-flag="${escapeHtml(flag.id)}">Reopen</button>
      </div>
    `;

  return `
    <div class="flag-row">
      <div class="flag-row-body">
        <p class="flag-row-step">${escapeHtml(flag.step_label || "General")}</p>
        ${flag.reason ? `<p class="flag-row-reason">${escapeHtml(flag.reason)}</p>` : ""}
        <p class="flag-row-meta">${escapeHtml(flag.flagged_by)} &middot; ${escapeHtml(formatFlagTime(flag.created_at))}</p>
        ${kind === "resolved" ? `
          <p class="flag-row-meta">Resolved by ${escapeHtml(flag.resolved_by || "")} &middot; ${escapeHtml(formatFlagTime(flag.resolved_at))}</p>
          ${flag.resolution_note ? `<p class="flag-row-reason">${escapeHtml(flag.resolution_note)}</p>` : ""}
        ` : ""}
        <p class="errors" data-flag-error="${escapeHtml(flag.id)}" hidden></p>
      </div>
      ${actions}
    </div>
  `;
}

// Grouped by KBA, in the order the KBAs already appear in the library, rather
// than say alphabetically by reference — which would put a KBA an admin
// barely recognises ahead of one they use every day. A reference the library
// no longer has (should not happen; the database cascades a flag away with
// its KBA) still falls back to itself rather than being silently dropped.
function renderFlagsGroup(container, flags, kind) {
  if (!flags.length) {
    container.innerHTML = kind === "open"
      ? `<p class="muted small tight">No open flags.</p>`
      : `<p class="muted small tight">No resolved flags yet.</p>`;
    return;
  }

  const byKba = new Map();
  flags.forEach(flag => {
    if (!byKba.has(flag.kba_id)) byKba.set(flag.kba_id, []);
    byKba.get(flag.kba_id).push(flag);
  });

  const order = [...new Set([...KBAS.map(k => k.id), ...byKba.keys()])];

  container.innerHTML = order
    .filter(ref => byKba.has(ref))
    .map(ref => {
      const kba = KBAS.find(k => k.id === ref);
      const title = kba ? kba.title : ref;
      const rows = byKba.get(ref);

      return `
        <div class="flags-group">
          <p class="flags-group-title">${escapeHtml(title)} <span class="muted small">${rows.length} ${kind}</span></p>
          ${rows.map(flag => flagRowMarkup(flag, kind)).join("")}
        </div>
      `;
    }).join("");

  container.querySelectorAll("[data-resolve-flag]").forEach(wireResolveButton);
  container.querySelectorAll("[data-reopen-flag]").forEach(wireReopenButton);
}

function wireResolveButton(btn) {
  btn.addEventListener("click", async () => {
    const id = btn.dataset.resolveFlag;
    const row = btn.closest(".flag-row");
    const noteInput = row.querySelector(`[data-resolve-note="${id}"]`);
    const errorEl = row.querySelector(`[data-flag-error="${id}"]`);

    btn.disabled = true;
    if (noteInput) noteInput.disabled = true;

    try {
      const patch = await resolveFlag(id, noteInput ? noteInput.value : "");
      const original = openFlags.find(flag => flag.id === id);

      openFlags = openFlags.filter(flag => flag.id !== id);
      // Only kept in step if the Resolved tab has actually been loaded once
      // already — if it has not, the next time it is opened it fetches fresh
      // and this row will be in it regardless.
      if (resolvedFlags !== null && original) resolvedFlags = [{ ...original, ...patch }, ...resolvedFlags];

      updateFlagsBadge();
      renderFlagsTabContent();
    } catch (error) {
      console.error(error);
      btn.disabled = false;
      if (noteInput) noteInput.disabled = false;
      errorEl.textContent = error.message || String(error);
      errorEl.hidden = false;
    }
  });
}

function wireReopenButton(btn) {
  btn.addEventListener("click", async () => {
    const id = btn.dataset.reopenFlag;
    const row = btn.closest(".flag-row");
    const errorEl = row.querySelector(`[data-flag-error="${id}"]`);

    btn.disabled = true;

    try {
      const patch = await reopenFlag(id);
      const original = resolvedFlags ? resolvedFlags.find(flag => flag.id === id) : null;

      if (resolvedFlags !== null) resolvedFlags = resolvedFlags.filter(flag => flag.id !== id);
      if (original) {
        openFlags = [...openFlags, { ...original, ...patch }]
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      }

      updateFlagsBadge();
      renderFlagsTabContent();
    } catch (error) {
      console.error(error);
      btn.disabled = false;
      errorEl.textContent = error.message || String(error);
      errorEl.hidden = false;
    }
  });
}

function renderManageScreen() {
  const listEl = document.getElementById("kba-list");
  const countEl = document.getElementById("kba-count");
  const canEdit = isAdmin();

  // With nothing in the library there is nothing to filter, and the empty state
  // carries the one action worth offering — so the toolbar steps aside rather
  // than showing a second button that does the same thing.
  const empty = !KBAS.length;

  // Analysts work calls but do not change the library. The security policies are
  // what actually enforce this; hiding the controls just avoids offering an
  // action that would be refused.
  document.getElementById("new-kba").hidden = !canEdit || empty;
  document.getElementById("reset-kbas").hidden = !canEdit;
  document.getElementById("manage-readonly").hidden = canEdit;
  document.querySelector(".filter-row").hidden = empty;
  document.getElementById("flags-section").hidden = !canEdit;

  // The filter survives a re-render, so deleting or saving while filtered leaves
  // the analyst looking at the same slice of the library they were before.
  const query = document.getElementById("kba-filter").value;
  const filtering = query.trim() !== "";
  const shown = filtering ? searchKBAs(query) : KBAS;

  document.getElementById("clear-filter").hidden = !filtering;

  countEl.textContent = filtering
    ? `${shown.length} of ${KBAS.length} KBAs`
    : KBAS.length === 1 ? "1 KBA" : `${KBAS.length} KBAs`;

  listEl.innerHTML = "";

  if (!KBAS.length) {
    listEl.innerHTML = canEdit
      ? `<div class="empty-state">
           <h2>No KBAs yet</h2>
           <p>Add the first one, or bring back the standard set your organisation started with.</p>
           <button class="btn btn-primary" id="empty-add-kba">Add a KBA</button>
         </div>`
      : `<div class="empty-state">
           <h2>No KBAs yet</h2>
           <p>Nobody has added any to your organisation. An admin can set them up from this screen.</p>
         </div>`;

    const add = document.getElementById("empty-add-kba");
    if (add) add.addEventListener("click", () => openEditor(null));
    return;
  }

  if (!shown.length) {
    listEl.innerHTML = `<div class="empty-state">
        <h2>Nothing matches that</h2>
        <p>No KBA has &ldquo;${escapeHtml(query.trim())}&rdquo; in its reference, title or keywords.</p>
        <button class="btn btn-ghost" id="empty-clear-filter">Clear the filter</button>
      </div>`;
    document.getElementById("empty-clear-filter").addEventListener("click", () => {
      document.getElementById("kba-filter").value = "";
      renderManageScreen();
      document.getElementById("kba-filter").focus();
    });
    return;
  }

  shown.forEach(kba => {
    const stepCount = Object.keys(kba.steps).length;
    // Branching KBAs are still hand-authored in kba-data.js — the form cannot
    // represent them, so it does not offer to edit them either.
    const editable = toFormModel(kba) !== null;
    const card = document.createElement("div");
    card.className = "match-card";
    card.innerHTML = `
      <div class="match-head">
        <div>
          <p class="match-title">${escapeHtml(kba.title)}</p>
          <p class="match-sub">${escapeHtml(kba.id)} · ${stepCount} steps</p>
        </div>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-ghost btn-small" data-preview="${escapeHtml(kba.id)}">Preview</button>` : ""}
          ${!canEdit ? "" : editable
            ? `<button class="btn btn-ghost btn-small" data-edit="${escapeHtml(kba.id)}">Edit</button>`
            : `<span class="badge badge-muted">Branching</span>`}
          ${canEdit ? `<button class="btn btn-quiet btn-small" data-delete="${escapeHtml(kba.id)}">Delete</button>` : ""}
        </div>
      </div>
      <p class="muted small">${escapeHtml(kba.keywords.join(", "))}</p>
      ${canEdit && !editable
        ? `<p class="muted small branching-note">Answers here lead down more than one path, which the
           form cannot represent. Editing it in the form would flatten those branches, so it is
           edited in kba-data.js instead.</p>`
        : ""}
    `;
    listEl.appendChild(card);
  });

  listEl.querySelectorAll("[data-preview]").forEach(btn => {
    btn.addEventListener("click", () => {
      const kba = KBAS.find(k => k.id === btn.dataset.preview);
      if (kba) enterPreview(kba);
    });
  });

  listEl.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => openEditor(btn.dataset.edit));
  });

  listEl.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const kba = KBAS.find(k => k.id === btn.dataset.delete);
      if (!confirm(`Delete "${kba.title}"? This cannot be undone.`)) return;

      if (!await runStorageAction(() => deleteKBA(btn.dataset.delete), "manage-message")) return;

      await tidyKBAFolder(btn.dataset.delete);
      renderManageScreen();
      renderFlagsPanel();
    });
  });
}

// ---------------------------------------------------------------------------
// Team screen
// ---------------------------------------------------------------------------

// Admins only, because it shows the join code, and anyone with that code can add
// themselves to the organisation. The nav button is hidden for analysts and the
// organisations policy refuses them the row in any case.
async function renderTeamScreen() {
  const bodyEl = document.getElementById("team-body");
  const roleEl = document.getElementById("team-role");

  roleEl.textContent = isAdmin() ? "Admin" : "Analyst";
  bodyEl.innerHTML = `<div class="loading-state"><span class="spinner"></span> Loading your organisation&hellip;</div>`;

  let organisation;
  try {
    organisation = await loadOrganisation();
  } catch (error) {
    console.error(error);
    bodyEl.innerHTML = `<div class="message message-problem">Your organisation could not be loaded. ${escapeHtml(error.message || error)}</div>`;
    return;
  }

  bodyEl.innerHTML = `
    <div class="team-block">
      <label class="field-label">Organisation</label>
      <p class="match-title">${escapeHtml(organisation.name)}</p>
    </div>
    <div class="team-block">
      <label class="field-label">Join code</label>
      <p class="join-code" id="join-code">${escapeHtml(organisation.joinCode)}</p>
      <p class="muted small">Anyone who enters this when they sign up joins your
      organisation as an analyst: they can work calls with your KBAs but cannot
      change them.</p>
      <button class="btn btn-primary" id="copy-join-code">Copy join code</button>
    </div>
  `;

  document.getElementById("copy-join-code").addEventListener("click", () => {
    navigator.clipboard.writeText(organisation.joinCode);
    document.getElementById("copy-join-code").textContent = "Copied";
  });
}

document.getElementById("kba-filter").addEventListener("input", renderManageScreen);

document.getElementById("clear-filter").addEventListener("click", () => {
  document.getElementById("kba-filter").value = "";
  renderManageScreen();
  document.getElementById("kba-filter").focus();
});

document.getElementById("flags-toggle").addEventListener("click", () => {
  const panel = document.getElementById("flags-panel");
  const toggle = document.getElementById("flags-toggle");
  const opening = panel.hidden;
  panel.hidden = !opening;
  toggle.setAttribute("aria-expanded", String(opening));
});

document.getElementById("flags-tab-open").addEventListener("click", () => {
  setFlagsTab("open");
  renderFlagsTabContent();
});

document.getElementById("flags-tab-resolved").addEventListener("click", () => {
  setFlagsTab("resolved");
  renderFlagsTabContent();
});

document.getElementById("nav-team").addEventListener("click", () => {
  disarmCallGuard();
  exitPreview();
  showScreen("screen-team");
  renderTeamScreen();
});

document.getElementById("new-kba").addEventListener("click", () => openEditor(null));

document.getElementById("nav-manage").addEventListener("click", () => {
  disarmCallGuard();
  exitPreview();
  showScreen("screen-manage");
  renderManageScreen();
  renderFlagsPanel();
});

document.getElementById("nav-call").addEventListener("click", () => {
  disarmCallGuard();
  exitPreview();
  showScreen("screen-intake");
});

document.getElementById("reset-kbas").addEventListener("click", async () => {
  if (!confirm("Reset the library back to the original KBAs? Any changes will be lost.")) return;

  const images = imagePathsIn(KBAS);

  if (!await runStorageAction(() => resetKBAs(), "manage-message")) return;

  await tidyImages(images);
  renderManageScreen();
  renderFlagsPanel();
});

document.getElementById("kba-search").addEventListener("input", renderSearchResults);

document.getElementById("find-kba").addEventListener("click", () => {
  state.issueText = document.getElementById("issue-text").value;
  state.matches = findMatches(state.issueText);
  renderIntake();
});

document.getElementById("copy-description").addEventListener("click", () => {
  if (previewMode) {
    exitPreview();
    showScreen("screen-manage");
    renderManageScreen();
    return;
  }

  const ta = document.getElementById("review-description");
  ta.select();
  document.execCommand("copy");
  // The ticket text is out of the browser now, so refreshing no longer loses
  // anything that has not already been saved elsewhere.
  disarmCallGuard();
});

document.getElementById("start-over").addEventListener("click", () => {
  disarmCallGuard();
  exitPreview();
  state.issueText = "";
  state.matches = [];
  state.selectedKBA = null;
  state.log = [];
  state.captured = {};
  state.resolvedAfter = "";
  state.blockedReason = "";
  state.recorded = {};
  document.getElementById("issue-text").value = "";
  document.getElementById("match-results").innerHTML = "";
  setPrimary("find-kba", true);
  document.getElementById("kba-search").value = "";
  renderSearchResults();
  showScreen("screen-intake");
});

// ---------------------------------------------------------------------------
// KBA editor
// ---------------------------------------------------------------------------
//
// The form handles linear KBAs only: a list of action steps in order, then one
// question, then resolve or escalate. Branching KBAs like the password reset stay
// hand-authored in kba-data.js.
//
// While the form is open the KBA is held as a "form model" — a flat shape that
// maps onto the fields on screen. toFormModel and fromFormModel convert between
// that and the nested step graph the flow engine actually runs on.

let editorModel = null;

// imagePath is what the flow JSON stores. imageFile and imagePreview only exist
// between picking a file and saving, when the upload actually happens.
function blankAction() {
  return { type: "action", text: "", label: "", placeholder: "",
           imagePath: "", imageFile: null, imagePreview: "", uncertainNote: "" };
}

function blankFormModel() {
  return {
    id: null,
    reference: "",
    title: "",
    keywords: [],
    issueExample: "",
    sourceText: "",
    actions: [blankAction()],
    // yesLabel, noLabel and outcomeCheck have no field on the form. They are
    // carried through so that opening an existing KBA and saving it straight
    // back changes nothing.
    question: { text: "", label: "", yesLabel: "Yes", noLabel: "No", outcomeCheck: true },
    resolve: { note: "", captureFields: [] },
    escalate: { team: "", note: "", captureFields: [] },
    // Anything a drafted KBA was not read confidently. Empty for one typed by
    // hand or loaded from the database.
    uncertain: []
  };
}

// Returns a form model, or null if the KBA is not linear and so cannot be edited
// here. The walk fails closed on purpose: anything it does not fully recognise is
// left to kba-data.js rather than risking a save that quietly drops steps.
function toFormModel(kba) {
  const actions = [];
  const visited = new Set();

  let stepId = kba.start;
  while (kba.steps[stepId] && (kba.steps[stepId].type === "action" || kba.steps[stepId].type === "record")) {
    if (visited.has(stepId)) return null;
    visited.add(stepId);
    const step = kba.steps[stepId];
    actions.push({
      type: step.type,
      text: step.text,
      label: step.label || "",
      placeholder: step.placeholder || "",
      imagePath: step.image || "",
      imageFile: null,
      imagePreview: "",
      uncertainNote: ""
    });
    stepId = step.next;
  }

  const question = kba.steps[stepId];
  if (!question || question.type !== "question") return null;
  if (!Array.isArray(question.options) || question.options.length !== 2) return null;

  const [yes, no] = question.options;
  const resolve = kba.steps[yes.next];
  const escalate = kba.steps[no.next];
  if (!resolve || resolve.type !== "outcome" || resolve.outcome !== "resolve") return null;
  if (!escalate || escalate.type !== "outcome" || escalate.outcome !== "escalate") return null;

  // Every step has to be accounted for. If the KBA has steps this walk never
  // reached, saving from the form would silently delete them.
  const reached = new Set([...visited, stepId, yes.next, no.next]);
  if (Object.keys(kba.steps).some(id => !reached.has(id))) return null;

  return {
    id: kba.id,
    reference: kba.id,
    title: kba.title,
    keywords: kba.keywords.slice(),
    issueExample: kba.issueExample || "",
    sourceText: kba.sourceText || "",
    actions,
    question: {
      text: question.text,
      label: question.label || "",
      yesLabel: yes.label,
      noLabel: no.label,
      outcomeCheck: question.outcomeCheck === true
    },
    resolve: {
      note: resolve.note || "",
      captureFields: (resolve.captureFields || []).slice()
    },
    escalate: {
      team: escalate.team || "",
      note: escalate.note || "",
      captureFields: (escalate.captureFields || []).slice()
    },
    uncertain: []
  };
}

// Steps are renumbered s1, s2, s3... on every save. The ids are internal, and
// every "next" pointer is rewritten here, so renumbering is safe.
function fromFormModel(model) {
  const steps = {};

  model.actions.forEach((action, index) => {
    steps[`s${index + 1}`] = {
      type: action.type === "record" ? "record" : "action",
      text: action.text,
      ...(action.label ? { label: action.label } : {}),
      ...(action.type === "record" && action.placeholder ? { placeholder: action.placeholder } : {}),
      ...(action.imagePath ? { image: action.imagePath } : {}),
      next: index === model.actions.length - 1 ? "final" : `s${index + 2}`
    };
  });

  steps.final = {
    type: "question",
    text: model.question.text,
    ...(model.question.label ? { label: model.question.label } : {}),
    ...(model.question.outcomeCheck ? { outcomeCheck: true } : {}),
    options: [
      { label: model.question.yesLabel, next: "resolve" },
      { label: model.question.noLabel, next: "escalate" }
    ]
  };

  steps.resolve = { type: "outcome", outcome: "resolve" };
  if (model.resolve.note) steps.resolve.note = model.resolve.note;
  if (model.resolve.captureFields.length) steps.resolve.captureFields = model.resolve.captureFields;

  steps.escalate = { type: "outcome", outcome: "escalate" };
  if (model.escalate.team) steps.escalate.team = model.escalate.team;
  if (model.escalate.note) steps.escalate.note = model.escalate.note;
  if (model.escalate.captureFields.length) steps.escalate.captureFields = model.escalate.captureFields;

  return {
    // The app calls this id; the database column is `reference`. Named that way
    // here because storage.js does the renaming and nothing else should.
    id: model.reference,
    title: model.title,
    keywords: model.keywords,
    ...(model.issueExample ? { issueExample: model.issueExample } : {}),
    ...(model.sourceText ? { sourceText: model.sourceText } : {}),
    start: "s1",
    steps
  };
}

function slugify(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `kba-${slug}` : "";
}

// Capture fields are typed one per line and stored as a list of strings.
function linesToList(value) {
  return value.split("\n").map(line => line.trim()).filter(Boolean);
}

// True once the admin has typed a reference by hand, which stops the title from
// overwriting it. Editing an existing KBA counts as already set.
let referenceEdited = false;

// What this KBA pointed at when the form opened. Anything on this list that the
// saved version no longer references is a file nothing can reach.
let originalImagePaths = [];

function openEditor(id) {
  pendingPdf = null;

  if (id) {
    const existing = KBAS.find(kba => kba.id === id);
    originalImagePaths = imagePathsIn([existing]);
    editorModel = toFormModel(existing);
    document.getElementById("editor-heading").textContent = "Edit KBA";
    referenceEdited = true;
  } else {
    originalImagePaths = [];
    editorModel = blankFormModel();
    document.getElementById("editor-heading").textContent = "Add a KBA";
    referenceEdited = false;
  }
  showScreen("screen-editor");
  renderEditor();
}

function renderEditor() {
  const model = editorModel;

  const editing = model.id !== null;

  document.getElementById("editor-errors").hidden = true;
  document.getElementById("kba-title").value = model.title;
  document.getElementById("kba-reference").value = model.reference;

  // Saving matches on the reference, so changing it on an existing KBA would
  // write a second row rather than rename the first. Locked here until there is
  // a rename that deletes the old row as part of the same save.
  document.getElementById("kba-reference").readOnly = editing;
  document.getElementById("reference-hint").textContent = editing
    ? "cannot be changed once the KBA exists"
    : "filled in from the title until you change it";
  document.getElementById("kba-keywords").value = model.keywords.join(", ");
  document.getElementById("kba-example").value = model.issueExample;
  document.getElementById("question-text").value = model.question.text;
  document.getElementById("resolve-note").value = model.resolve.note;
  document.getElementById("resolve-fields").value = model.resolve.captureFields.join("\n");
  document.getElementById("escalate-team").value = model.escalate.team;
  document.getElementById("escalate-note").value = model.escalate.note;
  document.getElementById("escalate-fields").value = model.escalate.captureFields.join("\n");

  if (!pendingPdf) document.getElementById("pdf-file").value = "";
  document.getElementById("pdf-status").hidden = true;
  document.getElementById("draft-uncertain").hidden = true;
  document.getElementById("source-text").value = model.sourceText;

  if (model.sourceText) {
    document.getElementById("source-summary").textContent =
      "Kept with this KBA from when it was written.";
    openSourcePanel();
  } else {
    closeSourcePanel();
  }

  renderActionSteps();
  renderPdfActions();
  placeUncertainNotes();
}

function renderActionSteps() {
  const container = document.getElementById("action-steps");
  const actions = editorModel.actions;

  container.innerHTML = actions.map((action, index) => `
    <div class="step-row">
      <div class="step-row-head">
        <span class="step-number">Step ${index + 1}</span>
        <div class="row-actions">
          <button class="btn btn-quiet btn-icon" data-move-up="${index}" title="Move up" aria-label="Move step up" ${index === 0 ? "disabled" : ""}>&uarr;</button>
          <button class="btn btn-quiet btn-icon" data-move-down="${index}" title="Move down" aria-label="Move step down" ${index === actions.length - 1 ? "disabled" : ""}>&darr;</button>
          <button class="btn btn-quiet btn-small" data-remove="${index}" ${actions.length === 1 ? "disabled" : ""}>Remove</button>
        </div>
      </div>
      <label class="field-label">Step type</label>
      <select data-action-type="${index}">
        <option value="action"${action.type === "record" ? "" : " selected"}>Action — the analyst does something and confirms it</option>
        <option value="record"${action.type === "record" ? " selected" : ""}>Record — the analyst notes a value</option>
      </select>

      <label class="field-label">${action.type === "record" ? "What the analyst checks" : "What the analyst does"}</label>
      <textarea rows="2" data-action-text placeholder="${action.type === "record"
        ? "e.g. Check the light status on the base unit of the till."
        : "e.g. Power off the till by pressing and holding the button on the base unit."}">${escapeHtml(action.text)}</textarea>

      <label class="field-label">${action.type === "record"
        ? `Name of the value <span class="hint">used in the ticket, and fills a capture field of the same name</span>`
        : `Short label for the ticket <span class="hint">optional — the step text is used if this is blank</span>`}</label>
      <input type="text" data-action-label value="${escapeHtml(action.label)}" placeholder="${action.type === "record"
        ? "e.g. Base unit light status" : "e.g. Powered off the till from the base unit"}" />

      ${action.type === "record" ? `
        <label class="field-label">Example value <span class="hint">optional — shown greyed out in the box the analyst types into</span></label>
        <input type="text" data-action-placeholder value="${escapeHtml(action.placeholder)}" placeholder="e.g. Green, red, off" />
      ` : ""}

      ${action.uncertainNote ? uncertainNoteMarkup(action.uncertainNote) : ""}

      <label class="field-label">Screenshot <span class="hint">optional — an image up to 2 MB</span></label>
      ${stepImagePreview(action, index)}
      <input type="file" accept="image/*" data-action-image="${index}" />
      <p class="errors step-image-error" data-image-error="${index}" hidden></p>
    </div>
  `).join("");

  container.querySelectorAll("[data-action-type]").forEach(select => {
    select.addEventListener("change", () => {
      readEditorInputs();
      // The row is redrawn because the two types ask for different things.
      editorModel.actions[Number(select.dataset.actionType)].type = select.value;
      renderActionSteps();
    });
  });

  container.querySelectorAll("[data-action-image]").forEach(input => {
    input.addEventListener("change", event => pickStepImage(Number(input.dataset.actionImage), event));
  });

  container.querySelectorAll("[data-remove-image]").forEach(btn => {
    btn.addEventListener("click", () => {
      readEditorInputs();
      const action = editorModel.actions[Number(btn.dataset.removeImage)];
      if (action.imagePreview) URL.revokeObjectURL(action.imagePreview);
      // Nothing is removed from storage here. Files only go once the save has
      // succeeded, so backing out of the form leaves the KBA as it was.
      action.imagePath = "";
      action.imageFile = null;
      action.imagePreview = "";
      renderActionSteps();
    });
  });

  container.querySelectorAll("[data-move-up]").forEach(btn => {
    btn.addEventListener("click", () => moveAction(Number(btn.dataset.moveUp), -1));
  });

  container.querySelectorAll("[data-move-down]").forEach(btn => {
    btn.addEventListener("click", () => moveAction(Number(btn.dataset.moveDown), 1));
  });

  container.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      readEditorInputs();
      editorModel.actions.splice(Number(btn.dataset.remove), 1);
      renderActionSteps();
    });
  });
}

// A file just picked previews straight from the browser; one already saved
// previews from the signed URL the library was loaded with.
function stepImagePreview(action, index) {
  const source = action.imagePreview || (action.imagePath ? IMAGE_URLS[action.imagePath] : "");

  if (!source) {
    return action.imagePath
      ? `<p class="muted small tight">A screenshot is stored for this step, but its link could not be loaded.</p>`
      : "";
  }

  return `
    <div class="image-preview">
      <img src="${escapeHtml(source)}" alt="Screenshot for step ${index + 1}" />
      <button type="button" class="btn btn-quiet btn-small" data-remove-image="${index}">Remove</button>
    </div>
  `;
}

function showStepImageError(index, message) {
  const el = document.querySelector(`[data-image-error="${index}"]`);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function pickStepImage(index, event) {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;

  const problem = describeImageProblem(file);
  if (problem) {
    showStepImageError(index, problem);
    input.value = "";
    return;
  }

  readEditorInputs();

  const action = editorModel.actions[index];
  if (action.imagePreview) URL.revokeObjectURL(action.imagePreview);

  // Held until save. Uploading on pick would litter the bucket every time an
  // admin changed their mind or closed the form.
  action.imageFile = file;
  action.imagePreview = URL.createObjectURL(file);

  renderActionSteps();
}

// Pulls what is currently on screen back into the model. Called before anything
// that re-renders the step list, so half-typed steps survive a reorder, and again
// before saving.
function readEditorInputs() {
  const model = editorModel;

  model.title = document.getElementById("kba-title").value.trim();
  model.reference = document.getElementById("kba-reference").value.trim();
  model.keywords = document.getElementById("kba-keywords").value
    .split(",")
    .map(keyword => keyword.trim())
    .filter(Boolean);
  model.issueExample = document.getElementById("kba-example").value.trim();
  model.sourceText = document.getElementById("source-text").value.trim();
  model.question.text = document.getElementById("question-text").value.trim();
  model.resolve.note = document.getElementById("resolve-note").value.trim();
  model.resolve.captureFields = linesToList(document.getElementById("resolve-fields").value);
  model.escalate.team = document.getElementById("escalate-team").value.trim();
  model.escalate.note = document.getElementById("escalate-note").value.trim();
  model.escalate.captureFields = linesToList(document.getElementById("escalate-fields").value);

  // The rows carry text and label. Everything to do with the screenshot lives
  // only in the model, so it is carried across by position rather than re-read.
  model.actions = Array.from(document.querySelectorAll("#action-steps .step-row")).map((row, index) => {
    const existing = model.actions[index] || blankAction();
    const placeholderInput = row.querySelector("[data-action-placeholder]");

    return {
      type: row.querySelector("[data-action-type]").value === "record" ? "record" : "action",
      text: row.querySelector("[data-action-text]").value.trim(),
      label: row.querySelector("[data-action-label]").value.trim(),
      // Only record steps have the field; an action step keeps whatever it had
      // so switching type by mistake does not lose it.
      placeholder: placeholderInput ? placeholderInput.value.trim() : existing.placeholder,
      imagePath: existing.imagePath,
      imageFile: existing.imageFile,
      imagePreview: existing.imagePreview,
      // Travels with its step, so reordering or removing one keeps the flags
      // pointing at the right thing.
      uncertainNote: existing.uncertainNote || ""
    };
  });
}

function moveAction(index, direction) {
  readEditorInputs();

  const actions = editorModel.actions;
  const target = index + direction;
  if (target < 0 || target >= actions.length) return;

  [actions[index], actions[target]] = [actions[target], actions[index]];
  renderActionSteps();
}

function validateModel(model) {
  const errors = [];

  if (!model.title) errors.push("Give the KBA a title.");

  if (!model.reference) {
    errors.push("Give the KBA a reference.");
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(model.reference)) {
    errors.push("The reference can only use lower case letters, numbers and single hyphens, for example kba-till-power.");
  } else if (KBAS.some(kba => kba.id === model.reference && kba.id !== model.id)) {
    errors.push(`Another KBA already uses the reference "${model.reference}".`);
  }
  if (!model.keywords.length) errors.push("Add at least one keyword, or the assistant will never match this KBA to a call.");
  if (!model.actions.length) errors.push("Add at least one step.");

  model.actions.forEach((action, index) => {
    if (!action.text) {
      errors.push(`Step ${index + 1} needs a description of what the analyst does.`);
    }
    // A record step's label is the name of the thing being written down: it is
    // what the ticket shows and what a capture field is matched against, so it
    // cannot fall back to the step text the way an action step's can.
    if (action.type === "record" && !action.label) {
      errors.push(`Step ${index + 1} records a value, so it needs a name for that value.`);
    }
  });

  if (!model.question.text) errors.push("Add the final question that decides resolve or escalate.");

  return errors;
}

// Checks the flow JSON that is about to be saved, rather than the form it came
// from. fromFormModel should always produce a sound graph for a linear KBA, so
// anything caught here is a bug in the building rather than bad input — which is
// exactly why it runs before every save instead of being assumed.
function validateFlow(kba) {
  const errors = [];
  const steps = kba.steps;

  // Where a step can lead. Outcomes lead nowhere, which is the point of them.
  const exitsOf = step => {
    if (step.type === "question") return (step.options || []).map(option => option.next);
    if (step.type === "action" || step.type === "record") return [step.next];
    return [];                                  // an outcome, which ends there
  };

  if (!steps[kba.start]) {
    errors.push(`The KBA starts at "${kba.start}", which is not one of its steps.`);
  }

  for (const [id, step] of Object.entries(steps)) {
    for (const next of exitsOf(step)) {
      if (!next) errors.push(`Step "${id}" does not say which step comes next.`);
      else if (!steps[next]) errors.push(`Step "${id}" leads to "${next}", which is not one of its steps.`);
    }
  }

  // Walking a graph with broken links would just report the same faults again.
  if (errors.length) return errors;

  // Every route through the KBA has to finish on an outcome. A route that
  // revisits a step it has already been through never will.
  const endsInAnOutcome = (id, visited) => {
    const step = steps[id];
    if (step.type === "outcome") return true;

    if (visited.has(id)) {
      errors.push(`The steps loop back to "${id}" and never reach an outcome.`);
      return false;
    }
    visited.add(id);

    return exitsOf(step).every(next => endsInAnOutcome(next, new Set(visited)));
  };

  if (!errors.length) endsInAnOutcome(kba.start, new Set());

  return errors;
}

// Uploads whatever the admin picked, once the form is known to be valid. Each
// upload replaces the pending file with the path the flow JSON will carry.
async function uploadPendingImages(model) {
  for (const action of model.actions) {
    if (!action.imageFile) continue;

    action.imagePath = await uploadStepImage(model.reference, action.imageFile);

    URL.revokeObjectURL(action.imagePreview);
    action.imageFile = null;
    action.imagePreview = "";
  }
}

// Removing files nothing points at any more. A private bucket cannot be browsed,
// so a failure here has no other way of coming to light.
function warnAboutOrphans() {
  showMessage("manage-message",
    "Some screenshots could not be removed from storage and are now orphaned. " +
    "The change to the KBA itself went through. Their paths are in the browser console.");
}

async function tidyImages(paths) {
  if (!paths.length) return;
  if (!await removeImages(paths)) warnAboutOrphans();
}

// Used when a whole KBA goes: sweeps its folder rather than only the paths its
// steps referenced, so anything left behind by an earlier failure goes too.
async function tidyKBAFolder(reference) {
  if (!await removeKBAImages(reference)) warnAboutOrphans();
}

function showEditorErrors(errors) {
  const errorsEl = document.getElementById("editor-errors");
  errorsEl.className = "message message-problem";
  errorsEl.innerHTML = `<ul>${errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
  errorsEl.hidden = false;
  errorsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------------------
// Source PDF
// ---------------------------------------------------------------------------
//
// Reading a PDF here is about not retyping a four-page document. It does not
// interpret anything: the extracted text goes into a panel beside the form for
// the admin to copy from, and is stored with the KBA so whoever edits it next
// can see where the steps came from. Nothing is filled in automatically.
//
// This lives on the editor screen, which only admins can open.

const PDF_VERSION = "3.11.174";

// A scanned page has no text layer, so extraction comes back with nothing or a
// few stray characters. This is the line between a genuinely short document and
// a picture of a document.
const MIN_CHARACTERS_PER_PAGE = 10;

function pdfReady() {
  if (typeof pdfjsLib === "undefined") return false;

  // pdf.js parses in a worker, which it has to be told where to find.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_VERSION}/pdf.worker.min.js`;
  return true;
}

async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();

    // hasEOL marks where a line ended in the document. Without it the whole page
    // arrives as one unbroken paragraph, which is no use to copy from.
    const text = content.items
      .map(item => item.str + (item.hasEOL ? "\n" : ""))
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    pages.push(text);
  }

  return { pageCount: pdf.numPages, text: pages.filter(Boolean).join("\n\n").trim() };
}

function showPdfStatus(message, problem) {
  const el = document.getElementById("pdf-status");
  el.className = problem ? "errors" : "notice";
  el.textContent = message;
  el.hidden = false;
}

function openSourcePanel() {
  document.getElementById("source-panel").hidden = false;
  document.getElementById("app-shell").classList.add("wide");
}

function closeSourcePanel() {
  document.getElementById("source-panel").hidden = true;
  document.getElementById("app-shell").classList.remove("wide");
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Drafting a KBA from a document
// ---------------------------------------------------------------------------
//
// The PDF goes to the parse-kba Edge Function, which holds the Gemini key and
// checks the caller is an admin before reading anything. What comes back is a
// draft: it fills the form in and nothing else. Nothing is saved until the admin
// has read it and pressed Save, and anything the model was unsure of is flagged
// against the field it affects.

// The file waiting to be drafted from, if any.
let pendingPdf = null;

// Which form field each uncertain flag belongs beside. Anything outside this
// list is shown above the form rather than dropped — a flag nobody sees is
// worse than one in a slightly odd place.
const UNCERTAIN_ANCHORS = {
  reference: "kba-reference",
  title: "kba-title",
  keywords: "kba-keywords",
  issue_example: "kba-example",
  final_question: "question-text",
  resolve_note: "resolve-note",
  resolve_capture_fields: "resolve-fields",
  escalate_team: "escalate-team",
  escalate_note: "escalate-note",
  escalate_capture_fields: "escalate-fields"
};

function uncertainNoteMarkup(note) {
  return `<p class="uncertain-note"><span class="uncertain-tag">Check</span><span>${escapeHtml(note)}</span></p>`;
}

function renderPdfActions() {
  document.getElementById("draft-from-pdf").hidden = pendingPdf === null;
}

// Flags for fields, placed after the input each one is about. Step flags are not
// handled here: those live on the step and are drawn with it.
function placeUncertainNotes() {
  document.querySelectorAll("#screen-editor .editor-main .uncertain-note").forEach(el => {
    if (!el.closest(".step-row")) el.remove();
  });

  const orphans = [];
  const items = (editorModel && editorModel.uncertain) || [];

  items.forEach(item => {
    const anchorId = UNCERTAIN_ANCHORS[item.field];
    const anchor = anchorId && document.getElementById(anchorId);

    if (!anchor) {
      orphans.push(item);
      return;
    }

    anchor.insertAdjacentHTML("afterend", uncertainNoteMarkup(item.note));
  });

  const panel = document.getElementById("draft-uncertain");
  if (!orphans.length) {
    panel.hidden = true;
    return;
  }

  panel.className = "message message-plain";
  panel.innerHTML = `<strong>Worth a second look</strong><ul>${
    orphans.map(item => `<li>${escapeHtml(item.note)}</li>`).join("")}</ul>`;
  panel.hidden = false;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL gives "data:application/pdf;base64,AAAA..."; the function
    // wants only what follows the comma.
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function formHasContent() {
  const model = editorModel;
  return Boolean(
    model.title || model.reference || model.keywords.length || model.issueExample ||
    model.question.text || model.resolve.note || model.escalate.team ||
    model.actions.some(action => action.text || action.label)
  );
}

// Fills the form in from a draft. Deliberately the only thing that happens with
// one: no save, no upload, no change to the library.
function applyDraft(draft, uncertain) {
  const stepNotes = new Map();
  const fieldNotes = [];

  (uncertain || []).forEach(item => {
    const step = /^step_([1-9][0-9]*)$/.exec(item.field || "");
    if (step) stepNotes.set(Number(step[1]) - 1, item.note);
    else fieldNotes.push(item);
  });

  editorModel.reference = draft.reference || "";
  editorModel.title = draft.title || "";
  editorModel.keywords = (draft.keywords || []).slice();
  editorModel.issueExample = draft.issue_example || "";
  editorModel.question.text = draft.final_question || "";
  editorModel.resolve.note = (draft.resolve && draft.resolve.note) || "";
  editorModel.resolve.captureFields = ((draft.resolve && draft.resolve.capture_fields) || []).slice();
  editorModel.escalate.team = (draft.escalate && draft.escalate.team) || "";
  editorModel.escalate.note = (draft.escalate && draft.escalate.note) || "";
  editorModel.escalate.captureFields = ((draft.escalate && draft.escalate.capture_fields) || []).slice();
  editorModel.uncertain = fieldNotes;

  editorModel.actions = (draft.action_steps || []).map((step, index) => ({
    ...blankAction(),
    text: step.text || "",
    label: step.label || "",
    uncertainNote: stepNotes.get(index) || ""
  }));

  if (!editorModel.actions.length) editorModel.actions = [blankAction()];

  // The drafted reference is the admin's to keep or change; the title should not
  // quietly overwrite it as they edit.
  referenceEdited = true;

  renderEditor();
}

document.getElementById("draft-from-pdf").addEventListener("click", async () => {
  if (!pendingPdf) return;

  readEditorInputs();

  if (formHasContent() &&
      !confirm("Replace what is in the form with a draft read from this PDF?\n\n" +
               "Nothing is saved either way — you will still review it before saving.")) {
    return;
  }

  const button = document.getElementById("draft-from-pdf");
  button.disabled = true;
  button.textContent = "Reading the document\u2026";
  showPdfStatus(`Sending ${pendingPdf.name} to be read. This usually takes a few seconds.`, false);

  try {
    const pdf = await fileToBase64(pendingPdf);
    const { data, error } = await supabaseClient.functions.invoke("parse-kba", { body: { pdf } });

    if (error) {
      showPdfStatus(await describeDraftFailure(error), true);
      return;
    }

    if (!data || !data.draft) {
      showPdfStatus("The document was read but no draft came back. Fill the form in by hand.", true);
      return;
    }

    applyDraft(data.draft, data.uncertain);

    const flagged = (data.uncertain || []).length;
    showPdfStatus(
      `Draft filled in from ${pendingPdf.name}. Nothing has been saved` +
      (flagged
        ? `, and ${flagged} thing${flagged === 1 ? "" : "s"} the reader was unsure of ${flagged === 1 ? "is" : "are"} flagged below.`
        : ". Read it through, then save."),
      false);
  } catch (error) {
    console.error(error);
    showPdfStatus(`The document could not be sent. ${error.message || error}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "Draft this KBA from the PDF";
    renderPdfActions();
  }
});

// The function returns a message written for whoever is reading it, so use that
// where there is one rather than inventing a worse one here.
async function describeDraftFailure(error) {
  const response = error && error.context;
  const status = response && response.status;

  let body = null;
  if (response && typeof response.json === "function") {
    body = await response.json().catch(() => null);
  }

  if (body && body.error) {
    if (status === 429) {
      const wait = body.detail && body.detail.retryAfterSeconds;
      return body.error + (wait ? ` Try again in about ${wait} seconds.` : "");
    }
    return body.error;
  }

  if (status === 429) {
    return "The drafting service is busy — it takes about ten to fifteen documents a minute. " +
           "Wait a moment and try again.";
  }

  if (status === 404) {
    return "The drafting service is not deployed for this project. An admin needs to run " +
           "`supabase functions deploy parse-kba`.";
  }

  return `The document could not be drafted. ${(error && error.message) || error}`;
}

document.getElementById("pdf-file").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;

  // Held for the drafting service, which reads the pages itself. Set before the
  // local text extraction runs, so a PDF that pdf.js cannot read can still be
  // drafted from.
  pendingPdf = file;
  renderPdfActions();

  if (!pdfReady()) {
    showPdfStatus(
      "The PDF reader did not load, so the text cannot be pulled out here. You can still draft " +
      "from it, or fill the form in by hand.", true);
    return;
  }

  showPdfStatus(`Reading ${file.name}\u2026`, false);
  input.disabled = true;

  try {
    const { text, pageCount } = await extractPdfText(file);
    const characters = text.replace(/\s/g, "").length;

    // Nothing, or so little that it cannot be a real document.
    if (characters < MIN_CHARACTERS_PER_PAGE * pageCount) {
      showPdfStatus(
        `${file.name} has ${plural(pageCount, "page")} but only ${plural(characters, "character")} ` +
        `of text in it, so it is almost certainly a scan \u2014 a picture of a document rather than ` +
        `a document. There is nothing to copy from, but the drafting service reads scanned pages, ` +
        `so "Draft this KBA from the PDF" will still work on it.`, true);
      return;
    }

    editorModel.sourceText = text;
    document.getElementById("source-text").value = text;
    document.getElementById("source-summary").textContent =
      `${file.name} \u2014 ${plural(pageCount, "page")}, ${characters.toLocaleString()} characters. ` +
      `Edit it freely; whatever is here is saved with the KBA.`;
    openSourcePanel();
    showPdfStatus(`Read ${plural(pageCount, "page")} from ${file.name}.`, false);
  } catch (error) {
    console.error(error);
    showPdfStatus(`Could not read ${file.name}. ${error.message || error}`, true);
  } finally {
    input.disabled = false;
  }
});

document.getElementById("hide-source").addEventListener("click", () => {
  // Hiding only tidies the panel away. Clearing the box is what removes the text.
  closeSourcePanel();
});

document.getElementById("kba-title").addEventListener("input", event => {
  if (referenceEdited) return;
  document.getElementById("kba-reference").value = slugify(event.target.value);
});

document.getElementById("kba-reference").addEventListener("input", () => {
  referenceEdited = true;
});

document.getElementById("add-action").addEventListener("click", () => {
  readEditorInputs();
  editorModel.actions.push(blankAction());
  renderActionSteps();
});

document.getElementById("cancel-edit").addEventListener("click", () => {
  editorModel = null;
  closeSourcePanel();
  showScreen("screen-manage");
  renderManageScreen();
});

document.getElementById("save-kba").addEventListener("click", async () => {
  readEditorInputs();

  const errors = validateModel(editorModel);
  if (errors.length) {
    showEditorErrors(errors);
    return;
  }

  // The step graph does not depend on the screenshots, so it is checked before
  // anything is uploaded — an invalid form should not leave files behind.
  const flowErrors = validateFlow(fromFormModel(editorModel));
  if (flowErrors.length) {
    showEditorErrors(flowErrors);
    return;
  }

  const button = document.getElementById("save-kba");
  const restoreButton = () => {
    button.disabled = false;
    button.textContent = "Save KBA";
  };

  button.disabled = true;
  button.textContent = "Saving\u2026";

  try {
    await uploadPendingImages(editorModel);
  } catch (error) {
    console.error(error);
    showEditorErrors([`The screenshots could not be uploaded, so nothing was saved. ${error.message || error}`]);
    restoreButton();
    return;
  }

  // Rebuilt now that every screenshot has a path to point at.
  const kba = fromFormModel(editorModel);
  const saved = await runStorageAction(() => saveKBA(kba), "editor-errors");

  restoreButton();

  // Stay on the form if the save failed, so nothing the analyst typed is lost.
  if (!saved) return;

  // Replaced, cleared, or attached to a step that has since been removed.
  const stillUsed = new Set(imagePathsIn([kba]));
  await tidyImages(originalImagePaths.filter(path => !stillUsed.has(path)));

  editorModel = null;
  originalImagePaths = [];
  closeSourcePanel();
  showScreen("screen-manage");
  renderManageScreen();

  const savedKba = KBAS.find(k => k.id === kba.id) || kba;
  showActionNotice("manage-message", `Saved "${savedKba.title}".`, "Preview it", () => enterPreview(savedKba));
});

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
//
// The app shell stays hidden until Supabase reports a session. Signing in and
// signing out both come back through onAuthStateChange below, so there is one
// path into the app rather than one for a fresh sign-in and another for a
// session restored from a previous visit.

// "signin" or "signup" — the same form does both.
let authMode = "signin";

// Whose KBAs are currently loaded, so a repeated auth event does not reload them.
let loadedUserId = null;

function showAuthError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.hidden = false;
  document.getElementById("auth-notice").hidden = true;
}

function showAuthNotice(message) {
  const el = document.getElementById("auth-notice");
  el.textContent = message;
  el.hidden = false;
  document.getElementById("auth-error").hidden = true;
}

function clearAuthMessages() {
  document.getElementById("auth-error").hidden = true;
  document.getElementById("auth-notice").hidden = true;
}

function renderAuthMode() {
  const signingIn = authMode === "signin";

  document.getElementById("auth-heading").textContent = signingIn ? "Sign in" : "Create an account";
  document.getElementById("auth-lede").textContent = signingIn
    ? "Sign in to reach your team's KBA library."
    : "Join your team with the code an admin gave you, or start a new organisation.";
  document.getElementById("auth-submit").textContent = signingIn ? "Sign in" : "Create account";
  document.getElementById("auth-switch-text").textContent = signingIn ? "No account yet?" : "Already have an account?";
  document.getElementById("auth-switch").textContent = signingIn ? "Create one" : "Sign in";
  document.getElementById("auth-password").autocomplete = signingIn ? "current-password" : "new-password";
  document.getElementById("signup-fields").hidden = signingIn;
  renderOrgNameField();
}

// Joining an existing organisation and starting a new one are the two ways to
// sign up, and the join code is what tells them apart. Asking for a name for an
// organisation the user is not creating would just be confusing, so that field
// disappears as soon as a code is typed.
function renderOrgNameField() {
  const joinCode = document.getElementById("auth-join-code").value.trim();
  document.getElementById("org-name-field").hidden = joinCode !== "";
}

function showSignedOut() {
  loadedUserId = null;
  KBAS = [];
  profile = null;
  clearMessage("app-message");
  clearMessage("manage-message");
  document.getElementById("nav-team").hidden = true;

  // Always come back to sign in, whichever mode the form was left in. Otherwise
  // signing out of a freshly created account leaves the form on "create an
  // account", and signing back in fails with "user already registered".
  authMode = "signin";
  clearAuthMessages();
  document.getElementById("auth-password").value = "";
  document.getElementById("auth-join-code").value = "";
  document.getElementById("auth-org-name").value = "";
  document.getElementById("kba-search").value = "";
  document.getElementById("kba-filter").value = "";

  document.getElementById("app-loading").hidden = true;
  document.getElementById("app-shell").hidden = true;
  document.getElementById("app-nav").hidden = true;
  document.getElementById("screen-auth").hidden = false;

  renderAuthMode();
}

async function showSignedIn(session) {
  document.getElementById("screen-auth").hidden = true;
  document.getElementById("app-loading").hidden = false;

  // The role decides what the rest of the app offers, so it has to be in hand
  // before anything renders. Without a profile the user stays an analyst: the
  // policies would refuse their writes anyway, and offering buttons that cannot
  // work is worse than offering none.
  let profileError = null;

  try {
    profile = await loadProfile();
  } catch (error) {
    console.error(error);
    profile = { id: session.user.id, email: session.user.email, orgId: null, role: "analyst" };
    profileError = error;
  }

  // Fetch before revealing the app, so there is no moment where the analyst can
  // type an issue into a library that has not arrived yet. loadKBAs seeds from
  // DEFAULT_KBAS only for an admin whose organisation is empty.
  await loadLibrary();

  if (profileError) {
    showMessage("app-message",
      `Your profile could not be read, so the app is running read-only. ${profileError.message || profileError}`);
  }

  document.getElementById("app-loading").hidden = true;
  document.getElementById("signed-in-as").textContent = session.user.email;
  document.getElementById("nav-team").hidden = !isAdmin();
  document.getElementById("app-nav").hidden = false;
  document.getElementById("app-shell").hidden = false;

  renderSearchResults();
  showScreen("screen-intake");
}

// Fetching the library, with a way to ask again if it does not arrive. Used both
// on sign-in and by the retry button that appears when it fails.
async function loadLibrary() {
  const ok = await runStorageAction(() => loadKBAs(profile), "app-message", loadLibrary);
  if (!ok) return false;

  // A retry lands on whichever screen the analyst was already looking at.
  renderSearchResults();
  if (document.getElementById("screen-manage").classList.contains("active")) {
    renderManageScreen();
    renderFlagsPanel();
  }

  return true;
}

// Called for the session found at startup and for every change after it.
async function applySession(session) {
  if (!session) {
    showSignedOut();
    return;
  }

  // Supabase reports the current session when the listener is first attached,
  // which can arrive alongside the one startup already handled.
  if (loadedUserId === session.user.id) return;
  loadedUserId = session.user.id;

  await showSignedIn(session);
}

document.getElementById("auth-join-code").addEventListener("input", renderOrgNameField);

document.getElementById("auth-switch").addEventListener("click", () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  clearAuthMessages();
  renderAuthMode();
});

document.getElementById("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  clearAuthMessages();

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;

  if (!email || !password) {
    showAuthError("Enter your email address and a password.");
    return;
  }

  const button = document.getElementById("auth-submit");
  button.disabled = true;
  button.textContent = authMode === "signin" ? "Signing in…" : "Creating account…";

  const { data, error } = authMode === "signin"
    ? await supabaseClient.auth.signInWithPassword({ email, password })
    : await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            join_code: document.getElementById("auth-join-code").value.trim(),
            organisation_name: document.getElementById("auth-org-name").value.trim()
          }
        }
      });

  button.disabled = false;
  renderAuthMode();

  if (error) {
    showAuthError(error.message);
    return;
  }

  // Signing up returns no session when the project asks for email confirmation.
  // Nothing else happens until the user clicks the link in that email.
  if (!data.session) {
    authMode = "signin";
    renderAuthMode();
    showAuthNotice("Account created. Check your email for the confirmation link, then sign in.");
    return;
  }

  document.getElementById("auth-password").value = "";
  // applySession takes it from here, through onAuthStateChange.
});

document.getElementById("sign-out").addEventListener("click", async () => {
  disarmCallGuard();
  exitPreview();
  await supabaseClient.auth.signOut();

  // Leave nothing from the previous session on screen.
  state.issueText = "";
  state.matches = [];
  state.selectedKBA = null;
  state.log = [];
  state.captured = {};
  editorModel = null;
  document.getElementById("issue-text").value = "";
  document.getElementById("match-results").innerHTML = "";
});

// ---------------------------------------------------------------------------
// Starting up, and failing to
// ---------------------------------------------------------------------------
//
// A blank screen with an error in the console tells an analyst nothing. Anything
// that stops the app starting is caught here and shown on the page instead.
//
// The two kinds of failure need different things from whoever is reading:
//
//   network        the app is fine, something between here and Supabase is not.
//                  Worth trying again, possibly in a minute.
//   configuration  the app will never start with these values. Trying again
//                  changes nothing; config.js has to be corrected first.
//
// Anything unrecognised is treated as a network problem, because offering a
// retry that does nothing is a smaller error than withholding one that would
// have worked.

const FAILURE_NETWORK = "network";
const FAILURE_CONFIGURATION = "configuration";

function classifyFailure(error) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return FAILURE_NETWORK;

  const text = String((error && (error.message || error.msg)) || error || "").toLowerCase();

  if (/invalid api key|invalid.*url|jwt|apikey|api key|unauthorized|401|403|forbidden|no api key/.test(text)) {
    return FAILURE_CONFIGURATION;
  }

  if (/failed to fetch|networkerror|network request failed|load failed|err_|timeout|timed out|offline|dns/.test(text)) {
    return FAILURE_NETWORK;
  }

  return FAILURE_NETWORK;
}

// Copy for each way the app can refuse to start. Kept together so the wording
// stays consistent across them.
function describeStartupFailure(reason, error) {
  if (reason === "library-missing") {
    return {
      kind: FAILURE_NETWORK,
      title: "The app could not finish loading",
      detail: "A part of the app is served from a CDN and it did not arrive. That is usually a " +
              "connection problem or a blocker in the browser. Check you are online and try again.",
      action: "Try again"
    };
  }

  if (reason === "config-missing") {
    return {
      kind: FAILURE_CONFIGURATION,
      title: "Not connected yet",
      detail: "This copy of the app has no Supabase project to talk to. Add your project URL and " +
              "anon key to config.js, then reload. The schema those keys expect is in " +
              "supabase-setup.sql.",
      action: "Reload"
    };
  }

  if (reason === "config-invalid") {
    return {
      kind: FAILURE_CONFIGURATION,
      title: "The project settings are not valid",
      detail: "Supabase rejected the project URL or anon key in config.js. Check them against " +
              "Project Settings then API in your Supabase dashboard, then reload. Trying again " +
              "will not help until they are corrected.",
      action: "Reload"
    };
  }

  if (classifyFailure(error) === FAILURE_CONFIGURATION) {
    return {
      kind: FAILURE_CONFIGURATION,
      title: "The KBA library refused the connection",
      detail: "Supabase answered, but rejected this app's project URL or anon key. Check them " +
              "against Project Settings then API in your Supabase dashboard, then reload. " +
              "Trying again will not help until they are corrected.",
      action: "Reload"
    };
  }

  return {
    kind: FAILURE_NETWORK,
    title: "The KBA library could not be reached",
    detail: "The app could not get through to Supabase. That is usually a connection problem " +
            "rather than anything wrong with the app itself. Check you are online and try again.",
    action: "Try again"
  };
}

function showStartupFailure(reason, error) {
  const failure = describeStartupFailure(reason, error);

  document.getElementById("app-loading").hidden = true;
  document.getElementById("screen-auth").hidden = true;
  document.getElementById("app-shell").hidden = true;
  document.getElementById("app-nav").hidden = true;

  document.getElementById("app-failed-title").textContent = failure.title;
  document.getElementById("app-failed-detail").textContent = failure.detail;

  const reasonEl = document.getElementById("app-failed-reason");
  const technical = error && (error.message || String(error));
  reasonEl.textContent = technical || "";
  reasonEl.hidden = !technical;

  const retry = document.getElementById("app-retry");
  retry.textContent = failure.action;
  retry.disabled = false;

  // A configuration problem cannot be retried away, so that button reloads the
  // page instead — which is what the user has to do after editing config.js.
  retry.onclick = failure.kind === FAILURE_CONFIGURATION
    ? () => window.location.reload()
    : () => boot();

  document.getElementById("app-failed").hidden = false;
}

// Only ever one auth listener, however many times boot runs.
let authSubscribed = false;

async function boot() {
  document.getElementById("app-failed").hidden = true;
  document.getElementById("app-loading").hidden = false;

  if (!supabaseClient) {
    showStartupFailure(supabaseClientProblem || "config-missing", null);
    return;
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    await applySession(session);

    if (!authSubscribed) {
      authSubscribed = true;
      supabaseClient.auth.onAuthStateChange((event, session) => {
        applySession(session).catch(error => {
          console.error(error);
          showStartupFailure(null, error);
        });
      });
    }
  } catch (error) {
    console.error(error);
    showStartupFailure(null, error);
  }
}

boot();
