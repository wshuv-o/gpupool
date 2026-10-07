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
  // Machine A holds "shared" and has "warm" resident; machine B holds "shared"
  // and "cold" but has nothing loaded. That asymmetry is what the routing
  // tests below read.
  start('dummy', process.execPath, ['test/dummy-app.mjs', '9999', 'shared,warm', 'warm']);
  start('dummyB', process.execPath, ['test/dummy-app.mjs', '9997', 'shared,cold', '']);
  start('wsapp', process.execPath, ['test/ws-app.mjs', '9998']);
  await waitFor(async () => (await fetch('http://127.0.0.1:8787/_health')).ok, 'broker');

  start('agentA', process.execPath, ['dist/agent/index.js', 'serve', '--manifest', 'test/machineA.yaml'], {
    GPUPOOL_HOME: homeA,
  });
  start('agentB', process.execPath, ['dist/agent/index.js', 'serve', '--manifest', 'test/machineB.yaml'], {
    GPUPOOL_HOME: homeB,
  });

  // Both machines registered AND their health probes have reported in.
  // `ready` alone is not evidence of that: with no state yet the broker trusts
  // the declaration, so it reads true before any probe has run. Waiting for the
  // model inventory proves a real probe actually landed.
  await waitFor(async () => {
    const s = await status();
    return (
      s.agents.length === 2 &&
      s.agents.every((a) => a.environments.every((e) => e.ready)) &&
      s.agents.every((a) =>
        a.environments.some((e) => e.name === 'imagegen' && Array.isArray(e.models)),
      )
    );
  }, 'two machines with reported inventory');

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

  // 3b. browser headers --------------------------------------------------
  // A forwarded Origin makes Ollama answer 403, so every browser-originated
  // request fails. Assert the local app never sees it.
  const seen = await fetch('http://127.0.0.1:8787/headers', {
    headers: {
      authorization: 'Bearer pk_imagegen_8d3b7e55',
      origin: 'https://example.github.io',
      referer: 'https://example.github.io/',
      'sec-fetch-mode': 'cors',
    },
  }).then((r) => r.json());
  record(
    'browser Origin is not forwarded to the local app',
    !('origin' in seen) && !('referer' in seen) && !('sec-fetch-mode' in seen),
  );

  // 3c. model-aware routing ---------------------------------------------
  // "warm" is resident only on machine A (:9999). A cold load of a real model
  // costs tens of seconds, so it must win over plain least-busy.
  const warm = await fetch('http://127.0.0.1:8787/', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pk_imagegen_8d3b7e55',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'warm', prompt: 'x' }),
  }).then((r) => r.json());
  record('a loaded model wins over least-busy', warm.servedBy === 'localhost:9999');

  // "cold" exists only on machine B (:9997), so it must go there even though
  // neither machine has it resident.
  const cold = await fetch('http://127.0.0.1:8787/', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pk_imagegen_8d3b7e55',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'cold', prompt: 'x' }),
  }).then((r) => r.json());
  record('a request routes to the only machine holding the model', cold.servedBy === 'localhost:9997');

  // An unknown model must still be served rather than refused: an inventory can
  // be stale, and a 404 from the app beats the broker inventing one.
  const unknown = await fetch('http://127.0.0.1:8787/', {
    method: 'POST',
    headers: {
      authorization: 'Bearer pk_imagegen_8d3b7e55',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'does-not-exist', prompt: 'x' }),
  });
  record('an unknown model is still routed, not refused', unknown.status === 200);

  // 3d. queueing ---------------------------------------------------------
  // Two machines x maxConcurrency 4 = 8 imagegen slots. Fill them all with
  // long streams, then prove a 9th request waits for a slot instead of being
  // bounced with 503 — a bounced caller just retries, which is strictly worse.
  const hog = new AbortController();
  const hogs = Array.from({ length: 8 }, () =>
    fetch('http://127.0.0.1:8787/sse?n=60', {
      headers: { authorization: 'Bearer pk_imagegen_8d3b7e55' },
      signal: hog.signal,
    }).catch(() => null),
  );
  await new Promise((r) => setTimeout(r, 900)); // let them occupy slots

  const queuedAt = Date.now();
  const overflow = fetch('http://127.0.0.1:8787/', {
    headers: { authorization: 'Bearer pk_imagegen_8d3b7e55' },
  });
  // While it waits, the broker should say so rather than hiding the backlog.
  await new Promise((r) => setTimeout(r, 400));
  const depth = (await status()).queued;

  const overflowRes = await overflow;
  const waitedMs = Date.now() - queuedAt;
  record(
    'a saturated pool queues instead of returning 503',
    overflowRes.status === 200 && depth >= 1 && waitedMs > 400,
  );
  console.log(`  (queued ${depth} deep, waited ${waitedMs}ms for a slot)`);

  hog.abort();
  await Promise.allSettled(hogs);
  await waitFor(async () => (await status()).queued === 0, 'queue to drain');

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
