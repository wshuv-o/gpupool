/**
 * Stands in for a local app that reports progress over WebSocket — ComfyUI,
 * A1111, a notebook kernel. Echoes what it receives and pushes unprompted
 * progress frames, so the test can prove both directions relay.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 9998);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws.send(JSON.stringify({ type: 'hello', from: `localhost:${port}`, url: req.url }));

  // Unprompted server-push, which is the whole reason these apps use sockets.
  let n = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'progress', step: ++n }));
    if (n >= 3) clearInterval(timer);
  }, 150);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Flip the bytes so the test can tell a real round-trip from an echo of
      // its own buffer, and confirm binary stayed binary.
      ws.send(Buffer.from(data).map((b) => b ^ 0xff), { binary: true });
      return;
    }
    ws.send(JSON.stringify({ type: 'echo', text: data.toString() }));
  });

  ws.on('close', () => clearInterval(timer));
});

server.listen(port, () => console.log(`ws app on ${port} (/ws)`));
