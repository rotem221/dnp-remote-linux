// Replay-protection cache. Every signed envelope carries a 16-byte
// random nonce. We reject any envelope whose nonce we've already seen
// in a sliding window of `MAX_NONCES` recent entries — combined with
// the timestamp-skew check in the dispatcher this stops a
// network-level attacker from re-sending an old message.

const MAX_NONCES = 4096;

export class NonceCache {
  private nonces = new Set<string>();
  private order: string[] = [];

  /** Returns true if the nonce is fresh (was not seen). Records it. */
  remember(nonce: string): boolean {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    this.order.push(nonce);
    if (this.order.length > MAX_NONCES) {
      const drop = this.order.shift()!;
      this.nonces.delete(drop);
    }
    return true;
  }
}
