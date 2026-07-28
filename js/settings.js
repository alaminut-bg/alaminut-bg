import * as api from './api.js';
import { esc } from './util.js';
import { setStatus, flashSaved, ask } from './ui.js';
import { currentProfile, loadProfile } from './auth.js';

let open = false;

export function toggleSettings(onNameChanged) {
  open = !open;
  const box = document.getElementById('userSettings');
  box.classList.toggle('hidden', !open);
  document.getElementById('userBody').classList.toggle('hidden', open);
  if (open) draw(onNameChanged);
}

export function closeSettings() {
  open = false;
  document.getElementById('userSettings').classList.add('hidden');
  document.getElementById('userBody').classList.remove('hidden');
}

function draw(onNameChanged) {
  const me = currentProfile();

  document.getElementById('userSettings').innerHTML =
    '<div class="set-block">' +
      '<h2>Моето име</h2>' +
      '<div class="set-foot">' +
        '<input class="cat-search" id="stName" value="' + esc(me?.display_name ?? '') + '" ' +
          'placeholder="звание и фамилия (р-к Иванов)" autocomplete="off">' +
        '<button class="btn-wide" id="stNameSave" style="margin-top:10px">Запази името</button>' +
      '</div>' +
    '</div>' +

    '<div class="set-block">' +
      '<h2>Смяна на парола</h2>' +
      '<div class="set-foot">' +
        '<input class="cat-search" id="stPass1" type="password" ' +
          'placeholder="нова парола (поне 6 знака)" autocomplete="new-password">' +
        '<input class="cat-search" id="stPass2" type="password" style="margin-top:9px" ' +
          'placeholder="повтори новата парола" autocomplete="new-password">' +
        '<button class="btn-wide" id="stPassSave" style="margin-top:10px">Смени паролата</button>' +
      '</div>' +
    '</div>' +

    '<div class="set-block">' +
      '<h2>Потребителско име</h2>' +
      '<div class="set-foot">' +
        '<input class="cat-search" id="stUser" value="' + esc(me?.username ?? '') + '" ' +
          'placeholder="само латиница (ivanov)" autocapitalize="none" ' +
          'autocorrect="off" spellcheck="false" autocomplete="off">' +
        '<button class="btn-wide" id="stUserSave" style="margin-top:10px">' +
          'Смени потребителя</button>' +
        '<div class="warn-note">С това име влизаш. След смяна ще влизаш с новото.</div>' +
      '</div>' +
    '</div>' +

    '<button class="btn-wide" id="stBack">← Назад към поръчката</button>' +
    '<p class="set-note" style="margin-top:14px">Ако си забравил паролата си, ' +
    'администратор ти задава нова.</p>';

  bind(onNameChanged);
}

function bind(onNameChanged) {
  document.getElementById('stBack').onclick = () => {
    closeSettings();
    document.getElementById('userBody').classList.remove('hidden');
  };

  document.getElementById('stNameSave').onclick = async () => {
    const btn = document.getElementById('stNameSave');
    btn.disabled = true;
    try {
      await api.updateMyName(document.getElementById('stName').value);
      await loadProfile();
      document.getElementById('uWho').textContent = currentProfile()?.display_name ?? '';
      flashSaved();
      if (onNameChanged) await onNameChanged();
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('stUserSave').onclick = async () => {
    const val = document.getElementById('stUser').value.trim().toLowerCase();
    const me = currentProfile();
    if (val === me?.username) return;
    if (!await ask('Смяна на потребител',
      `Оттук нататък ще влизаш с „${val}“ вместо „${me?.username}“.`,
      'Смени', true)) return;

    const btn = document.getElementById('stUserSave');
    btn.disabled = true;
    try {
      await api.updateMyUsername(val);
      await loadProfile();
      draw(onNameChanged);
      flashSaved();
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('stPassSave').onclick = async () => {
    const p1 = document.getElementById('stPass1').value;
    const p2 = document.getElementById('stPass2').value;
    if (p1 !== p2) { setStatus('Двете пароли не съвпадат.', 'err'); return; }

    const btn = document.getElementById('stPassSave');
    btn.disabled = true;
    try {
      await api.changeMyPassword(p1);
      document.getElementById('stPass1').value = '';
      document.getElementById('stPass2').value = '';
      setStatus('✓ паролата е сменена', 'ok');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
}
