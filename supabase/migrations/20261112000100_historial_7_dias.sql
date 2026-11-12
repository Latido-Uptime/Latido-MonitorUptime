-- Latido · Cada comprobación se guarda 7 días (antes 90).
-- El panel solo usa las últimas 24 h y cada caída queda en public.incidents, que se guarda 90 días.
-- Con 90 días, unas 24 cuentas Gratis con sus 5 webs llenaban los 500 MB del plan gratis de Supabase.
create or replace function public.checker_claim(batch int default 50)
returns table (id bigint, url text)
language plpgsql security definer set search_path = '' as $$
begin
  if random() < 0.01 then
    delete from public.monitor_checks where checked_at < now() - interval '7 days';
    delete from public.incidents where ended_at < now() - interval '90 days';
  end if;
  return query
    with due as (
      select m.id from public.monitors m
      where not m.paused
        and (m.last_checked_at is null
             or m.last_checked_at + make_interval(secs => m.interval_seconds) <= now())
      order by m.last_checked_at nulls first
      limit least(greatest(batch, 1), 200)
      for update skip locked
    )
    update public.monitors m set last_checked_at = now()
    from due where m.id = due.id
    returning m.id, m.url;
end $$;
