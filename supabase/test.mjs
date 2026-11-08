// Prueba las migraciones en Postgres real (PGlite) con una imitación mínima de Supabase. npm test
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert';

const sql = readdirSync(new URL('./migrations/', import.meta.url)).sort()
  .map(f => readFileSync(new URL('./migrations/' + f, import.meta.url), 'utf8')).join('\n');
const db = new PGlite();

// --- Imitación de Supabase: esquema auth, roles y auth.uid() desde la variable de sesión ---
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
await db.exec(sql);

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'a@x.com','{"name":"Agencia A","marketing":"true"}'), ($2,'b@x.com','{}')`, [A, B]);

async function as(uid, q, params = [], aal = 'aal1') {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); select set_config('request.jwt.claim.aal', '${aal}', false); set role authenticated;`);
  try { return await db.query(q, params); } finally { await db.exec('reset role'); }
}
async function fails(uid, q, re, params) {
  try { await as(uid, q, params); } catch (e) { assert.match(e.message, re); return; }
  assert.fail('debía fallar: ' + q);
}
const add = (uid, url, interval = 300, name = 'm') =>
  as(uid, 'insert into public.monitors (name, url, interval_seconds) values ($1,$2,$3) returning id, host', [name, url, interval]);

// Perfil creado al registrarse, con los datos del registro
const pa = (await as(A, 'select name, plan, marketing_opt_in from public.profiles')).rows;
assert.deepStrictEqual(pa, [{ name: 'Agencia A', plan: 'free', marketing_opt_in: true }]);

// No puede subirse el plan a sí mismo
await fails(A, `update public.profiles set plan = 'agencia' where id = '${A}'`, /permission denied/);
await as(A, `update public.profiles set name = 'Nuevo nombre' where id = '${A}'`);

// Límite de intervalo del plan Gratis
await fails(A, `insert into public.monitors (name, url, interval_seconds) values ('x','https://a.com',30)`, /como mínimo cada 300/);

// Host normalizado y límite de 3 por dominio en la cuenta
assert.strictEqual((await add(A, 'https://Shop.Example.com./x')).rows[0].host, 'shop.example.com');
await add(A, 'https://shop.example.com/y'); await add(A, 'http://shop.example.com:8080/z');
await fails(A, `insert into public.monitors (name, url, interval_seconds) values ('x','https://shop.example.com/w',300)`, /Ya tienes 3 monitores/);

// Límite de monitores del plan Gratis (5)
await add(A, 'https://uno.com'); await add(A, 'https://dos.com');
await fails(A, `insert into public.monitors (name, url, interval_seconds) values ('x','https://tres.com',300)`, /permite 5 monitores/);

// URLs inválidas o con credenciales
await fails(B, `insert into public.monitors (name, url, interval_seconds) values ('x','ftp://a.com',300)`, /monitors_url_check/);
await fails(B, `insert into public.monitors (name, url, interval_seconds) values ('x','https://user:pw@a.com',300)`, /usuario ni contraseña/);

// RLS: B no ve, no edita ni borra los monitores de A, ni puede crearlos a nombre de A (IDOR)
assert.strictEqual((await as(B, 'select * from public.monitors')).rows.length, 0);
assert.strictEqual((await as(B, `update public.monitors set name = 'hack'`)).affectedRows, 0);
assert.strictEqual((await as(B, `delete from public.monitors`)).affectedRows, 0);
await fails(B, `insert into public.monitors (user_id, name, url, interval_seconds) values ('${A}','x','https://b.com',300)`, /row-level security/);
assert.strictEqual((await as(B, 'select * from public.profiles')).rows.length, 1);

// Sin sesión (anon) no se ve nada
await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
await assert.rejects(db.query('select * from public.monitors'), /permission denied/);
await assert.rejects(db.query(`insert into public.monitors (name, url, interval_seconds) values ('x','https://a.com',300)`), /permission denied/);
await db.exec('reset role');

// El servidor (service_role) sí puede cambiar el plan: así lo hará el webhook de Paddle
await db.exec(`set role service_role; update public.profiles set plan = 'agencia' where id = '${A}'; reset role;`);
await add(A, 'https://tres.com', 30);

// No se puede invocar la función interna desde la API
await fails(A, 'select public.handle_new_user()', /permission denied|trigger functions/);

// 2FA: con un factor verificado, una sesión aal1 (solo contraseña) no ve ni toca nada
await db.query(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [A]);
assert.strictEqual((await as(A, 'select * from public.monitors')).rows.length, 0);
assert.strictEqual((await as(A, 'select * from public.profiles')).rows.length, 0);
await fails(A, `insert into public.monitors (name, url, interval_seconds) values ('x','https://cuatro.com',300)`, /row-level security/);
await fails(A, 'select public.delete_my_account()', /2FA/);
assert.ok((await as(A, 'select * from public.monitors', [], 'aal2')).rows.length > 0);
// B sin 2FA sigue funcionando con aal1
await add(B, 'https://b-uno.com');

// Sin sesión no se puede borrar ninguna cuenta
await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
await assert.rejects(db.query('select public.delete_my_account()'), /permission denied/);
await db.exec('reset role');

// Borrar mi cuenta (RGPD) con 2FA verificado: se borran perfil y monitores, y B no se ve afectado
await as(A, 'select public.delete_my_account()', [], 'aal2');
assert.strictEqual((await db.query('select count(*)::int as n from auth.users where id = $1', [A])).rows[0].n, 0);
assert.strictEqual((await as(B, 'select * from public.monitors')).rows.length, 1);

// Borrar la cuenta borra sus datos (RGPD)
await db.query('delete from auth.users where id = $1', [B]);
assert.strictEqual((await db.query('select count(*)::int as n from public.monitors')).rows[0].n, 0);

console.log('migración de cuentas: todos los tests pasan');
