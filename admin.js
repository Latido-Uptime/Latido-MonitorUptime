/* Panel de administración de Latido (latidouptime.com/admin). Los datos solo salen de funciones del
   servidor (admin_overview, admin_users, admin_monitors) que comprueban que quien llama es administrador
   y entró con 2FA; esta página solo los pinta, siempre con textContent porque son datos de los usuarios. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const CFG = window.LATIDO_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true }
});
const fecha = d => d ? new Date(d).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const dia = d => d ? new Date(d).toLocaleDateString('es') : '—';
const num = n => Number(n).toLocaleString('es');
const cada = s => s < 60 ? `${s} s` : `${s / 60} min`;
const PLAN = { free: 'Gratis', freelancer: 'Freelancer', agencia: 'Agencia' };

const STATS = [
  ['cuentas', 'Cuentas'], ['cuentas_verificadas', 'Con email confirmado'], ['cuentas_7_dias', 'Nuevas en 7 días'],
  ['cuentas_30_dias', 'Nuevas en 30 días'], ['activas_7_dias', 'Entraron en 7 días'], ['con_monitores', 'Con algún monitor'],
  ['con_2fa', 'Con 2FA'], ['novedades', 'Aceptan novedades'], ['monitores', 'Monitores'], ['monitores_caidos', 'Monitores caídos'],
  ['monitores_pausados', 'Monitores en pausa'], ['comprobaciones_24h', 'Comprobaciones en 24 h'], ['incidencias_abiertas', 'Incidencias abiertas'],
  ['incidencias_7_dias', 'Incidencias en 7 días'], ['avisos_pendientes', 'Avisos sin enviar'], ['base_de_datos', 'Tamaño de la base']
];

function message(text, link) {
  const p = $('[data-admin-msg]');
  p.replaceChildren(text);
  if (link) { const a = document.createElement('a'); a.href = link.href; a.textContent = link.text; p.append(' ', a); }
  p.hidden = false;
  $('[data-admin]').hidden = true;
}

/** Una fila de tabla: cada valor es texto o un [texto principal, texto secundario]. */
function row(values) {
  const tr = document.createElement('tr');
  for (const v of values) {
    const td = document.createElement('td');
    if (Array.isArray(v)) {
      const b = document.createElement('b'), small = document.createElement('small');
      b.textContent = v[0] ?? '—'; small.textContent = v[1] ?? ''; small.className = 'muted';
      td.append(b, document.createElement('br'), small);
    } else td.textContent = v ?? '—';
    tr.appendChild(td);
  }
  return tr;
}

function render(o, users, monitors) {
  $('[data-stats]').replaceChildren(...STATS.map(([k, label]) => {
    const d = document.createElement('div'), s = document.createElement('span'), b = document.createElement('b');
    s.className = 'mono muted'; s.textContent = label;
    b.textContent = typeof o[k] === 'number' ? num(o[k]) : o[k];
    d.append(s, b);
    return d;
  }));
  $('[data-plans]').textContent = 'Cuentas por plan: ' + (Object.entries(o.planes).map(([p, n]) => `${PLAN[p] || p} ${n}`).join(' · ') || '—');
  $('[data-users]').replaceChildren(...users.map(u => row([
    [u.email, (u.nombre || '') + (u.verificada ? '' : ' · email sin confirmar')],
    PLAN[u.plan] || u.plan, fecha(u.creada), fecha(u.ultimo_acceso),
    u.caidos ? `${u.monitores} (${u.caidos} ${u.caidos === 1 ? 'caído' : 'caídos'})` : String(u.monitores),
    u.con_2fa ? 'Sí' : 'No', u.novedades ? 'Sí' : 'No'
  ])));
  $('[data-monitors]').replaceChildren(...monitors.map(m => row([
    [m.nombre + (m.cliente ? ` · ${m.cliente}` : ''), m.url],
    m.cuenta,
    [m.pausado ? 'en pausa' : m.estado === 'down' ? 'caído' : m.estado === 'up' ? 'funciona' : 'pendiente', m.estado === 'down' ? m.motivo : m.desde && `desde ${fecha(m.desde)}`],
    cada(m.intervalo), fecha(m.ultima), dia(m.ssl_caduca)
  ])));
}

async function load() {
  $('[data-admin-msg]').textContent = 'Cargando…';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { message('Inicia sesión con tu cuenta de administrador para ver el panel.', { href: '/#/login', text: 'Iniciar sesión' }); return; }
  const [o, u, m] = await Promise.all([sb.rpc('admin_overview'), sb.rpc('admin_users'), sb.rpc('admin_monitors')]);
  const error = o.error || u.error || m.error;
  if (error) { message(error.message || 'No se pudo cargar el panel.', { href: '/#/app', text: 'Ir a mi panel' }); return; }
  $('[data-admin-msg]').hidden = true;
  $('[data-admin]').hidden = false;
  $('[data-admin-line]').textContent = `Administración · ${session.user.email}`;
  render(o.data, u.data, m.data);
}

$('[data-refresh]').addEventListener('click', load);
load();
