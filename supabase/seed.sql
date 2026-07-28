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
