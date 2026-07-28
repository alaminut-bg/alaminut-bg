-- Аламинут — миграция: два маркера за ден.
--   closed   → кухнята не работи, никакви поръчки
--   no_menu  → има аламинут, но няма меню за деня
-- Официалните празници и уикендите остават 'closed'.
-- Не трие данни. Безопасно е да се пусне повече от веднъж.

alter table non_working
  add column if not exists kind text not null default 'closed';

do $$
begin
  alter table non_working drop constraint if exists non_working_kind_check;
  alter table non_working add constraint non_working_kind_check
    check (kind in ('closed', 'no_menu'));
end $$;

-- ── правила ─────────────────────────────────────────────────────────────

-- Работен ден = делник, който не е маркиран като затворен.
-- 'no_menu' НЕ прави деня неработен — аламинут си върви.
create or replace function is_working_day(p_date date)
returns boolean language sql stable as $$
  select extract(isodow from p_date) < 6
     and not exists (
       select 1 from non_working
       where serve_date = p_date and kind = 'closed'
     );
$$;

create or replace function menu_blocked(p_date date)
returns boolean language sql stable as $$
  select exists (
    select 1 from non_working
    where serve_date = p_date and kind = 'no_menu'
  );
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

  if tg_op = 'DELETE' then
    return v_row;
  end if;

  if not is_working_day(v_date) then
    raise exception 'Кухнята не работи на тази дата.'
      using errcode = 'check_violation';
  end if;

  if v_row.source = 'menu' and menu_blocked(v_date) then
    raise exception 'Няма меню за тази дата.'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' then
    if new.dish_id    is distinct from old.dish_id
    or new.source     is distinct from old.source
    or new.unit_price is distinct from old.unit_price then
      raise exception 'Може да се променя само количеството.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

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
      or coalesce(v_pinned, false)
    ) then
      raise exception 'Това ястие не е в дневното меню за тази дата.'
        using errcode = 'check_violation';
    end if;
  end if;

  select price into v_price from dishes where id = new.dish_id;
  new.unit_price := v_price;

  return new;
end;
$$;

select serve_date, kind, note from non_working order by serve_date;
