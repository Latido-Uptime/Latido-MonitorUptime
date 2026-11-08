-- Latido · Fase 1: cuentas de usuario, perfiles y monitores.
-- La seguridad vive aquí, no en el navegador:
--   * RLS: cada usuario solo ve y toca sus filas (evita IDOR).
--   * El plan solo lo cambia el servidor (webhook de Paddle con la service_role), nunca el usuario.
--   * Los límites de cada plan se comprueban en un trigger, aunque alguien llame a la API a mano.

-- ---------- Planes ----------
create table public.plans (
  id            text primary key,
  name          text not null,
  max_monitors  int  not null check (max_monitors > 0),
  min_interval  int  not null check (min_interval >= 30)
);
insert into public.plans (id, name, max_monitors, min_interval) values
  ('free',       'Gratis',     5,   300),
  ('freelancer', 'Freelancer', 30,  60),
  ('agencia',    'Agencia',    150, 30);
alter table public.plans enable row level security;
create policy "planes visibles para todos" on public.plans for select using (true);

-- ---------- Perfiles ----------
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  name              text not null default '' check (char_length(name) <= 80),
  plan              text not null default 'free' references public.plans (id),
  marketing_opt_in  boolean not null default false,
  created_at        timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "ver mi perfil" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "editar mi perfil" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- El usuario solo puede cambiar su nombre y su consentimiento de marketing; nunca su plan
revoke update on public.profiles from authenticated, anon;
grant update (name, marketing_opt_in) on public.profiles to authenticated;

-- Crea el perfil al registrarse (los datos llegan de options.data en signUp)
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name, marketing_opt_in)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'name', ''), 80),
    coalesce((new.raw_user_meta_data ->> 'marketing') = 'true', false)
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Monitores ----------
create table public.monitors (
  id                bigint generated always as identity primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 60),
  url               text not null check (char_length(url) <= 2048 and url ~* '^https?://[^/\s]+'),
  host              text not null default '',
  client            text not null default '' check (char_length(client) <= 60),
  interval_seconds  int  not null check (interval_seconds in (30, 60, 300, 900)),
  created_at        timestamptz not null default now()
);
create index monitors_user_idx on public.monitors (user_id);
create index monitors_host_idx on public.monitors (host);
alter table public.monitors enable row level security;
-- Con "Confirm email" activado en Supabase, solo las cuentas verificadas obtienen sesión
create policy "ver mis monitores"    on public.monitors for select to authenticated using ((select auth.uid()) = user_id);
create policy "crear mis monitores"  on public.monitors for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "editar mis monitores" on public.monitors for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "borrar mis monitores" on public.monitors for delete to authenticated using ((select auth.uid()) = user_id);

-- Límites por plan, por cuenta y por dominio entre TODAS las cuentas (anti-abuso)
create function public.enforce_monitor_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p           public.plans;
  own_count   int;
  own_host    int;
  global_host int;
begin
  new.user_id := coalesce(new.user_id, auth.uid());
  -- Un usuario solo opera sobre sus monitores; se rechaza antes de mirar datos ajenos (sin fugas)
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'new row violates row-level security policy for table "monitors"';
  end if;
  new.host := lower(rtrim(substring(new.url from '^[a-zA-Z]+://(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)'), '.'));
  if new.host is null or new.host = '' then raise exception 'URL sin dominio'; end if;
  if new.url ~ '^[a-zA-Z]+://[^/]*@' then raise exception 'La URL no puede llevar usuario ni contraseña'; end if;

  select pl.* into p from public.plans pl join public.profiles pr on pr.plan = pl.id where pr.id = new.user_id;
  if not found then raise exception 'Perfil no encontrado'; end if;
  if new.interval_seconds < p.min_interval then
    raise exception 'Tu plan % permite comprobar como mínimo cada % s', p.name, p.min_interval;
  end if;

  if tg_op = 'INSERT' then
    select count(*) into own_count from public.monitors where user_id = new.user_id;
    if own_count >= p.max_monitors then
      raise exception 'Tu plan % permite % monitores', p.name, p.max_monitors;
    end if;
  end if;

  select count(*) filter (where user_id = new.user_id), count(*) into own_host, global_host
    from public.monitors where host = new.host and id is distinct from new.id;
  if own_host >= 3 then raise exception 'Ya tienes 3 monitores contra %', new.host; end if;
  if global_host >= 20 then raise exception 'Demasiados monitores contra % en Latido', new.host; end if;
  return new;
end $$;
create trigger monitors_limits before insert or update on public.monitors
  for each row execute function public.enforce_monitor_limits();

-- Las funciones internas no se pueden llamar desde la API pública
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.enforce_monitor_limits() from public, anon, authenticated;
