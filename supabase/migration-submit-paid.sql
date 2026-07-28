-- Аламинут — миграция: пращане на поръчка и отбелязване на платено.
-- Не трие данни. Безопасно е да се пусне повече от веднъж.

alter table orders
  add column if not exists submitted_at timestamptz,
  add column if not exists paid_at      timestamptz,
  add column if not exists paid_by      uuid references profiles(id) on delete set null;

-- Заварените поръчки се смятат за пратени, за да не изчезнат от кухнята.
update orders set submitted_at = created_at where submitted_at is null;

-- ── правила ─────────────────────────────────────────────────────────────
-- Собственикът може да праща и да отваря наново своята поръчка, но само
-- докато не е заключена. „Платено“ е само за админ и само за поръчки на
-- регистриран потребител — гост плаща на място.

create or replace function enforce_orders_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_locked boolean;
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

  -- Пращане и отваряне наново са позволени само преди 10:30. Поръчката може
  -- да съдържа и аламинут, и меню, затова е заключена чак когато и двете са.
  if new.submitted_at is distinct from old.submitted_at then
    select is_locked(new.serve_date, 'alaminut')
       and is_locked(new.serve_date, 'menu') into v_locked;
    if v_locked then
      raise exception 'Поръчките са заключени след 10:30.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create or replace function enforce_completion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if (new.completed_at is not null or new.paid_at is not null) and not is_admin() then
      raise exception 'Само администратор може да отбележи поръчка като приключена.'
        using errcode = 'check_violation';
    end if;
    new.completed_by := case when new.completed_at is null then null else auth.uid() end;
    new.paid_by      := case when new.paid_at      is null then null else auth.uid() end;
    return new;
  end if;

  if (new.completed_at is distinct from old.completed_at
      or new.completed_by is distinct from old.completed_by
      or new.paid_at is distinct from old.paid_at
      or new.paid_by is distinct from old.paid_by)
     and not is_admin() then
    raise exception 'Само администратор може да отбележи поръчка като приключена.'
      using errcode = 'check_violation';
  end if;

  -- Гостите плащат на място — „платено“ важи само за акаунтите.
  if new.paid_at is not null and new.profile_id is null then
    raise exception 'Плащане се отбелязва само за поръчки на потребител.'
      using errcode = 'check_violation';
  end if;

  if new.completed_at is distinct from old.completed_at then
    new.completed_by := case when new.completed_at is null then null else auth.uid() end;
  end if;
  if new.paid_at is distinct from old.paid_at then
    new.paid_by := case when new.paid_at is null then null else auth.uid() end;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

select 'ok' as status;

-- Кутия се предлага само с менюто, не и в аламинут решетката.
update dishes set in_alaminut = false, pinned_to_menu = true
where lower(name) like 'кутия%' and not archived;
