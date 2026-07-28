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
  ('bbbbbbbb-0000-0000-0000-000000000002','tuser','лейт. Борисов','user'),
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
