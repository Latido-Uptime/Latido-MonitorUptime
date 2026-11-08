// Prueba privada de Latido: revisa una web cada N segundos, guarda el historial en SQLite
// y avisa por email cuando se cae y cuando vuelve.
//   node --env-file=.env monitor/run.mjs            vigila sin parar
//   node --env-file=.env monitor/run.mjs --once     una sola comprobación
//   node --env-file=.env monitor/run.mjs --history  muestra el historial
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { check } from './check.mjs';
import { sendEmail } from './email.mjs';

const { checkUrl } = createRequire(import.meta.url)('../ssrf-guard.js');
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('./data.db', import.meta.url));
const CONFIRM_DELAY_MS = 20_000; // una caída se confirma con una segunda comprobación
const MIN_INTERVAL = 60;

/** Lógica pura de transiciones: qué aviso toca enviar. */
export function transition(prev, ok) {
  const next = ok ? 'up' : 'down';
  if (prev === next) return { next, alert: null };
  if (next === 'down') return { next, alert: 'down' };
  return { next, alert: prev === 'down' ? 'up' : null }; // primera comprobación OK: sin aviso
}

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS checks (
             id INTEGER PRIMARY KEY, url TEXT NOT NULL, at TEXT NOT NULL,
             ok INTEGER NOT NULL, status INTEGER, ms INTEGER, error TEXT);
           CREATE TABLE IF NOT EXISTS state (url TEXT PRIMARY KEY, status TEXT NOT NULL, since TEXT NOT NULL);`);
  return db;
}

function config() {
  const env = process.env;
  const errors = [];
  const url = checkUrl(env.MONITOR_URL || '');
  if (!url.ok) errors.push(`MONITOR_URL: ${url.error}`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(env.ALERT_EMAIL || '')) errors.push('ALERT_EMAIL: falta un email válido');
  if (!env.RESEND_API_KEY) errors.push('RESEND_API_KEY: falta la clave de Resend');
  const interval = Number(env.CHECK_INTERVAL_SECONDS || 300);
  if (!(interval >= MIN_INTERVAL)) errors.push(`CHECK_INTERVAL_SECONDS: mínimo ${MIN_INTERVAL}`);
  if (errors.length) { console.error('Configuración incompleta en .env:\n- ' + errors.join('\n- ')); process.exit(1); }
  return { url: url.url.href, to: env.ALERT_EMAIL, apiKey: env.RESEND_API_KEY,
           from: env.ALERT_FROM || 'Latido <onboarding@resend.dev>', interval };
}

const TIME_ZONE = process.env.TIME_ZONE || 'America/Guayaquil'; // los servidores van en UTC
const fmt = iso => new Date(iso).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'medium', timeZone: TIME_ZONE });
const minutesBetween = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));

async function runOnce(cfg, db) {
  let r = await check(cfg.url);
  if (!r.ok) {
    await new Promise(res => setTimeout(res, CONFIRM_DELAY_MS));
    r = await check(cfg.url);
  }
  const at = new Date().toISOString();
  db.prepare('INSERT INTO checks (url, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cfg.url, at, r.ok ? 1 : 0, r.status, r.ms, r.error);

  const prevRow = db.prepare('SELECT status, since FROM state WHERE url = ?').get(cfg.url);
  const { next, alert } = transition(prevRow?.status ?? null, r.ok);
  if (!prevRow || prevRow.status !== next)
    db.prepare('INSERT INTO state (url, status, since) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET status = excluded.status, since = excluded.since')
      .run(cfg.url, next, at);

  console.log(`${fmt(at)}  ${r.ok ? 'OK  ' : 'CAÍDA'}  ${r.status ?? '—'}  ${r.ms ?? '—'} ms  ${r.error ?? ''}`);

  if (alert === 'down') {
    await notify(cfg, `🔴 Caída: ${cfg.url}`,
      `${cfg.url} no responde desde ${fmt(at)}.\n\nMotivo: ${r.error}\n\nTe avisaremos cuando vuelva.\n— Latido`);
  } else if (alert === 'up') {
    await notify(cfg, `🟢 Recuperada: ${cfg.url}`,
      `${cfg.url} vuelve a funcionar desde ${fmt(at)} (respuesta ${r.status} en ${r.ms} ms).\n\nEstuvo caída unos ${minutesBetween(prevRow.since, at)} min.\n— Latido`);
  }
}

async function notify(cfg, subject, text) {
  try { await sendEmail({ apiKey: cfg.apiKey, from: cfg.from, to: cfg.to, subject, text }); console.log(`   aviso enviado a ${cfg.to}`); }
  catch (e) { console.error(`   no se pudo enviar el aviso: ${e.message}`); }
}

function history(db) {
  const rows = db.prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 20').all();
  if (!rows.length) return console.log('Todavía no hay comprobaciones.');
  for (const r of rows.reverse()) console.log(`${fmt(r.at)}  ${r.ok ? 'OK  ' : 'CAÍDA'}  ${r.status ?? '—'}  ${r.ms ?? '—'} ms  ${r.error ?? ''}`);
  for (const [label, hours] of [['24 h', 24], ['7 días', 168], ['30 días', 720]]) {
    const since = new Date(Date.now() - hours * 3600e3).toISOString();
    const { total, up } = db.prepare('SELECT COUNT(*) AS total, SUM(ok) AS up FROM checks WHERE at >= ?').get(since);
    if (total) console.log(`Uptime ${label}: ${(100 * up / total).toFixed(2)} % (${total} comprobaciones)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  if (process.argv.includes('--history')) { history(db); process.exit(0); }
  const cfg = config();
  if (process.argv.includes('--once')) { await runOnce(cfg, db); process.exit(0); }
  console.log(`Vigilando ${cfg.url} cada ${cfg.interval} s. Avisos a ${cfg.to}. Ctrl+C para parar.`);
  // setTimeout encadenado: una comprobación lenta nunca se solapa con la siguiente
  const loop = async () => {
    try { await runOnce(cfg, db); } catch (e) { console.error('Error inesperado:', e.message); }
    setTimeout(loop, cfg.interval * 1000);
  };
  loop();
}
