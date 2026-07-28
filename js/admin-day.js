import * as api from './api.js';
import { sb } from './supabase.js';
import { eur, esc, todayISO, addDaysISO, formatDayLabel } from './util.js';
import { ask, askText, setStatus } from './ui.js';

let date = todayISO();
let rows = [];          // [{id, who, completed_at, items}]
let ala = [];           // alaminut dishes
let menu = [];          // this day's menu dishes
let closed = false;
let openId = null;
let channel = null;
let softTimer = null;

const dishName = id =>
  ala.find(d => d.id === id)?.name ?? menu.find(d => d.id === id)?.name ?? '—';

const rowTotal = r => r.items.reduce((t, i) => t + i.qty * Number(i.unit_price), 0);
const grand = () => rows.reduce((t, r) => t + rowTotal(r), 0);
const itemsOf = (row, source) => row.items.filter(i => i.source === source);

export async function renderAdmin() {
  document.querySelectorAll('#adminTabs .tab').forEach(t => {
    t.onclick = async () => {
      document.querySelectorAll('#adminTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      unsubscribe();
      setStatus('');
      const which = t.getAttribute('data-atab');
      if (which === 'day') return renderDay();
      if (which === 'week') return (await import('./admin-week.js')).renderWeek();
      if (which === 'ala') return (await import('./admin-alaminut.js')).renderAlaminut();
      if (which === 'people') return (await import('./admin-people.js')).renderPeople();
    };
  });
  await renderDay();
}

export async function renderDay() {
  setStatus('зареждане…');
  try {
    const [r, a, m, st] = await Promise.all([
      api.getDay(date), api.listAlaminut(), api.listDayMenu(date), api.getDayStatus(date),
    ]);
    rows = r; ala = a; menu = m; closed = !!st?.closed;
    draw();
    subscribe();
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

/** Live refresh so two admins on the same day do not fight each other. */
function subscribe() {
  unsubscribe();
  channel = sb.channel('day-' + date)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, softReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, softReload)
    .subscribe();
}

function unsubscribe() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  clearTimeout(softTimer);
}

function softReload() {
  clearTimeout(softTimer);
  softTimer = setTimeout(async () => {
    try { rows = await api.getDay(date); draw(); } catch { /* transient */ }
  }, 400);
}

function summary(row) {
  return row.items
    .map(i => (i.qty > 1 ? `${dishName(i.dish_id)} ×${i.qty}` : dishName(i.dish_id)))
    .join(', ');
}

function gridHTML(row, dishes, source) {
  if (!dishes.length) {
    return '<div class="kempty">' +
      (source === 'menu' ? 'Няма меню за този ден.' : 'Аламинут списъкът е празен.') + '</div>';
  }
  return '<div class="dish-grid">' + dishes.map(d => {
    const q = itemsOf(row, source).find(i => i.dish_id === d.id)?.qty ?? 0;
    return '<button class="dish ' + (q ? 'picked' : '') +
      '" data-aadd="' + row.id + '|' + source + '|' + d.id + '">' +
      (q ? '<span class="badge">' + q + '</span><span class="minus" data-asub="' +
           row.id + '|' + source + '|' + d.id + '">−</span>' : '') +
      '<span class="dn">' + esc(d.name) + '</span>' +
      '<span class="dp">' + (d.price ? eur(d.price) : '—') + '</span></button>';
  }).join('') + '</div>';
}

function personHTML(row, idx) {
  const done = !!row.completed_at;
  const open = row.id === openId;
  return '<div class="person' + (done ? ' done' : '') + (open ? ' open' : '') + '">' +
    '<div class="p-head">' +
      '<span class="p-num">' + (idx + 1) + '</span>' +
      '<div class="p-main" data-open="' + row.id + '">' +
        '<div class="p-name">' + esc(row.who) +
          (row.guest_name ? ' <span class="pu">(гост)</span>' : '') + '</div>' +
        '<div class="p-summary' + (row.items.length ? '' : ' empty') + '">' +
          (row.items.length ? esc(summary(row)) : 'няма поръчка') + '</div>' +
      '</div>' +
      '<div class="p-right">' +
        '<span class="p-total">' + eur(rowTotal(row)) + '</span>' +
        '<button class="done-btn' + (done ? ' on' : '') + '" data-done="' + row.id + '">' +
          (done ? '✓' : 'Приключи') + '</button>' +
        '<button class="p-toggle" data-open="' + row.id + '">' + (open ? '▲' : '▼') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="picker">' +
      '<div class="ksub">Аламинут</div>' + gridHTML(row, ala, 'alaminut') +
      '<div class="ksub">Меню</div>' + gridHTML(row, menu, 'menu') +
      '<div class="p-actions">' +
        '<button class="clear" data-aclear="' + row.id + '">Изчисти поръчката</button>' +
        '<button class="del" data-adel="' + row.id + '">Изтрий човека</button>' +
      '</div>' +
    '</div></div>';
}

function kitchenHTML() {
  const block = (dishes, source, title) => {
    const lines = dishes.map(d => {
      const q = rows.reduce((s, r) =>
        s + (itemsOf(r, source).find(i => i.dish_id === d.id)?.qty ?? 0), 0);
      return q ? '<div class="kline"><span>' + esc(d.name) +
                 '</span><span class="kq">' + q + ' бр.</span></div>' : '';
    }).filter(Boolean);
    return '<div class="ksub">' + title + '</div>' +
      (lines.length ? lines.join('') : '<div class="kempty">Няма поръчки.</div>');
  };

  return '<div class="kitchen"><h2><span>Обобщение за кухнята</span></h2>' +
    '<div class="kitchen-body">' +
      block(ala, 'alaminut', 'Аламинут') +
      block(menu, 'menu', 'Меню') +
    '</div></div>';
}

function draw() {
  const lbl = formatDayLabel(date);
  const done = rows.filter(r => r.completed_at).length;
  // outstanding first — at lunchtime the useful view is who has NOT collected
  const ordered = [...rows].sort((a, b) =>
    (a.completed_at ? 1 : 0) - (b.completed_at ? 1 : 0));

  document.getElementById('adminBody').innerHTML =
    '<div class="datebar">' +
      '<button id="aPrev">‹</button>' +
      '<label class="dateshow"><span class="dow">' + lbl.dow + '</span>' +
        '<span class="dnum">' + lbl.dnum + '</span>' +
        '<input type="date" id="aDate" value="' + date + '"></label>' +
      '<button id="aNext">›</button>' +
      '<button class="today-pill" id="aToday">Днес</button>' +
    '</div>' +
    (closed ? '<div class="locked-note">🚫 САНИТАРЕН ДЕН</div>' : '') +
    '<div class="section-head"><span>Поръчки</span>' +
      '<span class="done-count">' + done + ' / ' + rows.length + ' приключени</span></div>' +
    (ordered.length
      ? ordered.map(personHTML).join('')
      : '<div class="empty-state"><div class="big">🍽️</div>' +
        'Още никой не е записан за този ден.</div>') +
    '<button class="add-person" id="aAddGuest">+ Добави гост</button>' +
    kitchenHTML() +
    '<div class="totalbar"><div><div class="lbl">Всичко за деня</div>' +
      '<div class="val">' + eur(grand()) + '</div></div>' +
      '<div class="ppl">' + rows.length + (rows.length === 1 ? ' човек' : ' души') + '</div></div>';

  bind();
}

function bind() {
  document.getElementById('aPrev').onclick = () => { date = addDaysISO(date, -1); renderDay(); };
  document.getElementById('aNext').onclick = () => { date = addDaysISO(date, 1); renderDay(); };
  document.getElementById('aToday').onclick = () => { date = todayISO(); renderDay(); };
  document.getElementById('aDate').onchange = e => { date = e.target.value; renderDay(); };

  document.querySelectorAll('[data-open]').forEach(el => {
    el.onclick = () => {
      const id = el.getAttribute('data-open');
      openId = openId === id ? null : id;
      draw();
    };
  });

  document.querySelectorAll('[data-done]').forEach(el => {
    el.onclick = async e => {
      e.stopPropagation();
      const id = el.getAttribute('data-done');
      const row = rows.find(r => r.id === id);
      try {
        await api.setCompleted(id, !row.completed_at);
        row.completed_at = row.completed_at ? null : new Date().toISOString();
        draw();
      } catch (err) { setStatus(err.message, 'err'); }
    };
  });

  document.querySelectorAll('[data-aadd]').forEach(el => {
    el.onclick = async e => {
      if (e.target.hasAttribute('data-asub')) return;
      const [rid, source, did] = el.getAttribute('data-aadd').split('|');
      await bump(rid, source, did, +1);
    };
  });
  document.querySelectorAll('[data-asub]').forEach(el => {
    el.onclick = async e => {
      e.stopPropagation();
      const [rid, source, did] = el.getAttribute('data-asub').split('|');
      await bump(rid, source, did, -1);
    };
  });

  document.querySelectorAll('[data-aclear]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-aclear');
      const row = rows.find(r => r.id === id);
      if (!row.items.length) return;
      if (!await ask('Изчистване на поръчка',
        `Всички ястия на „${row.who}“ ще бъдат премахнати. Човекът остава в списъка.`,
        'Изчисти', true)) return;
      try {
        await api.clearOrderItems(id);
        row.items = [];
        draw();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });

  document.querySelectorAll('[data-adel]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-adel');
      const row = rows.find(r => r.id === id);
      if (!await ask('Изтриване на човек',
        `„${row.who}“ и поръчката му ще изчезнат от този ден.`, 'Изтрий')) return;
      try {
        await api.deleteOrder(id);
        rows = rows.filter(r => r.id !== id);
        if (openId === id) openId = null;
        draw();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });

  document.getElementById('aAddGuest').onclick = async () => {
    const name = await askText('Нов гост', 'Звание и фамилия:', '', 'напр. лейт. Борисов');
    if (!name) return;
    try {
      await api.ensureOrder(date, null, name);
      await renderDay();
    } catch (e) { setStatus(e.message, 'err'); }
  };
}

async function bump(rowId, source, dishId, delta) {
  const row = rows.find(r => r.id === rowId);
  const dish = (source === 'alaminut' ? ala : menu).find(d => d.id === dishId);
  const item = row.items.find(i => i.dish_id === dishId && i.source === source);
  const qty = (item?.qty ?? 0) + delta;

  try {
    await api.setItem(rowId, dishId, source, qty, item?.unit_price ?? dish.price);
    if (qty <= 0) {
      row.items = row.items.filter(i => !(i.dish_id === dishId && i.source === source));
    } else if (item) {
      item.qty = qty;
    } else {
      row.items.push({ dish_id: dishId, source, qty, unit_price: dish.price });
    }
    draw();
  } catch (e) { setStatus(e.message, 'err'); }
}
