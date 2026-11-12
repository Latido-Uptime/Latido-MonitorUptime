// Comprobador de Latido. Cada 30 s reserva los monitores a los que les toca, los comprueba
// (filtro anti-SSRF en check.mjs) y guarda el resultado. Si una web cae o vuelve, la base de datos
// deja el aviso en una cola y otro bucle lo envía por email; si el envío falla, se reintenta.
// Si una web falla y las webs de control tampoco responden, el fallo es de nuestra red y no se marca.
// También guarda la caducidad del certificado SSL, y la base de datos avisa a los 14, 7 y 3 días.
// Entra en la base de datos como latido_checker: solo puede llamar a checker_claim, checker_report,
// checker_alerts_due y checker_alert_sent.
//   node --env-file=.env monitor/run.mjs
// HEARTBEAT_URL (opcional): URL de ping de Healthchecks.io. Se llama tras cada ronda, con /fail si la
// ronda falló, nuestra red no responde o los avisos no salen; si deja de llegar, Healthchecks te avisa a ti.
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { sendEmail } from './email.mjs';

const TICK_MS = 30_000;
const SEND_EVERY_MS = 5_000; // cada cuánto se revisa la cola de avisos
const BATCH = 50;          // monitores por ronda
const CONCURRENCY = 10;    // comprobaciones a la vez
const RETRY_DELAY_MS = 5_000; // una caída se confirma con una segunda comprobación
const ALERTS_PER_HOUR = 20;   // tope de emails por cuenta y hora
const TIME_ZONE = process.env.TIME_ZONE || 'America/Guayaquil';
// Webs de control de Google y Cloudflare, hechas para comprobar conexiones: si fallan las dos, el fallo es nuestro
const CANARIES = ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
const oneLine = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 120);

/** Una ronda: reserva, comprueba y guarda (los avisos quedan en la cola). Un fallo solo se guarda si
 *  alguna web de control responde: si no, la caída es de nuestra red y se avisaría a todos en falso. */
export async function runBatch({ sql, checkFn = check, retryDelayMs = RETRY_DELAY_MS }) {
  const due = await sql`select id, url from public.checker_claim(${BATCH})`;
  let next = 0, canaries, networkDown = false;
  // Las webs de control se consultan como mucho una vez por ronda, y solo si algo falla
  const networkOk = () => (canaries ??= Promise.allSettled(CANARIES.map(u => checkFn(u))).then(rs => rs.some(x => x.value?.ok)));
  async function lane() {
    while (next < due.length) {
      const m = due[next++];
      try {
        let r = await checkFn(m.url);
        if (!r.ok) { await sleep(retryDelayMs); r = await checkFn(m.url); }
        if (!r.ok && !(await networkOk())) { networkDown = true; continue; }
        await sql`select public.checker_report(${m.id}, ${r.ok}, ${r.status}, ${r.ms}, ${r.error}, ${r.certExpires || null})`;
      } catch (e) {
        console.error(`monitor ${m.id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, lane));
  return { checked: due.length, networkDown };
}

/** Envía los avisos de la cola. Uno que falla, o que supera el tope por cuenta, se queda en ella
 *  y la base de datos lo vuelve a entregar más tarde. Devuelve cuántos se enviaron y cuántos fallaron. */
export async function sendDue({ sql, send, allow = () => true }) {
  let sent = 0, failed = 0;
  for (const a of await sql`select * from public.checker_alerts_due(${BATCH})`) {
    if (!allow(a.email)) { console.warn(`tope de avisos alcanzado para una cuenta; se reintentará (monitor ${oneLine(a.monitor_name)})`); continue; }
    try { await send(a); }
    catch (e) { failed++; console.error(`no se pudo enviar el aviso; se reintentará: ${e.message}`); continue; }
    sent++;
    await sql`select public.checker_alert_sent(${a.id})`; // si esto fallara, el aviso se repetiría: mejor repetido que perdido
  }
  return { sent, failed };
}

/** Texto del aviso (solo texto plano: nada que escapar). La hora es la del suceso, no la del envío. */
export function alertEmail(a) {
  const name = oneLine(a.monitor_name), url = oneLine(a.monitor_url), at = fmt(new Date(a.event_at));
  if (a.alert === 'ssl') {
    const days = Math.max(1, Math.round((new Date(a.ssl_expires_at) - new Date(a.event_at)) / 864e5));
    const left = `${days} día${days === 1 ? '' : 's'}`;
    return {
      subject: `⚠️ El certificado SSL de ${name} caduca en ${left}`,
      text: `El certificado SSL de ${name} (${url}) caduca el ${fmt(new Date(a.ssl_expires_at))}, dentro de ${left}.\n\nSi no se renueva antes, los navegadores mostrarán un aviso de seguridad y los visitantes no podrán entrar. Si se renueva solo (por ejemplo, con Let's Encrypt), revisa por qué no lo ha hecho todavía.\n\n— Latido · https://latidouptime.com`
    };
  }
  if (a.alert === 'welcome') return {
    subject: `✅ Latido ya vigila ${name}`,
    text: `${name} (${url}) respondió bien en su primera comprobación (${a.status} en ${a.ms} ms).\n\nAsí te llegarán los avisos: te escribiremos a este email si deja de responder, cuando vuelva y antes de que caduque su certificado SSL. Si este correo llegó a spam, márcalo como «No es spam» para no perderte ninguno.\n\n— Latido · https://latidouptime.com`
  };
  if (a.alert === 'down') return {
    subject: `🔴 Caída: ${name}`,
    text: `${name} (${url}) no responde desde ${at}.\n\nMotivo: ${oneLine(a.error)}\n\nTe avisaremos cuando vuelva.\n\n— Latido · https://latidouptime.com`
  };
  return {
    subject: `🟢 Recuperado: ${name}`,
    text: `${name} (${url}) vuelve a funcionar desde ${at} (respuesta ${a.status} en ${a.ms} ms).\n\nEstuvo caído unos ${a.down_minutes} min.\n\n— Latido · https://latidouptime.com`
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
  const { DATABASE_URL, RESEND_API_KEY, ALERT_FROM, HEARTBEAT_URL } = process.env;
  const missing = ['DATABASE_URL', 'RESEND_API_KEY', 'ALERT_FROM'].filter(k => !process.env[k]);
  if (missing.length) { console.error('Faltan variables: ' + missing.join(', ')); process.exit(1); }

  // prepare: false porque el pooler de Supabase (modo transacción) no admite sentencias preparadas
  const sql = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 });
  const allow = alertLimiter();
  const send = a => sendEmail({ apiKey: RESEND_API_KEY, from: ALERT_FROM, to: a.email, ...alertEmail(a) });
  let emailsOk = true; // resultado del último intento de envío; sigue en false hasta que uno salga bien

  console.log(`Comprobador de Latido en marcha: una ronda cada ${TICK_MS / 1000} s.`);
  const loop = async () => {
    const t0 = Date.now();
    let ok = false;
    try {
      const { checked, networkDown } = await runBatch({ sql });
      if (checked) console.log(`${fmt(new Date())}  ${checked} monitores comprobados en ${Date.now() - t0} ms`);
      if (networkDown) console.warn('Las webs de control tampoco responden: el fallo parece de la red de Latido; esta ronda no marca caídas.');
      ok = !networkDown;
    } catch (e) { console.error('ronda fallida:', e.message); }
    if (HEARTBEAT_URL) fetch(ok && emailsOk ? HEARTBEAT_URL : HEARTBEAT_URL.replace(/\/?$/, '/fail'), { signal: AbortSignal.timeout(10_000) })
      .catch(e => console.warn('señal de vida fallida:', e.message));
    setTimeout(loop, Math.max(1000, TICK_MS - (Date.now() - t0)));
  };
  const sendLoop = async () => {
    try {
      const { sent, failed } = await sendDue({ sql, send, allow });
      if (sent + failed) emailsOk = !failed;
    } catch (e) { console.error('cola de avisos:', e.message); }
    setTimeout(sendLoop, SEND_EVERY_MS);
  };
  loop(); sendLoop();
  const stop = async () => { await sql.end({ timeout: 5 }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
