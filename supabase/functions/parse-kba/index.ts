// parse-kba — turns an uploaded PDF into a draft KBA.
//
// Gemini reads PDFs natively, scans included, so the file goes across as inline
// data rather than being turned into text first. Nothing is saved here: the
// draft goes back to the browser, fills in the form, and an admin decides what
// of it is right before anything is written.
//
// Deploy:
//   supabase secrets set GEMINI_API_KEY=your-key
//   supabase functions deploy parse-kba
//
// Optional: GEMINI_MODEL, defaulting to gemini-2.0-flash.
//
// The API key is read from the environment here and never leaves this function.
// The browser only ever sees the draft.
//
// This file is deliberately thin. Everything worth testing lives in handler.ts
// and draft.ts, neither of which reaches for a runtime API of its own.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { handleRequest } from "./handler.ts";

Deno.serve((req: Request) => handleRequest(req, {
  env: (name: string) => Deno.env.get(name),
  createClient,
  fetch: (input: string, init?: RequestInit) => fetch(input, init)
}));
