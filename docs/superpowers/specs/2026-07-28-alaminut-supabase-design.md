# Аламинут — migration from Apps Script to Supabase

**Date:** 2026-07-28
**Status:** approved design, not yet implemented

## 1. Purpose

The existing app is a single 845-line `Index.html` served by Google Apps Script, backed by a
Google Sheet. One person types everyone's daily food orders into it. It works, but Apps Script
is slow, has execution quotas, and cannot support accounts.

This migration moves the backend to Supabase and the frontend to GitHub Pages, and adds:

- password-protected accounts (admin-created, no self-signup)
- each person entering their **own** order
- a second order type: the daily **меню** (pre-ordered for the next day) alongside the existing
  **аламинут** (ordered for the same day)
- an admin week-builder for assembling each day's меню from a growing dish catalog
- proper mobile layout, installable as a phone app

Existing Google Sheet data is **not** migrated. The new database starts empty; the Sheet stays
in Google Drive as a read-only archive.

## 2. Domain

From the kitchen's weekly paper sheet:

- The left column is the **дневно меню** — for each date, an ordered list of ~4 dishes.
  A day can instead be marked `САНИТАРЕН ДЕН` (kitchen closed).
- The right column is **аламинут** — a standing made-to-order list, identical all week.
- Dishes repeat heavily across days and weeks (`ТАРАТОР` appears Mon, Tue and Wed, and is also
  on the аламинут list). Roughly 20 menu variants circulate and eventually stabilise.

Therefore dishes are a **reusable catalog**, and "which dishes are on day D" is a separate fact.
A dish has exactly one price regardless of where it appears.

Ordering a меню is mechanically identical to ordering аламинут: tap a dish to add one, tap again
for another, tap minus to remove. A person may order a full меню, part of one, or several of the
same dish. There is no bundle price — the total is the sum of the dishes ordered.

## 3. Architecture

```
Phone / browser
      │
      ├─ GitHub Pages ──► static files (HTML / CSS / JS modules, manifest, service worker)
      │
      └─ supabase-js (CDN) ──► Supabase
                                 ├─ Auth           username → internal email, password
                                 ├─ Postgres       RLS is the security boundary
                                 └─ Edge Function  admin-users (account management)
```

No self-hosted server, no build step, no CI. `git push` publishes.

### Why no build step

The priority is "set it up once and never touch it". A bundler, `npm`, and a GitHub Action are
three more things that can break during a dependency update while nobody is watching. Plain ES
modules with `supabase-js` imported from a CDN need none of it, and the app is small enough that
bundle size is irrelevant.

### Why GitHub Pages

Free, unlimited sites, no per-account project cap (unlike the existing Render and Netlify free
accounts), no cold starts, nothing to renew. The repository must be **public** for free Pages.
This is safe: the Supabase anon key is designed to be published, and all access control is
enforced by Row Level Security in the database.

### Supabase free-tier pausing

Supabase pauses a project after 7 consecutive days with no **database** activity. Daily use by
staff prevents this. No keep-alive pinger is needed — and note that pinging the GitHub Pages URL
would not help anyway, since only database activity counts. If a long shutdown ever does pause
the project, it is restored with one click in the Supabase dashboard; data is retained.

### File layout

| File | Purpose |
|---|---|
| `index.html` | shell and all markup |
| `app.css` | existing styles, carried over, plus the new screens |
| `js/supabase.js` | client construction, project URL and anon key |
| `js/auth.js` | login screen, session handling, role resolution |
| `js/api.js` | every database call, in one place |
| `js/orders.js` | the day view — own order, аламинут + меню |
| `js/admin.js` | week builder, dish catalog, accounts, full day list |
| `js/ui.js` | shared helpers: `eur`, `esc`, the `ask()` dialog, status line |
| `manifest.json`, `sw.js` | installable PWA |
| `supabase/schema.sql` | tables, policies, functions, seed |
| `supabase/functions/admin-users/` | Edge Function source |

`js/api.js` deliberately exposes the same shape the Apps Script bridge did (`getDay`, `saveRow`,
`deleteRow`, `saveMenu`), so the order-entry logic that already works well is preserved rather
than rewritten.

### Configuration

A `.env` file cannot be read by a browser on a static site. The two Supabase values are pasted
directly into `js/supabase.js`, which is correct — both are public by design:

```
NEXT_PUBLIC_SUPABASE_URL              https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  sb_publishable_...
```

This project uses Supabase's **new API key format**. `sb_publishable_...` is the direct
replacement for the legacy `anon` JWT key: it resolves to the same `anon` / `authenticated`
Postgres roles, so every RLS policy in section 5 applies unchanged. It requires a recent
supabase-js v2 build, so the CDN import is pinned accordingly:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
```

The `NEXT_PUBLIC_` prefix is a Next.js build-time convention and has no effect here, since there
is no build step. The names are kept only so they match what the Supabase dashboard displays.

`.env` is kept, gitignored, purely as a local note of these values and for running a local dev
server during testing. Nothing in the deployed app reads it.

The secret counterpart, `sb_secret_...` (formerly `service_role`), is **never** placed in any file
in this repository. It exists only as a secret inside the Edge Function's environment in Supabase.

## 4. Data model

```sql
profiles      id → auth.users, username, display_name, role, active
dishes        id, name, price, in_alaminut, alaminut_pos, archived
daily_menu    serve_date, dish_id, position
day_status    serve_date, closed, note
orders        serve_date, profile_id | guest_name, completed_at, completed_by
order_items   order_id, dish_id, source, qty, unit_price
```

### `display_name`

A single free-text field holding rank and surname together, exactly as it should appear:
`лейт. Борисов`. The admin types it whole when creating the account. Rank is not a separate
field and not a controlled list — a promotion means editing the one string.

`username` remains separate and Latin (`borisov`), because it has to survive being turned into an
email address for Supabase Auth. The user types the username to log in but only ever sees
`display_name` in the interface.

### `source` on `order_items`

An order row is keyed by the date the food is **served**. On Tuesday's row, the аламинут items
were entered on Tuesday but the меню items were entered on Monday. The origin cannot be derived
from any other column, so it is stored.

`source` drives two things: the kitchen summary splits into an Аламинут block and a Меню block,
and the two have different deadlines.

### Locking

| items | lock at |
|---|---|
| `source = 'alaminut'` for day D | D, 10:30 local |
| `source = 'menu'` for day D | D−1, 10:30 local |

Both therefore close on the same morning: at 10:30 the kitchen holds today's аламинут counts and
tomorrow's меню counts together. Admins are never locked out.

The lock is enforced by a database trigger, not only by disabled buttons, because the anon key is
public and a determined user could otherwise write directly to the API.

Timezone is `Europe/Sofia`, pinned explicitly in the SQL rather than relying on the server default.

### Price snapshotting

`order_items.unit_price` records the price at the moment the item was ordered. Editing a dish
price in the week builder updates the catalog and affects only future orders; past days keep what
they were sold at. This preserves the current spreadsheet behaviour.

### Deletion

Removing a dish sets `archived = true` rather than deleting the row, so historical orders remain
intact and readable. Archived dishes are not offerable.

### Closed days

`day_status.closed` exists so that "the admin has not filled Thursday in yet" and "Thursday is
САНИТАРЕН ДЕН" are visibly different states. An empty `daily_menu` alone cannot distinguish them,
and users would read the first as a broken app.

### Guests

`orders.guest_name` lets an admin add a person who has no account. Exactly one of `profile_id`
and `guest_name` is set, enforced by a check constraint. Normal users can never create guest rows.

### Completion

The admin marks an order **Приключена** once that person has physically collected their food.
`completed_at` (null = not collected) plus `completed_by` records who marked it and when.

The flag is **per order**, not per dish: a person's аламинут for day D and their меню for day D
are handed over together at the same lunch, so a single toggle covers both. It is a toggle, not a
one-way action — an admin can un-mark a row set by mistake.

Only admins may change it, enforced by a trigger rather than by hiding the button, since a normal
user's `update` policy would otherwise reach the column. Users see the state read-only on their
own card.

Completion is independent of the 10:30 lock — an order can be marked collected at any time, well
after ordering has closed.

## 5. Schema

```sql
-- ─────────────────────────── extensions & helpers ───────────────────────────

create extension if not exists pgcrypto;

-- Local "business time" in Sofia, independent of the server timezone.
create or replace function app_now()
returns timestamptz language sql stable as $$
  select now();
$$;

create or replace function sofia_date()
returns date language sql stable as $$
  select (app_now() at time zone 'Europe/Sofia')::date;
$$;

create or replace function sofia_time()
returns time language sql stable as $$
  select (app_now() at time zone 'Europe/Sofia')::time;
$$;

-- ─────────────────────────────── profiles ───────────────────────────────────

create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9._-]{2,32}$'),
  display_name text not null,
  role         text not null default 'user' check (role in ('admin','user')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- SECURITY DEFINER so that the profiles policies do not recurse into themselves.
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

-- ──────────────────────────────── dishes ────────────────────────────────────

create table dishes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  price       numeric(6,2) not null default 0 check (price >= 0),
  in_alaminut boolean not null default false,
  alaminut_pos integer not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index on dishes (archived, in_alaminut, alaminut_pos);

-- ────────────────────────── daily menu & day status ─────────────────────────

create table daily_menu (
  id         uuid primary key default gen_random_uuid(),
  serve_date date not null,
  dish_id    uuid not null references dishes(id) on delete restrict,
  position   integer not null default 0,
  unique (serve_date, dish_id)
);

create index on daily_menu (serve_date, position);

create table day_status (
  serve_date date primary key,
  closed     boolean not null default false,
  note       text
);

-- ─────────────────────────── orders & order items ───────────────────────────

create table orders (
  id           uuid primary key default gen_random_uuid(),
  serve_date   date not null,
  profile_id   uuid references profiles(id) on delete cascade,
  guest_name   text,
  completed_at timestamptz,                            -- null = not collected yet
  completed_by uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint one_owner check (
    (profile_id is not null and guest_name is null) or
    (profile_id is null and guest_name is not null)
  )
);

create unique index orders_one_per_person
  on orders (serve_date, profile_id) where profile_id is not null;

create index on orders (serve_date);

create table order_items (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  dish_id    uuid not null references dishes(id) on delete restrict,
  source     text not null check (source in ('alaminut','menu')),
  qty        integer not null check (qty > 0),
  unit_price numeric(6,2) not null check (unit_price >= 0),
  unique (order_id, dish_id, source)
);

create index on order_items (order_id);

-- ──────────────────────────────── locking ───────────────────────────────────

-- An item is locked once its ordering window has closed.
--   alaminut for D  → locked from D     10:30
--   menu     for D  → locked from D-1   10:30
create or replace function is_locked(p_serve_date date, p_source text)
returns boolean language sql stable as $$
  select case
    when p_source = 'alaminut'
      then (sofia_date() > p_serve_date)
        or (sofia_date() = p_serve_date     and sofia_time() >= time '10:30')
    else
           (sofia_date() > p_serve_date - 1)
        or (sofia_date() = p_serve_date - 1 and sofia_time() >= time '10:30')
  end;
$$;

create or replace function enforce_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_row  order_items;
begin
  v_row := coalesce(new, old);
  select serve_date into v_date from orders where id = v_row.order_id;

  if is_admin() then
    return v_row;
  end if;

  if is_locked(v_date, v_row.source) then
    raise exception 'Поръчките са заключени след 10:30.'
      using errcode = 'check_violation';
  end if;

  return v_row;
end;
$$;

create trigger order_items_lock
  before insert or update or delete on order_items
  for each row execute function enforce_lock();

-- ───────────────────────── completion is admin-only ─────────────────────────
-- The owner's UPDATE policy would otherwise let a user mark their own order
-- collected. Guard the column itself rather than relying on the UI.

create or replace function enforce_completion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.completed_at is not null and not is_admin() then
      raise exception 'Само администратор може да отбележи поръчка като приключена.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if (new.completed_at is distinct from old.completed_at
      or new.completed_by is distinct from old.completed_by)
     and not is_admin() then
    raise exception 'Само администратор може да отбележи поръчка като приключена.'
      using errcode = 'check_violation';
  end if;

  -- stamp who did it, so the client cannot claim someone else did
  if new.completed_at is distinct from old.completed_at then
    new.completed_by := case when new.completed_at is null then null else auth.uid() end;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger orders_completion
  before insert or update on orders
  for each row execute function enforce_completion();

-- ──────────────────────────── row level security ────────────────────────────

alter table profiles    enable row level security;
alter table dishes      enable row level security;
alter table daily_menu  enable row level security;
alter table day_status  enable row level security;
alter table orders      enable row level security;
alter table order_items enable row level security;

-- profiles: you see yourself; admins see and manage everyone
create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid() or is_admin());
create policy profiles_admin_write on profiles
  for all to authenticated using (is_admin()) with check (is_admin());

-- catalog and calendar: everyone reads, admins write
create policy dishes_read on dishes
  for select to authenticated using (true);
create policy dishes_admin_write on dishes
  for all to authenticated using (is_admin()) with check (is_admin());

create policy daily_menu_read on daily_menu
  for select to authenticated using (true);
create policy daily_menu_admin_write on daily_menu
  for all to authenticated using (is_admin()) with check (is_admin());

create policy day_status_read on day_status
  for select to authenticated using (true);
create policy day_status_admin_write on day_status
  for all to authenticated using (is_admin()) with check (is_admin());

-- orders: your own row only; admins see the whole day
create policy orders_own on orders
  for all to authenticated
  using  (profile_id = auth.uid() or is_admin())
  with check (
    is_admin() or (profile_id = auth.uid() and guest_name is null)
  );

create policy order_items_own on order_items
  for all to authenticated
  using (exists (
    select 1 from orders o where o.id = order_id
      and (o.profile_id = auth.uid() or is_admin())
  ))
  with check (exists (
    select 1 from orders o where o.id = order_id
      and (o.profile_id = auth.uid() or is_admin())
  ));

-- ──────────────────────────────── grants ────────────────────────────────────
-- Policies only filter rows; the role still needs table privileges.

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  profiles, dishes, daily_menu, day_status, orders, order_items
  to authenticated;

-- ─────────────────────────────── realtime ───────────────────────────────────
-- Only the admin day view subscribes; users need no live sync.

alter publication supabase_realtime add table orders, order_items;
```

### Seed

The аламинут list and the dishes visible on the photographed week are inserted with
`price = 0`; the admin fills real prices in on first run through the week builder.

```
аламинут   Таратор, Кашкавал пане, Пържени картофи със сирене, Пържени картофи,
           Меча лапа, Кебапче на скара, Кюфте на скара, Пилешко филе на скара,
           Мешена салата, Шопска салата, Яйца на очи, Хляб /филия/

меню       Супа топчета, Печен пил. бут /домат, краставица/, Кюфтета фрикасе,
           Картофена крем супа, Пил. пържола бут /топ. сирене и сметана/,
           Кюфтета по чирпански, Шкембе чорба, Огретен, Свинско с ориз
```

`Таратор` is inserted once, with `in_alaminut = true`, and is additionally placed on the
relevant `daily_menu` dates. It is not duplicated.

## 6. Authentication

Supabase Auth requires an email per account. Staff will not all have one, and usernames are
Cyrillic surnames which cannot appear in an email local part.

The admin therefore sets two fields: a Latin `username` (`petrov`) used for login, and a Cyrillic
`display_name` (`Петров`) shown everywhere in the interface. The app maps the username to an
internal address before calling Supabase:

```js
signInWithPassword({ email: `${username}@alaminut.local`, password })
```

Users never see or type an email. Email confirmation is switched off in the Supabase Auth
settings, since these addresses do not receive mail. There is no email-based password reset —
an admin sets a new password instead.

### Account management

Creating an auth user requires the `service_role` key, which cannot be shipped in a public page.
A Supabase Edge Function `admin-users` performs these operations server-side:

| action | effect |
|---|---|
| `create` | creates the auth user + `profiles` row |
| `reset-password` | sets a new password |
| `set-active` | activates or deactivates an account |
| `set-role` | promotes to admin or demotes to user |

The function verifies the caller's JWT and confirms that caller is an active admin before doing
anything. It is deployed once from the Supabase dashboard; the `service_role` key is supplied as
a function secret and never leaves Supabase.

The first admin account is created by hand in the Supabase dashboard, once, during setup.

## 7. Screens

### Login

Username and password. Nothing else.

### User view

A single screen showing only that person's own order.

- **Днес — аламинут**: the existing tap-to-add dish grid, sourced from
  `dishes where in_alaminut and not archived`, ordered by `alaminut_pos`.
- **Утре — меню**: the identical grid, sourced from `daily_menu` for tomorrow.
- After the relevant 10:30 deadline the section becomes read-only with an explicit
  `Заключено — след 10:30` state rather than silently failing.
- If tomorrow is `САНИТАРЕН ДЕН`, that is shown in place of the grid.
- Own running total at the bottom.
- A read-only `✓ Приключена` badge once an admin has marked the order collected. The user cannot
  set or clear it.

A user cannot see or edit anyone else's order, and RLS enforces this rather than the UI.

### Admin view

Tabbed:

- **Поръчки** — the current full day list with the date bar, every person's order, and the
  kitchen summary **split into separate Аламинут and Меню blocks**, plus the grand total.
  Admins may add, edit and delete any order, including after the lock.
  Each person's card carries a **Приключена** toggle marking that they collected their food;
  completed rows dim and sink below the outstanding ones, so what is left to hand out is obvious
  at a glance. A counter shows `12 / 18 приключени`.
- **Седмица** — the week builder. Pick a date, add dishes from a searchable catalog, drag to
  reorder, remove, mark the day as САНИТАРЕН ДЕН, or copy the whole day from another date.
  Typing a name not in the catalog creates a new dish permanently.
  **Price is editable inline and saves back to the catalog dish**, so prices can be filled in
  while assembling the week.
- **Аламинут** — the standing list: add, rename, reprice, drag-reorder, archive. This is the
  existing settings screen, carried over.
- **Хора** — create an account, reset a password, deactivate, promote to admin.

### Mobile

The `fillScreen()` routine in the current file exists solely to force the Apps Script iframe to
fill the screen. It is deleted. Replaced by real viewport handling: `dvh` units, `env(safe-area-inset-*)`
padding, tap targets of at least 44px, and a PWA manifest so the app opens fullscreen from the
home screen with no browser chrome.

## 8. Synchronisation

The current app polls every 15 seconds. Supabase Realtime replaces it for the admin's day view,
which is the only screen where concurrent edits matter. Users editing only their own order need
no live sync; a refresh on focus is sufficient.

Optimistic local updates with a debounced write are kept, as they work well on a slow phone
connection. The `dirty`-set and retry behaviour in the current file is preserved.

## 9. Error handling

- **Offline** — writes queue in the existing `dirty` set and retry, with the status line showing
  `⚠ няма връзка — ще опитам пак`. Unchanged from today.
- **Lock rejection** — the trigger raises a Bulgarian message; the client shows it and reloads
  that section read-only, in case the user's clock is wrong.
- **Session expiry** — `supabase.auth.onAuthStateChange` returns the user to the login screen
  without losing unsaved input where possible.
- **Deactivated account** — RLS via `is_admin()` and an `active` check causes reads to return
  nothing; the client detects the empty profile and signs the user out with an explanation.
- **Paused project** — requests fail wholesale; the status line shows a clear message rather
  than an empty app.

## 10. Testing

- **Lock function** — direct SQL tests of `is_locked()` across the boundary: 10:29 and 10:31 on
  D and D−1, for both sources.
- **RLS** — with a normal user's JWT, confirm that reading another person's order returns zero
  rows and that writing to `dishes` fails.
- **Completion guard** — with a normal user's JWT, confirm that setting `completed_at` on their
  own order is rejected, both on insert and on update.
- **Edge Function** — confirm a non-admin JWT is rejected for every action.
- **Manual** — full pass on a real phone: install to home screen, order in both sections, hit
  the lock, verify the admin week builder and the split kitchen summary.

## 11. Out of scope

Deliberately excluded from this iteration, to be reconsidered only if actually needed:

- payments, debts and settlement tracking
- reporting and CSV export across date ranges
- named reusable week templates (the day-by-day builder with "copy from another day" is expected
  to be enough; templates are worth adding only if the ~20 menus genuinely stabilise)
- importing the historical Google Sheet data
- push notifications and order reminders
