import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import type { EnvironmentDecl } from '../shared/protocol.js';

/** Credentials written once at pairing, then reused forever. */
export interface Credentials {
  broker: string;
  token: string;
  agentId: string;
  label: string;
  /**
   * Token for the local control API. Written here so an application on this
   * machine can read it from a file it already has to know about, rather than
   * being handed a secret out of band.
   */
  controlToken?: string;
}

export interface AgentManifest {
  environments: EnvironmentDecl[];
  maxConcurrency: number;
  healthIntervalMs: number;
  /**
   * Loopback port for the control API an application uses to publish a port it
   * opened at runtime. 0 disables it, which is right for a machine whose
   * environments never change.
   */
  controlPort: number;
}

/**
 * GPUPOOL_HOME relocates the config dir, which allows several agents on one
 * machine — useful for testing, and for a box whose GPUs you want to offer to
 * separate pools.
 */
export function credentialsPath(): string {
  return join(process.env.GPUPOOL_HOME ?? join(homedir(), '.gpupool'), 'credentials.json');
}

export function loadCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Credentials;
}

export function saveCredentials(creds: Credentials): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  return path;
}

/** A fresh agentId per machine; stable across restarts once written. */
export function newAgentId(): string {
  return `ag_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function defaultLabel(): string {
  return hostname().toLowerCase();
}

interface ManifestFile {
  controlPort?: number;
  environments?: Record<
    string,
    { port: number; health?: string; host?: string } | number
  >;
  maxConcurrency?: number;
  healthIntervalMs?: number;
}

/**
 * Reads gpupool.yaml (or .json). Environments may be given longhand or as a
 * bare port number, since a port is all most setups need.
 */
export function loadManifest(path: string): AgentManifest {
  if (!existsSync(path)) {
    throw new Error(
      `No manifest at ${path}. Create one:\n\nenvironments:\n  myapp:\n    port: 11434\n    health: /api/tags\n`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const file = (path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)) as ManifestFile;

  const environments: EnvironmentDecl[] = [];
  for (const [name, value] of Object.entries(file.environments ?? {})) {
    const decl = typeof value === 'number' ? { port: value } : value;
    if (!decl || typeof decl.port !== 'number') {
      throw new Error(`Environment "${name}" needs a port.`);
    }
    environments.push({
      name,
      port: decl.port,
      health: typeof decl === 'object' ? decl.health : undefined,
      host: (typeof decl === 'object' ? decl.host : undefined) ?? '127.0.0.1',
    });
  }

  if (environments.length === 0) {
    throw new Error(`Manifest ${path} declares no environments.`);
  }

  return {
    environments,
    maxConcurrency: file.maxConcurrency ?? 4,
    healthIntervalMs: file.healthIntervalMs ?? 10_000,
    controlPort: file.controlPort ?? 0,
  };
}
