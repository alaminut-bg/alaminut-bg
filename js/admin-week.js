import * as api from './api.js';
import { eur, esc, todayISO, addDaysISO, formatDayLabel } from './util.js';
import { ask, flashSaved, setStatus , showError } from './ui.js';

let date = todayISO();
let dishes = [];        // this day's own menu, in order
let pinned = [];        // always-offered extras, read-only here
let catalog = [];
let search = '';
let searchTimer = null;

export async function renderWeek() {
  setStatus('зареждане…');
  try {
    const [menu, cat] = await Promise.all([
      api.listDayMenu(date), api.searchCatalog(search),
    ]);
    // Pinned extras (Кутия) ride along with every day and are managed in the
    // Аламинут tab. Keep them out of the editable list, or saving this day
    // would write them into daily_menu permanently.
    dishes = menu.filter(d => !d.pinned);
    pinned = menu.filter(d => d.pinned);
    catalog = cat;
    draw();
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
    showError('adminBody', e.message);
  }
}

function draw(keepFocus) {
  const lbl = formatDayLabel(date);
  const chosen = new Set(dishes.map(d => d.id));

  const rowsHTML = dishes.map((d, i) =>
    '<div class="set-row" data-wrow="' + d.id + '">' +
      '<span class="p-num">' + (i + 1) + '</span>' +
      '<input type="text" value="' + esc(d.name) + '" data-wname="' + d.id + '">' +
      '<div class="price-wrap">' +
        '<input type="number" step="0.01" min="0" inputmode="decimal" ' +
          'value="' + Number(d.price).toFixed(2) + '" data-wprice="' + d.id + '">' +
        '<span class="cur">€</span></div>' +
      '<button class="kill" data-wup="' + d.id + '">↑</button>' +
      '<button class="kill" data-wdown="' + d.id + '">↓</button>' +
      '<button class="kill" data-wdel="' + d.id + '">✕</button>' +
    '</div>').join('');

  const catHTML = catalog.map(c =>
    '<div class="cat-item' + (chosen.has(c.id) ? ' chosen' : '') + '" data-wadd="' + c.id + '">' +
      '<span>' + esc(c.name) + (chosen.has(c.id) ? ' ✓' : '') + '</span>' +
      '<span class="cp">' + eur(c.price) + '</span></div>').join('');

  const exact = catalog.some(c => c.name.toLowerCase() === search.trim().toLowerCase());

  document.getElementById('adminBody').innerHTML =
    '<div class="datebar">' +
      '<button id="wPrev">‹</button>' +
      '<label class="dateshow"><span class="dow">' + lbl.dow + '</span>' +
        '<span class="dnum">' + lbl.dnum + '</span>' +
        '<input type="date" id="wDate" value="' + date + '"></label>' +
      '<button id="wNext">›</button>' +
      '<button class="today-pill" id="wToday">Днес</button>' +
    '</div>' +

    '<div class="set-block">' +
      '<h2>Меню за деня</h2>' +
      (dishes.length
        ? rowsHTML
        : '<div class="kempty" style="padding:16px">Празен ден — кухнята не работи. ' +
          'Добави ястие отдолу, за да го отвориш.</div>') +
      (pinned.length
        ? '<div class="set-foot" style="padding-top:0">' +
          '<div class="reorder-hint" style="padding-top:12px">📦 Винаги се предлага: ' +
          pinned.map(d => esc(d.name) + ' · ' + eur(d.price)).join(', ') +
          '<br>Управлява се в таб „Аламинут“.</div></div>'
        : '') +
    '</div>' +

    '<div class="set-block">' +
      '<h2>Добави от каталога</h2>' +
      '<div class="set-foot">' +
        '<input class="cat-search" id="wSearch" placeholder="търси или напиши ново ястие…" ' +
          'value="' + esc(search) + '" autocomplete="off">' +
        '<div class="cat-list">' + (catHTML || '<div class="kempty" style="padding:12px">Няма съвпадение.</div>') + '</div>' +
        (search.trim() && !exact
          ? '<button class="btn-wide" id="wNew" style="margin-top:10px">+ Създай „' +
            esc(search.trim()) + '“</button>'
          : '') +
      '</div>' +
    '</div>' +

    '<div class="set-block">' +
      '<h2>Копирай от друг ден</h2>' +
      '<div class="set-foot">' +
        '<input type="date" id="wCopyFrom" class="cat-search">' +
        '<button class="btn-wide" id="wCopy" style="margin-top:10px">⧉ Копирай тук</button>' +
      '</div>' +
    '</div>' +

    '<p class="set-note">Промяната на цена тук се записва в каталога и важи за всички дни ' +
    'занапред. Вече направени поръчки пазят цената, с която са записани.</p>';

  bind();

  if (keepFocus) {
    const el = document.getElementById('wSearch');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}

function bind() {
  document.getElementById('wPrev').onclick = () => { date = addDaysISO(date, -1); renderWeek(); };
  document.getElementById('wNext').onclick = () => { date = addDaysISO(date, 1); renderWeek(); };
  document.getElementById('wToday').onclick = () => { date = todayISO(); renderWeek(); };
  document.getElementById('wDate').onchange = e => { date = e.target.value; renderWeek(); };

  const s = document.getElementById('wSearch');
  if (s) s.oninput = () => {
    search = s.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try { catalog = await api.searchCatalog(search); draw(true); }
      catch (e) { setStatus(e.message, 'err'); }
    }, 250);
  };

  document.querySelectorAll('[data-wadd]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-wadd');
      if (dishes.some(d => d.id === id)) return;
      const c = catalog.find(x => x.id === id);
      dishes.push({ id: c.id, name: c.name, price: c.price });
      await saveOrder();
    };
  });

  const nb = document.getElementById('wNew');
  if (nb) nb.onclick = async () => {
    const name = search.trim();
    if (!name) return;
    try {
      const created = await api.upsertDish({ name, price: 0, in_alaminut: false });
      dishes.push({ id: created.id, name: created.name, price: created.price });
      search = '';
      await saveOrder();
    } catch (e) { setStatus(e.message, 'err'); }
  };

  document.querySelectorAll('[data-wdel]').forEach(el => {
    el.onclick = async () => {
      dishes = dishes.filter(d => d.id !== el.getAttribute('data-wdel'));
      await saveOrder();
    };
  });
  document.querySelectorAll('[data-wup]').forEach(el => {
    el.onclick = async () => { move(el.getAttribute('data-wup'), -1); await saveOrder(); };
  });
  document.querySelectorAll('[data-wdown]').forEach(el => {
    el.onclick = async () => { move(el.getAttribute('data-wdown'), +1); await saveOrder(); };
  });

  // Name and price edits write back to the CATALOG dish, not just this day.
  document.querySelectorAll('[data-wname]').forEach(el => {
    let t = null;
    el.oninput = () => {
      const d = dishes.find(x => x.id === el.getAttribute('data-wname'));
      d.name = el.value;
      clearTimeout(t); t = setTimeout(() => saveDish(d), 700);
    };
  });
  document.querySelectorAll('[data-wprice]').forEach(el => {
    let t = null;
    el.oninput = () => {
      const d = dishes.find(x => x.id === el.getAttribute('data-wprice'));
      d.price = Number(el.value) || 0;
      clearTimeout(t); t = setTimeout(() => saveDish(d), 700);
    };
  });

  document.getElementById('wCopy').onclick = async () => {
    const from = document.getElementById('wCopyFrom').value;
    if (!from) { setStatus('Избери ден, от който да копираш.', 'err'); return; }
    if (from === date) { setStatus('Това е същият ден.', 'err'); return; }
    if (!await ask('Копиране на меню',
      'Менюто за този ден ще бъде заменено с това от ' + from + '.', 'Копирай', true)) return;
    try {
      const src = await api.listDayMenu(from);
      await api.setDayMenu(date, src.map(d => d.id));
      await renderWeek();
      flashSaved();
    } catch (e) { setStatus(e.message, 'err'); }
  };
}

function move(id, delta) {
  const i = dishes.findIndex(d => d.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= dishes.length) return;
  [dishes[i], dishes[j]] = [dishes[j], dishes[i]];
}

async function saveOrder() {
  try {
    await api.setDayMenu(date, dishes.map(d => d.id));
    catalog = await api.searchCatalog(search);
    draw();
    flashSaved();
  } catch (e) {
    setStatus(e.message, 'err');
    showError('adminBody', e.message);
  }
}

async function saveDish(d) {
  try {
    await api.upsertDish({ id: d.id, name: d.name, price: d.price });
    flashSaved();
  } catch (e) {
    setStatus(e.message, 'err');
    showError('adminBody', e.message);
  }
}
