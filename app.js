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
  resolvedAfter: ""
};

// Used only when a KBA offers no resolve outcome at all from where the analyst
// is standing. Every KBA the form builds has one, so this is a backstop for
// hand-authored flows rather than something the app expects to reach.
const FALLBACK_RESOLVE = { type: "outcome", outcome: "resolve" };

// The resolve outcome this call was heading for. Ending early lands on the
// ending the KBA defines, so the review screen asks for that outcome's capture
// fields and carries its note, exactly as working through every step would.
//
// Breadth first, so when a KBA branches to several resolve outcomes the nearest
// one along the paths still ahead wins rather than whichever happens to be
// first in the object.
function findResolveOutcome(kba, fromStepId) {
  const queue = [fromStepId];
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const step = kba.steps[id];
    if (!step) continue;

    if (step.type === "outcome") {
      if (step.outcome === "resolve") return step;
      continue;                                   // an escalate or callback ending
    }

    if (step.type === "question") (step.options || []).forEach(option => queue.push(option.next));
    else queue.push(step.next);
  }

  return null;
}

function scoreKBA(kba, text) {
  const lower = text.toLowerCase();
  let score = 0;
  kba.keywords.forEach(k => {
    if (lower.includes(k.toLowerCase())) score += k.split(" ").length;
  });
  return score;
}

function findMatches(text) {
  return KBAS
    .map(kba => ({ kba, score: scoreKBA(kba, text) }))
    .filter(m => m.score > 0)
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
  state.issueText = document.getElementById("issue-text").value;
  state.selectedKBA = KBAS.find(k => k.id === id);
  state.currentStepId = state.selectedKBA.start;
  state.log = [];
  state.captured = {};
  state.resolvedAfter = "";
  showScreen("screen-flow");
  renderFlowStep();
}

function renderFlowStep() {
  const kba = state.selectedKBA;
  const step = kba.steps[state.currentStepId];

  document.getElementById("flow-title").textContent = kba.title;

  const logEl = document.getElementById("flow-log");
  logEl.innerHTML = state.log
    .map((e, i) => `<div class="log-item"><i class="ti ti-check"></i><span>${i + 1} - ${escapeHtml(e.label)} - ${escapeHtml(e.answer)}</span></div>`)
    .join("");

  const stepEl = document.getElementById("flow-step");

  if (step.type === "outcome") {
    goToReview(step);
    return;
  }

  if (step.type === "action") {
    // Already signed, so this is a straight lookup. Nothing here goes to the
    // network before the step is on screen.
    const imageUrl = step.image ? IMAGE_URLS[step.image] : "";

    stepEl.innerHTML = `
      <p class="step-text">${escapeHtml(step.text)}</p>
      ${imageUrl ? `<figure class="step-image"><img src="${escapeHtml(imageUrl)}" alt="Screenshot for this step" /></figure>` : ""}
      <div class="option-row">
        <button class="btn btn-primary" id="flow-next">Mark done and continue</button>
        <button class="btn btn-ghost" id="flow-resolved">Issue resolved</button>
      </div>
    `;

    const image = stepEl.querySelector(".step-image img");
    if (image) {
      // A link that has expired or a file that has gone should not leave a
      // broken icon sitting in the middle of a call.
      image.addEventListener("error", () => { image.closest(".step-image").hidden = true; });
    }

    document.getElementById("flow-next").addEventListener("click", () => {
      state.log.push({ label: step.label || step.text, answer: "Yes" });
      state.currentStepId = step.next;
      renderFlowStep();
    });

    document.getElementById("flow-resolved").addEventListener("click", () => {
      const label = step.label || step.text;

      // A misclick here closes a call that is still open, so it asks first.
      if (!confirm(
        `End the call here?\n\n` +
        `The checks you have completed will be recorded, with "${label}" as the one ` +
        `that fixed it. Any steps after this one will not be recorded as performed.`)) return;

      // This step was carried out — it is what resolved the issue. The ones
      // after it are simply never reached, so they never reach the log either.
      state.log.push({ label, answer: "Yes" });
      state.resolvedAfter = label;

      goToReview(findResolveOutcome(kba, step.next) || FALLBACK_RESOLVE);
    });
    return;
  }

  stepEl.innerHTML = `
    <p class="step-text">${escapeHtml(step.text)}</p>
    <div class="option-row">
      ${step.options.map(o => `<button class="btn btn-ghost" data-next="${escapeHtml(o.next)}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`).join("")}
    </div>
  `;

  stepEl.querySelectorAll("[data-next]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!step.outcomeCheck) {
        state.log.push({
          label: step.label || step.text,
          answer: btn.dataset.label
        });
      }
      state.currentStepId = btn.dataset.next;
      renderFlowStep();
    });
  });
}

function goToReview(outcomeStep) {
  showScreen("screen-review");
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
    const row = document.createElement("div");
    row.className = "field-row";
    row.innerHTML = `<label>${escapeHtml(f)}</label><input type="text" data-field="${escapeHtml(f)}" placeholder="Enter ${escapeHtml(f.toLowerCase())}" />`;
    fieldsEl.appendChild(row);
  });
  fieldsEl.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", () => {
      state.captured[input.dataset.field] = input.value;
      renderDescription(outcomeStep);
    });
  });

  renderDescription(outcomeStep);
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function renderDescription(outcomeStep) {
  const raw = state.issueText.trim().replace(/\.$/, "");
  const issueLine = `User contacted to report ${raw ? lowerFirst(raw) : "an issue"}`;

  const parts = [issueLine];

  const checks = state.log
    .map((e, i) => `${i + 1} - ${e.label} - ${e.answer}`)
    .join("\n");
  if (checks) parts.push("", "Checks performed", checks);

  if (state.resolvedAfter) parts.push("", `Resolved after this check - ${state.resolvedAfter}`);

  const fields = (outcomeStep.captureFields || [])
    .map(f => `${f} - ${state.captured[f] || ""}`)
    .join("\n");
  if (fields) parts.push("", fields);

  if (outcomeStep.note) parts.push("", outcomeStep.note);

  if (outcomeStep.outcome === "resolve") {
    parts.push("", "Issue resolved", "Shared the reference number");
  } else if (outcomeStep.outcome === "callback") {
    parts.push("", "Shared the reference number");
  } else {
    parts.push("", "Assigning to the second line team", "Shared the reference number");
  }

  document.getElementById("review-description").value = parts.join("\n");
}

// ---------------------------------------------------------------------------
// Manage KBAs screen
// ---------------------------------------------------------------------------

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

document.getElementById("nav-team").addEventListener("click", () => {
  showScreen("screen-team");
  renderTeamScreen();
});

document.getElementById("new-kba").addEventListener("click", () => openEditor(null));

document.getElementById("nav-manage").addEventListener("click", () => {
  showScreen("screen-manage");
  renderManageScreen();
});

document.getElementById("nav-call").addEventListener("click", () => {
  showScreen("screen-intake");
});

document.getElementById("reset-kbas").addEventListener("click", async () => {
  if (!confirm("Reset the library back to the original KBAs? Any changes will be lost.")) return;

  const images = imagePathsIn(KBAS);

  if (!await runStorageAction(() => resetKBAs(), "manage-message")) return;

  await tidyImages(images);
  renderManageScreen();
});

document.getElementById("kba-search").addEventListener("input", renderSearchResults);

document.getElementById("find-kba").addEventListener("click", () => {
  state.issueText = document.getElementById("issue-text").value;
  state.matches = findMatches(state.issueText);
  renderIntake();
});

document.getElementById("copy-description").addEventListener("click", () => {
  const ta = document.getElementById("review-description");
  ta.select();
  document.execCommand("copy");
});

document.getElementById("start-over").addEventListener("click", () => {
  state.issueText = "";
  state.matches = [];
  state.selectedKBA = null;
  state.log = [];
  state.captured = {};
  state.resolvedAfter = "";
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
  return { text: "", label: "", imagePath: "", imageFile: null, imagePreview: "" };
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
    escalate: { team: "", note: "", captureFields: [] }
  };
}

// Returns a form model, or null if the KBA is not linear and so cannot be edited
// here. The walk fails closed on purpose: anything it does not fully recognise is
// left to kba-data.js rather than risking a save that quietly drops steps.
function toFormModel(kba) {
  const actions = [];
  const visited = new Set();

  let stepId = kba.start;
  while (kba.steps[stepId] && kba.steps[stepId].type === "action") {
    if (visited.has(stepId)) return null;
    visited.add(stepId);
    const step = kba.steps[stepId];
    actions.push({
      text: step.text,
      label: step.label || "",
      imagePath: step.image || "",
      imageFile: null,
      imagePreview: ""
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
    }
  };
}

// Steps are renumbered s1, s2, s3... on every save. The ids are internal, and
// every "next" pointer is rewritten here, so renumbering is safe.
function fromFormModel(model) {
  const steps = {};

  model.actions.forEach((action, index) => {
    steps[`s${index + 1}`] = {
      type: "action",
      text: action.text,
      ...(action.label ? { label: action.label } : {}),
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

  document.getElementById("pdf-file").value = "";
  document.getElementById("pdf-status").hidden = true;
  document.getElementById("source-text").value = model.sourceText;

  if (model.sourceText) {
    document.getElementById("source-summary").textContent =
      "Kept with this KBA from when it was written.";
    openSourcePanel();
  } else {
    closeSourcePanel();
  }

  renderActionSteps();
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
      <label class="field-label">What the analyst does</label>
      <textarea rows="2" data-action-text placeholder="e.g. Check and note the light status on the base unit of the till.">${escapeHtml(action.text)}</textarea>
      <label class="field-label">Short label for the ticket <span class="hint">optional — the step text is used if this is blank</span></label>
      <input type="text" data-action-label value="${escapeHtml(action.label)}" placeholder="e.g. Checked base unit light status" />

      <label class="field-label">Screenshot <span class="hint">optional — an image up to 2 MB</span></label>
      ${stepImagePreview(action, index)}
      <input type="file" accept="image/*" data-action-image="${index}" />
      <p class="errors step-image-error" data-image-error="${index}" hidden></p>
    </div>
  `).join("");

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
    return {
      text: row.querySelector("[data-action-text]").value.trim(),
      label: row.querySelector("[data-action-label]").value.trim(),
      imagePath: existing.imagePath,
      imageFile: existing.imageFile,
      imagePreview: existing.imagePreview
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
    if (!action.text) errors.push(`Step ${index + 1} needs a description of what the analyst does.`);
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
    if (step.type === "action") return [step.next];
    return [];
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

document.getElementById("pdf-file").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;

  if (!pdfReady()) {
    showPdfStatus(
      "The PDF reader did not load, so the file cannot be read here. Check your connection " +
      "and reload the page, or fill the form in by hand.", true);
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
        `of text in it. That almost always means it is a scan \u2014 a picture of a document rather ` +
        `than a document. Pulling text out of a picture needs OCR, which this app does not do. ` +
        `Export a PDF from the original file if you can, or type the steps in by hand.`, true);
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
  if (document.getElementById("screen-manage").classList.contains("active")) renderManageScreen();

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
