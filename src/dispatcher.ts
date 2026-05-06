// Routes inbound bridge envelopes to the right service. Same shape as
// the Mac's `BridgeDispatcher` — every handler verifies the envelope
// signature against the sender's public key (or, in the special case
// of the first `pairingRequest`, against the freshly-supplied public
// key in the payload itself).

import {
  BridgeEnvelope,
  BridgeMessageType,
  HelloPayload,
  HeartbeatPayload,
  PairingRequestPayload,
  PairingResponsePayload,
  SessionListResponsePayload,
  NewSessionRequestPayload,
  CloseSessionRequestPayload,
  UserPromptPayload,
  ProjectInfoPayload,
  LiveEventPayload,
  EventBatchPayload,
  SessionEvent,
  DirectoryListingRequestPayload,
  FileContentRequestPayload,
  FileWriteRequestPayload,
  FileSearchRequestPayload,
  PROTOCOL_VERSION,
  MAX_CLOCK_SKEW_SECONDS,
  canonicalJSONStringify,
  formatDate,
  newUUID,
  newNonce,
} from "./protocol.js";
import { BridgeServer, BridgeConnection } from "./wsBridge.js";
import { BridgeSigner } from "./signer.js";
import {
  Identity,
  rememberPeer,
  findTrustedPeer,
  secretKeyBytes,
  publicKeyBytes,
} from "./keys.js";
import { NonceCache } from "./nonce.js";
import { PairingTokens } from "./pairing.js";
import { Sessions } from "./sessions.js";
import { FilesService } from "./files.js";

export interface DispatcherCallbacks {
  identity: () => Identity;
  setIdentity: (next: Identity) => void;
  pairingTokens: () => PairingTokens;
  sessions: Sessions;
  files: FilesService;
  onPairedDevicesChanged: () => void;
  /** Endpoint the iPhone reaches us on, e.g. `tcp://192.168.0.5:18733`.
   *  We echo it back in `pairingResponse` so the iPhone can
   *  re-connect after a network blip. */
  endpointURL: () => string;
}

export class Dispatcher {
  private nonces = new NonceCache();
  /** connectionId → trusted peer device id. Set right after a
   *  successful pairing OR after a paired iPhone re-sends `hello`. */
  private deviceForConn = new Map<string, string>();

  constructor(
    private readonly bridge: BridgeServer,
    private readonly cb: DispatcherCallbacks,
  ) {}

  /** Top-level frame handler — wired into `BridgeServer.handlers.onFrame`. */
  onFrame(frame: Buffer, conn: BridgeConnection): void {
    let env: BridgeEnvelope<unknown>;
    try {
      env = JSON.parse(frame.toString("utf8"));
    } catch {
      return;
    }
    if (env.protocolVersion !== PROTOCOL_VERSION) {
      // Older iPhone build trying to talk to a newer daemon (or
      // vice-versa). Drop without ceremony.
      return;
    }
    if (!isFreshTimestamp(env.timestamp)) return;
    if (!this.nonces.remember(env.nonce)) return;

    switch (env.type) {
      case "pairingRequest":
        this.handlePairingRequest(env as BridgeEnvelope<PairingRequestPayload>, conn);
        break;
      case "hello":
        this.handleHello(env as BridgeEnvelope<HelloPayload>, conn);
        break;
      case "heartbeat":
        this.handleHeartbeat(env as BridgeEnvelope<HeartbeatPayload>, conn);
        break;
      case "sessionListRequest":
        this.requireSignedThen(env, conn, () => this.sendSessionList(conn));
        break;
      case "newSessionRequest":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as NewSessionRequestPayload | null;
          this.cb.sessions.create({ projectPath: p?.projectPath ?? undefined });
          this.sendSessionList(); // broadcast
        });
        break;
      case "closeSessionRequest":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as CloseSessionRequestPayload;
          this.cb.sessions.close(p.sessionId);
          this.sendSessionList();
        });
        break;
      case "userPrompt":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as UserPromptPayload;
          this.cb.sessions.sendPrompt(p.sessionId, p.text);
        });
        break;
      case "directoryListingRequest":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as DirectoryListingRequestPayload;
          void this.cb.files
            .listDirectory({ requestId: p.requestId, relativePath: p.relativePath })
            .then((resp) => this.sendSigned(conn, "directoryListingResponse", null, resp));
        });
        break;
      case "fileContentRequest":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as FileContentRequestPayload;
          void this.cb.files
            .readFile({
              requestId: p.requestId,
              relativePath: p.relativePath,
              maxBytes: p.maxBytes,
            })
            .then((resp) => this.sendSigned(conn, "fileContentResponse", null, resp));
        });
        break;
      case "fileWriteRequest":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as FileWriteRequestPayload;
          void this.cb.files
            .writeFile({
              requestId: p.requestId,
              path: p.path,
              utf8Text: p.utf8Text,
            })
            .then((resp) => this.sendSigned(conn, "fileWriteResponse", null, resp));
        });
        break;
      case "fileSearchRequest":
        this.requireSignedThen(env, conn, () => {
          const p = env.payload as FileSearchRequestPayload;
          void this.cb.files
            .search({
              requestId: p.requestId,
              rootPath: p.rootPath,
              query: p.query,
              maxResults: p.maxResults,
              searchContent: p.searchContent,
            })
            .then((resp) => this.sendSigned(conn, "fileSearchResponse", null, resp));
        });
        break;
      default:
        // Unknown / unhandled types are silently ignored — keeps the
        // iPhone happy when it sends messages this Phase-1 daemon
        // doesn't yet speak.
        break;
    }
  }

  // ---- handlers ----

  private handlePairingRequest(
    env: BridgeEnvelope<PairingRequestPayload>,
    conn: BridgeConnection,
  ): void {
    const tokens = this.cb.pairingTokens();
    const supplied = env.payload.pairingToken;
    if (supplied !== tokens.token && supplied !== tokens.humanCode) {
      this.sendPairingResponse(conn, false, "Pairing token did not match.");
      this.bridge.drop(conn.id);
      return;
    }
    // Verify the iPhone signed this envelope with the public key it's
    // sending. Without this check, an attacker who learned the token
    // could impersonate any device id.
    let peerKey: Uint8Array;
    try {
      peerKey = Buffer.from(env.payload.publicKey, "base64");
    } catch {
      this.sendPairingResponse(conn, false, "Bad public key.");
      this.bridge.drop(conn.id);
      return;
    }
    if (!BridgeSigner.verify(env, peerKey)) {
      this.sendPairingResponse(conn, false, "Signature did not verify.");
      this.bridge.drop(conn.id);
      return;
    }
    // Remember the peer.
    const id = this.cb.identity();
    const next = rememberPeer(id, {
      deviceId: env.payload.deviceId,
      deviceName: env.payload.deviceName,
      platform: env.payload.platform,
      publicKey: env.payload.publicKey,
      pairedAt: formatDate(),
    });
    this.cb.setIdentity(next);
    this.deviceForConn.set(conn.id, env.payload.deviceId);
    this.sendPairingResponse(conn, true);
    this.cb.onPairedDevicesChanged();
    // Push initial state so the iPhone immediately sees this Linux
    // box as a paired Mac with whatever sessions exist.
    this.sendProjectInfo(conn);
    this.sendSessionList(conn);
  }

  private handleHello(
    env: BridgeEnvelope<HelloPayload>,
    conn: BridgeConnection,
  ): void {
    const peer = findTrustedPeer(this.cb.identity(), env.payload.deviceId);
    if (!peer) {
      // Unknown device. Drop the connection — they need to pair first.
      this.bridge.drop(conn.id);
      return;
    }
    const peerKey = Buffer.from(peer.publicKey, "base64");
    if (!BridgeSigner.verify(env, peerKey)) {
      this.bridge.drop(conn.id);
      return;
    }
    this.deviceForConn.set(conn.id, env.payload.deviceId);
    this.sendHelloAck(conn, env.senderId);
    this.sendProjectInfo(conn);
    this.sendSessionList(conn);
  }

  private handleHeartbeat(
    env: BridgeEnvelope<HeartbeatPayload>,
    conn: BridgeConnection,
  ): void {
    if (!this.requireSigned(env, conn)) return;
    // Echo a heartbeat back so the iPhone knows we're alive.
    const id = this.cb.identity();
    this.sendSigned(conn, "heartbeat", null, {
      sentAt: formatDate(),
      connectionUptimeSeconds: 0,
    } satisfies HeartbeatPayload);
  }

  // ---- senders ----

  private sendPairingResponse(
    conn: BridgeConnection,
    accepted: boolean,
    denialReason?: string,
  ): void {
    const id = this.cb.identity();
    const payload: PairingResponsePayload = {
      accepted,
      serverDeviceId: id.deviceId,
      serverPublicKey: id.publicKey,
      serverEndpoint: this.cb.endpointURL(),
      denialReason: denialReason ?? null,
    };
    this.sendSigned(conn, "pairingResponse", null, payload);
  }

  private sendHelloAck(conn: BridgeConnection, recipient: string): void {
    const id = this.cb.identity();
    this.sendSigned(conn, "helloAck", recipient, {
      deviceId: id.deviceId,
      deviceName: id.deviceName,
      platform: "linux",
      appVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    } satisfies HelloPayload);
  }

  /** Broadcast the current project + status snapshot. iPhone consumes
   *  this to render the project chip in its top bar and to drive
   *  cold-launch alignment to whatever this daemon is hosting. */
  sendProjectInfo(target?: BridgeConnection): void {
    const sess = this.cb.sessions;
    // Phase 1 ships a single root — `process.cwd()` at daemon start.
    // Phase 2 will let the iPhone request a project switch.
    const cwd = process.cwd();
    const path = require("node:path") as typeof import("node:path");
    const payload: ProjectInfoPayload = {
      rootPath: cwd,
      displayName: path.basename(cwd) || "linux",
      homePath: process.env.HOME ?? null,
      tailscaleHostname: null,
      tailscaleIPv4: null,
      gitHub: null,
      gitHubAuth: null,
      isLocked: false,
    };
    if (target) this.sendSigned(target, "projectInfo", null, payload);
    else this.broadcastSigned("projectInfo", payload);
    void sess; // silence unused if Phase 2 removes the projection later
  }

  /** Send `sessionListResponse` either to one connection or to all. */
  sendSessionList(target?: BridgeConnection): void {
    const payload: SessionListResponsePayload = {
      sessions: this.cb.sessions.list(),
    };
    if (target) this.sendSigned(target, "sessionListResponse", null, payload);
    else this.broadcastSigned("sessionListResponse", payload);
  }

  /** Push a single newly-emitted SessionEvent to every paired peer. */
  broadcastLiveEvent(event: SessionEvent): void {
    const payload: LiveEventPayload = { event };
    this.broadcastSigned("liveEvent", payload, event.sessionId);
  }

  // ---- low-level send helpers ----

  private sendSigned<P>(
    conn: BridgeConnection,
    type: BridgeMessageType,
    sessionId: string | null,
    payload: P,
  ): void {
    const env = this.makeEnvelope(type, sessionId, payload);
    this.bridge.send(conn.id, Buffer.from(canonicalJSONStringify(env), "utf8"));
  }

  private broadcastSigned<P>(
    type: BridgeMessageType,
    payload: P,
    sessionId: string | null = null,
  ): void {
    const env = this.makeEnvelope(type, sessionId, payload);
    this.bridge.broadcast(Buffer.from(canonicalJSONStringify(env), "utf8"));
  }

  private makeEnvelope<P>(
    type: BridgeMessageType,
    sessionId: string | null,
    payload: P,
  ): BridgeEnvelope<P> {
    const id = this.cb.identity();
    const env: BridgeEnvelope<P> = {
      id: newUUID(),
      type,
      protocolVersion: PROTOCOL_VERSION,
      senderId: id.deviceId,
      recipientId: null,
      sessionId,
      timestamp: formatDate(),
      nonce: newNonce(),
      signature: "",
      payload,
    };
    BridgeSigner.sign(env, secretKeyBytes(id));
    return env;
  }

  // ---- signature gate ----

  private requireSigned<P>(
    env: BridgeEnvelope<P>,
    conn: BridgeConnection,
  ): boolean {
    const peerId = this.deviceForConn.get(conn.id);
    if (!peerId) return false;
    const peer = findTrustedPeer(this.cb.identity(), peerId);
    if (!peer) return false;
    const key = Buffer.from(peer.publicKey, "base64");
    if (!BridgeSigner.verify(env, key)) return false;
    return true;
  }

  private requireSignedThen<P>(
    env: BridgeEnvelope<P>,
    conn: BridgeConnection,
    fn: () => void,
  ): void {
    if (this.requireSigned(env, conn)) fn();
  }

  /** Called by `BridgeServer.onDisconnect` to forget the connection. */
  onConnectionDropped(connId: string): void {
    this.deviceForConn.delete(connId);
  }
}

function isFreshTimestamp(iso: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const skew = Math.abs(Date.now() - t) / 1000;
  return skew <= MAX_CLOCK_SKEW_SECONDS;
}
