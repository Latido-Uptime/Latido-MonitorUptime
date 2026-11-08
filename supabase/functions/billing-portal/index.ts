// Portal de cliente de Paddle: el usuario ve sus facturas, cambia la tarjeta o CANCELA en un clic.
// Solo para usuarios con sesión; cada uno obtiene únicamente el enlace de su propia suscripción.
import { rpc, userFromToken } from '../_shared/supabase.ts';

const API_KEY = Deno.env.get('PADDLE_API_KEY') ?? '';
const PADDLE_API = Deno.env.get('PADDLE_ENV') === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
const ORIGINS = new Set(['https://latidouptime.com', 'http://127.0.0.1:8765', 'http://localhost:8765']);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'access-control-allow-origin': ORIGINS.has(origin) ? origin : 'https://latidouptime.com',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin'
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'content-type': 'application/json' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'método no permitido' });
  if (!API_KEY) return json(req, 500, { error: 'sin configurar' });

  const user = await userFromToken(req.headers.get('authorization'));
  if (!user) return json(req, 401, { error: 'inicia sesión' });

  const rows = await rpc<{ paddle_customer_id: string; paddle_subscription_id: string }[]>('paddle_ids_for', { p_user: user.id });
  if (!rows.length) return json(req, 404, { error: 'no tienes una suscripción de pago' });
  const { paddle_customer_id: customer, paddle_subscription_id: subscription } = rows[0];

  const res = await fetch(`${PADDLE_API}/customers/${encodeURIComponent(customer)}/portal-sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subscription_ids: [subscription] })
  });
  if (!res.ok) { console.error('portal-sessions', res.status, (await res.text()).slice(0, 300)); return json(req, 502, { error: 'Paddle no respondió' }); }
  const { data } = await res.json();
  return json(req, 200, {
    portal: data?.urls?.general?.overview ?? null,
    cancel: data?.urls?.subscriptions?.[0]?.cancel_subscription ?? null
  });
});
