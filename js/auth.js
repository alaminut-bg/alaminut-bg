import { sb } from './supabase.js';

const EMAIL_DOMAIN = 'alaminut.local';
let profile = null;

export function currentProfile() { return profile; }
export function isAdmin() { return profile?.role === 'admin'; }

/** Usernames are latin because they become an email local part. */
export async function signIn(username, password) {
  const u = String(username || '').trim().toLowerCase();
  if (!u || !password) throw new Error('Въведи потребител и парола.');

  const { error } = await sb.auth.signInWithPassword({
    email: `${u}@${EMAIL_DOMAIN}`,
    password,
  });
  if (error) throw new Error('Грешен потребител или парола.');

  const p = await loadProfile();
  if (!p) {
    await sb.auth.signOut();
    throw new Error('Профилът липсва. Обади се на администратор.');
  }
  if (!p.active) {
    await sb.auth.signOut();
    throw new Error('Профилът е деактивиран.');
  }
}

export async function signOut() {
  profile = null;
  await sb.auth.signOut();
}

export async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { profile = null; return null; }

  const { data, error } = await sb
    .from('profiles')
    .select('id, username, display_name, role, active')
    .eq('id', session.user.id)
    .maybeSingle();

  profile = error ? null : data;
  return profile;
}

export function onAuth(cb) {
  sb.auth.onAuthStateChange(event => cb(event));
}
