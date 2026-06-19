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
  // Stamp the daemon's package version into the page so a user staring
  // at a stale modal can verify their browser actually loaded the
  // latest JS. Hard-refresh proves itself by flipping this number.
  const version = ((): string => {
    try { return require("../package.json").version; } catch { return "?"; }
  })();
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
  button.revoke {
    background: transparent;
    color: var(--danger);
    border: 1px solid rgba(255,107,107,.4);
    border-radius: 8px;
    padding: 5px 10px;
    font-size: 12px; font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  button.revoke:hover { background: rgba(255,107,107,.12); }
  button.revoke:disabled { opacity: 0.5; cursor: default; }
  button.primary {
    background: var(--accent);
    color: #fff;
    border: 0;
    border-radius: 10px;
    padding: 10px 18px;
    font-size: 14px; font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease;
  }
  button.primary:hover { filter: brightness(1.1); }
  button.primary:disabled { opacity: 0.55; cursor: default; }
  button.ghost {
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--stroke);
    border-radius: 10px;
    padding: 9px 16px;
    font-size: 13px; font-weight: 500;
    cursor: pointer;
  }
  button.ghost:hover { background: var(--surface-2); }
  .login-hint {
    margin-top: 12px;
    padding: 12px 14px;
    background: rgba(255,184,77,.08);
    border: 1px solid rgba(255,184,77,.3);
    border-radius: 10px;
    color: var(--text-2);
    font-size: 13px; line-height: 1.55;
  }
  .login-hint code {
    background: rgba(0,0,0,.3);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .login-hint .actions {
    margin-top: 10px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.6);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    background: var(--surface);
    border: 1px solid var(--stroke);
    border-radius: 18px;
    padding: 24px;
    max-width: 540px; width: calc(100% - 40px);
    max-height: 90vh; overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,.5);
  }
  .modal h3 {
    margin: 0 0 4px;
    font-size: 18px; font-weight: 700;
    letter-spacing: -0.01em;
  }
  .modal .step {
    margin-top: 18px;
    padding: 14px;
    background: var(--surface-2);
    border-radius: 12px;
    font-size: 14px; line-height: 1.55;
    color: var(--text-2);
  }
  .modal .step strong { color: var(--text); display: block; margin-bottom: 4px; font-size: 13px; }
  .modal .url-row {
    display: flex; gap: 8px;
    margin-top: 8px;
  }
  .modal .url-row input {
    flex: 1; min-width: 0;
    background: var(--bg);
    border: 1px solid var(--stroke);
    border-radius: 8px;
    padding: 8px 10px;
    color: var(--text-2);
    font-family: var(--font-mono); font-size: 12px;
    overflow: hidden;
  }
  .modal .url-row a, .modal .url-row button {
    flex-shrink: 0;
    background: var(--accent);
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 12px; font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    display: inline-flex; align-items: center;
  }
  .modal .url-row button.copy {
    background: var(--surface);
    color: var(--text-2);
    border: 1px solid var(--stroke);
  }
  .modal textarea {
    width: 100%;
    margin-top: 8px;
    background: var(--bg);
    border: 1px solid var(--stroke);
    border-radius: 8px;
    padding: 10px;
    color: var(--text);
    font-family: var(--font-mono); font-size: 13px;
    min-height: 64px;
    resize: vertical;
  }
  .modal .footer-row {
    margin-top: 22px;
    display: flex; gap: 10px; justify-content: flex-end;
  }
  .modal .error-row {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(255,107,107,.1);
    border: 1px solid rgba(255,107,107,.35);
    border-radius: 8px;
    color: var(--danger);
    font-size: 13px;
    display: none;
  }
  .modal .error-row.shown { display: block; }
  .modal .success-row {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(61,220,132,.1);
    border: 1px solid rgba(61,220,132,.35);
    border-radius: 8px;
    color: var(--success);
    font-size: 13px;
    display: none;
  }
  .modal .success-row.shown { display: block; }
  .modal .spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid var(--stroke);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
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
      <div class="row">
        <div class="left">
          <span class="label">Claude</span>
          <span class="sub" id="claudeSub">Probing…</span>
        </div>
        <span class="badge" id="claudeBadge">…</span>
      </div>
    </section>

    <section class="card" style="grid-column: 1 / -1;">
      <h2>Paired iPhones</h2>
      <div id="peersList"><div class="empty">No iPhones paired yet — scan the QR with the DNP Remote IDE app.</div></div>
      <div id="claudeHint"></div>
    </section>

    <section class="card" style="grid-column: 1 / -1;">
      <h2>Sessions</h2>
      <div id="sessionsList"><div class="empty">No sessions yet — your iPhone will create them on demand.</div></div>
    </section>
  </div>

  <div class="footer">
    Stop the daemon at any time with <code>Ctrl-C</code> in the terminal it was launched from.
    <br/>
    <span style="opacity:0.6;">dnp-remote-linux v${version}</span>
  </div>
</div>

<div class="modal-backdrop" id="authModal" role="dialog" aria-modal="true" aria-labelledby="authTitle">
  <div class="modal">
    <h3 id="authTitle">Sign in to Claude</h3>
    <p style="margin:6px 0 0; color:var(--text-2); font-size:13px;">
      Authorise this Linux daemon to talk to Claude on your behalf. Uses
      <code style="font-family:var(--font-mono); font-size:12px;">claude setup-token</code>
      under the hood — the resulting long-lived OAuth token is stored on this
      box at <code style="font-family:var(--font-mono); font-size:12px;">~/.config/dnp-remote/claude-oauth.json</code>
      with mode 600.
    </p>
    <div class="step" id="authStep1">
      <strong>1. Open Anthropic's authorisation page</strong>
      <span id="authUrlPending"><span class="spinner"></span> Spawning <code>claude setup-token</code>…</span>
      <div class="url-row" id="authUrlReady" style="display:none;">
        <input id="authUrl" readonly />
        <a id="authUrlOpen" target="_blank" rel="noopener noreferrer">Open ↗</a>
        <button class="copy" id="authUrlCopy" type="button">Copy</button>
      </div>
    </div>
    <div class="step" id="authStep2" style="opacity:0.5;">
      <strong>2. Paste the code Anthropic gives you</strong>
      Sign in, then Anthropic shows a one-time code on the callback page.
      Copy that code and paste it below. After Submit, the daemon makes
      an OAuth round-trip to <code style="font-family:var(--font-mono); font-size:11px;">api.anthropic.com</code>
      which can take up to ~2 minutes on a slow connection — leave the
      modal open until you see "Token saved" or an error.
      <textarea id="authCode" placeholder="Paste the code from Anthropic here" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
    </div>
    <div class="error-row" id="authError"></div>
    <div class="success-row" id="authSuccess">
      Token saved. Future Claude sessions on this daemon will use it automatically.
    </div>
    <div class="footer-row">
      <button class="ghost" id="authCancel" type="button">Close</button>
      <button class="primary" id="authSubmit" type="button" disabled>Submit code</button>
    </div>
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
    renderClaude(s.claude);
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
        <span class="sub">\${escapeHtml(p.platform)} · paired \${escapeHtml((p.pairedAt || '').split('T')[0])}</span>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="badge success">Trusted</span>
        <button class="revoke" data-device-id="\${escapeHtml(p.deviceId)}" data-name="\${escapeHtml(p.deviceName)}">Revoke</button>
      </div>
    </div>
  \`).join('');
}
function renderClaude(claude) {
  const badge = document.getElementById('claudeBadge');
  const sub   = document.getElementById('claudeSub');
  const hint  = document.getElementById('claudeHint');
  if (!claude) {
    badge.textContent = '?'; badge.className = 'badge';
    sub.textContent = 'Status unknown';
    hint.innerHTML = '';
    return;
  }
  if (claude.authState === 'ok') {
    badge.textContent = 'Authenticated'; badge.className = 'badge success';
    sub.textContent = claude.version || 'Logged in and ready';
    hint.innerHTML = '';
  } else if (claude.authState === 'not-logged-in') {
    badge.textContent = 'Login required'; badge.className = 'badge warning';
    sub.textContent = (claude.version || 'Claude installed') + ' — but no credentials for this user';
    hint.innerHTML = \`
      <div class="login-hint">
        <strong>Claude isn\\'t logged in for this daemon yet.</strong><br/>
        Sessions opened from your iPhone will hang on the login screen until
        you authorise the daemon. Click below — it walks you through the same
        OAuth flow <code>claude setup-token</code> does, right from this page.
        <div class="actions">
          <button class="primary" id="signInBtn" type="button">Sign in to Claude</button>
        </div>
      </div>
    \`;
    const btn = document.getElementById('signInBtn');
    if (btn) btn.addEventListener('click', () => openAuthModal());
  } else if (claude.authState === 'missing') {
    badge.textContent = 'Not installed'; badge.className = 'badge danger';
    sub.textContent = '\`claude\` not found on PATH';
    hint.innerHTML = \`
      <div class="login-hint">
        <strong>The Claude Code CLI isn\\'t installed.</strong><br/>
        Install it with: <code>npm install -g @anthropic-ai/claude-code</code> then refresh this page.
      </div>
    \`;
  } else {
    badge.textContent = 'Unknown'; badge.className = 'badge';
    sub.textContent = claude.detail || 'Could not determine login state';
    hint.innerHTML = '';
  }
}
document.addEventListener('click', async (e) => {
  const btn = e.target;
  if (!(btn instanceof HTMLElement) || !btn.classList.contains('revoke')) return;
  const id = btn.getAttribute('data-device-id');
  const name = btn.getAttribute('data-name') || 'this device';
  if (!id) return;
  if (!confirm('Revoke ' + name + '? It will need to scan the QR again to reconnect.')) return;
  btn.disabled = true; btn.textContent = 'Revoking…';
  try {
    await fetch('/api/peers/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
    await refresh();
  } catch {
    btn.disabled = false; btn.textContent = 'Revoke';
  }
});

// ---------- Sign in to Claude flow ----------
let authSessionId = null;
const $ = (id) => document.getElementById(id);
async function openAuthModal() {
  $('authModal').classList.add('open');
  $('authError').classList.remove('shown'); $('authError').textContent = '';
  $('authSuccess').classList.remove('shown');
  $('authUrlPending').style.display = '';
  $('authUrlReady').style.display = 'none';
  $('authStep2').style.opacity = '0.5';
  $('authCode').value = '';
  $('authSubmit').disabled = true;
  authSessionId = null;
  try {
    const r = await fetch('/api/claude/auth/start', { method: 'POST' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      showAuthError(j.error || 'Failed to start auth');
      return;
    }
    const j = await r.json();
    authSessionId = j.sessionId;
    $('authUrl').value = j.url;
    $('authUrlOpen').href = j.url;
    $('authUrlPending').style.display = 'none';
    $('authUrlReady').style.display = 'flex';
    $('authStep2').style.opacity = '1';
    $('authSubmit').disabled = false;
  } catch (e) {
    showAuthError('Network error: ' + e);
  }
}
function showAuthError(msg) {
  $('authError').textContent = msg;
  $('authError').classList.add('shown');
}
function showAuthSuccess() {
  $('authSuccess').classList.add('shown');
  $('authStep1').style.opacity = '0.5';
  $('authStep2').style.opacity = '0.5';
  $('authSubmit').disabled = true;
}
async function submitAuthCode() {
  if (!authSessionId) return;
  // Strip every whitespace char client-side too. Mirrors the server's
  // sanitisation so the user sees the cleaned form in the textarea
  // before it hits claude — useful feedback when the paste from
  // console.claude.com landed with a soft-wrap newline.
  const raw = $('authCode').value;
  const code = raw.replace(/\s+/g, '');
  if (code !== raw) $('authCode').value = code;
  if (!code) { showAuthError('Paste the code from Anthropic first.'); return; }
  $('authError').classList.remove('shown');
  $('authSubmit').disabled = true;
  $('authSubmit').innerHTML = '<span class="spinner"></span>Submitting…';
  // Polling sweeps the daemon's session state every 800ms. Catches:
  //   - failed (with claude's own error wording) the moment it lands,
  //     instead of waiting for the long timeout
  //   - complete the moment the token is captured (the round-trip to
  //     api.anthropic.com can run >30s on a slow tailnet, so the user
  //     sees the green "Token saved" up to a minute before the fetch
  //     resolves naturally on its own deadline)
  const sid = authSessionId;
  let pollHandle = null;
  let elapsed = 0;
  const poll = async () => {
    if (sid !== authSessionId) return;
    elapsed += 0.8;
    // Keep the spinner caption fresh so the user knows the daemon is
    // alive and not the browser-spinner-of-doom.
    if (elapsed > 4 && elapsed < 110) {
      $('authSubmit').innerHTML = '<span class="spinner"></span>Waiting for Anthropic… ' + Math.round(elapsed) + 's';
    }
    try {
      const r = await fetch('/api/claude/auth/status?sessionId=' + encodeURIComponent(sid), { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      if (s.state === 'failed' && s.error) {
        clearInterval(pollHandle);
        showAuthError(s.error + (/Invalid code/i.test(s.error) ? ' — close this dialog, click Sign in again for a fresh URL, then copy the FULL code (including any "#…" tail) from the Anthropic page.' : ''));
        $('authSubmit').disabled = false;
        $('authSubmit').textContent = 'Submit code';
      } else if (s.state === 'complete') {
        clearInterval(pollHandle);
        showAuthSuccess();
        setTimeout(refresh, 500);
        setTimeout(closeAuthModal, 2200);
      }
    } catch {}
  };
  pollHandle = setInterval(poll, 800);
  try {
    const r = await fetch('/api/claude/auth/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, code }),
    });
    clearInterval(pollHandle);
    const j = await r.json();
    if (j.ok) {
      showAuthSuccess();
      // Force a fresh probe on the next /api/state so the badge flips
      // immediately rather than waiting for the 30s probe cache.
      setTimeout(refresh, 500);
      setTimeout(closeAuthModal, 2200);
    } else {
      // Only overwrite the error if the poller hasn't already shown one;
      // claude's exact wording (set by the poller) is more useful than
      // our generic timeout text.
      if (!$('authError').classList.contains('shown')) {
        showAuthError(j.error || 'Auth failed');
      }
      $('authSubmit').disabled = false;
      $('authSubmit').textContent = 'Submit code';
    }
  } catch (e) {
    clearInterval(pollHandle);
    showAuthError('Network error: ' + e);
    $('authSubmit').disabled = false;
    $('authSubmit').textContent = 'Submit code';
  }
}
async function closeAuthModal() {
  // Just hide the modal — DON'T delete the in-flight session. If the
  // user clicks Close while a tab is still open with the OAuth URL,
  // they should be able to reopen Sign-in, paste the code, and have
  // the daemon match the state to the still-alive session. The 10-min
  // TTL cleans up if it really was abandoned.
  $('authModal').classList.remove('open');
  authSessionId = null;
}
$('authCancel').addEventListener('click', closeAuthModal);
$('authSubmit').addEventListener('click', submitAuthCode);
$('authUrlCopy').addEventListener('click', () => {
  const inp = $('authUrl');
  inp.select(); inp.setSelectionRange(0, 99999);
  try { navigator.clipboard.writeText(inp.value); } catch { document.execCommand('copy'); }
  $('authUrlCopy').textContent = 'Copied';
  setTimeout(() => { $('authUrlCopy').textContent = 'Copy'; }, 1500);
});
// Deliberately NOT closing the modal on backdrop click — that has ended
// auth attempts mid-flow when the user clicked outside while reading
// the Anthropic page in another tab. The Cancel/Close button is the
// only path that cancels.
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
