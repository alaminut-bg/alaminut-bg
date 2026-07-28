import * as api from './api.js';
import { esc } from './util.js';
import { ask, askText, flashSaved, setStatus } from './ui.js';

let people = [];

export async function renderPeople() {
  setStatus('зареждане…');
  try {
    people = await api.listProfiles();
    draw();
    setStatus('');
  } catch (e) { setStatus(e.message, 'err'); }
}

function draw() {
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
        '<input class="cat-search" id="npUser" placeholder="потребител на латиница (borisov)" ' +
          'autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off">' +
        '<input class="cat-search" id="npName" style="margin-top:9px" ' +
          'placeholder="звание и фамилия (лейт. Борисов)" autocomplete="off">' +
        '<input class="cat-search" id="npPass" style="margin-top:9px" type="text" ' +
          'placeholder="парола (поне 6 знака)" autocomplete="off">' +
        '<button class="btn-wide" id="npAdd" style="margin-top:11px">+ Създай акаунт</button>' +
      '</div>' +
    '</div>' +
    '<div class="set-block"><h2>Хора (' + people.length + ')</h2>' + rows + '</div>' +
    '<p class="set-note">Потребителското име е на латиница, защото с него се влиза. ' +
    'Званието и фамилията се показват в приложението. Няма възстановяване по имейл — ' +
    'администратор задава нова парола.</p>';

  bind();
}

function bind() {
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
