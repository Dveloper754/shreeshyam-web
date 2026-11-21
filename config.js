// ============================================================
//  EDIT THIS FILE — paste your two Supabase values here.
//  Get them in Supabase → Project Settings → API.
// ============================================================

export const SUPABASE_URL = "https://srv2001110.hstgr.cloud";

// This is the "anon public" key. It is safe to put in the browser
// because Row Level Security + login protect your data.
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzk1MjQxODMyLCJleHAiOjIxMTA2MDE4MzJ9._XV9wHYYS297rdU-3tTKQhsLVKlTkuCZp15-76TPaZk";

// Optional: the business name shown in the header.
export const BUSINESS_NAME = "thedeveloper";

// Version marker. BUMP THIS every time you deploy a new version (any new value is fine,
// e.g. the date + a number). Apps that are already open compare their running value to
// this one and, when it differs, show an "Update available" button — they never refresh
// on their own, so an ongoing match is never disturbed. The user taps it when it's safe.
export const APP_VERSION = "2026-11-21-35";

// AI voice entry (optional, website only). When true, the browser listens and
// sends what it heard to the "voice-parse" Edge Function, which uses Claude to
// understand Hinglish and pull out the bet fields far better than the built-in
// parser. It needs the function deployed and ANTHROPIC_API_KEY set as a Supabase
// secret. If it's off, not deployed, or the key is missing, the app automatically
// falls back to the free built-in browser voice. (Needs the browser's speech
// recognition, so it works on the website in Chrome, not the desktop/pendrive app.)
export const VOICE_AI = false;

// Cloud voice for the DESKTOP / pendrive app (ignored by the website — the browser
// keeps using its free built-in voice). When true, the installed app records a short
// clip and sends it to the "stt" Edge Function (OpenAI Whisper) → text → the bet
// parser. The app only turns this on when it detects it is running inside the desktop
// shell, so it is safe to leave true here even though this same file serves the website.
export const VOICE_CLOUD = true;
