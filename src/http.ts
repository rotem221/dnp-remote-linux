// Local HTTP server — serves the pairing UI on `localhost:<uiPort>`
// and exposes a tiny JSON `/api/state` endpoint the page polls every
// 2s for live updates. The same `http.Server` is reused by the
// WebSocket bridge so both surfaces share a port.

import http from "node:http";
import * as QRCode from "qrcode";
import { renderUI } from "./ui.html.js";
import { Identity } from "./keys.js";
import { Sessions } from "./sessions.js";
import { PairingTokens, pairingQRPayload } from "./pairing.js";
import { getClaudeStatus, invalidateClaudeStatusCache } from "./claudeStatus.js";
import { startAuth, submitCode, cancelAuth, getAuthStatus } from "./claudeAuth.js";

export interface HTTPDeps {
  identity: () => Identity;
  sessions: () => Sessions;
  pairingTokens: () => PairingTokens;
  bridgeEndpoint: () => string;
  /** Optional Tailscale fallback endpoint embedded in the QR as `te` so the
   *  iPhone can fall back to the tailnet when the LAN attempt fails. */
  tailscaleEndpoint?: () => string | null;
  /** Drop a paired peer by deviceId. Wired by the daemon to update the
   *  identity file + close any active connection from that peer. Keep
   *  optional so older daemon entry points still compile. */
  revokePeer?: (deviceId: string) => void;
}

export function createHTTPServer(deps: HTTPDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // The WebSocket upgrade goes through the same server — this
    // handler only sees regular HTTP. WSS handles itself via the
    // `WebSocketServer({ server })` upgrade listener.

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const tokens = deps.pairingTokens();
        const qrPayload = pairingQRPayload({
          endpoint: deps.bridgeEndpoint(),
          tailscaleEndpoint: deps.tailscaleEndpoint?.() ?? null,
          tokens,
          serverDeviceId: deps.identity().deviceId,
          serverDeviceName: deps.identity().deviceName,
          serverPublicKey: deps.identity().publicKey,
        });
        const qrSVG = await QRCode.toString(qrPayload, {
          type: "svg",
          margin: 1,
          width: 220,
          color: { dark: "#0c0d10", light: "#ffffff" },
        });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderUI({
          qrSVG,
          endpoint: deps.bridgeEndpoint(),
          humanCode: tokens.humanCode,
        }));
      } catch (err) {
        res.writeHead(500); res.end("UI render error");
      }
      return;
    }

    if (url.pathname === "/api/state") {
      const id = deps.identity();
      const tokens = deps.pairingTokens();
      const sess = deps.sessions();
      // Claude status piggybacks on the same /api/state poll so the
      // dashboard stays a single fetch per tick. The probe itself is
      // cached for 30s inside `claudeStatus.ts`.
      const claude = await getClaudeStatus().catch(() => null);
      const state = {
        endpoint: deps.bridgeEndpoint(),
        humanCode: tokens.humanCode,
        peers: id.trustedPeers,
        sessions: sess.list(),
        claude,
      };
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(state));
      return;
    }

    // POST /api/claude/auth/start — kick off `claude setup-token` in a PTY,
    // wait for the OAuth URL line, return it. Body: empty.
    if (url.pathname === "/api/claude/auth/start") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain", "allow": "POST" });
        res.end("POST only");
        return;
      }
      try {
        const result = await startAuth();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    // POST /api/claude/auth/code — submit the user's OAuth code into the
    // running setup-token PTY. Body: `{ sessionId, code }`. Returns
    // `{ ok: true }` once the long-lived token has been parsed + persisted,
    // or `{ ok: false, error }` if it timed out / claude rejected it.
    if (url.pathname === "/api/claude/auth/code") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain", "allow": "POST" });
        res.end("POST only");
        return;
      }
      try {
        const body = await readJSONBody<{ sessionId?: string; code?: string }>(req);
        if (!body?.sessionId || !body.code) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing sessionId or code" }));
          return;
        }
        const result = await submitCode(body.sessionId, body.code);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    // GET /api/claude/auth/status?sessionId=… — return the live state of
    // an auth session including the last ~600 chars claude printed. Used
    // by the modal to surface error text the moment claude rejects the
    // code instead of waiting for the timeout.
    if (url.pathname === "/api/claude/auth/status") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId" }));
        return;
      }
      const status = getAuthStatus(sessionId);
      res.writeHead(status ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(status ?? { error: "Unknown session" }));
      return;
    }

    // POST /api/claude/auth/cancel — abort an in-flight session. Used when
    // the user closes the modal before pasting a code.
    if (url.pathname === "/api/claude/auth/cancel") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain", "allow": "POST" });
        res.end("POST only");
        return;
      }
      try {
        const body = await readJSONBody<{ sessionId?: string }>(req);
        if (body?.sessionId) cancelAuth(body.sessionId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    // POST /api/peers/:deviceId/revoke — drop a paired iPhone from the
    // trusted list. Used by the "Revoke" button in the web UI. Method-
    // checked so a stray browser GET can't delete a peer; the page POSTs
    // via fetch so there's no CSRF surface (no cookies on this UI).
    {
      const m = url.pathname.match(/^\/api\/peers\/([^/]+)\/revoke$/);
      if (m) {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "text/plain", "allow": "POST" });
          res.end("POST only");
          return;
        }
        const deviceId = decodeURIComponent(m[1] ?? "");
        if (deps.revokePeer) deps.revokePeer(deviceId);
        invalidateClaudeStatusCache();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, deviceId }));
        return;
      }
    }

    if (url.pathname === "/api/qr.svg") {
      try {
        const tokens = deps.pairingTokens();
        const svg = await QRCode.toString(
          pairingQRPayload({
            endpoint: deps.bridgeEndpoint(),
            tailscaleEndpoint: deps.tailscaleEndpoint?.() ?? null,
            tokens,
            serverDeviceId: deps.identity().deviceId,
            serverDeviceName: deps.identity().deviceName,
            serverPublicKey: deps.identity().publicKey,
          }),
          { type: "svg", margin: 1, width: 320 },
        );
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
        res.end(svg);
      } catch {
        res.writeHead(500); res.end();
      }
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return server;
}

/** Slurp the request body and JSON.parse it. Capped at 64 KB so a misbehaving
 *  client can't pin the daemon's memory by streaming forever. */
function readJSONBody<T>(req: import("http").IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 64 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length > 0 ? (JSON.parse(text) as T) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
