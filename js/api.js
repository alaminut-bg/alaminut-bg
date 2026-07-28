import { sb } from './supabase.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

/** Turns a Postgres error into a message worth showing a user. */
function boom(error, fallback) {
  if (!error) return;
  const m = String(error.message || '');
  if (m.includes('10:30')) throw new Error('Поръчките са заключени след 10:30.');
  if (m.includes('санитарен')) throw new Error('Не може да се поръчва за санитарен ден.');
  if (m.includes('не е налично') || m.includes('не е в дневното'))
    throw new Error('Това ястие не се предлага за този ден.');
  if (m.includes('администратор')) throw new Error('Само администратор може да направи това.');
  if (m.includes('количеството')) throw new Error('Може да се променя само количеството.');
  if (error.code === '42501' || m.includes('row-level security')) {
    throw new Error('Нямаш право за това действие.');
  }
  throw new Error(fallback);
}

const ITEM_COLS = 'dish_id, source, qty, unit_price';

// ─────────────────────────────── catalog ───────────────────────────────

export async function listAlaminut() {
  const { data, error } = await sb.from('dishes')
    .select('id, name, price, alaminut_pos')
    .eq('in_alaminut', true).eq('archived', false)
    .order('alaminut_pos');
  boom(error, 'Менюто не се зареди.');
  return data ?? [];
}

export async function listDayMenu(date) {
  const { data, error } = await sb.from('daily_menu')
    .select('position, dishes(id, name, price, archived)')
    .eq('serve_date', date).order('position');
  boom(error, 'Менюто за деня не се зареди.');
  return (data ?? [])
    .filter(r => r.dishes && !r.dishes.archived)
    .map(r => ({ id: r.dishes.id, name: r.dishes.name,
                 price: r.dishes.price, position: r.position }));
}

export async function getDayStatus(date) {
  const { data, error } = await sb.from('day_status')
    .select('serve_date, closed, note').eq('serve_date', date).maybeSingle();
  boom(error, 'Състоянието на деня не се зареди.');
  return data;
}

export async function searchCatalog(q) {
  let query = sb.from('dishes')
    .select('id, name, price, in_alaminut')
    .eq('archived', false).order('name').limit(50);
  if (q && q.trim()) query = query.ilike('name', `%${q.trim()}%`);
  const { data, error } = await query;
  boom(error, 'Каталогът не се зареди.');
  return data ?? [];
}

// ──────────────────────────────── orders ───────────────────────────────

export async function getMyOrder(date) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;

  const { data, error } = await sb.from('orders')
    .select(`id, completed_at, order_items(${ITEM_COLS})`)
    .eq('serve_date', date).eq('profile_id', session.user.id).maybeSingle();
  boom(error, 'Поръчката не се зареди.');
  if (!data) return null;
  return { id: data.id, completed_at: data.completed_at, items: data.order_items ?? [] };
}

export async function getDay(date) {
  const { data, error } = await sb.from('orders')
    .select(`id, profile_id, guest_name, completed_at, created_at,
             profiles(display_name), order_items(${ITEM_COLS})`)
    .eq('serve_date', date).order('created_at');
  boom(error, 'Денят не се зареди.');
  return (data ?? []).map(o => ({
    id: o.id,
    profile_id: o.profile_id,
    guest_name: o.guest_name,
    who: o.profiles?.display_name ?? o.guest_name ?? '—',
    completed_at: o.completed_at,
    items: o.order_items ?? [],
  }));
}

/** Returns the existing order id for that person and day, creating one if needed. */
export async function ensureOrder(date, profileId, guestName) {
  if (profileId) {
    const { data: found, error: findErr } = await sb.from('orders')
      .select('id').eq('serve_date', date).eq('profile_id', profileId).maybeSingle();
    boom(findErr, 'Поръчката не се зареди.');
    if (found) return found.id;
  }
  const { data, error } = await sb.from('orders')
    .insert({ serve_date: date,
              profile_id: profileId ?? null,
              guest_name: profileId ? null : guestName })
    .select('id').single();
  boom(error, 'Поръчката не се създаде.');
  return data.id;
}

/**
 * qty <= 0 deletes the line. The database overwrites unit_price with the
 * catalog price for non-admins, so the value sent here is only a hint.
 * An existing line is updated in place (qty only) — the trigger rejects any
 * attempt to move a line to a different dish.
 */
export async function setItem(orderId, dishId, source, qty, unitPrice) {
  if (qty <= 0) {
    const { error } = await sb.from('order_items').delete()
      .eq('order_id', orderId).eq('dish_id', dishId).eq('source', source);
    boom(error, 'Промяната не се запази.');
    return;
  }

  const { data: existing, error: findErr } = await sb.from('order_items')
    .select('id').eq('order_id', orderId).eq('dish_id', dishId)
    .eq('source', source).maybeSingle();
  boom(findErr, 'Промяната не се запази.');

  if (existing) {
    const { error } = await sb.from('order_items')
      .update({ qty }).eq('id', existing.id);
    boom(error, 'Промяната не се запази.');
    return;
  }

  const { error } = await sb.from('order_items')
    .insert({ order_id: orderId, dish_id: dishId, source, qty, unit_price: unitPrice });
  boom(error, 'Промяната не се запази.');
}

export async function clearOrderItems(orderId) {
  const { error } = await sb.from('order_items').delete().eq('order_id', orderId);
  boom(error, 'Изчистването не мина.');
}

export async function deleteOrder(orderId) {
  const { error } = await sb.from('orders').delete().eq('id', orderId);
  boom(error, 'Изтриването не мина.');
}

export async function setCompleted(orderId, done) {
  const { error } = await sb.from('orders')
    .update({ completed_at: done ? new Date().toISOString() : null })
    .eq('id', orderId);
  boom(error, 'Промяната не се запази.');
}

// ────────────────────────────── admin: menu ────────────────────────────

/**
 * Only the keys actually supplied are written. Editing a price from the week
 * builder must not silently reset in_alaminut and drop the dish out of the
 * standing аламинут list.
 */
export async function upsertDish(dish) {
  const row = {};
  if (dish.name !== undefined) row.name = dish.name;
  if (dish.price !== undefined) row.price = Number(dish.price) || 0;
  if (dish.in_alaminut !== undefined) row.in_alaminut = !!dish.in_alaminut;
  if (dish.alaminut_pos !== undefined) row.alaminut_pos = Number(dish.alaminut_pos) || 0;

  const cols = 'id, name, price, in_alaminut, alaminut_pos';

  if (dish.id) {
    const { data, error } = await sb.from('dishes')
      .update(row).eq('id', dish.id).select(cols).single();
    boom(error, 'Ястието не се запази.');
    return data;
  }

  const { data, error } = await sb.from('dishes')
    .insert(row).select(cols).single();
  boom(error, 'Ястието не се създаде.');
  return data;
}

export async function archiveDish(id) {
  const { error } = await sb.from('dishes').update({ archived: true }).eq('id', id);
  boom(error, 'Ястието не се премахна.');
}

export async function saveAlaminutOrder(rows) {
  for (const r of rows) {
    const { error } = await sb.from('dishes')
      .update({ alaminut_pos: r.alaminut_pos }).eq('id', r.id);
    boom(error, 'Редът не се запази.');
  }
}

/** Replaces the whole day. dishIds order becomes position 1..n. */
export async function setDayMenu(date, dishIds) {
  const { error: delErr } = await sb.from('daily_menu').delete().eq('serve_date', date);
  boom(delErr, 'Менюто не се запази.');
  if (!dishIds.length) return;
  const rows = dishIds.map((id, i) => ({ serve_date: date, dish_id: id, position: i + 1 }));
  const { error } = await sb.from('daily_menu').insert(rows);
  boom(error, 'Менюто не се запази.');
}

export async function setDayClosed(date, closed, note) {
  const { error } = await sb.from('day_status')
    .upsert({ serve_date: date, closed, note: note ?? null },
            { onConflict: 'serve_date' });
  boom(error, 'Състоянието не се запази.');
}

// ───────────────────────────── admin: people ───────────────────────────

export async function listProfiles() {
  const { data, error } = await sb.from('profiles')
    .select('id, username, display_name, role, active').order('display_name');
  boom(error, 'Хората не се заредиха.');
  return data ?? [];
}

export async function adminUsers(action, payload = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Няма активен вход.');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Действието не мина.');
  return body;
}
