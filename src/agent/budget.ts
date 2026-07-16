/**
 * Run budget: enforced between agent turns. When any limit trips, the agent
 * gets exactly one final "wrap up" turn with tools disabled.
 */
export interface BudgetLimits {
  maxUsd: number;
  maxWallMs: number;
  maxTurns: number;
  maxTokens: number;
}

/**
 * Runs end at the model's natural completion — these are backstops, not design
 * constraints. USD catches runaway spend; wall clock is an ops guard; turns
 * guard infinite tool ping-pong; tokens are effectively unlimited (cost already
 * prices them). The whole agent tree shares one tracker.
 */
export const DEFAULT_LIMITS: BudgetLimits = {
  maxUsd: 100,
  maxWallMs: 360 * 60 * 1000,
  maxTurns: 10_000,
  maxTokens: 1_000_000_000,
};

export const RESERVE_OUTPUT_FLOOR_TOKENS = 512;

export interface CallReservation {
  usd: number;
  maxTokens: number;
}

export class BudgetTracker {
  readonly limits: BudgetLimits;
  private startedAt = Date.now();
  private reservedUsd = 0;
  usedUsd = 0;
  usedTokens = 0;
  turns = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  addUsage(usd: number, tokens: number): void {
    this.usedUsd += usd;
    this.usedTokens += tokens;
  }

  addTurn(): void {
    this.turns += 1;
  }

  availableUsd(): number {
    return Math.max(this.limits.maxUsd - this.usedUsd - this.reservedUsd, 0);
  }

  remainingWallMs(): number {
    return Math.max(this.limits.maxWallMs - this.elapsedMs, 0);
  }

  /**
   * Check + reserve is synchronous so concurrent subagents sharing this
   * tracker cannot double-book remaining headroom.
   */
  tryReserve(usd: number): boolean {
    if (this.usedUsd + this.reservedUsd + usd > this.limits.maxUsd + 1e-9) return false;
    this.reservedUsd += usd;
    return true;
  }

  /**
   * Reserve worst-case cost of one provider call before issuing it. Clamps
   * maxOutputTokens down to fit (not below floorTokens); returns null when
   * even the floor doesn't fit.
   */
  reserveCall(
    estInputTokens: number,
    maxOutputTokens: number,
    pricing: { input_per_mtok: number; output_per_mtok: number },
    floorTokens: number = RESERVE_OUTPUT_FLOOR_TOKENS,
  ): CallReservation | null {
    const inUsd = (estInputTokens * pricing.input_per_mtok) / 1_000_000;
    const perOutTok = pricing.output_per_mtok / 1_000_000;
    const full = inUsd + maxOutputTokens * perOutTok;
    if (this.tryReserve(full)) return { usd: full, maxTokens: maxOutputTokens };
    if (perOutTok <= 0) return null; // input cost alone doesn't fit
    const clamped = Math.min(
      maxOutputTokens,
      Math.floor((this.availableUsd() - inUsd) / perOutTok),
    );
    if (clamped < Math.max(floorTokens, 1)) return null;
    const usd = inUsd + clamped * perOutTok;
    if (!this.tryReserve(usd)) return null;
    return { usd, maxTokens: clamped };
  }

  /** Release reservation and record actual spend. */
  settle(reservation: CallReservation, actualUsd: number, tokens: number): void {
    this.reservedUsd = Math.max(this.reservedUsd - reservation.usd, 0);
    this.addUsage(actualUsd, tokens);
  }

  release(reservation: CallReservation): void {
    this.reservedUsd = Math.max(this.reservedUsd - reservation.usd, 0);
  }

  exceeded(): string | null {
    if (this.usedUsd >= this.limits.maxUsd) {
      return `cost budget exhausted ($${this.usedUsd.toFixed(4)} >= $${this.limits.maxUsd})`;
    }
    if (this.elapsedMs >= this.limits.maxWallMs) {
      return `wall-clock budget exhausted (${Math.round(this.elapsedMs / 1000)}s >= ${Math.round(this.limits.maxWallMs / 1000)}s)`;
    }
    if (this.turns >= this.limits.maxTurns) {
      return `turn budget exhausted (${this.turns} >= ${this.limits.maxTurns})`;
    }
    if (this.usedTokens >= this.limits.maxTokens) {
      return `token budget exhausted (${this.usedTokens} >= ${this.limits.maxTokens})`;
    }
    return null;
  }
}
