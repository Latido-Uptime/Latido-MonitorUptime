-- Latido · Aviso antes de que caduque el certificado SSL.
-- El comprobador ya ve el certificado en cada comprobación https: guardamos su caducidad y avisamos
-- por email a los 14, 7 y 3 días. No a los 30: Let's Encrypt renueva solo unos 30 días antes y ese
-- aviso saltaría en casi todas las webs justo antes de su renovación automática.
alter table public.monitors
  add column ssl_expires_at  timestamptz, -- el certificado que antes caduca de la URL (null en http)
  add column ssl_warned_days int;         -- último tramo avisado (14, 7 o 3); null = ningún aviso pendiente

alter table public.alert_outbox
  add column ssl_expires_at timestamptz,
  drop constraint alert_outbox_alert_check,
  add constraint alert_outbox_alert_check check (alert in ('down', 'up', 'ssl'));

-- La firma cambia (parámetro nuevo con valor por defecto, y ya no devuelve filas): el comprobador
-- anterior sigue funcionando durante el despliegue porque llama con 5 parámetros e ignora el resultado.
drop function public.checker_report(bigint, boolean, int, int, text);
create function public.checker_report(p_monitor bigint, p_ok boolean, p_status int, p_ms int, p_error text,
                                      p_ssl_expires timestamptz default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  m     public.monitors;
  nxt   text := case when p_ok then 'up' else 'down' end;
  err   text := left(p_error, 200);
  -- Tramo de aviso del certificado; null si le quedan más de 14 días o no hay dato
  warn  int := case when p_ssl_expires <= now() + interval '3 days' then 3
                    when p_ssl_expires <= now() + interval '7 days' then 7
                    when p_ssl_expires <= now() + interval '14 days' then 14 end;
begin
  select * into m from public.monitors where id = p_monitor for update;
  if not found then return; end if; -- borrado mientras se comprobaba

  insert into public.monitor_checks (monitor_id, ok, status, ms, error)
  values (p_monitor, p_ok, p_status, p_ms, err);

  update public.monitors set
    state = nxt,
    state_since = case when m.state is distinct from nxt then now() else m.state_since end,
    last_status = p_status, last_ms = p_ms, last_error = err,
    -- Sin dato (http o fallo de conexión) se conserva lo visto; un certificado con margen rearma los avisos
    ssl_expires_at = coalesce(p_ssl_expires, m.ssl_expires_at),
    ssl_warned_days = case when p_ssl_expires is null then m.ssl_warned_days
                           when warn is null then null
                           else least(warn, coalesce(m.ssl_warned_days, warn)) end
  where id = p_monitor;

  -- Avisos: al caer (aunque sea la primera comprobación) y al volver tras una caída.
  -- Solo queda el último pendiente de cada monitor: el más reciente ya cuenta lo que pasó.
  if m.state is distinct from nxt and (nxt = 'down' or m.state = 'down') then
    delete from public.alert_outbox where monitor_id = p_monitor and alert <> 'ssl';
    insert into public.alert_outbox (monitor_id, alert, status, ms, error, down_minutes)
    values (p_monitor, nxt, p_status, p_ms, err,
            case when nxt = 'up' then greatest(1, ceil(extract(epoch from now() - m.state_since) / 60))::int end);

    -- La incidencia se abre al caer y se cierra al volver, con la comprobación anterior de cada lado
    if nxt = 'down' then
      insert into public.incidents (monitor_id, status, error, last_ok_at)
      values (p_monitor, p_status, err,
              (select max(c.checked_at) from public.monitor_checks c where c.monitor_id = p_monitor and c.ok));
    else
      update public.incidents set ended_at = now(),
        last_fail_at = (select max(c.checked_at) from public.monitor_checks c where c.monitor_id = p_monitor and not c.ok)
      where monitor_id = p_monitor and ended_at is null;
    end if;
  end if;

  -- Aviso del certificado: una sola vez por tramo
  if warn < coalesce(m.ssl_warned_days, 99) then
    delete from public.alert_outbox where monitor_id = p_monitor and alert = 'ssl';
    insert into public.alert_outbox (monitor_id, alert, ssl_expires_at) values (p_monitor, 'ssl', p_ssl_expires);
  end if;
end $$;
revoke execute on function public.checker_report(bigint, boolean, int, int, text, timestamptz) from public, anon, authenticated;
grant execute on function public.checker_report(bigint, boolean, int, int, text, timestamptz) to latido_checker;

-- Igual que antes, devolviendo también la caducidad para los avisos del certificado
drop function public.checker_alerts_due(int);
create function public.checker_alerts_due(batch int default 50)
returns table (id bigint, alert text, email text, monitor_name text, monitor_url text, event_at timestamptz,
               status int, ms int, error text, down_minutes int, ssl_expires_at timestamptz)
language sql security definer set search_path = '' as $$
  with due as (
    select o.id from public.alert_outbox o
    where o.next_attempt_at <= now()
    order by o.id
    limit least(greatest(batch, 1), 200)
    for update skip locked
  ), leased as (
    update public.alert_outbox o set
      attempts = o.attempts + 1,
      next_attempt_at = now() + interval '1 minute' * least(power(2, least(o.attempts, 6)), 60)
    from due where o.id = due.id
    returning o.*
  )
  select l.id, l.alert, u.email::text, m.name, m.url, l.event_at, l.status, l.ms, l.error, l.down_minutes, l.ssl_expires_at
  from leased l
  join public.monitors m on m.id = l.monitor_id
  join auth.users u on u.id = m.user_id
  order by l.id;
$$;
revoke execute on function public.checker_alerts_due(int) from public, anon, authenticated;
grant execute on function public.checker_alerts_due(int) to latido_checker;
