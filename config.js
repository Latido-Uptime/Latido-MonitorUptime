// Configuración pública de Latido. La clave "publishable" está pensada para ir en el navegador:
// la seguridad la ponen las políticas RLS de la base de datos. NUNCA pongas aquí una clave secreta.
window.LATIDO_CONFIG = Object.freeze({
  supabaseUrl: 'https://udsyguzfvtlpersuwbjl.supabase.co',
  supabaseKey: 'sb_publishable_1iF0LciSu6tzNu3YyEpQRA_EIm0XM__',
  // Cloudflare Turnstile (pública). En local se usa la clave de pruebas oficial de Cloudflare.
  turnstileSiteKey: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '1x00000000000000000000AA'
    : '0x4AAAAAAF4oZeqEclN8vpNC'
});
