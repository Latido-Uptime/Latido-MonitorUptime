// Reúne en i18n/claves.json todos los textos en español que hay que traducir:
//  - los del HTML: i18n/claves-html.json, que da I18n.keys() en el navegador con la web en español;
//  - los t('…') de app.js;
//  - y los que llegan ya en español desde fuera (DYNAMIC): motivos del comprobador, mensajes de la base
//    de datos, del filtro anti-SSRF, nombres de planes y datos de ejemplo de la portada.
// Después hay que traducir las claves nuevas en i18n/<idioma>.json (el test avisa si falta alguna).
//   node scripts/claves-i18n.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DYNAMIC = [
  // Planes (public.plans.name) y monitores de ejemplo de la portada
  'Gratis', 'Freelancer', 'Agencia',
  'Reserva de citas', 'Tienda online', 'Pasarela de pago', 'Reservas', 'Carta y pedidos',
  // Motivos que guarda el comprobador (monitor/check.mjs)
  'Conexión rechazada por el servidor', 'El servidor cortó la conexión', 'El dominio no existe',
  'El certificado SSL ha caducado', 'El certificado SSL no corresponde a este dominio',
  'El certificado SSL es autofirmado', 'El certificado SSL no es de confianza',
  'Sin respuesta en 10 s', 'Redirección inválida', 'Más de 5 redirecciones',
  // Filtro anti-SSRF (ssrf-guard.js), en el navegador y en el comprobador
  'La URL no es válida.', 'Solo se permiten http y https.', 'La URL no puede llevar usuario ni contraseña.',
  'Falta el dominio.', 'Esa dirección es privada o interna y no se puede monitorizar.',
  'Ese dominio es interno y no se puede monitorizar.', 'El dominio no resuelve.', 'El dominio apunta a una dirección interna.',
  // Mensajes de la base de datos (código P0001)
  'URL sin dominio', 'La URL no puede llevar usuario ni contraseña', 'Perfil no encontrado',
  'Confirma tu código de 2FA para borrar la cuenta', 'Sin sesión'
];

/** Los textos de los t('…') de app.js (todos van entre comillas simples). */
export function appKeys(src) {
  return [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
}

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
export function allKeys() {
  return [...new Set([...JSON.parse(read('../i18n/claves-html.json')), ...appKeys(read('../app.js')), ...DYNAMIC])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = allKeys();
  writeFileSync(new URL('../i18n/claves.json', import.meta.url), JSON.stringify(keys, null, 2) + '\n');
  console.log(`${keys.length} textos en i18n/claves.json`);
}
