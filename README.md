# gpupool

Expose a local port to the internet, across several machines, with automatic
failover when one of them is off.

You run something on a GPU box — Ollama, vLLM, ComfyUI, a FastAPI service, your
own code, anything that speaks HTTP. gpupool makes it reachable from your
deployed app, and routes around machines that are powered down.

```
browser → your app on Vercel → broker (always on) → ┬→ office-3090   :11434
                                                     ├→ home-4070     :11434
                                                     └→ friend-4090   :11434
```

The GPU boxes never listen on a public port. Each one dials *out* to the broker
over a WebSocket and holds it open, so home routers and NAT are a non-issue —
no port forwarding, no static IP, no tunnel to configure.

## Three parts

| Part | Runs where | Job |
|---|---|---|
| **agent** | each GPU machine | dials out, health-checks your local app, proxies requests to it |
| **broker** | one always-on host | keeps the live registry, resolves app keys, relays streams |
| **your app** | Vercel, Lambda, anywhere | points at the broker and forgets the rest |

Only the broker needs hosting. It is a small stateful Node service that relays
bytes and never computes, so the smallest instance your platform sells is
enough.

## On a GPU machine

Pair once, install as a service, done. Credentials persist in
`~/.gpupool/credentials.json`.

```bash
gpupool login --broker https://broker.example.com \
              --token at_REPLACE_WITH_YOUR_OWN \
              --label office-3090
gpupool service install            # survives reboots
```

`gpupool serve` runs it in the foreground instead, which is what you want while
getting the manifest right.

Declare what to expose in `gpupool.yaml`. gpupool neither knows nor cares what
is behind the port:

```yaml
environments:
  chatapp:
    port: 11434          # Ollama, as it happens
    health: /api/tags    # polled; a crashed app drops out of the pool
  imagegen:
    port: 9999           # something else entirely
    health: /healthz

maxConcurrency: 4        # requests this machine accepts at once
```

`health` is optional. Without it the agent settles for a TCP connect check,
which catches the app having exited but not the app being broken.

## Running it as a service

This is what makes a machine contribute whenever it is powered on, rather than
whenever someone remembered to leave a terminal open.

```bash
gpupool service install              # starts at logon, no admin needed
gpupool service install --system     # starts at boot, needs admin/root
gpupool service install --dry-run    # print the definition, change nothing
gpupool service status
gpupool service uninstall
```

Each platform's native supervisor does the work, so you can inspect and remove
what was installed with tools you already know:

| Platform | Mechanism | Notes |
|---|---|---|
| Windows | Task Scheduler (XML) | restarts every minute on failure; runs on battery |
| Linux | systemd | `Restart=always`, `RestartSec=5` |
| macOS | launchd | `KeepAlive`, `RunAtLoad` |

Two things worth knowing. The Windows task is generated as XML rather than
plain `schtasks` flags because the defaults are wrong for this job — tasks
normally refuse to start on battery, stop when a laptop unplugs, and give up
after a crash. And a Linux *user* service dies at logout unless you enable
lingering, which the installer tells you about:

```bash
sudo loginctl enable-linger $USER
```

`--dry-run` prints the exact unit, plist, or task XML without touching the
system. Worth using first: these files are easy to get subtly wrong and
annoying to debug once a supervisor owns them.

## From your application

The broker is a transparent HTTP proxy, so whatever your local app speaks, your
app speaks. If the local app is Ollama, every OpenAI-compatible client works
with a one-line change and no SDK at all:

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'https://broker.example.com/v1',
  apiKey: process.env.GPUPOOL_KEY,      // pk_chatapp_...
});

const stream = await openai.chat.completions.create({
  model: 'gpt-oss-64k:latest',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,                          // streams token-by-token
});
```

Nothing in your app knows which machine answered, or that a machine went away
between two requests.

### Environments isolate apps from each other

Each app key resolves to exactly one environment, and that binding is the only
thing that decides where a request lands:

```json
{
  "appKeys": {
    "pk_chatapp_REPLACE_ME": "chatapp",
    "pk_imagegen_REPLACE_ME": "imagegen"
  }
}
```

The `chatapp` key cannot reach `imagegen`'s port no matter what path it
requests. Revoking or repointing an app means editing this map — the app itself
never changes.

### WebSockets

WebSocket upgrades are tunnelled too, in both directions, with binary frames
and server-initiated pushes preserved. ComfyUI, A1111 and notebook kernels
report progress this way, so an HTTP-only tunnel would leave them
half-working.

Browsers cannot set headers on a WebSocket, so the key may travel as a query
parameter instead. It is stripped before the path reaches the local app:

```js
new WebSocket('wss://broker.example.com/ws?key=pk_wsapp_...');
```

One limit: subprotocol negotiation picks the client's first choice, because the
101 response must be sent before the local app has had a chance to state a
preference.

### Sticky sessions

Send a session id and the broker prefers the machine that served that session
last, so a warm KV cache or loaded model is not thrown away:

```js
headers: { 'x-gpupool-session': conversationId }
```

Affinity is a preference, never a pin. If that machine is offline or at
capacity the request goes elsewhere, because falling back beats failing.
Requests without the header are balanced normally, so this changes nothing for
stateless callers. Configure with `GPUPOOL_SESSION_HEADER` and
`GPUPOOL_SESSION_TTL_MS`.

## When nothing is available

A request for an environment with no live machine gets `503` immediately rather
than hanging:

```json
{ "error": { "message": "No machine available for environment \"chatapp\" right now. Try again later.",
             "type": "no_capacity" } }
```

The message distinguishes two cases, because they need different fixes:

- **"No machine available ... try again later"** — a machine declares this
  environment but none is ready right now. Temporary.
- **"No machine is serving ..."** — nothing in the pool declares it at all.
  A config mistake.

## Running the broker

```bash
node dist/broker/index.js          # or: docker build . && docker run
```

Tokens and keys are opaque strings you generate — there is no registration step.
Make them unguessable:

```bash
node -e "console.log('at_'+require('crypto').randomBytes(16).toString('hex'))"   # agent token
node -e "console.log('pk_'+require('crypto').randomBytes(16).toString('hex'))"   # app key
```

Configured by `broker.config.json`, with env vars taking precedence so a
deployed broker can live entirely in a platform secret store:

| Env var | Meaning |
|---|---|
| `PORT` | listen port (default 8787) |
| `GPUPOOL_AGENT_TOKENS` | comma-separated; one per machine |
| `GPUPOOL_APP_KEYS` | JSON object of app key → environment |
| `GPUPOOL_ADMIN_KEY` | guards `/_status` |
| `GPUPOOL_HEARTBEAT_MS` | ping interval (default 10s) |
| `GPUPOOL_STALE_MS` | evict a silent agent after this (default 30s) |
| `GPUPOOL_REQUEST_TIMEOUT_MS` | per-request ceiling (default 10 min; `0` disables) |
| `GPUPOOL_SESSION_HEADER` | session id header (default `x-gpupool-session`) |
| `GPUPOOL_SESSION_TTL_MS` | how long affinity survives idleness (default 10 min) |

Broker endpoints: `/_health`, `/_status`, `/_agent` (the agent WebSocket).
Everything else is proxied.

A `Dockerfile` and `fly.toml` are included. The Fly config deliberately sets
`auto_stop_machines = false`: the broker holds one long-lived socket per GPU
machine, and stopping it would drop every agent at once.

The agent is intentionally **not** containerised — it has to reach apps on the
host's own loopback, which a container cannot see.

## Single-file binary

For machines with no Node install:

```bash
npm run binary        # -> build/gpupool.exe  (~89 MB)
```

Node SEA, so it is one self-contained file. The build bakes in a flag telling
the service installer to register the binary itself rather than `node <script>`.

**Windows caveat:** an unsigned executable is blocked by Smart App Control /
WDAC on Windows 11 with "An Application Control policy has blocked this file."
Distributing the binary realistically needs an Authenticode certificate. The
`npx gpupool` route has no such problem, so that remains the easier path until
signing is in place.

## Seeing the pool

```bash
$ gpupool status --admin-key <key>
home-4070  (0/4 busy)
  chatapp  :11434  ready
office-3090  (2/4 busy)
  chatapp  :11434  ready
  imagegen  :9999  DOWN - connect ECONNREFUSED 127.0.0.1:9999
```

Health is tracked per environment, not per machine: a crashed app is pulled
from the pool while everything else on that box keeps serving.

`/_status` also reports cumulative `served` and `socketsOpened` per machine,
live `websockets`, and `stickySessions`.

## How requests travel

One WebSocket per machine, with everything multiplexed over it by id:

```
agent  → broker   hello     { agentId, label, environments, maxConcurrency }
agent  → broker   ping      { activeJobs, states }         every 10s
broker → agent    req       { id, env, method, path, headers, body }
agent  → broker   res_head  { id, status, headers }
agent  → broker   res_chunk { id, data }  × N              ← streaming lives here
agent  → broker   res_end   { id }
broker → agent    cancel    { id }                         client hung up

broker → agent    ws_open   { id, env, path, headers, protocols }
agent  → broker   ws_ready  { id, protocol }
      ↔           ws_data   { id, data, binary }           either direction
      ↔           ws_close  { id, code, reason }
```

Three details that matter:

- **Response chunks are relayed as they arrive**, never collected and
  forwarded at the end. That is what makes SSE and token streaming work; a
  buffering proxy looks correct but destroys time-to-first-token.
- **`cancel` propagates a client disconnect** down to the local app, so an
  abandoned chat stops occupying the GPU instead of generating into a void.
- **Client frames sent during the local handshake are queued, not dropped**,
  so a client that writes immediately on `open` does not lose its first
  message.

Agent selection is least-busy among ready machines with spare capacity. Plain
round-robin would happily hand a seventh request to a box already mid-generation
on three while another sits idle.

## Failure behavior

| What happens | Result |
|---|---|
| Machine powers off | socket closes, out of the pool immediately; next request goes elsewhere |
| Machine freezes | no ping for `GPUPOOL_STALE_MS`, evicted |
| Local app crashes, machine fine | health check fails, that environment only is pulled |
| Machine dies mid-stream | client connection is cut (a partial response cannot be retried) |
| Machine dies with sockets open | those WebSockets close with 1011 |
| Client hangs up | `cancel` aborts the local request |
| Nothing available | immediate `503` |
| Machine wakes up | reconnects with backoff capped at 30s, rejoins on its own |

## Tests

```bash
node test/run-all.mjs
```

Brings up a two-machine pool on localhost — machine A serving three
environments, machine B two — and checks all nine properties:

```
PASS  payload byte-identical to a direct call
PASS  requests without a valid key are rejected
PASS  an app key cannot reach another environment's port
PASS  SSE streams rather than buffers
PASS  websocket tunnel relays both directions
PASS  session affinity overrides least-busy
PASS  environment on two machines survives losing one
PASS  environment on only the dead machine returns 503
PASS  a machine that comes back rejoins on its own
```

Two of these are written the way they are for a reason:

- **Streaming** is checked by timing the gaps between chunks against a
  deterministic 60ms source, because a proxy that buffers the whole response
  and forwards it at the end is invisible to a client that only inspects the
  final body. Measured: 21 chunks for 21 events, median gap 62ms.
- **Affinity** is checked by making the affine machine the *busier* one. The
  obvious test — fire sequential requests and see them land together — proves
  nothing, since with every machine idle "least busy" already returns the same
  one every time.

The suite deliberately does not depend on a local LLM being healthy; a real
Ollama token-streaming comparison runs as an extra when one is available.

## Not in this version

- `gpupool login` takes a token you issue by hand; there is no account system
- one broker, no multi-region, and its registry is in memory
- raw TCP (non-HTTP, non-WebSocket) is not forwarded
- no metering or quotas
- the binary is unsigned, so Windows Smart App Control blocks it
- anyone with an agent token can join the pool and serve traffic, so treat
  agent tokens as trusted
