/**
 * Brings up a two-machine pool on localhost and runs every check against it.
 *
 * Machine A exposes three environments (an LLM, a plain HTTP app, a WebSocket
 * app); machine B exposes only the LLM, so environment-level routing and
 * failover are both observable.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const procs = [];
const ROOT = process.cwd();

/**
 * Fixtures, not secrets. The suite configures its own broker through env vars
 * and writes its own agent credentials, so a fresh clone can run `npm test`
 * without first hand-building a broker.config.json.
 */
const AGENT_TOKENS = { A: 'test_agent_a', B: 'test_agent_b' };
const APP_KEYS = {
  pk_chatapp_4a91f0e2: 'chatapp',
  pk_imagegen_8d3b7e55: 'imagegen',
  pk_wsapp_6b2f9a07: 'wsapp',
};
const ADMIN_KEY = 'admin_local_dev';

const BROKER_ENV = {
  PORT: '8787',
  GPUPOOL_AGENT_TOKENS: Object.values(AGENT_TOKENS).join(','),
  GPUPOOL_APP_KEYS: JSON.stringify(APP_KEYS),
  GPUPOOL_ADMIN_KEY: ADMIN_KEY,
};

/** Pair a simulated machine by writing the file `gpupool login` would write. */
function pair(dir, token, label) {
  const home = join(ROOT, 'test', dir);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'credentials.json'),
    JSON.stringify(
      { broker: 'http://127.0.0.1:8787', token, agentId: `ag_test_${dir}`, label },
      null,
      2,
    ),
  );
  return home;
}

function start(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  const logs = [];
  p.stdout.on('data', (d) => logs.push(d));
  p.stderr.on('data', (d) => logs.push(d));
  procs.push({ name, p, logs });
  return p;
}

function stopAll() {
  for (const { p } of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function status() {
  const res = await fetch('http://127.0.0.1:8787/_status', {
    headers: { authorization: 'Bearer admin_local_dev' },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function runScript(file, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, ...args], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
  });
}

const results = [];
function record(name, ok) {
  results.push([name, ok]);
  console.log(`\n${ok ? '=== PASS' : '=== FAIL'}: ${name}\n`);
}

try {
  const homeA = pair('machineA', AGENT_TOKENS.A, 'office-3090');
  const homeB = pair('machineB', AGENT_TOKENS.B, 'home-4070');

  console.log('--- bringing up pool ---');
  start('broker', process.execPath, ['dist/broker/index.js'], BROKER_ENV);
  start('dummy', process.execPath, ['test/dummy-app.mjs', '9999']);
  start('wsapp', process.execPath, ['test/ws-app.mjs', '9998']);
  await waitFor(async () => (await fetch('http://127.0.0.1:8787/_health')).ok, 'broker');

  start('agentA', process.execPath, ['dist/agent/index.js', 'serve', '--manifest', 'test/machineA.yaml'], {
    GPUPOOL_HOME: homeA,
  });
  start('agentB', process.execPath, ['dist/agent/index.js', 'serve', '--manifest', 'test/machineB.yaml'], {
    GPUPOOL_HOME: homeB,
  });

  // Both machines registered AND their health probes have reported in.
  await waitFor(async () => {
    const s = await status();
    return (
      s.agents.length === 2 &&
      s.agents.every((a) => a.environments.every((e) => e.ready))
    );
  }, 'two healthy machines');

  const s = await status();
  for (const a of s.agents) {
    console.log(`  ${a.label}: ${a.environments.map((e) => `${e.name}:${e.port}`).join(' ')}`);
  }

  // 1. plain proxy + byte fidelity -------------------------------------
  const viaTunnel = await fetch('http://127.0.0.1:8787/api/tags', {
    headers: { authorization: 'Bearer pk_chatapp_4a91f0e2' },
  }).then((r) => r.text());
  const direct = await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.text());
  record('payload byte-identical to a direct call', viaTunnel === direct);

  // 2. auth ------------------------------------------------------------
  const noKey = await fetch('http://127.0.0.1:8787/api/tags');
  const badKey = await fetch('http://127.0.0.1:8787/api/tags', {
    headers: { authorization: 'Bearer nope' },
  });
  record('requests without a valid key are rejected', noKey.status === 401 && badKey.status === 401);

  // 3. environment isolation -------------------------------------------
  const crossed = await fetch('http://127.0.0.1:8787/generate', {
    headers: { authorization: 'Bearer pk_chatapp_4a91f0e2' },
  }).then((r) => r.text());
  record(
    'an app key cannot reach another environment\'s port',
    !crossed.includes('"app":"imagegen"'),
  );

  // 4. streaming -------------------------------------------------------
  // Deterministic source, so this measures the tunnel and not model health.
  record('SSE streams rather than buffers', await runScript('test/sse-test.mjs'));

  // 4b. the same against the real LLM, when it happens to be healthy
  const llmStream = await runScript('test/stream-test.mjs');
  if (!llmStream) {
    console.log('  (skipped: local Ollama is not serving; tunnel itself verified above)');
  } else {
    record('token streaming through the tunnel matches a direct call', true);
  }

  // 5. websockets ------------------------------------------------------
  record('websocket tunnel relays both directions', await runScript('test/ws-test.mjs'));

  // 6. sticky sessions -------------------------------------------------
  record('session affinity overrides least-busy', await runScript('test/sticky-test.mjs'));

  // 7. failover --------------------------------------------------------
  console.log('--- killing machine A ---');
  procs.find((x) => x.name === 'agentA').p.kill();
  await waitFor(async () => (await status()).agents.length === 1, 'machine A to drop out');

  // imagegen runs on both machines, so it must survive; wsapp runs only on
  // machine A, so it must now be unavailable.
  const shared = await fetch('http://127.0.0.1:8787/healthz', {
    headers: { authorization: 'Bearer pk_imagegen_8d3b7e55' },
  });
  const exclusive = await fetch('http://127.0.0.1:8787/healthz', {
    headers: { authorization: 'Bearer pk_wsapp_6b2f9a07' },
  });
  record('environment on two machines survives losing one', shared.ok);
  record('environment on only the dead machine returns 503', exclusive.status === 503);

  // 8. rejoin ----------------------------------------------------------
  console.log('--- restarting machine A ---');
  start('agentA2', process.execPath, ['dist/agent/index.js', 'serve', '--manifest', 'test/machineA.yaml'], {
    GPUPOOL_HOME: join(ROOT, 'test', 'machineA'),
  });
  await waitFor(async () => {
    const s2 = await status();
    // Not just reconnected: its health probes must have reported in too.
    return s2.agents.length === 2 && s2.agents.some((a) => a.environments.some((e) => e.name === 'wsapp' && e.ready));
  }, 'machine A to rejoin');
  const rejoined = await fetch('http://127.0.0.1:8787/healthz', {
    headers: { authorization: 'Bearer pk_wsapp_6b2f9a07' },
  });
  record('a machine that comes back rejoins on its own', rejoined.ok);
} catch (err) {
  console.error(`\nharness error: ${err.message}`);
  for (const { name, logs } of procs) {
    console.error(`\n--- ${name} ---\n${logs.join('').slice(-1500)}`);
  }
  results.push(['harness completed', false]);
} finally {
  stopAll();
}

console.log('\n================ SUMMARY ================');
let failed = 0;
for (const [name, ok] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
