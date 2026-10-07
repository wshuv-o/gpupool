import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Runtime enrolment: short-lived invite codes exchanged for permanent agent
 * tokens.
 *
 * Adding a machine used to mean hand-editing broker.config.json and restarting
 * the broker, which drops every connected machine to admit one. Tokens granted
 * here are written to their own store instead, so the running pool is never
 * interrupted and the hand-written config stays the operator's to own.
 */

/** Human-typeable: no vowels (so no accidental words), no 0/O/1/I ambiguity. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

function code(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export interface Invite {
  code: string;
  expiresAt: number;
  /** Set once redeemed, so a code cannot be used twice. */
  usedBy?: string;
}

export interface GrantedToken {
  token: string;
  agentId: string;
  label: string;
  issuedAt: number;
}

export class Enrolment {
  private invites = new Map<string, Invite>();
  private granted: GrantedToken[] = [];

  constructor(
    private storePath: string,
    private ttlMs: number,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const doc = JSON.parse(readFileSync(this.storePath, 'utf8')) as {
        tokens?: GrantedToken[];
      };
      this.granted = doc.tokens ?? [];
    } catch {
      // A corrupt store must not stop the broker from serving the machines
      // whose tokens live in the operator's config file.
      this.granted = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(
      this.storePath,
      JSON.stringify({ tokens: this.granted }, null, 2) + '\n',
      // These are credentials: readable by the broker's user only.
      { mode: 0o600 },
    );
  }

  /** Mint an invite. Short-lived by design: it is meant to be used immediately. */
  create(): Invite {
    this.sweep();
    const invite: Invite = { code: code(8), expiresAt: Date.now() + this.ttlMs };
    this.invites.set(invite.code, invite);
    return invite;
  }

  /**
   * Exchange a code for a permanent token. Returns null when the code is
   * unknown, expired or already redeemed — deliberately one message for all
   * three, so a caller cannot probe which codes exist.
   */
  redeem(raw: string, label: string, agentId: string): GrantedToken | null {
    this.sweep();
    const wanted = normalise(raw);
    // Constant-time compare against every live invite: a plain map lookup
    // leaks, through timing, how much of a guessed code was correct.
    let hit: Invite | null = null;
    for (const invite of this.invites.values()) {
      if (invite.usedBy) continue;
      if (constantTimeEquals(invite.code, wanted)) hit = invite;
    }
    if (!hit) return null;

    hit.usedBy = agentId;
    const token: GrantedToken = {
      token: `ag_${randomBytes(24).toString('hex')}`,
      agentId,
      label,
      issuedAt: Date.now(),
    };
    this.granted.push(token);
    this.persist();
    return token;
  }

  /** Tokens issued at runtime, merged with the config file's on every check. */
  tokens(): string[] {
    return this.granted.map((g) => g.token);
  }

  has(token: string): boolean {
    return this.granted.some((g) => g.token === token);
  }

  get pendingInvites(): number {
    this.sweep();
    return [...this.invites.values()].filter((i) => !i.usedBy).length;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, invite] of this.invites) {
      if (invite.expiresAt <= now || invite.usedBy) this.invites.delete(key);
    }
  }
}

/** Accept what a human would type: spaces, dashes and lower case all fine. */
export function normalise(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
