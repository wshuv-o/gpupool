import type { WebSocket } from 'ws';
import type { ServerResponse } from 'node:http';
import type {
  EnvironmentDecl,
  EnvironmentState,
  GpuInfo,
} from '../shared/protocol.js';
import { encodeFrame } from '../shared/protocol.js';

/** A request in flight: forwarded to an agent, response not yet complete. */
export interface PendingRequest {
  id: string;
  env: string;
  res: ServerResponse;
  agentId: string;
  startedAt: number;
  /** Set once res_head has been written — after that we can no longer send an error status. */
  headersSent: boolean;
  /**
   * CORS headers computed from the original request. Carried here because the
   * response is written later, from a frame handler that no longer has the
   * IncomingMessage.
   */
  cors: Record<string, string>;
}

export class AgentConn {
  readonly pending = new Map<string, PendingRequest>();
  states: EnvironmentState[] = [];
  /** GPUs this machine reported, empty when it has none or cannot tell. */
  gpus: GpuInfo[] = [];
  activeJobs = 0;
  lastSeen = Date.now();
  /** Cumulative requests dispatched to this machine since it connected. */
  served = 0;
  /** Cumulative WebSocket tunnels opened against this machine. */
  socketsOpened = 0;

  constructor(
    readonly agentId: string,
    readonly label: string,
    readonly ws: WebSocket,
    // Not readonly: an application can start a model on a port chosen at
    // runtime, and the machine then serves something it did not know about
    // when it connected.
    public environments: EnvironmentDecl[],
    readonly maxConcurrency: number,
  ) {}

  hasEnvironment(name: string): boolean {
    return this.environments.some((e) => e.name === name);
  }

  /**
   * What this machine said about an environment's models, or null when it
   * never reported — which means "unknown", not "none".
   */
  private inv(name: string): { models?: string[]; loaded?: string[] } | null {
    return this.states.find((s) => s.name === name) ?? null;
  }

  /** Model is resident in VRAM right now, so a request avoids a cold load. */
  hasLoaded(name: string, model: string): boolean {
    return this.inv(name)?.loaded?.includes(model) ?? false;
  }

  /** Model is on disk here. False only when we have an inventory that lacks it. */
  canServe(name: string, model: string): boolean {
    const models = this.inv(name)?.models;
    if (!models) return true; // no inventory: cannot rule the machine out
    return models.includes(model);
  }

  /** True when this machine published an inventory we can reason about. */
  knowsModels(name: string): boolean {
    return this.inv(name)?.models !== undefined;
  }

  /** Declared, and the agent's last health probe said the app is answering. */
  isReady(name: string): boolean {
    if (!this.hasEnvironment(name)) return false;
    const st = this.states.find((s) => s.name === name);
    // Before the first ping we have no state yet; trust the declaration.
    return st ? st.ready : true;
  }

  get hasCapacity(): boolean {
    return this.pending.size < this.maxConcurrency;
  }

  /** Free VRAM across this machine's GPUs; 0 when it reported none. */
  get freeVramMb(): number {
    return this.gpus.reduce((n, g) => n + g.freeMb, 0);
  }

  send(frame: Parameters<typeof encodeFrame>[0]): void {
    if (this.ws.readyState === 1) this.ws.send(encodeFrame(frame));
  }
}

interface Affinity {
  agentId: string;
  expires: number;
}

/** A request parked because every machine serving its environment was busy. */
interface Waiter {
  env: string;
  model?: string;
  sessionKey?: string;
  enqueuedAt: number;
  settle: (agent: AgentConn | null) => void;
  timer: NodeJS.Timeout;
}

export class Registry {
  private agents = new Map<string, AgentConn>();
  /** session key -> machine that served it last, so warm state is reused. */
  private affinity = new Map<string, Affinity>();
  /** Requests waiting for capacity, oldest first. */
  private waiting: Waiter[] = [];

  constructor(private sessionTtlMs = 600_000) {}

  add(agent: AgentConn): void {
    // A machine reconnecting replaces its old entry; the stale socket is dropped.
    const existing = this.agents.get(agent.agentId);
    if (existing && existing.ws !== agent.ws) {
      existing.ws.close(4000, 'replaced by newer connection');
      this.failAllPending(existing, 'agent reconnected');
    }
    this.agents.set(agent.agentId, agent);
  }

  remove(agentId: string, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.agents.delete(agentId);
    this.failAllPending(agent, reason);
    // If that was the last machine for an environment, its waiters can never
    // be satisfied — release them now rather than holding them to the timeout.
    for (const waiter of [...this.waiting]) {
      if (this.servesEnvironment(waiter.env)) continue;
      const i = this.waiting.indexOf(waiter);
      if (i < 0) continue;
      this.waiting.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.settle(null);
    }
  }

  get(agentId: string): AgentConn | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentConn[] {
    return [...this.agents.values()];
  }

  /**
   * Least-busy ready agent for an environment. Round-robin would ignore that
   * one box may be mid-generation on three requests while another sits idle.
   *
   * With a session key we prefer the machine that served that session before,
   * so a warm KV cache or loaded model is not thrown away — but only while it
   * is ready and has capacity. Affinity is a preference, never a guarantee:
   * falling back to another machine beats failing the request.
   */
  pick(env: string, sessionKey?: string, model?: string): AgentConn | null {
    const ready = this.list().filter((a) => a.isReady(env) && a.hasCapacity);
    if (ready.length === 0) return null;

    const candidates = model ? preferForModel(ready, env, model) : ready;

    if (sessionKey) {
      const key = `${env}\u0000${sessionKey}`;
      const hit = this.affinity.get(key);
      if (hit && hit.expires > Date.now()) {
        // Affinity wins only inside the best tier: a warm KV cache is worth
        // less than avoiding a cold load of the model itself.
        const sticky = candidates.find((a) => a.agentId === hit.agentId);
        if (sticky) {
          hit.expires = Date.now() + this.sessionTtlMs;
          return sticky;
        }
      }
      const chosen = leastBusy(candidates);
      this.affinity.set(key, {
        agentId: chosen.agentId,
        expires: Date.now() + this.sessionTtlMs,
      });
      return chosen;
    }

    return leastBusy(candidates);
  }

  /**
   * Park a request until a machine frees up, resolving null if it waits too
   * long. A saturated pool is a queue, not an error: 503 tells a caller to
   * retry, which is exactly what we can do for them without the round trip —
   * and retry storms are worse than an orderly line.
   */
  enqueue(
    env: string,
    model: string | undefined,
    sessionKey: string | undefined,
    timeoutMs: number,
  ): Promise<AgentConn | null> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        env,
        model,
        sessionKey,
        enqueuedAt: Date.now(),
        settle: resolve,
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.waiting.push(waiter);
    });
  }

  /**
   * Hand freed capacity to whoever has waited longest. Called whenever a slot
   * could have opened: a request finished, a machine joined, health changed.
   */
  drain(): void {
    if (this.waiting.length === 0) return;
    // FIFO, so a request cannot be starved by newer arrivals.
    for (const waiter of [...this.waiting]) {
      const agent = this.pick(waiter.env, waiter.sessionKey, waiter.model);
      if (!agent) continue;
      const i = this.waiting.indexOf(waiter);
      if (i < 0) continue;
      this.waiting.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.settle(agent);
    }
  }

  /** How many requests are parked for an environment. */
  queueDepth(env: string): number {
    return this.waiting.filter((w) => w.env === env).length;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Drop expired affinity entries so the map cannot grow without bound. */
  pruneAffinity(): void {
    const now = Date.now();
    for (const [key, a] of this.affinity) {
      if (a.expires <= now) this.affinity.delete(key);
    }
  }

  get affinityCount(): number {
    return this.affinity.size;
  }

  /**
   * Does any live machine declare this environment, busy or not? Separates
   * "everyone is loaded right now" (worth queueing for) from "nobody serves
   * this app" (a config mistake, and queueing would just stall the caller).
   */
  servesEnvironment(env: string): boolean {
    return this.list().some((a) => a.hasEnvironment(env));
  }

  /** Every environment name any live agent is currently serving. */
  readyEnvironments(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const a of this.list()) {
      for (const e of a.environments) {
        if (a.isReady(e.name)) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Drop agents that have stopped pinging. This is the entire failover mechanism. */
  evictStale(timeoutMs: number): string[] {
    const now = Date.now();
    const dropped: string[] = [];
    for (const a of this.list()) {
      if (now - a.lastSeen > timeoutMs) {
        a.ws.close(4001, 'heartbeat timeout');
        this.remove(a.agentId, 'heartbeat timeout');
        dropped.push(a.label);
      }
    }
    return dropped;
  }

  /** Tracked WebSocket tunnels, so an agent loss can close them cleanly. */
  readonly sockets = new Map<string, { agentId: string; close: (reason: string) => void }>();

  private failAllPending(agent: AgentConn, reason: string): void {
    for (const [id, sock] of this.sockets) {
      if (sock.agentId === agent.agentId) {
        sock.close(reason);
        this.sockets.delete(id);
      }
    }
    for (const p of agent.pending.values()) {
      if (p.headersSent) {
        // Mid-stream: the client already has a 200 and partial body. All we can
        // do is cut the connection so the client sees a truncated response.
        p.res.destroy();
      } else {
        p.res.writeHead(502, { 'content-type': 'application/json' });
        p.res.end(
          JSON.stringify({
            error: { message: `upstream agent lost: ${reason}`, type: 'agent_lost' },
          }),
        );
      }
    }
    agent.pending.clear();
  }
}

/**
 * Narrow candidates to the best tier for a model.
 *
 * Loading a large model costs tens of seconds, so a machine holding it in VRAM
 * beats an idle machine that would have to fetch it from disk. Tiers:
 *   1. resident in VRAM
 *   2. on disk, or inventory unknown (an app we cannot introspect is never
 *      ruled out — absent inventory means "cannot tell", not "has nothing")
 *   3. anything ready, if the tiers above are empty: an inventory can be
 *      stale, and a 404 from the app beats refusing to route at all.
 */
function preferForModel(candidates: AgentConn[], env: string, model: string): AgentConn[] {
  const loaded = candidates.filter((a) => a.hasLoaded(env, model));
  if (loaded.length > 0) return loaded;

  const able = candidates.filter((a) => a.canServe(env, model));
  if (able.length > 0) return able;

  return candidates;
}

/**
 * Pick between machines that can all serve the request.
 *
 * Fewest requests in flight first — a machine mid-generation on three prompts
 * will answer a fourth more slowly than an idle one, whatever its hardware.
 *
 * Then most free VRAM. Equally busy machines are not equally able: the one
 * with headroom can take the work without evicting a model it already holds,
 * and evicting means the next request for that model pays a cold load. A
 * machine that reports no GPUs scores 0 and loses the tiebreak, which is the
 * right way round — if we cannot tell, prefer the machine we can.
 */
function leastBusy(candidates: AgentConn[]): AgentConn {
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (c.pending.size !== best.pending.size) {
      if (c.pending.size < best.pending.size) best = c;
      continue;
    }
    if (c.freeVramMb > best.freeVramMb) best = c;
  }
  return best;
}
