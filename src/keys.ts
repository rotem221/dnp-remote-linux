// Per-host Ed25519 keypair plus the trusted-peer registry. Kept in a
// single JSON file under `$XDG_CONFIG_HOME/dnp-remote/identity.json`
// (defaults to `~/.config/dnp-remote/identity.json` on Linux). chmod
// 600 on first write so the secret key isn't world-readable.
//
// Format:
//   {
//     "deviceId": "<uuid>",
//     "deviceName": "<hostname>",
//     "secretKey": "<base64 of 64-byte tweetnacl secret>",
//     "publicKey": "<base64 of 32-byte ed25519 public>",
//     "trustedPeers": [
//       { "deviceId": "...", "deviceName": "...", "platform": "ios",
//         "publicKey": "...", "pairedAt": "...iso..." }
//     ]
//   }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeyPair } from "./signer.js";
import { newUUID } from "./protocol.js";

export interface TrustedPeer {
  deviceId: string;
  deviceName: string;
  platform: string;
  publicKey: string; // base64
  pairedAt: string;
}

export interface Identity {
  deviceId: string;
  deviceName: string;
  secretKey: string; // base64 (64-byte tweetnacl secret)
  publicKey: string; // base64 (32-byte public)
  trustedPeers: TrustedPeer[];
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "dnp-remote");
}

function identityPath(): string {
  return path.join(configDir(), "identity.json");
}

function defaultDeviceName(): string {
  // Combine the hostname with a brand prefix so the iPhone's paired
  // devices list shows something meaningful without the user having
  // to set a name.
  const host = os.hostname() || "linux";
  return `DNP Remote · ${host}`;
}

/** Load identity from disk; create + persist if missing. */
export function loadOrCreateIdentity(): Identity {
  const filePath = identityPath();
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Identity;
    // Defensive normalisation in case an older file is missing a field.
    if (!parsed.trustedPeers) parsed.trustedPeers = [];
    return parsed;
  }
  const kp = generateKeyPair();
  const id: Identity = {
    deviceId: newUUID(),
    deviceName: defaultDeviceName(),
    secretKey: Buffer.from(kp.secretKey).toString("base64"),
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    trustedPeers: [],
  };
  saveIdentity(id);
  return id;
}

export function saveIdentity(id: Identity): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = identityPath();
  fs.writeFileSync(filePath, JSON.stringify(id, null, 2), { mode: 0o600 });
}

/** Convenience accessors that return raw bytes. */
export function secretKeyBytes(id: Identity): Uint8Array {
  return Buffer.from(id.secretKey, "base64");
}

export function publicKeyBytes(id: Identity): Uint8Array {
  return Buffer.from(id.publicKey, "base64");
}

export function findTrustedPeer(
  id: Identity,
  deviceId: string,
): TrustedPeer | undefined {
  return id.trustedPeers.find((p) => p.deviceId === deviceId);
}

export function rememberPeer(id: Identity, peer: TrustedPeer): Identity {
  const without = id.trustedPeers.filter((p) => p.deviceId !== peer.deviceId);
  const next: Identity = { ...id, trustedPeers: [...without, peer] };
  saveIdentity(next);
  return next;
}

export function forgetPeer(id: Identity, deviceId: string): Identity {
  const next: Identity = {
    ...id,
    trustedPeers: id.trustedPeers.filter((p) => p.deviceId !== deviceId),
  };
  saveIdentity(next);
  return next;
}

export function configDirPath(): string {
  return configDir();
}
