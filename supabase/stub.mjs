// Postgres real (PGlite) con una imitación mínima de Supabase y todas las migraciones aplicadas.
// Solo para pruebas: npm test
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

export async function createDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id) on delete cascade, status text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('aal', coalesce(nullif(current_setting('request.jwt.claim.aal', true), ''), 'aal1')) $$;
    grant execute on function auth.jwt() to anon, authenticated;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
  `);
  const dir = new URL('./migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  return db;
}
