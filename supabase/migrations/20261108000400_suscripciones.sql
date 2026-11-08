-- Latido · Fase 4: suscripciones con Paddle.
-- El plan SOLO lo cambia apply_subscription(), que solo puede llamar el servidor (service_role)
-- desde el receptor de webhooks tras verificar la firma de Paddle. Nunca el navegador.

-- ---------- Precios de Paddle -> plan ----------
create table public.paddle_prices (
  price_id  text primary key,
  plan      text not null references public.plans (id),
  cycle     text not null check (cycle in ('mensual', 'anual'))
);
alter table public.paddle_prices enable row level security;
create policy "precios visibles para todos" on public.paddle_prices for select using (true);
-- Sandbox (pruebas). Los de producción se añaden en otra migración al activar la cuenta real.
insert into public.paddle_prices (price_id, plan, cycle) values
  ('pri_01m6xhx0k2jwwrxxgqt4j78sta', 'freelancer', 'mensual'),
  ('pri_01m6xj127v637ye8sc91x0bk6q', 'freelancer', 'anual'),
  ('pri_01m6xhy9v5yxy38bjhjb29w0ej', 'agencia',    'mensual'),
  ('pri_01m6xj00pa6ksr2k16qgq56c1e', 'agencia',    'anual');

-- ---------- Suscripciones (solo lectura para su dueño) ----------
create table public.subscriptions (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  paddle_subscription_id  text not null unique,
  paddle_customer_id      text not null,
  status                  text not null,
  price_id                text,
  plan                    text not null references public.plans (id),
  current_period_end      timestamptz,
  scheduled_cancel        boolean not null default false,
  event_at                timestamptz not null, -- para ignorar webhooks que llegan desordenados
  updated_at              timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
create policy "ver mi suscripción" on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "2FA obligatorio si está activado" on public.subscriptions as restrictive
  for all to authenticated using ((select public.mfa_ok()));

-- ---------- Monitores en pausa (al bajar de plan) ----------
alter table public.monitors add column paused boolean not null default false;

-- El comprobador se salta los monitores en pausa
create or replace function public.checker_claim(batch int default 50)
returns table (id bigint, url text)
language plpgsql security definer set search_path = '' as $$
begin
  if random() < 0.01 then
    delete from public.monitor_checks where checked_at < now() - interval '90 days';
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
revoke execute on function public.checker_claim(int) from public, anon, authenticated;
grant execute on function public.checker_claim(int) to latido_checker;

-- Límites del plan: el servidor puede saltarlos solo al ajustar tras un cambio de plan
create or replace function public.enforce_monitor_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p           public.plans;
  own_count   int;
  own_host    int;
  global_host int;
begin
  -- Ajuste hecho por el servidor al cambiar de plan (fit_monitors_to_plan)
  if current_setting('latido.server_fit', true) = 'on' then return new; end if;
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
revoke execute on function public.enforce_monitor_limits() from public, anon, authenticated;

-- Ajusta los monitores de un usuario a los límites de su plan actual:
-- intervalos al mínimo permitido, los más antiguos activos y el resto en pausa.
create function public.fit_monitors_to_plan(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.plans;
begin
  select pl.* into p from public.plans pl join public.profiles pr on pr.plan = pl.id where pr.id = p_user;
  if not found then return; end if;
  -- Es el servidor ajustando, no el usuario configurando: el trigger de límites no aplica.
  -- La marca es local a esta transacción y la API pública no permite fijarla.
  perform set_config('latido.server_fit', 'on', true);
  update public.monitors set interval_seconds = p.min_interval
    where user_id = p_user and interval_seconds < p.min_interval;
  perform set_config('latido.server_fit', 'off', true);
  update public.monitors m set paused = (r.n > p.max_monitors)
    from (select id, row_number() over (order by created_at, id) as n
          from public.monitors where user_id = p_user) r
    where m.id = r.id and m.paused is distinct from (r.n > p.max_monitors);
end $$;

-- Aplica un evento de suscripción de Paddle (ya verificado por el receptor de webhooks).
-- Devuelve el plan resultante o 'ignorado' si el evento es más antiguo que el último aplicado.
create function public.apply_subscription(
  p_user uuid, p_subscription text, p_customer text, p_status text,
  p_price text, p_period_end timestamptz, p_scheduled_cancel boolean, p_event_at timestamptz
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  prev     public.subscriptions;
  new_plan text;
begin
  if p_user is null or p_subscription is null or p_event_at is null then
    raise exception 'Evento de suscripción incompleto';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then return 'usuario inexistente'; end if;

  select * into prev from public.subscriptions where user_id = p_user for update;
  if found and prev.event_at > p_event_at and prev.paddle_subscription_id = p_subscription then
    return 'ignorado';
  end if;
  -- Una suscripción distinta que se cancela no puede quitarle el plan a una que sigue pagada
  -- (evita que alguien pague "a nombre" de otro usuario y luego cancele para dejarlo sin plan)
  if found and prev.paddle_subscription_id <> p_subscription
     and prev.status in ('active', 'trialing', 'past_due')
     and p_status not in ('active', 'trialing', 'past_due') then
    return 'ignorado';
  end if;

  -- Con el pago al día (o en reintentos de cobro) se mantiene el plan; si no, Gratis
  select case when p_status in ('active', 'trialing', 'past_due') then pp.plan else 'free' end
    into new_plan from public.paddle_prices pp where pp.price_id = p_price;
  new_plan := coalesce(new_plan, 'free'); -- precio desconocido: nunca regala un plan

  insert into public.subscriptions as s (user_id, paddle_subscription_id, paddle_customer_id, status,
                                         price_id, plan, current_period_end, scheduled_cancel, event_at, updated_at)
  values (p_user, p_subscription, p_customer, p_status, p_price, new_plan, p_period_end,
          coalesce(p_scheduled_cancel, false), p_event_at, now())
  on conflict (user_id) do update set
    paddle_subscription_id = excluded.paddle_subscription_id, paddle_customer_id = excluded.paddle_customer_id,
    status = excluded.status, price_id = excluded.price_id, plan = excluded.plan,
    current_period_end = excluded.current_period_end, scheduled_cancel = excluded.scheduled_cancel,
    event_at = excluded.event_at, updated_at = now();

  update public.profiles set plan = new_plan where id = p_user;
  perform public.fit_monitors_to_plan(p_user);
  return new_plan;
end $$;

-- Para el portal de cliente (cancelar en un clic): datos de Paddle de un usuario
create function public.paddle_ids_for(p_user uuid)
returns table (paddle_customer_id text, paddle_subscription_id text)
language sql stable security definer set search_path = '' as $$
  select paddle_customer_id, paddle_subscription_id from public.subscriptions where user_id = p_user;
$$;

revoke execute on function public.fit_monitors_to_plan(uuid) from public, anon, authenticated;
revoke execute on function public.apply_subscription(uuid, text, text, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
revoke execute on function public.paddle_ids_for(uuid) from public, anon, authenticated;
grant execute on function public.apply_subscription(uuid, text, text, text, text, timestamptz, boolean, timestamptz) to service_role;
grant execute on function public.paddle_ids_for(uuid) to service_role;

-- El plan Gratis ya no deja crear un monitor más mientras haya alguno en pausa por exceso:
-- el conteo del trigger de límites incluye los pausados, así que se mantiene igual.
