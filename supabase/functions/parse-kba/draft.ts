// The half of parse-kba that has no dependencies: what to ask Gemini for, and
// what has to be true of the answer before it goes anywhere near a client.
//
// Nothing here touches Deno, the network or the database, so it can be run and
// tested on its own. index.ts holds everything that cannot.

export type UncertainItem = { field: string; note: string };
export type ActionStep = { text: string; label: string };

export type DraftKBA = {
  reference: string;
  title: string;
  keywords: string[];
  issue_example: string;
  action_steps: ActionStep[];
  final_question: string;
  resolve: { note: string; capture_fields: string[] };
  escalate: { team: string; note: string; capture_fields: string[] };
  uncertain: UncertainItem[];
};

// The names an uncertain item may point at. The client anchors its warnings to
// these, so anything outside the list is shown at the top of the form instead of
// being dropped — a flag nobody sees is worse than one in the wrong place.
export const UNCERTAIN_FIELDS = [
  "reference",
  "title",
  "keywords",
  "issue_example",
  "final_question",
  "resolve_note",
  "resolve_capture_fields",
  "escalate_team",
  "escalate_note",
  "escalate_capture_fields"
];

// step_1, step_2 and so on are also valid, and are checked by pattern.
export const UNCERTAIN_STEP_PATTERN = /^step_[1-9][0-9]*$/;

// Gemini honours a response schema, which removes most of the ways a model can
// hand back something shaped almost right. It is not a substitute for the checks
// below — a schema cannot say that a reference is a slug or that a flow ends.
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reference: { type: "string" },
    title: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    issue_example: { type: "string" },
    action_steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          label: { type: "string" }
        },
        required: ["text", "label"]
      }
    },
    final_question: { type: "string" },
    resolve: {
      type: "object",
      properties: {
        note: { type: "string" },
        capture_fields: { type: "array", items: { type: "string" } }
      },
      required: ["note", "capture_fields"]
    },
    escalate: {
      type: "object",
      properties: {
        team: { type: "string" },
        note: { type: "string" },
        capture_fields: { type: "array", items: { type: "string" } }
      },
      required: ["team", "note", "capture_fields"]
    },
    uncertain: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          note: { type: "string" }
        },
        required: ["field", "note"]
      }
    }
  },
  required: [
    "reference", "title", "keywords", "issue_example", "action_steps",
    "final_question", "resolve", "escalate", "uncertain"
  ]
};

export const PROMPT = [
  "You are reading a knowledge base article used by first-line IT support analysts",
  "in a retail company. Turn it into a draft for their troubleshooting assistant.",
  "",
  "The assistant walks an analyst through one KBA during a phone call: a list of",
  "actions to carry out in order, then a single yes/no question. Yes means the",
  "issue is resolved; no means it is escalated to another team.",
  "",
  "Return JSON only, with these fields:",
  "",
  "  reference        a short slug identifying the KBA: lower case letters, digits",
  "                   and single hyphens, starting with 'kba-'. Derive it from the",
  "                   title, for example kba-till-not-powering-on.",
  "  title            a short name for the problem, as an analyst would say it.",
  "  keywords         words and short phrases an analyst might type when describing",
  "                   this call. Include the words a caller would use, not only the",
  "                   formal ones. Between five and ten.",
  "  issue_example    one sentence in the voice of a caller reporting this issue.",
  "  action_steps     the things the analyst does, in the order the document gives",
  "                   them. Each has:",
  "                     text   the instruction shown on screen, a full sentence.",
  "                     label  a short past-tense summary for the ticket, for",
  "                            example 'Checked base unit light status'.",
  "                   Include only steps the analyst performs. Do not include the",
  "                   final check of whether it worked; that is the question below.",
  "  final_question   the single yes/no question that decides whether the issue is",
  "                   fixed, for example 'Did the till power on?'.",
  "  resolve          what happens when the answer is yes:",
  "                     note            a sentence for the ticket, or an empty string.",
  "                     capture_fields  details to record on a resolved call, or [].",
  "  escalate         what happens when the answer is no:",
  "                     team            the team it goes to, or an empty string.",
  "                     note            a sentence for the ticket, or an empty string.",
  "                     capture_fields  details second line will need, for example",
  "                                     'Till number'. Use [] if the document says none.",
  "  uncertain        anything you could not read confidently. Each entry has:",
  "                     field  one of: " + UNCERTAIN_FIELDS.join(", ") + ",",
  "                            or step_1, step_2 and so on for a particular step.",
  "                     note   what was unclear and what you assumed, in one sentence.",
  "",
  "Rules:",
  "- Use only what the document says. Do not invent steps, teams or field names.",
  "- If the document is a scan, read it as best you can and record anything you had",
  "  to guess in uncertain.",
  "- If the document describes branching paths beyond one yes/no question, flatten",
  "  it to the main path and say so in uncertain.",
  "- Every field must be present. Use an empty string or an empty array rather than",
  "  omitting one.",
  "- There must be at least one action step and a final question.",
  "- uncertain may be empty, but only if you genuinely read everything clearly."
].join("\n");

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText).filter(Boolean) : [];
}

// Trims, drops blanks and fills in anything missing, so the checks below and the
// client are working with the same predictable shape.
export function normaliseDraft(raw: any): DraftKBA {
  const steps = Array.isArray(raw?.action_steps) ? raw.action_steps : [];

  return {
    reference: asText(raw?.reference).toLowerCase(),
    title: asText(raw?.title),
    keywords: asList(raw?.keywords),
    issue_example: asText(raw?.issue_example),
    action_steps: steps
      .map((step: any) => ({ text: asText(step?.text), label: asText(step?.label) }))
      .filter((step: ActionStep) => step.text !== ""),
    final_question: asText(raw?.final_question),
    resolve: {
      note: asText(raw?.resolve?.note),
      capture_fields: asList(raw?.resolve?.capture_fields)
    },
    escalate: {
      team: asText(raw?.escalate?.team),
      note: asText(raw?.escalate?.note),
      capture_fields: asList(raw?.escalate?.capture_fields)
    },
    uncertain: (Array.isArray(raw?.uncertain) ? raw.uncertain : [])
      .map((item: any) => ({ field: asText(item?.field), note: asText(item?.note) }))
      .filter((item: UncertainItem) => item.note !== "")
  };
}

// Does the draft carry what a KBA cannot do without? Returns the problems, so
// all of them can be reported at once rather than one per attempt.
export function validateDraft(draft: DraftKBA): string[] {
  const problems: string[] = [];

  if (!draft.title) problems.push("no title");
  if (!draft.reference) problems.push("no reference");
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(draft.reference)) {
    problems.push(`the reference "${draft.reference}" is not a slug`);
  }

  if (!draft.keywords.length) problems.push("no keywords");
  if (!draft.action_steps.length) problems.push("no action steps");
  if (!draft.final_question) problems.push("no final question");

  draft.action_steps.forEach((step, index) => {
    if (!step.text) problems.push(`step ${index + 1} has no text`);
  });

  return problems;
}

// The same flow the client's form builds, so what is validated here is what the
// admin would end up saving.
export function buildFlow(draft: DraftKBA): any {
  const steps: Record<string, any> = {};

  draft.action_steps.forEach((action, index) => {
    steps[`s${index + 1}`] = {
      type: "action",
      text: action.text,
      ...(action.label ? { label: action.label } : {}),
      next: index === draft.action_steps.length - 1 ? "final" : `s${index + 2}`
    };
  });

  steps.final = {
    type: "question",
    text: draft.final_question,
    outcomeCheck: true,
    options: [
      { label: "Yes", next: "resolve" },
      { label: "No", next: "escalate" }
    ]
  };

  steps.resolve = { type: "outcome", outcome: "resolve" };
  if (draft.resolve.note) steps.resolve.note = draft.resolve.note;
  if (draft.resolve.capture_fields.length) steps.resolve.captureFields = draft.resolve.capture_fields;

  steps.escalate = { type: "outcome", outcome: "escalate" };
  if (draft.escalate.team) steps.escalate.team = draft.escalate.team;
  if (draft.escalate.note) steps.escalate.note = draft.escalate.note;
  if (draft.escalate.capture_fields.length) steps.escalate.captureFields = draft.escalate.capture_fields;

  return {
    id: draft.reference,
    title: draft.title,
    keywords: draft.keywords,
    ...(draft.issue_example ? { issueExample: draft.issue_example } : {}),
    start: "s1",
    steps
  };
}

// Every link lands on a step that exists, and every route ends on an outcome.
// The same walk the client runs before a save, done here so a half-formed flow
// is never returned in the first place.
export function validateFlow(kba: any): string[] {
  const problems: string[] = [];
  const steps = kba.steps || {};

  const exitsOf = (step: any): string[] => {
    if (step.type === "question") return (step.options || []).map((option: any) => option.next);
    if (step.type === "action") return [step.next];
    return [];
  };

  if (!steps[kba.start]) problems.push(`the flow starts at "${kba.start}", which is not a step`);

  for (const id of Object.keys(steps)) {
    for (const next of exitsOf(steps[id])) {
      if (!next) problems.push(`step "${id}" does not say what comes next`);
      else if (!steps[next]) problems.push(`step "${id}" leads to "${next}", which is not a step`);
    }
  }

  if (problems.length) return problems;

  const endsInAnOutcome = (id: string, visited: Set<string>): boolean => {
    const step = steps[id];
    if (step.type === "outcome") return true;

    if (visited.has(id)) {
      problems.push(`the steps loop back to "${id}" and never reach an outcome`);
      return false;
    }
    visited.add(id);

    return exitsOf(step).every((next: string) => endsInAnOutcome(next, new Set(visited)));
  };

  endsInAnOutcome(kba.start, new Set());
  return problems;
}

// Everything, in the order it has to happen. Returns the draft only if the flow
// it would produce is sound.
export function checkDraft(raw: any): { draft?: DraftKBA; problems: string[] } {
  const draft = normaliseDraft(raw);

  const problems = validateDraft(draft);
  if (problems.length) return { problems };

  const flowProblems = validateFlow(buildFlow(draft));
  if (flowProblems.length) return { problems: flowProblems };

  return { draft, problems: [] };
}
