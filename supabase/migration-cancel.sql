-- Аламинут — миграция: потребителят може да откаже своя поръчка.
-- Не трие данни. Безопасно е да се пусне повече от веднъж.
--
-- Отказът маха ястията на съответната секция (аламинут или меню) и после,
-- ако не е останало нищо, и самия ред — за да не виси празно име при админа.
-- Затова тук се разрешава изтриване на СОБСТВЕН и ПРАЗЕН ред. Самите ястия
-- си остават под правилото за 10:30 от enforce_lock(), тоест никой не може
-- да изтрие вече заключена поръчка, като мине през този път.

create or replace function enforce_orders_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_locked boolean;
begin
  if is_admin() then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.profile_id is distinct from auth.uid() then
      raise exception 'Само администратор може да изтрива чужди поръчки.'
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from order_items where order_id = old.id) then
      raise exception 'Поръчката още съдържа ястия.'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if new.serve_date is distinct from old.serve_date
     or new.profile_id is distinct from old.profile_id
     or new.guest_name is distinct from old.guest_name then
    raise exception 'Не можете да променяте деня или собственика на поръчката.'
      using errcode = 'check_violation';
  end if;

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

select 'ok' as status;
