/**
 * Proves the tunnel streams rather than buffers.
 *
 * A proxy that collects the whole response and forwards it at the end still
 * looks correct to a client — you only catch it by timing the gaps between
 * chunks. If first-chunk latency is well below total duration and arrivals are
 * spread out, tokens really are flowing through live.
 */
const url = process.argv[2] ?? 'http://127.0.0.1:8787/v1/chat/completions';
const key = process.argv[3] ?? 'pk_chatapp_4a91f0e2';
const model = process.argv[4] ?? 'gpt-oss-64k:latest';

const t0 = performance.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    stream: true,
    max_tokens: 80,
    messages: [{ role: 'user', content: 'Count from 1 to 20, comma separated. Nothing else.' }],
  }),
});

console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type')}`);
console.log(`transfer-encoding: ${res.headers.get('transfer-encoding') ?? '(none)'}`);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}

const arrivals = [];
let text = '';
const decoder = new TextDecoder();

for await (const chunk of res.body) {
  const at = performance.now() - t0;
  arrivals.push(at);
  const raw = decoder.decode(chunk, { stream: true });
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '';
    } catch {
      /* partial frame across a chunk boundary; harmless for this test */
    }
  }
}

const total = performance.now() - t0;
const first = arrivals[0] ?? 0;
const last = arrivals.at(-1) ?? 0;
const gaps = arrivals.slice(1).map((a, i) => a - arrivals[i]);
const maxGap = gaps.length ? Math.max(...gaps) : 0;

console.log(`\nnetwork chunks:    ${arrivals.length}`);
console.log(`first chunk at:    ${first.toFixed(0)} ms`);
console.log(`last chunk at:     ${last.toFixed(0)} ms`);
console.log(`total:             ${total.toFixed(0)} ms`);
console.log(`largest gap:       ${maxGap.toFixed(0)} ms`);
console.log(`spread:            ${(last - first).toFixed(0)} ms of arrivals`);
console.log(`\ncompletion: ${JSON.stringify(text.trim().slice(0, 120))}`);

// Buffering shows up as every chunk landing in one burst at the very end.
const streamed = arrivals.length > 2 && last - first > 50 && first < total * 0.9;
console.log(`\nverdict: ${streamed ? 'STREAMING (chunks spread over time)' : 'BUFFERED (all at once)'}`);
process.exit(streamed ? 0 : 1);
