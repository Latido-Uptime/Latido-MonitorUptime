// Receptor de webhooks de Paddle. Sin firma válida no se cree nada: así nadie puede
// mandar un "pago completado" falso. El plan lo decide la base de datos según el precio.
import { verifyPaddleSignature } from '../_shared/paddle.ts';
import { rpc } from '../_shared/supabase.ts';

const SECRET = Deno.env.get('PADDLE_WEBHOOK_SECRET') ?? '';
const EVENTS = new Set([
  'subscription.created', 'subscription.updated', 'subscription.activated', 'subscription.canceled',
  'subscription.paused', 'subscription.resumed', 'subscription.past_due', 'subscription.trialing'
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, text: string) => new Response(text, { status });

Deno.serve(async req => {
  if (req.method !== 'POST') return reply(405, 'método no permitido');
  const raw = await req.text();
  if (raw.length > 1_000_000) return reply(413, 'demasiado grande');
  if (!SECRET) { console.error('falta PADDLE_WEBHOOK_SECRET'); return reply(500, 'sin configurar'); }
  if (!(await verifyPaddleSignature(raw, req.headers.get('paddle-signature'), SECRET))) return reply(401, 'firma inválida');

  let ev;
  try { ev = JSON.parse(raw); } catch { return reply(400, 'json inválido'); }
  if (!EVENTS.has(ev?.event_type)) return reply(200, 'ignorado');

  const d = ev.data ?? {};
  const userId = d.custom_data?.user_id;
  // 200 aunque falte el usuario: reintentarlo no lo arreglaría (pagos hechos fuera de la web)
  if (typeof userId !== 'string' || !UUID.test(userId)) { console.error('suscripción sin user_id válido:', d.id); return reply(200, 'sin usuario'); }

  try {
    const result = await rpc<string>('apply_subscription', {
      p_user: userId,
      p_subscription: d.id,
      p_customer: d.customer_id,
      p_status: d.status,
      p_price: d.items?.[0]?.price?.id ?? null,
      p_period_end: d.current_billing_period?.ends_at ?? null,
      p_scheduled_cancel: d.scheduled_change?.action === 'cancel',
      p_event_at: ev.occurred_at
    });
    console.log(`${ev.event_type} ${d.id}: ${result}`);
    return reply(200, 'ok');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return reply(500, 'error'); // Paddle reintentará
  }
});
