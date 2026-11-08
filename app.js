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
    s.textContent = `${m.client} · ${m.state === 'warn' ? 'lento ' + m.ms + ' ms' : m.ms + ' ms'}`;
    name.append(b, s);
    li.append(dot(m.state), name, bars(m.name));
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

  formMsg(f, 'Creando tu cuenta…', true);
  const { error } = await sb.auth.signUp({
    email, password: pass,
    options: { emailRedirectTo: redirectTo('app'), data: { name, marketing: f.elements.marketing.checked } }
  });
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
    location.hash = '#/app';
    return;
  }

  const email = f.elements.email.value.trim().toLowerCase();
  const pass = f.elements.password.value;
  if (!EMAIL_RE.test(email) || !pass) {
    formMsg(f, 'Escribe un email válido y tu contraseña.');
    (!EMAIL_RE.test(email) ? f.elements.email : f.elements.password).focus();
    return;
  }
  busy(f, true);
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
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
  location.hash = '#/app';
});

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
  busy(f, true);
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo('nueva-clave') });
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
}
$('[data-checkout]').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!f.elements.start.checked) { setMsg(f, 'start', 'Marca la casilla para empezar ya.'); return; }
  setMsg(f, 'start', '');
  formMsg(f, 'Los pagos con Paddle se activan en la próxima fase. Mientras tanto puedes usar el plan Gratis.', true);
});

// ---------- Panel ----------
let profile = null, plan = null, monitors = [];

async function loadDash() {
  const [p, m] = await Promise.all([
    sb.from('profiles').select('name, plan, plans(name, max_monitors, min_interval)').single(),
    sb.from('monitors').select('id, name, url, client, interval_seconds, created_at').order('created_at')
  ]);
  if (p.error || m.error) { toast('No pudimos cargar tus datos. Recarga la página.'); return; }
  profile = p.data; plan = p.data.plans; monitors = m.data;
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
    sp.append(b, sm); svc.append(dot('new'), sp);
    const cl = document.createElement('td'); cl.textContent = m.client || '—';
    const hist = document.createElement('td'); hist.className = 'muted small'; hist.textContent = 'Sin datos aún';
    const ms = document.createElement('td'); ms.className = 'mono';
    ms.textContent = m.interval_seconds < 60 ? `cada ${m.interval_seconds} s` : `cada ${m.interval_seconds / 60} min`;
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

function renderDash() {
  if (!plan) return;
  renderMonitors(); renderIntervals();
  $('[data-account-line]').textContent = `Panel · ${session.user.email}`;
  $('[data-plan-line]').textContent = `Plan ${plan.name}`;
  $('[data-sub-line]').textContent = profile.plan === 'free' ? 'Plan Gratis · sin cobros.' : `Plan ${plan.name}.`;
  $('[data-stat-count]').textContent = monitors.length;
  $('[data-stat-down]').textContent = '—';
  $('[data-stat-uptime]').textContent = '—';
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
    .select('id, name, url, client, interval_seconds, created_at').single();
  busy(f, false);
  if (error) {
    // Los límites del plan los aplica la base de datos (código P0001, mensaje en español)
    formMsg(f, error.code === 'P0001' ? error.message : 'No se pudo añadir el monitor. Inténtalo de nuevo.');
    return;
  }
  monitors.push(data);
  f.reset();
  renderDash();
  formMsg(f, 'Monitor guardado. Las comprobaciones automáticas se activan en la próxima fase.', true);
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
  setMsg(f, 'url', 'Vista previa de un envío firmado (aún no se guarda):', true);
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event: 'monitor.down', monitor: 'Web principal', at: ts });
  const sig = await hmacHex('whsec_vista_previa', `${ts}.${body}`);
  out.textContent = `POST ${r.url.href}\nLatido-Timestamp: ${ts}\nLatido-Signature: v1=${sig}\n\n${body}`;
  out.hidden = false;
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
const actions = {
  async logout() {
    await sb.auth.signOut();
    toast('Sesión cerrada.');
    if (location.hash === '#/') route(); else location.hash = '#/';
  },
  async resend() {
    const out = $('[data-resend-out]');
    if (!pendingEmail) { out.textContent = 'Vuelve a registrarte o inicia sesión para reenviar el email.'; return; }
    const { error } = await sb.auth.resend({ type: 'signup', email: pendingEmail, options: { emailRedirectTo: redirectTo('app') } });
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

// ---------- Página de estado pública de ejemplo (sin URLs ni IPs) ----------
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
  if (PROTECTED.has(path) && (!session || mfaNeeded)) {
    if (mfaNeeded) { $('[data-totp]').hidden = false; }
    location.replace('#/login'); return;
  }
  if (path === '/verifica' && !pendingEmail) { location.replace('#/registro'); return; }
  const views = $$('[data-view]');
  const view = views.find(v => v.dataset.view === path) || views.find(v => v.dataset.view === '404');
  views.forEach(v => { v.hidden = v !== view; });
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

// ---------- Arranque ----------
renderHero();
renderStatus();
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
    if (linkError) toast('El enlace no es válido o ya caducó. Pide uno nuevo.');
    else if (!session && back === 'app') toast('Email confirmado. Ya puedes iniciar sesión.');
  }
  window.addEventListener('hashchange', route);
  route();
})();
