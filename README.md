# KBA Assistant

A guided troubleshooting tool for first-line IT support analysts.

An analyst describes the issue a caller reported, the app matches it to an
approved knowledge base article (KBA), walks them through that KBA's steps one at
a time, and produces a structured ticket description at the end.

## The problem

Every first-line call follows the same shape: find the right procedure, work
through it, write it up. Each step leaks time and consistency.

- Analysts search manually through the KBA library before troubleshooting starts
- The depth and order of checks vary between analysts, because most are recalled
  from memory rather than followed step by step
- The incident note is typed by hand, so its clarity depends on how confident
  that analyst is writing under time pressure
- Second-line teams inherit that variance and bounce tickets back for rework

The cost is not one bad ticket. It is the accumulated drag of every call where
diagnosis and documentation quality depend on the individual rather than the
process.

## How it works

1. **Describe or search** — the analyst types what the caller reported, or
   searches the library directly if they already know which KBA they need
2. **Match** — keyword scoring ranks the library, showing the best match plus
   alternatives, so the analyst keeps the final say
3. **Guided flow** — the KBA's steps are presented one at a time, with an
   optional screenshot per step. An "issue resolved" button ends the call early
   when the problem is fixed
4. **Review** — a structured description is generated from the checks actually
   performed, along with any details the KBA requires. The analyst edits it
   before copying into the ticket system

The generated text is always a draft. The analyst is accountable for what goes
into the ticket, so the app never submits anything on their behalf.

## Design decisions worth knowing

**Alternatives are always shown.** A single silent match trains analysts to
accept whatever appears. Showing the runners-up makes a wrong match a two-second
correction rather than a wrong procedure.

**Early exit resolves, but never escalates.** If the issue is fixed after two
checks, the analyst stops and only those two appear in the description.
Escalating still requires working through the full procedure, because an
incomplete escalation is exactly what second line sends back.

**The flow runs client-side.** Once a KBA is loaded, working through it needs no
network. A support call should not depend on store wifi holding up.

**Nothing about a call is stored.** The app persists KBAs, not tickets or
sessions. There is no retention policy to enforce and no incident data to leak.
The trade-off is that it cannot report on resolution rates or handle time — if
those become requirements, the design changes substantially.

## Tech

- Plain HTML, CSS and JavaScript — no framework, no build step
- Supabase for Postgres, auth and file storage
- Row level security for tenant isolation, enforced in the database rather than
  in application code
- `pdf.js` for client-side text extraction from uploaded KBA documents
- Deployed as static files

## Roles

| | Analyst | Admin |
|---|---|---|
| Run a call | Yes | Yes |
| Search the library | Yes | Yes |
| Create, edit, delete KBAs | No | Yes |
| See the organisation join code | No | Yes |

Signing up without a join code creates a new organisation and makes you its
admin. Signing up with one joins that organisation as an analyst.

## Running it locally

You will need a Supabase project.

1. Clone the repo
2. In the Supabase SQL editor, run the schema, then the organisations and roles
   migration, then the storage policies
3. Create `config.js` in the project root:

   ```js
   const SUPABASE_URL = "https://your-project-ref.supabase.co";
   const SUPABASE_ANON_KEY = "your-publishable-key";
   ```

   The publishable key is safe to commit. Row level security is what protects
   the data, not key secrecy. Never put the service role or secret key here.

4. Serve the folder — the Live Server extension for VS Code works fine
5. Sign up without a join code to create an organisation and become its admin

## Known limitations

- **Branching KBAs cannot be built through the UI.** The editor handles linear
  procedures. Anything with branches has to be authored directly in the database.
- **Join codes do not expire.** Anyone holding one can join the organisation. A
  real deployment needs expiring codes or admin approval.
- **Matching is keyword scoring, not language understanding.** It works when the
  analyst's wording overlaps the KBA's keywords. Postgres full-text search is the
  natural next step.
- **Scanned PDFs cannot be read.** Text extraction needs a text layer. A scan is
  an image of a document, and OCR is not implemented.
- **Not tested with real analysts.** The flow is reconstructed from system design
  work rather than validated through observation or interviews.

## Status

Working prototype. Multi-user, with auth, roles and a real database, but not
deployed against a real support desk.

All KBAs, procedures and screenshots in this repository are fictional and written
for demonstration. Nothing here reproduces any employer's internal documentation.
