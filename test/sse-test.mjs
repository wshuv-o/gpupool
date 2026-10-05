/**
 * Times an SSE stream through the tunnel against a deterministic source: 20
 * events, 60ms apart. A proxy that buffers would deliver them in one burst at
 * the end, which is invisible to a client that only inspects the final body.
 */
const broker = process.argv[2] ?? 'http://127.0.0.1:8787';
const key = process.argv[3] ?? 'pk_imagegen_8d3b7e55';

const t0 = performance.now();
const res = await fetch(`${broker}/sse`, { headers: { authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const arrivals = [];
let events = 0;
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  arrivals.push(performance.now() - t0);
  events += (decoder.decode(chunk, { stream: true }).match(/data:/g) ?? []).length;
}

const total = performance.now() - t0;
const first = arrivals[0] ?? 0;
const last = arrivals.at(-1) ?? 0;
const gaps = arrivals.slice(1).map((a, i) => a - arrivals[i]);
const median = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

console.log(`events:          ${events}`);
console.log(`network chunks:  ${arrivals.length}`);
console.log(`first chunk:     ${first.toFixed(0)} ms`);
console.log(`last chunk:      ${last.toFixed(0)} ms`);
console.log(`total:           ${total.toFixed(0)} ms`);
console.log(`median gap:      ${median.toFixed(0)} ms   (source emits every 60 ms)`);

const checks = [
  ['every event arrived', events >= 21],
  ['chunks were not coalesced into one burst', arrivals.length >= 15],
  ['first chunk arrived long before the last', first < last / 4],
  ['pacing matches the source (40-120ms)', median > 40 && median < 120],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
