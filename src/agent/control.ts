import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { EnvironmentDecl } from '../shared/protocol.js';

/**
 * A local API an application on this machine calls to publish a port.
 *
 * The case this exists for: someone clicks a button, your code starts a model
 * on whatever port was free, and that port needs to be reachable through the
 * pool a second later. Declaring environments in a manifest cannot express
 * that — the port did not exist when the manifest was written.
 *
 * Bound to loopback only. Anything that can reach it can publish a port on
 * this machine to the whole pool, so it is deliberately not reachable from the
 * network, and a token is required on top.
 */

export interface ControlHooks {
  /** Current environments, including any published through here. */
  list(): EnvironmentDecl[];
  /** Publish or replace one. Resolves once the root has acknowledged. */
  publish(env: EnvironmentDecl): Promise<void>;
  /** Withdraw one. Resolves once the root has acknowledged. */
  withdraw(name: string): Promise<void>;
  /** The app key the root issued for an environment, once it has one. */
  keyFor(name: string): string | undefined;
  /** The pool's base URL, which is what a caller actually connects to. */
  brokerUrl(): string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, message: string): void {
  send(res, status, { error: { message } });
}

function tokenOk(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // A registration is a handful of fields; anything larger is a mistake.
    if (total > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A name that is safe as a routing key and readable in the dashboard. */
function cleanName(raw: unknown, port: number): string {
  if (typeof raw === 'string' && raw.trim()) {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .slice(0, 48);
    if (cleaned) return cleaned;
  }
  // Without a name, the port is the only thing that distinguishes it.
  return `port-${port}`;
}

export function startControlServer(
  port: number,
  token: string,
  hooks: ControlHooks,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (!tokenOk(req.headers.authorization, token)) {
        fail(res, 401, 'Control token required.');
        return;
      }

      try {
        if (req.method === 'GET' && (path === '/registered' || path === '/')) {
          send(res, 200, {
            broker: hooks.brokerUrl(),
            environments: hooks.list().map((e) => ({
              name: e.name,
              port: e.port,
              health: e.health,
              key: hooks.keyFor(e.name) ?? null,
              url: hooks.brokerUrl(),
            })),
          });
          return;
        }

        if (req.method === 'POST' && path === '/register') {
          const body = (await readJson(req)) as { port?: number; name?: string; health?: string };
          const portNum = Number(body.port);
          if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            fail(res, 400, 'A "port" between 1 and 65535 is required.');
            return;
          }
          const name = cleanName(body.name, portNum);
          await hooks.publish({
            name,
            port: portNum,
            health: typeof body.health === 'string' ? body.health : undefined,
            host: '127.0.0.1',
          });
          const key = hooks.keyFor(name);
          send(res, 200, {
            environment: name,
            port: portNum,
            url: hooks.brokerUrl(),
            key: key ?? null,
            // Said plainly because the alternative is an application caching a
            // key that quietly stopped working.
            note: key
              ? 'Use url + key to reach this port through the pool.'
              : 'Registered, but the root has not issued a key yet. GET /registered shortly.',
          });
          return;
        }

        if (req.method === 'DELETE' && path.startsWith('/register/')) {
          const name = decodeURIComponent(path.slice('/register/'.length));
          await hooks.withdraw(name);
          send(res, 200, { environment: name, withdrawn: true });
          return;
        }

        fail(res, 404, 'Try GET /registered, POST /register, DELETE /register/<name>.');
      } catch (err) {
        fail(res, 400, (err as Error).message);
      }
    })();
  });

  // Loopback only: publishing a port to the whole pool is not something the
  // network should be able to ask for.
  server.listen(port, '127.0.0.1');
  return server;
}
