// Genera las páginas de /errores (una por cada fallo que explica Latido), su índice y sitemap.xml.
// Son HTML estáticos para que Google los indexe: las rutas #/ de la web no se indexan.
// Los nombres deben coincidir con errores.js. Después de editar el contenido:
//   node scripts/paginas-errores.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const SITE = 'https://latidouptime.com';

// Texto con `código` entre comillas invertidas; todo lo demás se escapa
const PAGES = [
  {
    slug: 'error-500',
    title: 'Error 500 (Internal Server Error): qué significa y qué revisar',
    h1: 'Error 500: el servidor falló al generar la página',
    description: 'Qué significa el error 500 Internal Server Error, sus causas más habituales (plugins, .htaccess, PHP, base de datos) y qué revisar primero para recuperar la web.',
    intro: 'El servidor recibió la petición, pero algo falló al generar la página. Es un error genérico del lado del servidor: no depende del navegador ni de la conexión del visitante, y suele aparecer justo después de un cambio.',
    causes: [
      'Un error en el código tras una actualización: un plugin, un tema o un despliegue nuevo.',
      'Una regla mal escrita en el archivo `.htaccess`.',
      'PHP sin memoria suficiente (`memory_limit`) o una versión de PHP que el sitio no soporta.',
      'La base de datos no responde o sus credenciales cambiaron.',
      'Detrás de Cloudflare, los errores del 520 al 526 indican un problema entre Cloudflare y tu servidor: caído, sin aceptar conexiones o con un certificado no válido.'
    ],
    checks: [
      'Abre el registro de errores del servidor (`error_log` o los logs del panel del hosting): casi siempre dice qué archivo y qué línea fallan.',
      'Deshaz lo último que cambió: la actualización de un plugin o un tema, o el último despliegue.',
      'Renombra temporalmente `.htaccess` para descartar una regla rota.',
      'Revisa el límite de memoria y la versión de PHP en el panel del hosting.',
      'En WordPress, activa `WP_DEBUG_LOG` y desactiva los plugins para encontrar el culpable.'
    ],
    latido: 'El servidor respondió 500'
  },
  {
    slug: 'error-502',
    title: 'Error 502 Bad Gateway: qué significa y qué revisar',
    h1: 'Error 502 Bad Gateway: el intermediario recibió una respuesta inválida',
    description: 'Qué significa el error 502 Bad Gateway, por qué aparece con Nginx, PHP-FPM o Cloudflare y qué revisar primero para que la web vuelva.',
    intro: 'Entre el visitante y tu web suele haber un servidor intermedio: Nginx delante de PHP, un balanceador o una CDN como Cloudflare. El 502 significa que ese intermediario pidió la página al servidor de origen y recibió una respuesta inválida o ninguna.',
    causes: [
      'El proceso que genera la página (PHP-FPM, Node, Apache) está caído, reiniciándose o bloqueado.',
      'El servidor se quedó sin memoria y el sistema cerró ese proceso.',
      'El intermediario apunta a una dirección o a un puerto que ya no corresponden al servidor.',
      'Un firewall del servidor de origen bloquea al intermediario, por ejemplo a las IPs de Cloudflare.'
    ],
    checks: [
      'Comprueba que el servicio de la aplicación (PHP-FPM, Node…) está en marcha y reinícialo.',
      'Lee el registro de errores del intermediario (por ejemplo, el `error.log` de Nginx): dice qué falló al contactar con el origen.',
      'Revisa el consumo de memoria y CPU del servidor.',
      'Si usas Cloudflare, confirma que el servidor de origen responde directamente y que su firewall permite las IPs de Cloudflare.'
    ],
    latido: 'El servidor respondió 502'
  },
  {
    slug: 'error-503',
    title: 'Error 503 Service Unavailable: qué significa y qué revisar',
    h1: 'Error 503: la web no está disponible temporalmente',
    description: 'Qué significa el error 503 Service Unavailable, sus causas (sobrecarga, mantenimiento, límites del hosting, protección anti-bots) y qué revisar primero.',
    intro: 'El servidor está activo, pero en este momento no puede atender la petición. Suele ser temporal: está sobrecargado, en mantenimiento o limitado por el hosting.',
    causes: [
      'Un pico de tráfico o los recursos del plan agotados: CPU, memoria o número de procesos.',
      'Modo mantenimiento: en WordPress, una actualización que se corta deja un archivo `.maintenance` que mantiene la web en 503.',
      'El hosting limitó o suspendió temporalmente la cuenta por consumo.',
      'Una protección anti-bots que responde 503 a las visitas automáticas, como un desafío de Cloudflare.'
    ],
    checks: [
      'Mira el panel del hosting: uso de recursos y avisos de límite o de suspensión.',
      'En WordPress, busca un archivo `.maintenance` en la raíz y bórralo si la actualización ya terminó.',
      'Revisa los registros del servidor a la hora de la caída.',
      'Si la web carga en tu navegador pero el monitor ve un 503, revisa la protección anti-bots: puede estar bloqueando las comprobaciones.'
    ],
    latido: 'El servidor respondió 503'
  },
  {
    slug: 'error-504',
    title: 'Error 504 Gateway Timeout: qué significa y qué revisar',
    h1: 'Error 504 Gateway Timeout: el servidor tardó demasiado en responder',
    description: 'Qué significa el error 504 Gateway Timeout, por qué el servidor de origen no responde a tiempo y qué revisar primero: consultas lentas, carga y tiempos de espera.',
    intro: 'El servidor intermedio (Nginx, un balanceador o una CDN) esperó al servidor de origen y este no contestó a tiempo. La web no está necesariamente caída, pero tarda tanto que el intermediario se rinde.',
    causes: [
      'Consultas lentas a la base de datos o scripts pesados que tardan más de lo permitido.',
      'Un servidor saturado por tráfico, tareas programadas o copias de seguridad.',
      'Problemas de red entre el intermediario y el servidor de origen.',
      'Tiempos de espera demasiado cortos en la configuración del intermediario.'
    ],
    checks: [
      'Mide cuánto tarda la página en el servidor de origen y busca consultas lentas.',
      'Revisa la carga del servidor a la hora de la caída: CPU, memoria y tareas programadas.',
      'Lee los registros del intermediario y del servidor de origen.',
      'Si esas páginas lentas son normales, ajusta los tiempos de espera (por ejemplo, `proxy_read_timeout` o `fastcgi_read_timeout` en Nginx).'
    ],
    latido: 'El servidor respondió 504'
  },
  {
    slug: 'error-403',
    title: 'Error 403 Forbidden: qué significa y por qué puede bloquear a tu monitor',
    h1: 'Error 403 Forbidden: el servidor se niega a mostrar la página',
    description: 'Qué significa el error 403 Forbidden, cuándo es un bloqueo del firewall o de la protección anti-bots y no una caída, y qué revisar primero.',
    intro: 'El servidor entendió la petición, pero no quiere servirla. Para un monitor de uptime hay un caso frecuente: la web funciona para tus visitantes y lo que hay es un firewall o una protección anti-bots que bloquea las comprobaciones automáticas.',
    causes: [
      'Un firewall o una protección anti-bots (Cloudflare, Wordfence, ModSecurity, Imunify360) que bloquea robots o IPs de centros de datos.',
      'Permisos de archivos o de carpetas incorrectos.',
      'Una regla en `.htaccess` o en la configuración del servidor que deniega el acceso.',
      'Restricciones por país o por IP.',
      'Si el código es 401, la página pide usuario y contraseña; si es 429, el servidor está limitando las peticiones.'
    ],
    checks: [
      'Abre la web desde tu navegador: si carga, revisa el firewall y permite las comprobaciones de Latido, que se identifican como `LatidoMonitor`.',
      'Revisa los permisos: lo habitual es 644 para archivos y 755 para carpetas.',
      'Busca reglas que denieguen el acceso o restricciones de IP en `.htaccess` y en la configuración del servidor.',
      'Si el 403 empezó al activar un plugin de seguridad, revisa su registro de bloqueos.'
    ],
    latido: 'El servidor respondió 403'
  },
  {
    slug: 'certificado-ssl',
    title: 'Certificado SSL caducado o no válido: qué significa y cómo solucionarlo',
    h1: 'Certificado SSL caducado o no válido',
    description: 'Por qué el navegador muestra «La conexión no es privada» (NET::ERR_CERT_DATE_INVALID), por qué falla la renovación automática del certificado SSL y qué revisar primero.',
    intro: 'El navegador no puede confirmar que la conexión es segura y muestra «La conexión no es privada»: `NET::ERR_CERT_DATE_INVALID` si el certificado caducó, `NET::ERR_CERT_COMMON_NAME_INVALID` si es de otro dominio. Casi ningún visitante pasa de ese aviso, así que para ellos la web está caída.',
    causes: [
      'La renovación automática falló: el DNS dejó de apuntar al servidor, se cambió de hosting o la tarea de renovación se detuvo.',
      'Un certificado de pago que nadie renovó a tiempo.',
      'El certificado instalado no cubre ese nombre: falta el `www` o un subdominio.',
      'Un certificado autofirmado o instalado sin su cadena intermedia completa.'
    ],
    checks: [
      'Pulsa el candado del navegador y mira la fecha de caducidad y los dominios que cubre.',
      'Revisa el registro de la renovación automática: AutoSSL o Let\'s Encrypt en el panel del hosting, o `certbot renew --dry-run` en tu servidor.',
      'Comprueba que el DNS del dominio y del `www` apuntan al servidor que emite el certificado.',
      'Instala el certificado con su cadena intermedia completa.'
    ],
    latido: 'El certificado SSL ha caducado',
    extra: 'Además, Latido lee la caducidad del certificado en cada comprobación y te avisa 14, 7 y 3 días antes de que caduque, para que lo renueves antes de que nadie vea el aviso.'
  },
  {
    slug: 'dominio-no-resuelve',
    title: 'El dominio no resuelve (DNS_PROBE_FINISHED_NXDOMAIN): qué significa y qué revisar',
    h1: 'El dominio no resuelve: para internet, la web no existe',
    description: 'Qué significa DNS_PROBE_FINISHED_NXDOMAIN o «el dominio no resuelve»: dominio caducado, DNS mal configurado o nameservers cambiados. Qué revisar primero.',
    intro: 'El DNS no devuelve ninguna dirección para el dominio, así que nadie puede llegar a la web: el navegador muestra `DNS_PROBE_FINISHED_NXDOMAIN` o «No se puede acceder a este sitio». Si el dominio caducó, también deja de funcionar su correo.',
    causes: [
      'El dominio caducó y no se renovó: es la causa más grave y una de las más frecuentes.',
      'Se borró o se editó mal un registro DNS (A, AAAA o CNAME).',
      'Se cambiaron los nameservers (por ejemplo, al pasar a Cloudflare) sin copiar todos los registros.',
      'El registrador suspendió el dominio porque el titular no verificó su email.',
      'El dominio apunta a una dirección privada o interna.'
    ],
    checks: [
      'Revisa en el registrador la fecha de caducidad del dominio y si está suspendido.',
      'Comprueba qué nameservers tiene configurados el dominio.',
      'Revisa los registros A o CNAME del dominio y del `www`.',
      'Busca en el email del titular avisos del registrador pendientes de verificar.'
    ],
    latido: 'El dominio no resuelve'
  },
  {
    slug: 'conexion-rechazada',
    title: 'Conexión rechazada (ERR_CONNECTION_REFUSED): qué significa y qué revisar',
    h1: 'Conexión rechazada: el servidor no acepta conexiones',
    description: 'Qué significa ERR_CONNECTION_REFUSED o una conexión rechazada: el servidor web está parado, un firewall bloquea el puerto o el DNS apunta a un servidor antiguo.',
    intro: 'La dirección del servidor responde, pero nadie acepta la conexión en el puerto de la web: el 80 para http o el 443 para https. Normalmente el servidor web no está en marcha o un firewall rechaza la conexión. El navegador lo muestra como `ERR_CONNECTION_REFUSED`.',
    causes: [
      'El servidor web (Nginx, Apache) está parado o no arrancó tras un reinicio.',
      'Un error en su configuración le impide arrancar.',
      'Un firewall bloquea los puertos 80 o 443.',
      'El DNS apunta a la IP de un servidor antiguo que ya no aloja la web.',
      'El servidor cortó la conexión a medias por un fallo o un reinicio.'
    ],
    checks: [
      'Comprueba que el servidor web está en marcha y revisa sus registros de arranque.',
      'Revisa el firewall del servidor y el del proveedor: los puertos 80 y 443 deben estar abiertos.',
      'Confirma que la IP del DNS es la del servidor actual.'
    ],
    latido: 'Conexión rechazada por el servidor'
  },
  {
    slug: 'sin-respuesta',
    title: 'La web no responde (ERR_CONNECTION_TIMED_OUT): qué significa y qué revisar',
    h1: 'La web no responde: se agotó el tiempo de espera',
    description: 'Qué significa ERR_CONNECTION_TIMED_OUT o una web que no responde: servidor apagado, saturado o un firewall que descarta las conexiones. Qué revisar primero.',
    intro: 'El servidor no contestó nada en el tiempo de espera. A diferencia de una conexión rechazada, aquí no llega ninguna respuesta: el servidor está apagado, colgado o saturado, o algo en el camino descarta las conexiones. El navegador lo muestra como `ERR_CONNECTION_TIMED_OUT`.',
    causes: [
      'El servidor está apagado o colgado.',
      'Está saturado: CPU o memoria al límite por tráfico, tareas pesadas o un ataque.',
      'Un firewall descarta las conexiones sin avisar.',
      'Un problema de red en el proveedor del servidor.'
    ],
    checks: [
      'Entra en la consola del proveedor y comprueba que el servidor está encendido y responde.',
      'Revisa el consumo de CPU y memoria a la hora de la caída.',
      'Revisa las reglas del firewall.',
      'Consulta la página de estado del proveedor por si hay una incidencia general.'
    ],
    latido: 'Sin respuesta en 10 s'
  },
  {
    slug: 'demasiadas-redirecciones',
    title: 'Demasiadas redirecciones (ERR_TOO_MANY_REDIRECTS): qué significa y cómo arreglarlo',
    h1: 'Demasiadas redirecciones: la web entra en un bucle',
    description: 'Por qué aparece ERR_TOO_MANY_REDIRECTS: el SSL «Flexible» de Cloudflare, reglas de redirección que se contradicen o las URLs de WordPress. Qué revisar primero.',
    intro: 'La web redirige a otra dirección que vuelve a redirigir, en bucle, hasta que el navegador se rinde con `ERR_TOO_MANY_REDIRECTS`. Latido sigue como mucho 5 redirecciones antes de dar la web por caída.',
    causes: [
      'Cloudflare en modo SSL «Flexible» con un servidor que fuerza https: Cloudflare pide por http, el servidor redirige a https, y así sin fin.',
      'Reglas de redirección que se contradicen en `.htaccess` o en Nginx, por ejemplo con `www` y sin `www`.',
      'En WordPress, la dirección del sitio no coincide con la redirección del servidor.',
      'Dos plugins de redirección o de SSL que se pisan.'
    ],
    checks: [
      'Si usas Cloudflare, pon el modo SSL en «Full» o «Full (strict)», siempre que tu servidor tenga certificado.',
      'Revisa las reglas de redirección del servidor y deja una sola para cada caso.',
      'En WordPress, comprueba las dos direcciones de Ajustes → Generales.',
      'Desactiva los plugins de redirección o de SSL para encontrar cuál provoca el bucle.'
    ],
    latido: 'Más de 5 redirecciones'
  }
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230b0c0e'/%3E%3Cpath d='M4 17h6l3-8 5 15 3-7h7' fill='none' stroke='%2334d27b' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
const MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6"/><path d="M4 17h6l3-8 5 15 3-7h7"/></svg>';

function layout({ title, description, path, body }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Latido</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="theme-color" content="#eef0f3">
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500&amp;display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<!-- Generado por scripts/paginas-errores.mjs: edita el contenido allí -->
<a class="skip" href="#main">Saltar al contenido</a>
<header class="nav">
  <div class="wrap nav-row">
    <a class="brand" href="/" aria-label="Latido, inicio">${MARK}<span>Latido</span></a>
    <a class="btn btn-primary btn-sm nav-cta" href="/#/registro">Crear cuenta gratis</a>
  </div>
</header>
<main id="main">
${body}
<section class="close">
  <div class="wrap close-row">
    <h2>Entérate antes que tu cliente la próxima vez.</h2>
    <a class="btn btn-primary" href="/#/registro">Crear cuenta gratis</a>
  </div>
</section>
</main>
<footer class="footer">
  <div class="wrap footer-row">
    <div>
      <a class="brand" href="/">${MARK}<span>Latido</span></a>
      <p class="muted small">Monitor de uptime para agencias web.</p>
    </div>
    <nav aria-label="Legal" class="footer-links">
      <a href="/#/terminos">Términos</a>
      <a href="/#/privacidad">Privacidad</a>
      <a href="/#/cookies">Cookies</a>
      <a href="/#/reembolsos">Reembolsos</a>
      <a href="/#/aviso-legal">Aviso legal</a>
    </nav>
  </div>
</footer>
</body>
</html>
`;
}

function page(p) {
  const list = items => items.map(i => `    <li>${md(i)}</li>`).join('\n');
  return layout({
    title: p.title, description: p.description, path: `/errores/${p.slug}`,
    body: `<section class="legal"><div class="wrap narrow">
  <p class="eyebrow mono"><a href="/errores/">Errores web explicados</a></p>
  <h1>${esc(p.h1)}</h1>
  <p class="lede">${md(p.intro)}</p>
  <h2 class="h3">Causas más habituales</h2>
  <ul>
${list(p.causes)}
  </ul>
  <h2 class="h3">Qué revisar primero</h2>
  <ol>
${list(p.checks)}
  </ol>
  <h2 class="h3">Cómo lo detecta Latido</h2>
  <p>Latido comprueba tu web cada pocos minutos. Si falla, repite la comprobación 5 segundos después y, si sigue fallando, te avisa por email con el motivo en español: «${esc(p.latido)}». Cuando vuelve, te avisa otra vez con cuánto tiempo estuvo caída, y en tu panel queda la incidencia con un mensaje listo para reenviar a tu cliente.</p>${p.extra ? `\n  <p>${md(p.extra)}</p>` : ''}
</div></section>`
  });
}

function index() {
  const items = PAGES.map(p => `    <li><a href="/errores/${p.slug}">${esc(p.h1)}</a><br><span class="muted small">${esc(p.description)}</span></li>`).join('\n');
  return layout({
    title: 'Errores web explicados: qué significa cada uno y qué revisar',
    description: 'Qué significan los errores que tiran una web (500, 502, 503, 504, 403, certificado SSL, DNS, conexión rechazada, tiempo de espera y redirecciones) y qué revisar primero.',
    path: '/errores/',
    body: `<section class="legal"><div class="wrap narrow">
  <h1>Errores web explicados</h1>
  <p class="lede">Qué significa cada error que puede tirar una web y qué revisar primero. Son los mismos fallos que Latido detecta y explica en sus avisos.</p>
  <ul class="error-index">
${items}
  </ul>
</div></section>`
  });
}

const dir = new URL('../errores/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const p of PAGES) writeFileSync(new URL(`${p.slug}.html`, dir), page(p));
writeFileSync(new URL('index.html', dir), index());
const urls = ['/', '/errores/', ...PAGES.map(p => `/errores/${p.slug}`)];
writeFileSync(new URL('../sitemap.xml', import.meta.url), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}
</urlset>
`);
console.log(`${PAGES.length} páginas de errores, su índice y sitemap.xml generados`);
