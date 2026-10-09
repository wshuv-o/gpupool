#!/usr/bin/env node
import { request as httpRequest, type ClientRequest } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import { WebSocket } from 'ws';

import {
  loadCredentials,
  saveCredentials,
  loadManifest,
  newAgentId,
  defaultLabel,
  credentialsPath,
  type AgentManifest,
  type Credentials,
} from './config.js';
import { probeAll } from './health.js';
import { startControlServer } from './control.js';
import { probeGpus } from './gpu.js';
import { detectEnvironments, renderManifest } from './detect.js';
import { writeRootConfig, writeManifest, lanAddresses, rootDir } from './setup.js';
import {
  installService,
  uninstallService,
  serviceStatus,
  isElevated,
  checkManifestReadable,
  SERVICE_NAME,
  renderServiceDefinition,
} from './service.js';
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  stripHopHeaders,
  type BrokerFrame,
  type EnvironmentDecl,
  type EnvironmentState,
  type GpuInfo,
  type ReqFrame,
  type WsOpenFrame,
} from '../shared/protocol.js';

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Headers to present to the local app.
 *
 * `Origin` must not be forwarded. Local AI servers police it themselves —
 * Ollama answers 403 for an origin outside OLLAMA_ORIGINS, and Jupyter and
 * ComfyUI do the same — so passing a browser's origin through makes every
 * browser-originated request fail. The broker already owns CORS for the public
 * side and overrides whatever the app sets, so from the app's point of view
 * this is a same-origin server-side call, which is what it actually is.
 */
function localHeaders(
  incoming: Record<string, string>,
  env: EnvironmentDecl,
): Record<string, string> {
  const headers: Record<string, string> = { ...incoming };
  for (const h of Object.keys(headers)) {
    const k = h.toLowerCase();
    // sec-fetch-* carries the same cross-site signal some servers act on.
    if (k === 'origin' || k === 'referer' || k.startsWith('sec-fetch-')) {
      delete headers[h];
    }
  }
  // The local app should see itself as the host, not the broker.
  headers['host'] = `${env.host ?? '127.0.0.1'}:${env.port}`;
  return headers;
}

// ------------------------------------------------------------------ serve

class Agent {
  private ws: WebSocket | null = null;
  private states: EnvironmentState[] = [];
  /** Local requests in flight, so a cancel frame can abort them. */
  private inflight = new Map<string, ClientRequest>();
  /** Relayed WebSockets to the local app, keyed by tunnel id. */
  private sockets = new Map<string, WebSocket>();
  private backoffMs = 1000;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Resolves once the first probe has run, so the broker stops guessing. */
  private probed: Promise<void>;
  private probedResolve!: () => void;
  /** App keys the root issued, keyed by environment name. */
  private envKeys: Record<string, string> = {};
  private gpus: GpuInfo[] = [];
  private control: ReturnType<typeof startControlServer> | null = null;

  constructor(
    private creds: Credentials,
    private manifest: AgentManifest,
  ) {
    this.probed = new Promise((resolve) => {
      this.probedResolve = resolve;
    });
  }

  start(): void {
    void this.healthLoop();
    this.connect();
  }

  /** Probe continuously and independently of the socket, so the first ping
   *  after a reconnect already carries real state. */
  private async healthLoop(): Promise<void> {
    while (!this.stopping) {
      this.states = await probeAll(this.manifest.environments);
      // Free VRAM moves as models load and unload, so it is sampled on the
      // same cycle as health rather than once at startup.
      this.gpus = await probeGpus();
      this.probedResolve();
      await new Promise((r) => setTimeout(r, this.manifest.healthIntervalMs));
    }
  }

  private connect(): void {
    const url = this.creds.broker.replace(/^http/, 'ws').replace(/\/$/, '') + '/_agent';
    log(`connecting to ${url}`);

    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.creds.token}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000;
      ws.send(
        encodeFrame({
          t: 'hello',
          v: PROTOCOL_VERSION,
          agentId: this.creds.agentId,
          label: this.creds.label,
          environments: this.manifest.environments,
          maxConcurrency: this.manifest.maxConcurrency,
        }),
      );
    });

    ws.on('message', (raw) => {
      const frame = decodeFrame<BrokerFrame>(raw.toString());
      if (!frame) return;
      switch (frame.t) {
        case 'welcome':
          log(`registered as "${this.creds.label}" (broker protocol v${frame.v})`);
          this.startHeartbeat(frame.heartbeatMs);
          break;
        case 'env_keys':
          this.envKeys = frame.keys;
          break;
        case 'req':
          this.forward(frame);
          break;
        case 'cancel': {
          const req = this.inflight.get(frame.id);
          if (req) {
            req.destroy();
            this.inflight.delete(frame.id);
          }
          break;
        }
        case 'ws_open':
          this.openLocalSocket(frame);
          break;
        case 'ws_data': {
          const local = this.sockets.get(frame.id);
          if (local?.readyState === WebSocket.OPEN) {
            local.send(Buffer.from(frame.b64, 'base64'), { binary: frame.binary });
          }
          break;
        }
        case 'ws_close': {
          const local = this.sockets.get(frame.id);
          this.sockets.delete(frame.id);
          local?.close(frame.code ?? 1000, frame.reason ?? '');
          break;
        }
        case 'pong':
          break;
      }
    });

    // A failed socket emits both 'error' and 'close'. Without this guard we
    // would schedule two reconnects and double-count the backoff.
    let settled = false;
    const reconnect = (why: string) => {
      if (settled) return;
      settled = true;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      for (const req of this.inflight.values()) req.destroy();
      this.inflight.clear();
      for (const sock of this.sockets.values()) sock.close(1011, 'broker connection lost');
      this.sockets.clear();
      if (this.stopping) return;
      const wait = this.backoffMs + Math.floor(Math.random() * 500);
      log(`disconnected (${why}); retrying in ${wait}ms`);
      // Backoff caps at 30s so a machine that wakes up rejoins promptly.
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      setTimeout(() => this.connect(), wait);
    };

    ws.on('close', (code) => reconnect(`code ${code}`));
    ws.on('error', (err) => reconnect(err.message));
  }

  /** One heartbeat, carrying the latest health snapshot. */
  private beat(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      encodeFrame({
        t: 'ping',
        activeJobs: this.inflight.size + this.sockets.size,
        states: this.states,
        gpus: this.gpus.length ? this.gpus : undefined,
      }),
    );
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const beat = () => this.beat();
    beat();
    this.heartbeat = setInterval(beat, intervalMs);
    // The first beat can land before the first probe finishes, leaving the
    // broker with no state at all — which it reads as "trust the declaration",
    // so it may route to a dead app or route model-blind. Ping again the moment
    // real state exists rather than waiting out a full heartbeat.
    void this.probed.then(() => {
      if (!this.stopping) beat();
    });
  }

  /**
   * Publish a port that did not exist when this machine started.
   *
   * The environment list is replaced wholesale and re-sent, so the root's view
   * cannot drift from this machine's. Health probing picks it up on the next
   * cycle like any other environment.
   */
  async publishEnvironment(env: EnvironmentDecl): Promise<void> {
    const rest = this.manifest.environments.filter((e) => e.name !== env.name);
    this.manifest.environments = [...rest, env];
    this.sendEnvironments();
    // Probe immediately: the caller is about to hand the URL to someone, and a
    // request arriving before the first probe would find no reported state.
    this.states = await probeAll(this.manifest.environments);
    this.beat();
  }

  async withdrawEnvironment(name: string): Promise<void> {
    this.manifest.environments = this.manifest.environments.filter((e) => e.name !== name);
    delete this.envKeys[name];
    this.sendEnvironments();
    this.states = await probeAll(this.manifest.environments);
    this.beat();
  }

  private sendEnvironments(): void {
    this.send({ t: 'envs', environments: this.manifest.environments });
  }

  environments(): EnvironmentDecl[] {
    return this.manifest.environments;
  }

  keyFor(name: string): string | undefined {
    return this.envKeys[name];
  }

  brokerUrl(): string {
    return this.creds.broker;
  }

  /** Start the loopback API an application uses to publish ports. */
  startControl(port: number, token: string): void {
    this.control = startControlServer(port, token, {
      list: () => this.environments(),
      publish: (env) => this.publishEnvironment(env),
      withdraw: (name) => this.withdrawEnvironment(name),
      keyFor: (name) => this.keyFor(name),
      brokerUrl: () => this.brokerUrl(),
    });
    log(`control API on 127.0.0.1:${port}`);
  }

  /** Pipe one tunnelled request into the local app and stream the reply back. */
  private forward(frame: ReqFrame): void {
    const env = this.manifest.environments.find((e) => e.name === frame.env);
    if (!env) {
      this.fail(frame.id, `unknown environment "${frame.env}"`, true);
      return;
    }

    const body = frame.b64 ? Buffer.from(frame.b64, 'base64') : null;
    const headers = localHeaders(frame.headers, env);
    if (body) headers['content-length'] = String(body.length);

    const req = httpRequest(
      {
        host: env.host ?? '127.0.0.1',
        port: env.port,
        path: frame.path,
        method: frame.method,
        headers,
      },
      (res) => {
        this.send({
          t: 'res_head',
          id: frame.id,
          status: res.statusCode ?? 502,
          headers: stripHopHeaders(res.headers),
        });
        res.on('data', (chunk: Buffer) => {
          this.send({ t: 'res_chunk', id: frame.id, b64: chunk.toString('base64') });
        });
        res.on('end', () => {
          this.inflight.delete(frame.id);
          this.send({ t: 'res_end', id: frame.id });
        });
        res.on('error', (err) => {
          this.inflight.delete(frame.id);
          this.fail(frame.id, err.message, false);
        });
      },
    );

    req.on('error', (err) => {
      // Nothing was written yet, so the broker can still return a clean 502.
      const had = this.inflight.delete(frame.id);
      if (had) this.fail(frame.id, err.message, true);
    });

    this.inflight.set(frame.id, req);
    if (body) req.write(body);
    req.end();
  }

  /**
   * Dial a WebSocket against the local app and relay it. Many local AI tools
   * (ComfyUI, A1111, notebook kernels) report progress this way, so an
   * HTTP-only tunnel would leave them half-working.
   */
  private openLocalSocket(frame: WsOpenFrame): void {
    const env = this.manifest.environments.find((e) => e.name === frame.env);
    if (!env) {
      this.send({ t: 'ws_err', id: frame.id, message: `unknown environment "${frame.env}"` });
      return;
    }

    const host = env.host ?? '127.0.0.1';
    const target = `ws://${host}:${env.port}${frame.path}`;
    const local = new WebSocket(target, frame.protocols, {
      // Same reasoning as the HTTP path: a forwarded Origin makes servers that
      // police WebSocket origins reject the upgrade outright.
      headers: localHeaders(frame.headers, env),
    });
    this.sockets.set(frame.id, local);

    local.on('open', () => {
      this.send({ t: 'ws_ready', id: frame.id, protocol: local.protocol || undefined });
    });
    local.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.send({ t: 'ws_data', id: frame.id, b64: buf.toString('base64'), binary: isBinary });
    });
    local.on('close', (code, reason) => {
      if (this.sockets.delete(frame.id)) {
        this.send({ t: 'ws_close', id: frame.id, code, reason: reason.toString().slice(0, 120) });
      }
    });
    local.on('error', (err) => {
      if (this.sockets.delete(frame.id)) {
        this.send({ t: 'ws_err', id: frame.id, message: err.message });
      }
    });
  }

  private fail(id: string, message: string, recoverable: boolean): void {
    this.send({ t: 'res_err', id, message, recoverable });
  }

  private send(frame: Parameters<typeof encodeFrame>[0]): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
  }

  stop(): void {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000, 'shutting down');
  }
}

// ------------------------------------------------------------------ CLI

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function describe(envs: EnvironmentDecl[]): string {
  return envs.map((e) => `${e.name} -> 127.0.0.1:${e.port}`).join('\n  ');
}

function cmdLogin(): void {
  const broker = arg('broker');
  const token = arg('token');
  if (!broker || !token) {
    console.error('usage: gpupool login --broker <url> --token <agent-token> [--label <name>]');
    process.exit(1);
  }
  const existing = loadCredentials();
  const creds: Credentials = {
    broker,
    token,
    // Keep the machine identity stable across re-logins.
    agentId: existing?.agentId ?? newAgentId(),
    label: arg('label') ?? existing?.label ?? defaultLabel(),
  };
  const path = saveCredentials(creds);
  console.log(`paired "${creds.label}" with ${broker}`);
  console.log(`credentials saved to ${path}`);
  console.log('\nnext: gpupool serve');
}

/**
 * One command to put a machine in the pool: redeem an invite code, work out
 * what is already running here, write both files.
 *
 * The old path was seven steps across two machines — edit the broker's config,
 * restart it, copy a token, hand-write a manifest — and every one of them is a
 * chance to typo something that then looks like a dead app.
 */
async function cmdJoin(): Promise<void> {
  const code = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : arg('code');
  const broker = arg('broker');
  if (!code || !broker) {
    console.error('usage: gpupool join <code> --broker <url> [--label <name>] [--manifest <path>]');
    process.exit(1);
  }

  const existing = loadCredentials();
  // Reuse the machine identity so re-joining does not orphan the old entry.
  const agentId = existing?.agentId ?? newAgentId();
  const label = arg('label') ?? existing?.label ?? defaultLabel();

  const base = broker.replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/_join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label, agentId }),
    });
  } catch (err) {
    console.error(`cannot reach broker at ${base}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = `broker refused the code (HTTP ${res.status})`;
    try {
      const doc = JSON.parse(detail) as { error?: { message?: string } };
      if (doc.error?.message) message = doc.error.message;
    } catch {
      /* non-JSON error body; the status line is enough */
    }
    console.error(message);
    process.exit(1);
  }

  const granted = (await res.json()) as { token: string; agentId: string };
  const path = saveCredentials({ broker: base, token: granted.token, agentId, label });
  console.log(`joined ${base} as "${label}"`);
  console.log(`credentials saved to ${path}`);

  // Only write a manifest when there is not one already: overwriting someone's
  // hand-tuned file would be a nasty surprise.
  const manifestPath = arg('manifest') ?? 'gpupool.yaml';
  if (existsSync(manifestPath)) {
    console.log(`
keeping your existing ${manifestPath}`);
    console.log('next: gpupool serve');
    return;
  }

  process.stdout.write('\nlooking for local AI servers... ');
  const found = await detectEnvironments();
  if (found.length === 0) {
    console.log('none found.');
    console.log(
      `
Nothing is answering on the ports we know (Ollama, ComfyUI, A1111,
` +
        `vLLM, LM Studio, KoboldCpp). Start your server, then write ${manifestPath}:

` +
        `environments:
  myapp:
    port: 11434
    health: /api/tags
`,
    );
    process.exit(1);
  }

  writeFileSync(manifestPath, renderManifest(found));
  console.log(`found ${found.length}.`);
  console.log(`wrote ${manifestPath}:
  ${describe(found)}`);
  console.log('\nnext: gpupool serve   (or: gpupool service install)');
}

async function cmdSetup(): Promise<void> {
  const role = process.argv[3];
  if (role === 'root') return cmdSetupRoot();
  if (role === 'leaf') return cmdSetupLeaf();
  console.error(`usage:
  gpupool setup root [--port 8787] [--cors <origin>]
  gpupool setup leaf --key <setup-key> --root <url> [--label <name>]`);
  process.exit(1);
}

/**
 * Turn this machine into the pool's root: it runs the broker AND contributes
 * its own GPU, which is what people expect from "set this one up first".
 */
async function cmdSetupRoot(): Promise<void> {
  const port = Number(arg('port') ?? 8787);

  // Detection runs first: keys are minted per environment, so we have to know
  // what this machine runs before we can mint them.
  process.stdout.write('looking for local AI servers... ');
  const found = await writeManifest(arg('manifest') ?? 'gpupool.yaml');

  const { config, created } = writeRootConfig({
    port,
    environments: (found ?? []).map((e) => e.name),
    corsOrigin: arg('cors') ?? '*',
  });

  if (!created) {
    console.log('');
    console.log(`already set up as root; reusing ${rootDir()}`);
    console.log('(delete that directory to start over — it would orphan joined machines)');
  }
  if (found) {
    console.log(`found ${found.length} — this machine will serve requests too.`);
  } else {
    // A root with no GPU is a normal arrangement, not an error: a small
    // always-on box coordinating machines that do the actual work. Say which
    // one happened rather than refusing to continue.
    console.log('none found.');
    console.log('this machine will coordinate only, and serve no requests itself.');
  }

  const addrs = lanAddresses();
  const lan = addrs[0] ?? '127.0.0.1';

  // Pair this machine with its own broker, so the machine coordinating the
  // pool is not the one machine missing from it.
  if (found && config.selfToken) {
    const existing = loadCredentials();
    saveCredentials({
      broker: `http://127.0.0.1:${port}`,
      token: config.selfToken,
      agentId: existing?.agentId ?? newAgentId(),
      label: arg('label') ?? existing?.label ?? defaultLabel(),
    });
  }

  const keyLines = Object.entries(config.appKeys)
    .map(([env, k]) => `               ${env.padEnd(16)} ${k}`)
    .join('\n');

  console.log(`
root is configured.

  config     ${rootDir()}
  dashboard  http://${lan}:${port}/_ui
  admin key  ${config.adminKey}
  serves     ${found ? describe(found) : 'nothing locally — coordinates only'}

  keys       one per service, so machines running different things each stay
             reachable:
${keyLines}

Start it — the broker, and this machine's own agent:

  gpupool broker          (foreground)
  gpupool serve           (second terminal)
  gpupool service install (keeps the agent running across reboots)

Then open the dashboard, sign in with the admin key, and copy the setup key
it shows. On each other machine:

  gpupool setup leaf --key <setup-key> --root http://${lan}:${port}
`);
  if (addrs.length > 1) {
    console.log(`This machine has several addresses; leaves should use one they can reach:`);
    for (const a of addrs) console.log(`  http://${a}:${port}`);
    console.log('');
  }
}

/** Join an existing root using the key its dashboard shows. */
async function cmdSetupLeaf(): Promise<void> {
  const setupKey = arg('key');
  const root = arg('root');
  if (!setupKey || !root) {
    console.error('usage: gpupool setup leaf --key <setup-key> --root <url> [--label <name>]');
    process.exit(1);
  }

  const existing = loadCredentials();
  const agentId = existing?.agentId ?? newAgentId();
  const label = arg('label') ?? existing?.label ?? defaultLabel();
  const base = root.replace(/\/+$/, '');

  process.stdout.write(`joining ${base}... `);
  let res: Response;
  try {
    res = await fetch(`${base}/_join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: setupKey, label, agentId }),
    });
  } catch (err) {
    console.log('failed.');
    console.error(`
Cannot reach ${base}: ${(err as Error).message}

Check that the root is running, and that this machine can reach it:
  curl ${base}/_health`);
    process.exit(1);
  }

  if (!res.ok) {
    console.log('refused.');
    const detail = await res.text().catch(() => '');
    let message = `HTTP ${res.status}`;
    try {
      const doc = JSON.parse(detail) as { error?: { message?: string } };
      if (doc.error?.message) message = doc.error.message;
    } catch {
      /* status line is enough */
    }
    console.error(`
${message}`);
    if (res.status === 401) {
      console.error('The setup key may be wrong, or enrollment closed on the dashboard.');
    }
    process.exit(1);
  }

  const granted = (await res.json()) as { token: string };
  saveCredentials({ broker: base, token: granted.token, agentId, label });
  console.log('done.');

  process.stdout.write('looking for local AI servers... ');
  const found = await writeManifest(arg('manifest') ?? 'gpupool.yaml');
  if (!found) {
    console.log('none found.');
    console.error(`
This machine joined, but has no AI server to share. Install one:

  winget install Ollama.Ollama
  ollama pull llama3.2:3b

then run: gpupool service install
(no new key needed — this machine is already enrolled)`);
    process.exit(1);
  }
  console.log(`found ${found.length}.`);
  console.log(`
"${label}" joined the pool:
  ${describe(found)}

Keep it connected across reboots:

  gpupool service install
`);
}

/** Run the broker from the root's generated config. */
function cmdBroker(): void {
  const cfgPath = resolve(rootDir(), 'broker.config.json');
  if (!existsSync(cfgPath)) {
    console.error(`not set up as root. run:
  gpupool setup root`);
    process.exit(1);
  }
  // The broker reads ./broker.config.json, so run it from the root's directory
  // rather than teaching it a second way to be configured.
  process.chdir(rootDir());
  void import('../broker/index.js');
}

function cmdServe(): void {
  const creds = loadCredentials();
  if (!creds) {
    console.error(`not paired. run:\n  gpupool login --broker <url> --token <token>`);
    process.exit(1);
  }
  const manifestPath = arg('manifest') ?? 'gpupool.yaml';
  let manifest: AgentManifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(`gpupool agent "${creds.label}"`);
  console.log(`  broker:   ${creds.broker}`);
  console.log(`  exposing:\n  ${describe(manifest.environments)}`);
  console.log(`  capacity: ${manifest.maxConcurrency} concurrent\n`);

  const agent = new Agent(creds, manifest);
  agent.start();

  // --control starts the API an application uses to publish a port it opened
  // at runtime. Off unless asked for: a machine whose environments never
  // change has no reason to listen for them.
  const controlPort = Number(arg('control') ?? manifest.controlPort ?? 0);
  if (controlPort > 0) {
    let controlToken = creds.controlToken;
    if (!controlToken) {
      // Minted once and stored beside the credentials, so an application on
      // this machine reads it from a file it already knows about.
      controlToken = `ct_${randomBytes(16).toString('hex')}`;
      saveCredentials({ ...creds, controlToken });
    }
    agent.startControl(controlPort, controlToken);
    console.log(`  control:  http://127.0.0.1:${controlPort}  (token in ${credentialsPath()})`);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log('shutting down');
      agent.stop();
      process.exit(0);
    });
  }
}

async function cmdStatus(): Promise<void> {
  const creds = loadCredentials();
  const broker = arg('broker') ?? creds?.broker;
  if (!broker) {
    console.error('no broker known; pass --broker <url> or run login first');
    process.exit(1);
  }
  const adminKey = arg('admin-key') ?? process.env.GPUPOOL_ADMIN_KEY;
  const res = await fetch(`${broker.replace(/\/$/, '')}/_status`, {
    headers: adminKey ? { authorization: `Bearer ${adminKey}` } : {},
  });
  const body = (await res.json()) as {
    agents?: Array<{
      label: string;
      activeJobs: number;
      maxConcurrency: number;
      environments: Array<{ name: string; port: number; ready: boolean; detail?: string }>;
    }>;
    error?: { message: string };
  };
  if (!res.ok) {
    console.error(body.error?.message ?? `status ${res.status}`);
    process.exit(1);
  }
  const agents = body.agents ?? [];
  if (agents.length === 0) {
    console.log('no machines connected');
    return;
  }
  for (const a of agents) {
    console.log(`${a.label}  (${a.activeJobs}/${a.maxConcurrency} busy)`);
    for (const e of a.environments) {
      const mark = e.ready ? 'ready' : `DOWN${e.detail ? ` - ${e.detail}` : ''}`;
      console.log(`  ${e.name}  :${e.port}  ${mark}`);
    }
  }
}

function cmdService(): void {
  const sub = process.argv[3];
  const system = process.argv.includes('--system');

  if (sub === 'install') {
    const manifestPath = resolve(arg('manifest') ?? 'gpupool.yaml');
    const problem = checkManifestReadable(manifestPath);
    if (problem) {
      console.error(problem);
      process.exit(1);
    }
    if (!loadCredentials()) {
      console.error('not paired yet. run gpupool login first.');
      process.exit(1);
    }
    if (system && !isElevated()) {
      console.error(
        platform() === 'win32'
          ? '--system needs an elevated prompt (Run as Administrator).'
          : '--system needs root. re-run with sudo.',
      );
      process.exit(1);
    }
    if (process.argv.includes('--dry-run')) {
      const def = renderServiceDefinition({ manifestPath, system });
      console.log(`would write: ${def.path}
`);
      console.log(def.body);
      return;
    }

    try {
      const lines = installService({
        manifestPath,
        system,
        // The service may run with a different HOME, so pin the config dir.
        gpupoolHome: process.env.GPUPOOL_HOME,
      });
      console.log(lines.join('\n'));
      if (!system) {
        console.log(
          '\nthis starts at logon. for a machine that should serve before anyone' +
            '\nlogs in, reinstall elevated with --system.',
        );
      }
    } catch (err) {
      console.error(`install failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'uninstall') {
    try {
      console.log(uninstallService(system).join('\n'));
    } catch (err) {
      console.error(`uninstall failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'status') {
    console.log(`${SERVICE_NAME}:`);
    console.log(serviceStatus(system));
    return;
  }

  console.error('usage: gpupool service <install|uninstall|status> [--system] [--manifest <path>]');
  process.exit(1);
}

const command = process.argv[2];
switch (command) {
  case 'login':
    cmdLogin();
    break;
  case 'join':
    void cmdJoin();
    break;
  case 'setup':
    void cmdSetup();
    break;
  case 'broker':
    cmdBroker();
    break;
  case 'serve':
    cmdServe();
    break;
  case 'status':
    void cmdStatus();
    break;
  case 'service':
    cmdService();
    break;
  default:
    console.log(`gpupool - expose a local port through a shared broker

  gpupool setup root [--port 8787]
  gpupool setup leaf --key <setup-key> --root <url> [--label <name>]
  gpupool broker

  gpupool join <code> --broker <url> [--label <name>]
  gpupool login --broker <url> --token <token> [--label <name>]
  gpupool serve [--manifest gpupool.yaml]
  gpupool status [--admin-key <key>]

  gpupool service install [--manifest <path>] [--system] [--dry-run]
  gpupool service uninstall [--system]
  gpupool service status [--system]

"join" redeems an invite code from the broker admin, then detects what you
already run locally and writes gpupool.yaml for you. "login" is the manual
path when you were handed a token directly.

Service install keeps the agent running across reboots, so the machine joins
the pool whenever it is powered on. Without --system it starts at logon and
needs no admin rights; with --system it starts at boot before login.
`);
    process.exit(command ? 1 : 0);
}
