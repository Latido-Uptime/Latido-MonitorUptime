/* Filtro anti-SSRF de Latido. Script clásico: funciona en el navegador (window.SsrfGuard)
   y en Node (require). En el navegador solo valida la URL y las IPs literales (ayuda de UX);
   la protección real es resolveAndCheck() en el servidor, antes de cada comprobación y tras
   cada redirección, conectando a la IP ya validada (evita DNS rebinding). */
(function (root) {
  'use strict';

  const MAX_REDIRECTS = 5;

  // [red, bits] de IPv4 bloqueadas
  const V4_BLOCKED = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
    ['168.63.129.16', 32], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
  ];

  const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

  function v4ToInt(ip) {
    const p = ip.split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const part of p) {
      if (!/^(0|[1-9]\d{0,2})$/.test(part) || +part > 255) return null;
      n = n * 256 + Number(part);
    }
    return n;
  }

  function isBlockedV4(ip) {
    const n = v4ToInt(ip);
    if (n === null) return true; // formato raro: bloquear
    if (ip === '192.0.0.9' || ip === '192.0.0.10') return false;
    return V4_BLOCKED.some(([net, bits]) => {
      const size = 2 ** (32 - bits);
      const base = v4ToInt(net);
      return n >= base && n < base + size;
    });
  }

  // Expande una IPv6 (sin corchetes) a 8 grupos de 16 bits
  function expandV6(ip) {
    if (ip.includes('%')) return null;
    let s = ip.toLowerCase();
    const v4tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4tail) {
      const n = v4ToInt(v4tail[1]);
      if (n === null) return null;
      s = s.slice(0, -v4tail[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map(g => parseInt(g, 16));
  }

  function isBlockedV6(ip) {
    const g = expandV6(ip);
    if (!g) return true;
    const allZeroUntil = k => g.slice(0, k).every(x => x === 0);
    if (allZeroUntil(8)) return true;                          // ::
    if (allZeroUntil(7) && g[7] === 1) return true;            // ::1
    if (allZeroUntil(5) && g[5] === 0xffff)                    // ::ffff:a.b.c.d (IPv4 mapeada)
      return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    if (allZeroUntil(6)) return true;                         // IPv4 compatible obsoleta ::/96
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // NAT64 local /48
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) // 64:ff9b::/96 (NAT64)
      return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    if ((g[0] & 0xfe00) === 0xfc00) return true;               // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true;               // fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true;               // site-local obsoleta fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true;               // multicast
    if ((g[0] & 0xe000) !== 0x2000) return true;             // solo unicast global (salvo traducciones anteriores)
    if (g[0] === 0x2002 || (g[0] === 0x2001 && g[1] === 0)) return true; // 6to4 y Teredo
    if (g[0] === 0x2001 && (g[1] === 2 || g[1] === 0xdb8)) return true; // pruebas y documentaci?n
    if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // documentaci?n
    return false;
  }

  function isIp(host) {
    return v4ToInt(host) !== null || host.includes(':');
  }

  function isBlockedIp(ip) {
    return ip.includes(':') ? isBlockedV6(ip) : isBlockedV4(ip);
  }

  /** Valida la forma de la URL. Devuelve { ok, error, url }. */
  function checkUrl(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { return { ok: false, error: 'La URL no es válida.' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return { ok: false, error: 'Solo se permiten http y https.' };
    if (u.username || u.password)
      return { ok: false, error: 'La URL no puede llevar usuario ni contraseña.' };
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) return { ok: false, error: 'Falta el dominio.' };
    // El parser WHATWG ya normaliza 2130706433, 0x7f.1 y similares a IPv4 con puntos
    if (isIp(host)) {
      if (isBlockedIp(host)) return { ok: false, error: 'Esa dirección es privada o interna y no se puede monitorizar.' };
    } else if (BLOCKED_HOSTS.test(host) || !host.includes('.')) {
      return { ok: false, error: 'Ese dominio es interno y no se puede monitorizar.' };
    }
    return { ok: true, url: u, host };
  }

  /** Servidor: resuelve el DNS y bloquea si CUALQUIER IP es interna. Llamar antes de cada
      petición y tras cada redirección (máx. MAX_REDIRECTS). Devuelve la IP a la que conectar. */
  async function resolveAndCheck(raw, lookup) {
    const r = checkUrl(raw);
    if (!r.ok) return r;
    let addrs;
    try {
      addrs = isIp(r.host) ? [{ address: r.host }] : await lookup(r.host, { all: true, verbatim: true });
    } catch { return { ok: false, error: 'El dominio no resuelve.' }; }
    if (!Array.isArray(addrs) || !addrs.length) return { ok: false, error: 'El dominio no resuelve.' };
    const bad = addrs.some(a => !a || typeof a.address !== 'string' || isBlockedIp(a.address));
    if (bad) return { ok: false, error: 'El dominio apunta a una dirección interna.' };
    return { ok: true, url: r.url, host: r.host, address: addrs[0].address };
  }

  const api = { checkUrl, isBlockedIp, resolveAndCheck, MAX_REDIRECTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SsrfGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
