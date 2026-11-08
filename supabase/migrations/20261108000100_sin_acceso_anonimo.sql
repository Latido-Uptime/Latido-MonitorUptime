-- Los visitantes sin sesión no tocan perfiles ni monitores (ni siquiera llegan a los triggers).
revoke all on public.profiles, public.monitors from anon;
