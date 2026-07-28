-- Аламинут — миграция: пази данните само месец назад.
-- Безопасно е да се пусне повече от веднъж.

-- Колко дни назад се пазят поръчките. Смени числото тук, ако решиш друго.
create or replace function purge_old_data(p_keep_days integer default 31)
returns table (deleted_orders integer, deleted_menu_days integer)
language plpgsql security definer set search_path = public as $$
declare
  v_cutoff date := sofia_date() - p_keep_days;
  v_orders integer;
  v_menu   integer;
begin
  -- order_items падат заедно с поръчката (on delete cascade)
  delete from orders where serve_date < v_cutoff;
  get diagnostics v_orders = row_count;

  delete from daily_menu where serve_date < v_cutoff;
  get diagnostics v_menu = row_count;

  delete from non_working where serve_date < v_cutoff;

  return query select v_orders, v_menu;
end;
$$;

revoke all on function purge_old_data(integer) from public, anon, authenticated;

-- ── автоматично, всяка нощ ──────────────────────────────────────────────
-- Ако този блок гръмне, включи разширението от Database → Extensions → pg_cron
-- и пусни файла пак. Ако pg_cron не е налично, виж ръчния вариант отдолу.

do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('alaminut-purge')
  where exists (select 1 from cron.job where jobname = 'alaminut-purge');

  perform cron.schedule(
    'alaminut-purge',
    '30 2 * * *',                       -- 02:30 всяка нощ
    $cron$ select purge_old_data(31); $cron$
  );

  raise notice 'pg_cron е включен: чистенето върви всяка нощ в 02:30';
exception when others then
  raise notice 'pg_cron не е наличен (%). Пускай ръчно: select purge_old_data(31);',
    sqlerrm;
end $$;

-- ── ръчно ───────────────────────────────────────────────────────────────
-- Пусни това по всяко време, за да изчистиш веднага:
--   select * from purge_old_data(31);

select * from purge_old_data(31);
