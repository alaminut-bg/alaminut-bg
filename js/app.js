import { signIn, signOut, loadProfile, isAdmin, currentProfile, onAuth } from './auth.js';
import { showScreen, setStatus } from './ui.js';

async function route() {
  const p = await loadProfile();
  if (!p || !p.active) { showScreen('screen-login'); return; }

  if (isAdmin()) {
    showScreen('screen-admin');
    document.getElementById('aWho').textContent = p.display_name;
    const { renderAdmin } = await import('./admin-day.js');
    await renderAdmin();
  } else {
    showScreen('screen-user');
    const { renderUserScreen } = await import('./orders.js');
    await renderUserScreen();
  }
}

function bindLogin() {
  const btn = document.getElementById('liBtn');
  const user = document.getElementById('liUser');
  const pass = document.getElementById('liPass');
  const err = document.getElementById('liErr');

  async function submit() {
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Влизане…';
    try {
      await signIn(user.value, pass.value);
      pass.value = '';
      await route();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Вход';
    }
  }

  btn.onclick = submit;
  user.onkeydown = e => { if (e.key === 'Enter') pass.focus(); };
  pass.onkeydown = e => { if (e.key === 'Enter') submit(); };
}

function bindSignOut() {
  for (const id of ['uOut', 'aOut']) {
    const el = document.getElementById(id);
    if (el) el.onclick = async () => {
      await signOut();
      showScreen('screen-login');
      setStatus('');
    };
  }
}

onAuth(event => { if (event === 'SIGNED_OUT') showScreen('screen-login'); });

// The day rolls over at midnight; a phone left open would keep showing
// yesterday. Re-route when the tab comes back into view.
let lastSeen = null;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  const now = new Date().toDateString();
  if (lastSeen && lastSeen !== now) await route();
  lastSeen = now;
});
lastSeen = new Date().toDateString();

bindLogin();
bindSignOut();
route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* not fatal */ });
  });
}

// handy during setup
window.__alaminut = { signOut, currentProfile, isAdmin, route };
