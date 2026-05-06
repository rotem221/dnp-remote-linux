// Mirror of `BridgeSigner` on the Mac side. Sign canonical JSON of the
// envelope with `signature == ""`, base64-encode the resulting 64-byte
// Ed25519 signature, and write it back into the envelope. Verification
// strips the signature, recomputes canonical JSON, and runs detached
// verify with the sender's public key.
//
// We use `tweetnacl` rather than Node's built-in `crypto.sign('ed25519',
// ...)` because tweetnacl emits the same compact 64-byte signature
// format Apple's CryptoKit produces, with no DER wrapping or
// EncryptedPrivateKeyInfo gymnastics. Same bytes on both ends.

import nacl from "tweetnacl";
import {
  BridgeEnvelope,
  canonicalJSONStringify,
} from "./protocol.js";

export class BridgeSigner {
  static sign<P>(envelope: BridgeEnvelope<P>, privateKey: Uint8Array): void {
    if (privateKey.length !== nacl.sign.secretKeyLength) {
      throw new Error(
        `signer: private key must be ${nacl.sign.secretKeyLength} bytes (got ${privateKey.length})`,
      );
    }
    envelope.signature = "";
    const bytes = Buffer.from(canonicalJSONStringify(envelope), "utf8");
    const sig = nacl.sign.detached(bytes, privateKey);
    envelope.signature = Buffer.from(sig).toString("base64");
  }

  static verify<P>(envelope: BridgeEnvelope<P>, publicKey: Uint8Array): boolean {
    if (publicKey.length !== nacl.sign.publicKeyLength) {
      return false;
    }
    const sigB64 = envelope.signature;
    if (!sigB64) return false;
    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sigB64, "base64");
    } catch {
      return false;
    }
    if (sigBytes.length !== nacl.sign.signatureLength) return false;
    const unsigned: BridgeEnvelope<P> = { ...envelope, signature: "" };
    const bytes = Buffer.from(canonicalJSONStringify(unsigned), "utf8");
    return nacl.sign.detached.verify(bytes, sigBytes, publicKey);
  }
}

/** Generate a fresh Ed25519 keypair. Returned bytes match
 *  `Curve25519.Signing.PrivateKey().rawRepresentation` on macOS — the
 *  matching public key sits in `keypair.publicKey`. */
export function generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}
