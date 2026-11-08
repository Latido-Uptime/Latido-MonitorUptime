// Prueba la verificación de firmas de Paddle (Node ejecuta el .ts directamente). npm test
import assert from 'node:assert';
import { verifyPaddleSignature, hmacHex } from './_shared/paddle.ts';

const secret = 'pdl_ntfset_prueba';
const body = '{"event_type":"subscription.created","data":{"id":"sub_1"}}';
const now = 1_800_000_000;
const sig = await hmacHex(secret, `${now}:${body}`);
const header = `ts=${now};h1=${sig}`;

assert.strictEqual(await verifyPaddleSignature(body, header, secret, now), true);
// Cuerpo alterado, secreto distinto, firma falsa o ausente: rechazado
assert.strictEqual(await verifyPaddleSignature(body.replace('sub_1', 'sub_2'), header, secret, now), false);
assert.strictEqual(await verifyPaddleSignature(body, header, 'otro_secreto', now), false);
assert.strictEqual(await verifyPaddleSignature(body, `ts=${now};h1=${'0'.repeat(64)}`, secret, now), false);
assert.strictEqual(await verifyPaddleSignature(body, null, secret, now), false);
assert.strictEqual(await verifyPaddleSignature(body, 'basura', secret, now), false);
// Reenvío de un aviso antiguo (más de 5 minutos): rechazado
assert.strictEqual(await verifyPaddleSignature(body, header, secret, now + 301), false);
// Varias firmas (rotación de secreto): vale si alguna coincide
assert.strictEqual(await verifyPaddleSignature(body, `ts=${now};h1=${'a'.repeat(64)};h1=${sig}`, secret, now), true);

console.log('webhook de Paddle: todos los tests pasan');
