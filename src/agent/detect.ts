import { request } from 'node:http';

import type { EnvironmentDecl } from '../shared/protocol.js';

/**
 * Guess what this machine is already running.
 *
 * Hand-writing a manifest is the step people get wrong: a typo'd port looks
 * exactly like a dead app. Every tool below has a well-known default port and
 * a cheap endpoint that identifies it, so in the common case we can just look.
 */
interface Candidate {
  name: string;
  port: number;
  health: string;
  /** Substring that confirms it really is this tool and not something else. */
  expect?: string;
}

const KNOWN: Candidate[] = [
  { name: 'ollama', port: 11434, health: '/api/tags', expect: 'models' },
  { name: 'comfyui', port: 8188, health: '/system_stats' },
  { name: 'automatic1111', port: 7860, health: '/sdapi/v1/sd-models' },
  { name: 'vllm', port: 8000, health: '/v1/models', expect: 'data' },
  { name: 'textgen', port: 5000, health: '/v1/models', expect: 'data' },
  { name: 'lmstudio', port: 1234, health: '/v1/models', expect: 'data' },
  { name: 'koboldcpp', port: 5001, health: '/api/v1/model' },
];

const PROBE_MS = 1200;

function probe(port: number, path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', timeout: PROBE_MS },
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
          if (buf.length > 64 * 1024) req.destroy();
        });
        res.on('end', () => resolve(buf));
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

/** Everything we can find answering on this machine right now. */
export async function detectEnvironments(): Promise<EnvironmentDecl[]> {
  const found = await Promise.all(
    KNOWN.map(async (c): Promise<EnvironmentDecl | null> => {
      const body = await probe(c.port, c.health);
      if (body === null) return null;
      // A port being open is not proof: something else may own it. When we have
      // a marker, require it rather than claiming a stranger's port.
      if (c.expect && !body.includes(c.expect)) return null;
      return { name: c.name, port: c.port, health: c.health };
    }),
  );
  return found.filter((e): e is EnvironmentDecl => e !== null);
}

/** Render a manifest a human can read and edit afterwards. */
export function renderManifest(envs: EnvironmentDecl[], maxConcurrency = 4): string {
  const lines = [
    '# Written by `gpupool join`. Edit freely — this is yours now.',
    '#',
    '# Each entry exposes one local port through the broker. An app key on the',
    '# broker resolves to one of these names, which is what keeps apps apart.',
    'environments:',
  ];
  for (const e of envs) {
    lines.push(`  ${e.name}:`);
    lines.push(`    port: ${e.port}`);
    if (e.health) lines.push(`    health: ${e.health}`);
  }
  lines.push('');
  lines.push('# Requests this machine will accept at once.');
  lines.push(`maxConcurrency: ${maxConcurrency}`);
  return lines.join('\n') + '\n';
}
