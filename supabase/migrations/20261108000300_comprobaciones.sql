-- Latido · Fase 3: comprobaciones reales.
-- El comprobador (Fly.io) entra con el rol latido_checker, que SOLO puede ejecutar
-- checker_claim() y checker_report(): no lee tablas, ni cuentas, ni contraseñas.

-- ---------- Estado de cada monitor (solo lo escribe el comprobador) ----------
alter table public.monitors
  add column state           text not null default 'pending' check (state in ('pending', 'up', 'down')),
  add column state_since     timestamptz,
  add column last_checked_at timestamptz,
  add column last_status     int,
  add column last_ms         int,
  add column last_error      text;
create index monitors_due_idx on public.monitors (last_checked_at nulls first);

-- Los límites del plan solo se revisan cuando cambia lo que configura el usuario, no cuando
-- el comprobador guarda un resultado (si no, un cliente que baja de plan bloquearía sus informes)
drop trigger monitors_limits on public.monitors;
create trigger monitors_limits before insert or update of url, interval_seconds, user_id on public.monitors
  for each row execute function public.enforce_monitor_limits();

-- Los usuarios solo pueden escribir los campos que configuran; el estado no
revoke insert, update on public.monitors from authenticated;
grant insert (user_id, name, url, client, interval_seconds) on public.monitors to authenticated;
grant update (name, url, client, interval_seconds) on public.monitors to authenticated;

-- ---------- Historial ----------
create table public.monitor_checks (
  id          bigint generated always as identity primary key,
  monitor_id  bigint not null references public.monitors (id) on delete cascade,
  checked_at  timestamptz not null default now(),
  ok          boolean not null,
  status      int,
  ms          int,
  error       text check (char_length(error) <= 200)
);
create index monitor_checks_monitor_idx on public.monitor_checks (monitor_id, checked_at desc);
alter table public.monitor_checks enable row level security;
revoke all on public.monitor_checks from anon, authenticated;
grant select on public.monitor_checks to authenticated;
create policy "ver el historial de mis monitores" on public.monitor_checks for select to authenticated
  using (exists (select 1 from public.monitors m where m.id = monitor_id and m.user_id = (select auth.uid())));
create policy "2FA obligatorio si está activado" on public.monitor_checks as restrictive
  for all to authenticated using ((select public.mfa_ok()));

-- ---------- Rol del comprobador ----------
-- Se crea sin poder entrar; la contraseña se le pone a mano en el SQL Editor (nunca en el repositorio).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'latido_checker') then
    create role latido_checker nologin noinherit;
  end if;
end $$;
grant usage on schema public to latido_checker;

-- Reserva los monitores a los que les toca comprobación (varios comprobadores no se pisan)
create function public.checker_claim(batch int default 50)
returns table (id bigint, url text)
language plpgsql security definer set search_path = '' as $$
begin
  -- Mantenimiento: el historial se guarda 90 días
  if random() < 0.01 then
    delete from public.monitor_checks where checked_at < now() - interval '90 days';
  end if;
  return query
    with due as (
      select m.id from public.monitors m
      where m.last_checked_at is null
         or m.last_checked_at + make_interval(secs => m.interval_seconds) <= now()
      order by m.last_checked_at nulls first
      limit least(greatest(batch, 1), 200)
      for update skip locked
    )
    update public.monitors m set last_checked_at = now()
    from due where m.id = due.id
    returning m.id, m.url;
end $$;

-- Guarda un resultado. Si el estado cambia (cae o vuelve), devuelve a quién avisar.
create function public.checker_report(p_monitor bigint, p_ok boolean, p_status int, p_ms int, p_error text)
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

  -- Avisos: al caer (aunque sea la primera comprobación) y al volver tras una caída
  if m.state is distinct from nxt and (nxt = 'down' or m.state = 'down') then
    return query
      select nxt, u.email::text, m.name, m.url,
             case when nxt = 'up' then greatest(1, ceil(extract(epoch from now() - m.state_since) / 60))::int end
      from auth.users u where u.id = m.user_id;
  end if;
end $$;

revoke execute on function public.checker_claim(int) from public, anon, authenticated;
revoke execute on function public.checker_report(bigint, boolean, int, int, text) from public, anon, authenticated;
grant execute on function public.checker_claim(int) to latido_checker;
grant execute on function public.checker_report(bigint, boolean, int, int, text) to latido_checker;
