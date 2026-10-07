import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `a !== b` on strings returns as soon as it finds a differing byte, so the
 * time taken tells an attacker how much of a guess was correct. That turns
 * guessing a 32-character key from infeasible into a few thousand requests.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length alone is not worth hiding — but timingSafeEqual throws on a
  // mismatch, so it has to be checked first.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Who is calling.
 *
 * Behind a reverse proxy every request arrives from 127.0.0.1, so rate
 * limiting on the socket address would treat the whole internet as one client
 * and lock everyone out together. X-Forwarded-For fixes that, but only when a
 * proxy we trust is setting it — otherwise a caller spoofs the header and gets
 * a fresh identity per request, defeating the limiter entirely.
 */
export function clientIp(req: IncomingMessage, trustedHops: number): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (trustedHops <= 0) return direct;

  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd.join(',') : fwd;
  if (!raw) return direct;

  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return direct;

  // Read from the RIGHT. X-Forwarded-For grows left-to-right as it passes
  // through proxies, and each proxy appends the address it actually saw — so
  // the right-most entries are the ones written by infrastructure we trust,
  // and everything to their left is whatever the caller chose to claim.
  //
  // Taking the left-most entry, as this used to, means a caller sets
  // "X-Forwarded-For: 1.2.3.4", changes it every request, and gets a fresh
  // identity each time — which defeats rate limiting entirely.
  //
  // With one proxy in front, that is the last entry. With a CDN in front of
  // that proxy, it is the second to last, and so on.
  const idx = parts.length - trustedHops;
  return parts[Math.max(0, idx)] ?? direct;
}

interface Bucket {
  failures: number;
  /** When the current block expires; 0 when not blocked. */
  blockedUntil: number;
  lastFailure: number;
}

/**
 * Blocks a client after repeated authentication failures.
 *
 * Without this, every secret the broker holds — app keys, the admin key,
 * invite codes — can be guessed at whatever rate the network allows. An
 * 8-character invite code is 28^8 combinations, which sounds ample until you
 * can try ten thousand a second.
 *
 * Only failures count. A caller using a valid key is never slowed down.
 */
export class AuthLimiter {
  private buckets = new Map<string, Bucket>();
  private lastPrune = Date.now();

  constructor(
    private maxFailures: number,
    private windowMs: number,
    private blockMs: number,
  ) {}

  /** Is this client currently locked out? */
  blocked(ip: string): boolean {
    const b = this.buckets.get(ip);
    if (!b) return false;
    if (b.blockedUntil > Date.now()) return true;
    if (b.blockedUntil !== 0) {
      // Block expired: start them fresh rather than leaving them one failure
      // away from another lockout.
      this.buckets.delete(ip);
    }
    return false;
  }

  /** Record a failed authentication. Returns true if that triggered a block. */
  fail(ip: string): boolean {
    this.prune();
    const now = Date.now();
    const b = this.buckets.get(ip);
    if (!b) {
      this.buckets.set(ip, { failures: 1, blockedUntil: 0, lastFailure: now });
      return false;
    }
    // Failures spread thinly over hours are noise, not an attack.
    if (now - b.lastFailure > this.windowMs) b.failures = 0;
    b.failures++;
    b.lastFailure = now;
    if (b.failures >= this.maxFailures) {
      b.blockedUntil = now + this.blockMs;
      return true;
    }
    return false;
  }

  /** A successful authentication clears the slate for that client. */
  succeed(ip: string): void {
    this.buckets.delete(ip);
  }

  /** Seconds until this client may try again. */
  retryAfter(ip: string): number {
    const b = this.buckets.get(ip);
    if (!b || b.blockedUntil <= Date.now()) return 0;
    return Math.ceil((b.blockedUntil - Date.now()) / 1000);
  }

  get tracked(): number {
    return this.buckets.size;
  }

  /** Keep the map bounded: an attacker rotating source addresses would
   *  otherwise grow it without limit. */
  private prune(): void {
    const now = Date.now();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const cutoff = Math.max(this.windowMs, this.blockMs);
    for (const [ip, b] of this.buckets) {
      if (b.blockedUntil <= now && now - b.lastFailure > cutoff) this.buckets.delete(ip);
    }
  }
}
