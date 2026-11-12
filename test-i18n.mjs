// node test-i18n.mjs (también lo ejecuta npm test)
// Cada idioma traduce todos los textos de i18n/claves.json, con las mismas {variables} y etiquetas HTML,
// y ningún t('…') de app.js se queda fuera de las claves.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { appKeys, DYNAMIC } from './scripts/claves-i18n.mjs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const keys = JSON.parse(read('./i18n/claves.json'));
const set = new Set(keys);

const missingFromKeys = [...appKeys(read('./app.js')), ...DYNAMIC].filter(k => !set.has(k));
assert.deepStrictEqual(missingFromKeys, [], 'Textos sin clave: ejecuta node scripts/claves-i18n.mjs y tradúcelos');

const vars = s => (s.match(/\{\w+\}/g) || []).sort().join(' ');
const tags = s => (s.match(/<[^>]+>/g) || []).sort().join(' ');
for (const lang of ['en', 'zh', 'fr', 'de']) {
  const d = JSON.parse(read(`./i18n/${lang}.json`));
  const missing = keys.filter(k => typeof d[k] !== 'string' || !d[k].trim());
  assert.deepStrictEqual(missing, [], `${lang}: faltan traducciones`);
  assert.deepStrictEqual(Object.keys(d).filter(k => !set.has(k)), [], `${lang}: sobran claves`);
  assert.deepStrictEqual(keys.filter(k => vars(k) !== vars(d[k])), [], `${lang}: {variables} distintas`);
  assert.deepStrictEqual(keys.filter(k => tags(k) !== tags(d[k])), [], `${lang}: etiquetas HTML distintas`);
  assert.ok(/<script|on\w+=|javascript:/i.test(Object.values(d).join(' ')) === false, `${lang}: HTML peligroso`);
}

console.log('i18n: todos los tests pasan');
