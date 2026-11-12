-- Latido · Historial del panel resumido en el servidor.
-- El panel pedía cada comprobación de las últimas 24 h, pero la API de Supabase devuelve como mucho
-- 1000 filas por petición: con 4 o 5 monitores cada 5 min se perdían justo las horas más recientes.
-- Ahora recibe una fila por monitor con 45 tramos de 32 min: '1' bien, '0' algún fallo, '.' sin datos.
-- security invoker: se aplican las políticas RLS de monitors y monitor_checks (solo lo propio, con 2FA).
create function public.my_history_24h()
returns table (monitor_id bigint, slots text, checks int, failures int)
language sql stable security invoker set search_path = '' as $$
  with s as (
    select c.monitor_id,
           least(44, floor(extract(epoch from c.checked_at - now()) / 1920 + 45))::int as slot,
           bool_and(c.ok) as ok, count(*)::int as n, (count(*) filter (where not c.ok))::int as bad
    from public.monitor_checks c
    where c.checked_at >= now() - interval '24 hours'
    group by 1, 2
  )
  select m.id,
         string_agg(case when s.ok then '1' when not s.ok then '0' else '.' end, '' order by g),
         coalesce(sum(s.n), 0)::int,
         coalesce(sum(s.bad), 0)::int
  from public.monitors m
  cross join generate_series(0, 44) g
  left join s on s.monitor_id = m.id and s.slot = g
  group by m.id;
$$;
revoke execute on function public.my_history_24h() from public, anon;
grant execute on function public.my_history_24h() to authenticated;
