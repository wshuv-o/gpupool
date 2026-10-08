#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

import { loadConfig, bearer } from './config.js';
import { Enrolment, normalise } from './enrol.js';
import { AuthLimiter, clientIp, safeEqual } from './security.js';
import { DASHBOARD_HTML } from './ui/dashboard.js';
import { AgentConn, Registry } from './registry.js';
import {
  PROTOCOL_VERSION,
  decodeFrame,
  stripHopHeaders,
  type AgentFrame,
  type HelloFrame,
} from '../shared/protocol.js';

const cfg = loadConfig();
const registry = new Registry(cfg.sessionTtlMs);
const enrolment = new Enrolment(cfg.tokenStorePath, cfg.inviteTtlMs);
const limiter = new AuthLimiter(cfg.authMaxFailures, cfg.authWindowMs, cfg.authBlockMs);

/** Refuse the request when this client has been guessing. */
function rateLimited(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = clientIp(req, cfg.trustedProxyHops);
  if (!limiter.blocked(ip)) return false;
  const retry = limiter.retryAfter(ip);
  res.setHeader('retry-after', String(retry));
  apiError(res, 429, `Too many failed attempts. Try again in ${retry}s.`, 'rate_limited', req);
  return true;
}

/** Record a failed authentication and log when it escalates to a block. */
function authFailed(req: IncomingMessage, what: string): void {
  const ip = clientIp(req, cfg.trustedProxyHops);
  if (limiter.fail(ip)) log(`blocked ${ip} after repeated ${what} failures`);
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/**
 * CORS headers for browser callers. An app key embedded in browser JS is
 * readable by anyone who opens devtools, so the useful control is not secrecy
 * but which origins may present it — hence the allowlist option.
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const requestOrigin = req.headers.origin;
  const base: Record<string, string> = {
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers':
      `authorization,content-type,x-gpupool-key,${cfg.sessionHeader}`,
    'access-control-max-age': '86400',
  };

  if (cfg.corsOrigin === '*') {
    return { ...base, 'access-control-allow-origin': '*' };
  }
  const allowed = cfg.corsOrigin.split(',').map((o) => o.trim());
  if (requestOrigin && allowed.includes(requestOrigin)) {
    // Vary matters: a cache must not serve one origin's response to another.
    return { ...base, 'access-control-allow-origin': requestOrigin, vary: 'origin' };
  }
  return { vary: 'origin' };
}

function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(req ? corsHeaders(req) : {}),
  });
  res.end(payload);
}

/** Shaped like an OpenAI API error so existing clients surface it properly. */
function apiError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  req?: IncomingMessage,
): void {
  // Without CORS headers here, a browser reports a generic network error and
  // the real cause (bad key, no capacity) never reaches the page.
  json(res, status, { error: { message, type } }, req);
}

// ------------------------------------------------------------------ HTTP proxy

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Pull the model name out of a request body.
 *
 * Every OpenAI-compatible and Ollama endpoint carries it as a top-level
 * "model" string. Anything else — form posts, uploads, malformed JSON — yields
 * undefined and routing stays model-blind, exactly as it was before.
 */
function modelFromBody(body: Buffer): string | undefined {
  if (body.length === 0 || body.length > 1024 * 1024) return undefined;
  try {
    const doc = JSON.parse(body.toString('utf8')) as unknown;
    if (!doc || typeof doc !== 'object') return undefined;
    const m = (doc as Record<string, unknown>).model;
    return typeof m === 'string' && m.length > 0 ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an app key to its environment without leaking it through timing.
 *
 * A Map lookup compares key bytes and returns early on the first difference,
 * so response time reveals how much of a guessed key was right. Walking every
 * key with a constant-time compare costs microseconds and removes that.
 */
function lookupAppKey(key: string): string | undefined {
  let found: string | undefined;
  for (const [candidate, env] of cfg.appKeys) {
    // No early exit: the loop must take the same time whether or not it
    // matched, and whichever entry matched.
    if (safeEqual(candidate, key)) found = env;
  }
  return found;
}

async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(req, res)) return;

  const key =
    bearer(req.headers.authorization) ?? (req.headers['x-gpupool-key'] as string | undefined);
  if (!key) {
    apiError(res, 401, 'Missing API key. Pass Authorization: Bearer <key>.', 'missing_key', req);
    return;
  }

  const env = lookupAppKey(key);
  if (!env) {
    authFailed(req, 'app key');
    apiError(res, 401, 'Invalid API key.', 'invalid_key', req);
    return;
  }
  limiter.succeed(clientIp(req, cfg.trustedProxyHops));

  // Read the body before routing: the model name lives in it, and routing to
  // a machine that already holds that model saves a cold load worth far more
  // than the buffering costs.
  const body = await readBody(req, cfg.maxBodyBytes);
  if (body === null) {
    apiError(res, 413, 'Request body too large.', 'body_too_large', req);
    return;
  }

  const session = req.headers[cfg.sessionHeader] as string | undefined;
  const model = modelFromBody(body);

  let agent = registry.pick(env, session, model);
  if (!agent) {
    if (!registry.servesEnvironment(env)) {
      // Nobody serves this at all: queueing would only stall the caller.
      apiError(
        res,
        503,
        `No machine is serving environment "${env}". Check the agent gpupool.yaml.`,
        'no_capacity',
        req,
      );
      return;
    }
    if (registry.queueDepth(env) >= cfg.queueLimit) {
      apiError(
        res,
        503,
        `Too many requests queued for environment "${env}". Try again later.`,
        'queue_full',
        req,
      );
      return;
    }
    // Every machine is busy. Hold the request instead of bouncing it: the
    // caller would only retry, and a retry storm is worse than a queue.
    const waited = Date.now();
    agent = await registry.enqueue(env, model, session, cfg.queueTimeoutMs);
    if (!agent) {
      apiError(
        res,
        503,
        `No machine available for environment "${env}" right now. Try again later.`,
        'no_capacity',
        req,
      );
      return;
    }
    // The client may have hung up while parked; dispatching now would occupy a
    // GPU producing a response nobody will read.
    if (res.writableEnded || res.destroyed) {
      registry.drain();
      return;
    }
    log(`queued ${Date.now() - waited}ms [${env}] -> ${agent.label}`);
  }

  const id = randomUUID();
  const headers = stripHopHeaders(req.headers);
  // The tunnel re-frames the body, and the app key must not reach the local app.
  delete headers['content-length'];
  delete headers['authorization'];
  delete headers['x-gpupool-key'];

  agent.served++;
  agent.pending.set(id, {
    id,
    env,
    res,
    agentId: agent.agentId,
    startedAt: Date.now(),
    headersSent: false,
    cors: corsHeaders(req),
  });

  const timer =
    cfg.requestTimeoutMs > 0
      ? setTimeout(() => {
          const p = agent.pending.get(id);
          if (!p) return;
          agent.pending.delete(id);
          registry.drain();
          agent.send({ t: 'cancel', id });
          if (p.headersSent) p.res.destroy();
          else apiError(p.res, 504, 'Upstream agent timed out.', 'agent_timeout');
        }, cfg.requestTimeoutMs)
      : null;

  res.on('close', () => {
    if (timer) clearTimeout(timer);
    // Client hung up before we finished: tell the agent to abort the local
    // request, so a cancelled chat stops occupying a GPU.
    if (agent.pending.delete(id)) {
      registry.drain();
      agent.send({ t: 'cancel', id });
    }
  });

  agent.send({
    t: 'req',
    id,
    env,
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    headers,
    b64: body.length ? body.toString('base64') : undefined,
  });

  log(`-> ${agent.label} [${env}] ${req.method} ${req.url} (${id.slice(0, 8)})`);
}

/**
 * Mint an invite code. Admin-only: a code is a credential-in-waiting.
 *
 * This exists so adding a machine does not mean editing broker.config.json and
 * restarting — a restart drops every connected machine to admit one.
 */
function handleInvite(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    apiError(res, 405, 'POST required.', 'method_not_allowed', req);
    return;
  }
  if (rateLimited(req, res)) return;
  if (!cfg.adminKey || !safeEqual(bearer(req.headers.authorization), cfg.adminKey)) {
    authFailed(req, 'admin key');
    apiError(res, 401, 'Admin key required.', 'invalid_key', req);
    return;
  }
  limiter.succeed(clientIp(req, cfg.trustedProxyHops));
  const invite = enrolment.create();
  log(`invite ${invite.code} issued (expires in ${Math.round(cfg.inviteTtlMs / 1000)}s)`);
  json(res, 200, { code: invite.code, expiresAt: invite.expiresAt }, req);
}

/** Exchange an invite code for a permanent agent token. */
async function handleJoin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(req, res)) return;
  if (req.method !== 'POST') {
    apiError(res, 405, 'POST required.', 'method_not_allowed', req);
    return;
  }
  const body = await readBody(req, 8192);
  if (body === null) {
    apiError(res, 413, 'Request body too large.', 'body_too_large', req);
    return;
  }
  let doc: { code?: string; label?: string; agentId?: string };
  try {
    doc = JSON.parse(body.toString('utf8')) as typeof doc;
  } catch {
    apiError(res, 400, 'Expected a JSON body.', 'bad_request', req);
    return;
  }
  if (!doc.code || !doc.agentId) {
    apiError(res, 400, 'Both "code" and "agentId" are required.', 'bad_request', req);
    return;
  }

  const label = (doc.label ?? 'unnamed').slice(0, 64);
  const agentId = doc.agentId.slice(0, 64);
  // A setup key and an invite code arrive through the same door, because the
  // machine joining does not care which one it was handed.
  const granted = doc.code.startsWith('ek_')
    ? enrolment.redeemEnrollment(doc.code, label, agentId)
    : enrolment.redeem(doc.code, label, agentId);
  if (!granted) {
    // One message for unknown, expired and already-used: distinguishing them
    // would let someone probe which codes exist. Rate limiting is what makes
    // the code length meaningful — 28^8 is only out of reach if you cannot
    // try thousands per second.
    authFailed(req, 'invite code');
    apiError(res, 401, 'That code is not valid. Ask for a fresh one.', 'invalid_code', req);
    return;
  }
  limiter.succeed(clientIp(req, cfg.trustedProxyHops));
  log(`machine "${label}" enrolled via invite (${normalise(doc.code)})`);
  json(res, 200, { token: granted.token, agentId: granted.agentId, label }, req);
}

/** Read or change the reusable setup key. Admin-only, like /_invite. */
async function handleEnrollment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (rateLimited(req, res)) return;
  if (!cfg.adminKey || !safeEqual(bearer(req.headers.authorization), cfg.adminKey)) {
    authFailed(req, 'admin key');
    apiError(res, 401, 'Admin key required.', 'invalid_key', req);
    return;
  }
  limiter.succeed(clientIp(req, cfg.trustedProxyHops));

  if (req.method === 'GET') {
    json(res, 200, enrolment.enrollment(), req);
    return;
  }
  if (req.method !== 'POST') {
    apiError(res, 405, 'GET or POST.', 'method_not_allowed', req);
    return;
  }

  const body = await readBody(req, 4096);
  let doc: { open?: boolean; rotate?: boolean } = {};
  try {
    doc = body && body.length ? (JSON.parse(body.toString('utf8')) as typeof doc) : {};
  } catch {
    apiError(res, 400, 'Expected a JSON body.', 'bad_request', req);
    return;
  }

  if (doc.rotate) {
    enrolment.rotateEnrollment();
    log('enrollment key rotated');
  }
  if (typeof doc.open === 'boolean') {
    enrolment.setEnrollmentOpen(doc.open);
    log(`enrollment ${doc.open ? 'opened' : 'closed'}`);
  }
  json(res, 200, enrolment.enrollment(), req);
}

function handleStatus(req: IncomingMessage, res: ServerResponse): void {
  if (rateLimited(req, res)) return;
  // Fails CLOSED. This previously skipped the check entirely when no admin key
  // was configured, publishing machine labels, ports, model inventories and
  // request counts to anyone who asked.
  if (!cfg.adminKey || !safeEqual(bearer(req.headers.authorization), cfg.adminKey)) {
    authFailed(req, 'admin key');
    apiError(res, 401, 'Admin key required.', 'invalid_key', req);
    return;
  }
  limiter.succeed(clientIp(req, cfg.trustedProxyHops));
  json(res, 200, {
    ok: true,
    protocol: PROTOCOL_VERSION,
    agents: registry.list().map((a) => ({
      agentId: a.agentId,
      label: a.label,
      activeJobs: a.pending.size,
      maxConcurrency: a.maxConcurrency,
      served: a.served,
      socketsOpened: a.socketsOpened,
      lastSeenMs: Date.now() - a.lastSeen,
      environments: a.environments.map((e) => ({
        name: e.name,
        port: e.port,
        ready: a.isReady(e.name),
        // Surfacing inventory makes a routing decision explainable: you can
        // see which machine held the model when a request landed where it did.
        models: a.states.find((st) => st.name === e.name)?.models,
        loaded: a.states.find((st) => st.name === e.name)?.loaded,
        detail: a.states.find((s) => s.name === e.name)?.detail,
      })),
    })),
    environments: Object.fromEntries(registry.readyEnvironments()),
    queued: registry.queued,
    websockets: tunnels.size,
    stickySessions: registry.affinityCount,
  }, req);
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  // Preflight never reaches a GPU machine; answer it at the edge.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (path === '/_ui' || path === '/_ui/') {
    // The page itself carries no secrets — it asks for the admin key and holds
    // it in sessionStorage — so it needs no auth of its own. Every call it
    // makes is authenticated individually.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // It only ever talks to its own origin, so forbid everything else.
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (path === '/_invite') return handleInvite(req, res);
  if (path === '/_enrollment') return void handleEnrollment(req, res);
  if (path === '/_join') return void handleJoin(req, res);
  if (path === '/_status') return handleStatus(req, res);
  if (path === '/_health') return json(res, 200, { ok: true }, req);
  handleProxy(req, res).catch((err: unknown) => {
    log('proxy error', err);
    if (!res.headersSent) apiError(res, 500, 'Broker error.', 'broker_error', req);
    else res.destroy();
  });
});

// ------------------------------------------------------------------ agent socket

const wss = new WebSocketServer({ noServer: true });

/**
 * Client-facing WebSocket server. Subprotocol negotiation picks the client's
 * first choice, because the 101 must be sent before the local app has had a
 * chance to state a preference.
 */
const wssClient = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => protocols.values().next().value ?? false,
});

/** A client WebSocket relayed to a local app through an agent. */
interface Tunnel {
  clientWs: WebSocket;
  agent: AgentConn;
  ready: boolean;
  /** Frames the client sent before the local app finished its handshake. */
  queue: Array<{ b64: string; binary: boolean }>;
}

const tunnels = new Map<string, Tunnel>();

/** Constant-time membership test, for the same reason as lookupAppKey. */
function hasAgentToken(token: string): boolean {
  let found = false;
  for (const candidate of cfg.agentTokens) {
    if (safeEqual(candidate, token)) found = true;
  }
  return found;
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, msg: string): void {
  const body = JSON.stringify({ error: { message: msg } });
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\n` +
      'content-type: application/json\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/_agent') {
    const token = bearer(req.headers.authorization);
    const ip = clientIp(req, cfg.trustedProxyHops);
    if (limiter.blocked(ip)) {
      rejectUpgrade(socket, 429, 'Too many failed attempts.');
      return;
    }
    if (!token || !(hasAgentToken(token) || enrolment.has(token))) {
      if (limiter.fail(ip)) log(`blocked ${ip} after repeated agent token failures`);
      rejectUpgrade(socket, 401, 'Invalid agent token.');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachAgent(ws));
    return;
  }

  // Browsers cannot set headers on a WebSocket, so the key may arrive as a
  // query parameter. It is stripped before the path reaches the local app.
  const key =
    bearer(req.headers.authorization) ??
    (req.headers['x-gpupool-key'] as string | undefined) ??
    url.searchParams.get('key') ??
    undefined;
  const env = key ? cfg.appKeys.get(key) : undefined;
  if (!env) {
    rejectUpgrade(socket, 401, 'Missing or invalid API key.');
    return;
  }

  const session =
    (req.headers[cfg.sessionHeader] as string | undefined) ??
    url.searchParams.get('session') ??
    undefined;
  const agent = registry.pick(env, session);
  if (!agent) {
    rejectUpgrade(socket, 503, `No machine available for environment "${env}". Try again later.`);
    return;
  }

  url.searchParams.delete('key');
  url.searchParams.delete('session');
  const forwardPath = url.pathname + (url.searchParams.size ? `?${url.searchParams}` : '');

  const headers = stripHopHeaders(req.headers);
  for (const h of ['authorization', 'x-gpupool-key', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    delete headers[h];
  }

  wssClient.handleUpgrade(req, socket, head, (clientWs) => {
    const id = randomUUID();
    agent.socketsOpened++;
    const tunnel: Tunnel = { clientWs, agent, ready: false, queue: [] };
    tunnels.set(id, tunnel);
    registry.sockets.set(id, {
      agentId: agent.agentId,
      close: (reason) => {
        tunnels.delete(id);
        clientWs.close(1011, reason.slice(0, 120));
      },
    });

    clientWs.on('message', (data, isBinary) => {
      const b64 = Buffer.isBuffer(data)
        ? data.toString('base64')
        : Buffer.from(data as ArrayBuffer).toString('base64');
      // Anything sent before the local app is ready is held, not dropped.
      if (!tunnel.ready) tunnel.queue.push({ b64, binary: isBinary });
      else agent.send({ t: 'ws_data', id, b64, binary: isBinary });
    });

    clientWs.on('close', (code, reason) => {
      if (tunnels.delete(id)) {
        registry.sockets.delete(id);
        agent.send({ t: 'ws_close', id, code, reason: reason.toString().slice(0, 120) });
      }
    });

    clientWs.on('error', () => {
      if (tunnels.delete(id)) {
        registry.sockets.delete(id);
        agent.send({ t: 'ws_close', id, code: 1011, reason: 'client error' });
      }
    });

    agent.send({
      t: 'ws_open',
      id,
      env,
      path: forwardPath,
      headers,
      protocols: clientWs.protocol ? [clientWs.protocol] : undefined,
    });
    log(`~> ${agent.label} [${env}] WS ${forwardPath} (${id.slice(0, 8)})`);
  });
});

function attachAgent(ws: WebSocket): void {
  let agent: AgentConn | null = null;

  ws.on('message', (raw) => {
    const frame = decodeFrame<AgentFrame>(raw.toString());
    if (!frame) return;

    if (frame.t === 'hello') {
      const hello = frame as HelloFrame;
      agent = new AgentConn(
        hello.agentId,
        hello.label,
        ws,
        hello.environments,
        Math.max(1, hello.maxConcurrency),
      );
      registry.add(agent);
      registry.drain();
      ws.send(
        JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION, heartbeatMs: cfg.heartbeatMs }),
      );
      const envList = hello.environments.map((e) => `${e.name}:${e.port}`).join(', ');
      log(`+ agent "${hello.label}" [${envList}]`);
      return;
    }

    // Every other frame requires an established agent.
    if (!agent) return;

    switch (frame.t) {
      case 'ping': {
        agent.lastSeen = Date.now();
        agent.states = frame.states;
        ws.send(JSON.stringify({ t: 'pong' }));
        // A machine whose app just came back, or that just loaded the model a
        // waiter needs, is newly usable capacity.
        registry.drain();
        break;
      }
      case 'res_head': {
        const p = agent.pending.get(frame.id);
        if (!p) break;
        const headers = { ...frame.headers };
        // We re-frame as chunked; the local app framing headers would conflict.
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        // The local app may set its own CORS policy, which would be wrong for
        // the broker's origin and could duplicate the header. Ours wins.
        for (const h of Object.keys(headers)) {
          if (h.toLowerCase().startsWith('access-control-')) delete headers[h];
        }
        p.res.writeHead(frame.status, { ...headers, ...p.cors });
        p.headersSent = true;
        // Chat responses are SSE: without this the stream sits in Node buffers.
        p.res.flushHeaders?.();
        break;
      }
      case 'res_chunk': {
        const p = agent.pending.get(frame.id);
        if (!p) break;
        p.res.write(Buffer.from(frame.b64, 'base64'));
        break;
      }
      case 'res_end': {
        const p = agent.pending.get(frame.id);
        if (!p) break;
        agent.pending.delete(frame.id);
        registry.drain();
        p.res.end();
        log(`<- ${agent.label} ${frame.id.slice(0, 8)} ${Date.now() - p.startedAt}ms`);
        break;
      }
      case 'res_err': {
        const p = agent.pending.get(frame.id);
        if (!p) break;
        agent.pending.delete(frame.id);
        registry.drain();
        if (p.headersSent) p.res.destroy();
        else apiError(p.res, 502, `Local app error: ${frame.message}`, 'upstream_error');
        break;
      }
      case 'ws_ready': {
        const tunnel = tunnels.get(frame.id);
        if (!tunnel) break;
        tunnel.ready = true;
        // Flush anything the client sent during the local handshake.
        for (const q of tunnel.queue) {
          agent.send({ t: 'ws_data', id: frame.id, b64: q.b64, binary: q.binary });
        }
        tunnel.queue.length = 0;
        break;
      }
      case 'ws_data': {
        const tunnel = tunnels.get(frame.id);
        if (!tunnel) break;
        tunnel.clientWs.send(Buffer.from(frame.b64, 'base64'), { binary: frame.binary });
        break;
      }
      case 'ws_close': {
        const tunnel = tunnels.get(frame.id);
        if (!tunnel) break;
        tunnels.delete(frame.id);
        registry.sockets.delete(frame.id);
        tunnel.clientWs.close(frame.code ?? 1000, (frame.reason ?? '').slice(0, 120));
        break;
      }
      case 'ws_err': {
        const tunnel = tunnels.get(frame.id);
        if (!tunnel) break;
        tunnels.delete(frame.id);
        registry.sockets.delete(frame.id);
        // 1011 so the client can tell this apart from a normal close.
        tunnel.clientWs.close(1011, frame.message.slice(0, 120));
        break;
      }
    }
  });

  const onGone = (reason: string) => () => {
    if (!agent) return;
    registry.remove(agent.agentId, reason);
    log(`- agent "${agent.label}" (${reason})`);
    agent = null;
  };
  ws.on('close', onGone('disconnected'));
  ws.on('error', onGone('socket error'));
}

setInterval(
  () => {
    for (const label of registry.evictStale(cfg.staleMs)) {
      log(`- agent "${label}" (stale)`);
    }
    registry.pruneAffinity();
  },
  Math.max(1000, Math.floor(cfg.heartbeatMs / 2)),
).unref();

// A client that opens a socket and dribbles headers forever holds a connection
// for nothing. Node's defaults are permissive; these are not.
server.headersTimeout = 20_000;
server.requestTimeout = 0; // per-request ceiling is cfg.requestTimeoutMs, which understands streaming
server.keepAliveTimeout = 65_000;

server.listen(cfg.port, cfg.host, () => {
  log(`broker listening on ${cfg.host ?? '0.0.0.0'}:${cfg.port}`);
  log(`  dashboard: http://127.0.0.1:${cfg.port}/_ui`);
  if (!cfg.host) {
    // Worth saying out loud: behind a TLS-terminating proxy this means the
    // broker is also reachable directly, in plaintext, on its own port.
    log('  bound to all interfaces; set HOST=127.0.0.1 if a proxy fronts this');
  }
  log(`  app keys: ${cfg.appKeys.size}  agent tokens: ${cfg.agentTokens.size}`);
  if (cfg.appKeys.size === 0) {
    log('  WARNING: no app keys configured; every request will 401');
  }
  if (!cfg.adminKey) {
    log('  WARNING: no admin key; /_status and /_invite are disabled until one is set');
  }
  if (cfg.corsOrigin === '*') {
    log('  NOTE: CORS allows any origin; set GPUPOOL_CORS_ORIGIN to restrict which sites may use an app key');
  }
  if (!cfg.trustedProxyHops && cfg.host === '127.0.0.1') {
    // Loopback binding means a proxy is in front, and without trustProxy every
    // caller shares one rate-limit bucket.
    log('  WARNING: bound to loopback but GPUPOOL_TRUST_PROXY is not set; rate limiting will see every client as 127.0.0.1');
  }
  if (cfg.trustedProxyHops && cfg.host !== '127.0.0.1') {
    log('  WARNING: GPUPOOL_TRUST_PROXY is set while not behind a proxy; X-Forwarded-For can be spoofed to evade rate limiting');
  }
});
