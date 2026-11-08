// node monitor/test.mjs  (también lo ejecuta npm test)
import assert from 'node:assert';
import postgres from 'postgres';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { check } from './check.mjs';
import { runBatch, alertEmail, alertLimiter } from './run.mjs';
import { createDb } from '../supabase/stub.mjs';

// ---------- Anti-SSRF: nunca se conecta a direcciones internas, ni directas ni vía DNS ----------
for (const u of ['http://127.0.0.1', 'http://localhost:5432', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
  const r = await check(u);
  assert.strictEqual(r.ok, false, u); assert.strictEqual(r.status, null, u);
}
const rebinding = await check('https://parece-publico.example.com', { lookup: async () => [{ address: '10.0.0.5', family: 4 }] });
assert.match(rebinding.error, /interna/);

// Comprobación real (se omite sin internet)
const live = await check('https://example.com');
if (live.error && /resuelve|conexión|ENETUNREACH|EAI_AGAIN/i.test(live.error)) console.log('(sin internet: se omite la prueba real)');
else { assert.strictEqual(live.ok, true, JSON.stringify(live)); assert.ok(live.ms > 0); }

// ---------- Textos de aviso: sin saltos de línea inyectados en el asunto ----------
const down = alertEmail({ alert: 'down', monitor_name: 'Tienda\r\nBcc: x@y.com', monitor_url: 'https://t.com' }, { error: 'El servidor respondió 503' });
assert.ok(!/[\r\n]/.test(down.subject)); assert.match(down.text, /503/);
assert.match(alertEmail({ alert: 'up', monitor_name: 'T', monitor_url: 'https://t.com', down_minutes: 7 }, { status: 200, ms: 90 }).text, /7 min/);

// ---------- Tope de avisos por cuenta y hora ----------
const allow = alertLimiter(2, 1000);
assert.deepStrictEqual([allow('a', 0), allow('a', 1), allow('a', 2), allow('b', 2), allow('a', 1500)], [true, true, false, true, true]);

// ---------- De punta a punta: comprobador real contra Postgres real, con el rol latido_checker ----------
const db = await createDb();
const U = '55555555-5555-5555-5555-555555555555';
await db.query(`insert into auth.users (id, email) values ($1, 'dueno@x.com')`, [U]);
await db.exec(`select set_config('request.jwt.claim.sub', '${U}', false); set role authenticated;
  insert into public.monitors (name, url, interval_seconds) values ('Web OK', 'https://ok.example', 300), ('Web rota', 'https://rota.example', 300);
  reset role;`);
const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
await server.start();
const port = server.server ? server.server.address().port : server.port;
const sql = postgres({ host: '127.0.0.1', port, database: 'postgres', username: 'postgres', max: 1, prepare: false, onnotice: () => {} });
await sql`set role latido_checker`; // a partir de aquí, solo los permisos del comprobador

const fakeCheck = async url => url.includes('rota') ? { ok: false, status: 503, ms: 40, error: 'El servidor respondió 503' } : { ok: true, status: 200, ms: 120, error: null };
const sent = [];
const notify = async (a, r) => { sent.push({ ...a, ...alertEmail(a, r) }); };

assert.strictEqual(await runBatch({ sql, checkFn: fakeCheck, notify, retryDelayMs: 0 }), 2);
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].alert, 'down'); assert.strictEqual(sent[0].email, 'dueno@x.com'); assert.match(sent[0].subject, /Web rota/);
assert.strictEqual(await runBatch({ sql, checkFn: fakeCheck, notify, retryDelayMs: 0 }), 0); // aún no les toca
await assert.rejects(sql`select * from public.monitors`, /permission denied/); // el comprobador no lee tablas

await sql.end(); await server.stop();
await db.exec('reset role'); // PGlite comparte una sola sesión con la conexión de red
const states = (await db.query(`select name, state, last_status from public.monitors order by name`)).rows;
assert.deepStrictEqual(states, [{ name: 'Web OK', state: 'up', last_status: 200 }, { name: 'Web rota', state: 'down', last_status: 503 }]);

console.log('monitor: todos los tests pasan');
