/** Both screens have their own status line; write to whichever is visible. */
function statusEl() {
  const admin = document.getElementById('statusAdmin');
  if (admin && admin.closest('.screen')?.classList.contains('active')) return admin;
  return document.getElementById('status');
}

export function setStatus(msg, cls) {
  const el = statusEl();
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

/** Transient "saved" flash that does not clobber a later message. */
export function flashSaved() {
  setStatus('✓ запазено', 'ok');
  setTimeout(() => {
    const el = statusEl();
    if (el && el.textContent === '✓ запазено') setStatus('');
  }, 1500);
}

export function ask(title, text, yesLabel, calm) {
  return new Promise(resolve => {
    const ovl = document.getElementById('ovl');
    const yes = document.getElementById('dlgYes');
    const no = document.getElementById('dlgNo');
    document.getElementById('dlgTitle').textContent = title;
    document.getElementById('dlgText').textContent = text;
    yes.textContent = yesLabel || 'Да';
    yes.classList.toggle('calm', !!calm);
    ovl.classList.remove('hidden');
    function done(v) {
      ovl.classList.add('hidden');
      yes.onclick = null; no.onclick = null; ovl.onclick = null;
      resolve(v);
    }
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    ovl.onclick = e => { if (e.target === ovl) done(false); };
  });
}

/** Single-line text prompt. Replaces window.prompt, which is blocked in
 *  standalone PWAs on iOS and looks alien everywhere else. */
export function askText(title, text, value = '', placeholder = '') {
  return new Promise(resolve => {
    const ovl = document.getElementById('ovlInput');
    const inp = document.getElementById('inpField');
    const yes = document.getElementById('inpYes');
    const no = document.getElementById('inpNo');
    document.getElementById('inpTitle').textContent = title;
    document.getElementById('inpText').textContent = text;
    inp.value = value;
    inp.placeholder = placeholder;
    ovl.classList.remove('hidden');
    setTimeout(() => inp.focus(), 30);
    function done(v) {
      ovl.classList.add('hidden');
      yes.onclick = null; no.onclick = null; ovl.onclick = null; inp.onkeydown = null;
      resolve(v);
    }
    yes.onclick = () => done(inp.value.trim() || null);
    no.onclick = () => done(null);
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value.trim() || null); };
    ovl.onclick = e => { if (e.target === ovl) done(null); };
  });
}

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s =>
    s.classList.toggle('active', s.id === id));
}
