import * as api from './api.js';
import { eur, esc } from './util.js';
import { ask, flashSaved, setStatus } from './ui.js';

let list = [];

export async function renderAlaminut() {
  setStatus('зареждане…');
  try {
    list = await api.listAlaminut();
    draw();
    setStatus('');
  } catch (e) { setStatus(e.message, 'err'); }
}

function draw() {
  const rows = list.map(it =>
    '<div class="set-row" data-mrow="' + it.id + '">' +
      '<span class="grip" data-grip="' + it.id + '">⠿</span>' +
      '<input type="text" value="' + esc(it.name) + '" data-sname="' + it.id + '" ' +
        'placeholder="име на ястието">' +
      '<div class="price-wrap">' +
        '<input type="number" step="0.01" min="0" inputmode="decimal" ' +
          'value="' + Number(it.price).toFixed(2) + '" data-sprice="' + it.id + '">' +
        '<span class="cur">€</span></div>' +
      '<button class="done-btn' + (it.pinned_to_menu ? ' on' : '') +
        '" data-spin="' + it.id + '" title="Да се предлага и с менюто">📦</button>' +
      '<button class="kill" data-skill="' + it.id + '">✕</button>' +
    '</div>').join('');

  document.getElementById('adminBody').innerHTML =
    '<div class="set-block">' +
      '<h2>Аламинут — постоянен списък</h2>' +
      '<div class="reorder-hint">Задръж ⠿ и влачи, за да смениш реда.</div>' +
      '<div id="menuList">' + (rows || '<div class="kempty" style="padding:16px">Празен списък.</div>') + '</div>' +
      '<div class="set-foot"><button class="btn-wide" id="addDishBtn">' +
        '+ Добави ново ястие</button></div>' +
    '</div>' +
    '<p class="set-note">Този списък важи за всеки ден. Премахнатите ястия остават ' +
    'в старите поръчки, само спират да се предлагат.<br><br>' +
    '📦 значи, че ястието се предлага и с менюто всеки ден, без да го добавяш ' +
    'по дни. Цената е една и съща на двете места — смениш ли я тук, сменя се и в менюто.</p>';

  bind();
}

function bind() {
  document.querySelectorAll('[data-sname]').forEach(el => {
    let t = null;
    el.oninput = () => {
      const it = list.find(i => i.id === el.getAttribute('data-sname'));
      it.name = el.value;
      clearTimeout(t); t = setTimeout(() => save(it), 700);
    };
  });
  document.querySelectorAll('[data-sprice]').forEach(el => {
    let t = null;
    el.oninput = () => {
      const it = list.find(i => i.id === el.getAttribute('data-sprice'));
      it.price = Number(el.value) || 0;
      clearTimeout(t); t = setTimeout(() => save(it), 700);
    };
  });

  // 📦 = also offered alongside the меню on every day, without being placed
  // on each day by hand. One dish row, so the price stays in sync.
  document.querySelectorAll('[data-spin]').forEach(el => {
    el.onclick = async () => {
      const it = list.find(i => i.id === el.getAttribute('data-spin'));
      const next = !it.pinned_to_menu;
      try {
        await api.upsertDish({ id: it.id, pinned_to_menu: next });
        it.pinned_to_menu = next;
        draw(); flashSaved();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });

  document.querySelectorAll('[data-skill]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-skill');
      const it = list.find(i => i.id === id);
      if (!await ask('Премахване от аламинут',
        `„${it.name || 'Това ястие'}“ няма да се предлага повече. Старите поръчки остават.`,
        'Премахни')) return;
      try {
        await api.archiveDish(id);
        list = list.filter(i => i.id !== id);
        draw(); flashSaved();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });

  document.getElementById('addDishBtn').onclick = async () => {
    try {
      const created = await api.upsertDish({
        name: 'Ново ястие', price: 0, in_alaminut: true, alaminut_pos: list.length + 1,
      });
      list.push(created);
      draw();
      const inputs = document.querySelectorAll('[data-sname]');
      const last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
    } catch (e) { setStatus(e.message, 'err'); }
  };

  bindReorder();
}

async function save(it) {
  try {
    await api.upsertDish({ id: it.id, name: it.name, price: it.price });
    flashSaved();
  } catch (e) { setStatus(e.message, 'err'); }
}

/* ── drag to reorder ─────────────────────────────────────────────────── */
let dragState = null;

function bindReorder() {
  document.querySelectorAll('[data-grip]').forEach(grip => {
    grip.onpointerdown = e => {
      e.preventDefault();
      const id = grip.getAttribute('data-grip');
      const rowEl = document.querySelector('[data-mrow="' + id + '"]');
      if (!rowEl) return;

      grip.setPointerCapture(e.pointerId);
      const rect = rowEl.getBoundingClientRect();
      dragState = {
        id, el: rowEl, grip, pointerId: e.pointerId,
        offsetY: e.clientY - rect.top, moved: false,
        marker: document.createElement('div'),
      };
      dragState.marker.className = 'drop-line';
      rowEl.classList.add('dragging');
      rowEl.style.width = rect.width + 'px';
      if (navigator.vibrate) navigator.vibrate(12);

      grip.onpointermove = onDragMove;
      grip.onpointerup = onDragEnd;
      grip.onpointercancel = onDragEnd;
    };
  });
}

function onDragMove(e) {
  if (!dragState) return;
  e.preventDefault();
  const d = dragState;

  if (!d.moved) {
    d.moved = true;
    const parent = d.el.parentElement;
    const index = Array.from(parent.children).indexOf(d.el);
    d.el.style.position = 'fixed';
    d.el.style.left = d.el.getBoundingClientRect().left + 'px';
    d.el.style.zIndex = '60';
    d.el.style.pointerEvents = 'none';
    parent.insertBefore(d.marker, parent.children[index]);
  }

  d.el.style.top = (e.clientY - d.offsetY) + 'px';

  const listEl = document.getElementById('menuList');
  const siblings = Array.from(listEl.querySelectorAll('[data-mrow]')).filter(x => x !== d.el);
  let placed = false;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      listEl.insertBefore(d.marker, sib); placed = true; break;
    }
  }
  if (!placed) listEl.appendChild(d.marker);
}

async function onDragEnd() {
  if (!dragState) return;
  const d = dragState;
  dragState = null;

  d.grip.onpointermove = null; d.grip.onpointerup = null; d.grip.onpointercancel = null;
  try { d.grip.releasePointerCapture(d.pointerId); } catch { /* pointer already gone */ }

  d.el.classList.remove('dragging');
  for (const p of ['position', 'top', 'left', 'width', 'zIndex', 'pointerEvents']) {
    d.el.style[p] = '';
  }

  if (!d.moved) { d.marker.remove(); return; }

  const listEl = document.getElementById('menuList');
  let target = Array.from(listEl.children).indexOf(d.marker);
  d.marker.remove();

  const from = list.findIndex(i => i.id === d.id);
  if (from < 0) return;
  const moved = list.splice(from, 1)[0];
  if (from < target) target--;
  target = Math.max(0, Math.min(target, list.length));
  list.splice(target, 0, moved);

  list.forEach((it, i) => { it.alaminut_pos = i + 1; });
  draw();
  if (navigator.vibrate) navigator.vibrate(8);

  try {
    await api.saveAlaminutOrder(list.map(i => ({ id: i.id, alaminut_pos: i.alaminut_pos })));
    flashSaved();
  } catch (e) { setStatus(e.message, 'err'); }
}
