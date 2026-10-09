import { execFile } from 'node:child_process';

import type { GpuInfo } from '../shared/protocol.js';

/**
 * What GPUs this machine has, and how much memory is free right now.
 *
 * Used to break ties in routing: when two machines can both serve a model,
 * the one with more free VRAM is the one that will not have to evict something
 * to do it. Best effort — a machine with no NVIDIA tooling reports nothing and
 * routing falls back to least-busy, which is what it did before this existed.
 */

const PROBE_TIMEOUT_MS = 2000;
/** nvidia-smi costs tens of milliseconds; no point running it per heartbeat. */
const CACHE_MS = 5000;

let cached: { at: number; gpus: GpuInfo[] } | null = null;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
    child.on('error', () => resolve(null));
  });
}

/**
 * Query NVIDIA GPUs. Returns an empty list on any failure — no driver, no
 * nvidia-smi, AMD, Apple silicon, a VM. Absence of information is not an
 * error here, it just means routing cannot use capacity for this machine.
 */
export async function probeGpus(): Promise<GpuInfo[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.gpus;

  const out = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ]);

  const gpus: GpuInfo[] = [];
  if (out) {
    for (const line of out.split('\n')) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 3) continue;
      const totalMb = Number(parts[1]);
      const freeMb = Number(parts[2]);
      if (!Number.isFinite(totalMb) || !Number.isFinite(freeMb)) continue;
      gpus.push({ name: parts[0], totalMb, freeMb });
    }
  }

  cached = { at: now, gpus };
  return gpus;
}

/** Free VRAM across every GPU, which is what routing compares. */
export function totalFreeMb(gpus: GpuInfo[] | undefined): number {
  if (!gpus || gpus.length === 0) return 0;
  return gpus.reduce((n, g) => n + g.freeMb, 0);
}
