// Authentication helpers wrapping Supabase Auth.
import { supabase } from "./supabaseClient.js";

// Supabase Auth needs an email under the hood, but users only ever see a plain
// username. We map "vicky" -> "vicky@books.local" behind the scenes. If someone
// types a full email it is kept as-is (so old email logins still work).
const LOGIN_DOMAIN = "books.local";
export function usernameToEmail(username) {
  const u = String(username || "").trim().toLowerCase();
  return u.includes("@") ? u : `${u}@${LOGIN_DOMAIN}`;
}

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  // Save a fresh backup of this client's own data before leaving (best effort).
  try { await supabase.rpc("backup_my_data"); } catch (e) { /* ignore */ }
  await supabase.auth.signOut();
}

export async function changePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}
