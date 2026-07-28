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

-- A dish that is offered on the daily menu but NOT in the alaminut list —
-- used to prove source/availability enforcement works both directions.
insert into dishes (id, name, price, in_alaminut) values
  ('dddddddd-0000-0000-0000-000000000002','Тестово меню ястие', 5.00, false);

insert into daily_menu (serve_date, dish_id) values
  (date '2026-08-03', 'dddddddd-0000-0000-0000-000000000002');

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

-- ══════════════════ 4. orders cannot be deleted or reassigned by users ══════════════════
-- The FK cascade + serve_date reassignment bypasses described in the review:
-- a non-admin must never delete an order, nor move it to another day/owner.

set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';

do $$ begin
  begin
    delete from orders where id = 'eeeeeeee-0000-0000-0000-000000000001';
    raise exception 'FAIL: user was allowed to delete their own order';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

do $$ begin
  assert (select count(*) from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000001') = 1,
         'FAIL: order items must survive a rejected delete';
end $$;

do $$ begin
  begin
    update orders set serve_date = date '2026-08-01'
    where id = 'eeeeeeee-0000-0000-0000-000000000001';
    raise exception 'FAIL: user was allowed to move their order to another day';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

do $$ begin
  assert (select serve_date from orders
          where id = 'eeeeeeee-0000-0000-0000-000000000001') = date '2026-07-27',
         'FAIL: serve_date must be unchanged after the rejected update';
end $$;

-- admin bypass: delete and reassignment both work for admins
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

insert into orders (id, serve_date, profile_id) values
  ('eeeeeeee-0000-0000-0000-000000000099', date '2026-07-27',
   'cccccccc-0000-0000-0000-000000000003');

update orders set serve_date = date '2026-08-01'
where id = 'eeeeeeee-0000-0000-0000-000000000099';

do $$ begin
  assert (select serve_date from orders
          where id = 'eeeeeeee-0000-0000-0000-000000000099') = date '2026-08-01',
         'FAIL: admin must be able to move an order to another day';
end $$;

delete from orders where id = 'eeeeeeee-0000-0000-0000-000000000099';

do $$ begin
  assert (select count(*) from orders
          where id = 'eeeeeeee-0000-0000-0000-000000000099') = 0,
         'FAIL: admin must be able to delete an order';
end $$;

-- ══════════════════ 5. completed_by cannot be forged on INSERT ══════════════════
-- Owned by bbbbbbbb (not cccccccc) so it doesn't disturb the "cccccccc sees
-- zero orders" isolation assertion in section 9.

set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';

insert into orders (id, serve_date, profile_id, completed_by) values
  ('eeeeeeee-0000-0000-0000-000000000004', date '2026-08-03',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001');

do $$ begin
  assert (select completed_by from orders
          where id = 'eeeeeeee-0000-0000-0000-000000000004') is null,
         'FAIL: completed_by must be forced to null on insert unless legitimately completed';
end $$;

-- ══════════════════ 6. unit_price is a server-side snapshot ══════════════════
-- 2026-08-03 is far enough out that neither alaminut nor menu is locked
-- under the clock frozen at 2026-07-27 10:30 above.

insert into order_items (order_id, dish_id, source, qty, unit_price) values
  ('eeeeeeee-0000-0000-0000-000000000004',
   'dddddddd-0000-0000-0000-000000000001','alaminut',2,0.01);

do $$ begin
  assert (select unit_price from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
            and dish_id = 'dddddddd-0000-0000-0000-000000000001') = 3.50,
         'FAIL: unit_price must be overwritten with the catalog price on insert';
end $$;

do $$ begin
  begin
    update order_items set unit_price = 0.01
    where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
      and dish_id = 'dddddddd-0000-0000-0000-000000000001';
    raise exception 'FAIL: user was allowed to change unit_price on update';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

update order_items set qty = 5
where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
  and dish_id = 'dddddddd-0000-0000-0000-000000000001';

do $$ begin
  assert (select qty from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
            and dish_id = 'dddddddd-0000-0000-0000-000000000001') = 5,
         'FAIL: qty-only update must succeed';
  assert (select unit_price from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
            and dish_id = 'dddddddd-0000-0000-0000-000000000001') = 3.50,
         'FAIL: unit_price must remain the snapshot after a qty-only update';
end $$;

-- ══════════════════ 7. a dish must actually be offered under the source ══════════════════

-- alaminut-only dish ordered under source = 'menu' → no matching daily_menu row
do $$ begin
  begin
    insert into order_items (order_id, dish_id, source, qty, unit_price) values
      ('eeeeeeee-0000-0000-0000-000000000004',
       'dddddddd-0000-0000-0000-000000000001','menu',1,3.50);
    raise exception 'FAIL: user ordered an alaminut-only dish under source=menu';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

-- menu-only dish ordered under source = 'alaminut' → in_alaminut is false
do $$ begin
  begin
    insert into order_items (order_id, dish_id, source, qty, unit_price) values
      ('eeeeeeee-0000-0000-0000-000000000004',
       'dddddddd-0000-0000-0000-000000000002','alaminut',1,5.00);
    raise exception 'FAIL: user ordered a non-alaminut dish under source=alaminut';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

-- the same dish under the correct source (menu, matching daily_menu) must succeed
insert into order_items (order_id, dish_id, source, qty, unit_price) values
  ('eeeeeeee-0000-0000-0000-000000000004',
   'dddddddd-0000-0000-0000-000000000002','menu',1,999.00);

do $$ begin
  assert (select unit_price from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
            and dish_id = 'dddddddd-0000-0000-0000-000000000002') = 5.00,
         'FAIL: valid menu order must succeed and snapshot the catalog price';
end $$;

-- admin bypasses both the availability check and the price snapshot
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

insert into order_items (order_id, dish_id, source, qty, unit_price) values
  ('eeeeeeee-0000-0000-0000-000000000004',
   'dddddddd-0000-0000-0000-000000000002','alaminut',1,1.23);

do $$ begin
  assert (select unit_price from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000004'
            and dish_id = 'dddddddd-0000-0000-0000-000000000002'
            and source = 'alaminut') = 1.23,
         'FAIL: admin must be able to order a non-alaminut dish under alaminut and set its own price';
end $$;

-- ══════════════ 8. a day with no menu is a non-working day ══════════════
-- 2026-08-10 deliberately has no daily_menu rows, so the kitchen is shut and
-- a normal user must not be able to order anything — not even аламинут.
-- Owned by bbbbbbbb for the same isolation-safety reason as section 5.

insert into orders (id, serve_date, profile_id) values
  ('eeeeeeee-0000-0000-0000-000000000005', date '2026-08-10',
   'bbbbbbbb-0000-0000-0000-000000000002');

set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';

do $$ begin
  begin
    insert into order_items (order_id, dish_id, source, qty, unit_price) values
      ('eeeeeeee-0000-0000-0000-000000000005',
       'dddddddd-0000-0000-0000-000000000001','alaminut',1,3.50);
    raise exception 'FAIL: user ordered on a day with no menu';
  exception when check_violation then
    null;  -- expected
  end;
end $$;

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

insert into order_items (order_id, dish_id, source, qty, unit_price) values
  ('eeeeeeee-0000-0000-0000-000000000005',
   'dddddddd-0000-0000-0000-000000000001','alaminut',1,3.50);

do $$ begin
  assert (select count(*) from order_items
          where order_id = 'eeeeeeee-0000-0000-0000-000000000005') = 1,
         'FAIL: admin must be able to order on a non-working day';
end $$;

-- ══════════════════════ 9. RLS isolation ══════════════════════

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
