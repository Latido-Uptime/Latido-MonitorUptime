/* Latido — web con cuentas reales (Supabase Auth). Las validaciones del navegador son ayuda
   para el usuario: las reglas de verdad (RLS, límites por plan, 2FA) las aplica la base de datos. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- Supabase ----------
const CFG = window.LATIDO_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
let session = null;   // sesión de Supabase (null = sin sesión)
let mfaNeeded = false; // tiene 2FA y la sesión aún no lo ha verificado (aal1 → aal2)
let pendingEmail = ''; // email recién registrado, para la pantalla "revisa tu email"

// Precios públicos (los límites reales viven en la tabla public.plans)
const PRICES = {
  free:       { name: 'Gratis',     price: 0 },
  freelancer: { name: 'Freelancer', price: 9 },
  agencia:    { name: 'Agencia',    price: 29 }
};
const INTERVALS = [30, 60, 300, 900];

// ---------- Utilidades ----------
let toastTimer;
function toast(msg) {
  const t = $('[data-toast]');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
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
function busy(form, on) { $$('button[type="submit"]', form).forEach(b => { b.disabled = on; }); }
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const redirectTo = r => `${location.origin}${location.pathname}?r=${r}`;

/** Traduce los errores de Supabase a mensajes claros, sin revelar si una cuenta existe. */
function authError(error) {
  const code = error && (error.code || '');
  const status = error && error.status;
  if (status === 429 || /rate.?limit/i.test(code + error.message)) return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
  if (code === 'email_not_confirmed') return 'Confirma tu email antes de entrar: abre el enlace que te enviamos.';
  if (code === 'weak_password') return 'La contraseña es demasiado débil o aparece en filtraciones. Elige otra.';
  if (code === 'same_password') return 'La contraseña nueva debe ser distinta de la anterior.';
  if (code === 'mfa_verification_failed' || code === 'mfa_challenge_expired') return 'Código incorrecto o caducado. Prueba con el código actual de tu app.';
  if (code === 'captcha_failed') return 'No pudimos verificar que eres humano. Recarga la página y vuelve a probar.';
  return 'No se pudo completar. Inténtalo de nuevo en unos minutos.';
}

// ---------- Visuales de la portada (datos de ejemplo de marketing) ----------
function rng(seed) {
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
  if (state === 'new') d.style.background = 'var(--line)';
  d.setAttribute('aria-hidden', 'true');
  return d;
}
const HERO = [
  { name: 'Reserva de citas', client: 'Clínica Ortiz', state: 'up', ms: 212 },
  { name: 'Tienda online', client: 'Ferretería Lumen', state: 'up', ms: 348 },
  { name: 'Pasarela de pago', client: 'Ferretería Lumen', state: 'warn', ms: 1840 },
  { name: 'Reservas', client: 'Hotel Brisa', state: 'up', ms: 187 },
  { name: 'Carta y pedidos', client: 'Ruda Café', state: 'up', ms: 264 }
];
function renderHero() {
  const ul = $('[data-hero-monitors]');
  ul.replaceChildren();
  HERO.forEach(m => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'name';
    const b = document.createElement('b'); b.textContent = m.name;
    const s = document.createElement('span'); s.className = 'mono';
    s.textContent = `${m.client} · ${m.state === 'down' ? 'caída' : m.state === 'warn' ? 'lento ' + m.ms + ' ms' : m.ms + ' ms'}`;
    name.append(b, s);
    li.append(dot(m.state), name, bars(m.name, 90, m.downToday));
    ul.appendChild(li);
  });
}

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

// ---------- CAPTCHA (Cloudflare Turnstile): un widget por pantalla, token de un solo uso ----------
const captchas = new Map(); // contenedor -> { id, token }
const slotOf = scope => $('[data-captcha]', scope.closest('[data-view]') || scope);
function mountCaptcha(view) {
  const slot = $('[data-captcha]', view);
  if (!slot || !window.turnstile) return;
  const known = captchas.get(slot);
  if (known) { known.token = ''; window.turnstile.reset(known.id); return; }
  const entry = { id: null, token: '' };
  entry.id = window.turnstile.render(slot, {
    sitekey: CFG.turnstileSiteKey, language: 'es',
    callback: t => { entry.token = t; },
    'expired-callback': () => { entry.token = ''; },
    'error-callback': () => { entry.token = ''; }
  });
  captchas.set(slot, entry);
}
function captchaToken(scope) { const c = captchas.get(slotOf(scope)); return c ? c.token : ''; }
function captchaUsed(scope) { const c = captchas.get(slotOf(scope)); if (c) { c.token = ''; window.turnstile.reset(c.id); } }
const NO_CAPTCHA = 'Completa la verificación anti-bots y vuelve a pulsar el botón.';
// Turnstile llama a esta función al cargar (api.js?onload=latidoTurnstileReady)
window.latidoTurnstileReady = () => { const v = $$('[data-view]').find(x => !x.hidden); if (v) mountCaptcha(v); };

// ---------- Contraseñas filtradas (Have I Been Pwned, k-anonimidad) ----------
async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Solo se envían los 5 primeros caracteres del hash. null = no se pudo comprobar. */
async function pwnedCount(password) {
  try {
    const h = await sha1Hex(password);
    const res = await fetch('https://api.pwnedpasswords.com/range/' + h.slice(0, 5), { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const line = (await res.text()).split('\n').find(l => l.startsWith(h.slice(5)));
    return line ? parseInt(line.split(':')[1], 10) : 0;
  } catch { return null; }
}
/** Valida longitud y filtraciones; devuelve un mensaje de error o ''. */
async function passwordProblem(pass) {
  if (pass.length < 8 || pass.length > 128) return 'La contraseña debe tener entre 8 y 128 caracteres.';
  const n = await pwnedCount(pass);
  return n > 0 ? `Esta contraseña aparece en ${n.toLocaleString('es')} filtraciones. Elige otra.` : '';
}

// ---------- Registro ----------
$('[data-register]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const name = f.elements.name.value.trim();
  const email = f.elements.email.value.trim().toLowerCase();
  const pass = f.elements.password.value;
  let ok = true;
  setMsg(f, 'name', name ? '' : 'Escribe tu nombre o el de tu agencia.'); ok = ok && !!name;
  setMsg(f, 'email', EMAIL_RE.test(email) ? '' : 'Escribe un email válido.'); ok = ok && EMAIL_RE.test(email);
  setMsg(f, 'password', pass.length >= 8 && pass.length <= 128 ? '' : 'La contraseña debe tener entre 8 y 128 caracteres.'); ok = ok && pass.length >= 8 && pass.length <= 128;
  setMsg(f, 'terms', f.elements.terms.checked ? '' : 'Necesitamos que aceptes los términos y confirmes que eres mayor de edad.'); ok = ok && f.elements.terms.checked;
  if (!ok) { formMsg(f, ''); const bad = $('[aria-invalid="true"]', f); if (bad) bad.focus(); return; }

  busy(f, true); formMsg(f, 'Comprobando la contraseña…', true);
  const problem = await passwordProblem(pass);
  if (problem) { busy(f, false); formMsg(f, ''); setMsg(f, 'password', problem); f.elements.password.focus(); return; }

  const captchaTokenValue = captchaToken(f);
  if (!captchaTokenValue) { busy(f, false); formMsg(f, NO_CAPTCHA); return; }
  formMsg(f, 'Creando tu cuenta…', true);
  const { error } = await sb.auth.signUp({
    email, password: pass,
    options: { emailRedirectTo: redirectTo('app'), captchaToken: captchaTokenValue, data: { name, marketing: f.elements.marketing.checked } }
  });
  captchaUsed(f);
  busy(f, false);
  if (error) { formMsg(f, authError(error)); return; }
  // Supabase responde igual exista o no la cuenta: no revelamos qué emails están registrados
  pendingEmail = email;
  f.reset(); formMsg(f, '');
  location.hash = '#/verifica';
});

// ---------- Login (con 2FA si está activado) ----------
$('[data-login]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const totpBox = $('[data-totp]', f);
  formMsg(f, '');

  if (mfaNeeded && session) { // segundo paso: código de la app
    const code = f.elements.totp.value.trim();
    if (!/^\d{6}$/.test(code)) { formMsg(f, 'Escribe los 6 dígitos de tu app de autenticación.'); f.elements.totp.focus(); return; }
    busy(f, true);
    const { data: factors } = await sb.auth.mfa.listFactors();
    const factor = factors && factors.totp.find(x => x.status === 'verified');
    const { error } = factor ? await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code }) : { error: { code: 'mfa_verification_failed' } };
    busy(f, false);
    if (error) { formMsg(f, authError(error)); f.elements.totp.select(); return; }
    mfaNeeded = false; totpBox.hidden = true; f.reset();
    location.hash = nextAfterLogin();
    return;
  }

  const email = f.elements.email.value.trim().toLowerCase();
  const pass = f.elements.password.value;
  if (!EMAIL_RE.test(email) || !pass) {
    formMsg(f, 'Escribe un email válido y tu contraseña.');
    (!EMAIL_RE.test(email) ? f.elements.email : f.elements.password).focus();
    return;
  }
  const loginToken = captchaToken(f);
  if (!loginToken) { formMsg(f, NO_CAPTCHA); return; }
  busy(f, true);
  const { error } = await sb.auth.signInWithPassword({ email, password: pass, options: { captchaToken: loginToken } });
  captchaUsed(f);
  if (error) {
    busy(f, false);
    // Mismo mensaje exista o no la cuenta
    formMsg(f, error.code === 'invalid_credentials' ? 'Email o contraseña incorrectos.' : authError(error));
    return;
  }
  await refreshMfa();
  busy(f, false);
  if (mfaNeeded) {
    totpBox.hidden = false; f.elements.totp.value = ''; f.elements.totp.focus();
    formMsg(f, 'Escribe el código de 6 dígitos de tu app de autenticación.', true);
    return;
  }
  f.reset();
  location.hash = nextAfterLogin();
});

function nextAfterLogin() {
  let next = '';
  try { next = sessionStorage.getItem('latido-next') || ''; sessionStorage.removeItem('latido-next'); } catch { /* sin almacenamiento */ }
  return /^#\/checkout\?plan=(freelancer|agencia)&ciclo=(mensual|anual)$/.test(next) || next === '#/checkout' ? next : '#/app';
}

async function refreshMfa() {
  const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  mfaNeeded = !!data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

// ---------- Recuperar contraseña ----------
$('[data-reset]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const email = f.elements.email.value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { formMsg(f, 'Escribe un email válido.'); f.elements.email.setAttribute('aria-invalid', 'true'); f.elements.email.focus(); return; }
  f.elements.email.setAttribute('aria-invalid', 'false');
  const resetToken = captchaToken(f);
  if (!resetToken) { formMsg(f, NO_CAPTCHA); return; }
  busy(f, true);
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo('nueva-clave'), captchaToken: resetToken });
  captchaUsed(f);
  busy(f, false);
  if (error && error.status === 429) { formMsg(f, authError(error)); return; }
  f.reset();
  // Siempre la misma respuesta: no revela si el email está registrado
  formMsg(f, 'Si el email existe, te enviamos un enlace. Solo sirve una vez y caduca en 1 hora.', true);
});

$('[data-new-password]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const pass = f.elements.password.value;
  if (!session) { formMsg(f, 'El enlace caducó o ya se usó. Pide uno nuevo en "¿Olvidaste tu contraseña?".'); return; }
  busy(f, true); formMsg(f, 'Comprobando la contraseña…', true);
  const problem = await passwordProblem(pass);
  if (problem) { busy(f, false); formMsg(f, ''); setMsg(f, 'password', problem); f.elements.password.focus(); return; }
  const { error } = await sb.auth.updateUser({ password: pass });
  busy(f, false);
  if (error) { formMsg(f, authError(error)); return; }
  f.reset(); setMsg(f, 'password', '');
  toast('Contraseña cambiada. Te enviamos un aviso por email.');
  location.hash = '#/app';
});

// ---------- Checkout (fase de pagos) ----------
function renderCheckout(params) {
  const key = Object.hasOwn(PRICES, params.get('plan')) && params.get('plan') !== 'free' ? params.get('plan') : 'agencia';
  const c = params.get('ciclo') === 'anual' ? 'anual' : 'mensual';
  const p = PRICES[key];
  $('[data-co-plan]').textContent = p.name;
  $('[data-co-price]').textContent = c === 'anual' ? `${yearly(p.price)} $ al año (equivale a ${fmt(yearly(p.price) / 12)} $/mes)` : `${p.price} $ al mes`;
  $('[data-co-cycle]').textContent = c === 'anual' ? 'Cada año' : 'Cada mes';
  $('[data-checkout]').dataset.plan = key;
  $('[data-checkout]').dataset.cycle = c;
}
let paddleReady = false;
function initPaddle() {
  if (!CFG.paddle.enabled) return false;
  if (paddleReady || !window.Paddle || !CFG.paddle.clientToken) return paddleReady;
  if (CFG.paddle.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
  window.Paddle.Initialize({
    token: CFG.paddle.clientToken,
    eventCallback: ev => { if (ev && ev.name === 'checkout.completed') awaitingPayment = true; }
  });
  return (paddleReady = true);
}
let awaitingPayment = false;
$('[data-checkout]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!f.elements.start.checked) { setMsg(f, 'start', 'Marca la casilla para empezar ya.'); return; }
  setMsg(f, 'start', '');
  if (!session) { location.hash = '#/login'; return; }
  const { data: current } = await sb.from('subscriptions').select('status').maybeSingle();
  if (current && ['active', 'trialing', 'past_due'].includes(current.status)) {
    formMsg(f, 'Ya tienes un plan de pago. Para cambiarlo, cancélalo en tu panel (Cuenta y seguridad → Suscripción) y contrata el nuevo cuando termine el periodo pagado.');
    return;
  }
  if (!initPaddle()) { formMsg(f, 'El pago no está disponible ahora mismo. Recarga la página o inténtalo más tarde.'); return; }
  const priceId = CFG.paddle.prices[f.dataset.plan][f.dataset.cycle];
  formMsg(f, '');
  window.Paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    customer: { email: session.user.email },
    // El servidor solo usa este id para saber a qué cuenta aplicar el pago; el plan lo decide el precio
    customData: { user_id: session.user.id },
    settings: { displayMode: 'overlay', locale: 'es', theme: 'light', allowLogout: false,
                successUrl: `${location.origin}${location.pathname}?r=app&pago=ok` }
  });
});

// ---------- Panel ----------
let profile = null, plan = null, monitors = [], subscription = null, history = new Map(), incidents = []; // history: monitor_id -> resumen de 24 h

async function loadDash() {
  const [p, m, h, s, i] = await Promise.all([
    sb.from('profiles').select('name, plan, first_alert_sent_at, plans(name, max_monitors, min_interval)').single(),
    sb.from('monitors').select('id, name, url, client, interval_seconds, created_at, state, state_since, last_checked_at, last_status, last_ms, last_error, paused, ssl_expires_at').order('created_at'),
    sb.rpc('my_history_24h'), // resumido en el servidor: la API devuelve como mucho 1000 filas por petición
    sb.from('subscriptions').select('plan, status, current_period_end, scheduled_cancel').maybeSingle(),
    sb.from('incidents').select('monitor_id, started_at, last_ok_at, status, error, last_fail_at, ended_at').order('started_at', { ascending: false }).limit(50)
  ]);
  if (p.error || m.error) { toast('No pudimos cargar tus datos. Recarga la página.'); return; }
  profile = p.data; plan = p.data.plans; monitors = m.data; subscription = s && !s.error ? s.data : null;
  history = new Map((h.data || []).map(d => [d.monitor_id, d]));
  incidents = i.data || [];
  renderDash();
  render2fa();
}

function renderIntervals() {
  const sel = $('[data-intervals]');
  const prev = +sel.value || 0;
  sel.replaceChildren();
  INTERVALS.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s < 60 ? `Cada ${s} s` : `Cada ${s / 60} min`;
    if (s < plan.min_interval) { o.disabled = true; o.textContent += ' (plan superior)'; }
    sel.appendChild(o);
  });
  sel.value = String(Math.max(prev, plan.min_interval));
  if (!sel.value) sel.value = String(plan.min_interval);
  $('[data-limits]').textContent = `Plan ${plan.name}: ${monitors.length} de ${plan.max_monitors} monitores · mínimo ${plan.min_interval < 60 ? plan.min_interval + ' s' : plan.min_interval / 60 + ' min'} · máx. 3 por dominio.`;
}

function renderMonitors() {
  const tb = $('[data-monitors]');
  tb.replaceChildren();
  if (!monitors.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 5; td.className = 'muted small'; td.textContent = 'Todavía no tienes monitores. Añade el primero con el formulario.';
    tr.appendChild(td); tb.appendChild(tr); return;
  }
  monitors.forEach((m, index) => {
    const tr = document.createElement('tr');
    const svc = document.createElement('td'); svc.className = 'svc';
    const sp = document.createElement('span');
    const b = document.createElement('b'); b.textContent = m.name;
    const sm = document.createElement('small'); sm.textContent = m.url;
    if (m.state === 'down' && m.last_error) { const er = document.createElement('small'); er.className = 't-down'; er.textContent = m.last_error; sp.append(b, sm, er); }
    else sp.append(b, sm);
    if (m.paused) { const pz = document.createElement('small'); pz.textContent = 'En pausa: supera el límite de tu plan'; sp.append(pz); }
    if (new Date(m.ssl_expires_at) > Date.now()) { // ya caducado lo dice el motivo de la caída
      const d = daysLeft(m.ssl_expires_at), sc = document.createElement('small');
      if (d <= 14) sc.className = 't-down';
      sc.textContent = d <= 14 ? `El certificado SSL caduca en ${daysText(d)}` : `SSL válido hasta ${new Date(m.ssl_expires_at).toLocaleDateString('es')}`;
      sp.append(sc);
    }
    svc.append(dot(m.paused || m.state === 'pending' ? 'new' : m.state), sp);
    const cl = document.createElement('td'); cl.textContent = m.client || '—';
    const hist = document.createElement('td');
    const day = history.get(m.id);
    if (day && day.checks) hist.appendChild(historyBars(day));
    else { hist.className = 'muted small'; hist.textContent = m.state === 'pending' ? 'Primera comprobación en curso' : 'Sin datos en 24 h'; }
    const ms = document.createElement('td'); ms.className = 'mono';
    ms.textContent = m.state === 'down' ? 'caído' : m.state === 'up' ? `${m.last_ms} ms` : 'pendiente';
    const act = document.createElement('td');
    const del = document.createElement('button'); del.type = 'button'; del.className = 'del';
    del.textContent = 'Eliminar'; del.setAttribute('aria-label', 'Eliminar ' + m.name);
    del.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el monitor "${m.name}"?`)) return;
      del.disabled = true;
      const { error } = await sb.from('monitors').delete().eq('id', m.id);
      if (error) { del.disabled = false; toast('No se pudo eliminar. Inténtalo de nuevo.'); return; }
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

/** Barras de las últimas 24 h (45 tramos que resume el servidor): rojo si alguna comprobación falló en el tramo. */
function historyBars(day) {
  const wrap = document.createElement('span');
  wrap.className = 'bars'; wrap.setAttribute('role', 'img');
  const okPct = 100 * (day.checks - day.failures) / day.checks;
  wrap.setAttribute('aria-label', `Disponibilidad en 24 h: ${okPct.toFixed(2).replace('.', ',')} %`);
  for (const v of day.slots) { const i = document.createElement('i'); i.className = v === '.' ? 'e' : v === '1' ? '' : 'd'; wrap.appendChild(i); }
  return wrap;
}

// ---------- Incidencias: la ficha que la agencia reenvía a su cliente ----------
const when = d => new Date(d).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
const daysLeft = d => Math.max(1, Math.round((new Date(d) - Date.now()) / 864e5));
const daysText = n => `${n} día${n === 1 ? '' : 's'}`;
const every = m => m.interval_seconds < 60 ? `${m.interval_seconds} s` : `${m.interval_seconds / 60} min`;
/** Minutos entre detectar la caída y ver que volvió (o hasta ahora, si sigue caída). */
const downFor = i => Math.max(1, Math.round((new Date(i.ended_at || Date.now()) - new Date(i.started_at)) / 6e4));

/** Qué revisar primero según lo que vio Latido. Es una pista, no un diagnóstico: por eso se dice "probable". */
function hint(i) {
  const s = i.status, e = i.error || '';
  if (s >= 500) return 'el estado del hosting y los registros de errores del servidor';
  if ([401, 403, 429].includes(s)) return 'si un firewall o la protección anti-bots está bloqueando las comprobaciones';
  if (s === 404 || s === 410) return 'si la página cambió de dirección o se borró';
  if (s >= 400) return 'la configuración del servidor para esa dirección';
  if (/SSL/.test(e)) return 'el certificado SSL: su renovación y su configuración';
  if (/dominio/i.test(e)) return 'el DNS y que el dominio no haya caducado';
  if (/rechazada|cortó/.test(e)) return 'que el servidor web esté en marcha y acepte conexiones';
  if (/Sin respuesta/.test(e)) return 'si el servidor está sobrecargado o caído';
  if (/redirecci/i.test(e)) return 'las redirecciones de la web';
  return 'el estado del servidor y del hosting';
}

/** La ficha en texto plano, lista para pegar en un email o chat con el cliente. */
function clientMessage(i, m) {
  return [
    `Incidencia en ${m.name} (${m.url})`,
    '',
    `Qué pasó: ${(i.error || 'la web no respondió correctamente').replace(/\.$/, '')}.`, // algunos errores ya traen punto
    `Detectada: ${when(i.started_at)}${i.last_ok_at ? ` (la comprobación anterior, ${when(i.last_ok_at)}, fue correcta)` : ''}. Se confirmó con una segunda comprobación 5 segundos después.`,
    i.ended_at
      ? `Resuelta: ${when(i.ended_at)}. Duración aproximada: ${downFor(i)} min (la web se comprueba cada ${every(m)}).`
      : `Estado: sigue sin responder, desde hace unos ${downFor(i)} min.`,
    `Qué revisar primero (causa probable): ${hint(i)}.`
  ].join('\n');
}

function renderIncidents() {
  const ul = $('[data-incidents]');
  ul.replaceChildren();
  const list = incidents.filter(i => monitors.some(m => m.id === i.monitor_id));
  if (!list.length) {
    const li = document.createElement('li'); li.className = 'muted small'; li.textContent = 'Sin incidencias en los últimos 90 días.';
    ul.appendChild(li); return;
  }
  for (const i of list) ul.appendChild(incidentCard(i, monitors.find(x => x.id === i.monitor_id)));
}

/** La ficha de una incidencia: la misma en el panel y en la demo de la portada. */
function incidentCard(i, m) {
  const li = document.createElement('li'); li.className = i.ended_at ? 'incident is-done' : 'incident';
  const head = document.createElement('div'); head.className = 'incident-head';
  const badge = document.createElement('span'); badge.className = i.ended_at ? 'badge badge-up' : 'badge badge-down';
  badge.textContent = i.ended_at ? `Resuelta · ${downFor(i)} min` : 'Caída en curso';
  const b = document.createElement('b'); b.textContent = m.client ? `${m.name} · ${m.client}` : m.name;
  head.append(badge, b);
  const diag = document.createElement('p'); diag.className = 'diag';
  const label = document.createElement('span'); label.className = 'mono'; label.textContent = 'Motivo';
  diag.append(label, i.error || 'La web no respondió correctamente');
  const times = document.createElement('p'); times.className = 'small muted';
  times.textContent = `Detectada ${when(i.started_at)}` + (i.last_ok_at ? ` · última comprobación correcta ${when(i.last_ok_at)}` : '')
    + (i.ended_at ? ` · resuelta ${when(i.ended_at)}` : '');
  const tip = document.createElement('p'); tip.className = 'small'; tip.textContent = `Qué revisar primero (causa probable): ${hint(i)}.`;
  const slug = Errores.errorPage(i.status, i.error);
  if (slug) {
    const more = document.createElement('a'); more.href = `/errores/${slug}`; more.target = '_blank'; more.rel = 'noopener';
    more.textContent = 'Qué significa este error';
    tip.append(' ', more);
  }
  const actions = document.createElement('div'); actions.className = 'incident-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-ghost btn-sm';
  copy.textContent = 'Copiar mensaje para el cliente';
  copy.addEventListener('click', () => {
    const text = clientMessage(i, m);
    navigator.clipboard.writeText(text).then(() => toast('Mensaje copiado. Pégalo en tu email o chat con el cliente.'), () => {
      // Sin permiso para el portapapeles: se muestra el texto ya seleccionado para copiarlo a mano
      const ta = li.querySelector('textarea') || li.appendChild(document.createElement('textarea'));
      ta.readOnly = true; ta.rows = 7; ta.value = text; ta.setAttribute('aria-label', 'Mensaje para el cliente');
      ta.focus(); ta.select();
      toast('No se pudo copiar solo: el mensaje está seleccionado debajo, cópialo con Ctrl+C o Cmd+C.');
    });
  });
  actions.appendChild(copy);
  li.append(head, diag, times, tip, actions);
  return li;
}

// ---------- Demo de la portada: una caída simulada, con los mensajes reales del comprobador ----------
const DEMO = {
  503: { status: 503, error: 'El servidor respondió 503' },
  ssl: { status: null, error: 'El certificado SSL ha caducado' },
  dns: { status: null, error: 'El dominio no resuelve.' }
};
let demoTimer;
$$('[data-demo]').forEach(btn => btn.addEventListener('click', () => {
  const m = { name: 'Tienda online', url: 'https://ferreterialumen.example', client: 'Ferretería Lumen', interval_seconds: 300 };
  const ago = min => new Date(Date.now() - min * 6e4).toISOString();
  const i = { ...DEMO[btn.dataset.demo], started_at: ago(6), last_ok_at: ago(11), ended_at: null };
  const hero = HERO.find(h => h.name === m.name);
  const show = mail => {
    const card = incidentCard(i, m), note = document.createElement('p'), tag = document.createElement('span');
    tag.className = 'badge badge-warn'; tag.textContent = 'Simulación';
    note.className = 'small'; note.append(tag, ` Email enviado: ${mail}`);
    card.prepend(note);
    $('[data-demo-incident]').replaceChildren(card);
    renderHero();
  };
  $$('[data-demo]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  clearTimeout(demoTimer);
  Object.assign(hero, { state: 'down', downToday: true });
  show(`🔴 Caída: ${m.name}`);
  demoTimer = setTimeout(() => {
    Object.assign(i, { ended_at: ago(0), last_fail_at: ago(1) });
    hero.state = 'up';
    show(`🟢 Recuperado: ${m.name}`);
  }, 3000);
}));

function renderDash() {
  if (!plan) return;
  renderMonitors(); renderIntervals(); renderIncidents();
  $('[data-account-line]').textContent = `Panel · ${session.user.email}`;
  $('[data-plan-line]').textContent = `Plan ${plan.name}`;
  const paid = profile.plan !== 'free' && subscription;
  const until = subscription && subscription.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  $('[data-sub-line]').textContent = !paid ? 'Plan Gratis · sin cobros.'
    : subscription.scheduled_cancel ? `Plan ${plan.name} · cancelado: sigue activo hasta el ${until}.`
    : subscription.status === 'past_due' ? `Plan ${plan.name} · no pudimos cobrar: actualiza tu tarjeta.`
    : `Plan ${plan.name} · se renueva el ${until}.`;
  $('[data-sub-upgrade]').hidden = !!paid || !CFG.paddle.enabled;
  $$('[data-sub-paid]').forEach(b => { b.hidden = !paid; });
  $('[data-action="cancel-sub"]').hidden = !paid || subscription.scheduled_cancel;
  $('[data-stat-count]').textContent = monitors.length;
  $('[data-stat-down]').textContent = monitors.filter(m => m.state === 'down').length;
  const ssl = monitors.map(m => new Date(m.ssl_expires_at)).filter(d => d > Date.now()).sort((a, b) => a - b);
  $('[data-stat-ssl]').textContent = ssl.length ? daysText(daysLeft(ssl[0])) : '—';
  let total = 0, bad = 0;
  for (const d of history.values()) { total += d.checks; bad += d.failures; }
  $('[data-stat-uptime]').textContent = total ? (100 * (total - bad) / total).toFixed(2).replace('.', ',') + ' %' : '—';
}

$('[data-add-monitor]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const name = f.elements.name.value.trim();
  const interval = +f.elements.interval.value;
  ['name', 'url', 'interval'].forEach(k => setMsg(f, k, ''));
  formMsg(f, '');
  if (!name) { setMsg(f, 'name', 'Ponle un nombre.'); f.elements.name.focus(); return; }
  const r = SsrfGuard.checkUrl(f.elements.url.value);
  if (!r.ok) { setMsg(f, 'url', r.error); f.elements.url.focus(); return; }
  if (!INTERVALS.includes(interval) || interval < plan.min_interval) { setMsg(f, 'interval', `El intervalo mínimo de tu plan es ${plan.min_interval} s.`); return; }
  busy(f, true);
  const { data, error } = await sb.from('monitors')
    .insert({ name, url: r.url.href, client: f.elements.client.value.trim(), interval_seconds: interval })
    .select('id, name, url, client, interval_seconds, created_at, state, state_since, last_checked_at, last_status, last_ms, last_error, paused').single();
  busy(f, false);
  if (error) {
    // Los límites del plan los aplica la base de datos (código P0001, mensaje en español)
    formMsg(f, error.code === 'P0001' ? error.message : 'No se pudo añadir el monitor. Inténtalo de nuevo.');
    return;
  }
  monitors.push(data);
  setTimeout(() => { if (location.hash === '#/app') loadDash(); }, 45000); // muestra la primera comprobación
  f.reset();
  renderDash();
  formMsg(f, 'Monitor guardado. La primera comprobación llega en menos de un minuto.' + (profile.first_alert_sent_at ? ''
    : ` La primera vez que una de tus webs responda bien te enviaremos un email de prueba a ${session.user.email}: si no lo ves, mira en spam.`), true);
});


// ---------- 2FA (TOTP) ----------
let enrollingFactor = null;
async function render2fa() {
  const { data } = await sb.auth.mfa.listFactors();
  const active = !!data && data.totp.some(x => x.status === 'verified');
  $('[data-action="2fa"]').hidden = active || !!enrollingFactor;
  $('[data-action="2fa-off"]').hidden = !active;
  if (active) $('[data-2fa-out]').textContent = '2FA activado. Te pediremos un código al iniciar sesión.';
}
$('[data-2fa-form]').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const code = f.elements.code.value.trim();
  const out = $('[data-2fa-out]');
  if (!/^\d{6}$/.test(code)) { out.textContent = 'Escribe los 6 dígitos que muestra tu app.'; f.elements.code.focus(); return; }
  busy(f, true);
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enrollingFactor, code });
  busy(f, false);
  if (error) { out.textContent = authError(error); f.elements.code.select(); return; }
  enrollingFactor = null; f.hidden = true; f.reset();
  await render2fa();
  toast('2FA activado. Guarda bien tu app: la necesitarás para entrar.');
});

// ---------- Acciones de cuenta ----------
async function portalLink(kind) {
  const out = $('[data-cancel-out]');
  out.textContent = 'Abriendo el portal de Paddle…';
  const { data, error } = await sb.functions.invoke('billing-portal', { method: 'POST' });
  const url = !error && data && (kind === 'cancel' ? data.cancel || data.portal : data.portal);
  if (!url || !/^https:\/\/[a-z0-9.-]*paddle\.com\//i.test(url)) { out.textContent = 'No pudimos abrir el portal. Inténtalo de nuevo en unos minutos.'; return; }
  out.textContent = '';
  location.href = url;
}
const actions = {
  portal() { return portalLink('portal'); },
  'cancel-sub'() { return portalLink('cancel'); },
  async logout() {
    await sb.auth.signOut();
    toast('Sesión cerrada.');
    if (location.hash === '#/') route(); else location.hash = '#/';
  },
  async resend() {
    const out = $('[data-resend-out]');
    if (!pendingEmail) { out.textContent = 'Vuelve a registrarte o inicia sesión para reenviar el email.'; return; }
    const view = out.closest('[data-view]');
    const resendToken = captchaToken(view);
    if (!resendToken) { out.textContent = NO_CAPTCHA; return; }
    const { error } = await sb.auth.resend({ type: 'signup', email: pendingEmail, options: { emailRedirectTo: redirectTo('app'), captchaToken: resendToken } });
    captchaUsed(view);
    out.textContent = error ? authError(error) : 'Email reenviado. Revisa también la carpeta de spam.';
  },
  async '2fa'() {
    const out = $('[data-2fa-out]');
    // Limpia intentos de alta anteriores sin terminar
    const { data: list } = await sb.auth.mfa.listFactors();
    for (const fct of (list ? list.all : []).filter(x => x.status === 'unverified')) await sb.auth.mfa.unenroll({ factorId: fct.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'App ' + Date.now() });
    if (error) { out.textContent = authError(error); return; }
    enrollingFactor = data.id;
    const qr = Object.assign(document.createElement('img'), {
      className: 'qr', width: 180, height: 180, alt: 'Código QR para tu app de autenticación',
      src: data.totp.qr_code // data:image/svg+xml generado por Supabase
    });
    $('[data-2fa-qr]').replaceChildren(qr);
    $('[data-2fa-secret]').textContent = data.totp.secret;
    $('[data-2fa-form]').hidden = false;
    $('[data-action="2fa"]').hidden = true;
    out.textContent = 'Escanea el código con Google Authenticator, 1Password o similar y escribe el código que te muestre.';
    $('#t-code').focus();
  },
  async '2fa-off'() {
    if (!confirm('¿Desactivar el 2FA? Tu cuenta quedará protegida solo por la contraseña.')) return;
    const { data } = await sb.auth.mfa.listFactors();
    for (const fct of (data ? data.totp : [])) {
      const { error } = await sb.auth.mfa.unenroll({ factorId: fct.id });
      if (error) { $('[data-2fa-out]').textContent = authError(error); return; }
    }
    await sb.auth.refreshSession();
    $('[data-2fa-out]').textContent = '2FA desactivado.';
    await render2fa();
  },
  async export() {
    const { data: m, error } = await sb.from('monitors').select('*');
    const { data: p } = await sb.from('profiles').select('*').single();
    if (error) { $('[data-data-out]').textContent = 'No se pudo exportar. Inténtalo de nuevo.'; return; }
    const data = { cuenta: { email: session.user.email, creada: session.user.created_at, perfil: p }, monitores: m, exportado: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'latido-mis-datos.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('[data-data-out]').textContent = 'Descarga iniciada.';
  },
  async delete() {
    if (!confirm('¿Borrar tu cuenta? Se eliminarán tu perfil y todos tus monitores. Esta acción no se puede deshacer.')) return;
    const { error } = await sb.rpc('delete_my_account');
    if (error) { $('[data-data-out]').textContent = error.code === 'P0001' ? error.message : 'No se pudo borrar la cuenta. Inténtalo de nuevo.'; return; }
    await sb.auth.signOut({ scope: 'local' });
    location.hash = '#/';
    toast('Tu cuenta y tus datos se han borrado.');
  }
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action]) actions[b.dataset.action]();
});


// ---------- Router ----------
const PROTECTED = new Set(['/app']);
function route() {
  if (location.hash === '#main') { $('#main').focus(); return; }
  const raw = location.hash.slice(1) || '/';
  const [pathPart, anchor] = raw.split('#');
  const [path, query] = (pathPart || '/').split('?');
  if (PROTECTED.has(path) && (!session || mfaNeeded)) {
    if (mfaNeeded) { $('[data-totp]').hidden = false; }
    location.replace('#/login'); return;
  }
  if (path === '/verifica' && !pendingEmail) { location.replace('#/registro'); return; }
  if (path === '/checkout' && !CFG.paddle.enabled) { location.replace('#/#precios'); toast('Los planes de pago llegarán pronto. Por ahora puedes usar el plan Gratis.'); return; }
  if (path === '/checkout' && (!session || mfaNeeded)) { try { sessionStorage.setItem('latido-next', location.hash); } catch { /* sin almacenamiento */ } location.replace('#/login'); return; }
  const views = $$('[data-view]');
  const view = views.find(v => v.dataset.view === path) || views.find(v => v.dataset.view === '404');
  views.forEach(v => { v.hidden = v !== view; });
  mountCaptcha(view);
  if (path === '/checkout') renderCheckout(new URLSearchParams(query));
  if (path === '/app') loadDash();
  if (path === '/verifica') $('[data-verify-email]').textContent = pendingEmail;
  const signedIn = !!session && !mfaNeeded;
  $$('[data-guest]').forEach(el => { el.hidden = signedIn; });
  $$('[data-user]').forEach(el => { el.hidden = !signedIn; });
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

/** Tras pagar, el plan lo activa el webhook firmado de Paddle (no el navegador): esperamos a verlo. */
async function waitForPlan() {
  toast('Pago recibido. Activando tu plan…');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { data } = await sb.from('profiles').select('plan').maybeSingle();
    if (data && data.plan !== 'free') { toast('¡Listo! Tu plan ya está activo.'); if (location.hash === '#/app') loadDash(); return; }
  }
  toast('Tu pago está confirmado; el plan puede tardar unos minutos en activarse. Recarga más tarde.');
}

// ---------- Arranque ----------
// Pagos desactivados: los planes de pago se muestran como "Próximamente" (el servidor tampoco da planes)
if (!CFG.paddle.enabled) $$('[data-plan-link]').forEach(a => {
  const soon = document.createElement('span');
  soon.className = a.className + ' is-soon'; soon.textContent = 'Próximamente'; soon.setAttribute('aria-disabled', 'true');
  a.replaceWith(soon);
});
renderHero();
sb.auth.onAuthStateChange((event, s) => {
  session = s;
  // Sin llamadas a Supabase dentro del callback (evita bloqueos de la librería)
  if (event === 'PASSWORD_RECOVERY') setTimeout(() => { location.hash = '#/nueva-clave'; });
  if (event === 'SIGNED_OUT') { mfaNeeded = false; profile = plan = null; monitors = []; setTimeout(route); }
});
(async () => {
  // Vuelta desde un enlace de email (?r=app / ?r=nueva-clave): la librería canjea el código PKCE
  const params = new URLSearchParams(location.search);
  const back = params.get('r');
  const linkError = params.get('error_description');
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session) await refreshMfa();
  if (back || linkError || params.has('code')) {
    const next = back === 'nueva-clave' ? '#/nueva-clave' : '#/app';
    history.replaceState(null, '', location.pathname + (session ? next : '#/login'));
    if (params.get('pago') === 'ok') waitForPlan();
    if (linkError) toast('El enlace no es válido o ya caducó. Pide uno nuevo.');
    else if (!session && back === 'app') toast('Email confirmado. Ya puedes iniciar sesión.');
  }
  window.addEventListener('hashchange', route);
  route();
})();
