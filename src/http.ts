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

export interface HTTPDeps {
  identity: () => Identity;
  sessions: () => Sessions;
  pairingTokens: () => PairingTokens;
  bridgeEndpoint: () => string;
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
          tokens,
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
      const state = {
        endpoint: deps.bridgeEndpoint(),
        humanCode: tokens.humanCode,
        peers: id.trustedPeers,
        sessions: sess.list(),
      };
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(state));
      return;
    }

    if (url.pathname === "/api/qr.svg") {
      try {
        const tokens = deps.pairingTokens();
        const svg = await QRCode.toString(
          pairingQRPayload({ endpoint: deps.bridgeEndpoint(), tokens }),
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
