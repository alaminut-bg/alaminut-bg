-- Аламинут — full schema. Safe to re-run: drops first.
-- Run in Supabase → SQL Editor.

-- No `drop trigger ... on <table>` here: IF EXISTS covers the trigger but NOT
-- the relation, so those statements error on a first-ever run when the table
-- does not exist yet. Dropping the tables removes their triggers anyway.
drop table    if exists order_items cascade;
drop table    if exists orders      cascade;
drop table    if exists daily_menu  cascade;
drop table    if exists day_status  cascade;   -- removed feature; drops the old table
drop table    if exists dishes      cascade;
drop table    if exists profiles    cascade;
drop function if exists is_admin() cascade;
drop function if exists is_locked(date, text) cascade;
drop function if exists enforce_lock() cascade;
drop function if exists enforce_orders_lock() cascade;
drop function if exists enforce_completion() cascade;
drop function if exists enforce_profile_self_edit() cascade;
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
  -- Always offered with the меню too, without being placed on each day by
  -- hand — e.g. Кутия. Still one dish row, so its price is edited in one
  -- place and changes everywhere at once.
  pinned_to_menu boolean not null default false,
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

-- No day_status table. A date with no daily_menu rows is simply a day the
-- kitchen does not work — weekends and the occasional weekday. The admin
-- closes a day by not building one, which is what already happens.

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
  v_date     date;
  v_row      order_items;
  v_price    numeric(6,2);
  v_in_alam  boolean;
  v_archived boolean;
  v_pinned   boolean;
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

  -- DELETE has no `new` row; the checks below only apply to INSERT/UPDATE.
  if tg_op = 'DELETE' then
    return v_row;
  end if;

  -- No day-level "is the kitchen open" rule. Аламинут is a standing list and
  -- is always orderable; a меню item is already restricted to dishes actually
  -- placed on that date's daily_menu by the check further down, so a day with
  -- no menu simply has no меню to order.

  -- An UPDATE may only change qty. Letting dish_id or source move would let a
  -- cheap line be retargeted at an expensive dish while keeping its old
  -- snapshot price — the same hole unit_price protection exists to close.
  if tg_op = 'UPDATE' then
    if new.dish_id    is distinct from old.dish_id
    or new.source     is distinct from old.source
    or new.unit_price is distinct from old.unit_price then
      raise exception 'Може да се променя само количеството.'
        using errcode = 'check_violation';
    end if;
    return new;   -- qty-only edit: nothing left to validate
  end if;

  -- Everything below is INSERT-only. Re-validating on UPDATE would break a
  -- plain qty edit on a line whose dish was archived or dropped from the day
  -- after it was legitimately ordered.

  -- rule: the dish must actually be offered under the chosen source
  select archived, in_alaminut, pinned_to_menu
    into v_archived, v_in_alam, v_pinned
    from dishes where id = new.dish_id;

  if new.source = 'alaminut' then
    if coalesce(v_archived, true) or not coalesce(v_in_alam, false) then
      raise exception 'Това ястие не е налично в аламинут менюто.'
        using errcode = 'check_violation';
    end if;
  else -- 'menu'
    if coalesce(v_archived, true) or not (
      exists (select 1 from daily_menu
              where serve_date = v_date and dish_id = new.dish_id)
      or coalesce(v_pinned, false)      -- always-offered extras, e.g. Кутия
    ) then
      raise exception 'Това ястие не е в дневното меню за тази дата.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- rule: unit_price is a server-side snapshot, never client input
  select price into v_price from dishes where id = new.dish_id;
  new.unit_price := v_price;

  return new;
end;
$$;

create trigger order_items_lock
  before insert or update or delete on order_items
  for each row execute function enforce_lock();

-- ─────────────────────── orders cannot be tampered with ─────────────────────
-- Non-admins may never delete an order (the app never lets a user remove
-- their own order — only admins do, e.g. for guests). Nor may they reassign
-- an order to another day/person, which would otherwise let them edit
-- locked items freely and set serve_date back afterwards.

create or replace function enforce_orders_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_admin() then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Само администратор може да изтрива поръчки.'
      using errcode = 'check_violation';
  end if;

  if new.serve_date is distinct from old.serve_date
     or new.profile_id is distinct from old.profile_id
     or new.guest_name is distinct from old.guest_name then
    raise exception 'Не можете да променяте деня или собственика на поръчката.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger orders_lock
  before update or delete on orders
  for each row execute function enforce_orders_lock();

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
    -- completed_by is never client-supplied: null unless an admin is
    -- legitimately completing the order at insert time.
    new.completed_by := case when new.completed_at is null then null else auth.uid() end;
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
alter table orders      enable row level security;
alter table order_items enable row level security;

create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid() or is_admin());
create policy profiles_admin_write on profiles
  for all to authenticated using (is_admin()) with check (is_admin());
-- A user may edit their own row; the trigger below limits that to display_name.
create policy profiles_self_update on profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Without this a user could grant themselves admin through their own row.
create or replace function enforce_profile_self_edit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_admin() then
    return new;
  end if;
  if new.username is distinct from old.username
     or new.role   is distinct from old.role
     or new.active is distinct from old.active
     or new.id     is distinct from old.id then
    raise exception 'Може да смениш само името си.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger profiles_self_edit
  before update on profiles
  for each row execute function enforce_profile_self_edit();

create policy dishes_read on dishes
  for select to authenticated using (true);
create policy dishes_admin_write on dishes
  for all to authenticated using (is_admin()) with check (is_admin());

create policy daily_menu_read on daily_menu
  for select to authenticated using (true);
create policy daily_menu_admin_write on daily_menu
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
  profiles, dishes, daily_menu, orders, order_items
  to authenticated;

-- ─────────────────────────────── realtime ───────────────────────────────────

alter publication supabase_realtime add table orders, order_items;
