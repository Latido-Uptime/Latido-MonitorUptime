// node monitor/test.mjs
import assert from 'node:assert';
import { check } from './check.mjs';
import { transition } from './run.mjs';

// Transiciones: avisar al caer y al volver, nunca repetir avisos
assert.deepStrictEqual(transition(null, true), { next: 'up', alert: null });
assert.deepStrictEqual(transition(null, false), { next: 'down', alert: 'down' });
assert.deepStrictEqual(transition('up', true), { next: 'up', alert: null });
assert.deepStrictEqual(transition('up', false), { next: 'down', alert: 'down' });
assert.deepStrictEqual(transition('down', false), { next: 'down', alert: null });
assert.deepStrictEqual(transition('down', true), { next: 'up', alert: 'up' });

// Anti-SSRF: nunca se conecta a direcciones internas, ni directas ni vía DNS
for (const u of ['http://127.0.0.1', 'http://localhost:5432', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
  const r = await check(u);
  assert.strictEqual(r.ok, false, u); assert.strictEqual(r.status, null, u);
}
const rebinding = await check('https://parece-publico.example.com', { lookup: async () => [{ address: '10.0.0.5', family: 4 }] });
assert.match(rebinding.error, /interna/);

// Comprobación real (se omite sin internet)
const live = await check('https://example.com');
if (live.error && /resuelve|conexión|ENETUNREACH|EAI_AGAIN/i.test(live.error)) console.log('(sin internet: se omite la prueba real)');
else { assert.strictEqual(live.ok, true, JSON.stringify(live)); assert.ok(live.ms > 0); }

console.log('monitor: todos los tests pasan');
