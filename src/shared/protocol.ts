/**
 * Wire protocol between agent and broker.
 *
 * One WebSocket per agent, dialled OUTBOUND by the agent. Every HTTP request
 * the broker receives is multiplexed over that single socket, keyed by `id`.
 * That is the whole NAT story: the GPU box never listens on a public port.
 */

export const PROTOCOL_VERSION = 1;

/** An app the agent is exposing, as declared in gpupool.yaml. */
export interface EnvironmentDecl {
  /** Logical name. App keys on the broker resolve to this. */
  name: string;
  /** Local port the dev's app listens on. We neither know nor care what it is. */
  port: number;
  /** Optional GET path used to decide liveness. Omit to treat an open port as healthy. */
  health?: string;
  /** Host to reach the app on. Defaults to 127.0.0.1. */
  host?: string;
}

/** Liveness of one environment, as last observed by the agent. */
export interface EnvironmentState {
  name: string;
  ready: boolean;
  /** Populated when ready === false. */
  detail?: string;
  /**
   * Models the app says it can serve. Best effort: absent when the app exposes
   * no inventory endpoint we recognise, which routing treats as "might have
   * anything" rather than "has nothing".
   */
  models?: string[];
  /**
   * Models already resident in VRAM. Routing strongly prefers these — loading
   * a 13 GB model costs tens of seconds, which dwarfs any queueing we might
   * save by sending the request to a less busy machine.
   */
  loaded?: string[];
}

// ---------------------------------------------------------------- agent -> broker

export interface HelloFrame {
  t: 'hello';
  v: number;
  /** Stable per-machine id, generated once at pairing and persisted. */
  agentId: string;
  /** Human label shown in status output, e.g. "office-3090". */
  label: string;
  environments: EnvironmentDecl[];
  /** Requests this machine will accept at once. */
  maxConcurrency: number;
}

/**
 * The machine's environment list changed while it was connected.
 *
 * Declaring environments only in the opening handshake assumes a machine knows
 * at startup everything it will ever serve. That is false the moment an
 * application starts a model on a port chosen at runtime — the case this
 * exists for. The agent sends the whole list rather than a delta, so the
 * broker's view cannot drift out of step with the machine's.
 */
export interface EnvsFrame {
  t: 'envs';
  environments: EnvironmentDecl[];
}

/** One GPU, as the machine reports it. */
export interface GpuInfo {
  name: string;
  totalMb: number;
  freeMb: number;
}

export interface PingFrame {
  t: 'ping';
  activeJobs: number;
  /**
   * GPUs on this machine and their free memory. Absent when the machine has
   * none, or no tooling to ask — which routing reads as "cannot compare", not
   * "has no capacity".
   */
  gpus?: GpuInfo[];
  /** Full liveness snapshot; the broker replaces its view with this. */
  states: EnvironmentState[];
}

/** Response status line + headers. Sent once per request, before any body. */
export interface ResHeadFrame {
  t: 'res_head';
  id: string;
  status: number;
  headers: Record<string, string>;
}

/** A slice of response body. Many per request — this is what makes SSE stream. */
export interface ResChunkFrame {
  t: 'res_chunk';
  id: string;
  /** base64 so the frame stays JSON and stays debuggable. */
  b64: string;
}

export interface ResEndFrame {
  t: 'res_end';
  id: string;
}

/** The local app failed, refused the connection, or vanished mid-response. */
export interface ResErrFrame {
  t: 'res_err';
  id: string;
  message: string;
  /** True when nothing was written yet, so the broker can still send a clean 502. */
  recoverable: boolean;
}

/** The local app accepted the WebSocket upgrade; relaying may begin. */
export interface WsReadyFrame {
  t: 'ws_ready';
  id: string;
  /** Subprotocol the local app selected, echoed back to the client. */
  protocol?: string;
}

/**
 * One WebSocket message in either direction. `binary` is preserved because a
 * client that sent a Buffer must not receive a string back.
 */
export interface WsDataFrame {
  t: 'ws_data';
  id: string;
  b64: string;
  binary: boolean;
}

export interface WsCloseFrame {
  t: 'ws_close';
  id: string;
  code?: number;
  reason?: string;
}

export interface WsErrFrame {
  t: 'ws_err';
  id: string;
  message: string;
}

export type AgentFrame =
  | HelloFrame
  | EnvsFrame
  | PingFrame
  | ResHeadFrame
  | ResChunkFrame
  | ResEndFrame
  | ResErrFrame
  | WsReadyFrame
  | WsDataFrame
  | WsCloseFrame
  | WsErrFrame;

// ---------------------------------------------------------------- broker -> agent

export interface WelcomeFrame {
  t: 'welcome';
  v: number;
  /** Agent pings on this interval; broker evicts at 3x. */
  heartbeatMs: number;
}

/**
 * App keys for the machine's environments, as the broker sees them.
 *
 * An environment created at runtime has no key in anyone's config, so nothing
 * could address it. The broker mints one and tells the agent, which hands it
 * to whichever application asked for the port in the first place.
 *
 * Sent after hello and after any envs frame, so the agent always holds the
 * current set.
 */
export interface EnvKeysFrame {
  t: 'env_keys';
  /** environment name -> app key */
  keys: Record<string, string>;
}

export interface ReqFrame {
  t: 'req';
  id: string;
  env: string;
  method: string;
  /** Path plus query string, forwarded verbatim. */
  path: string;
  headers: Record<string, string>;
  /** Request bodies are buffered at the broker; absent when empty. */
  b64?: string;
}

/** Client hung up. Agent should abort the local request. */
export interface CancelFrame {
  t: 'cancel';
  id: string;
}

export interface PongFrame {
  t: 'pong';
}

/** Ask the agent to open a WebSocket against the local app. */
export interface WsOpenFrame {
  t: 'ws_open';
  id: string;
  env: string;
  path: string;
  headers: Record<string, string>;
  /** Subprotocols the client asked for. */
  protocols?: string[];
}

export type BrokerFrame =
  | WelcomeFrame
  | EnvKeysFrame
  | ReqFrame
  | CancelFrame
  | PongFrame
  | WsOpenFrame
  | WsDataFrame
  | WsCloseFrame;

// ---------------------------------------------------------------- enrolment

/** What POST /_invite returns to an admin. */
export interface InviteResponse {
  code: string;
  expiresAt: number;
}

/** What POST /_join returns to a machine presenting a valid code. */
export interface JoinResponse {
  token: string;
  agentId: string;
  label: string;
}

// ---------------------------------------------------------------- helpers

export function encodeFrame(f: AgentFrame | BrokerFrame): string {
  return JSON.stringify(f);
}

export function decodeFrame<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Headers that must not be forwarded through the tunnel: they describe the
 * hop, not the message, and passing them on corrupts framing.
 */
export const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

export function stripHopHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
