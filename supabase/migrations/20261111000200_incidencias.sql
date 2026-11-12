-- Latido · Incidencias: una fila por caída, para la ficha que la agencia reenvía a su cliente.
-- Guarda la comprobación anterior a cada lado: con comprobaciones cada N min solo sabemos que la
-- caída empezó entre last_ok_at y started_at, y que terminó entre last_fail_at y ended_at.
create table public.incidents (
  id            bigint generated always as identity primary key,
  monitor_id    bigint not null references public.monitors (id) on delete cascade,
  started_at    timestamptz not null default now(), -- primera comprobación fallida (ya confirmada)
  last_ok_at    timestamptz,                        -- última correcta antes; null si nunca respondió
  status        int,
  error         text check (char_length(error) <= 200),
  last_fail_at  timestamptz,                        -- última fallida antes de volver
  ended_at      timestamptz                         -- primera correcta después; null mientras siga caída
);
create index incidents_monitor_idx on public.incidents (monitor_id, started_at desc);
alter table public.incidents enable row level security;
revoke all on public.incidents from anon, authenticated;
grant select on public.incidents to authenticated;
create policy "ver las incidencias de mis monitores" on public.incidents for select to authenticated
  using (exists (select 1 from public.monitors m where m.id = monitor_id and m.user_id = (select auth.uid())));
create policy "2FA obligatorio si está activado" on public.incidents as restrictive
  for all to authenticated using ((select public.mfa_ok()));

-- Las webs que ya estaban caídas antes de esta migración tienen su incidencia abierta
insert into public.incidents (monitor_id, started_at, status, error, last_ok_at)
select m.id, coalesce(m.state_since, now()), m.last_status, m.last_error,
       (select max(c.checked_at) from public.monitor_checks c where c.monitor_id = m.id and c.ok and c.checked_at < m.state_since)
from public.monitors m where m.state = 'down';

-- Guarda un resultado. Si el estado cambia (cae o vuelve), deja el aviso en la cola y abre o cierra la incidencia.
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
end $$;

-- Reserva los monitores a los que les toca comprobación. Mantenimiento: el historial y las
-- incidencias cerradas se guardan 90 días, como dice la política de privacidad.
create or replace function public.checker_claim(batch int default 50)
returns table (id bigint, url text)
language plpgsql security definer set search_path = '' as $$
begin
  if random() < 0.01 then
    delete from public.monitor_checks where checked_at < now() - interval '90 days';
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
