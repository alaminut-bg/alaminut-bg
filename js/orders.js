import * as api from './api.js';
import { eur, esc, todayISO, addDaysISO, isLockedClient, formatDayLabel } from './util.js';
import { setStatus, flashSaved } from './ui.js';
import { currentProfile } from './auth.js';

// One section per source. alaminut is served today, menu is served tomorrow.
// `works` = the admin entered a menu for that date; an empty day means the
// kitchen does not work then (weekends, the odd weekday).
const S = {
  alaminut: { date: null, dishes: [], qty: {}, orderId: null, locked: false, works: false },
  menu:     { date: null, dishes: [], qty: {}, orderId: null, locked: false, works: false },
};
let completedAt = null;
let saveTimer = null;
const dirty = new Set();          // `${source}|${dishId}`

const priceOf = (source, id) =>
  Number(S[source].dishes.find(d => d.id === id)?.price) || 0;

const sectionTotal = source =>
  Object.entries(S[source].qty).reduce((t, [id, q]) => t + q * priceOf(source, id), 0);

const grandTotal = () => sectionTotal('alaminut') + sectionTotal('menu');

export async function renderUserScreen() {
  const today = todayISO();
  const tomorrow = addDaysISO(today, 1);

  S.alaminut.date = today;
  S.menu.date = tomorrow;
  S.alaminut.locked = isLockedClient(today, 'alaminut');
  S.menu.locked = isLockedClient(tomorrow, 'menu');

  const me = currentProfile();
  document.getElementById('uWho').textContent = me?.display_name ?? '';

  setStatus('зареждане…');
  try {
    const [ala, todayMenu, tomorrowMenu, todayOrder, tomorrowOrder] =
      await Promise.all([
        api.listAlaminut(),
        api.listDayMenu(today),        // only to learn whether today is a working day
        api.listDayMenu(tomorrow),
        api.getMyOrder(today),
        api.getMyOrder(tomorrow),
      ]);

    S.alaminut.dishes = ala;
    S.alaminut.works = todayMenu.length > 0;
    S.menu.dishes = tomorrowMenu;
    S.menu.works = tomorrowMenu.length > 0;

    S.alaminut.orderId = todayOrder?.id ?? null;
    S.menu.orderId = tomorrowOrder?.id ?? null;
    completedAt = todayOrder?.completed_at ?? null;

    S.alaminut.qty = {};
    S.menu.qty = {};
    for (const it of todayOrder?.items ?? []) {
      if (it.source === 'alaminut') S.alaminut.qty[it.dish_id] = it.qty;
    }
    for (const it of tomorrowOrder?.items ?? []) {
      if (it.source === 'menu') S.menu.qty[it.dish_id] = it.qty;
    }

    draw();
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

function summaryText(source) {
  const st = S[source];
  return st.dishes
    .filter(d => st.qty[d.id])
    .map(d => (st.qty[d.id] > 1 ? `${d.name} ×${st.qty[d.id]}` : d.name))
    .join(', ');
}

function gridHTML(source) {
  const st = S[source];
  return st.dishes.map(d => {
    const q = Number(st.qty[d.id]) || 0;
    return '<button class="dish ' + (q ? 'picked' : '') + '"' +
      (st.locked ? ' disabled' : '') +
      ' data-add="' + source + '|' + d.id + '">' +
      (q ? '<span class="badge">' + q + '</span>' +
           (st.locked ? '' : '<span class="minus" data-sub="' + source + '|' + d.id + '">−</span>')
         : '') +
      '<span class="dn">' + esc(d.name) + '</span>' +
      '<span class="dp">' + (d.price ? eur(d.price) : '—') + '</span></button>';
  }).join('');
}

function sectionHTML(source, title, when, lockHint) {
  const st = S[source];
  const picked = Object.keys(st.qty).length;
  let inner;

  if (!st.works) {
    inner = '<div class="locked-note">Кухнята не работи на тази дата.</div>';
  } else if (st.dishes.length === 0) {
    inner = '<div class="locked-note">Аламинут списъкът е празен.</div>';
  } else {
    inner = (st.locked ? '<div class="locked-note">🔒 ' + lockHint + '</div>' : '') +
      '<div class="dish-grid">' + gridHTML(source) + '</div>';
  }

  return '<div class="section-head"><span>' + title + '</span>' +
      '<span class="when">' + when + '</span></div>' +
    '<div class="person open">' +
      '<div class="p-head">' +
        '<div class="p-main"><div class="p-summary' + (picked ? '' : ' empty') + '">' +
          (picked ? esc(summaryText(source)) : 'няма поръчка') +
        '</div></div>' +
        '<div class="p-right"><span class="p-total">' + eur(sectionTotal(source)) + '</span></div>' +
      '</div>' +
      '<div class="picker">' + inner + '</div>' +
    '</div>';
}

function draw() {
  const t = formatDayLabel(S.alaminut.date);
  const n = formatDayLabel(S.menu.date);

  document.getElementById('userBody').innerHTML =
    (completedAt
      ? '<div class="section-head"><span>Поръчката е взета</span>' +
        '<span class="done-badge">✓ Приключена</span></div>'
      : '') +
    sectionHTML('alaminut', 'Днес — аламинут', `${t.dow}, ${t.dnum}`,
      'Заключено — аламинут се поръчва до 10:30.') +
    sectionHTML('menu', 'Утре — меню', `${n.dow}, ${n.dnum}`,
      'Заключено — менюто за утре се поръчва до 10:30 днес.') +
    '<div class="totalbar">' +
      '<div><div class="lbl">Общо</div>' +
      '<div class="val">' + eur(grandTotal()) + '</div></div>' +
      '<div class="ppl">' + (completedAt ? '✓ приключена' : 'до 10:30') + '</div>' +
    '</div>';

  bind();
}

function bind() {
  document.querySelectorAll('#userBody [data-add]').forEach(el => {
    el.onclick = e => {
      if (e.target.hasAttribute('data-sub')) return;
      const [source, id] = el.getAttribute('data-add').split('|');
      if (S[source].locked || !S[source].works) return;
      S[source].qty[id] = (Number(S[source].qty[id]) || 0) + 1;
      touch(source, id);
    };
  });

  document.querySelectorAll('#userBody [data-sub]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const [source, id] = el.getAttribute('data-sub').split('|');
      if (S[source].locked || !S[source].works) return;
      const next = (Number(S[source].qty[id]) || 0) - 1;
      if (next > 0) S[source].qty[id] = next; else delete S[source].qty[id];
      touch(source, id);
    };
  });
}

function touch(source, dishId) {
  dirty.add(`${source}|${dishId}`);
  draw();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 700);
}

async function flush() {
  if (!dirty.size) return;
  const batch = Array.from(dirty);
  dirty.clear();
  setStatus('запазва се…');
  const failed = [];

  for (const key of batch) {
    const [source, dishId] = key.split('|');
    const st = S[source];
    try {
      if (!st.orderId) {
        st.orderId = await api.ensureOrder(st.date, currentProfile().id, null);
      }
      await api.setItem(st.orderId, dishId, source,
        Number(st.qty[dishId]) || 0, priceOf(source, dishId));
    } catch (e) {
      // A lock or availability rejection means our view disagrees with the
      // server — our clock may be wrong. Reload rather than retry forever.
      if (/10:30|не работи|не се предлага/.test(e.message)) {
        dirty.clear();
        setStatus(e.message, 'err');
        await renderUserScreen();
        return;
      }
      failed.push(key);
    }
  }

  if (failed.length) {
    failed.forEach(k => dirty.add(k));
    setStatus('⚠ няма връзка — ще опитам пак', 'err');
    setTimeout(flush, 4000);
  } else {
    flashSaved();
  }
}
