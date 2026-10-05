/**
 * Verifies session affinity *overrides* least-busy selection.
 *
 * A weaker test — fire sequential requests and check they land together —
 * proves nothing, because with every machine idle "least busy" already returns
 * the same one every time. The only way to tell the two apart is to make the
 * affine machine the busier one and check the session still goes there, while
 * an unsessioned request goes elsewhere.
 */
const broker = process.argv[2] ?? 'http://127.0.0.1:8787';
const key = process.argv[3] ?? 'pk_imagegen_8d3b7e55';
const admin = process.argv[4] ?? 'admin_local_dev';

async function status() {
  const res = await fetch(`${broker}/_status`, { headers: { authorization: `Bearer ${admin}` } });
  return res.json();
}

/** Which machine served a single cheap request, via the broker's counters. */
async function whoServed(session) {
  const before = new Map((await status()).agents.map((a) => [a.label, a.served]));
  const headers = { authorization: `Bearer ${key}` };
  if (session) headers['x-gpupool-session'] = session;
  await fetch(`${broker}/healthz`, { headers });
  const after = await status();
  for (const a of after.agents) {
    if (a.served > (before.get(a.label) ?? 0)) return a.label;
  }
  return 'unknown';
}

/**
 * A long-lived stream, so the slot stays occupied while we probe. Uses the
 * test app's SSE endpoint rather than a real generation: affinity is a routing
 * property and should be testable without a working GPU.
 */
function occupy(session) {
  const headers = { authorization: `Bearer ${key}` };
  if (session) headers['x-gpupool-session'] = session;
  return fetch(`${broker}/sse?n=150`, { headers })
    .then((r) => r.text())
    .catch(() => null);
}

const agents = (await status()).agents;
if (agents.length < 2) {
  console.error(`need 2 machines in the pool, found ${agents.length}`);
  process.exit(1);
}

// 1. bind a session and learn where it landed
const bound = await whoServed('session-sticky');
console.log(`session-sticky bound to: ${bound}`);
const other = agents.map((a) => a.label).find((l) => l !== bound);

// 2. make that machine the busiest in the pool, using the same session so the
//    load deliberately piles onto the affine machine
const load = [occupy('session-sticky'), occupy('session-sticky'), occupy('session-sticky')];
await new Promise((r) => setTimeout(r, 2500));

const busy = (await status()).agents.map((a) => `${a.label}=${a.activeJobs}`).join(' ');
console.log(`in-flight while probing:  ${busy}`);

// 3. the discriminating probes
const stickyWent = await whoServed('session-sticky');
const freeWent = await whoServed(undefined);
console.log(`sessioned request went to: ${stickyWent}`);
console.log(`unsessioned request went to: ${freeWent}`);

await Promise.all(load);

const busyCounts = new Map(agents.map((a) => [a.label, 0]));
const checks = [
  ['session stuck to its machine despite it being busier', stickyWent === bound],
  ['unsessioned request preferred the idle machine', freeWent === other],
  ['the two decisions actually differed', stickyWent !== freeWent],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
console.log(
  failed === 0
    ? '\naffinity overrides least-busy, and plain requests still balance'
    : `\n${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
