// Llamadas a la base de datos como servidor desde las Edge Functions (sin dependencias).
const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function serviceHeaders(): Record<string, string> {
  const h: Record<string, string> = { apikey: SERVICE_KEY, 'content-type': 'application/json' };
  // Las claves antiguas (JWT) van también en Authorization; las nuevas sb_secret_ solo en apikey
  if (SERVICE_KEY.startsWith('eyJ')) h.authorization = `Bearer ${SERVICE_KEY}`;
  return h;
}

export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: serviceHeaders(), body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json() as T;
}

/** Usuario dueño del token de sesión que envía el navegador, o null. */
export async function userFromToken(authorization: string | null): Promise<{ id: string; email: string } | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const res = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, authorization } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: u.id, email: u.email } : null;
}
