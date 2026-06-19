// TypeScript port of the bridge protocol shared with the macOS host
// (`Packages/DNPShared/Sources/DNPShared/Protocol`). Kept as a single
// file because the Linux daemon uses a small subset of the full
// protocol — anything we don't decode here either gets dropped or
// passes through opaquely as a JSON object.
//
// **Wire format**.  Length-prefixed JSON frames:
//   <4-byte big-endian length><canonical JSON of BridgeEnvelope>
// The JSON encoding is deterministic — keys are sorted at every level
// and slashes are NOT escaped — so the same bytes serialise on both
// macOS (`JSONEncoder.outputFormatting = [.sortedKeys,
// .withoutEscapingSlashes]`) and Node. Without that determinism the
// Ed25519 signature would never round-trip.

export const PROTOCOL_VERSION = 1;
export const MAX_CLOCK_SKEW_SECONDS = 60;
export const HEARTBEAT_INTERVAL_SECONDS = 15;

/** Mirror of `BridgeMessageType` on the Swift side. */
export type BridgeMessageType =
  | "hello"
  | "helloAck"
  | "pairingRequest"
  | "pairingResponse"
  | "sessionListRequest"
  | "sessionListResponse"
  | "subscribeSession"
  | "unsubscribeSession"
  | "eventBatch"
  | "liveEvent"
  | "userPrompt"
  | "approvalResponse"
  | "newSessionRequest"
  | "closeSessionRequest"
  | "attachmentTransfer"
  | "cancelRunning"
  | "projectInfo"
  | "openFolderRequest"
  | "directoryListingRequest"
  | "directoryListingResponse"
  | "fileContentRequest"
  | "fileContentResponse"
  | "fileWriteRequest"
  | "fileWriteResponse"
  | "fileSearchRequest"
  | "fileSearchResponse"
  | "setProjectRootRequest"
  | "githubRepoListRequest"
  | "githubRepoListResponse"
  | "githubAdoptRepoRequest"
  | "recentProjectListRequest"
  | "recentProjectListResponse"
  | "screenMirrorStart"
  | "screenMirrorStop"
  | "screenMirrorFrame"
  | "screenMirrorCursor"
  | "remoteInput"
  | "macUnlockRequest"
  | "macUnlockResponse"
  | "forceApprove"
  | "aiUsageBroadcast"
  | "activeSessionBroadcast"
  | "heartbeat"
  | "reconnect"
  | "revoke"
  | "error";

export interface BridgeEnvelope<P = unknown> {
  id: string; // UUID v4
  type: BridgeMessageType;
  protocolVersion: number;
  senderId: string; // device UUID
  recipientId?: string | null;
  sessionId?: string | null;
  timestamp: string; // ISO-8601 with fractional seconds
  nonce: string; // base64, 16 bytes
  signature: string; // base64, 64 bytes — empty when unsigned
  payload: P;
}

// ---------- Hello / handshake ----------

export type DevicePlatform = "mac" | "ios" | "ipad" | "linux" | "windows";

export interface HelloPayload {
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform;
  appVersion: string;
  protocolVersion: number;
}

export interface HeartbeatPayload {
  sentAt: string;
  connectionUptimeSeconds: number;
}

// ---------- Pairing ----------

export interface PairingRequestPayload {
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform;
  pairingToken: string; // either the 32-char base64url token, or the human code
  publicKey: string; // base64 of 32-byte Ed25519 public key
}

export interface PairingResponsePayload {
  accepted: boolean;
  /** Server-side device id. Field name is historical (`mac…`) — the
   *  Swift `PairingResponse` model is shared with the macOS host and
   *  predates Linux support, so the same names are reused here so the
   *  signed envelope round-trips byte-for-byte through the iPhone's
   *  decoder. */
  macDeviceId: string;
  macName: string;
  macPublicKey: string; // base64 — Swift decodes Data via base64 by default
  issuedAt: string;     // ISO-8601 with fractional seconds (matches `formatDate`)
  serverEndpoint: string; // tcp://host:port
  denialReason?: string | null;
  /** Tells the iPhone what kind of host it just paired with so the UI
   *  can pick a per-platform icon and label. */
  platform: DevicePlatform;
}

// ---------- Sessions ----------

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "waitingForApproval"
  | "waitingForUser"
  | "compacting"
  | "ending"
  | "ended"
  | "crashed"
  | "disconnected";

export type ContextHealth = "healthy" | "low" | "critical";

export interface Session {
  id: string;
  title: string;
  projectPath: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  lastActivityAt: string | null;
  pendingApprovalCount: number;
  contextHealth: ContextHealth;
  claudeSessionId?: string | null;
}

export interface SessionListRequestPayload {
  includeArchived: boolean;
}

export interface SessionListResponsePayload {
  sessions: Session[];
}

export interface NewSessionRequestPayload {
  projectPath?: string | null;
}

export interface CloseSessionRequestPayload {
  sessionId: string;
}

// ---------- Live events ----------

export type SessionEventType =
  | "command"
  | "codeEdit"
  | "fileChanged"
  | "toolActivity"
  | "approval"
  | "context"
  | "message"
  | "warning"
  | "error"
  | "crash"
  | "subagent"
  | "raw"
  | "thinkingSummary"
  | "contextUpdate"
  | "sessionStatusUpdate"
  | "sessionStarted"
  | "sessionEnded";

export type Severity = "info" | "warning" | "error" | "debug";

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  severity: Severity;
  title: string;
  createdAt: string;
  sequence: number;
  /**
   * Discriminated payload mirroring `SessionEventPayload` on Swift. We
   * keep it loose (`any`) here because Linux Phase 1 only emits the
   * `raw` and `message` shapes — fuller typing lands once we actually
   * parse Claude's structured output.
   */
  payload?: { kind: string; value: unknown };
}

export interface LiveEventPayload {
  event: SessionEvent;
}

export interface EventBatchPayload {
  sessionId: string;
  events: SessionEvent[];
  isBackfill: boolean;
  highestSequence: number | null;
}

// ---------- User prompt ----------

export interface UserPromptPayload {
  sessionId: string;
  text: string;
  attachments: unknown[];
}

// ---------- File explorer ----------

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface DirectoryListingRequestPayload {
  requestId: string;
  relativePath: string;
}

export interface DirectoryListingResponsePayload {
  requestId: string;
  relativePath: string;
  entries: DirectoryEntry[];
  error: string | null;
}

export interface FileContentRequestPayload {
  requestId: string;
  relativePath: string;
  maxBytes: number;
}

export interface FileContentResponsePayload {
  requestId: string;
  relativePath: string;
  mimeType: string;
  utf8Text: string | null;
  /** Base64-encoded raw bytes. Set when the file failed UTF-8 decode. */
  binary: string | null;
  truncated: boolean;
  error: string | null;
}

export interface FileWriteRequestPayload {
  requestId: string;
  path: string;
  utf8Text: string;
}

export interface FileWriteResponsePayload {
  requestId: string;
  path: string;
  success: boolean;
  error: string | null;
}

export interface FileSearchHit {
  path: string;
  isDirectory: boolean;
  lineNumber: number | null;
  snippet: string | null;
}

export interface FileSearchRequestPayload {
  requestId: string;
  rootPath: string;
  query: string;
  maxResults: number;
  searchContent: boolean;
}

export interface FileSearchResponsePayload {
  requestId: string;
  query: string;
  hits: FileSearchHit[];
  truncated: boolean;
  error: string | null;
}

// ---------- ProjectInfo ----------

export interface ProjectInfoPayload {
  rootPath: string | null;
  displayName: string | null;
  homePath: string | null;
  tailscaleHostname: string | null;
  tailscaleIPv4: string | null;
  gitHub: unknown | null;
  gitHubAuth: unknown | null;
  isLocked?: boolean | null;
}

// ---------- Canonical JSON (bridge-stable) ----------

/**
 * Serialise `value` to JSON the way the Mac side does — recursively
 * sort keys at every level, no whitespace, no `/` escaping, dates
 * already strings (caller passes ISO-8601 with fractional seconds via
 * `formatDate` below). Identical bytes on Linux + macOS = identical
 * Ed25519 signature input.
 */
export function canonicalJSONStringify(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v); // JSON.stringify never escapes `/`
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error("canonical JSON: non-finite number");
    }
    return JSON.stringify(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    return "[" + v.map(stringifyCanonical).join(",") + "]";
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + stringifyCanonical(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("canonical JSON: unsupported type " + typeof v);
}

/** ISO-8601 with millisecond precision — what `JSONEncoder.dateEncodingStrategy = .iso8601withFraction` emits. */
export function formatDate(d: Date = new Date()): string {
  return d.toISOString(); // toISOString() already emits "...Z" with milliseconds
}

/** Parse a UUID v4 generation. Random128-bit, hex-with-dashes. */
export function newUUID(): string {
  // Node 16+ has crypto.randomUUID()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return randomUUID();
}

/** 16-byte base64 nonce — replay-protection input for every envelope. */
export function newNonce(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return randomBytes(16).toString("base64");
}
