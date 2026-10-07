/**
 * Security properties, on brokers of their own.
 *
 * These deliberately trigger lockouts and run brokers with deliberately weak
 * configurations, both of which would poison the main suite — a blocked client
 * stays blocked for the whole run.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const procs = [];
const results = [];
const ROOT = process.cwd();

function broker(port, env) {
  const p = spawn(process.execPath, [join(ROOT, 'dist/broker/index.js')], {
    // cwd matters: a broker.config.json in the repo root would supply an admin
    // key and silently invalidate the "no admin key" case below.
    cwd: ROOT + '/test',
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => logs.push(d));
  p.stderr.on('data', (d) => logs.push(d));
  procs.push(p);
  return { proc: p, logs };
}

function record(name, ok) {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/_health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`broker on ${port} never came up`);
}

try {
  // --- a broker with no admin key must not publish its pool ---------------
  const noAdmin = broker(8831, {
    GPUPOOL_APP_KEYS: '{"pk_ok":"env"}',
    GPUPOOL_TOKEN_STORE: '.sec-tokens-1.json',
    GPUPOOL_ADMIN_KEY: '',
  });
  await waitUp(8831);

  const status = await fetch('http://127.0.0.1:8831/_status');
  const invite = await fetch('http://127.0.0.1:8831/_invite', { method: 'POST' });
  record(
    'without an admin key, /_status and /_invite are closed not open',
    status.status === 401 && invite.status === 401,
  );
  record(
    'startup says plainly that admin endpoints are disabled',
    noAdmin.logs.join('').includes('no admin key'),
  );

  // --- repeated guessing gets you blocked --------------------------------
  const limited = broker(8832, {
    GPUPOOL_ADMIN_KEY: 'adm_correct',
    GPUPOOL_APP_KEYS: '{"pk_ok":"env"}',
    GPUPOOL_AUTH_MAX_FAILURES: '4',
    GPUPOOL_AUTH_BLOCK_MS: '4000',
    GPUPOOL_TOKEN_STORE: '.sec-tokens-2.json',
  });
  await waitUp(8832);

  const codes = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch('http://127.0.0.1:8832/api/tags', {
      headers: { authorization: `Bearer pk_guess_${i}` },
    });
    codes.push(r.status);
  }
  record(
    'guessing app keys is blocked after the configured limit',
    codes.slice(0, 4).every((c) => c === 401) && codes.slice(4).every((c) => c === 429),
  );

  // A found key must not let an attacker continue mid-lockout.
  const whileBlocked = await fetch('http://127.0.0.1:8832/api/tags', {
    headers: { authorization: 'Bearer pk_ok' },
  });
  record('a blocked client is refused even with a valid key', whileBlocked.status === 429);

  const blockedRes = await fetch('http://127.0.0.1:8832/_status');
  record(
    'a blocked client is told when to retry',
    blockedRes.status === 429 && Number(blockedRes.headers.get('retry-after')) > 0,
  );

  // --- and is let back in once the block expires --------------------------
  await new Promise((r) => setTimeout(r, 4500));
  const after = await fetch('http://127.0.0.1:8832/_status', {
    headers: { authorization: 'Bearer adm_correct' },
  });
  record('the block lifts on its own', after.status === 200);

  // --- a wrong admin key is still just wrong ------------------------------
  const wrongAdmin = await fetch('http://127.0.0.1:8832/_status', {
    headers: { authorization: 'Bearer adm_wrong' },
  });
  record('a wrong admin key is rejected', wrongAdmin.status === 401);
} finally {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

console.log('\n================ SECURITY ================');
for (const [name, ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
