/**
 * The pool dashboard, served by the broker at /_ui.
 *
 * Inlined as a string rather than read from disk: the broker ships as a
 * single-file binary, so anything it serves has to be compiled in.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gpupool</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --ink: #1a1a19; --muted: #6b6b68;
    --line: #e6e5e1; --ok: #1a7f4b; --warn: #a6681a; --bad: #b3261e;
    --accent: #2d5bd7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a19; --panel: #232322; --ink: #eceae5; --muted: #9a9a95;
      --line: #343432; --ok: #4ab87b; --warn: #d9a441; --bad: #e5766c;
      --accent: #7aa2f7;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    padding: 20px 24px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px;
  }
  .stat { font-size: 26px; font-weight: 620; letter-spacing: -0.02em; }
  .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em;
       color: var(--muted); margin: 32px 0 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  th { font-size: 12px; color: var(--muted); font-weight: 600; }
  td { font-size: 14px; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
  code, .mono { font-family: ui-monospace, "Cascadia Code", Menlo, monospace; font-size: 13px; }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 12px;
    background: var(--bg); border: 1px solid var(--line); margin: 2px 4px 2px 0;
  }
  .pill.loaded { border-color: var(--ok); color: var(--ok); font-weight: 560; }
  button {
    font: inherit; padding: 8px 14px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:hover { filter: brightness(0.97); }
  input {
    font: inherit; padding: 8px 11px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); width: 100%;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .joincmd {
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; white-space: pre; margin: 10px 0 0;
  }
  .empty { color: var(--muted); padding: 28px; text-align: center; }
  .muted { color: var(--muted); }
  .warn { color: var(--warn); }
  #login { max-width: 380px; margin: 80px auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>gpupool</h1>
  <span class="sub" id="broker"></span>
  <span class="sub" id="tick" style="margin-left:auto"></span>
</header>

<main id="login" hidden>
  <div class="card">
    <h1 style="margin-bottom:6px">Admin key</h1>
    <p class="sub" style="margin-top:0">
      From the key printed by <code>gpupool setup root</code>, or
      <code>broker.config.json</code>.
    </p>
    <form id="loginForm">
      <input id="key" type="password" placeholder="admin_..." autocomplete="off">
      <div class="row" style="margin-top:12px">
        <button class="primary" type="submit">Open dashboard</button>
        <span id="loginErr" class="warn"></span>
      </div>
    </form>
  </div>
</main>

<main id="app" hidden>
  <div class="grid">
    <div class="card"><div class="label">Machines</div><div class="stat" id="nMachines">-</div></div>
    <div class="card"><div class="label">Running now</div><div class="stat" id="nActive">-</div></div>
    <div class="card"><div class="label">Queued</div><div class="stat" id="nQueued">-</div></div>
    <div class="card"><div class="label">Served</div><div class="stat" id="nServed">-</div></div>
  </div>

  <h2>Machines</h2>
  <div class="card" style="padding:0">
    <table>
      <thead><tr><th>Machine</th><th>Environment</th><th>Models</th><th>Load</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="noMachines" hidden>
      No machines yet. Use the setup key below to add one.
    </div>
  </div>

  <h2>Add a machine</h2>
  <div class="card">
    <div class="row">
      <span class="mono" id="ekey" style="flex:1"></span>
      <button id="copyKey">Copy</button>
      <button id="toggleOpen"></button>
      <button id="rotate">Rotate</button>
    </div>
    <div class="joincmd mono" id="joincmd"></div>
    <p class="sub" id="enrollNote"></p>
    <p class="sub">Not set up yet? Send people the <a href="/install">setup sheet</a>: it says where to download gpupool and what to run.</p>
  </div>
</main>

<script>
var $ = function (id) { return document.getElementById(id); };

// sessionStorage, not a cookie: a cookie would ride along on every proxied API
// request too, and this key belongs only on the admin endpoints.
var adminKey = sessionStorage.getItem('gpupool_admin') || '';

function api(path, opts) {
  opts = opts || {};
  var headers = Object.assign({}, opts.headers || {}, {
    authorization: 'Bearer ' + adminKey
  });
  return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
    if (res.status === 401) throw new Error('unauthorised');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

function showLogin(msg) {
  $('login').hidden = false;
  $('app').hidden = true;
  $('loginErr').textContent = msg || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function pills(models, loaded) {
  if (!models || !models.length) return '<span class="muted">not reported</span>';
  var set = {};
  (loaded || []).forEach(function (m) { set[m] = true; });
  // Resident models first: that is what routing actually prefers, so it is
  // what someone scanning this table needs to see.
  return models.slice().sort(function (a, b) {
    return (set[b] ? 1 : 0) - (set[a] ? 1 : 0);
  }).map(function (m) {
    return '<span class="pill' + (set[m] ? ' loaded' : '') + '">' +
      escapeHtml(m) + (set[m] ? ' &middot; in VRAM' : '') + '</span>';
  }).join('');
}

function renderRows(agents) {
  var out = [];
  agents.forEach(function (a) {
    a.environments.forEach(function (e, i) {
      out.push('<tr>' +
        (i === 0
          ? '<td rowspan="' + a.environments.length + '"><strong>' + escapeHtml(a.label) +
            '</strong><br><span class="sub mono">' + escapeHtml(a.agentId) + '</span></td>'
          : '') +
        '<td><span class="dot ' + (e.ready ? 'ok' : 'bad') + '"></span>' +
          escapeHtml(e.name) + '<br><span class="sub mono">:' + e.port + '</span></td>' +
        '<td>' + pills(e.models, e.loaded) + '</td>' +
        (i === 0
          ? '<td rowspan="' + a.environments.length + '">' + a.activeJobs + ' / ' +
            a.maxConcurrency + '</td>'
          : '') +
        '</tr>');
    });
  });
  return out.join('');
}

function refresh() {
  return api('/_status').then(function (st) {
    $('broker').textContent = location.host;
    $('nMachines').textContent = st.agents.length;
    $('nActive').textContent = st.agents.reduce(function (n, a) { return n + a.activeJobs; }, 0);
    $('nQueued').textContent = st.queued || 0;
    $('nServed').textContent = st.agents.reduce(function (n, a) { return n + a.served; }, 0);
    $('rows').innerHTML = renderRows(st.agents);
    $('noMachines').hidden = st.agents.length > 0;
    $('tick').textContent = 'updated ' + new Date().toLocaleTimeString();

    return api('/_enrollment').then(function (enr) {
      $('ekey').textContent = enr.key;
      $('toggleOpen').textContent = enr.open ? 'Close enrollment' : 'Open enrollment';
      $('joincmd').textContent =
        'gpupool setup leaf --key ' + enr.key + ' --root ' + location.origin;
      $('enrollNote').textContent = enr.open
        ? 'Any machine with this key can join. Close it once yours have.'
        : 'Closed. Machines already joined keep working; new ones are refused.';
    }).catch(function () { /* enrollment is a convenience; the table matters more */ });
  }).catch(function (err) {
    if (String(err.message) === 'unauthorised') return showLogin('Key no longer valid.');
    $('tick').textContent = 'broker unreachable';
  });
}

$('loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  adminKey = $('key').value.trim();
  api('/_status').then(function () {
    sessionStorage.setItem('gpupool_admin', adminKey);
    $('login').hidden = true;
    $('app').hidden = false;
    refresh();
  }).catch(function () {
    showLogin('That key was not accepted.');
  });
});

$('copyKey').onclick = function () {
  if (navigator.clipboard) navigator.clipboard.writeText($('ekey').textContent);
};

$('toggleOpen').onclick = function () {
  var closing = $('toggleOpen').textContent.indexOf('Close') === 0;
  api('/_enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ open: !closing })
  }).then(refresh);
};

$('rotate').onclick = function () {
  if (!confirm('Rotate the setup key? The old one stops working immediately.')) return;
  api('/_enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rotate: true })
  }).then(refresh);
};

if (adminKey) {
  api('/_status').then(function () {
    $('app').hidden = false;
    refresh();
  }).catch(function () { showLogin(); });
} else {
  showLogin();
}

setInterval(function () { if (!$('app').hidden) refresh(); }, 3000);
</script>
</body>
</html>`;
