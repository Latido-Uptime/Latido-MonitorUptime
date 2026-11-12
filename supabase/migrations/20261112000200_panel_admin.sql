-- Latido · Panel de administración (latidouptime.com/admin).
-- Quién es administrador lo dice public.admins, que nadie puede leer ni escribir por la API: se añade
-- a mano con SQL. Los datos del panel solo salen por funciones que lo comprueban en el servidor y que
-- exigen una sesión verificada con 2FA (aal2): una contraseña robada no basta para ver a todos los usuarios.
create table public.admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from public, anon, authenticated, service_role;

-- Corta con un mensaje claro si quien llama no es administrador o no entró con su código de 2FA
create function public.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.admins where user_id = (select auth.uid())) then
    raise exception 'No tienes acceso al panel de administración' using errcode = '42501';
  end if;
  if coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'Activa la verificación en dos pasos y entra con tu código para usar el panel de administración' using errcode = '42501';
  end if;
end $$;

-- Resumen: cuánta gente usa Latido y qué hace
create function public.admin_overview() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return json_build_object(
    'cuentas',              (select count(*) from auth.users),
    'cuentas_verificadas',  (select count(*) from auth.users where email_confirmed_at is not null),
    'cuentas_7_dias',       (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'cuentas_30_dias',      (select count(*) from auth.users where created_at > now() - interval '30 days'),
    'activas_7_dias',       (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'con_monitores',        (select count(distinct user_id) from public.monitors),
    'con_2fa',              (select count(distinct user_id) from auth.mfa_factors where status = 'verified'),
    'novedades',            (select count(*) from public.profiles where marketing_opt_in),
    'monitores',            (select count(*) from public.monitors),
    'monitores_caidos',     (select count(*) from public.monitors where state = 'down'),
    'monitores_pausados',   (select count(*) from public.monitors where paused),
    'comprobaciones_24h',   (select count(*) from public.monitor_checks where checked_at > now() - interval '24 hours'),
    'incidencias_abiertas', (select count(*) from public.incidents where ended_at is null),
    'incidencias_7_dias',   (select count(*) from public.incidents where started_at > now() - interval '7 days'),
    'avisos_pendientes',    (select count(*) from public.alert_outbox),
    'planes',               (select coalesce(json_object_agg(plan, n), '{}') from (select plan, count(*) as n from public.profiles group by plan) p),
    'base_de_datos',        pg_size_pretty(pg_database_size(current_database()))
  );
end $$;

-- Las cuentas, de la más nueva a la más antigua
create function public.admin_users()
returns table (id uuid, email text, nombre text, plan text, creada timestamptz, verificada boolean,
               ultimo_acceso timestamptz, monitores int, caidos int, con_2fa boolean, novedades boolean)
language sql stable security definer set search_path = '' as $$
  select public.require_admin();
  select u.id, u.email::text, p.name, p.plan, u.created_at, u.email_confirmed_at is not null, u.last_sign_in_at,
         (select count(*)::int from public.monitors m where m.user_id = u.id),
         (select count(*)::int from public.monitors m where m.user_id = u.id and m.state = 'down'),
         exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified'),
         coalesce(p.marketing_opt_in, false)
  from auth.users u left join public.profiles p on p.id = u.id
  order by u.created_at desc
  limit 500;
$$;

-- Los monitores de todas las cuentas, del más nuevo al más antiguo
create function public.admin_monitors()
returns table (id bigint, cuenta text, nombre text, url text, cliente text, estado text, desde timestamptz,
               intervalo int, pausado boolean, ultima timestamptz, motivo text, ssl_caduca timestamptz, creado timestamptz)
language sql stable security definer set search_path = '' as $$
  select public.require_admin();
  select m.id, u.email::text, m.name, m.url, m.client, m.state, m.state_since, m.interval_seconds, m.paused,
         m.last_checked_at, m.last_error, m.ssl_expires_at, m.created_at
  from public.monitors m join auth.users u on u.id = m.user_id
  order by m.created_at desc
  limit 500;
$$;

revoke execute on function public.require_admin() from public, anon, authenticated;
revoke execute on function public.admin_overview() from public, anon;
revoke execute on function public.admin_users() from public, anon;
revoke execute on function public.admin_monitors() from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_users() to authenticated;
grant execute on function public.admin_monitors() to authenticated;
