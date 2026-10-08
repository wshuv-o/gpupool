import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';

import { detectEnvironments, renderManifest } from './detect.js';
import type { EnvironmentDecl } from '../shared/protocol.js';

/**
 * Two-role setup: one machine is the root, the rest are leaves.
 *
 * The underlying pieces — a broker, agent tokens, app keys, a manifest — did
 * not change. What changed is that nobody should have to know they exist to
 * put three machines together. The root generates everything and prints one
 * key; a leaf takes that key and is done.
 */

export interface RootConfig {
  port: number;
  adminKey: string;
  appKey: string;
  environment: string;
  dir: string;
}

function key(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

/** Where a root keeps its broker config and token store. */
export function rootDir(): string {
  return process.env.GPUPOOL_HOME ?? join(homedir(), '.gpupool');
}

/**
 * Write the broker's configuration, generating credentials on first run.
 *
 * Re-running setup must not invalidate machines that already joined, so an
 * existing config is read back rather than replaced.
 */
export function writeRootConfig(opts: {
  port: number;
  environment: string;
  corsOrigin: string;
}): { config: RootConfig; created: boolean } {
  const dir = rootDir();
  const path = join(dir, 'broker.config.json');

  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as {
      port?: number;
      adminKey?: string;
      appKeys?: Record<string, string>;
    };
    const [appKey, environment] = Object.entries(existing.appKeys ?? {})[0] ?? ['', ''];
    return {
      created: false,
      config: {
        port: existing.port ?? opts.port,
        adminKey: existing.adminKey ?? '',
        appKey,
        environment: environment || opts.environment,
        dir,
      },
    };
  }

  const config: RootConfig = {
    port: opts.port,
    adminKey: key('admin'),
    appKey: key('pk'),
    environment: opts.environment,
    dir,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        port: config.port,
        // Bound to every interface on purpose: leaves on the LAN have to reach
        // it. A root exposed to the internet should sit behind a reverse proxy
        // and set host to 127.0.0.1 — see deploy/.
        adminKey: config.adminKey,
        appKeys: { [config.appKey]: config.environment },
        corsOrigin: opts.corsOrigin,
        tokenStorePath: join(dir, 'broker.tokens.json'),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );

  return { config, created: true };
}

/**
 * Find what this machine is already running and write a manifest for it.
 *
 * Returns null when nothing was found, so the caller can say something useful
 * rather than writing an empty manifest that fails later for no clear reason.
 */
export async function writeManifest(manifestPath: string): Promise<EnvironmentDecl[] | null> {
  if (existsSync(manifestPath)) {
    const { loadManifest } = await import('./config.js');
    try {
      return loadManifest(manifestPath).environments;
    } catch {
      return null;
    }
  }
  const found = await detectEnvironments();
  if (found.length === 0) return null;
  mkdirSync(dirname(resolve(manifestPath)), { recursive: true });
  writeFileSync(manifestPath, renderManifest(found));
  return found;
}

/** The LAN addresses a leaf could reach this machine on. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // Virtual adapters (WSL, Hyper-V, Docker) answer on 172.x and are useless to
  // a leaf on the real network, so real LAN ranges come first.
  return out.sort((a, b) => rank(a) - rank(b));
}

function rank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (ip.startsWith('172.')) return 3;
  return 2;
}
