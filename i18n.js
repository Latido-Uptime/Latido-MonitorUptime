/* Idiomas de la web de Latido. El texto en español (del HTML y de app.js) es la clave: cada idioma es
   un diccionario «español → traducción» en i18n/<idioma>.json, que se descarga al elegirlo. Si falta
   una traducción, se ve el español. Lo que escribe el usuario (nombres, URLs, emails) nunca pasa por
   aquí. Las claves que deben traducirse están en i18n/claves.json (I18n.keys() da las del HTML). */
(function (root) {
  'use strict';
  const LANGS = ['es', 'en', 'zh', 'fr', 'de'];
  const LOCALE = { es: 'es', en: 'en', zh: 'zh-CN', fr: 'fr', de: 'de' };
  const dicts = {};
  let lang = 'es';

  const norm = s => s.replace(/\s+/g, ' ').trim();
  /** Traduce un texto en español al idioma actual; {nombre} se sustituye por vars.nombre. */
  function t(es, vars) {
    const s = (lang !== 'es' && dicts[lang] && dicts[lang][es]) || es;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  // Textos fijos del HTML, guardados en español al cargar, antes de que app.js pinte nada.
  // data-i18n="html": frases con enlaces o negritas dentro, que se traducen enteras.
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const SKIP = 'script, style, code, [translate="no"], [data-i18n="html"]';
  const texts = [], htmls = [], attrs = [];
  for (const el of document.querySelectorAll('[data-i18n="html"]')) htmls.push({ el, es: norm(el.innerHTML) });
  for (const el of document.body.querySelectorAll(ATTRS.map(a => `[${a}]`).join())) {
    if (el.closest('[translate="no"]')) continue;
    for (const a of ATTRS) if (el.hasAttribute(a)) attrs.push({ el, a, es: el.getAttribute(a) });
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const es = norm(n.data);
    if (!/\p{L}/u.test(es) || n.parentElement.closest(SKIP)) continue; // sin letras: números y símbolos
    texts.push({ n, es, pre: /^\s/.test(n.data) ? ' ' : '', post: /\s$/.test(n.data) ? ' ' : '' });
  }

  function apply() {
    for (const x of texts) x.n.data = x.pre + t(x.es) + x.post;
    for (const x of htmls) x.el.innerHTML = t(x.es); // solo textos propios del diccionario, nunca del usuario
    for (const x of attrs) x.el.setAttribute(x.a, t(x.es));
    document.documentElement.lang = LOCALE[lang];
    for (const s of document.querySelectorAll('[data-lang]')) s.value = lang;
  }

  /** Cambia el idioma: descarga su diccionario, traduce lo fijo y avisa a app.js para que repinte lo demás. */
  async function set(l) {
    if (!LANGS.includes(l)) l = 'es';
    try {
      if (l !== 'es' && !dicts[l]) dicts[l] = await (await fetch(`i18n/${l}.json`)).json();
    } catch { l = 'es'; } // sin conexión o sin diccionario: se queda en español
    lang = l;
    try { localStorage.setItem('latido-lang', l); } catch { /* sin almacenamiento */ }
    apply();
    document.dispatchEvent(new Event('latido:idioma'));
  }

  /** Los textos fijos del HTML en español, para los traductores. */
  function keys() { return [...new Set([...texts, ...htmls, ...attrs].map(x => x.es))]; }

  root.I18n = { t, set, keys, lang: () => lang, locale: () => LOCALE[lang] };
  document.addEventListener('change', e => { if (e.target.matches('[data-lang]')) set(e.target.value); });

  // Idioma inicial: el elegido antes o, si no, el del navegador (si es uno de los nuestros)
  let saved = null;
  try { saved = localStorage.getItem('latido-lang'); } catch { /* sin almacenamiento */ }
  const browser = (navigator.languages || [navigator.language]).map(x => String(x).slice(0, 2).toLowerCase()).find(x => LANGS.includes(x));
  const first = saved || browser || 'es';
  if (first !== 'es') set(first);
})(typeof globalThis !== 'undefined' ? globalThis : this);
