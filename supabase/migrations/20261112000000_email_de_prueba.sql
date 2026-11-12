-- Latido · Email de prueba con la primera web que responde bien.
-- Así el usuario comprueba desde el primer día que los avisos le llegan y no van a spam.
-- Una sola vez por cuenta: demuestra que el email funciona; no hace falta repetirlo con cada web.
alter table public.profiles add column first_alert_sent_at timestamptz;

alter table public.alert_outbox
  drop constraint alert_outbox_alert_check,
  add constraint alert_outbox_alert_check check (alert in ('down', 'up', 'ssl', 'welcome'));

create or replace function public.checker_report(p_monitor bigint, p_ok boolean, p_status int, p_ms int, p_error text,
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

  -- Primera web de la cuenta que responde bien: email de prueba, una sola vez
  if m.state = 'pending' and nxt = 'up' then
    update public.profiles set first_alert_sent_at = now() where id = m.user_id and first_alert_sent_at is null;
    if found then
      insert into public.alert_outbox (monitor_id, alert, status, ms) values (p_monitor, 'welcome', p_status, p_ms);
    end if;
  end if;
end $$;
