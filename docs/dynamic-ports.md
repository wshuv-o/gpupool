# Publishing a port from your own application

The case this exists for: someone clicks a button in your app, your code starts
a model on whatever port was free, and that port needs to be reachable through
the pool a second later.

A manifest cannot express that — the port did not exist when the manifest was
written. So the agent on each leaf can run a small local API that your
application calls to publish a port, and to withdraw it when the work is done.

## Turning it on

The control API is off by default. A machine whose environments never change
has no reason to listen for them.

```bash
gpupool serve --control 9800
```

or in `gpupool.yaml`:

```yaml
controlPort: 9800
```

It binds **127.0.0.1 only**. Anything that can reach it can publish a port on
this machine to the entire pool, so it is deliberately not reachable from the
network, and a token is required on top.

## Finding the token

Minted on first use and written next to the agent's credentials, so your
application reads it from a file it already has to know about:

- Windows: `%USERPROFILE%\.gpupool\credentials.json`
- Linux/macOS: `~/.gpupool/credentials.json`

```json
{ "broker": "https://gpu.example.com", "controlToken": "ct_..." }
```

Read `controlToken` at startup. Do not copy it anywhere else.

## The three calls

### Publish a port

```http
POST http://127.0.0.1:9800/register
Authorization: Bearer <controlToken>
Content-Type: application/json

{ "port": 9123, "name": "job-abc", "health": "/healthz" }
```

`port` is required. `name` is optional and becomes the route — omitted, you get
`port-9123`. `health` is optional; with it the agent polls that path and drops
the environment out of the pool when it stops answering, which is worth setting
for anything long-lived.

```json
{
  "environment": "job-abc",
  "port": 9123,
  "url": "https://gpu.example.com",
  "key": "pk_1be0bf41c70fc4eec9658caf8d02de11",
  "note": "Use url + key to reach this port through the pool."
}
```

`url` + `key` is everything a caller needs. Hand them to whoever asked for the
work — a browser, another service, a queue consumer.

### List what this machine publishes

```http
GET http://127.0.0.1:9800/registered
Authorization: Bearer <controlToken>
```

Returns every environment including ones from the manifest, each with its
current key.

### Withdraw it

```http
DELETE http://127.0.0.1:9800/register/job-abc
Authorization: Bearer <controlToken>
```

Call this when the work finishes. The route disappears and **its key stops
working immediately** — a key never outlives the port it addressed.

## A worked example

```python
import json, os, subprocess, requests

home = os.path.expanduser("~/.gpupool/credentials.json")
control_token = json.load(open(home))["controlToken"]
CONTROL = "http://127.0.0.1:9800"
auth = {"Authorization": f"Bearer {control_token}"}

def run_job(job_id, model):
    port = free_port()
    proc = subprocess.Popen(["vllm", "serve", model, "--port", str(port)])
    wait_until_listening(port)

    published = requests.post(
        f"{CONTROL}/register",
        headers=auth,
        json={"port": port, "name": f"job-{job_id}", "health": "/health"},
    ).json()

    try:
        # Anyone, anywhere, can now use these two values.
        return published["url"], published["key"]
    finally:
        pass  # withdraw when the job is actually done, below

def finish_job(job_id, proc):
    requests.delete(f"{CONTROL}/register/job-{job_id}", headers=auth)
    proc.terminate()
```

## Things worth knowing

**Keys are not permanent.** A published environment exists only while the
machine serving it is connected. If the root restarts, or the leaf reconnects,
the agent re-publishes and the root issues a **new** key. An application that
cached one will start getting `401`. Re-read `GET /registered` when that
happens rather than treating it as fatal.

**Nothing is persisted.** Publishing is a runtime fact, not configuration. A
leaf that restarts comes back with only what its manifest declares; your
application republishes whatever it restarts.

**Names are cleaned.** Lower-cased, and anything outside `a-z0-9._-` becomes a
dash. Two machines publishing the same name is fine and useful — they become
one route, and the root spreads requests across both.

**Withdraw on failure too.** If your process dies without calling `DELETE`, the
route lingers until the health check fails or the agent disconnects. With a
`health` path that is quick; without one the agent only knows the port closed,
so set one for anything that might crash.
