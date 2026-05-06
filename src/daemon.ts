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
  const tokens: PairingTokens = issuePairingTokens();
  const externalHost = opts.externalHost ?? bestLANAddress();
  const bridgeEndpoint = `tcp://${externalHost}:${opts.bridgePort}`;

  // The ordering below matters: dispatcher needs the bridge, bridge
  // needs the http server (for upgrade), sessions need the
  // dispatcher (for liveEvent broadcasts).
  const httpServer = createHTTPServer({
    identity: () => identity,
    sessions: () => sessions,
    pairingTokens: () => tokens,
    bridgeEndpoint: () => bridgeEndpoint,
  });

  const bridgeHttpServer = require("node:http").createServer() as import("http").Server;

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

  const bridge = new BridgeServer(bridgeHttpServer, {
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

  bridge.start();

  // Listen the two ports in parallel.
  await listen(httpServer, opts.uiPort);
  await listen(bridgeHttpServer, opts.bridgePort);

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
      await Promise.all([
        new Promise<void>((res) => httpServer.close(() => res())),
        new Promise<void>((res) => bridgeHttpServer.close(() => res())),
      ]);
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

/** Pick the best non-loopback IPv4 to embed in the pairing endpoint
 *  URL. Prefers Wi-Fi / Ethernet over virtual interfaces. */
function bestLANAddress(): string {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      candidates.push({ name, address: a.address });
    }
  }
  // Prefer common LAN names first.
  candidates.sort((a, b) => score(b.name) - score(a.name));
  return candidates[0]?.address ?? "127.0.0.1";

  function score(name: string): number {
    if (/^en|^eth|^wlp|^wlan|^wifi/i.test(name)) return 3;
    if (/^tailscale/i.test(name)) return 2;
    if (/^docker|^br|^vir/i.test(name)) return 0;
    return 1;
  }
}
