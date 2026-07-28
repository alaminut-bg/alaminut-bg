-- Аламинут — миграция: неработни дни.
-- Събота и неделя са неработни автоматично (в кода, без данни).
-- Тази таблица е само за официалните празници и извънредните дни.
-- Не трие данни. Безопасно е да се пусне повече от веднъж.

create table if not exists non_working (
  serve_date date primary key,
  note       text
);

alter table non_working enable row level security;

drop policy if exists non_working_read on non_working;
create policy non_working_read on non_working
  for select to authenticated using (true);

drop policy if exists non_working_admin_write on non_working;
create policy non_working_admin_write on non_working
  for all to authenticated using (is_admin()) with check (is_admin());

grant select, insert, update, delete on non_working to authenticated;

-- ── правилото в базата ──────────────────────────────────────────────────
-- Потребител не може да поръчва за събота, неделя или официален празник.
-- Админ може — за извънредни случаи.

create or replace function is_working_day(p_date date)
returns boolean language sql stable as $$
  select extract(isodow from p_date) < 6            -- 6 = събота, 7 = неделя
     and not exists (select 1 from non_working where serve_date = p_date);
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
    raise exception 'Този ден е неработен.'
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

-- ── официални празници 2026 ─────────────────────────────────────────────
-- ⚠ ПРОВЕРИ ГИ. Датите на Великден се местят всяка година, а когато празник
-- падне в събота или неделя, следващият понеделник също е неработен.
-- Всеки ден може да се включва и изключва от таб „Меню“ в приложението.
-- Съботите и неделите НЕ са тук — те се пропускат автоматично.

insert into non_working (serve_date, note) values
  (date '2026-01-01', 'Нова година'),
  (date '2026-03-03', 'Освобождение'),
  (date '2026-04-10', 'Разпети петък'),
  (date '2026-04-13', 'Светли понеделник'),
  (date '2026-05-01', 'Ден на труда'),
  (date '2026-05-06', 'Гергьовден'),
  (date '2026-05-25', 'Св. св. Кирил и Методий (преместен)'),
  (date '2026-09-07', 'Съединение (преместен)'),
  (date '2026-09-22', 'Независимост'),
  (date '2026-12-24', 'Бъдни вечер'),
  (date '2026-12-25', 'Рождество Христово'),
  (date '2026-12-28', 'Коледа (преместен)')
on conflict (serve_date) do nothing;

select serve_date, note from non_working order by serve_date;
