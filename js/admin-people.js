import * as api from './api.js';
import { esc } from './util.js';
import { ask, askText, flashSaved, setStatus , showError } from './ui.js';

let people = [];
let total = 0;
let page = 0;
let query = '';
let searchTimer = null;

export async function renderPeople(keepFocus) {
  setStatus('зареждане…');
  try {
    const res = await api.listProfiles({ page, query });
    // Deleting the last person on a page would otherwise leave it blank.
    if (!res.rows.length && page > 0) {
      page = Math.max(0, Math.ceil(res.total / api.PEOPLE_PAGE_SIZE) - 1);
      return renderPeople(keepFocus);
    }
    people = res.rows;
    total = res.total;
    draw(keepFocus);
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
    showError('adminBody', e.message);
  }
}

function draw(keepFocus) {
  const pages = Math.max(1, Math.ceil(total / api.PEOPLE_PAGE_SIZE));
  const first = total ? page * api.PEOPLE_PAGE_SIZE + 1 : 0;
  const last = Math.min((page + 1) * api.PEOPLE_PAGE_SIZE, total);

  const rows = people.map(p =>
    '<div class="person-row' + (p.active ? '' : ' off') + '">' +
      '<div class="pinfo">' +
        '<div>' + esc(p.display_name) +
          (p.role === 'admin' ? ' <span class="tagadmin">АДМИН</span>' : '') + '</div>' +
        '<div class="pu">' + esc(p.username) + (p.active ? '' : ' · деактивиран') + '</div>' +
      '</div>' +
      '<button class="done-btn" data-ppass="' + p.id + '">Парола</button>' +
      '<button class="done-btn" data-prole="' + p.id + '">' +
        (p.role === 'admin' ? '↓ Потребител' : '↑ Админ') + '</button>' +
      '<button class="done-btn" data-pact="' + p.id + '">' +
        (p.active ? 'Изключи' : 'Включи') + '</button>' +
    '</div>').join('');

  document.getElementById('adminBody').innerHTML =
    '<div class="set-block">' +
      '<h2>Нов акаунт</h2>' +
      '<div class="set-foot">' +
        '<input class="cat-search" id="npUser" placeholder="потребител на латиница (ivanov)" ' +
          'autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off">' +
        '<input class="cat-search" id="npName" style="margin-top:9px" ' +
          'placeholder="звание и фамилия (р-к Иванов)" autocomplete="off">' +
        '<input class="cat-search" id="npPass" style="margin-top:9px" type="text" ' +
          'placeholder="парола (поне 6 знака)" autocomplete="off">' +
        '<button class="btn-wide" id="npAdd" style="margin-top:11px">+ Създай акаунт</button>' +
      '</div>' +
    '</div>' +
    '<div class="set-block">' +
      '<h2>Хора (' + total + ')</h2>' +
      '<div class="set-foot" style="padding-bottom:0">' +
        '<input class="cat-search" id="pplSearch" placeholder="търси по име или потребител…" ' +
          'value="' + esc(query) + '" autocomplete="off">' +
      '</div>' +
      (rows || '<div class="kempty" style="padding:16px">Няма съвпадение.</div>') +
      (pages > 1
        ? '<div class="pager">' +
            '<button id="pplPrev"' + (page === 0 ? ' disabled' : '') + '>‹</button>' +
            '<span>' + first + '–' + last + ' от ' + total + '</span>' +
            '<button id="pplNext"' + (page >= pages - 1 ? ' disabled' : '') + '>›</button>' +
          '</div>'
        : '') +
    '</div>' +
    '<p class="set-note">Потребителското име е на латиница, защото с него се влиза. ' +
    'Званието и фамилията се показват в приложението. Няма възстановяване по имейл — ' +
    'администратор задава нова парола.</p>';

  bind();

  if (keepFocus) {
    const el = document.getElementById('pplSearch');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}

function bind() {
  const s = document.getElementById('pplSearch');
  if (s) s.oninput = () => {
    query = s.value;
    page = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderPeople(true), 250);
  };

  const prev = document.getElementById('pplPrev');
  if (prev) prev.onclick = () => { page = Math.max(0, page - 1); renderPeople(); };
  const next = document.getElementById('pplNext');
  if (next) next.onclick = () => { page += 1; renderPeople(); };

  document.getElementById('npAdd').onclick = async () => {
    const btn = document.getElementById('npAdd');
    const username = document.getElementById('npUser').value.trim().toLowerCase();
    const display_name = document.getElementById('npName').value.trim();
    const password = document.getElementById('npPass').value;
    btn.disabled = true;
    try {
      await api.adminUsers('create', { username, display_name, password, role: 'user' });
      await renderPeople();
      flashSaved();
    } catch (e) {
      setStatus(e.message, 'err');
      btn.disabled = false;
    }
  };

  document.querySelectorAll('[data-ppass]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-ppass');
      const p = people.find(x => x.id === id);
      const pw = await askText('Нова парола', `За ${p.display_name}:`, '', 'поне 6 знака');
      if (!pw) return;
      try {
        await api.adminUsers('reset-password', { id, password: pw });
        flashSaved();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });

  document.querySelectorAll('[data-prole]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-prole');
      const p = people.find(x => x.id === id);
      const to = p.role === 'admin' ? 'user' : 'admin';
      if (!await ask('Смяна на права',
        to === 'admin'
          ? `„${p.display_name}“ ще може да променя менюто, цените и акаунтите.`
          : `„${p.display_name}“ вече няма да е администратор.`,
        'Промени', true)) return;
      try {
        await api.adminUsers('set-role', { id, role: to });
        await renderPeople();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });

  document.querySelectorAll('[data-pact]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-pact');
      const p = people.find(x => x.id === id);
      try {
        await api.adminUsers('set-active', { id, active: !p.active });
        await renderPeople();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });
}
