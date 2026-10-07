import { readFileSync, existsSync } from 'node:fs';

export interface BrokerConfig {
  port: number;
  /**
   * Interface to bind. Defaults to all, which is what you want when the broker
   * is itself the public endpoint. Set to 127.0.0.1 when a reverse proxy
   * terminates TLS in front of it — otherwise the broker is also reachable
   * directly on its own port, in plaintext, bypassing that proxy entirely.
   */
  host: string | undefined;
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
   * How long a request may wait for a busy pool before giving up with 503.
   * Generous by default: a queued request is still cheaper for the caller than
   * a bounce and a retry, and generation can legitimately take minutes.
   */
  queueTimeoutMs: number;
  /** Parked requests per environment before new ones are refused outright. */
  queueLimit: number;
  /**
   * Origins allowed to call the broker from a browser. '*' allows any;
   * otherwise a comma-separated allowlist that is echoed back when matched.
   * Needed because an app key in browser JS is readable anyway, so the
   * meaningful control is which origins may use it.
   */
  corsOrigin: string;
  /**
   * Where tokens granted through /_join are kept. Separate from the config
   * file so the operator's hand-written settings are never rewritten by the
   * broker, and so a machine can enrol without a restart.
   */
  tokenStorePath: string;
  /** Invite lifetime. Short: a code is meant to be used straight away. */
  inviteTtlMs: number;
  /**
   * Trust X-Forwarded-For. Turn this ON behind a reverse proxy, or every
   * request looks like it came from 127.0.0.1 and one attacker locks out the
   * whole world. Leave it OFF when the broker faces the internet directly, or
   * a caller spoofs the header for a fresh identity on every request.
   */
  trustProxy: boolean;
  /** Failed authentications from one address before it is blocked. */
  authMaxFailures: number;
  /** Failures spread wider apart than this are treated as unrelated. */
  authWindowMs: number;
  /** How long a blocked address stays blocked. */
  authBlockMs: number;
}

interface FileShape {
  port?: number;
  host?: string;
  agentTokens?: string[];
  appKeys?: Record<string, string>;
  adminKey?: string;
  corsOrigin?: string;
  tokenStorePath?: string;
  trustProxy?: boolean | string;
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
    host: process.env.HOST ?? file.host,
    agentTokens,
    appKeys,
    adminKey: process.env.GPUPOOL_ADMIN_KEY ?? file.adminKey ?? null,
    heartbeatMs: Number(process.env.GPUPOOL_HEARTBEAT_MS ?? 10_000),
    staleMs: Number(process.env.GPUPOOL_STALE_MS ?? 30_000),
    maxBodyBytes: Number(process.env.GPUPOOL_MAX_BODY ?? 16 * 1024 * 1024),
    requestTimeoutMs: Number(process.env.GPUPOOL_REQUEST_TIMEOUT_MS ?? 600_000),
    sessionHeader: (process.env.GPUPOOL_SESSION_HEADER ?? 'x-gpupool-session').toLowerCase(),
    sessionTtlMs: Number(process.env.GPUPOOL_SESSION_TTL_MS ?? 600_000),
    queueTimeoutMs: Number(process.env.GPUPOOL_QUEUE_TIMEOUT_MS ?? 120_000),
    queueLimit: Number(process.env.GPUPOOL_QUEUE_LIMIT ?? 100),
    corsOrigin: process.env.GPUPOOL_CORS_ORIGIN ?? file.corsOrigin ?? '*',
    tokenStorePath:
      process.env.GPUPOOL_TOKEN_STORE ?? file.tokenStorePath ?? 'broker.tokens.json',
    inviteTtlMs: Number(process.env.GPUPOOL_INVITE_TTL_MS ?? 600_000),
    trustProxy: (process.env.GPUPOOL_TRUST_PROXY ?? file.trustProxy ?? '') === 'true' ||
      file.trustProxy === true,
    authMaxFailures: Number(process.env.GPUPOOL_AUTH_MAX_FAILURES ?? 10),
    authWindowMs: Number(process.env.GPUPOOL_AUTH_WINDOW_MS ?? 300_000),
    authBlockMs: Number(process.env.GPUPOOL_AUTH_BLOCK_MS ?? 900_000),
  };
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
