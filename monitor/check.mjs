// Una comprobación HTTP segura: filtro anti-SSRF en cada salto, conexión a la IP ya validada
// (evita DNS rebinding), máx. 5 redirecciones, timeout corto y sin leer nunca el cuerpo.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';

const { resolveAndCheck, MAX_REDIRECTS } = createRequire(import.meta.url)('../ssrf-guard.js');
const TIMEOUT_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'LatidoMonitor/0.1 (+https://latidouptime.com)';

function request(target) {
  return new Promise(resolve => {
    const lib = target.url.protocol === 'https:' ? https : http;
    const family = target.address.includes(':') ? 6 : 4;
    const req = lib.request(target.url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      // Fuerza la IP validada; el nombre se sigue usando para TLS (SNI) y la cabecera Host
      lookup: (_host, opts, cb) => (opts && opts.all)
        ? cb(null, [{ address: target.address, family }])
        : cb(null, target.address, family)
    }, res => {
      const cert = res.socket.getPeerCertificate?.(); // solo en https; vacío si el servidor no lo envía
      const expires = new Date(cert?.valid_to);
      resolve({ status: res.statusCode, location: res.headers.location, certExpires: isNaN(expires) ? null : expires });
      res.destroy(); // solo nos importan el código, el tiempo y la caducidad del certificado
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Sin respuesta en ${TIMEOUT_MS / 1000} s`)));
    req.on('error', err => resolve({ error: humanError(err) }));
    req.end();
  });
}

function humanError(err) {
  const map = {
    ECONNREFUSED: 'Conexión rechazada por el servidor',
    ECONNRESET: 'El servidor cortó la conexión',
    ENOTFOUND: 'El dominio no existe',
    CERT_HAS_EXPIRED: 'El certificado SSL ha caducado',
    ERR_TLS_CERT_ALTNAME_INVALID: 'El certificado SSL no corresponde a este dominio',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'El certificado SSL es autofirmado',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'El certificado SSL no es de confianza'
  };
  return map[err.code] || err.message || 'Error de conexión';
}

/** Devuelve { ok, status, ms, error, certExpires }. `lookup` se puede inyectar en los tests.
 *  certExpires: la caducidad más próxima entre los certificados https de todos los saltos (o null). */
export async function check(rawUrl, { lookup = dns.lookup } = {}) {
  const start = performance.now();
  let url = rawUrl, certExpires = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await resolveAndCheck(url, lookup);
    if (!target.ok) return { ok: false, status: null, ms: null, error: target.error, certExpires };
    const res = await request(target);
    const ms = Math.round(performance.now() - start);
    if (res.error) return { ok: false, status: null, ms, error: res.error, certExpires };
    if (res.certExpires && (!certExpires || res.certExpires < certExpires)) certExpires = res.certExpires;
    if (REDIRECTS.has(res.status) && res.location) {
      try { url = new URL(res.location, target.url).href; } catch { return { ok: false, status: res.status, ms, error: 'Redirección inválida', certExpires }; }
      continue; // el siguiente salto vuelve a pasar por el filtro anti-SSRF
    }
    const ok = res.status >= 200 && res.status < 400;
    return { ok, status: res.status, ms, error: ok ? null : `El servidor respondió ${res.status}`, certExpires };
  }
  return { ok: false, status: null, ms: Math.round(performance.now() - start), error: `Más de ${MAX_REDIRECTS} redirecciones`, certExpires };
}
