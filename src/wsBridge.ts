// Length-prefixed signed-envelope WebSocket-style bridge. Mirrors the
// Mac's `BridgeServerService` byte-for-byte:
//
//   <4-byte BE length><JSON bytes of BridgeEnvelope>
//
// `ws` is a plain WebSocket library, but we use it as a transport for
// raw binary frames — the iPhone sends the same length-prefixed JSON
// frames it would send over a raw TCP socket. The advantage of going
// through `ws` (versus raw `net.Server`) is automatic upgrade
// negotiation if a future iPhone build switches to true WebSocket
// frames; for now both ends just push the same byte stream.

import http from "node:http";
import { WebSocketServer, WebSocket, RawData } from "ws";

export type FrameHandler = (frame: Buffer, conn: BridgeConnection) => void;

export interface BridgeConnection {
  id: string;
  remote: string;
  send(frame: Buffer): void;
  close(): void;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WebSocket>();
  private remoteFor = new Map<string, string>();
  private nextId = 1;

  constructor(
    private readonly httpServer: http.Server,
    private readonly handlers: {
      onConnection?: (conn: BridgeConnection) => void;
      onFrame: FrameHandler;
      onDisconnect?: (id: string) => void;
    },
  ) {}

  start(): void {
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => {
      const id = `c${this.nextId++}`;
      const remote = (req.socket.remoteAddress ?? "?") + ":" + (req.socket.remotePort ?? 0);
      this.connections.set(id, ws);
      this.remoteFor.set(id, remote);
      const conn: BridgeConnection = {
        id,
        remote,
        send: (frame) => ws.send(frame),
        close: () => ws.close(),
      };
      this.handlers.onConnection?.(conn);

      ws.on("message", (data: RawData, isBinary: boolean) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        // The Mac wraps the JSON in a 4-byte BE length prefix when
        // sending over raw TCP. Over WebSocket the framing is
        // already provided by the protocol, so the prefix is
        // redundant — but the iPhone still emits it for symmetry.
        // Strip it transparently if present.
        if (buf.length >= 4) {
          const declared = buf.readUInt32BE(0);
          if (declared === buf.length - 4) {
            this.handlers.onFrame(buf.subarray(4), conn);
            return;
          }
        }
        this.handlers.onFrame(buf, conn);
      });

      ws.on("close", () => {
        this.connections.delete(id);
        this.remoteFor.delete(id);
        this.handlers.onDisconnect?.(id);
      });

      ws.on("error", () => {
        try { ws.close(); } catch { /* ignore */ }
      });
    });
  }

  /** Length-prefixed send to a single connection. The iPhone strips
   *  the 4-byte prefix the same way the Mac does. */
  send(connId: string, jsonBytes: Buffer): void {
    const ws = this.connections.get(connId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(framed(jsonBytes));
  }

  /** Broadcast to every paired connection. */
  broadcast(jsonBytes: Buffer): void {
    const wire = framed(jsonBytes);
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(wire);
    }
  }

  drop(connId: string): void {
    this.connections.get(connId)?.close();
  }

  stop(): void {
    for (const ws of this.connections.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
    this.wss?.close();
    this.wss = null;
  }
}

function framed(jsonBytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(jsonBytes.length, 0);
  return Buffer.concat([len, jsonBytes]);
}
