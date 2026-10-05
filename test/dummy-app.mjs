// Stands in for "whatever the dev happens to run locally". Not an LLM, which
// is the point: the tunnel is protocol-agnostic.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9999);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Deterministic SSE source. Streaming has to be testable without depending
  // on a multi-gigabyte model being healthy. `n` controls how long it runs, so
  // a test can also use it to hold a slot open.
  if (url.pathname === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const want = Number(url.searchParams.get('n') ?? 20);
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: {"n":${n}}\n\n`);
      if (n >= want) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 60);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // Lets a test assert which headers actually reached the local app. Ollama,
  // Jupyter and ComfyUI all reject requests carrying a foreign Origin, so the
  // agent must strip it.
  if (url.pathname === '/headers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ app: 'imagegen', servedBy: `localhost:${port}`, path: req.url }));
}).listen(port, () => console.log(`dummy app on ${port}`));
