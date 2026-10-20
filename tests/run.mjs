// JetPass test runner: node tests/run.mjs
// Checks the hash code against Node's crypto and makes sure known passwords never change.
// Run with --update to rewrite tests/vectors.json (only when an output change is intended).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, pbkdf2Sync, webcrypto, randomBytes } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const core = html.slice(html.indexOf('/* JP-CORE-START'), html.indexOf('/* JP-CORE-END */'));
const JP = new Function(core + '\nreturn JP;')();

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.error(`FAIL ${name} ${detail}`); }
};
const hex = b => Buffer.from(b).toString('hex');

// 1. Hash functions vs Node crypto, across block boundaries
for (let len = 0; len <= 300; len++) {
  const m = randomBytes(len);
  check(`sha1 len=${len}`, hex(JP.sha1(m)) === createHash('sha1').update(m).digest('hex'));
  check(`sha256 len=${len}`, hex(JP.sha256(m)) === createHash('sha256').update(m).digest('hex'));
  check(`sha512 len=${len}`, hex(JP.sha512(m)) === createHash('sha512').update(m).digest('hex'));
}

// 2. HMAC, including empty and long keys
for (const klen of [0, 1, 20, 63, 64, 65, 127, 128, 129, 200]) {
  const k = randomBytes(klen), m = randomBytes(77);
  check(`hmac-256 key=${klen}`, hex(JP.hmac('SHA-256', k, m)) === createHmac('sha256', k).update(m).digest('hex'));
  check(`hmac-512 key=${klen}`, hex(JP.hmac('SHA-512', k, m)) === createHmac('sha512', k).update(m).digest('hex'));
}

// 3. PBKDF2: pure JS and native path
for (const [p, s, it] of [['secret', 'SERIAL', 1000], ['', 'X', 1000], ['pässwörd', 'Ab-12', 2500]]) {
  const want = pbkdf2Sync(p, s, it, 32, 'sha256').toString('hex');
  const enc = x => new TextEncoder().encode(x);
  check(`pbkdf2Js ${p}/${s}`, hex(JP.pbkdf2Js(enc(p), enc(s), it)) === want);
  check(`pbkdf2 ${p}/${s}`, hex(await JP.pbkdf2(enc(p), enc(s), it)) === want);
}

// 4. Default hex output matches `echo -n "INPUTsecret" | sha256sum`
{
  const out = await JP.generate('  abc123 ', 'secret', { charset: 'hex', length: 64 });
  check('hex = sha256sum', out === createHash('sha256').update('ABC123secret').digest('hex'), out);
}

// 5. Behaviour rules
{
  const d = JP.DEFAULTS;
  const cs = JP.charsetChars(d);
  check('default charset has no Y/Z', !cs.some(c => 'YyZz'.includes(c)));
  check('default charset has no look-alikes', !cs.some(c => '0Oo1lI'.includes(c)));
  check('digits keep 0 and 1', JP.charsetChars({ ...d, charset: 'digits' }).join('') === '0123456789');
  check('empty input gives empty output', (await JP.generate('   ', 's', d)) === '');
  check('trim + case: same password', (await JP.generate(' ab-12 ', 's', d)) === (await JP.generate('AB-12', 's', d)));
  check('secret changes password', (await JP.generate('AB', 's1', d)) !== (await JP.generate('AB', 's2', d)));
  for (let i = 0; i < 200; i++) {
    const pw = await JP.generate('SN' + i, 'k', d);
    if (!(pw.length === 12 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw))) { check('mix rule', false, pw); break; }
  }
  const s = JP.sanitize({ algo: 'HMAC-SHA-512', length: 99, charset: 'custom', custom: 'abc!', prefix: 'X-' });
  check('profile round trip', JSON.stringify(JP.profileDecode(JP.profileEncode(s))) === JSON.stringify(s));
  check('profile default code', JP.profileEncode(d) === 'JP1-e30');
  let bad = false;
  try { JP.profileDecode('garbage'); } catch { bad = true; }
  check('profile rejects garbage', bad);
  check('sanitize clamps length', JP.sanitize({ length: 99 }).length === 64);
}

// 6. Frozen vectors: outputs must never change between versions
const CASES = [
  ['DEFAULT', 'SN-4CE0460D0G', 'MySecret', {}],
  ['no secret', 'SN-4CE0460D0G', '', {}],
  ['unicode', 'Žltá škoda 42', 'tajné heslo', {}],
  ['sha512', 'PF3XK2LM', 'k', { algo: 'SHA-512' }],
  ['sha1', 'PF3XK2LM', 'k', { algo: 'SHA-1' }],
  ['hmac256', 'PF3XK2LM', 'k', { algo: 'HMAC-SHA-256' }],
  ['hmac512', 'PF3XK2LM', 'k', { algo: 'HMAC-SHA-512' }],
  ['pbkdf2', 'PF3XK2LM', 'k', { algo: 'PBKDF2-SHA-256', iter: 1000 }],
  ['order si + sep', 'PF3XK2LM', 'k', { order: 'si', sep: ':' }],
  ['upperdigits', 'ABC', 'k', { charset: 'upperdigits', length: 16 }],
  ['lowerdigits', 'ABC', 'k', { charset: 'lowerdigits', length: 16 }],
  ['pin', 'ABC', 'k', { charset: 'digits', length: 6 }],
  ['symbols', 'ABC', 'k', { charset: 'symbols', length: 20 }],
  ['hex 64+', 'ABC', 'k', { charset: 'hex', length: 64 }],
  ['custom', 'ABC', 'k', { charset: 'custom', custom: 'abcdef', length: 10 }],
  ['long', 'ABC', 'k', { length: 64 }],
  ['no filters', 'ABC', 'k', { noAmbig: false, noYZ: false, mix: false }],
  ['keep case strip', ' a b-c ', 'k', { textCase: 'keep', strip: true }],
  ['affix', 'ABC', 'k', { prefix: 'Bios-', suffix: '!' }],
];
const vecFile = new URL('tests/vectors.json', root);
const actual = {};
for (const [name, input, secret, opts] of CASES) actual[name] = await JP.generate(input, secret, opts);
if (process.argv.includes('--update')) {
  writeFileSync(vecFile, JSON.stringify(actual, null, 2) + '\n');
  console.log('vectors.json updated');
} else {
  const want = JSON.parse(readFileSync(vecFile, 'utf8'));
  for (const name of Object.keys(actual)) check(`vector "${name}"`, want[name] === actual[name], `want ${want[name]} got ${actual[name]}`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
