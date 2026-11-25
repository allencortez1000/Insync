-- Migration 13: English-only system. Rename the one seeded holiday that used a Filipino name.
update public.holidays
   set name = 'Day of Valor'
 where name = 'Araw ng Kagitingan';
