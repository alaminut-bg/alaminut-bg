import { sb } from './supabase.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

/** Turns a Postgres error into a message worth showing a user. */
function boom(error, fallback) {
  if (!error) return;
  console.error('[alaminut]', error);   // the Bulgarian text below hides the cause
  const m = String(error.message || '');
  if (m.includes('10:30')) throw new Error('Поръчките са заключени след 10:30.');
  if (m.includes('неработен')) throw new Error('Този ден е неработен.');
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
    .select('id, name, price, alaminut_pos, pinned_to_menu')
    .eq('in_alaminut', true).eq('archived', false)
    .order('alaminut_pos');
  boom(error, 'Менюто не се зареди.');
  return data ?? [];
}

/**
 * That date's menu, plus the always-offered extras (Кутия). Pinned dishes are
 * appended, never duplicated if the admin also placed one on the day by hand.
 */
export async function listDayMenu(date) {
  const [day, pinned] = await Promise.all([
    sb.from('daily_menu')
      .select('position, dishes(id, name, price, archived)')
      .eq('serve_date', date).order('position'),
    sb.from('dishes')
      .select('id, name, price')
      .eq('pinned_to_menu', true).eq('archived', false).order('name'),
  ]);
  boom(day.error, 'Менюто за деня не се зареди.');
  boom(pinned.error, 'Менюто за деня не се зареди.');

  const list = (day.data ?? [])
    .filter(r => r.dishes && !r.dishes.archived)
    .map(r => ({ id: r.dishes.id, name: r.dishes.name,
                 price: r.dishes.price, position: r.position }));

  const seen = new Set(list.map(d => d.id));
  for (const d of pinned.data ?? []) {
    if (!seen.has(d.id)) list.push({ ...d, position: 999, pinned: true });
  }
  return list;
}

/**
 * Everything the Аламинут tab manages: dishes offered in the аламинут grid,
 * plus menu-pinned extras like Кутия that are edited in the same place but
 * never appear in the аламинут grid itself.
 */
export async function listAlaminutAdmin() {
  const { data, error } = await sb.from('dishes')
    .select('id, name, price, alaminut_pos, in_alaminut, pinned_to_menu')
    .or('in_alaminut.eq.true,pinned_to_menu.eq.true')
    .eq('archived', false)
    .order('alaminut_pos');
  boom(error, 'Списъкът не се зареди.');
  return data ?? [];
}

/** Official holidays and one-off closures, as a Set of ISO dates. */
export async function listNonWorking(fromDate, toDate) {
  const { data, error } = await sb.from('non_working')
    .select('serve_date, note')
    .gte('serve_date', fromDate).lte('serve_date', toDate);
  boom(error, 'Неработните дни не се заредиха.');
  return new Set((data ?? []).map(r => r.serve_date));
}

export async function getNonWorking(date) {
  const { data, error } = await sb.from('non_working')
    .select('serve_date, note').eq('serve_date', date).maybeSingle();
  boom(error, 'Неработните дни не се заредиха.');
  return data;
}

export async function setNonWorking(date, off, note) {
  if (!off) {
    const { error } = await sb.from('non_working').delete().eq('serve_date', date);
    boom(error, 'Промяната не се запази.');
    return;
  }
  const { error } = await sb.from('non_working')
    .upsert({ serve_date: date, note: note ?? null }, { onConflict: 'serve_date' });
  boom(error, 'Промяната не се запази.');
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
    .select(`id, completed_at, submitted_at, paid_at, order_items(${ITEM_COLS})`)
    .eq('serve_date', date).eq('profile_id', session.user.id).maybeSingle();
  boom(error, 'Поръчката не се зареди.');
  if (!data) return null;
  return {
    id: data.id,
    completed_at: data.completed_at,
    submitted_at: data.submitted_at,
    paid_at: data.paid_at,
    items: data.order_items ?? [],
  };
}

/** The owner may submit or reopen their own order, until 10:30. */
export async function setSubmitted(orderId, sent) {
  const { error } = await sb.from('orders')
    .update({ submitted_at: sent ? new Date().toISOString() : null })
    .eq('id', orderId);
  boom(error, 'Промяната не се запази.');
}

export async function setPaid(orderId, paid) {
  const { error } = await sb.from('orders')
    .update({ paid_at: paid ? new Date().toISOString() : null })
    .eq('id', orderId);
  boom(error, 'Промяната не се запази.');
}

export async function getDay(date) {
  // orders references profiles twice (profile_id and completed_by), so the
  // embed must name the foreign key or PostgREST refuses as ambiguous.
  const { data, error } = await sb.from('orders')
    .select(`id, profile_id, guest_name, completed_at, submitted_at, paid_at, created_at,
             profiles!orders_profile_id_fkey(display_name),
             order_items(${ITEM_COLS})`)
    .eq('serve_date', date).order('created_at');
  boom(error, 'Денят не се зареди.');
  return (data ?? []).map(o => ({
    id: o.id,
    profile_id: o.profile_id,
    guest_name: o.guest_name,
    who: o.profiles?.display_name ?? o.guest_name ?? '—',
    completed_at: o.completed_at,
    submitted_at: o.submitted_at,
    paid_at: o.paid_at,
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
  if (dish.pinned_to_menu !== undefined) row.pinned_to_menu = !!dish.pinned_to_menu;

  const cols = 'id, name, price, in_alaminut, alaminut_pos, pinned_to_menu';

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

// ───────────────────────────── admin: people ───────────────────────────

// ───────────────────────────── own account ─────────────────────────────
// A user may change their own display name and password. The trigger in the
// database blocks everything else (username, role, active).

export async function updateMyName(displayName) {
  const name = String(displayName || '').trim();
  if (name.length < 2) throw new Error('Въведи звание и фамилия.');

  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Няма активен вход.');

  const { error } = await sb.from('profiles')
    .update({ display_name: name }).eq('id', session.user.id);
  boom(error, 'Името не се запази.');
}

export async function changeMyPassword(password) {
  if (String(password || '').length < 6) {
    throw new Error('Паролата трябва да е поне 6 знака.');
  }
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw new Error('Паролата не се смени.');
}

export async function listProfiles() {
  const { data, error } = await sb.from('profiles')
    .select('id, username, display_name, role, active').order('display_name');
  boom(error, 'Хората не се заредиха.');
  return data ?? [];
}

export async function adminUsers(action, payload = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Няма активен вход.');

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (e) {
    // fetch itself threw: the function is not deployed, or its CORS preflight
    // was rejected by the gateway (usually "Verify JWT" being on).
    console.error('[alaminut] admin-users fetch failed', e);
    throw new Error('Функцията admin-users не отговаря. Провери дали е публикувана ' +
                    'и дали "Verify JWT" е изключено.');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[alaminut] admin-users', res.status, body);
    throw new Error(body.error || `Действието не мина (${res.status}).`);
  }
  return body;
}
