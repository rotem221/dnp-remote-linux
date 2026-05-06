// Pairing token issuance + matching. Same wire shape as the Mac side:
// the daemon publishes a 32-char base64url token plus a 6-digit
// human-readable code in the QR payload, and the iPhone presents one
// of them in a `pairingRequest` envelope. We accept either; the human
// code is just a fallback for users who can't scan (e.g. screen
// reader, broken camera).
//
// The token rotates on every daemon restart so a leaked QR can't be
// re-used the next day. Once a peer pairs successfully it's recorded
// in `identity.json` and never needs the token again — subsequent
// reconnects authenticate with their device key.

import { randomBytes } from "node:crypto";

export interface PairingTokens {
  token: string;       // 32-char base64url, used by the QR scan path
  humanCode: string;   // 6-digit numeric, used by the manual fallback
  issuedAt: number;    // Date.now() ms — purely diagnostic
}

export function issuePairingTokens(): PairingTokens {
  const tokenBytes = randomBytes(24);
  const token = tokenBytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  // 6-digit human code, zero-padded. Cryptographic randomness so a
  // malicious neighbour can't brute-force the bridge in 1 000 000
  // attempts before we cycle the daemon — they'd need to land within
  // one valid window.
  const humanCode = (randomBytes(4).readUInt32BE(0) % 1_000_000)
    .toString()
    .padStart(6, "0");
  return { token, humanCode, issuedAt: Date.now() };
}

/** Build the JSON payload encoded into the pairing QR. The iPhone
 *  decodes it, extracts the endpoint + token, and sends a
 *  `pairingRequest`. Field names (`e`, `t`, `c`) match the Mac so the
 *  same scanner code on iPhone reads either daemon. */
export function pairingQRPayload(args: {
  endpoint: string;
  tokens: PairingTokens;
}): string {
  return JSON.stringify({
    e: args.endpoint,
    t: args.tokens.token,
    c: args.tokens.humanCode,
  });
}
