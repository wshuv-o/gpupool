import { request } from 'node:http';
import { connect } from 'node:net';

import type { EnvironmentDecl, EnvironmentState } from '../shared/protocol.js';

const PROBE_TIMEOUT_MS = 2500;
/** Inventory is an optimisation, not liveness — never let it stall a heartbeat. */
const INVENTORY_TIMEOUT_MS = 1500;

/**
 * Is the dev's local app actually answering?
 *
 * With a `health` path we do a real GET, which catches an app that is listening
 * but broken. Without one we settle for a TCP connect, which at least catches
 * the app having exited.
 */
export async function probe(env: EnvironmentDecl): Promise<EnvironmentState> {
  const host = env.host ?? '127.0.0.1';
  if (env.health) {
    return probeHttp(env.name, host, env.port, env.health);
  }
  return probeTcp(env.name, host, env.port);
}

function probeHttp(
  name: string,
  host: string,
  port: number,
  path: string,
): Promise<EnvironmentState> {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path, method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume(); // drain, we only care about the status
        const status = res.statusCode ?? 0;
        resolve(
          status > 0 && status < 500
            ? { name, ready: true }
            : { name, ready: false, detail: `health returned ${status}` },
        );
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ name, ready: false, detail: 'health check timed out' });
    });
    req.on('error', (err) => {
      resolve({ name, ready: false, detail: err.message });
    });
    req.end();
  });
}

function probeTcp(name: string, host: string, port: number): Promise<EnvironmentState> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (state: EnvironmentState) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('connect', () => done({ name, ready: true }));
    socket.on('timeout', () => done({ name, ready: false, detail: 'port connect timed out' }));
    socket.on('error', (err) => done({ name, ready: false, detail: err.message }));
  });
}

/** GET a path and parse JSON, or give up quietly. */
function getJson(host: string, port: number, path: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path, method: 'GET', timeout: INVENTORY_TIMEOUT_MS },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          resolve(null);
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          // An inventory response is small; a huge body means we guessed wrong
          // about the endpoint and should stop reading it.
          if (buf.length > 512 * 1024) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function namesFrom(doc: unknown, key: 'models' | 'data', field: 'name' | 'id'): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const arr = (doc as Record<string, unknown>)[key];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>)[field] : null))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/**
 * Best-effort model inventory.
 *
 * We probe the shapes we know rather than making the user describe their
 * server: Ollama answers /api/ps and /api/tags, anything OpenAI-compatible
 * answers /v1/models. An app we do not recognise simply reports nothing, and
 * routing falls back to least-busy — the behaviour before this existed.
 */
async function inventory(
  host: string,
  port: number,
): Promise<{ models?: string[]; loaded?: string[] }> {
  const [ps, tags] = await Promise.all([
    getJson(host, port, '/api/ps'),
    getJson(host, port, '/api/tags'),
  ]);

  const loaded = namesFrom(ps, 'models', 'name');
  let models = namesFrom(tags, 'models', 'name');

  if (models.length === 0) {
    models = namesFrom(await getJson(host, port, '/v1/models'), 'data', 'id');
  }

  const out: { models?: string[]; loaded?: string[] } = {};
  // Distinguish "nothing loaded" from "cannot tell": only report a key when we
  // actually got an answer, so the broker can tell unknown from empty.
  if (ps !== null) out.loaded = loaded;
  if (models.length > 0) out.models = models;
  return out;
}

export async function probeAll(envs: EnvironmentDecl[]): Promise<EnvironmentState[]> {
  return Promise.all(
    envs.map(async (env) => {
      const state = await probe(env);
      if (!state.ready) return state;
      const inv = await inventory(env.host ?? '127.0.0.1', env.port);
      return { ...state, ...inv };
    }),
  );
}
