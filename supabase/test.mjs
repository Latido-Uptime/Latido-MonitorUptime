// Prueba las migraciones en Postgres real (PGlite) con una imitación mínima de Supabase. npm test
import assert from 'node:assert';
import { createDb } from './stub.mjs';

const db = await createDb();

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

// ---------- Fase 3: comprobaciones ----------
const C = '33333333-3333-3333-3333-333333333333', D = '44444444-4444-4444-4444-444444444444';
await db.query(`insert into auth.users (id, email) values ($1, 'c@x.com'), ($2, 'd@x.com')`, [C, D]);
const mc = (await add(C, 'https://c-web.com')).rows[0].id;
const checker = async (q, params = []) => {
  await db.exec('reset role; set role latido_checker;');
  try { return await db.query(q, params); } finally { await db.exec('reset role'); }
};

// El usuario no puede escribir el estado de su monitor ni llamar a las funciones del comprobador
await fails(C, `update public.monitors set state = 'up' where id = ${mc}`, /permission denied/);
await fails(C, `insert into public.monitors (name, url, interval_seconds, state) values ('x','https://c2.com',300,'up')`, /permission denied/);
await fails(C, 'select * from public.checker_claim(10)', /permission denied/);
await fails(C, `select * from public.checker_report(${mc}, true, 200, 10, null)`, /permission denied/);
await fails(C, 'select * from public.checker_alerts_due(10)', /permission denied/);
await fails(C, 'select public.checker_alert_sent(1)', /permission denied/);
await fails(C, 'select * from public.alert_outbox', /permission denied/);
await as(C, `update public.monitors set name = 'Renombrado' where id = ${mc}`); // sí puede configurar

// El comprobador no puede leer ninguna tabla ni las cuentas
await assert.rejects(checker('select * from public.monitors'), /permission denied/);
await assert.rejects(checker('select * from public.monitor_checks'), /permission denied/);
await assert.rejects(checker('select * from public.alert_outbox'), /permission denied/);
await assert.rejects(checker('select * from public.profiles'), /permission denied/);
await assert.rejects(checker('select email from auth.users'), /permission denied/);

// Reserva: el monitor sale una vez y no vuelve hasta que le toque
assert.deepStrictEqual((await checker('select * from public.checker_claim(10)')).rows.map(r => r.id), [mc]);
assert.strictEqual((await checker('select * from public.checker_claim(10)')).rows.length, 0);

// Avisos solo al cambiar de estado. Van a una cola: el comprobador los recoge y los borra al enviarlos
const report = (ok, status, ms, err) => checker('select * from public.checker_report($1, $2, $3, $4, $5)', [mc, ok, status, ms, err]);
const due = async () => (await checker('select * from public.checker_alerts_due(10)')).rows;
const queued = async () => (await db.query('select alert, attempts from public.alert_outbox')).rows;
const waitSeconds = async () => Number((await db.query('select extract(epoch from next_attempt_at - now()) as s from public.alert_outbox')).rows[0].s);
await report(true, 200, 120, null);
assert.strictEqual((await due()).length, 0);                                          // primera OK: sin aviso
await report(false, null, null, 'El dominio no resuelve');                             // cae
let alertRow = await due();
assert.strictEqual(alertRow[0].alert, 'down'); assert.strictEqual(alertRow[0].email, 'c@x.com');
assert.strictEqual(alertRow[0].monitor_name, 'Renombrado'); assert.strictEqual(alertRow[0].error, 'El dominio no resuelve');
assert.strictEqual((await due()).length, 0);                                          // reservado: no sale dos veces
// Sin confirmar el envío vuelve a salir a 1, 2, 4… min, y nunca más tarde de una hora
assert.ok(Math.abs(await waitSeconds() - 60) < 5);
await db.query('update public.alert_outbox set next_attempt_at = now()'); await due();
assert.ok(Math.abs(await waitSeconds() - 120) < 5);
await db.query('update public.alert_outbox set attempts = 5000, next_attempt_at = now()'); await due(); // sin desbordar 2^n
assert.ok(Math.abs(await waitSeconds() - 3600) < 5);
await report(false, 503, 40, 'El servidor respondió 503');                            // sigue caído: nada nuevo
assert.strictEqual((await queued()).length, 1);
await report(true, 200, 90, null);                                                     // vuelve: sustituye al pendiente
assert.deepStrictEqual(await queued(), [{ alert: 'up', attempts: 0 }]);
alertRow = await due();
assert.strictEqual(alertRow[0].alert, 'up'); assert.ok(alertRow[0].down_minutes >= 1);
await checker('select public.checker_alert_sent($1)', [alertRow[0].id]);
assert.strictEqual((await queued()).length, 0);                                       // enviado: sale de la cola
await report(true, 200, 1, 'x'.repeat(500)); // un error larguísimo se recorta a 200 caracteres, sin fallar

// Incidencias: una por caída, con la comprobación anterior a cada lado (la caída empezó entre
// last_ok_at y started_at, y terminó entre last_fail_at y ended_at). Solo las ve el dueño
const inc = (await as(C, 'select status, error, last_ok_at, started_at, last_fail_at, ended_at from public.incidents')).rows;
assert.strictEqual(inc.length, 1);
assert.strictEqual(inc[0].error, 'El dominio no resuelve'); assert.strictEqual(inc[0].status, null);
assert.ok(inc[0].last_ok_at < inc[0].started_at && inc[0].started_at < inc[0].last_fail_at && inc[0].last_fail_at < inc[0].ended_at);
assert.strictEqual((await as(D, 'select * from public.incidents')).rows.length, 0);
await fails(C, `insert into public.incidents (monitor_id) values (${mc})`, /permission denied/);
await assert.rejects(checker('select * from public.incidents'), /permission denied/);
await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
await assert.rejects(db.query('select * from public.incidents'), /permission denied/);
await db.exec('reset role');

// El dueño ve su estado e historial; otro usuario no ve nada
assert.deepStrictEqual((await as(C, `select state, last_ms from public.monitors where id = ${mc}`)).rows[0], { state: 'up', last_ms: 1 });
assert.strictEqual((await as(C, 'select * from public.monitor_checks')).rows.length, 5);
assert.strictEqual((await as(D, 'select * from public.monitor_checks')).rows.length, 0);

// Historial de 24 h del panel, resumido en el servidor: una fila por monitor, sin chocar con el límite
// de 1000 filas de la API. 45 tramos de 32 min: '1' bien, '0' algún fallo, '.' sin datos
await db.query(`insert into public.monitor_checks (monitor_id, ok, checked_at) values ($1, true, now() - interval '12 hours'), ($1, false, now() - interval '25 hours')`, [mc]);
const [day] = (await as(C, 'select * from public.my_history_24h()')).rows;
assert.strictEqual(day.monitor_id, mc);
assert.strictEqual(day.checks, 6); assert.strictEqual(day.failures, 2); // la de hace 25 h no cuenta
assert.strictEqual(day.slots, '.'.repeat(22) + '1' + '.'.repeat(21) + '0');
assert.strictEqual((await as(D, 'select * from public.my_history_24h()')).rows.length, 0);
await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
await assert.rejects(db.query('select * from public.my_history_24h()'), /permission denied/);
await db.exec('reset role');

// Si el cliente baja de plan, sus informes no quedan bloqueados por los límites
await db.exec(`set role service_role; update public.profiles set plan = 'freelancer' where id = '${C}'; reset role;`);
await as(C, `update public.monitors set interval_seconds = 60 where id = ${mc}`);
await db.exec(`set role service_role; update public.profiles set plan = 'free' where id = '${C}'; reset role;`);
await report(false, 500, 30, 'El servidor respondió 500');
assert.strictEqual((await due())[0].alert, 'down');
assert.deepStrictEqual((await as(C, 'select status, ended_at from public.incidents order by started_at')).rows.map(r => [r.status, r.ended_at === null]), [[null, false], [500, true]]); // otra caída, otra incidencia abierta

// Certificado SSL: aviso a los 14, 7 y 3 días, una sola vez por tramo; uno renovado rearma los avisos
const ssl = days => checker('select public.checker_report($1, true, 200, 50, null, now() + make_interval(days => $2))', [mc, days]);
const sslQueued = async () => (await db.query(`select count(*)::int as n from public.alert_outbox where alert = 'ssl'`)).rows[0].n;
const warned = async () => (await db.query('select ssl_warned_days as w from public.monitors where id = $1', [mc])).rows[0].w;
await ssl(60); assert.strictEqual(await sslQueued(), 0); assert.strictEqual(await warned(), null);
await ssl(10); assert.strictEqual(await warned(), 14);
const sslAlert = (await due()).find(a => a.alert === 'ssl');
assert.strictEqual(sslAlert.email, 'c@x.com'); assert.ok(sslAlert.ssl_expires_at > new Date(Date.now() + 9 * 864e5));
await checker('select public.checker_alert_sent($1)', [sslAlert.id]);
await ssl(9); assert.strictEqual(await sslQueued(), 0);                             // mismo tramo: no se repite
await ssl(5); assert.strictEqual(await warned(), 7); assert.strictEqual(await sslQueued(), 1);
await report(false, 503, 40, 'El servidor respondió 503'); await report(true, 200, 90, null);
assert.strictEqual(await sslQueued(), 1);                                           // caer y volver no lo borra
await checker('select public.checker_report($1, true, 200, 50, null)', [mc]);        // sin dato (http): se conserva
assert.strictEqual(await warned(), 7);
await ssl(90); assert.strictEqual(await warned(), null);                            // renovado: avisos rearmados
assert.ok((await as(C, `select ssl_expires_at from public.monitors where id = ${mc}`)).rows[0].ssl_expires_at > new Date(Date.now() + 80 * 864e5));
await db.query('delete from public.alert_outbox');

// Borrar el monitor borra su historial y sus avisos pendientes; un informe tardío de un monitor borrado no falla
await as(C, `delete from public.monitors where id = ${mc}`);
assert.strictEqual((await db.query('select count(*)::int as n from public.monitor_checks')).rows[0].n, 0);
assert.strictEqual((await queued()).length, 0);
assert.strictEqual((await db.query('select count(*)::int as n from public.incidents')).rows[0].n, 0);
await report(true, 200, 10, null);

// ---------- Fase 4: suscripciones con Paddle ----------
const E = '66666666-6666-6666-6666-666666666666', F = '77777777-7777-7777-7777-777777777777';
await db.query(`insert into auth.users (id, email) values ($1, 'e@x.com'), ($2, 'f@x.com')`, [E, F]);
const AGENCIA_MES = 'pri_01m6xhy9v5yxy38bjhjb29w0ej', FREELANCER_MES = 'pri_01m6xhx0k2jwwrxxgqt4j78sta';
const apply = async (user, status, price, at, extra = {}) => {
  await db.exec('reset role; set role service_role;');
  try {
    return (await db.query('select public.apply_subscription($1, $2, $3, $4, $5, $6, $7, $8) as r',
      [user, extra.sub || 'sub_e', 'ctm_e', status, price, extra.periodEnd || null, extra.cancel || false, at])).rows[0].r;
  } finally { await db.exec('reset role'); }
};
const planOf = async u => (await db.query('select plan from public.profiles where id = $1', [u])).rows[0].plan;

// Con los pagos desactivados ningún precio da un plan; para probar la lógica, los añadimos como si fueran de producción
assert.strictEqual((await db.query('select count(*)::int as n from public.paddle_prices')).rows[0].n, 0);
assert.strictEqual(await apply(E, 'active', AGENCIA_MES, '2026-11-08T08:00:00Z', { sub: 'sub_prueba' }), 'free');
await db.query(`insert into public.paddle_prices (price_id, plan, cycle) values ($1, 'agencia', 'mensual'), ($2, 'freelancer', 'mensual')`, [AGENCIA_MES, FREELANCER_MES]);
await db.query('delete from public.subscriptions');

// Nadie más que el servidor puede aplicar un pago (ni el usuario, ni sin sesión)
await fails(E, `select public.apply_subscription('${E}', 's', 'c', 'active', '${AGENCIA_MES}', null, false, now())`, /permission denied/);
await fails(E, `select * from public.paddle_ids_for('${E}')`, /permission denied/);
await fails(E, `insert into public.subscriptions (user_id, paddle_subscription_id, paddle_customer_id, status, plan, event_at) values ('${E}','s','c','active','agencia',now())`, /permission denied/);

// Contrata Agencia: sube el plan y puede usar sus límites
assert.strictEqual(await apply(E, 'active', AGENCIA_MES, '2026-11-08T10:00:00Z'), 'agencia');
assert.strictEqual(await planOf(E), 'agencia');
for (let i = 0; i < 7; i++) await add(E, `https://e${i}.com`, 30);
// Ve su suscripción; otro usuario no
assert.strictEqual((await as(E, 'select plan, status from public.subscriptions')).rows[0].plan, 'agencia');
assert.strictEqual((await as(F, 'select * from public.subscriptions')).rows.length, 0);

// Un aviso viejo que llega tarde no deshace uno más nuevo
assert.strictEqual(await apply(E, 'canceled', AGENCIA_MES, '2026-11-08T09:00:00Z'), 'ignorado');
assert.strictEqual(await planOf(E), 'agencia');

// Cobro fallido en reintentos: conserva el plan
assert.strictEqual(await apply(E, 'past_due', AGENCIA_MES, '2026-11-08T11:00:00Z'), 'agencia');

// Cancela: vuelve a Gratis, intervalos al mínimo y los monitores que sobran quedan en pausa
assert.strictEqual(await apply(E, 'canceled', AGENCIA_MES, '2026-11-08T12:00:00Z'), 'free');
assert.strictEqual(await planOf(E), 'free');
const after = (await db.query('select interval_seconds, paused from public.monitors where user_id = $1 order by created_at, id', [E])).rows;
assert.ok(after.every(m => m.interval_seconds === 300));
assert.deepStrictEqual(after.map(m => m.paused), [false, false, false, false, false, true, true]);
// El comprobador no reserva los pausados
await db.exec('update public.monitors set last_checked_at = null');
const claimedIds = (await checker('select id from public.checker_claim(200)')).rows.map(r => r.id);
const pausedIds = (await db.query('select id from public.monitors where paused')).rows.map(r => r.id);
assert.ok(pausedIds.length === 2 && pausedIds.every(id => !claimedIds.includes(id)));
// No puede crear otro monitor mientras supere el límite, ni quitarse la pausa
await fails(E, `insert into public.monitors (name, url, interval_seconds) values ('x','https://nuevo-e.com',300)`, /permite 5 monitores/);
await fails(E, 'update public.monitors set paused = false', /permission denied/);

// Vuelve a pagar (Freelancer): se reactivan solos
assert.strictEqual(await apply(E, 'active', FREELANCER_MES, '2026-11-09T10:00:00Z', { sub: 'sub_e2' }), 'freelancer');
assert.ok((await db.query('select bool_and(not paused) as ok from public.monitors where user_id = $1', [E])).rows[0].ok);

// La cancelación de OTRA suscripción no le quita el plan a la que sigue pagada
assert.strictEqual(await apply(E, 'canceled', AGENCIA_MES, '2026-11-09T11:00:00Z', { sub: 'sub_ajena' }), 'ignorado');
assert.strictEqual(await planOf(E), 'freelancer');

// Un precio desconocido nunca regala un plan
assert.strictEqual(await apply(F, 'active', 'pri_falso', '2026-11-09T10:00:00Z', { sub: 'sub_f' }), 'free');
assert.strictEqual(await planOf(F), 'free');

// Borrar la cuenta borra su suscripción
await db.query('delete from auth.users where id = $1', [E]);
assert.strictEqual((await db.query(`select count(*)::int as n from public.subscriptions where user_id = '${E}'`)).rows[0].n, 0);

console.log('migración de cuentas: todos los tests pasan');
