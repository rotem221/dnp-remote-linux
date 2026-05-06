// Local web UI returned as a single-page HTML string. We deliberately
// avoid a build pipeline (no Svelte, no Vite, no bundler) so the
// `npm install -g` user gets a fully working daemon as soon as the
// package extracts — no `npm run build` step, no extra deps. The page
// fetches state from the daemon's HTTP routes (`/api/state`) and
// shows the pairing QR + connected peers.

export function renderUI(args: {
  qrSVG: string;
  endpoint: string;
  humanCode: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>DNP Remote · Linux</title>
<style>
  :root {
    --bg: #0c0d10;
    --surface: #15171c;
    --surface-2: #1c1f26;
    --stroke: #2a2e36;
    --text: #e8eaed;
    --text-2: #a8aeb8;
    --text-3: #6f7682;
    --accent: #7c5cff;
    --success: #3ddc84;
    --warning: #ffb84d;
    --danger: #ff6b6b;
    --radius: 14px;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .page {
    max-width: 980px;
    margin: 0 auto;
    padding: 28px 22px 80px;
  }
  header { margin-bottom: 24px; }
  h1 {
    font-size: 22px; font-weight: 700;
    margin: 0 0 4px; letter-spacing: -0.01em;
  }
  header p { margin: 0; color: var(--text-2); font-size: 14px; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface);
    border: 1px solid var(--stroke);
    border-radius: var(--radius);
    padding: 18px;
  }
  .card h2 {
    margin: 0 0 12px;
    font-size: 14px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-3);
  }
  .qr-wrap {
    display: flex; flex-direction: column; align-items: center;
    gap: 12px;
  }
  .qr-wrap svg, .qr-wrap img {
    width: 220px; height: 220px;
    background: white; border-radius: 10px; padding: 8px;
  }
  .endpoint, .code {
    font-family: var(--font-mono); font-size: 13px;
    color: var(--text-2);
    word-break: break-all; text-align: center;
  }
  .code .digits {
    display: inline-block;
    font-size: 22px; font-weight: 700;
    color: var(--text); letter-spacing: 0.18em;
    background: var(--surface-2);
    border: 1px solid var(--stroke);
    border-radius: 10px;
    padding: 6px 14px;
    margin-top: 6px;
  }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px; font-size: 12px; font-weight: 600;
    border-radius: 999px; background: var(--surface-2);
    color: var(--text-2);
  }
  .badge.success { background: rgba(61,220,132,.12); color: var(--success); }
  .badge.warning { background: rgba(255,184,77,.12); color: var(--warning); }
  .badge.danger  { background: rgba(255,107,107,.12); color: var(--danger);  }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; border-bottom: 1px solid var(--stroke);
    font-size: 14px;
  }
  .row:last-child { border-bottom: 0; }
  .row .left  { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .row .label { color: var(--text); font-weight: 500; }
  .row .sub   { color: var(--text-3); font-size: 12px; }
  .empty { color: var(--text-3); font-size: 13px; padding: 14px 0 6px; }
  .footer {
    margin-top: 22px;
    color: var(--text-3); font-size: 12px; text-align: center;
  }
  code { font-family: var(--font-mono); color: var(--text-2); }
</style>
</head>
<body>
<div class="page">
  <header>
    <h1>DNP Remote · Linux daemon</h1>
    <p>
      Pair this Linux box with the
      <a href="https://github.com/rotem221/DNPRemoteIDE" style="color:var(--accent)">DNP Remote IDE</a>
      iPhone companion to drive Claude Code (or any PTY shell)
      remotely from your phone.
    </p>
  </header>

  <div class="grid">
    <section class="card">
      <h2>Pair an iPhone</h2>
      <div class="qr-wrap">
        ${args.qrSVG}
        <div class="endpoint" id="endpoint">${escapeHtml(args.endpoint)}</div>
        <div class="code">
          Or enter manually
          <br/>
          <span class="digits" id="humanCode">${escapeHtml(args.humanCode)}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Status</h2>
      <div class="row">
        <div class="left">
          <span class="label">Bridge</span>
          <span class="sub">Listening for iPhone connections</span>
        </div>
        <span class="badge success" id="bridgeBadge">Online</span>
      </div>
      <div class="row">
        <div class="left">
          <span class="label">Sessions</span>
          <span class="sub" id="sessionsSub">No active sessions</span>
        </div>
        <span class="badge" id="sessionsBadge">0</span>
      </div>
      <div class="row">
        <div class="left">
          <span class="label">Paired devices</span>
          <span class="sub" id="peersSub">No iPhones paired yet</span>
        </div>
        <span class="badge" id="peersBadge">0</span>
      </div>
    </section>

    <section class="card" style="grid-column: 1 / -1;">
      <h2>Paired iPhones</h2>
      <div id="peersList"><div class="empty">No iPhones paired yet — scan the QR with the DNP Remote IDE app.</div></div>
    </section>

    <section class="card" style="grid-column: 1 / -1;">
      <h2>Sessions</h2>
      <div id="sessionsList"><div class="empty">No sessions yet — your iPhone will create them on demand.</div></div>
    </section>
  </div>

  <div class="footer">
    Stop the daemon at any time with <code>Ctrl-C</code> in the terminal it was launched from.
  </div>
</div>

<script>
async function refresh() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    document.getElementById('sessionsBadge').textContent = s.sessions.length;
    document.getElementById('sessionsSub').textContent = s.sessions.length
      ? s.sessions.length + ' active session' + (s.sessions.length === 1 ? '' : 's')
      : 'No active sessions';
    document.getElementById('peersBadge').textContent = s.peers.length;
    document.getElementById('peersSub').textContent = s.peers.length
      ? s.peers.length + ' iPhone' + (s.peers.length === 1 ? '' : 's') + ' paired'
      : 'No iPhones paired yet';
    document.getElementById('peersList').innerHTML = renderPeers(s.peers);
    document.getElementById('sessionsList').innerHTML = renderSessions(s.sessions);
    document.getElementById('endpoint').textContent = s.endpoint;
    document.getElementById('humanCode').textContent = s.humanCode;
  } catch {}
}
function renderPeers(peers) {
  if (!peers.length) {
    return '<div class="empty">No iPhones paired yet — scan the QR with the DNP Remote IDE app.</div>';
  }
  return peers.map(p => \`
    <div class="row">
      <div class="left">
        <span class="label">\${escapeHtml(p.deviceName)}</span>
        <span class="sub">\${escapeHtml(p.platform)} · paired \${escapeHtml(p.pairedAt.split('T')[0])}</span>
      </div>
      <span class="badge success">Trusted</span>
    </div>
  \`).join('');
}
function renderSessions(list) {
  if (!list.length) {
    return '<div class="empty">No sessions yet — your iPhone will create them on demand.</div>';
  }
  return list.map(s => \`
    <div class="row">
      <div class="left">
        <span class="label">\${escapeHtml(s.title)}</span>
        <span class="sub">\${escapeHtml(s.projectName)} · \${escapeHtml(s.status)}</span>
      </div>
      <span class="badge \${s.status === 'running' ? 'success' : (s.status === 'ended' ? '' : 'warning')}">\${escapeHtml(s.status)}</span>
    </div>
  \`).join('');
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
}
