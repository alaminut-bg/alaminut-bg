# Аламинут Supabase Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Google Apps Script backend of the Аламинут daily food-order app with Supabase, add accounts, next-day меню ordering, an admin week builder, and ship it as an installable static site on GitHub Pages.

**Architecture:** Static ES modules served by GitHub Pages talk directly to Supabase via `supabase-js` loaded from a CDN. There is no build step, no npm at runtime, and no self-hosted server. All access control lives in Postgres Row Level Security plus two triggers; the browser is treated as hostile. One Supabase Edge Function exists solely because creating auth users needs the secret key.

**Tech Stack:** Vanilla ES modules, `@supabase/supabase-js@2` (esm.sh CDN), Supabase Postgres + Auth + Edge Functions (Deno), GitHub Pages, PWA manifest + service worker.

**Spec:** `docs/superpowers/specs/2026-07-28-alaminut-supabase-design.md`

## Global Constraints

- **No build step.** No bundler, no npm dependency at runtime, no CI. Every file is served exactly as committed. `package.json`, `package-lock.json` and `node_modules/` from the earlier Next.js quickstart are deleted in Task 4.
- **Language of the interface is Bulgarian.** All user-facing strings, including database error messages, are Bulgarian. Code identifiers and comments are English.
- **Timezone is `Europe/Sofia`**, pinned explicitly. Never rely on a server or browser default.
- **Cutoff is 10:30 Sofia time.** аламинут for day D locks at D 10:30; меню for day D locks at D−1 10:30. Admins are never locked out.
- **Prices are `numeric(6,2)`, in euro**, formatted as `12,50 €` (comma decimal separator, space before €).
- **`order_items.unit_price` is a snapshot.** Editing a dish price never alters an existing order.
- **The publishable key is public.** `sb_publishable_71nG1uEZv1PbbTWpAjbZtg_uF1EEYHK` and the project URL `https://ggyjtjacjxwdgucnpkll.supabase.co` are committed to the repo. The `sb_secret_...` key is **never** committed, never sent to the browser, and exists only as an Edge Function secret.
- **Supabase client import is pinned:** `import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'`
- **Dishes are archived, never deleted** (`archived = true`), so historical orders stay readable.
- **Every module is an ES module** with explicit `export` / `import`, referenced from `index.html` with `<script type="module">`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/schema.sql` | tables, indexes, functions, triggers, RLS policies, grants, realtime |
| `supabase/seed.sql` | initial dish catalog from the photographed week |
| `supabase/tests.sql` | assertion script for lock, completion guard and RLS |
| `supabase/functions/admin-users/index.ts` | Edge Function: create / reset-password / set-active / set-role |
| `index.html` | single shell, all markup for every screen |
| `app.css` | all styles |
| `js/config.js` | Supabase URL + publishable key |
| `js/supabase.js` | the shared client instance |
| `js/util.js` | pure helpers: money, escaping, date maths, Sofia clock, client-side lock |
| `js/ui.js` | status line, confirm dialog, screen switching |
| `js/auth.js` | login form, session lifecycle, current profile + role |
| `js/api.js` | every database call, one place |
| `js/orders.js` | user screen — own order only, аламинут + меню |
| `js/admin-day.js` | admin day list, kitchen summary, Приключена, totals, realtime |
| `js/admin-week.js` | week builder — day menus, catalog search, inline price edit |
| `js/admin-alaminut.js` | standing аламинут list with drag reorder |
| `js/admin-people.js` | account creation and management |
| `js/app.js` | bootstrap and routing between screens |
| `manifest.json`, `sw.js`, `icons/` | installable PWA |
| `tests/run.html`, `tests/tests.js` | zero-dependency browser test page for pure functions |

`js/admin.js` from the spec is deliberately split into the four `admin-*.js` files above. A single admin module would carry four unrelated screens and grow past the point where it can be reasoned about or edited reliably.

## Testing Approach

There is no test runner, by design — adding one would reintroduce the npm toolchain the architecture exists to avoid. Testing is therefore three real mechanisms, not a fake one:

1. **`supabase/tests.sql`** — assertion SQL run in the Supabase SQL editor. This covers the lock function, the completion guard and RLS, which is where every security-critical decision lives. Failures raise exceptions.
2. **`tests/run.html`** — a browser page importing `js/util.js` and asserting on pure functions. No dependencies. Served locally with `npx --yes serve .` because ES modules do not load over `file://`.
3. **Manual verification steps** with exact expected outcomes for DOM behaviour, stated inline in each task.

Every task ends with a commit.

---

### Task 1: Database schema, triggers and RLS

**Files:**
- Create: `supabase/schema.sql`
- Create: `supabase/tests.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `profiles`, `dishes`, `daily_menu`, `day_status`, `orders`, `order_items`; functions `is_admin() → boolean`, `is_locked(date, text) → boolean`, `sofia_date() → date`, `sofia_time() → time`.

- [ ] **Step 1: Write the schema**

Create `supabase/schema.sql`:

```sql
-- Аламинут — full schema. Safe to re-run: drops first.
-- Run in Supabase → SQL Editor.

drop trigger  if exists orders_completion  on orders;
drop trigger  if exists order_items_lock   on order_items;
drop table    if exists order_items cascade;
drop table    if exists orders      cascade;
drop table    if exists daily_menu  cascade;
drop table    if exists day_status  cascade;
drop table    if exists dishes      cascade;
drop table    if exists profiles    cascade;
drop function if exists is_admin() cascade;
drop function if exists is_locked(date, text) cascade;
drop function if exists enforce_lock() cascade;
drop function if exists enforce_completion() cascade;
drop function if exists sofia_date() cascade;
drop function if exists sofia_time() cascade;
drop function if exists app_now() cascade;

create extension if not exists pgcrypto;

-- ─────────────────────────── Sofia business clock ───────────────────────────
-- app_now() is indirection on purpose: tests.sql can redefine it to freeze
-- time and exercise the 10:30 boundary without waiting for 10:30.

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
  display_name text not null,            -- rank + surname, e.g. 'р-к Иванов'
  role         text not null default 'user' check (role in ('admin','user')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- SECURITY DEFINER, otherwise the profiles policies recurse into themselves.
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

-- ──────────────────────────────── dishes ────────────────────────────────────

create table dishes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  price        numeric(6,2) not null default 0 check (price >= 0),
  in_alaminut  boolean not null default false,
  alaminut_pos integer not null default 0,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);

create index dishes_alaminut_idx on dishes (archived, in_alaminut, alaminut_pos);

-- ────────────────────────── daily menu & day status ─────────────────────────

create table daily_menu (
  id         uuid primary key default gen_random_uuid(),
  serve_date date not null,
  dish_id    uuid not null references dishes(id) on delete restrict,
  position   integer not null default 0,
  unique (serve_date, dish_id)
);

create index daily_menu_date_idx on daily_menu (serve_date, position);

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
  completed_at timestamptz,                          -- null = not collected
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
create index orders_date_idx on orders (serve_date);

create table order_items (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  dish_id    uuid not null references dishes(id) on delete restrict,
  source     text not null check (source in ('alaminut','menu')),
  qty        integer not null check (qty > 0),
  unit_price numeric(6,2) not null check (unit_price >= 0),
  unique (order_id, dish_id, source)
);

create index order_items_order_idx on order_items (order_id);

-- ──────────────────────────────── locking ───────────────────────────────────
--   alaminut for D → locked from D     10:30
--   menu     for D → locked from D-1   10:30

create or replace function is_locked(p_serve_date date, p_source text)
returns boolean language sql stable as $$
  select case
    when p_source = 'alaminut' then
         (sofia_date() >  p_serve_date)
      or (sofia_date() =  p_serve_date     and sofia_time() >= time '10:30')
    else
         (sofia_date() >  p_serve_date - 1)
      or (sofia_date() =  p_serve_date - 1 and sofia_time() >= time '10:30')
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
-- The owner's UPDATE policy would otherwise reach completed_at. Guard the
-- column itself; never rely on the button being hidden.

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

  -- stamp the actor server-side so the client cannot name someone else
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

create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid() or is_admin());
create policy profiles_admin_write on profiles
  for all to authenticated using (is_admin()) with check (is_admin());

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

create policy orders_own on orders
  for all to authenticated
  using  (profile_id = auth.uid() or is_admin())
  with check (is_admin() or (profile_id = auth.uid() and guest_name is null));

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

alter publication supabase_realtime add table orders, order_items;
```

- [ ] **Step 2: Run the schema and verify it fails cleanly on a second run**

In Supabase → SQL Editor, paste `supabase/schema.sql` and run.
Expected: `Success. No rows returned.`
Run it a second time. Expected: `Success` again (the drops at the top make it idempotent).

- [ ] **Step 3: Write the assertion tests**

Create `supabase/tests.sql`:

```sql
-- Аламинут — assertion tests. Run AFTER schema.sql, in the SQL Editor.
-- Every check raises on failure. A clean run means everything passed.
-- Runs inside a transaction that is rolled back, so it leaves no data.

begin;

-- Fixture users must exist in auth.users because profiles references it.
-- If your Supabase version rejects this insert for a missing NOT NULL column,
-- add that column with any placeholder value — the rows are rolled back anyway.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','admin@test.local','x',now(),now(),now()),
  ('bbbbbbbb-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','user@test.local','x',now(),now(),now()),
  ('cccccccc-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','other@test.local','x',now(),now(),now())
on conflict (id) do nothing;

insert into profiles (id, username, display_name, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001','tadmin','кап. Тестов','admin'),
  ('bbbbbbbb-0000-0000-0000-000000000002','tuser','р-к Иванов','user'),
  ('cccccccc-0000-0000-0000-000000000003','tother','сер. Друг','user');

insert into dishes (id, name, price, in_alaminut) values
  ('dddddddd-0000-0000-0000-000000000001','Тест ястие', 3.50, true);

-- ══════════════════════ 1. is_locked() boundary ══════════════════════
-- Freeze the clock by redefining app_now(). Rolled back with the tx.

create or replace function app_now() returns timestamptz language sql stable as $$
  select timestamptz '2026-07-27 10:29:00+03';   -- 10:29 Sofia, Monday 27th
$$;

do $$ begin
  -- alaminut for today: still open at 10:29
  assert is_locked(date '2026-07-27','alaminut') = false, 'alaminut today should be OPEN at 10:29';
  -- menu for tomorrow: still open at 10:29
  assert is_locked(date '2026-07-28','menu')     = false, 'menu tomorrow should be OPEN at 10:29';
  -- alaminut for yesterday: long closed
  assert is_locked(date '2026-07-26','alaminut') = true,  'alaminut yesterday must be LOCKED';
  -- menu for today: its deadline was yesterday 10:30
  assert is_locked(date '2026-07-27','menu')     = true,  'menu today must be LOCKED';
  -- menu for the day after tomorrow: deadline is tomorrow, still open
  assert is_locked(date '2026-07-29','menu')     = false, 'menu D+2 should be OPEN';
end $$;

create or replace function app_now() returns timestamptz language sql stable as $$
  select timestamptz '2026-07-27 10:30:00+03';   -- exactly 10:30
$$;

do $$ begin
  assert is_locked(date '2026-07-27','alaminut') = true, 'alaminut today must LOCK at exactly 10:30';
  assert is_locked(date '2026-07-28','menu')     = true, 'menu tomorrow must LOCK at exactly 10:30';
  assert is_locked(date '2026-07-29','menu')     = false,'menu D+2 still OPEN at 10:30';
end $$;

-- ══════════════════════ 2. lock trigger blocks users ══════════════════════

insert into orders (id, serve_date, profile_id) values
  ('eeeeeeee-0000-0000-0000-000000000001', date '2026-07-27',
   'bbbbbbbb-0000-0000-0000-000000000002');

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';

do $$ begin
  begin
    insert into order_items (order_id, dish_id, source, qty, unit_price)
    values ('eeeeeeee-0000-0000-0000-000000000001',
            'dddddddd-0000-0000-0000-000000000001','alaminut',1,3.50);
    raise exception 'FAIL: user was allowed to order after the cutoff';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

-- admin is never locked out
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
insert into order_items (order_id, dish_id, source, qty, unit_price)
values ('eeeeeeee-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000001','alaminut',1,3.50);

do $$ begin
  assert (select count(*) from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000001') = 1,
         'admin must be able to write past the cutoff';
end $$;

-- ══════════════════════ 3. completion is admin-only ══════════════════════

set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';

do $$ begin
  begin
    update orders set completed_at = now()
    where id = 'eeeeeeee-0000-0000-0000-000000000001';
    raise exception 'FAIL: user was allowed to mark their own order completed';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
update orders set completed_at = now()
where id = 'eeeeeeee-0000-0000-0000-000000000001';

do $$ begin
  assert (select completed_by from orders
          where id = 'eeeeeeee-0000-0000-0000-000000000001')
         = 'aaaaaaaa-0000-0000-0000-000000000001',
         'completed_by must be stamped from auth.uid()';
end $$;

-- ══════════════════════ 4. RLS isolation ══════════════════════

set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000003"}';

do $$ begin
  assert (select count(*) from orders) = 0,
         'a user must not see another users order';
  assert (select count(*) from order_items) = 0,
         'a user must not see another users order items';
end $$;

-- A price change by a non-admin must not take effect. RLS makes the UPDATE
-- match zero rows rather than raise, so assert on the row count.
do $$
declare n integer;
begin
  update dishes set price = 99 where id = 'dddddddd-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'FAIL: user was allowed to change a price';
exception when insufficient_privilege then
  null;  -- an outright privilege error is equally acceptable
end $$;

reset role;

do $$ begin
  assert (select price from dishes
          where id = 'dddddddd-0000-0000-0000-000000000001') = 3.50,
         'price must be unchanged after the user attempt';
end $$;

rollback;
```

- [ ] **Step 4: Run the tests and verify they pass**

In Supabase → SQL Editor, paste `supabase/tests.sql` and run.
Expected: `Success. No rows returned.` with no `FAIL:` message and no assertion error.

If any assertion fires, the message names the broken rule. Fix `schema.sql`, re-run it, then re-run the tests.

- [ ] **Step 5: Verify `app_now()` was restored by the rollback**

Run:

```sql
select sofia_date(), sofia_time();
```

Expected: today's real Sofia date and the current time — **not** `2026-07-27 10:30`. If it shows the frozen value, the rollback did not take; re-run `schema.sql`.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql supabase/tests.sql
git commit -m "feat(db): schema, lock and completion triggers, RLS policies"
```

---

### Task 2: Seed the dish catalog

**Files:**
- Create: `supabase/seed.sql`

**Interfaces:**
- Consumes: tables from Task 1.
- Produces: 21 rows in `dishes`; `Таратор` exists exactly once with `in_alaminut = true`.

- [ ] **Step 1: Write the seed**

Create `supabase/seed.sql`. Prices are `0` — the admin fills them in through the week builder on first run. `Таратор` appears in both columns of the paper sheet but is **one** dish row.

```sql
-- Аламинут — initial catalog, transcribed from the week of 27.07.2026.
-- Prices are 0; the admin sets them in the Седмица / Аламинут screens.
-- Safe to re-run: does nothing if the catalog already has rows.

do $$
begin
  if exists (select 1 from dishes) then
    raise notice 'dishes already seeded, skipping';
    return;
  end if;

  -- Standing аламинут list (right column). alaminut_pos preserves sheet order.
  insert into dishes (name, price, in_alaminut, alaminut_pos) values
    ('Таратор',                     0, true,  1),
    ('Кашкавал пане',               0, true,  2),
    ('Пържени картофи със сирене',  0, true,  3),
    ('Пържени картофи',             0, true,  4),
    ('Меча лапа',                   0, true,  5),
    ('Кебапче на скара',            0, true,  6),
    ('Кюфте на скара',              0, true,  7),
    ('Пилешко филе на скара',       0, true,  8),
    ('Мешена салата',               0, true,  9),
    ('Шопска салата',               0, true, 10),
    ('Яйца на очи',                 0, true, 11),
    ('Хляб /филия/',                0, true, 12);

  -- Menu-only dishes (left column). Таратор is NOT repeated here.
  insert into dishes (name, price, in_alaminut) values
    ('Супа топчета',                                0, false),
    ('Печен пил. бут /домат, краставица/',          0, false),
    ('Кюфтета фрикасе',                             0, false),
    ('Картофена крем супа',                         0, false),
    ('Пил. пържола бут /топ. сирене и сметана/',    0, false),
    ('Кюфтета по чирпански',                        0, false),
    ('Шкембе чорба',                                0, false),
    ('Огретен',                                     0, false),
    ('Свинско с ориз',                              0, false);
end $$;
```

- [ ] **Step 2: Run the seed and verify the counts**

Paste `supabase/seed.sql` into the SQL Editor and run, then run:

```sql
select
  (select count(*) from dishes)                        as total,
  (select count(*) from dishes where in_alaminut)      as alaminut,
  (select count(*) from dishes where name = 'Таратор') as taratori;
```

Expected exactly: `total = 21`, `alaminut = 12`, `taratori = 1`.

If `taratori = 2`, the seed was run twice with the guard removed — delete all dishes and re-run.

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql
git commit -m "feat(db): seed dish catalog from the paper menu"
```

---

### Task 3: Edge Function for account management

**Files:**
- Create: `supabase/functions/admin-users/index.ts`

**Interfaces:**
- Consumes: `profiles` table, `is_admin()` semantics.
- Produces: `POST /functions/v1/admin-users` accepting
  `{action: 'create'|'reset-password'|'set-active'|'set-role', ...}` and returning
  `{ok: true, ...}` or `{error: string}` with a 4xx status.

This function exists only because creating an auth user requires the secret key, which can never reach the browser.

- [ ] **Step 1: Write the function**

Create `supabase/functions/admin-users/index.ts`:

```ts
// Admin-only account management. The secret key lives here and nowhere else.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL     = Deno.env.get('SUPABASE_URL')!
const SECRET  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EMAIL_DOMAIN = 'alaminut.local'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const jwt = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Липсва вход.' }, 401)

  const admin = createClient(URL, SECRET, { auth: { persistSession: false } })

  // 1. Who is calling?
  const { data: caller, error: whoErr } = await admin.auth.getUser(jwt)
  if (whoErr || !caller?.user) return json({ error: 'Невалиден вход.' }, 401)

  // 2. Are they an active admin? Checked server-side, never trusted from the body.
  const { data: prof } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', caller.user.id)
    .single()

  if (!prof || prof.role !== 'admin' || !prof.active) {
    return json({ error: 'Само за администратори.' }, 403)
  }

  const body = await req.json().catch(() => ({}))
  const { action } = body

  try {
    if (action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase()
      const displayName = String(body.display_name ?? '').trim()
      const password = String(body.password ?? '')
      const role = body.role === 'admin' ? 'admin' : 'user'

      if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json({ error: 'Потребителското име трябва да е на латиница, 2–32 знака.' }, 400)
      }
      if (displayName.length < 2) {
        return json({ error: 'Въведи звание и фамилия.' }, 400)
      }
      if (password.length < 6) {
        return json({ error: 'Паролата трябва да е поне 6 знака.' }, 400)
      }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
      })
      if (createErr) {
        const taken = createErr.message.toLowerCase().includes('already')
        return json({ error: taken ? 'Това потребителско име вече съществува.' : createErr.message }, 400)
      }

      const { error: profErr } = await admin.from('profiles').insert({
        id: created.user.id,
        username,
        display_name: displayName,
        role,
      })
      if (profErr) {
        // Do not leave an auth user without a profile.
        await admin.auth.admin.deleteUser(created.user.id)
        return json({ error: profErr.message }, 400)
      }

      return json({ ok: true, id: created.user.id })
    }

    if (action === 'reset-password') {
      const password = String(body.password ?? '')
      if (password.length < 6) {
        return json({ error: 'Паролата трябва да е поне 6 знака.' }, 400)
      }
      const { error } = await admin.auth.admin.updateUserById(body.id, { password })
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === 'set-active') {
      const active = Boolean(body.active)
      if (body.id === caller.user.id && !active) {
        return json({ error: 'Не можеш да деактивираш себе си.' }, 400)
      }
      const { error } = await admin.from('profiles').update({ active }).eq('id', body.id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === 'set-role') {
      const role = body.role === 'admin' ? 'admin' : 'user'
      if (body.id === caller.user.id && role !== 'admin') {
        return json({ error: 'Не можеш да свалиш собствените си права.' }, 400)
      }
      const { error } = await admin.from('profiles').update({ role }).eq('id', body.id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: 'Непознато действие.' }, 400)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
```

- [ ] **Step 2: Deploy it**

In the Supabase dashboard → **Edge Functions** → **Deploy a new function**, name it exactly `admin-users`, and paste the file contents.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase — do **not** add them manually and do **not** paste the secret key anywhere in this repository.

- [ ] **Step 3: Create the first admin by hand**

This is the one account that cannot be created by the app, because the app needs an admin to exist first.

Dashboard → **Authentication** → **Add user** → **Create new user**:
- Email: `admin@alaminut.local`
- Password: choose one
- Tick **Auto Confirm User**

Then in the SQL Editor:

```sql
insert into profiles (id, username, display_name, role)
select id, 'admin', 'кап. Администратор', 'admin'
from auth.users where email = 'admin@alaminut.local';
```

Verify:

```sql
select username, display_name, role, active from profiles;
```

Expected: one row, `role = admin`, `active = true`.

- [ ] **Step 4: Turn off email confirmation for future accounts**

Dashboard → **Authentication** → **Sign In / Providers** → **Email** → turn **Confirm email** off.

Without this, every account the Edge Function creates would sit unconfirmed and unable to log in, because `@alaminut.local` receives no mail.

- [ ] **Step 5: Verify a non-admin is rejected**

Run in a terminal, substituting your project ref and publishable key:

```bash
curl -s -X POST \
  "https://ggyjtjacjxwdgucnpkll.supabase.co/functions/v1/admin-users" \
  -H "Content-Type: application/json" \
  -H "apikey: sb_publishable_71nG1uEZv1PbbTWpAjbZtg_uF1EEYHK" \
  -d '{"action":"create","username":"hacker","display_name":"x","password":"secret123"}'
```

Expected: `{"error":"Липсва вход."}` with HTTP 401 — no account is created. The function refuses without a valid admin JWT.

Confirm nothing was created:

```sql
select count(*) from profiles where username = 'hacker';
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/admin-users/index.ts
git commit -m "feat(db): admin-users edge function for account management"
```

---

### Task 4: Static shell, pure helpers and the browser test page

**Files:**
- Create: `js/config.js`, `js/util.js`, `tests/run.html`, `tests/tests.js`
- Create: `app.css`
- Delete: `package.json`, `package-lock.json`, `node_modules/`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.js`: `SUPABASE_URL: string`, `SUPABASE_KEY: string`
  - `util.js`: `eur(n: number) → string`, `esc(s: string) → string`, `todayISO() → string`, `addDaysISO(iso: string, n: number) → string`, `sofiaParts(d?: Date) → {date: string, minutes: number}`, `isLockedClient(serveDate: string, source: 'alaminut'|'menu', now?) → boolean`, `CUTOFF_MIN: 630`, `DOW: string[]`, `MON: string[]`, `formatDayLabel(iso) → {dow, dnum}`

- [ ] **Step 1: Remove the unused npm install**

The Next.js quickstart packages cannot be used by a no-build static site.

```bash
rm -rf node_modules package.json package-lock.json
```

- [ ] **Step 2: Write the config**

Create `js/config.js`. Both values are public by design; RLS is what protects the data.

```js
// Public by design. All access control lives in Postgres RLS.
export const SUPABASE_URL = 'https://ggyjtjacjxwdgucnpkll.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_71nG1uEZv1PbbTWpAjbZtg_uF1EEYHK';
```

- [ ] **Step 3: Write the failing tests**

Create `tests/tests.js`:

```js
import {
  eur, esc, addDaysISO, isLockedClient, sofiaParts, formatDayLabel, CUTOFF_MIN,
} from '../js/util.js';

const out = document.getElementById('out');
let pass = 0, fail = 0;

function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  out.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}\n`;
  if (!ok) out.textContent += `      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`;
}

// ── money ─────────────────────────────────────────────────────────────
eq(eur(0),      '0,00 €',  'eur: zero');
eq(eur(3.5),    '3,50 €',  'eur: one decimal padded');
eq(eur(12.345), '12,35 €', 'eur: rounds half up');
eq(eur(0.1 + 0.2), '0,30 €', 'eur: float error absorbed');

// ── escaping ──────────────────────────────────────────────────────────
eq(esc('<b>&"'), '&lt;b&gt;&amp;&quot;', 'esc: all four entities');
eq(esc(''),      '',                     'esc: empty');
eq(esc(null),    '',                     'esc: null is safe');

// ── date maths ────────────────────────────────────────────────────────
eq(addDaysISO('2026-07-27',  1), '2026-07-28', 'addDays: forward');
eq(addDaysISO('2026-07-27', -1), '2026-07-26', 'addDays: backward');
eq(addDaysISO('2026-07-31',  1), '2026-08-01', 'addDays: month boundary');
eq(addDaysISO('2026-12-31',  1), '2027-01-01', 'addDays: year boundary');
eq(addDaysISO('2026-03-29',  1), '2026-03-30', 'addDays: DST day is not skipped');

// ── the 10:30 cutoff ──────────────────────────────────────────────────
eq(CUTOFF_MIN, 630, 'cutoff is 10:30 in minutes');

const at = (date, minutes) => ({ date, minutes });

// Monday 27th, 10:29
eq(isLockedClient('2026-07-27', 'alaminut', at('2026-07-27', 629)), false, 'alaminut today OPEN at 10:29');
eq(isLockedClient('2026-07-28', 'menu',     at('2026-07-27', 629)), false, 'menu tomorrow OPEN at 10:29');
eq(isLockedClient('2026-07-26', 'alaminut', at('2026-07-27', 629)), true,  'alaminut yesterday LOCKED');
eq(isLockedClient('2026-07-27', 'menu',     at('2026-07-27', 629)), true,  'menu today LOCKED (deadline was yesterday)');
eq(isLockedClient('2026-07-29', 'menu',     at('2026-07-27', 629)), false, 'menu D+2 OPEN');

// exactly 10:30 — the boundary must lock, not stay open
eq(isLockedClient('2026-07-27', 'alaminut', at('2026-07-27', 630)), true, 'alaminut LOCKS at exactly 10:30');
eq(isLockedClient('2026-07-28', 'menu',     at('2026-07-27', 630)), true, 'menu LOCKS at exactly 10:30');
eq(isLockedClient('2026-07-29', 'menu',     at('2026-07-27', 630)), false,'menu D+2 still OPEN at 10:30');

// ── Sofia clock ───────────────────────────────────────────────────────
const p = sofiaParts(new Date('2026-07-27T07:29:00Z')); // 10:29 Sofia (UTC+3)
eq(p, { date: '2026-07-27', minutes: 629 }, 'sofiaParts: summer offset +3');

const w = sofiaParts(new Date('2026-01-15T08:29:00Z')); // 10:29 Sofia (UTC+2)
eq(w, { date: '2026-01-15', minutes: 629 }, 'sofiaParts: winter offset +2');

const mid = sofiaParts(new Date('2026-07-26T21:10:00Z')); // 00:10 Sofia on the 27th
eq(mid, { date: '2026-07-27', minutes: 10 }, 'sofiaParts: midnight rolls the date, hour is 0 not 24');

// ── day label ─────────────────────────────────────────────────────────
eq(formatDayLabel('2026-07-27'), { dow: 'понеделник', dnum: '27 юли' }, 'label: Monday 27 July');

out.textContent += `\n${pass} passed, ${fail} failed\n`;
document.title = fail ? `✗ ${fail} failed` : `✓ ${pass} passed`;
```

Create `tests/run.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>tests</title>
<style>body{background:#191d16;color:#eee9da;font:13px/1.6 ui-monospace,monospace;padding:16px}</style>
<pre id="out"></pre>
<script type="module" src="./tests.js"></script>
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npx --yes serve . -l 3000
```

Open `http://localhost:3000/tests/run.html`.
Expected: a blank page and a console error `Failed to resolve module specifier` / `404 /js/util.js` — `util.js` does not exist yet.

A plain `file://` open will **not** work; ES modules require a server.

- [ ] **Step 5: Write the implementation**

Create `js/util.js`:

```js
export const DOW = ['неделя','понеделник','вторник','сряда','четвъртък','петък','събота'];
export const MON = ['януари','февруари','март','април','май','юни',
                    'юли','август','септември','октомври','ноември','декември'];

/** Orders close at 10:30 Sofia time, expressed as minutes past midnight. */
export const CUTOFF_MIN = 10 * 60 + 30;

export function eur(n) {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  return v.toFixed(2).replace('.', ',') + ' €';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

/**
 * The current moment in Sofia, as a plain ISO date and minutes past midnight.
 * hourCycle h23 matters: without it some engines return hour "24" at midnight.
 */
export function sofiaParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);

  const p = Object.fromEntries(
    parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));

  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function todayISO() {
  return sofiaParts().date;
}

/** Date maths in UTC so a DST transition can never drop or repeat a day. */
export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Mirrors is_locked() in schema.sql.
 *   alaminut for D -> deadline D     10:30
 *   menu     for D -> deadline D-1   10:30
 * Advisory only: it drives the UI. The database trigger is authoritative,
 * because the device clock can be wrong or deliberately changed.
 */
export function isLockedClient(serveDate, source, now = sofiaParts()) {
  const deadline = source === 'alaminut' ? serveDate : addDaysISO(serveDate, -1);
  if (now.date > deadline) return true;
  return now.date === deadline && now.minutes >= CUTOFF_MIN;
}

export function formatDayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { dow: DOW[dt.getUTCDay()], dnum: `${d} ${MON[m - 1]}` };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Reload `http://localhost:3000/tests/run.html`.
Expected: every line reads `PASS`, the last line reads `24 passed, 0 failed`, and the browser tab title is `✓ 24 passed`.

- [ ] **Step 7: Port the stylesheet**

Create `app.css` containing the contents of `Index.html` lines 9–167 verbatim (everything between `<style>` and `</style>`), with these three changes:

1. Delete the `body{ ... }` rule's reliance on JS height. Replace the `body` rule with:

```css
body{
  margin:0; background:var(--bg); color:var(--text);
  font-family:'IBM Plex Sans',sans-serif; font-size:16px;
  min-height:100dvh; padding-bottom:150px;
  overflow-x:hidden; max-width:100vw;
}
```

2. Add, at the end of the file:

```css
/* screens */
.screen{display:none;}
.screen.active{display:block;}

/* login */
.login-box{max-width:340px; margin:16vh auto 0; padding:0 18px;}
.login-box h1{font-family:'Oswald',sans-serif; font-size:22px; color:var(--khaki);
  text-align:center; margin:0 0 22px; letter-spacing:.02em;}
.login-box input{width:100%; margin-bottom:11px; padding:14px 12px; font-size:16px;
  background:var(--panel); border:1px solid var(--line); border-radius:9px;
  color:var(--text); font-family:inherit;}
.login-box input:focus{border-color:var(--khaki); outline:none;}
.login-box .err{color:var(--rust); font-size:13px; min-height:19px; text-align:center;}

/* locked sections */
.locked-note{background:var(--panel-2); border:1px solid var(--line); border-radius:9px;
  padding:13px; text-align:center; color:var(--dim); font-size:13px; margin:8px 0;}
.section-head{font-family:'Oswald',sans-serif; font-size:14px; text-transform:uppercase;
  letter-spacing:.05em; color:var(--khaki); margin:20px 0 9px; display:flex;
  justify-content:space-between; align-items:baseline; gap:8px;}
.section-head .when{font-family:'IBM Plex Sans',sans-serif; text-transform:none;
  letter-spacing:0; font-size:12px; color:var(--dim);}

/* completion */
.person.done{opacity:.55;}
.done-btn{border:1px solid var(--line); background:var(--panel-2); color:var(--dim);
  border-radius:8px; padding:8px 11px; font-size:12.5px; cursor:pointer;
  font-family:inherit; white-space:nowrap;}
.done-btn.on{background:var(--ok); border-color:var(--ok); color:#191d16; font-weight:600;}
.done-count{font-size:12px; color:var(--dim);}
.done-badge{display:inline-block; background:var(--ok); color:#191d16; font-weight:600;
  font-size:12px; border-radius:6px; padding:3px 8px;}

/* kitchen split */
.ksub{font-size:11px; text-transform:uppercase; letter-spacing:.08em;
  color:var(--khaki-dim); padding:11px 0 3px;}

/* week builder catalog search */
.cat-search{width:100%; padding:12px; margin-top:8px; background:var(--panel-2);
  border:1px solid var(--line); border-radius:8px; color:var(--text);
  font-size:15px; font-family:inherit;}
.cat-list{max-height:220px; overflow-y:auto; margin-top:6px;}
.cat-item{display:flex; justify-content:space-between; align-items:center; gap:8px;
  padding:11px 10px; border-bottom:1px solid var(--line); cursor:pointer; font-size:14px;}
.cat-item:active{background:var(--panel-2);}
.cat-item .cp{font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--dim);}

/* people */
.person-row{display:flex; align-items:center; gap:9px; padding:11px 12px;
  border-bottom:1px solid var(--line);}
.person-row .pinfo{flex:1; min-width:0;}
.person-row .pu{font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--dim);}
.person-row .tagadmin{background:var(--khaki-dim); color:#191d16; font-size:11px;
  font-weight:700; border-radius:5px; padding:2px 6px;}
.person-row.off{opacity:.5;}

/* tap targets */
button, .tab, .dish, .done-btn{min-height:44px;}
```

3. Delete nothing else. The order-card, dish-grid, kitchen, totalbar, settings and dialog styles are all reused as-is.

- [ ] **Step 8: Verify the stylesheet loads**

Create a temporary check — open `http://localhost:3000/tests/run.html` and confirm it still passes (unaffected), then run:

```bash
node -e "const c=require('fs').readFileSync('app.css','utf8'); console.log('bytes',c.length, '| has :root', c.includes('--khaki'), '| has .done-btn', c.includes('.done-btn'), '| no fillScreen leftovers', !c.includes('minHeight'))"
```

Expected: `bytes` above 6000, and `true` for all three checks.

- [ ] **Step 9: Commit**

```bash
git add app.css js/config.js js/util.js tests/run.html tests/tests.js
git rm -r --cached --ignore-unmatch node_modules package.json package-lock.json
git commit -m "feat(web): config, pure helpers, stylesheet, browser test page"
```

---

### Task 5: Supabase client, login and session

**Files:**
- Create: `js/supabase.js`, `js/ui.js`, `js/auth.js`
- Create: `index.html`

**Interfaces:**
- Consumes: `config.js`, `util.js`.
- Produces:
  - `supabase.js`: `sb` — the shared `SupabaseClient`
  - `ui.js`: `setStatus(msg: string, cls?: 'err'|'ok')`, `ask(title, text, yesLabel?, calm?) → Promise<boolean>`, `showScreen(id: 'screen-login'|'screen-user'|'screen-admin')`
  - `auth.js`: `signIn(username, password) → Promise<void>` (throws `Error` with a Bulgarian message), `signOut() → Promise<void>`, `loadProfile() → Promise<{id, username, display_name, role, active}|null>`, `currentProfile() → profile|null`, `isAdmin() → boolean`, `onAuth(cb)`

- [ ] **Step 1: Write the client**

Create `js/supabase.js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
```

- [ ] **Step 2: Write the shared UI helpers**

Create `js/ui.js`. `ask()` is ported from `Index.html:260-279` unchanged in behaviour.

```js
export function setStatus(msg, cls) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

/** Transient "saved" flash that does not clobber a later message. */
export function flashSaved() {
  setStatus('✓ запазено', 'ok');
  setTimeout(() => {
    const el = document.getElementById('status');
    if (el && el.textContent === '✓ запазено') setStatus('');
  }, 1500);
}

export function ask(title, text, yesLabel, calm) {
  return new Promise(resolve => {
    const ovl = document.getElementById('ovl');
    const yes = document.getElementById('dlgYes');
    const no  = document.getElementById('dlgNo');
    document.getElementById('dlgTitle').textContent = title;
    document.getElementById('dlgText').textContent  = text;
    yes.textContent = yesLabel || 'Да';
    yes.classList.toggle('calm', !!calm);
    ovl.classList.remove('hidden');
    function done(v) {
      ovl.classList.add('hidden');
      yes.onclick = null; no.onclick = null; ovl.onclick = null;
      resolve(v);
    }
    yes.onclick = () => done(true);
    no.onclick  = () => done(false);
    ovl.onclick = e => { if (e.target === ovl) done(false); };
  });
}

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s =>
    s.classList.toggle('active', s.id === id));
}
```

- [ ] **Step 3: Write auth**

Create `js/auth.js`:

```js
import { sb } from './supabase.js';

const EMAIL_DOMAIN = 'alaminut.local';
let profile = null;

export function currentProfile() { return profile; }
export function isAdmin() { return profile?.role === 'admin'; }

/** Usernames are latin because they become an email local part. */
export async function signIn(username, password) {
  const u = String(username || '').trim().toLowerCase();
  if (!u || !password) throw new Error('Въведи потребител и парола.');

  const { error } = await sb.auth.signInWithPassword({
    email: `${u}@${EMAIL_DOMAIN}`,
    password,
  });
  if (error) throw new Error('Грешен потребител или парола.');

  const p = await loadProfile();
  if (!p) {
    await sb.auth.signOut();
    throw new Error('Профилът липсва. Обади се на администратор.');
  }
  if (!p.active) {
    await sb.auth.signOut();
    throw new Error('Профилът е деактивиран.');
  }
}

export async function signOut() {
  profile = null;
  await sb.auth.signOut();
}

export async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { profile = null; return null; }

  const { data, error } = await sb
    .from('profiles')
    .select('id, username, display_name, role, active')
    .eq('id', session.user.id)
    .maybeSingle();

  profile = error ? null : data;
  return profile;
}

export function onAuth(cb) {
  sb.auth.onAuthStateChange((event) => cb(event));
}
```

- [ ] **Step 4: Write the shell**

Create `index.html`. Only the login screen is populated in this task; the two app screens are empty containers that later tasks fill.

```html
<!DOCTYPE html>
<html lang="bg">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#191d16">
<title>Аламинут</title>
<link rel="manifest" href="manifest.json">
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="app.css">
</head>
<body>

<div class="screen active" id="screen-login">
  <div class="login-box">
    <h1>АЛАМИНУТ</h1>
    <input type="text" id="liUser" placeholder="потребител" autocomplete="username"
           autocapitalize="none" autocorrect="off" enterkeyhint="next">
    <input type="password" id="liPass" placeholder="парола" autocomplete="current-password"
           enterkeyhint="go">
    <div class="err" id="liErr"></div>
    <button class="btn-wide" id="liBtn">Вход</button>
  </div>
</div>

<div class="screen" id="screen-user">
  <div class="wrap">
    <div class="status" id="status"></div>
    <div id="userBody"></div>
  </div>
</div>

<div class="screen" id="screen-admin">
  <div class="wrap">
    <div class="tabs" id="adminTabs">
      <button class="tab active" data-atab="day">📋 Поръчки</button>
      <button class="tab" data-atab="week">🗓 Седмица</button>
      <button class="tab" data-atab="ala">🍳 Аламинут</button>
      <button class="tab" data-atab="people">👤 Хора</button>
    </div>
    <div class="status" id="statusAdmin"></div>
    <div id="adminBody"></div>
  </div>
</div>

<div class="ovl hidden" id="ovl">
  <div class="dlg">
    <div class="dtitle" id="dlgTitle"></div>
    <div class="dtext" id="dlgText"></div>
    <div class="dbtns">
      <button id="dlgNo">Не</button>
      <button class="yes" id="dlgYes">Да</button>
    </div>
  </div>
</div>

<script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Write a minimal bootstrap so login is testable**

Create `js/app.js`. Later tasks extend it.

```js
import { signIn, signOut, loadProfile, isAdmin, currentProfile, onAuth } from './auth.js';
import { showScreen } from './ui.js';

async function route() {
  const p = await loadProfile();
  if (!p || !p.active) { showScreen('screen-login'); return; }
  showScreen(isAdmin() ? 'screen-admin' : 'screen-user');
}

function bindLogin() {
  const btn  = document.getElementById('liBtn');
  const user = document.getElementById('liUser');
  const pass = document.getElementById('liPass');
  const err  = document.getElementById('liErr');

  async function submit() {
    err.textContent = '';
    btn.disabled = true;
    try {
      await signIn(user.value, pass.value);
      pass.value = '';
      await route();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  btn.onclick = submit;
  user.onkeydown = e => { if (e.key === 'Enter') pass.focus(); };
  pass.onkeydown = e => { if (e.key === 'Enter') submit(); };
}

onAuth(event => { if (event === 'SIGNED_OUT') showScreen('screen-login'); });

bindLogin();
route();

// exposed for manual verification in the console
window.__alaminut = { signOut, currentProfile, isAdmin };
```

- [ ] **Step 6: Verify login works**

With `npx --yes serve . -l 3000` running, open `http://localhost:3000/`.

1. Enter a wrong password. Expected: `Грешен потребител или парола.` in red, still on the login screen.
2. Enter `admin` and the password set in Task 3. Expected: the login screen disappears and the four admin tabs (`Поръчки / Седмица / Аламинут / Хора`) appear.
3. In the browser console run `__alaminut.currentProfile()`. Expected: an object with `role: "admin"`, `display_name: "кап. Администратор"`.
4. Reload the page. Expected: it goes straight to the admin screen — the session persisted.
5. Run `await __alaminut.signOut()`. Expected: the login screen returns.

- [ ] **Step 7: Commit**

```bash
git add index.html js/supabase.js js/ui.js js/auth.js js/app.js
git commit -m "feat(web): supabase client, login screen and session routing"
```

---

### Task 6: Data access layer

**Files:**
- Create: `js/api.js`

**Interfaces:**
- Consumes: `sb` from `supabase.js`.
- Produces (every function is `async` and throws `Error` with a Bulgarian message on failure):

```
listAlaminut()                      → [{id, name, price, alaminut_pos}]
listDayMenu(date)                   → [{id, name, price, position}]
getDayStatus(date)                  → {serve_date, closed, note} | null
searchCatalog(q)                    → [{id, name, price, in_alaminut}]
getMyOrder(date)                    → {id, completed_at, items:[{dish_id, source, qty, unit_price}]} | null
getDay(date)                        → [{id, who, profile_id, guest_name, completed_at, items:[...]}]
ensureOrder(date, profileId, guestName) → orderId: string
setItem(orderId, dishId, source, qty, unitPrice) → void   // qty <= 0 deletes
clearOrderItems(orderId)            → void
deleteOrder(orderId)                → void
setCompleted(orderId, done)         → void
upsertDish(dish)                    → {id, name, price, in_alaminut, alaminut_pos}
archiveDish(id)                     → void
saveAlaminutOrder(rows)             → void   // rows: [{id, alaminut_pos}]
setDayMenu(date, dishIds)           → void
setDayClosed(date, closed, note)    → void
listProfiles()                      → [{id, username, display_name, role, active}]
adminUsers(action, payload)         → object
```

- [ ] **Step 1: Write the module**

Create `js/api.js`:

```js
import { sb } from './supabase.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

/** Turns a Postgres error into a message worth showing a user. */
function boom(error, fallback) {
  if (!error) return;
  const m = String(error.message || '');
  if (m.includes('10:30'))       throw new Error('Поръчките са заключени след 10:30.');
  if (m.includes('администратор')) throw new Error('Само администратор може да направи това.');
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

export async function setItem(orderId, dishId, source, qty, unitPrice) {
  if (qty <= 0) {
    const { error } = await sb.from('order_items').delete()
      .eq('order_id', orderId).eq('dish_id', dishId).eq('source', source);
    boom(error, 'Промяната не се запази.');
    return;
  }
  const { error } = await sb.from('order_items')
    .upsert({ order_id: orderId, dish_id: dishId, source,
              qty, unit_price: unitPrice },
            { onConflict: 'order_id,dish_id,source' });
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

export async function upsertDish(dish) {
  const row = {
    name: dish.name,
    price: Number(dish.price) || 0,
    in_alaminut: !!dish.in_alaminut,
    alaminut_pos: Number(dish.alaminut_pos) || 0,
  };
  if (dish.id) row.id = dish.id;
  const { data, error } = await sb.from('dishes')
    .upsert(row).select('id, name, price, in_alaminut, alaminut_pos').single();
  boom(error, 'Ястието не се запази.');
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
```

- [ ] **Step 2: Verify the read path against the real database**

With the dev server running and logged in as `admin`, open the console on `http://localhost:3000/` and run:

```js
const api = await import('/js/api.js');
console.log('alaminut', (await api.listAlaminut()).length);
console.log('catalog',  (await api.searchCatalog('')).length);
console.log('таратор',  await api.searchCatalog('тарат'));
```

Expected: `alaminut 12`, `catalog 21`, and the search returning exactly one row named `Таратор`.

- [ ] **Step 3: Verify the write path and the lock**

Still in the console:

```js
const api = await import('/js/api.js');
const { todayISO, addDaysISO } = await import('/js/util.js');
const me  = (await (await import('/js/auth.js')).loadProfile()).id;
const day = addDaysISO(todayISO(), 3);          // far future, never locked

const oid   = await api.ensureOrder(day, me, null);
const dish  = (await api.listAlaminut())[0];
await api.setItem(oid, dish.id, 'alaminut', 2, dish.price);
console.log('after add',   await api.getMyOrder(day));

await api.setItem(oid, dish.id, 'alaminut', 0, dish.price);
console.log('after remove', await api.getMyOrder(day));

await api.deleteOrder(oid);
console.log('after delete', await api.getMyOrder(day));
```

Expected: the first log shows `items` with one entry, `qty: 2`; the second shows `items: []`; the third shows `null`.

- [ ] **Step 4: Verify `ensureOrder` is idempotent**

```js
const api = await import('/js/api.js');
const { todayISO, addDaysISO } = await import('/js/util.js');
const me  = (await (await import('/js/auth.js')).loadProfile()).id;
const day = addDaysISO(todayISO(), 4);
const a = await api.ensureOrder(day, me, null);
const b = await api.ensureOrder(day, me, null);
console.log(a === b ? 'PASS same order reused' : 'FAIL duplicate order created');
await api.deleteOrder(a);
```

Expected: `PASS same order reused`. A second row would violate `orders_one_per_person`, so a failure here means the lookup branch is broken.

- [ ] **Step 5: Commit**

```bash
git add js/api.js
git commit -m "feat(web): data access layer over supabase"
```

---

### Task 7: User screen — own order, аламинут + меню

**Files:**
- Create: `js/orders.js`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `api.js`, `util.js`, `ui.js`, `auth.js`.
- Produces: `renderUserScreen() → Promise<void>` — fills `#userBody`.

The dish grid, badge and minus-button markup is a direct port of `Index.html:424-434` (`dishGrid`) and `Index.html:598-623` (`refreshRow`), generalised over a `source`.

- [ ] **Step 1: Write the module**

Create `js/orders.js`:

```js
import * as api from './api.js';
import { eur, esc, todayISO, addDaysISO, isLockedClient, formatDayLabel } from './util.js';
import { setStatus, flashSaved } from './ui.js';
import { currentProfile } from './auth.js';

// state for the two sections, keyed by source
const S = {
  alaminut: { date: null, dishes: [], qty: {}, orderId: null, locked: false },
  menu:     { date: null, dishes: [], qty: {}, orderId: null, locked: false, closed: false },
};
let completedAt = null;
let saveTimer = null;
const dirty = new Set();   // `${source}|${dishId}`

function priceOf(source, dishId) {
  return Number(S[source].dishes.find(d => d.id === dishId)?.price) || 0;
}

function sectionTotal(source) {
  return Object.entries(S[source].qty)
    .reduce((t, [id, q]) => t + q * priceOf(source, id), 0);
}

function grandTotal() { return sectionTotal('alaminut') + sectionTotal('menu'); }

export async function renderUserScreen() {
  const today    = todayISO();
  const tomorrow = addDaysISO(today, 1);
  S.alaminut.date = today;
  S.menu.date     = tomorrow;
  S.alaminut.locked = isLockedClient(today, 'alaminut');
  S.menu.locked     = isLockedClient(tomorrow, 'menu');

  setStatus('зареждане…');
  try {
    const [ala, menu, status, todayOrder, tomorrowOrder] = await Promise.all([
      api.listAlaminut(),
      api.listDayMenu(tomorrow),
      api.getDayStatus(tomorrow),
      api.getMyOrder(today),
      api.getMyOrder(tomorrow),
    ]);

    S.alaminut.dishes = ala;
    S.menu.dishes     = menu;
    S.menu.closed     = !!status?.closed;

    S.alaminut.orderId = todayOrder?.id ?? null;
    S.menu.orderId     = tomorrowOrder?.id ?? null;
    completedAt        = todayOrder?.completed_at ?? null;

    S.alaminut.qty = {};
    S.menu.qty     = {};
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

function gridHTML(source) {
  const st = S[source];
  return st.dishes.map(d => {
    const q = Number(st.qty[d.id]) || 0;
    return '<button class="dish ' + (q ? 'picked' : '') + '" data-add="' + source + '|' + d.id + '">' +
      (q ? '<span class="badge">' + q + '</span>' +
           '<span class="minus" data-sub="' + source + '|' + d.id + '">−</span>' : '') +
      '<span class="dn">' + esc(d.name) + '</span>' +
      '<span class="dp">' + (d.price ? eur(d.price) : '—') + '</span></button>';
  }).join('');
}

function sectionHTML(source, title, when) {
  const st = S[source];
  let inner;

  if (source === 'menu' && st.closed) {
    inner = '<div class="locked-note">🚫 САНИТАРЕН ДЕН — няма меню.</div>';
  } else if (st.dishes.length === 0) {
    inner = '<div class="locked-note">Менюто за този ден още не е въведено.</div>';
  } else {
    inner = '<div class="dish-grid">' + gridHTML(source) + '</div>';
    if (st.locked) {
      inner = '<div class="locked-note">🔒 Заключено — след 10:30 не може да се променя.</div>' + inner;
    }
  }

  return '<div class="section-head"><span>' + title + '</span>' +
         '<span class="when">' + when + '</span></div>' +
         '<div class="person' + (st.locked ? '' : ' open') + '">' +
           '<div class="p-head">' +
             '<div class="p-main"><div class="p-summary">' +
               (Object.keys(st.qty).length ? esc(summaryText(source)) : 'няма поръчка') +
             '</div></div>' +
             '<div class="p-right"><span class="p-total">' + eur(sectionTotal(source)) + '</span></div>' +
           '</div>' +
           '<div class="picker" style="display:block">' + inner + '</div>' +
         '</div>';
}

function summaryText(source) {
  const st = S[source];
  return st.dishes
    .filter(d => st.qty[d.id])
    .map(d => st.qty[d.id] > 1 ? `${d.name} ×${st.qty[d.id]}` : d.name)
    .join(', ');
}

function draw() {
  const me = currentProfile();
  const t  = formatDayLabel(S.alaminut.date);
  const n  = formatDayLabel(S.menu.date);

  document.getElementById('userBody').innerHTML =
    '<div class="section-head"><span>' + esc(me?.display_name ?? '') + '</span>' +
      (completedAt ? '<span class="done-badge">✓ Приключена</span>' : '') + '</div>' +
    sectionHTML('alaminut', 'Днес — аламинут', `${t.dow}, ${t.dnum}`) +
    sectionHTML('menu',     'Утре — меню',     `${n.dow}, ${n.dnum}`) +
    '<div class="totalbar">' +
      '<div><div class="lbl">Общо</div>' +
      '<div class="val" id="uTotal">' + eur(grandTotal()) + '</div></div>' +
      '<div class="ppl"><button class="done-btn" id="uOut">Изход</button></div>' +
    '</div>';

  bind();
}

function bind() {
  document.querySelectorAll('#userBody [data-add]').forEach(el => {
    el.onclick = e => {
      if (e.target.hasAttribute('data-sub')) return;
      const [source, id] = el.getAttribute('data-add').split('|');
      if (S[source].locked) return;
      S[source].qty[id] = (Number(S[source].qty[id]) || 0) + 1;
      touch(source, id);
    };
  });
  document.querySelectorAll('#userBody [data-sub]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const [source, id] = el.getAttribute('data-sub').split('|');
      if (S[source].locked) return;
      const next = (Number(S[source].qty[id]) || 0) - 1;
      if (next > 0) S[source].qty[id] = next; else delete S[source].qty[id];
      touch(source, id);
    };
  });
  document.getElementById('uOut').onclick = async () => {
    const { signOut } = await import('./auth.js');
    await signOut();
  };
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
      failed.push(key);
      setStatus(e.message, 'err');
      // A lock rejection means our clock disagrees with the server. Re-read.
      if (e.message.includes('10:30')) { dirty.clear(); await renderUserScreen(); return; }
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
```

- [ ] **Step 2: Wire it into the bootstrap**

In `js/app.js`, replace the `route` function with:

```js
async function route() {
  const p = await loadProfile();
  if (!p || !p.active) { showScreen('screen-login'); return; }
  if (isAdmin()) {
    showScreen('screen-admin');
    const { renderAdmin } = await import('./admin-day.js').catch(() => ({}));
    if (renderAdmin) await renderAdmin();
  } else {
    showScreen('screen-user');
    const { renderUserScreen } = await import('./orders.js');
    await renderUserScreen();
  }
}
```

The `.catch` on the admin import is temporary scaffolding so this task runs before Task 8 exists; Task 8 removes it.

- [ ] **Step 3: Create a test user and verify the screen**

As admin, in the browser console:

```js
const api = await import('/js/api.js');
await api.adminUsers('create', {
  username: 'ivanov', display_name: 'р-к Иванов',
  password: 'test1234', role: 'user',
});
```

Expected: `{ok: true, id: "..."}`.

Then, still as admin, give tomorrow a menu so the second section has dishes:

```js
const api = await import('/js/api.js');
const { todayISO, addDaysISO } = await import('/js/util.js');
const cat = await api.searchCatalog('');
await api.setDayMenu(addDaysISO(todayISO(), 1), cat.slice(12, 16).map(d => d.id));
```

Sign out, then log in as `ivanov` / `test1234`.

Expected:
1. Two sections: `Днес — аламинут` with 12 dishes, `Утре — меню` with 4.
2. Tapping a dish shows a rust badge `1`; tapping again `2`; the minus button decrements and the badge disappears at zero.
3. The section total and the bottom `Общо` update immediately, and `✓ запазено` flashes about a second later.
4. Reload the page — the quantities are still there.
5. If it is already past 10:30 Sofia time, both sections show `🔒 Заключено` and taps do nothing.

- [ ] **Step 4: Verify a user cannot reach another user's order**

Logged in as `ivanov`, in the console:

```js
const api = await import('/js/api.js');
console.log('visible orders today:', (await api.getDay((await import('/js/util.js')).todayISO())).length);
```

Expected: `0` or `1` — never more than Иванов's own row. RLS filters the rest server-side.

- [ ] **Step 5: Verify a user cannot mark themselves completed**

```js
const api = await import('/js/api.js');
const { todayISO } = await import('/js/util.js');
const mine = await api.getMyOrder(todayISO());
try { await api.setCompleted(mine.id, true); console.log('FAIL — allowed'); }
catch (e) { console.log('PASS —', e.message); }
```

Expected: `PASS — Само администратор може да направи това.`

- [ ] **Step 6: Commit**

```bash
git add js/orders.js js/app.js
git commit -m "feat(web): user screen with alaminut and next-day menu ordering"
```

---

### Task 8: Admin day view — full list, split kitchen summary, Приключена

**Files:**
- Create: `js/admin-day.js`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `api.js`, `util.js`, `ui.js`.
- Produces: `renderAdmin() → Promise<void>` — installs the admin tab router and renders the day tab; `renderDay() → Promise<void>`.

- [ ] **Step 1: Write the module**

Create `js/admin-day.js`:

```js
import * as api from './api.js';
import { sb } from './supabase.js';
import { eur, esc, todayISO, addDaysISO, formatDayLabel } from './util.js';
import { ask } from './ui.js';

let date  = todayISO();
let rows  = [];        // [{id, who, completed_at, items}]
let ala   = [];        // alaminut dishes
let menu  = [];        // that day's menu dishes
let openId = null;
let channel = null;

function setStatus(m, cls) {
  const el = document.getElementById('statusAdmin');
  if (!el) return;
  el.textContent = m || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

const dishName = id =>
  ala.find(d => d.id === id)?.name ?? menu.find(d => d.id === id)?.name ?? '—';

const rowTotal = r => r.items.reduce((t, i) => t + i.qty * Number(i.unit_price), 0);
const grand    = () => rows.reduce((t, r) => t + rowTotal(r), 0);

export async function renderAdmin() {
  document.querySelectorAll('#adminTabs .tab').forEach(t => {
    t.onclick = async () => {
      document.querySelectorAll('#adminTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const which = t.getAttribute('data-atab');
      if (which === 'day')    return renderDay();
      if (which === 'week')   return (await import('./admin-week.js')).renderWeek();
      if (which === 'ala')    return (await import('./admin-alaminut.js')).renderAlaminut();
      if (which === 'people') return (await import('./admin-people.js')).renderPeople();
    };
  });
  await renderDay();
}

export async function renderDay() {
  setStatus('зареждане…');
  try {
    [rows, ala, menu] = await Promise.all([
      api.getDay(date), api.listAlaminut(), api.listDayMenu(date),
    ]);
    draw();
    subscribe();
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

/** Live refresh so two admins on the same day do not overwrite each other. */
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('day-' + date)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
        () => softReload())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' },
        () => softReload())
    .subscribe();
}

let softTimer = null;
function softReload() {
  clearTimeout(softTimer);
  softTimer = setTimeout(async () => {
    rows = await api.getDay(date);
    draw();
  }, 400);
}

function itemsOf(row, source) {
  return row.items.filter(i => i.source === source);
}

function summary(row) {
  const parts = row.items.map(i =>
    i.qty > 1 ? `${dishName(i.dish_id)} ×${i.qty}` : dishName(i.dish_id));
  return parts.join(', ');
}

function personHTML(row, idx) {
  const done = !!row.completed_at;
  const open = row.id === openId;
  return '<div class="person' + (done ? ' done' : '') + (open ? ' open' : '') + '">' +
    '<div class="p-head">' +
      '<span class="p-num">' + (idx + 1) + '</span>' +
      '<div class="p-main" data-open="' + row.id + '">' +
        '<div class="p-name" style="font-weight:600">' + esc(row.who) + '</div>' +
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
    '<div class="picker" style="' + (open ? 'display:block' : '') + '">' +
      pickerHTML(row) +
    '</div></div>';
}

function pickerHTML(row) {
  const grid = (dishes, source) => dishes.map(d => {
    const q = itemsOf(row, source).find(i => i.dish_id === d.id)?.qty ?? 0;
    return '<button class="dish ' + (q ? 'picked' : '') +
      '" data-aadd="' + row.id + '|' + source + '|' + d.id + '">' +
      (q ? '<span class="badge">' + q + '</span><span class="minus" data-asub="' +
           row.id + '|' + source + '|' + d.id + '">−</span>' : '') +
      '<span class="dn">' + esc(d.name) + '</span>' +
      '<span class="dp">' + (d.price ? eur(d.price) : '—') + '</span></button>';
  }).join('');

  return '<div class="ksub">Аламинут</div>' +
         '<div class="dish-grid">' + grid(ala, 'alaminut') + '</div>' +
         '<div class="ksub">Меню</div>' +
         (menu.length
            ? '<div class="dish-grid">' + grid(menu, 'menu') + '</div>'
            : '<div class="kempty">Няма меню за този ден.</div>') +
         '<div class="p-actions">' +
           '<button class="del" data-adel="' + row.id + '">Изтрий човека</button>' +
         '</div>';
}

function kitchenHTML() {
  const block = (source, title) => {
    const dishes = source === 'alaminut' ? ala : menu;
    const lines = dishes.map(d => {
      const q = rows.reduce((s, r) =>
        s + (itemsOf(r, source).find(i => i.dish_id === d.id)?.qty ?? 0), 0);
      return q ? '<div class="kline"><span>' + esc(d.name) +
                 '</span><span class="kq">' + q + ' бр.</span></div>' : '';
    }).filter(Boolean);
    return '<div class="ksub">' + title + '</div>' +
      (lines.length ? lines.join('') : '<div class="kempty">Няма поръчки.</div>');
  };

  return '<div class="kitchen open"><h2><span>Обобщение за кухнята</span></h2>' +
    '<div class="kitchen-body" style="display:block">' +
      block('alaminut', 'Аламинут') + block('menu', 'Меню') +
    '</div></div>';
}

function draw() {
  const lbl  = formatDayLabel(date);
  const done = rows.filter(r => r.completed_at).length;

  // outstanding first, completed sunk to the bottom
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
    '<div class="section-head"><span>Поръчки</span>' +
      '<span class="done-count">' + done + ' / ' + rows.length + ' приключени</span></div>' +
    (ordered.length
      ? ordered.map(personHTML).join('')
      : '<div class="empty-state"><div class="big">🍽️</div>Още никой не е записан за този ден.</div>') +
    '<button class="add-person" id="aAddGuest">+ Добави гост</button>' +
    kitchenHTML() +
    '<div class="totalbar"><div><div class="lbl">Всичко за деня</div>' +
      '<div class="val">' + eur(grand()) + '</div></div>' +
      '<div class="ppl">' + rows.length + (rows.length === 1 ? ' човек' : ' души') + '</div></div>';

  bind();
}

function bind() {
  document.getElementById('aPrev').onclick  = () => { date = addDaysISO(date, -1); renderDay(); };
  document.getElementById('aNext').onclick  = () => { date = addDaysISO(date,  1); renderDay(); };
  document.getElementById('aToday').onclick = () => { date = todayISO();           renderDay(); };
  document.getElementById('aDate').onchange = e => { date = e.target.value;        renderDay(); };

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
      const id  = el.getAttribute('data-done');
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

  document.querySelectorAll('[data-adel]').forEach(el => {
    el.onclick = async () => {
      const id  = el.getAttribute('data-adel');
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
    const name = prompt('Звание и фамилия на госта:');
    if (!name || !name.trim()) return;
    try {
      await api.ensureOrder(date, null, name.trim());
      await renderDay();
    } catch (e) { setStatus(e.message, 'err'); }
  };
}

async function bump(rowId, source, dishId, delta) {
  const row  = rows.find(r => r.id === rowId);
  const list = source === 'alaminut' ? ala : menu;
  const dish = list.find(d => d.id === dishId);
  const item = row.items.find(i => i.dish_id === dishId && i.source === source);
  const qty  = (item?.qty ?? 0) + delta;

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
```

- [ ] **Step 2: Remove the temporary scaffolding in app.js**

In `js/app.js`, replace the admin branch of `route()`:

```js
  if (isAdmin()) {
    showScreen('screen-admin');
    const { renderAdmin } = await import('./admin-day.js');
    await renderAdmin();
  } else {
```

- [ ] **Step 3: Verify the day view**

Log in as `admin`. Expected on the `Поръчки` tab:

1. The date bar shows today; `‹` and `›` move a day; `Днес` returns.
2. Иванов's order from Task 7 is listed with his `display_name`, his dishes and his total.
3. Tapping the card opens a picker with **two** labelled grids: `Аламинут` (12 dishes) and `Меню` (4, or `Няма меню за този ден` on a day with no menu).
4. Adding a dish as admin works **even after 10:30** — the trigger exempts admins.
5. `Обобщение за кухнята` shows two separate blocks, `Аламинут` and `Меню`, each counting only its own `source`.

- [ ] **Step 4: Verify Приключена**

1. Press `Приключи` on Иванов's row. Expected: the button turns green with `✓`, the card dims, it sinks below any outstanding rows, and the counter reads `1 / 1 приключени`.
2. Press it again. Expected: it reverts — it is a toggle, not one-way.
3. Confirm the actor was stamped server-side:

```sql
select o.completed_at, p.display_name as marked_by
from orders o left join profiles p on p.id = o.completed_by
where o.completed_at is not null;
```

Expected: `marked_by = кап. Администратор`.

- [ ] **Step 5: Verify realtime**

Open the app in two browser windows, both logged in as `admin`, both on today.
In window A, add a dish to someone's order.
Expected: window B updates within about a second without a reload.

- [ ] **Step 6: Commit**

```bash
git add js/admin-day.js js/app.js
git commit -m "feat(web): admin day view with split kitchen summary and completion"
```

---

### Task 9: Admin week builder

**Files:**
- Create: `js/admin-week.js`

**Interfaces:**
- Consumes: `api.js`, `util.js`, `ui.js`.
- Produces: `renderWeek() → Promise<void>` — fills `#adminBody`.

- [ ] **Step 1: Write the module**

Create `js/admin-week.js`:

```js
import * as api from './api.js';
import { eur, esc, todayISO, addDaysISO, formatDayLabel } from './util.js';
import { ask, flashSaved } from './ui.js';

let date   = todayISO();
let dishes = [];       // that day's menu, in order
let closed = false;
let note   = null;
let catalog = [];
let search  = '';

function setStatus(m, cls) {
  const el = document.getElementById('statusAdmin');
  if (!el) return;
  el.textContent = m || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

export async function renderWeek() {
  setStatus('зареждане…');
  try {
    const [menu, status, cat] = await Promise.all([
      api.listDayMenu(date), api.getDayStatus(date), api.searchCatalog(search),
    ]);
    dishes  = menu;
    closed  = !!status?.closed;
    note    = status?.note ?? null;
    catalog = cat;
    draw();
    setStatus('');
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

function draw() {
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
    '<div class="cat-item" data-wadd="' + c.id + '">' +
      '<span>' + esc(c.name) + (chosen.has(c.id) ? ' ✓' : '') + '</span>' +
      '<span class="cp">' + eur(c.price) + '</span></div>').join('');

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
      (closed
        ? '<div class="locked-note">🚫 ' + esc(note || 'САНИТАРЕН ДЕН') + '</div>'
        : (dishes.length ? rowsHTML : '<div class="kempty" style="padding:14px">Още няма ястия за този ден.</div>')) +
      '<div class="set-foot">' +
        '<button class="btn-wide" id="wClosed">' +
          (closed ? '↩ Отмени санитарен ден' : '🚫 Отбележи САНИТАРЕН ДЕН') + '</button>' +
      '</div>' +
    '</div>' +

    (closed ? '' :
    '<div class="set-block">' +
      '<h2>Добави от каталога</h2>' +
      '<div class="set-foot">' +
        '<input class="cat-search" id="wSearch" placeholder="търси или напиши ново ястие…" ' +
          'value="' + esc(search) + '" autocomplete="off">' +
        '<div class="cat-list">' + (catHTML || '<div class="kempty">Няма съвпадение.</div>') + '</div>' +
        '<button class="btn-wide" id="wNew" style="margin-top:10px">' +
          '+ Създай ново ястие „' + esc(search || '…') + '“</button>' +
      '</div>' +
    '</div>') +

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
}

function bind() {
  document.getElementById('wPrev').onclick  = () => { date = addDaysISO(date, -1); renderWeek(); };
  document.getElementById('wNext').onclick  = () => { date = addDaysISO(date,  1); renderWeek(); };
  document.getElementById('wToday').onclick = () => { date = todayISO();           renderWeek(); };
  document.getElementById('wDate').onchange = e => { date = e.target.value;        renderWeek(); };

  document.getElementById('wClosed').onclick = async () => {
    try {
      await api.setDayClosed(date, !closed, !closed ? 'САНИТАРЕН ДЕН' : null);
      await renderWeek();
      flashSaved();
    } catch (e) { setStatus(e.message, 'err'); }
  };

  const s = document.getElementById('wSearch');
  if (s) {
    let t = null;
    s.oninput = () => {
      search = s.value;
      clearTimeout(t);
      t = setTimeout(async () => {
        catalog = await api.searchCatalog(search);
        draw();
        const el = document.getElementById('wSearch');
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }, 250);
    };
  }

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
    const name = (search || '').trim();
    if (!name) { setStatus('Напиши име в полето за търсене.', 'err'); return; }
    try {
      const created = await api.upsertDish({ name, price: 0, in_alaminut: false });
      dishes.push({ id: created.id, name: created.name, price: created.price });
      search = '';
      await saveOrder();
    } catch (e) { setStatus(e.message, 'err'); }
  };

  document.querySelectorAll('[data-wdel]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-wdel');
      dishes = dishes.filter(d => d.id !== id);
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
      const id = el.getAttribute('data-wname');
      const d  = dishes.find(x => x.id === id);
      d.name = el.value;
      clearTimeout(t);
      t = setTimeout(() => saveDish(d), 700);
    };
  });
  document.querySelectorAll('[data-wprice]').forEach(el => {
    let t = null;
    el.oninput = () => {
      const id = el.getAttribute('data-wprice');
      const d  = dishes.find(x => x.id === id);
      d.price = Number(el.value) || 0;
      clearTimeout(t);
      t = setTimeout(() => saveDish(d), 700);
    };
  });

  document.getElementById('wCopy').onclick = async () => {
    const from = document.getElementById('wCopyFrom').value;
    if (!from) { setStatus('Избери ден, от който да копираш.', 'err'); return; }
    if (!await ask('Копиране на меню',
          'Менюто за този ден ще бъде заменено с това от ' + from + '.',
          'Копирай', true)) return;
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
  } catch (e) { setStatus(e.message, 'err'); }
}

async function saveDish(d) {
  try {
    await api.upsertDish({ id: d.id, name: d.name, price: d.price });
    flashSaved();
  } catch (e) { setStatus(e.message, 'err'); }
}
```

- [ ] **Step 2: Verify building a day**

Log in as `admin`, open the `Седмица` tab, navigate to tomorrow.

1. Type `супа` in the search box. Expected: the list narrows to `Супа топчета`, `Картофена крем супа`, `Шкембе чорба` is excluded (no match).
2. Tap `Супа топчета`. Expected: it appears in `Меню за деня` as row 1, `✓ запазено` flashes.
3. Add three more dishes. Expected: numbered 1–4.
4. Press `↓` on row 1. Expected: it becomes row 2 and the order persists after switching tabs and back.
5. Press `✕` on a row. Expected: it leaves the day — but it is still in the catalog search (removing from a day never archives the dish).

- [ ] **Step 3: Verify inline price editing writes to the catalog**

1. Set the price of `Супа топчета` to `2.50`. Wait for `✓ запазено`.
2. Switch to the `Поръчки` tab and back. Expected: the price still reads `2,50`.
3. Confirm it hit the catalog, not just the day:

```sql
select name, price from dishes where name = 'Супа топчета';
```

Expected: `2.50`.

- [ ] **Step 4: Verify price snapshotting**

1. As admin on the `Поръчки` tab for tomorrow, add `Супа топчета` to someone. Its `unit_price` is now 2.50.
2. Return to `Седмица`, change the price to `9.99`.
3. Return to `Поръчки`.

Expected: the existing line still charges 2,50 — the order kept its snapshot. Verify:

```sql
select oi.unit_price, d.price as catalog_price
from order_items oi join dishes d on d.id = oi.dish_id
where d.name = 'Супа топчета';
```

Expected: `unit_price = 2.50`, `catalog_price = 9.99`.

Set the price back to 2.50 afterwards.

- [ ] **Step 5: Verify САНИТАРЕН ДЕН and copy**

1. Navigate to a Thursday and press `🚫 Отбележи САНИТАРЕН ДЕН`. Expected: the dish list is replaced by the closed notice and the catalog block disappears.
2. Log in as `ivanov` on a day where tomorrow is that Thursday. Expected: the `Утре — меню` section reads `🚫 САНИТАРЕН ДЕН — няма меню.` rather than an empty grid.
3. Back as admin, on an empty day, pick a date in `Копирай от друг ден` and press `⧉ Копирай тук`. Expected: after confirming, that day's dishes appear in the same order.

- [ ] **Step 6: Commit**

```bash
git add js/admin-week.js
git commit -m "feat(web): admin week builder with catalog search and inline pricing"
```

---

### Task 10: Admin аламинут list

**Files:**
- Create: `js/admin-alaminut.js`

**Interfaces:**
- Consumes: `api.js`, `util.js`, `ui.js`.
- Produces: `renderAlaminut() → Promise<void>` — fills `#adminBody`.

The drag-reorder logic is a direct port of `Index.html:627-732` (`bindReorder`, `onDragMove`, `onDragEnd`), with `items` replaced by the module-level `list` and the save call replaced by `api.saveAlaminutOrder`.

- [ ] **Step 1: Write the module**

Create `js/admin-alaminut.js`:

```js
import * as api from './api.js';
import { eur, esc } from './util.js';
import { ask, flashSaved } from './ui.js';

let list = [];

function setStatus(m, cls) {
  const el = document.getElementById('statusAdmin');
  if (!el) return;
  el.textContent = m || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

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
      '<button class="kill" data-skill="' + it.id + '">✕</button>' +
    '</div>').join('');

  document.getElementById('adminBody').innerHTML =
    '<div class="set-block">' +
      '<h2>Аламинут — постоянен списък</h2>' +
      '<div class="reorder-hint">Задръж ⠿ и влачи, за да смениш реда.</div>' +
      '<div id="menuList">' + rows + '</div>' +
      '<div class="set-foot"><button class="btn-wide" id="addDishBtn">' +
        '+ Добави ново ястие</button></div>' +
    '</div>' +
    '<p class="set-note">Този списък важи за всеки ден. Премахнатите ястия остават ' +
    'в старите поръчки.</p>';

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
        name: 'Ново ястие', price: 0, in_alaminut: true,
        alaminut_pos: list.length + 1,
      });
      list.push(created);
      draw();
      const inputs = document.querySelectorAll('[data-sname]');
      const last = inputs[inputs.length - 1];
      last.focus(); last.select();
    } catch (e) { setStatus(e.message, 'err'); }
  };

  bindReorder();
}

async function save(it) {
  try {
    await api.upsertDish({ id: it.id, name: it.name, price: it.price,
                           in_alaminut: true, alaminut_pos: it.alaminut_pos });
    flashSaved();
  } catch (e) { setStatus(e.message, 'err'); }
}

// ── drag to reorder — ported from Index.html:627-732 ──────────────────
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

      grip.onpointermove   = onDragMove;
      grip.onpointerup     = onDragEnd;
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
    d.placeholderIndex = Array.from(parent.children).indexOf(d.el);
    d.el.style.position = 'fixed';
    d.el.style.left = d.el.getBoundingClientRect().left + 'px';
    d.el.style.zIndex = '60';
    d.el.style.pointerEvents = 'none';
    parent.insertBefore(d.marker, parent.children[d.placeholderIndex]);
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
  try { d.grip.releasePointerCapture(d.pointerId); } catch (err) { /* pointer already gone */ }

  d.el.classList.remove('dragging');
  ['position','top','left','width','zIndex','pointerEvents']
    .forEach(p => { d.el.style[p] = ''; });

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
```

- [ ] **Step 2: Verify the list**

As admin, open the `Аламинут` tab.

1. Expected: 12 rows in the seeded order, starting `Таратор`.
2. Set `Таратор` to `2.50`. Wait for `✓ запазено`, switch tabs and back. Expected: it persists.
3. Press `+ Добави ново ястие`. Expected: a row named `Ново ястие` appears at the bottom, focused and selected so typing replaces it.
4. Press `✕` on it and confirm. Expected: it disappears from the list — and it is **archived**, not deleted:

```sql
select name, archived from dishes where name = 'Ново ястие';
```

Expected: one row, `archived = true`.

- [ ] **Step 3: Verify drag reorder on a touch device**

On a phone (or Chrome DevTools device emulation, which dispatches pointer events), press and hold the `⠿` grip of row 3 and drag it above row 1.

Expected: the row lifts with a shadow, a khaki drop line follows the insertion point, and on release the list renumbers and `✓ запазено` flashes. Reload — the new order persists.

Confirm:

```sql
select name, alaminut_pos from dishes
where in_alaminut and not archived order by alaminut_pos;
```

Expected: `alaminut_pos` is a contiguous 1..n matching what is on screen.

- [ ] **Step 4: Commit**

```bash
git add js/admin-alaminut.js
git commit -m "feat(web): admin alaminut list with drag reorder"
```

---

### Task 11: Admin people management

**Files:**
- Create: `js/admin-people.js`

**Interfaces:**
- Consumes: `api.js`, `ui.js`.
- Produces: `renderPeople() → Promise<void>` — fills `#adminBody`.

- [ ] **Step 1: Write the module**

Create `js/admin-people.js`:

```js
import * as api from './api.js';
import { esc } from './util.js';
import { ask, flashSaved } from './ui.js';

let people = [];

function setStatus(m, cls) {
  const el = document.getElementById('statusAdmin');
  if (!el) return;
  el.textContent = m || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

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
        '<input class="cat-search" id="npUser" placeholder="потребител (латиница, напр. ivanov)" ' +
          'autocapitalize="none" autocorrect="off" autocomplete="off">' +
        '<input class="cat-search" id="npName" style="margin-top:9px" ' +
          'placeholder="звание и фамилия (напр. р-к Иванов)">' +
        '<input class="cat-search" id="npPass" style="margin-top:9px" type="text" ' +
          'placeholder="парола (поне 6 знака)">' +
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
    const username     = document.getElementById('npUser').value.trim().toLowerCase();
    const display_name = document.getElementById('npName').value.trim();
    const password     = document.getElementById('npPass').value;
    try {
      await api.adminUsers('create', { username, display_name, password, role: 'user' });
      document.getElementById('npUser').value = '';
      document.getElementById('npName').value = '';
      document.getElementById('npPass').value = '';
      await renderPeople();
      flashSaved();
    } catch (e) { setStatus(e.message, 'err'); }
  };

  document.querySelectorAll('[data-ppass]').forEach(el => {
    el.onclick = async () => {
      const id = el.getAttribute('data-ppass');
      const p  = people.find(x => x.id === id);
      const pw = prompt(`Нова парола за ${p.display_name} (поне 6 знака):`);
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
      const p  = people.find(x => x.id === id);
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
      const p  = people.find(x => x.id === id);
      try {
        await api.adminUsers('set-active', { id, active: !p.active });
        await renderPeople();
      } catch (e) { setStatus(e.message, 'err'); }
    };
  });
}
```

- [ ] **Step 2: Verify account creation**

As admin, open the `Хора` tab.

1. Create `petrov` / `мл. серж. Петров` / `test1234`. Expected: `✓ запазено` and the row appears in the list.
2. Try to create `petrov` again. Expected: `Това потребителско име вече съществува.` in red, no duplicate row.
3. Try `Петров` (Cyrillic) as the username. Expected: `Потребителското име трябва да е на латиница, 2–32 знака.`
4. Try a 3-character password. Expected: `Паролата трябва да е поне 6 знака.`
5. Sign out and log in as `petrov` / `test1234`. Expected: the user screen, showing `мл. серж. Петров`.

- [ ] **Step 3: Verify deactivation and password reset**

1. As admin, press `Изключи` on Петров. Expected: the row dims and reads `деактивиран`.
2. Sign out and try logging in as `petrov`. Expected: `Профилът е деактивиран.`
3. As admin, press `Включи`, then `Парола` and set `newpass99`.
4. Log in as `petrov` / `newpass99`. Expected: success.

- [ ] **Step 4: Verify the self-protection guards**

As admin, press `↓ Потребител` on your **own** row and confirm.
Expected: `Не можеш да свалиш собствените си права.` — you cannot lock yourself out of admin.

Press `Изключи` on your own row.
Expected: `Не можеш да деактивираш себе си.`

- [ ] **Step 5: Verify a normal user cannot call the function**

Log in as `petrov`, then in the console:

```js
const api = await import('/js/api.js');
try { await api.adminUsers('create', {username:'x2', display_name:'x', password:'secret123'}); console.log('FAIL'); }
catch (e) { console.log('PASS —', e.message); }
```

Expected: `PASS — Само за администратори.` The check is server-side; hiding the tab is not the protection.

- [ ] **Step 6: Commit**

```bash
git add js/admin-people.js
git commit -m "feat(web): admin account management"
```

---

### Task 12: PWA — installable, offline shell, mobile polish

**Files:**
- Create: `manifest.json`, `sw.js`, `icons/icon-192.svg`, `icons/icon-512.svg`
- Modify: `index.html`, `js/app.js`

**Interfaces:**
- Consumes: everything.
- Produces: an installable app that opens fullscreen with no browser chrome.

- [ ] **Step 1: Generate the icons**

The icon is the khaki-on-dark plate mark. Generate both sizes with one command (no design tool needed):

```bash
mkdir -p icons
node -e "
const fs=require('fs');
const svg=s=>\`<svg xmlns='http://www.w3.org/2000/svg' width='\${s}' height='\${s}'>
<rect width='\${s}' height='\${s}' rx='\${s*0.22}' fill='#191d16'/>
<circle cx='\${s/2}' cy='\${s/2}' r='\${s*0.30}' fill='none' stroke='#c2ab73' stroke-width='\${s*0.055}'/>
<circle cx='\${s/2}' cy='\${s/2}' r='\${s*0.16}' fill='#c2ab73'/></svg>\`;
fs.writeFileSync('icons/icon-192.svg',svg(192));
fs.writeFileSync('icons/icon-512.svg',svg(512));
console.log('wrote svg icons');
"
```

PNG is not required — the manifest references the SVG files directly, which every browser that supports PWA install also supports.

Verify:

```bash
ls icons
```

Expected: `icon-192.svg` and `icon-512.svg`.

- [ ] **Step 2: Write the manifest**

Create `manifest.json`:

```json
{
  "name": "Аламинут",
  "short_name": "Аламинут",
  "description": "Поръчки за храна",
  "lang": "bg",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#191d16",
  "theme_color": "#191d16",
  "icons": [
    { "src": "icons/icon-192.svg", "sizes": "192x192", "type": "image/svg+xml", "purpose": "any" },
    { "src": "icons/icon-512.svg", "sizes": "512x512", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

- [ ] **Step 3: Write the service worker**

Create `sw.js`. It caches the app shell only — never API responses, because a stale order list is worse than an error message.

```js
const CACHE = 'alaminut-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.json',
  './js/app.js', './js/config.js', './js/supabase.js', './js/util.js',
  './js/ui.js', './js/auth.js', './js/api.js', './js/orders.js',
  './js/admin-day.js', './js/admin-week.js', './js/admin-alaminut.js',
  './js/admin-people.js',
  './icons/icon-192.svg', './icons/icon-512.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache Supabase or the CDN — always go to the network.
  if (url.hostname.endsWith('supabase.co') || url.hostname === 'esm.sh') return;
  if (e.request.method !== 'GET') return;

  // Network-first for the shell so a deploy is picked up immediately,
  // falling back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
```

- [ ] **Step 4: Register it**

Append to `js/app.js`:

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* not fatal */ });
  });
}
```

- [ ] **Step 5: Verify installability**

With the dev server running, open Chrome DevTools → **Application** → **Manifest** on `http://localhost:3000/`.

Expected: the name reads `Аламинут`, both icons render, and there is no `Installability` error. Under **Service Workers**, `sw.js` shows as `activated and is running`.

- [ ] **Step 6: Verify offline behaviour**

In DevTools → **Network**, tick **Offline**, then reload.

Expected: the app shell still renders (login screen or the app frame) rather than the browser's dinosaur page. Data calls fail with a red Bulgarian status message — which is correct. Untick **Offline** and reload; everything works again.

- [ ] **Step 7: Verify on a real phone**

Serve to your phone over the local network:

```bash
npx --yes serve . -l 3000
```

Open `http://<your-laptop-ip>:3000/` on the phone, log in, then use the browser menu → **Добави към началния екран**.

Expected:
1. An icon appears on the home screen.
2. Opening it shows **no address bar** — fullscreen standalone.
3. The bottom total bar sits above the home indicator, not under it (`env(safe-area-inset-bottom)` doing its job).
4. Every dish tile, tab and button is comfortably tappable — nothing under 44px.
5. Nothing scrolls sideways at any point.

- [ ] **Step 8: Commit**

```bash
git add manifest.json sw.js icons index.html js/app.js
git commit -m "feat(web): installable PWA with offline shell"
```

---

### Task 13: Deploy to GitHub Pages

**Files:**
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the whole repo.
- Produces: a live URL.

- [ ] **Step 1: Archive the old app**

The Apps Script version is being replaced. Keep it in history rather than losing it.

```bash
mkdir -p legacy
git mv Index.html legacy/apps-script-Index.html 2>/dev/null || mv Index.html legacy/apps-script-Index.html
git add legacy
git commit -m "chore: archive the apps script version"
```

- [ ] **Step 2: Write the README**

Create `README.md`:

```markdown
# Аламинут

Дневни поръчки за храна. Статичен сайт на GitHub Pages + Supabase.

## Как работи

- `index.html` + `js/*.js` — интерфейсът. Без build стъпка, без npm.
- Supabase — база данни, вход и Edge Function за акаунтите.
- Достъпът се контролира от Row Level Security в базата, не от интерфейса.

## Настройка от нула

1. `supabase/schema.sql` → SQL Editor
2. `supabase/seed.sql` → SQL Editor
3. `supabase/functions/admin-users/index.ts` → Edge Functions, име `admin-users`
4. Authentication → изключи „Confirm email"
5. Създай първия админ ръчно (виж плана, задача 3)
6. Сложи URL и publishable key в `js/config.js`

## Тестове

- База: `supabase/tests.sql` в SQL Editor — без грешка значи всичко минава.
- Функции: `npx --yes serve .` и отвори `/tests/run.html`.

## Правила

- Поръчките се заключват в **10:30**: аламинут за деня, меню за следващия ден.
- Само админ променя меню, цени и акаунти.
- Цената се запазва в поръчката — промяна на цена не пипа стари поръчки.

`SUPABASE_URL` и publishable key са публични по замисъл. Тайният ключ
(`sb_secret_...`) не се пази в това repo — само в Edge Function-а.
```

- [ ] **Step 3: Push to GitHub**

```bash
gh repo create alaminut --public --source=. --remote=origin --push
```

If `gh` is not installed, create the repository on github.com and:

```bash
git remote add origin https://github.com/<you>/alaminut.git
git branch -M main
git push -u origin main
```

- [ ] **Step 4: Enable Pages**

Repository → **Settings** → **Pages** → **Source: Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.

Wait about a minute, then open `https://<you>.github.io/alaminut/`.

- [ ] **Step 5: Verify the deployed site**

On the live URL:

1. Log in as `admin`. Expected: the four admin tabs.
2. Check DevTools → **Console**. Expected: no CORS errors and no failed module imports. A `manifest` warning about icon purpose is harmless.
3. Log in as `ivanov` on a phone and place an order. Expected: it appears in the admin day view.
4. Install to the home screen from the live URL. Expected: fullscreen, correct icon.

- [ ] **Step 6: Confirm no secret leaked**

```bash
git log -p --all | grep -c "sb_secret" || echo "clean"
```

Expected: `clean`. If it prints a number above zero, the secret key entered history and must be rotated in the Supabase dashboard immediately.

Also confirm `.env` never landed:

```bash
git log --all --name-only --pretty=format: | sort -u | grep -x ".env" || echo "env never committed"
```

Expected: `env never committed`.

- [ ] **Step 7: Clean up the test accounts**

```sql
-- remove the throwaway accounts used during development
delete from auth.users where email in ('petrov@alaminut.local');
```

Keep `ivanov` if it is a real person; delete it the same way if not.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: setup and operation notes"
git push
```

---

## Post-deployment checklist

Run through this once with the actual admin, on a phone:

- [ ] Build a real week in `Седмица` from the current paper sheet, with real prices.
- [ ] Fill in real аламинут prices in the `Аламинут` tab.
- [ ] Create one account per person, with rank and surname.
- [ ] Confirm the 10:30 lock fires by checking the app after 10:30 with a normal account.
- [ ] Confirm the kitchen summary splits correctly with a mixed day of orders.
- [ ] Confirm `Приключена` works at lunchtime with real people collecting food.
