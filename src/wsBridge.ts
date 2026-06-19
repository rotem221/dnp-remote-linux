// Raw-TCP bridge with length-prefixed JSON envelopes. Mirrors the
// Mac's `BridgeServerService` byte-for-byte:
//
//   <4-byte BE length><JSON bytes of BridgeEnvelope>
//
// Why not WebSocket? The iPhone client uses `NWConnection` with the
// `.tcp` parameter — it does NOT speak the WebSocket upgrade
// handshake. The Mac listens with `NWListener(using: .tcp …)`, also
// raw. The wire format is plain TCP with our own framing on top, so
// the daemon has to match. An earlier rev of this file used `ws` and
// silently failed every pairing attempt: the iPhone's first frame
// (the length-prefixed pairing request) didn't look like an HTTP
// `GET /` Upgrade request, so `ws` rejected the connection during
// the handshake and the iPhone saw a dropped TCP socket — which the
// pairing watchdog reported as "Couldn't reach 192.168.x.x:18733".
//
// Frame parser handles arbitrary TCP segmentation: one frame may
// arrive in many TCP segments, or many frames may arrive in one
// segment. The buffer accumulates bytes until a full
// `<length><payload>` is available, then emits it and continues.

import net from "node:net";

export type FrameHandler = (frame: Buffer, conn: BridgeConnection) => void;

export interface BridgeConnection {
  id: string;
  remote: string;
  send(frame: Buffer): void;
  close(): void;
}

export class BridgeServer {
  private server: net.Server | null = null;
  private connections = new Map<string, net.Socket>();
  private remoteFor = new Map<string, string>();
  private nextId = 1;

  constructor(
    /** Reserved for API symmetry with the Mac's bridge — not used by
     *  the raw-TCP server. Kept so existing callers can pass the
     *  daemon's HTTP server without conditional plumbing. */
    private readonly _unused: unknown,
    private readonly handlers: {
      onConnection?: (conn: BridgeConnection) => void;
      onFrame: FrameHandler;
      onDisconnect?: (id: string) => void;
    },
  ) {
    void this._unused;
  }

  /** Bind the TCP listener. The caller supplies the port; the server
   *  always listens on `0.0.0.0` so LAN + Tailscale + 127.0.0.1 all
   *  reach the same accept loop. */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onClientConnect(socket));
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  /** Compatibility shim — older `daemon.ts` revs called `bridge.start()`
   *  before the listener was extracted into `listen(port)`. Now a no-op
   *  so the call site keeps working until the next refactor. */
  start(): void { /* listen() owns the bind */ }

  private onClientConnect(socket: net.Socket): void {
    const id = `c${this.nextId++}`;
    const remote = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    this.connections.set(id, socket);
    this.remoteFor.set(id, remote);

    socket.setNoDelay(true);

    const conn: BridgeConnection = {
      id,
      remote,
      send: (frame) => {
        if (!socket.destroyed) socket.write(frame);
      },
      close: () => socket.end(),
    };
    this.handlers.onConnection?.(conn);

    // Per-socket parser state. Bytes accumulate in `acc`; on each chunk
    // we drain as many complete frames as the buffer holds.
    let acc: Buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      acc = acc.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([acc, chunk]);
      while (acc.length >= 4) {
        const length = acc.readUInt32BE(0);
        // Defensive cap so a malformed length prefix can't allocate
        // gigabytes — bridge envelopes are kilobytes at most.
        if (length > 8 * 1024 * 1024) {
          socket.destroy(new Error(`bridge frame too large: ${length} bytes`));
          return;
        }
        if (acc.length < 4 + length) break;
        const frame = acc.subarray(4, 4 + length);
        acc = acc.subarray(4 + length);
        try {
          this.handlers.onFrame(frame, conn);
        } catch {
          // A handler throw must NOT take down the listener — log and
          // keep parsing the rest of the buffer.
        }
      }
    });

    socket.on("close", () => {
      this.connections.delete(id);
      this.remoteFor.delete(id);
      this.handlers.onDisconnect?.(id);
    });

    socket.on("error", () => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
  }

  /** Length-prefixed send to a single connection. */
  send(connId: string, jsonBytes: Buffer): void {
    const socket = this.connections.get(connId);
    if (!socket || socket.destroyed) return;
    socket.write(framed(jsonBytes));
  }

  /** Broadcast to every paired connection. */
  broadcast(jsonBytes: Buffer): void {
    const wire = framed(jsonBytes);
    for (const socket of this.connections.values()) {
      if (!socket.destroyed) socket.write(wire);
    }
  }

  drop(connId: string): void {
    const socket = this.connections.get(connId);
    if (socket && !socket.destroyed) socket.end();
  }

  stop(): void {
    for (const socket of this.connections.values()) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.connections.clear();
    this.server?.close();
    this.server = null;
  }
}

function framed(jsonBytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(jsonBytes.length, 0);
  return Buffer.concat([len, jsonBytes]);
}
