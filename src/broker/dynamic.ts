import { randomBytes } from 'node:crypto';

/**
 * App keys for environments that appeared at runtime.
 *
 * Configured keys live in broker.config.json because an operator chose them.
 * These are different: an application started a model on a port a moment ago,
 * and something has to be able to address it. The broker mints a key, hands it
 * back through the agent, and forgets it when the machine goes away.
 *
 * Deliberately not persisted. A dynamic environment exists only while the
 * machine serving it is connected, so a key that outlived the connection would
 * point at nothing. If the broker restarts, agents reconnect, re-register, and
 * are issued fresh keys — which is why an application should read its key back
 * from the agent rather than caching it forever.
 */
export interface DynamicKey {
  key: string;
  environment: string;
  agentId: string;
  createdAt: number;
}

export class DynamicKeys {
  private byKey = new Map<string, DynamicKey>();

  /**
   * Key for one environment on one machine, reusing the existing one so a
   * re-registration does not invalidate a key an application is already using.
   */
  mint(agentId: string, environment: string): string {
    for (const entry of this.byKey.values()) {
      if (entry.agentId === agentId && entry.environment === environment) return entry.key;
    }
    const key = `pk_${randomBytes(16).toString('hex')}`;
    this.byKey.set(key, { key, environment, agentId, createdAt: Date.now() });
    return key;
  }

  /** Environment a key addresses, or undefined. */
  lookup(key: string): string | undefined {
    return this.byKey.get(key)?.environment;
  }

  /** Every key this machine currently holds, as environment -> key. */
  forAgent(agentId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of this.byKey.values()) {
      if (entry.agentId === agentId) out[entry.environment] = entry.key;
    }
    return out;
  }

  /**
   * Drop keys for environments this machine no longer serves. Called when its
   * environment list changes and when it disconnects, so a key never outlives
   * the thing it addressed.
   */
  retain(agentId: string, environments: string[]): void {
    const keep = new Set(environments);
    for (const [key, entry] of this.byKey) {
      if (entry.agentId === agentId && !keep.has(entry.environment)) this.byKey.delete(key);
    }
  }

  dropAgent(agentId: string): void {
    this.retain(agentId, []);
  }

  get size(): number {
    return this.byKey.size;
  }
}
