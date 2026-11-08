// Configuración pública de Latido. La clave "publishable" está pensada para ir en el navegador:
// la seguridad la ponen las políticas RLS de la base de datos. NUNCA pongas aquí una clave secreta.
window.LATIDO_CONFIG = Object.freeze({
  supabaseUrl: 'https://udsyguzfvtlpersuwbjl.supabase.co',
  supabaseKey: 'sb_publishable_1iF0LciSu6tzNu3YyEpQRA_EIm0XM__',
  // Cloudflare Turnstile (pública). En local se usa la clave de pruebas oficial de Cloudflare.
  turnstileSiteKey: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '1x00000000000000000000AA'
    : '0x4AAAAAAF4oZeqEclN8vpNC',
  // Paddle Billing. El token de cliente es público; las claves secretas viven solo en Supabase.
  paddle: {
    enabled: false,         // true cuando la cuenta real de Paddle esté aprobada (RUC pendiente)
    environment: 'sandbox', // 'production' cuando Paddle apruebe la cuenta real
    clientToken: 'test_cd459f3dc7755043b320280382b', // test_… (Developer tools → Authentication → Client-side tokens)
    prices: {
      freelancer: { mensual: 'pri_01m6xhx0k2jwwrxxgqt4j78sta', anual: 'pri_01m6xj127v637ye8sc91x0bk6q' },
      agencia:    { mensual: 'pri_01m6xhy9v5yxy38bjhjb29w0ej', anual: 'pri_01m6xj00pa6ksr2k16qgq56c1e' }
    }
  }
});
