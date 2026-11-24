-- =============================================================================
-- Migration 11: fixes found during end-to-end testing
-- =============================================================================

-- 1. Site code generation no longer depends on the database locale: accented letters
--    (ñ, á, é, …) are mapped in both cases before upper-casing, so "Parañaque" always
--    becomes PARANAQUE (previously PARA-AQUE on databases with the "C" locale).
create or replace function public.site_code_default() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base text;
  v_code text;
  n      integer := 1;
begin
  if new.code is not null and btrim(new.code) <> '' then
    new.code := upper(btrim(new.code));
    return new;
  end if;
  v_base := upper(translate(coalesce(new.name, ''), 'ñÑáÁàÀâÂéÉèÈêÊíÍìÌîÎóÓòÒôÔúÚùÙûÛüÜ', 'nNaAaAaAeEeEeEiIiIiIoOoOoOuUuUuUuU'));
  v_base := regexp_replace(v_base, '[^A-Z0-9]+', '-', 'g');
  v_base := btrim(left(btrim(v_base, '-'), 16), '-');
  if length(v_base) < 2 then
    v_base := 'SITE';
  end if;
  v_code := v_base;
  while exists (select 1 from public.sites where code = v_code and id <> new.id) loop
    n := n + 1;
    v_code := v_base || '-' || n;
  end loop;
  new.code := v_code;
  return new;
end $$;
revoke execute on function public.site_code_default() from public, anon;
