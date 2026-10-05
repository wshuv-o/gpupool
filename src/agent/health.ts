import { request } from 'node:http';
import { connect } from 'node:net';

import type { EnvironmentDecl, EnvironmentState } from '../shared/protocol.js';

const PROBE_TIMEOUT_MS = 2500;

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

export async function probeAll(envs: EnvironmentDecl[]): Promise<EnvironmentState[]> {
  return Promise.all(envs.map(probe));
}
