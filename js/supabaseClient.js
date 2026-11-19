// Creates the single shared Supabase client used across the app.
// The Supabase library is loaded from js/vendor/supabase.umd.js (a normal
// <script> tag in index.html), so there is NO dependency on an external CDN
// at runtime — the app keeps working even if a CDN is down.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

const createClient = window.supabase && window.supabase.createClient;

export const isConfigured =
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes("YOUR-PROJECT-ID") &&
  !SUPABASE_ANON_KEY.includes("YOUR-ANON");

// Keep the login only for the current browser session: closing the browser (or
// the desktop app) logs the user out, so reopening always asks for the password.
// A page refresh during use keeps you signed in.
let _store;
try { _store = window.sessionStorage; _store.getItem("x"); } catch (e) { _store = undefined; }

export const supabase = (isConfigured && createClient)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: _store },
    })
  : null;
