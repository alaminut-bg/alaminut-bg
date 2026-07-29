import * as api from './api.js';
import { eur, esc, todayISO, addDaysISO, isLockedClient, canCancelClient,
         isWorkingDay, formatDayLabel } from './util.js';
import { setStatus, flashSaved, ask, showError } from './ui.js';
import { currentProfile } from './auth.js';

// One section per source. alaminut is served today, menu is served tomorrow.
// Аламинут is a standing list, always available. Меню exists only for dates
// the admin has actually built one for.
const S = {
  alaminut: { date: null, dishes: [], qty: {}, orderId: null, locked: false,
              submitted: false, paid: false },
  menu:     { date: null, dishes: [], qty: {}, orderId: null, locked: false,
              submitted: false, paid: false },
};
let completedAt = null;
let marks = new Map();   // ISO date -> {kind, note}

/** Editable only while unlocked AND not already sent to the kitchen. */
const editable = source => !S[source].locked && !S[source].submitted;
let saveTimer = null;
const dirty = new Set();          // `${source}|${dishId}`

const priceOf = (source, id) =>
  Number(S[source].dishes.find(d => d.id === id)?.price) || 0;

const sectionTotal = source =>
  Object.entries(S[source].qty).reduce((t, [id, q]) => t + q * priceOf(source, id), 0);

const grandTotal = () => sectionTotal('alaminut') + sectionTotal('menu');

/** днес / утре / вдругиден, else the plain date. */
function relWord(iso, today) {
  if (iso === today) return 'днес';
  if (iso === addDaysISO(today, 1)) return 'утре';
  if (iso === addDaysISO(today, 2)) return 'вдругиден';
  return null;
}

/**
 * The first day still open for that source AND actually a working day, so the
 * screen is never a dead end. Before 10:30 that is аламинут-today and
 * меню-tomorrow; after 10:30, and over weekends and holidays, it rolls
 * forward until it lands on a day people can really order for.
 */
function nextOpenDate(source, today, nonWorking) {
  let d = source === 'alaminut' ? today : addDaysISO(today, 1);
  for (let i = 0; i < 21; i++) {
    if (isWorkingDay(d, nonWorking) && !isLockedClient(d, source)) return d;
    d = addDaysISO(d, 1);
  }
  return d;
}

/**
 * Why the natural day was passed over, so the screen explains itself instead
 * of silently showing a later date. Weekends are left unexplained — the day
 * name is right there in the header.
 */
function skipNotice(source, natural, chosen, marks) {
  if (natural === chosen) return '';
  const m = marks.get(natural);
  if (!m || m.kind !== api.DAY_CLOSED) return '';
  const l = formatDayLabel(natural);
  return '<div class="kwarn">⛔ ' + l.dow + ', ' + l.dnum + ' — кухнята не работи' +
    (m.note ? ' (' + esc(m.note) + ')' : '') + '.</div>';
}

export async function renderUserScreen() {
  const today = todayISO();

  const me = currentProfile();
  document.getElementById('uWho').textContent = me?.display_name ?? '';

  setStatus('зареждане…');
  try {
    marks = await api.listDayMarks(today, addDaysISO(today, 30));
    const closed = new Set(
      [...marks].filter(([, m]) => m.kind === api.DAY_CLOSED).map(([d]) => d));

    S.alaminut.natural = today;
    S.menu.natural = addDaysISO(today, 1);
    S.alaminut.date = nextOpenDate('alaminut', today, closed);
    S.menu.date = nextOpenDate('menu', today, closed);
    S.alaminut.locked = isLockedClient(S.alaminut.date, 'alaminut');
    S.menu.locked = isLockedClient(S.menu.date, 'menu');

    const [ala, menuDishes, alaOrder, menuOrder] = await Promise.all([
      api.listAlaminut(),
      api.listDayMenu(S.menu.date),
      api.getMyOrder(S.alaminut.date),
      api.getMyOrder(S.menu.date),
    ]);

    S.alaminut.dishes = ala;
    S.menu.dishes = menuDishes;

    S.alaminut.orderId = alaOrder?.id ?? null;
    S.menu.orderId = menuOrder?.id ?? null;
    S.alaminut.submitted = !!alaOrder?.submitted_at;
    S.menu.submitted = !!menuOrder?.submitted_at;
    S.alaminut.paid = !!alaOrder?.paid_at;
    S.menu.paid = !!menuOrder?.paid_at;
    completedAt = alaOrder?.completed_at ?? null;

    S.alaminut.qty = {};
    S.menu.qty = {};
    for (const it of alaOrder?.items ?? []) {
      if (it.source === 'alaminut') S.alaminut.qty[it.dish_id] = it.qty;
    }
    for (const it of menuOrder?.items ?? []) {
      if (it.source === 'menu') S.menu.qty[it.dish_id] = it.qty;
    }

    draw(today);
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
    showError('userBody', e.message);
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
  const ro = !editable(source);
  return st.dishes.map(d => {
    const q = Number(st.qty[d.id]) || 0;
    return '<button class="dish ' + (q ? 'picked' : '') + '"' +
      (ro ? ' disabled' : '') +
      ' data-add="' + source + '|' + d.id + '">' +
      (q ? '<span class="badge">' + q + '</span>' +
           (ro ? '' : '<span class="minus" data-sub="' + source + '|' + d.id + '">−</span>')
         : '') +
      '<span class="dn">' + esc(d.name) + '</span>' +
      '<span class="dp">' + (d.price ? eur(d.price) : '—') + '</span></button>';
  }).join('');
}

/**
 * A plain reminder, not a count — how many dishes fit in one box is the
 * person's call, so there is no right number to check against.
 */
function boxHint(source) {
  if (source !== 'menu') return '';
  const st = S.menu;
  const orderedFood = st.dishes.some(d => !d.pinned && (Number(st.qty[d.id]) || 0) > 0);
  if (!orderedFood) return '';
  return '<div class="warn-note">📦 Не забравяй кутиите.</div>';
}

/** Прати / Модифицирай, plus the state line above it. */
function actionsHTML(source) {
  const st = S[source];
  const any = Object.keys(st.qty).length > 0;

  if (st.locked) {
    return '<div class="locked-note">🔒 Заключено — поръчките се приемат до 10:30.' +
      (st.submitted ? '<br>Поръчката ти е пратена.' : '') + '</div>';
  }

  // Cancelling closes at 10:25, five minutes before ordering does.
  const canCancel = any && st.orderId && canCancelClient(st.date, source);
  const cancelBtn = canCancel
    ? '<button class="btn-wide danger" data-cancel="' + source + '">' +
      '✕ Откажи поръчката</button>'
    : '';
  const cancelNote = any && !canCancel
    ? '<br>Отказ вече не е възможен — приема се до 10:25.'
    : '';

  if (st.submitted) {
    return boxHint(source) +
      '<div class="sent-note">✓ Пратена' +
        (st.paid ? ' · <b>платена</b>' : '') + '</div>' +
      '<div class="p-actions"><button class="btn-wide" data-reopen="' + source + '">' +
        '✎ Модифицирай</button>' + cancelBtn + '</div>' +
      '<div class="warn-note">' +
        (st.paid ? '' : '⚠ Неплатени поръчки не се обработват.') + cancelNote + '</div>';
  }

  return boxHint(source) +
    '<div class="p-actions"><button class="btn-wide send" data-send="' + source + '"' +
      (any ? '' : ' disabled') + '>📨 Прати поръчката</button>' + cancelBtn + '</div>' +
    '<div class="warn-note">' +
      (any ? 'Поръчката още не е пратена.' : 'Избери ястия и натисни „Прати поръчката“.') +
      '<br>⚠ Неплатени поръчки не се обработват.' + cancelNote + '</div>';
}

function sectionHTML(source, title, when, rel) {
  const st = S[source];
  const picked = Object.keys(st.qty).length;
  let inner;

  if (st.dishes.length === 0) {
    const marked = marks.get(st.date);
    inner = '<div class="locked-note">' +
      (source !== 'menu'
        ? 'Аламинут списъкът е празен.'
        : marked?.kind === 'no_menu'
          ? '🚫 Няма меню за този ден.' +
            (marked.note ? '<br>' + esc(marked.note) : '')
          : 'Менюто за ' + (rel || when) + ' още не е въведено.') + '</div>';
  } else {
    inner = '<div class="dish-grid">' + gridHTML(source) + '</div>' +
      actionsHTML(source);
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

function draw(today = todayISO()) {
  const head = (source, word) => {
    const iso = S[source].date;
    const rel = relWord(iso, today);
    const l = formatDayLabel(iso);
    // The date is what people get wrong, so lead with it in full and put the
    // днес/утре hint beside it rather than instead of it.
    return {
      title: word,
      when: `${l.dow}, ${l.dnum}` + (rel ? ` · ${rel}` : ''),
      rel,
    };
  };

  const a = head('alaminut', 'Аламинут');
  const m = head('menu', 'Меню');
  const aSkip = skipNotice('alaminut', S.alaminut.natural, S.alaminut.date, marks);
  const mSkip = skipNotice('menu', S.menu.natural, S.menu.date, marks);

  document.getElementById('userBody').innerHTML =
    (completedAt
      ? '<div class="section-head"><span>Поръчката е взета</span>' +
        '<span class="done-badge">✓ Приключена</span></div>'
      : '') +
    aSkip + sectionHTML('alaminut', a.title, a.when, a.rel) +
    mSkip + sectionHTML('menu', m.title, m.when, m.rel) +
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
      if (!editable(source)) return;
      S[source].qty[id] = (Number(S[source].qty[id]) || 0) + 1;
      touch(source, id);
    };
  });

  document.querySelectorAll('#userBody [data-sub]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const [source, id] = el.getAttribute('data-sub').split('|');
      if (!editable(source)) return;
      const next = (Number(S[source].qty[id]) || 0) - 1;
      if (next > 0) S[source].qty[id] = next; else delete S[source].qty[id];
      touch(source, id);
    };
  });

  document.querySelectorAll('#userBody [data-send]').forEach(el => {
    el.onclick = () => submit(el.getAttribute('data-send'), true);
  });
  document.querySelectorAll('#userBody [data-reopen]').forEach(el => {
    el.onclick = () => submit(el.getAttribute('data-reopen'), false);
  });
  document.querySelectorAll('#userBody [data-cancel]').forEach(el => {
    el.onclick = () => cancel(el.getAttribute('data-cancel'));
  });
}

async function cancel(source) {
  const st = S[source];
  if (!st.orderId) return;
  if (!await ask('Отказ на поръчката',
    'Поръчката ти за този ден ще бъде премахната напълно.', 'Откажи я')) return;

  clearTimeout(saveTimer);
  dirty.clear();
  setStatus('отказва се…');
  try {
    await api.cancelOrder(st.orderId, source);
    setStatus('Поръчката е отказана.', 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  }
  await renderUserScreen();
}

async function submit(source, sent) {
  const st = S[source];
  clearTimeout(saveTimer);
  if (dirty.size) await flush();          // never send a half-saved order

  if (!st.orderId) {
    if (!sent) return;
    setStatus('Нямаш какво да пратиш.', 'err');
    return;
  }

  setStatus(sent ? 'изпраща се…' : 'отваря се…');
  try {
    await api.setSubmitted(st.orderId, sent);
    st.submitted = sent;
    draw();
    setStatus(sent ? '✓ пратена' : 'Можеш да променяш до 10:30.', sent ? 'ok' : '');
  } catch (e) {
    setStatus(e.message, 'err');
    await renderUserScreen();
  }
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
      if (/10:30|не се предлага/.test(e.message)) {
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
