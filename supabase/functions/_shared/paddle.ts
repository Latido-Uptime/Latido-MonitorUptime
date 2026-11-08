// Verificación de la firma de los webhooks de Paddle (cabecera Paddle-Signature: "ts=…;h1=…").
// HMAC-SHA256 del texto "ts:cuerpo" con el secreto del destino de notificaciones.
// Funciona igual en Deno (Supabase Edge Functions) y en Node (pruebas).

const enc = new TextEncoder();

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** true solo si la firma es válida y reciente (por defecto, máximo 5 minutos: frena reenvíos). */
export async function verifyPaddleSignature(
  rawBody: string, header: string | null, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(';').map(p => p.trim().split('='));
  const ts = parts.find(([k]) => k === 'ts')?.[1];
  const signatures = parts.filter(([k]) => k === 'h1').map(([, v]) => v);
  if (!ts || !/^\d+$/.test(ts) || !signatures.length) return false;
  if (Math.abs(nowSeconds - Number(ts)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${ts}:${rawBody}`);
  return signatures.some(s => timingSafeEqualHex(s, expected));
}
