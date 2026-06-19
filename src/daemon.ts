// Wires everything together. Boots the HTTP server (which doubles as
// the WebSocket transport via `ws({ server })`), the pairing token
// store, the sessions manager, and the dispatcher. Returns a tiny
// stop() handle so the CLI can shut down cleanly on Ctrl-C.

import os from "node:os";
import { createHTTPServer } from "./http.js";
import { BridgeServer } from "./wsBridge.js";
import { Dispatcher } from "./dispatcher.js";
import { Sessions } from "./sessions.js";
import { FilesService } from "./files.js";
import { issuePairingTokens, PairingTokens } from "./pairing.js";
import {
  Identity,
  loadOrCreateIdentity,
  saveIdentity,
  configDirPath,
  forgetPeer,
  ensureClaudeOnboardingComplete,
  loadClaudeOAuthToken,
} from "./keys.js";

export interface DaemonOptions {
  /** WebSocket bridge port — defaults to 18733 (matches the Mac). */
  bridgePort: number;
  /** UI port — distinct from the bridge port so an iPhone can keep a
   *  long-lived bridge connection while the user reloads the UI. */
  uiPort: number;
  /** Command launched per new session. */
  defaultCommand: string;
  /** Project root that becomes every new session's `cwd`. */
  projectRoot: string;
  /** External hostname/IP the iPhone reaches. Auto-detected from
   *  `os.networkInterfaces()` when not supplied. */
  externalHost?: string;
}

export interface DaemonHandle {
  bridgePort: number;
  uiPort: number;
  uiURL: string;
  bridgeEndpoint: string;
  identityPath: string;
  identity: Identity;
  stop: () => Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  let identity = loadOrCreateIdentity();
  // Skip claude's first-run onboarding TUI for the daemon's user. Without
  // these flags the theme picker steals every keystroke the iPhone sends
  // until the user (somehow) navigates with arrow keys to "Dark mode" and
  // hits Enter — claude looks alive but ignores prompts. Idempotent.
  ensureClaudeOnboardingComplete();
  // Hydrate the persisted Claude OAuth token into the daemon's
  // `process.env` BEFORE anything spawns `claude`. Three things rely on
  // this being set early:
  //   1. The `claudeStatus` probe — without it, claude says "Not logged
  //      in", the UI shows "Login required", and the user re-runs OAuth
  //      every restart even though the token on disk is valid.
  //   2. Sessions spawned for the iPhone — `sessions.ts` falls back to
  //      `loadClaudeOAuthToken()` if env is missing, so this is belt +
  //      braces, but env-set is the source of truth.
  //   3. Future child processes inherit it automatically.
  const persistedToken = loadClaudeOAuthToken();
  if (persistedToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = persistedToken;
  }
  const tokens: PairingTokens = issuePairingTokens();
  const externalHost = opts.externalHost ?? bestLANAddress();
  const bridgeEndpoint = `tcp://${externalHost}:${opts.bridgePort}`;
  // Tailscale fallback. The iPhone scanner reads this from the QR's `te`
  // field and falls back to it if the primary `e` (LAN) endpoint can't be
  // reached within the pairing watchdog window. We auto-detect a tailnet
  // IP on `tailscale*` interfaces — that's the same logic the Mac uses.
  // If `--host` was passed and it's already a tailnet address, `te` stays
  // null (the primary endpoint already covers the tailnet path).
  const tailscaleEndpoint = opts.externalHost
    ? null
    : tailscaleAddress(opts.bridgePort);

  // The ordering below matters: dispatcher needs the bridge, sessions
  // need the dispatcher (for liveEvent broadcasts), and the bridge owns
  // its own raw-TCP listener now (it used to share the daemon's HTTP
  // server when the protocol was — incorrectly — assumed to be
  // WebSocket).
  const httpServer = createHTTPServer({
    identity: () => identity,
    sessions: () => sessions,
    pairingTokens: () => tokens,
    bridgeEndpoint: () => bridgeEndpoint,
    tailscaleEndpoint: () => tailscaleEndpoint,
    revokePeer: (deviceId) => {
      // Update the persisted identity (drops the peer from `trustedPeers`)
      // AND drop any active bridge connection that peer holds, so a
      // browser-driven revoke doesn't leave a phantom session ticking.
      identity = forgetPeer(identity, deviceId);
      saveIdentity(identity);
      dispatcherRef?.dropConnectionsForDevice(deviceId);
    },
  });

  // Sessions get a forward-declaration ref to the dispatcher via a
  // mutable holder — they're constructed BEFORE the dispatcher because
  // the dispatcher's `cb.sessions` needs them, but the sessions need
  // a callback that the dispatcher provides. Box-and-hand-back keeps
  // both sides happy without circular constructors.
  let dispatcherRef: Dispatcher | null = null;
  const sessions = new Sessions({
    defaultCommand: opts.defaultCommand,
    projectRoot: opts.projectRoot,
    onSessionsChanged: () => dispatcherRef?.sendSessionList(),
    onLiveEvent: (event) => dispatcherRef?.broadcastLiveEvent(event),
  });

  // First constructor argument is unused (BridgeServer kept its old
  // signature for diff minimisation when migrating off WebSocket).
  const bridge = new BridgeServer(null, {
    onConnection: (_conn) => { /* noop */ },
    onFrame: (frame, conn) => dispatcherRef?.onFrame(frame, conn),
    onDisconnect: (id) => dispatcherRef?.onConnectionDropped(id),
  });

  const files = new FilesService(opts.projectRoot);
  const dispatcher = new Dispatcher(bridge, {
    identity: () => identity,
    setIdentity: (next) => { identity = next; saveIdentity(next); },
    pairingTokens: () => tokens,
    sessions,
    files,
    onPairedDevicesChanged: () => { /* UI polls /api/state */ },
    endpointURL: () => bridgeEndpoint,
  });
  dispatcherRef = dispatcher;

  // Bind both ports in parallel. The bridge owns a raw TCP listener
  // (`net.Server`) that speaks the same length-prefixed JSON envelopes
  // the iPhone's `NWConnection` writes — no HTTP upgrade dance.
  await Promise.all([
    listen(httpServer, opts.uiPort),
    bridge.listen(opts.bridgePort),
  ]);

  return {
    bridgePort: opts.bridgePort,
    uiPort: opts.uiPort,
    uiURL: `http://localhost:${opts.uiPort}`,
    bridgeEndpoint,
    identityPath: configDirPath(),
    identity,
    stop: async () => {
      bridge.stop();
      sessions.shutdownAll();
      await new Promise<void>((res) => httpServer.close(() => res()));
    },
  };
}

function listen(server: import("http").Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener("listening", onListen); reject(err); };
    const onListen = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, "0.0.0.0");
  });
}

/** Pick the best non-loopback, non-tailnet IPv4 to embed as the QR's
 *  primary endpoint. Tailnet addresses are intentionally excluded —
 *  they live in the separate `te` fallback field so a phone without
 *  Tailscale can still pair on the LAN, and a phone with Tailscale
 *  still gets a working secondary if the LAN attempt fails. */
function bestLANAddress(): string {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (/^tailscale/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      candidates.push({ name, address: a.address });
    }
  }
  candidates.sort((a, b) => score(b.name) - score(a.name));
  return candidates[0]?.address ?? "127.0.0.1";

  function score(name: string): number {
    if (/^en|^eth|^wlp|^wlan|^wifi/i.test(name)) return 3;
    if (/^docker|^br|^vir/i.test(name)) return 0;
    return 1;
  }
}

/** First IPv4 on a `tailscale*` interface, or — when running inside a
 *  container that hides the tailnet interface (LXC, some Docker setups
 *  using userspace networking) — the IP reported by `tailscale ip -4`.
 *  Returns null when neither path yields an address so the QR omits
 *  `te` rather than carrying a dead fallback. */
function tailscaleAddress(port: number): string | null {
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!/^tailscale/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        return `tcp://${a.address}:${port}`;
      }
    }
  }
  // Container fallback: ask the tailscale CLI directly. The CLI prints
  // one IP per address family on its own line; we want the first IPv4.
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const first = out.split(/\s+/)[0];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(first)) {
      return `tcp://${first}:${port}`;
    }
  } catch {
    // tailscale not installed / not signed in / not on PATH — fall through.
  }
  return null;
}
