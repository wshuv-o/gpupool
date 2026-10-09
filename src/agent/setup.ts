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
  /**
   * Token the root's own agent uses to connect to its own broker. Written at
   * setup because a root that runs a GPU should contribute it — otherwise the
   * machine coordinating the pool is the one machine not in it.
   */
  selfToken: string;
  /** environment name -> app key. One per service, not one per pool. */
  appKeys: Record<string, string>;
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
  /**
   * Environments this machine found locally. A key is minted per environment,
   * never one for the pool: machines contribute different things — Ollama on
   * one, vLLM on another — and a single key bound to one name leaves the rest
   * connected, healthy and unreachable.
   *
   * Environments that appear later, on other machines or at runtime, get keys
   * from the broker automatically; see /_routes.
   */
  environments: string[];
  corsOrigin: string;
}): { config: RootConfig; created: boolean } {
  const dir = rootDir();
  const path = join(dir, 'broker.config.json');

  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as {
      port?: number;
      adminKey?: string;
      appKeys?: Record<string, string>;
      agentTokens?: string[];
    };
    const appKeys: Record<string, string> = {};
    for (const [k, env] of Object.entries(existing.appKeys ?? {})) appKeys[env] = k;
    return {
      created: false,
      config: {
        port: existing.port ?? opts.port,
        adminKey: existing.adminKey ?? '',
        selfToken: (existing.agentTokens ?? [])[0] ?? '',
        appKeys,
        dir,
      },
    };
  }

  const appKeys: Record<string, string> = {};
  for (const env of opts.environments.length ? opts.environments : ['default']) {
    appKeys[env] = key('pk');
  }

  const config: RootConfig = {
    port: opts.port,
    adminKey: key('admin'),
    selfToken: key('ag', 24),
    appKeys,
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
        agentTokens: [config.selfToken],
        // Stored key -> environment, which is what the broker reads.
        appKeys: Object.fromEntries(
          Object.entries(config.appKeys).map(([env, k]) => [k, env]),
        ),
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
      const kept = loadManifest(manifestPath).environments;
      // Detection is skipped for an existing file, so an old or copied one decides what this
      // machine registers as. Say so, rather than let it look like this machine was inspected.
      console.log(`\n(keeping your existing ${resolve(manifestPath)} - delete it to re-detect)`);
      return kept;
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
