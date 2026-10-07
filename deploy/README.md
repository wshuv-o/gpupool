# Deploying the broker on your own server

Everything here keeps your traffic on infrastructure you control. The broker is
a relay — no GPU, modest CPU, bandwidth is what matters, since every token
passes through it.

## Why self-host

Hosted tunnels (Cloudflare Tunnel, ngrok and the rest) terminate TLS on their
edge, so the provider can read every prompt and response in plaintext. Running
the broker on your own server removes that entirely: the only machines that see
your data are yours.

GPU machines still need nothing exposed. They dial *outbound* to the broker and
hold the connection open, so they stay behind NAT with no port forwarding and
no inbound firewall rule.

## What you need

- A server with a public IP, Ubuntu/Debian, Node 20+
- A DNS record pointing at it
- nginx and certbot for TLS (nginx is likely already there)

## Install

```bash
sudo bash install.sh
```

Idempotent — re-run it to upgrade. Credentials are generated on first run only,
so upgrading never invalidates machines that already joined.

It creates a `gpupool` system user, builds into `/opt/gpupool`, writes
`/etc/gpupool/broker.env` (mode 0640, root-owned), keeps runtime state in
`/var/lib/gpupool`, and installs a hardened systemd unit.

The broker binds **127.0.0.1 only**. nginx is the one thing that reaches it, so
the broker is never exposed in plaintext on its own port.

## nginx

Copy `nginx-gpupool.conf` to `/etc/nginx/sites-available/`, add the `map` block
from the top of that file into the `http{}` block of `/etc/nginx/nginx.conf`,
symlink it into `sites-enabled/`, then run certbot.

Two settings in there are not optional:

- **`proxy_buffering off`** — with buffering on, nginx holds the whole response
  before sending any of it, so token streaming arrives as one burst at the end.
  Nothing errors, which is exactly why this gets missed.
- **the `Upgrade`/`Connection` headers** — every GPU machine holds a WebSocket
  to the broker. Without these no machine can register at all.

`proxy_read_timeout` is raised to an hour because generation legitimately takes
minutes and agent sockets are idle between heartbeats; nginx's 60s default cuts
both off.

## Adding a GPU machine

```bash
# on the server
curl -X POST https://gpu.example.com/_invite -H "Authorization: Bearer $ADMIN_KEY"

# on the GPU machine
gpupool join <code> --broker https://gpu.example.com --label office-3090
gpupool service install
```

Nothing restarts, and machines already connected are undisturbed.

## Checking it

```bash
curl https://gpu.example.com/_health
curl https://gpu.example.com/_status -H "Authorization: Bearer $ADMIN_KEY"
systemctl status gpupool-broker
journalctl -u gpupool-broker -f
```

`/_status` shows each machine, the models it holds, which are resident in VRAM,
and how many requests are queued.

## Machines on the same LAN as the broker

Point them at the broker's private address instead of the public hostname.
Every token flows through the broker, so a local machine routing out to the
internet and back is pure waste.
