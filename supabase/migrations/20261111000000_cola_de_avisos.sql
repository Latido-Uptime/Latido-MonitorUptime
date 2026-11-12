-- Latido · Avisos que no se pierden.
-- Antes checker_report devolvía el aviso y, si el envío fallaba (Resend caído, tope diario,
-- reinicio de la máquina), se perdía. Ahora el aviso entra en una cola en la misma transacción
-- que el cambio de estado, y solo sale de ella cuando Resend lo ha aceptado.

create table public.alert_outbox (
  id               bigint generated always as identity primary key,
  monitor_id       bigint not null references public.monitors (id) on delete cascade,
  alert            text not null check (alert in ('down', 'up')),
  event_at         timestamptz not null default now(), -- hora del suceso, no la del envío
  status           int,
  ms               int,
  error            text check (char_length(error) <= 200),
  down_minutes     int,
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now()
);
-- Nadie la lee por la API; solo las funciones del comprobador
alter table public.alert_outbox enable row level security;
revoke all on public.alert_outbox from anon, authenticated;

-- Guarda un resultado. Si el estado cambia (cae o vuelve), deja el aviso en la cola.
-- shortcut: conserva la firma antigua aunque ya no devuelve filas, para que el comprobador anterior
-- no falle durante el despliegue; pásala a void la próxima vez que se toque esta función.
create or replace function public.checker_report(p_monitor bigint, p_ok boolean, p_status int, p_ms int, p_error text)
returns table (alert text, email text, monitor_name text, monitor_url text, down_minutes int)
language plpgsql security definer set search_path = '' as $$
declare
  m     public.monitors;
  nxt   text := case when p_ok then 'up' else 'down' end;
  err   text := left(p_error, 200);
begin
  select * into m from public.monitors where id = p_monitor for update;
  if not found then return; end if; -- borrado mientras se comprobaba

  insert into public.monitor_checks (monitor_id, ok, status, ms, error)
  values (p_monitor, p_ok, p_status, p_ms, err);

  update public.monitors set
    state = nxt,
    state_since = case when m.state is distinct from nxt then now() else m.state_since end,
    last_status = p_status, last_ms = p_ms, last_error = err
  where id = p_monitor;

  -- Avisos: al caer (aunque sea la primera comprobación) y al volver tras una caída.
  -- Solo queda el último pendiente de cada monitor: el más reciente ya cuenta lo que pasó.
  if m.state is distinct from nxt and (nxt = 'down' or m.state = 'down') then
    delete from public.alert_outbox where monitor_id = p_monitor;
    insert into public.alert_outbox (monitor_id, alert, status, ms, error, down_minutes)
    values (p_monitor, nxt, p_status, p_ms, err,
            case when nxt = 'up' then greatest(1, ceil(extract(epoch from now() - m.state_since) / 60))::int end);
  end if;
end $$;

-- Entrega los avisos a los que les toca y los reserva: si no se confirma el envío, vuelven a salir
-- a los 1, 2, 4… min, como mucho cada hora (varios comprobadores no se pisan)
create function public.checker_alerts_due(batch int default 50)
returns table (id bigint, alert text, email text, monitor_name text, monitor_url text,
               event_at timestamptz, status int, ms int, error text, down_minutes int)
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
  select l.id, l.alert, u.email::text, m.name, m.url, l.event_at, l.status, l.ms, l.error, l.down_minutes
  from leased l
  join public.monitors m on m.id = l.monitor_id
  join auth.users u on u.id = m.user_id
  order by l.id;
$$;

-- Resend aceptó el aviso: sale de la cola
create function public.checker_alert_sent(p_id bigint) returns void
language sql security definer set search_path = '' as $$
  delete from public.alert_outbox where id = p_id;
$$;

revoke execute on function public.checker_alerts_due(int) from public, anon, authenticated;
revoke execute on function public.checker_alert_sent(bigint) from public, anon, authenticated;
grant execute on function public.checker_alerts_due(int) to latido_checker;
grant execute on function public.checker_alert_sent(bigint) to latido_checker;
