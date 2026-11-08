// Comprobador de Latido. Cada 30 s reserva los monitores a los que les toca, los comprueba
// (filtro anti-SSRF en check.mjs) y guarda el resultado. Si una web cae o vuelve, avisa por email.
// Entra en la base de datos como latido_checker: solo puede llamar a checker_claim y checker_report.
//   node --env-file=.env monitor/run.mjs
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { sendEmail } from './email.mjs';

const TICK_MS = 30_000;
const BATCH = 50;          // monitores por ronda
const CONCURRENCY = 10;    // comprobaciones a la vez
const RETRY_DELAY_MS = 5_000; // una caída se confirma con una segunda comprobación
const ALERTS_PER_HOUR = 20;   // tope de emails por cuenta y hora
const TIME_ZONE = process.env.TIME_ZONE || 'America/Guayaquil';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
const oneLine = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 120);

/** Una ronda: reserva, comprueba y guarda. Devuelve cuántos monitores comprobó. */
export async function runBatch({ sql, checkFn = check, notify, retryDelayMs = RETRY_DELAY_MS }) {
  const due = await sql`select id, url from public.checker_claim(${BATCH})`;
  let next = 0;
  async function lane() {
    while (next < due.length) {
      const m = due[next++];
      try {
        let r = await checkFn(m.url);
        if (!r.ok) { await sleep(retryDelayMs); r = await checkFn(m.url); }
        const alerts = await sql`select * from public.checker_report(${m.id}, ${r.ok}, ${r.status}, ${r.ms}, ${r.error})`;
        for (const a of alerts) await notify(a, r);
      } catch (e) {
        console.error(`monitor ${m.id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, lane));
  return due.length;
}

/** Texto del aviso (solo texto plano: nada que escapar). */
export function alertEmail(a, r, now = new Date()) {
  const name = oneLine(a.monitor_name), url = oneLine(a.monitor_url);
  if (a.alert === 'down') return {
    subject: `🔴 Caída: ${name}`,
    text: `${name} (${url}) no responde desde ${fmt(now)}.\n\nMotivo: ${oneLine(r.error)}\n\nTe avisaremos cuando vuelva.\n\n— Latido · https://latidouptime.com`
  };
  return {
    subject: `🟢 Recuperado: ${name}`,
    text: `${name} (${url}) vuelve a funcionar desde ${fmt(now)} (respuesta ${r.status} en ${r.ms} ms).\n\nEstuvo caído unos ${a.down_minutes} min.\n\n— Latido · https://latidouptime.com`
  };
}

/** Tope de avisos por cuenta y hora, para que un fallo no inunde un buzón ni cueste dinero. */
export function alertLimiter(max = ALERTS_PER_HOUR, windowMs = 3600e3) {
  const sent = new Map();
  return (email, now = Date.now()) => {
    const recent = (sent.get(email) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) { sent.set(email, recent); return false; }
    recent.push(now); sent.set(email, recent); return true;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { DATABASE_URL, RESEND_API_KEY, ALERT_FROM } = process.env;
  const missing = ['DATABASE_URL', 'RESEND_API_KEY', 'ALERT_FROM'].filter(k => !process.env[k]);
  if (missing.length) { console.error('Faltan variables: ' + missing.join(', ')); process.exit(1); }

  // prepare: false porque el pooler de Supabase (modo transacción) no admite sentencias preparadas
  const sql = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 });
  const allow = alertLimiter();
  const notify = async (a, r) => {
    if (!allow(a.email)) { console.warn(`tope de avisos alcanzado para una cuenta (monitor ${oneLine(a.monitor_name)})`); return; }
    try { await sendEmail({ apiKey: RESEND_API_KEY, from: ALERT_FROM, to: a.email, ...alertEmail(a, r) }); }
    catch (e) { console.error(`no se pudo enviar el aviso: ${e.message}`); }
  };

  console.log(`Comprobador de Latido en marcha: una ronda cada ${TICK_MS / 1000} s.`);
  const loop = async () => {
    const t0 = Date.now();
    try {
      const n = await runBatch({ sql, notify });
      if (n) console.log(`${fmt(new Date())}  ${n} monitores comprobados en ${Date.now() - t0} ms`);
    } catch (e) { console.error('ronda fallida:', e.message); }
    setTimeout(loop, Math.max(1000, TICK_MS - (Date.now() - t0)));
  };
  loop();
  const stop = async () => { await sql.end({ timeout: 5 }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
