/* Latido — prototipo estático. Todo lo que aquí "valida" es UX: en producción cada regla
   se repite en el servidor (plan según webhook de Paddle, límites, anti-SSRF, IDOR, CSRF). */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- Planes (en producción: tabla del servidor, nunca del navegador) ----------
const PLANS = {
  free:       { name: 'Gratis',     monitors: 5,   minInterval: 300, price: 0 },
  freelancer: { name: 'Freelancer', monitors: 30,  minInterval: 60,  price: 9 },
  agencia:    { name: 'Agencia',    monitors: 150, minInterval: 30,  price: 29 }
};
const INTERVALS = [30, 60, 300, 900];
const MAX_PER_DOMAIN = 3; // shortcut: por cuenta en la demo; en producción se cuenta entre todas las cuentas
const DEMO = { email: 'demo@latido.example', password: 'latido-demo-2026' };

// ---------- Sesión de demo (en producción: cookie HttpOnly del proveedor de auth) ----------
let session = null;
try { session = JSON.parse(sessionStorage.getItem('latido-session')) || null; } catch { session = null; }
if (session && (typeof session !== 'object' || typeof session.email !== 'string' || !Object.hasOwn(PLANS, session.plan))) session = null;
function saveSession() {
  try { session ? sessionStorage.setItem('latido-session', JSON.stringify(session)) : sessionStorage.removeItem('latido-session'); } catch { /* sin almacenamiento: solo en memoria */ }
}

// ---------- Utilidades ----------
let toastTimer;
function toast(msg) {
  const t = $('[data-toast]');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
function setMsg(form, field, text, ok = false) {
  const p = $(`[data-msg="${field}"]`, form);
  const input = form.elements.namedItem(field);
  if (p && input) {
    p.id = p.id || (input.id || field) + '-error';
    input.setAttribute('aria-describedby', [...new Set((input.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).concat(p.id))].join(' '));
    p.setAttribute('aria-live', 'polite');
  }
  if (p) { p.textContent = text || ''; p.className = 'field-msg' + (text ? (ok ? ' ok' : ' err') : ''); }
  if (input && input.setAttribute) input.setAttribute('aria-invalid', text && !ok ? 'true' : 'false');
}
function formMsg(form, text, ok = false) {
  const p = $('[data-form-msg]', form);
  p.textContent = text || ''; p.className = 'form-msg' + (text ? (ok ? ' ok' : ' err') : '');
}
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function rng(seed) { // PRNG determinista para los datos de demo
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}
function bars(seed, n = 90, downToday = false, clean = false) {
  const r = rng(seed);
  const wrap = document.createElement('span');
  wrap.className = 'bars'; wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < n; i++) {
    const i_ = document.createElement('i');
    const x = r();
    if (clean) { /* 100 %: todo verde */ }
    else if (downToday && i === n - 1) i_.className = 'd';
    else if (x > 0.985) i_.className = 'd';
    else if (x > 0.965) i_.className = 'w';
    else if (x > 0.955) i_.className = 'm';
    wrap.appendChild(i_);
  }
  return wrap;
}
function dot(state) {
  const d = document.createElement('span');
  d.className = 'dot' + (state === 'up' ? ' dot-up' : '');
  if (state === 'down') d.style.background = 'var(--down)';
  if (state === 'warn') d.style.background = 'var(--warn)';
  d.setAttribute('aria-hidden', 'true');
  return d;
}

// ---------- Datos de demo ----------
let monitors = [
  { id: 1, name: 'Web principal', url: 'https://clinicaortiz.example', client: 'Clínica Ortiz', interval: 30, state: 'down', ms: 0 },
  { id: 2, name: 'Reserva de citas', url: 'https://citas.clinicaortiz.example', client: 'Clínica Ortiz', interval: 60, state: 'up', ms: 212 },
  { id: 3, name: 'Tienda online', url: 'https://ferreterialumen.example', client: 'Ferretería Lumen', interval: 30, state: 'up', ms: 348 },
  { id: 4, name: 'Pasarela de pago', url: 'https://ferreterialumen.example/checkout', client: 'Ferretería Lumen', interval: 30, state: 'warn', ms: 1840 },
  { id: 5, name: 'Reservas', url: 'https://hotelbrisa.example', client: 'Hotel Brisa', interval: 60, state: 'up', ms: 187 },
  { id: 6, name: 'Carta y pedidos', url: 'https://rudacafe.example', client: 'Ruda Café', interval: 300, state: 'up', ms: 264 }
];
let nextId = 7;

// ---------- Hero ----------
function renderHero() {
  const ul = $('[data-hero-monitors]');
  ul.replaceChildren();
  monitors.slice(1, 6).forEach(m => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'name';
    const b = document.createElement('b'); b.textContent = m.name;
    const s = document.createElement('span'); s.className = 'mono';
    s.textContent = `${m.client} · ${m.state === 'warn' ? 'lento ' + m.ms + ' ms' : m.ms + ' ms'}`;
    name.append(b, s);
    li.append(dot(m.state), name, bars(m.url));
    ul.appendChild(li);
  });
}
$('[data-demo-notify]').addEventListener('click', e => {
  e.currentTarget.disabled = true;
  e.currentTarget.textContent = 'Cliente avisado';
  $('[data-demo-notify-out]').textContent = 'Enviado 09:17 · "Estamos renovando el certificado, en 20 min estará resuelto."';
});

// ---------- Prueba anti-SSRF ----------
$('[data-ssrf-try]').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  const r = SsrfGuard.checkUrl(f.elements.url.value);
  setMsg(f, 'url', r.ok ? 'Formato permitido. El servidor aún resolverá el DNS y bloqueará si apunta a una red interna.' : 'Bloqueada: ' + r.error, r.ok);
});

// ---------- Precios ----------
let cycle = 'mensual';
function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('es', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
function yearly(m) { return Math.round(m * 12 * 0.8); }
$$('[data-cycle]').forEach(b => b.addEventListener('click', () => {
  cycle = b.dataset.cycle;
  $$('[data-cycle]').forEach(x => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on); });
  $$('[data-price]').forEach(el => {
    const m = +el.dataset.price;
    el.textContent = (cycle === 'anual' ? fmt(yearly(m) / 12) : fmt(m)) + ' $';
  });
  $$('[data-billed]').forEach(el => {
    const m = +el.dataset.billed;
    el.textContent = cycle === 'anual' ? `Facturado ${yearly(m)} $ al año. Impuestos según tu país.` : 'Facturado cada mes. Impuestos según tu país.';
  });
  $$('[data-plan-link]').forEach(a => { a.href = `#/checkout?plan=${a.dataset.planLink}&ciclo=${cycle}`; });
}));

// ---------- Registro ----------
async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** k-anonimidad: solo se envían los 5 primeros caracteres del hash. null = no se pudo comprobar. */
async function pwnedCount(password) {
  try {
    const h = await sha1Hex(password);
    const res = await fetch('https://api.pwnedpasswords.com/range/' + h.slice(0, 5), { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const line = (await res.text()).split('\n').find(l => l.startsWith(h.slice(5)));
    return line ? parseInt(line.split(':')[1], 10) : 0;
  } catch { return null; }
}

$('[data-register]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const name = f.elements.name.value.trim();
  const email = f.elements.email.value.trim();
  const pass = f.elements.password.value;
  let ok = true;
  setMsg(f, 'name', name ? '' : 'Escribe tu nombre o el de tu agencia.'); ok = ok && !!name;
  setMsg(f, 'email', EMAIL_RE.test(email) ? '' : 'Escribe un email válido.'); ok = ok && EMAIL_RE.test(email);
  const passOk = pass.length >= 8 && pass.length <= 128;
  setMsg(f, 'password', passOk ? '' : 'La contraseña debe tener entre 8 y 128 caracteres.'); ok = ok && passOk;
  setMsg(f, 'terms', f.elements.terms.checked ? '' : 'Necesitamos que aceptes los términos y confirmes que eres mayor de edad.'); ok = ok && f.elements.terms.checked;
  if (!ok) { formMsg(f, ''); const bad = $('[aria-invalid="true"]', f); if (bad) bad.focus(); return; }

  const btn = $('button[type="submit"]', f);
  btn.disabled = true; formMsg(f, 'Comprobando la contraseña…', true);
  const submissionHash = location.hash;
  const n = await pwnedCount(pass);
  btn.disabled = false;
  if (location.hash !== submissionHash) return;
  if (n > 0) {
    formMsg(f, '');
    setMsg(f, 'password', `Esta contraseña aparece en ${n.toLocaleString('es')} filtraciones. Elige otra.`);
    f.elements.password.focus();
    return;
  }
  formMsg(f, n === null ? 'No pudimos consultar Have I Been Pwned; el servidor volverá a comprobarla.' : '', true);
  session = { email, name, verified: false, marketing: f.elements.marketing.checked, plan: 'free' };
  saveSession();
  f.reset();
  location.hash = '#/verifica';
});

$('[data-verify-demo]').addEventListener('click', () => {
  if (session) { session.verified = true; saveSession(); toast('Email verificado. Ya puedes activar monitores.'); }
});

// ---------- Login (límite de intentos y CAPTCHA) ----------
let fails = 0, lockedUntil = 0;
$('[data-login]').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (Date.now() < lockedUntil) {
    formMsg(f, `Demasiados intentos. Espera ${Math.ceil((lockedUntil - Date.now()) / 1000)} s.`);
    return;
  }
  const email = f.elements.email.value.trim().toLowerCase();
  const pass = f.elements.password.value;
  if (!EMAIL_RE.test(email) || !pass) {
    formMsg(f, 'Escribe un email válido y tu contraseña.');
    (!EMAIL_RE.test(email) ? f.elements.email : f.elements.password).focus();
    return;
  }
  if (email === DEMO.email && pass === DEMO.password) {
    fails = 0;
    session = { email, name: 'Agencia Demo', verified: true, plan: 'agencia' }; // el servidor emitiría un id de sesión nuevo
    saveSession(); f.reset(); formMsg(f, '');
    $('[data-captcha]', f).hidden = true;
    location.hash = '#/app';
    return;
  }
  fails++;
  formMsg(f, 'Email o contraseña incorrectos.'); // mismo mensaje exista o no la cuenta
  if (fails >= 3) $('[data-captcha]', f).hidden = false;
  if (fails >= 5) { lockedUntil = Date.now() + 30000; fails = 3; formMsg(f, 'Demasiados intentos. Espera 30 s.'); }
});

$('[data-reset]').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!EMAIL_RE.test(f.elements.email.value.trim())) { formMsg(f, 'Escribe un email válido.'); f.elements.email.setAttribute('aria-invalid', 'true'); f.elements.email.focus(); return; }
  f.elements.email.setAttribute('aria-invalid', 'false');
  f.reset();
  formMsg(f, 'Si el email existe, te enviamos un enlace. Caduca en 30 minutos y solo sirve una vez.', true);
});

$$('[data-oauth]').forEach(b => b.addEventListener('click', () => toast('En producción: inicio de sesión con Google vía Supabase Auth.')));

// ---------- Checkout ----------
function renderCheckout(params) {
  const key = Object.hasOwn(PLANS, params.get('plan')) && params.get('plan') !== 'free' ? params.get('plan') : 'agencia';
  const c = params.get('ciclo') === 'anual' ? 'anual' : 'mensual';
  const p = PLANS[key];
  $('[data-co-plan]').textContent = p.name;
  $('[data-co-price]').textContent = c === 'anual' ? `${yearly(p.price)} $ al año (equivale a ${fmt(yearly(p.price) / 12)} $/mes)` : `${p.price} $ al mes`;
  $('[data-co-cycle]').textContent = c === 'anual' ? 'Cada año' : 'Cada mes';
  $('[data-checkout]').dataset.plan = key;
}
$('[data-checkout]').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!f.elements.start.checked) { setMsg(f, 'start', 'Marca la casilla para empezar ya.'); return; }
  setMsg(f, 'start', '');
  formMsg(f, 'Aquí se abriría Paddle Checkout. El plan se activa al recibir el webhook firmado.', true);
});

// ---------- Panel ----------
function currentPlan() { return PLANS[$('[data-plan-sim]').value]; }

function renderIntervals() {
  const sel = $('[data-intervals]');
  const min = currentPlan().minInterval;
  const prev = +sel.value || 0;
  sel.replaceChildren();
  INTERVALS.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s < 60 ? `Cada ${s} s` : `Cada ${s / 60} min`;
    if (s < min) { o.disabled = true; o.textContent += ' (plan superior)'; }
    sel.appendChild(o);
  });
  sel.value = String(Math.max(prev, min));
  if (!sel.value) sel.value = String(min);
  const p = currentPlan();
  $('[data-limits]').textContent = `Plan ${p.name}: ${monitors.length} de ${p.monitors} monitores · mínimo ${p.minInterval < 60 ? p.minInterval + ' s' : p.minInterval / 60 + ' min'} · máx. ${MAX_PER_DOMAIN} por dominio.`;
}

function renderMonitors() {
  const tb = $('[data-monitors]');
  tb.replaceChildren();
  monitors.forEach(m => {
    const tr = document.createElement('tr');
    const svc = document.createElement('td'); svc.className = 'svc';
    const sp = document.createElement('span');
    const b = document.createElement('b'); b.textContent = m.name;
    const sm = document.createElement('small'); sm.textContent = m.url;
    sp.append(b, sm); svc.append(dot(m.state), sp);
    const cl = document.createElement('td'); cl.textContent = m.client || '—';
    const hist = document.createElement('td');
    if (m.state === 'new') { hist.className = 'muted small'; hist.textContent = 'Sin datos aún'; }
    else hist.appendChild(bars(m.url, 45, m.state === 'down'));
    const ms = document.createElement('td'); ms.className = 'mono';
    ms.textContent = m.state === 'down' ? 'caído' : m.state === 'new' ? 'pendiente' : m.ms + ' ms';
    const act = document.createElement('td');
    const del = document.createElement('button'); del.type = 'button'; del.className = 'del';
    del.textContent = 'Eliminar'; del.setAttribute('aria-label', 'Eliminar ' + m.name);
    del.addEventListener('click', () => {
      const index = monitors.findIndex(x => x.id === m.id);
      monitors = monitors.filter(x => x.id !== m.id); renderDash();
      const buttons = $$('[data-monitors] .del');
      (buttons[Math.min(index, buttons.length - 1)] || $('#m-name')).focus();
      toast('Monitor eliminado.');
    });
    act.appendChild(del);
    tr.append(svc, cl, hist, ms, act);
    tb.appendChild(tr);
  });
}

function renderDash() {
  renderMonitors(); renderIntervals();
  const p = currentPlan();
  $('[data-sub-line]').textContent = p.price ? `Plan ${p.name} · renueva el 1 de diciembre.` : 'Plan Gratis · sin cobros.';
  const down = monitors.filter(m => m.state === 'down').length;
  $('[data-stat-count]').textContent = monitors.length;
  $('[data-stat-down]').textContent = down;
  $('[data-stat-uptime]').textContent = monitors.length ? (99.98 - down * 0.04).toFixed(2).replace('.', ',') + ' %' : '—';
  $('[data-unverified]').hidden = !session || session.verified;
}

$('[data-plan-sim]').addEventListener('change', () => {
  if (session) { session.plan = $('[data-plan-sim]').value; saveSession(); }
  const p = currentPlan();
  $('[data-sub-line]').textContent = p.price ? `Plan ${p.name} · renueva el 1 de diciembre.` : 'Plan Gratis · sin cobros.';
  renderIntervals();
});

$('[data-add-monitor]').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  const p = currentPlan();
  const name = f.elements.name.value.trim();
  const interval = +f.elements.interval.value;
  ['name', 'url', 'interval'].forEach(k => setMsg(f, k, ''));
  formMsg(f, '');
  if (!session || !session.verified) { formMsg(f, 'Verifica tu email antes de activar monitores.'); return; }
  if (!name) { setMsg(f, 'name', 'Ponle un nombre.'); f.elements.name.focus(); return; }
  const r = SsrfGuard.checkUrl(f.elements.url.value);
  if (!r.ok) { setMsg(f, 'url', r.error); f.elements.url.focus(); return; }
  if (monitors.length >= p.monitors) { formMsg(f, `Tu plan ${p.name} permite ${p.monitors} monitores. Mejora el plan para añadir más.`); return; }
  if (!INTERVALS.includes(interval) || !(interval >= p.minInterval)) { setMsg(f, 'interval', `El intervalo mínimo de tu plan es ${p.minInterval} s.`); return; }
  const sameDomain = monitors.filter(m => { const checked = SsrfGuard.checkUrl(m.url); return checked.ok && checked.host === r.host; }).length;
  if (sameDomain >= MAX_PER_DOMAIN) { setMsg(f, 'url', `Ya hay ${MAX_PER_DOMAIN} monitores contra ${r.host}.`); return; }
  monitors.push({ id: nextId++, name, url: r.url.href, client: f.elements.client.value.trim(), interval, state: 'new', ms: 0 });
  f.reset();
  renderDash();
  formMsg(f, 'Monitor añadido. Simulación: no se realizan comprobaciones de red.', true);
});

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
$('[data-webhook]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const r = SsrfGuard.checkUrl(f.elements.url.value);
  const out = $('[data-webhook-out]', f);
  if (!r.ok) { setMsg(f, 'url', r.error); out.hidden = true; return; }
  if (r.url.protocol !== 'https:') { setMsg(f, 'url', 'Los webhooks deben usar https.'); out.hidden = true; return; }
  setMsg(f, 'url', 'Webhook guardado. Cada envío va firmado:', true);
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event: 'monitor.down', monitor: 'Web principal', at: ts });
  const sig = await hmacHex('whsec_demo_no_real', `${ts}.${body}`);
  out.textContent = `POST ${r.url.href}\nLatido-Timestamp: ${ts}\nLatido-Signature: v1=${sig}\n\n${body}`;
  out.hidden = false;
});

// ---------- Cuenta ----------
const actions = {
  logout() { session = null; saveSession(); toast('Sesión cerrada.'); if (location.hash === '#/') route(); else location.hash = '#/'; },
  verify() { toast('Te reenviamos el enlace de verificación.'); },
  '2fa'() {
    const a = new Uint8Array(20); crypto.getRandomValues(a);
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const secret = [...a].map(x => B32[x & 31]).join('');
    $('[data-2fa-out]').textContent = `Escanea el QR o introduce esta clave en tu app: ${secret.match(/.{4}/g).join(' ')}. Después te pediremos un código de 6 dígitos y te daremos 10 códigos de respaldo.`;
  },
  cancel() {
    if (!confirm('¿Cancelar la suscripción? Mantienes el plan hasta el final del periodo pagado.')) return;
    $('[data-cancel-out]').textContent = 'Suscripción cancelada. Tu plan sigue activo hasta el 1 de diciembre. Te enviamos la confirmación por email.';
  },
  export() {
    const data = { cuenta: { email: session && session.email, nombre: session && session.name }, monitores: monitors, exportado: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'latido-mis-datos.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('[data-data-out]').textContent = 'Descarga iniciada.';
  },
  delete() {
    if (!confirm('¿Borrar tu cuenta? Eliminaremos tus monitores y datos en 30 días. Esta acción no se puede deshacer.')) return;
    session = null; saveSession(); location.hash = '#/'; toast('Cuenta programada para borrado. Te enviamos la confirmación por email.');
  }
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action]) actions[b.dataset.action]();
});

// ---------- Página de estado pública (sin URLs ni IPs) ----------
function renderStatus() {
  const ul = $('[data-status-list]');
  ul.replaceChildren();
  [['Web principal', 'up', '99,97 %'], ['Reserva de citas', 'warn', '99,62 %'], ['Formulario de contacto', 'up', '100 %']].forEach(([n, s, u]) => {
    const li = document.createElement('li');
    const row = document.createElement('div'); row.className = 'row';
    const b = document.createElement('b'); b.textContent = n;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (s === 'up' ? 'badge-up' : 'badge-warn');
    badge.textContent = s === 'up' ? `Operativo · ${u}` : `Incidencia · ${u}`;
    row.append(b, badge);
    li.append(row, bars('estado-' + n, 90, s === 'warn', u === '100 %'));
    ul.appendChild(li);
  });
}

// ---------- Router ----------
const PROTECTED = new Set(['/app']);
function route() {
  if (location.hash === '#main') { $('#main').focus(); return; }
  const raw = location.hash.slice(1) || '/';
  const [pathPart, anchor] = raw.split('#');
  const [path, query] = (pathPart || '/').split('?');
  if (PROTECTED.has(path) && !session) { location.replace('#/login'); return; }
  if (path === '/verifica' && !session) { location.replace('#/registro'); return; }
  const views = $$('[data-view]');
  const view = views.find(v => v.dataset.view === path) || views.find(v => v.dataset.view === '404');
  views.forEach(v => { v.hidden = v !== view; });
  if (path === '/checkout') renderCheckout(new URLSearchParams(query));
  if (path === '/app') { $('[data-plan-sim]').value = Object.hasOwn(PLANS, session.plan) ? session.plan : 'free'; renderDash(); }
  if (path === '/verifica') $('[data-verify-email]').textContent = session.email;
  $$('[data-guest]').forEach(el => { el.hidden = !!session; });
  $$('[data-user]').forEach(el => { el.hidden = !session; });
  closeMenu();
  const target = anchor && document.getElementById(anchor);
  const focusTarget = target && view.contains(target) ? target : $('#main');
  focusTarget.setAttribute('tabindex', '-1');
  focusTarget.focus({ preventScroll: true });
  if (focusTarget === target) target.scrollIntoView();
  else window.scrollTo(0, 0);
  const h1 = $('h1', view);
  document.title = path === '/' ? 'Latido — Monitor de uptime para agencias web' : `${h1 ? h1.textContent.trim() : 'Latido'} · Latido`;
}

// ---------- Menú móvil ----------
const toggle = $('.nav-toggle');
function closeMenu() { $('#nav-links').classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = 'Menú'; }
toggle.addEventListener('click', () => {
  const open = !$('#nav-links').classList.contains('is-open');
  $('#nav-links').classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Cerrar' : 'Menú';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { closeMenu(); toggle.focus(); }
});
document.addEventListener('focusin', e => { if (!$('.nav').contains(e.target)) closeMenu(); });
window.matchMedia('(max-width: 820px)').addEventListener('change', closeMenu);
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (a && a.hash === location.hash && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); route(); }
});

renderHero();
renderStatus();
window.addEventListener('hashchange', route);
route();
