-- Аламинут — миграция: „закачени към менюто" ястия (напр. Кутия).
-- Пусни ТОВА, а не schema.sql — не трие никакви данни и пази цените.
-- Безопасно е да се пусне повече от веднъж.

-- 1. новата колона
alter table dishes
  add column if not exists pinned_to_menu boolean not null default false;

-- 2. Кутия се предлага и с менюто, не само в аламинут
update dishes set pinned_to_menu = true
where lower(name) like 'кутия%' and not archived;

-- 3. правилото в базата трябва да пуска закачените ястия като „меню"
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
      or coalesce(v_pinned, false)      -- always-offered extras, e.g. Кутия
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

-- 4. потребителят може сам да си сменя името (звание и фамилия)
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ...но само името. Иначе всеки би могъл да си вдигне правата.
create or replace function enforce_profile_self_edit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_admin() then
    return new;
  end if;
  -- The user owns their display name and their username (the username is
  -- also their login). Role and active status are not theirs to change.
  if new.role   is distinct from old.role
     or new.active is distinct from old.active
     or new.id     is distinct from old.id then
    raise exception 'Може да смениш само името и потребителя си.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_self_edit on profiles;
create trigger profiles_self_edit
  before update on profiles
  for each row execute function enforce_profile_self_edit();

-- 5. ако Кутия още я няма в каталога, добави я
insert into dishes (name, price, in_alaminut, alaminut_pos, pinned_to_menu)
select 'Кутия', 0.10, true,
       coalesce((select max(alaminut_pos) from dishes where in_alaminut), 0) + 1, true
where not exists (select 1 from dishes where lower(name) like 'кутия%');

-- 6. проверка
select name, price, in_alaminut, pinned_to_menu
from dishes where pinned_to_menu;
