/**
 * Verifies the WebSocket tunnel end to end: client -> broker -> agent -> app.
 *
 * Checks the things a naive relay gets wrong — server-initiated pushes, binary
 * framing surviving the base64 hop, and the close handshake propagating.
 */
import { WebSocket } from 'ws';

const broker = process.argv[2] ?? 'ws://127.0.0.1:8787';
const key = process.argv[3] ?? 'pk_wsapp_6b2f9a07';

const url = `${broker}/ws?key=${key}&trace=1`;
console.log(`connecting: ${url.replace(key, key.slice(0, 8) + '...')}`);

const ws = new WebSocket(url);
const received = [];
let binaryOk = null;

const done = new Promise((resolveDone, reject) => {
  const bail = setTimeout(() => reject(new Error('timed out after 15s')), 15_000);

  ws.on('open', () => {
    console.log('connected (101 upgrade through the tunnel)');
    ws.send('ping-from-client');
    // 0x01 0x02 0x03 should come back inverted if binary framing survived.
    ws.send(Buffer.from([0x01, 0x02, 0x03]), { binary: true });
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = [...Buffer.from(data)];
      binaryOk = bytes.join(',') === '254,253,252';
      console.log(`  <- binary [${bytes.join(',')}]  ${binaryOk ? 'correct' : 'WRONG'}`);
      return;
    }
    const msg = JSON.parse(data.toString());
    received.push(msg);
    console.log(`  <- ${JSON.stringify(msg)}`);
    // hello + echo + 3 progress frames
    if (received.filter((m) => m.type === 'progress').length >= 3) {
      clearTimeout(bail);
      ws.close(1000, 'test complete');
    }
  });

  ws.on('close', (code) => {
    clearTimeout(bail);
    console.log(`closed with code ${code}`);
    resolveDone();
  });

  ws.on('error', (err) => {
    clearTimeout(bail);
    reject(err);
  });
});

try {
  await done;
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
}

const hello = received.find((m) => m.type === 'hello');
const echo = received.find((m) => m.type === 'echo');
const progress = received.filter((m) => m.type === 'progress');

const checks = [
  ['upgrade reached the local app', Boolean(hello)],
  ['query string forwarded (trace=1)', hello?.url?.includes('trace=1') ?? false],
  ['app key stripped from forwarded path', !(hello?.url ?? '').includes('key=')],
  ['client -> app message relayed', echo?.text === 'ping-from-client'],
  ['server-initiated push relayed', progress.length >= 3],
  ['binary frames survived the hop', binaryOk === true],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nall websocket checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
