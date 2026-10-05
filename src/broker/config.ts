import { readFileSync, existsSync } from 'node:fs';

export interface BrokerConfig {
  port: number;
  /** Tokens a machine may present to enrol. One per machine, issued once. */
  agentTokens: Set<string>;
  /** App key -> environment name. This binding is what isolates one app from another. */
  appKeys: Map<string, string>;
  adminKey: string | null;
  heartbeatMs: number;
  /** Agent is evicted after this long without a ping. */
  staleMs: number;
  maxBodyBytes: number;
  /** 0 disables. Guards against an agent that accepts a job and never answers. */
  requestTimeoutMs: number;
  /**
   * Request header carrying a session id. When a request includes it, the
   * broker prefers the machine that served that session last. Absent header
   * means no affinity, so this changes nothing for stateless callers.
   */
  sessionHeader: string;
  sessionTtlMs: number;
  /**
   * Origins allowed to call the broker from a browser. '*' allows any;
   * otherwise a comma-separated allowlist that is echoed back when matched.
   * Needed because an app key in browser JS is readable anyway, so the
   * meaningful control is which origins may use it.
   */
  corsOrigin: string;
}

interface FileShape {
  port?: number;
  agentTokens?: string[];
  appKeys?: Record<string, string>;
  adminKey?: string;
  corsOrigin?: string;
}

/**
 * Env vars win over the config file, so a deployed broker can be configured
 * entirely through the platform's secret store.
 */
export function loadConfig(path = 'broker.config.json'): BrokerConfig {
  let file: FileShape = {};
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, 'utf8')) as FileShape;
  }

  const agentTokens = new Set<string>(file.agentTokens ?? []);
  for (const t of (process.env.GPUPOOL_AGENT_TOKENS ?? '').split(',')) {
    if (t.trim()) agentTokens.add(t.trim());
  }

  const appKeys = new Map<string, string>(Object.entries(file.appKeys ?? {}));
  if (process.env.GPUPOOL_APP_KEYS) {
    for (const [k, v] of Object.entries(
      JSON.parse(process.env.GPUPOOL_APP_KEYS) as Record<string, string>,
    )) {
      appKeys.set(k, v);
    }
  }

  return {
    port: Number(process.env.PORT ?? file.port ?? 8787),
    agentTokens,
    appKeys,
    adminKey: process.env.GPUPOOL_ADMIN_KEY ?? file.adminKey ?? null,
    heartbeatMs: Number(process.env.GPUPOOL_HEARTBEAT_MS ?? 10_000),
    staleMs: Number(process.env.GPUPOOL_STALE_MS ?? 30_000),
    maxBodyBytes: Number(process.env.GPUPOOL_MAX_BODY ?? 16 * 1024 * 1024),
    requestTimeoutMs: Number(process.env.GPUPOOL_REQUEST_TIMEOUT_MS ?? 600_000),
    sessionHeader: (process.env.GPUPOOL_SESSION_HEADER ?? 'x-gpupool-session').toLowerCase(),
    sessionTtlMs: Number(process.env.GPUPOOL_SESSION_TTL_MS ?? 600_000),
    corsOrigin: process.env.GPUPOOL_CORS_ORIGIN ?? file.corsOrigin ?? '*',
  };
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
