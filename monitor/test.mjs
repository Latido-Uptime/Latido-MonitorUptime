// node monitor/test.mjs  (también lo ejecuta npm test)
import assert from 'node:assert';
import postgres from 'postgres';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { check } from './check.mjs';
import { runBatch, sendDue, alertEmail, alertLimiter } from './run.mjs';
import { createDb } from '../supabase/stub.mjs';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const { errorPage } = createRequire(import.meta.url)('../errores.js');

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
else { assert.strictEqual(live.ok, true, JSON.stringify(live)); assert.ok(live.ms > 0); assert.ok(live.certExpires > new Date()); }

// ---------- Textos de aviso: sin saltos de línea inyectados en el asunto, con la hora del suceso ----------
const at = new Date('2026-11-08T14:00:00Z');
const down = alertEmail({ alert: 'down', monitor_name: 'Tienda\r\nBcc: x@y.com', monitor_url: 'https://t.com', status: 503, error: 'El servidor respondió 503', event_at: at });
assert.ok(!/[\r\n]/.test(down.subject)); assert.match(down.text, /503/);
assert.match(down.text, /Qué significa y qué revisar: https:\/\/latidouptime\.com\/errores\/error-503\n/);

// ---------- Cada fallo enlaza a su página de /errores, y la página existe ----------
const fallos = [[500, 'El servidor respondió 500', 'error-500'], [520, 'El servidor respondió 520', 'error-500'], [502, '', 'error-502'],
  [503, '', 'error-503'], [504, '', 'error-504'], [403, '', 'error-403'], [429, '', 'error-403'],
  [null, 'El certificado SSL ha caducado', 'certificado-ssl'], [null, 'El certificado SSL no corresponde a este dominio', 'certificado-ssl'],
  [null, 'El dominio no resuelve.', 'dominio-no-resuelve'], [null, 'Conexión rechazada por el servidor', 'conexion-rechazada'],
  [null, 'El servidor cortó la conexión', 'conexion-rechazada'], [null, 'Sin respuesta en 10 s', 'sin-respuesta'],
  [null, 'Más de 5 redirecciones', 'demasiadas-redirecciones'], [404, 'El servidor respondió 404', null]];
for (const [status, error, slug] of fallos) {
  assert.strictEqual(errorPage(status, error), slug, `${status} ${error}`);
  if (slug) assert.ok(existsSync(new URL(`../errores/${slug}.html`, import.meta.url)), `falta la página ${slug}`);
}
assert.ok(down.text.includes(at.toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TIME_ZONE || 'America/Guayaquil' })));
assert.match(alertEmail({ alert: 'up', monitor_name: 'T', monitor_url: 'https://t.com', down_minutes: 7, status: 200, ms: 90, event_at: at }).text, /7 min/);
const sslMail = alertEmail({ alert: 'ssl', monitor_name: 'T', monitor_url: 'https://t.com', event_at: at, ssl_expires_at: new Date(at.getTime() + 864e5) });
assert.match(sslMail.subject, /SSL de T caduca en 1 día$/); assert.match(sslMail.text, /dentro de 1 día\./);

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
assert.deepStrictEqual(await runBatch({ sql, checkFn: fakeCheck, retryDelayMs: 0 }), { checked: 2, networkDown: false });

// Esperan en la cola el aviso de "Web rota" y el email de prueba de "Web OK" (la primera web de la
// cuenta que responde bien). Si Resend falla o se llega al tope, no se pierden
const sent = [];
const ok = async a => { sent.push({ ...a, ...alertEmail(a) }); };
const failing = async () => { throw new Error('Resend respondió 429'); };
const later = async () => { await sql`reset role`; await sql`update public.alert_outbox set next_attempt_at = now()`; await sql`set role latido_checker`; };
assert.deepStrictEqual(await sendDue({ sql, send: failing }), { sent: 0, failed: 2 });
assert.deepStrictEqual(await sendDue({ sql, send: ok }), { sent: 0, failed: 0 }); // esperan su reintento
await later();
assert.deepStrictEqual(await sendDue({ sql, send: ok, allow: () => false }), { sent: 0, failed: 0 }); // el tope los aplaza
await later();
assert.deepStrictEqual(await sendDue({ sql, send: ok }), { sent: 2, failed: 0 });
const downMail = sent.find(s => s.alert === 'down'), hello = sent.find(s => s.alert === 'welcome');
assert.strictEqual(downMail.email, 'dueno@x.com'); assert.match(downMail.subject, /Web rota/); assert.match(downMail.text, /503/);
assert.strictEqual(hello.subject, '✅ Latido ya vigila Web OK'); assert.match(hello.text, /\(200 en 120 ms\)/);
await later();
assert.deepStrictEqual(await sendDue({ sql, send: ok }), { sent: 0, failed: 0 }); // enviado: ya no está en la cola

assert.deepStrictEqual(await runBatch({ sql, checkFn: fakeCheck, retryDelayMs: 0 }), { checked: 0, networkDown: false }); // aún no les toca

// Si tampoco responden las webs de control, el fallo es de nuestra red: no se marca ninguna caída
const asked = [];
const allDown = async url => { asked.push(url); return { ok: false, status: null, ms: null, error: 'Sin respuesta en 10 s' }; };
await sql`reset role`; await sql`update public.monitors set last_checked_at = null`; await sql`set role latido_checker`;
assert.deepStrictEqual(await runBatch({ sql, checkFn: allDown, retryDelayMs: 0 }), { checked: 2, networkDown: true });
assert.strictEqual(asked.filter(u => !u.endsWith('.example')).length, 2); // las dos webs de control, una sola vez
assert.deepStrictEqual(await sendDue({ sql, send: ok }), { sent: 0, failed: 0 }); // ningún aviso en falso

// El certificado de "Web OK" caduca en 5 días: el comprobador lo guarda y llega el aviso
await sql`reset role`; await sql`update public.monitors set last_checked_at = null`; await sql`set role latido_checker`;
const soon = new Date(Date.now() + 5 * 864e5);
await runBatch({ sql, checkFn: async url => ({ ...(await fakeCheck(url)), certExpires: url.includes('//ok.') ? soon : null }), retryDelayMs: 0 });
sent.length = 0;
assert.deepStrictEqual(await sendDue({ sql, send: ok }), { sent: 1, failed: 0 });
assert.match(sent[0].subject, /SSL de Web OK caduca en 5 días/);
await assert.rejects(sql`select * from public.monitors`, /permission denied/); // el comprobador no lee tablas
await assert.rejects(sql`select * from public.alert_outbox`, /permission denied/);

await sql.end(); await server.stop();
await db.exec('reset role'); // PGlite comparte una sola sesión con la conexión de red
const states = (await db.query(`select name, state, last_status from public.monitors order by name`)).rows;
assert.deepStrictEqual(states, [{ name: 'Web OK', state: 'up', last_status: 200 }, { name: 'Web rota', state: 'down', last_status: 503 }]);

console.log('monitor: todos los tests pasan');
