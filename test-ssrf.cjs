// node test-ssrf.cjs
const assert = require('node:assert');
const { checkUrl, isBlockedIp, resolveAndCheck } = require('./ssrf-guard.js');

const blocked = [
  'http://169.254.169.254/latest/meta-data/', 'http://localhost:5432', 'http://127.0.0.1',
  'http://2130706433', 'http://0x7f.0.0.1', 'http://192.168.1.10', 'http://10.0.0.1',
  'http://172.20.3.4', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/',
  'http://[fe80::1]/', 'http://0.0.0.0', 'http://metadata.google.internal', 'file:///etc/passwd',
  'gopher://example.com', 'ftp://example.com', 'http://user:pass@example.com', 'http://intranet',
  'http://100.64.0.1', 'http://[0:0:0:0:0:0:0:1]', 'http://app.localhost',
  'http://localhost.', 'http://127.1.', 'http://0177.0.0.1', 'http://%6cocalhost',
  'http://[::ffff:169.254.169.254]', 'http://[::127.0.0.1]', 'http://[fec0::1]',
  'http://[64:ff9b:1::808:808]', 'http://[64:ff9b::a00:1]'
];
blocked.push('http://168.63.129.16', 'http://192.0.2.1', 'http://198.51.100.1', 'http://203.0.113.1', 'http://192.88.99.1', 'http://[2002:7f00:1::]', 'http://[2001:0:4136:e378:8000:63bf:80ff:fffe]', 'http://[100::1]', 'http://[2001:db8::1]', 'http://[3fff::1]', 'http://[::ffff:168.63.129.16]');
for (const u of blocked) assert.strictEqual(checkUrl(u).ok, false, 'debería bloquear ' + u);

const allowed = ['https://example.com', 'http://93.184.216.34', 'https://[2606:4700::1111]/', 'https://shop.example.org:8443/health'];
allowed.push('http://192.0.0.9', 'http://192.0.0.10', 'http://[::ffff:192.0.0.9]', 'http://[64:ff9b::808:808]');
for (const u of allowed) assert.strictEqual(checkUrl(u).ok, true, 'debería permitir ' + u);

assert.strictEqual(isBlockedIp('172.15.255.255'), false);
assert.strictEqual(isBlockedIp('172.32.0.0'), false);
assert.strictEqual(isBlockedIp('172.31.255.255'), true);

(async () => {
  // Dominio público que resuelve a IP interna (DNS rebinding / registro A malicioso)
  const evil = await resolveAndCheck('https://evil.example.com', async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }]);
  assert.strictEqual(evil.ok, false);
  const good = await resolveAndCheck('https://good.example.com', async () => [{ address: '93.184.216.34' }]);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.address, '93.184.216.34');
  assert.strictEqual((await resolveAndCheck('https://dns.example', async () => { throw new Error('ENOTFOUND'); })).ok, false);
  assert.strictEqual((await resolveAndCheck('https://dns.example', async () => [])).ok, false);
  assert.strictEqual((await resolveAndCheck('https://dns.example', async () => [{ address: '2002:7f00:1::' }])).ok, false);
  assert.strictEqual(isBlockedIp('1:2:3:4::5:6:7:8'), true);
  assert.strictEqual(isBlockedIp('2606:4700::1%eth0'), true);
  assert.strictEqual(isBlockedIp('0177.0.0.1'), true);
  for (const ip of ['2001:2::1', '2001:db8::1', '3fff::1', '192.88.99.1', '168.63.129.16']) {
    assert.strictEqual((await resolveAndCheck('https://dns.example', async () => [{ address: ip }])).ok, false);
  }
  for (const addresses of [null, [null], [{}], [{ address: 'not-an-ip' }]]) {
    assert.strictEqual((await resolveAndCheck('https://dns.example', async () => addresses)).ok, false);
  }
  console.log('ssrf-guard: todos los tests pasan');
})();
