-- Si un usuario activó el 2FA, sus datos solo son accesibles con una sesión verificada con 2FA
-- (aal2), aunque llame a la API directamente con su contraseña robada.
create function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
      or not exists (select 1 from auth.mfa_factors
                     where user_id = (select auth.uid()) and status = 'verified');
$$;
revoke execute on function public.mfa_ok() from public, anon;
grant execute on function public.mfa_ok() to authenticated;

create policy "2FA obligatorio si está activado" on public.monitors as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));
create policy "2FA obligatorio si está activado" on public.profiles as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));

-- Borrar mi cuenta (RGPD): elimina el usuario y, en cascada, su perfil y sus monitores.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  if not public.mfa_ok() then raise exception 'Confirma tu código de 2FA para borrar la cuenta'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
