import { createLogger } from '../lib/logger.js';
// BUG #23 FIX: unlinkSync was being dynamically imported inside async methods
// (reset() and _persistToRedis()) with `await import('node:fs')` even though
// the module was already statically imported at the top of the file.
// Using await import() in a synchronous-intent block adds unnecessary async
// overhead in the critical shutdown path and is semantically wrong.
// Added unlinkSync to the static import — one line change, zero behaviour change.
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const log = createLogger('kill-switch');
const KILL_SWITCH_FILE = join(process.cwd(), '.kill_switch_state');

/**
 * Kill Switch — Redis-persisted emergency halt.
 *
 * Survives app restarts via Redis key `risk:kill_switch`.
 * Once engaged, ALL trading is blocked until manually reset.
 *
 * Design choices:
 *   - `isEngaged()` is **synchronous** (reads from in-memory cache)
 *   - `engage()` is **async** — sets in-memory immediately, then AWAITS
 *     the Redis write before returning. This eliminates the race condition
 *     where a crash between in-memory set and Redis write loses state.
 *   - `verifyIntegrity()` is called on startup to detect conflicts.
 *
 * @module kill-switch
 */

const REDIS_KEY = 'risk:kill_switch';

export class KillSwitch {
  /**
   * @param {Object} [deps={}]
   * @param {Function} deps.cacheGet - Redis cacheGet function
   * @param {Function} deps.cacheSet - Redis cacheSet function
   */
  constructor(deps = {}) {
    /** @type {boolean} In-memory engaged state (synchronous reads) */
    this._engaged = false;

    /** @type {string|null} Reason for kill switch */
    this._reason = null;

    /** @type {string|null} ISO timestamp when engaged */
    this._engagedAt = null;

    /** @type {number} Total daily drawdown that triggered the kill */
    this._drawdownPct = 0;

    this._cacheGet = deps.cacheGet || null;
    this._cacheSet = deps.cacheSet || null;

    /** @type {Function|null} Callback when kill switch engages (for Telegram, etc.) */
    this._onEngage = deps.onEngage || null;
  }

  /**
   * Load persisted kill switch state from Redis (primary) or local file (secondary).
   * MUST be called during app init — before any trading logic runs.
   * @returns {Promise<void>}
   */
  async loadFromRedis() {
    // ── Primary: Redis ────────────────────────────────────────────
    if (this._cacheGet) {
      try {
        const stored = await this._cacheGet(REDIS_KEY);
        if (stored && stored.engaged) {
          this._engaged = true;
          this._reason = stored.reason || 'Restored from Redis';
          this._engagedAt = stored.engagedAt || null;
          this._drawdownPct = stored.drawdownPct || 0;

          log.warn({
            reason: this._reason,
            engagedAt: this._engagedAt,
            drawdownPct: this._drawdownPct,
            source: 'redis',
          }, '⚠ KILL SWITCH RESTORED FROM REDIS — trading blocked');
        }
        return; // Trust Redis (engaged or not) if it responded
      } catch (err) {
        log.error({ err: err.message }, 'Redis unavailable during loadFromRedis — checking file fallback');
      }
    }

    // ── Secondary: Local file ─────────────────────────────────────
    // C6 FIX: check file when Redis has no state or is unavailable.
    try {
      if (existsSync(KILL_SWITCH_FILE)) {
        const raw = readFileSync(KILL_SWITCH_FILE, 'utf8');
        const stored = JSON.parse(raw);
        if (stored && stored.engaged) {
          this._engaged = true;
          this._reason = stored.reason || 'Restored from file (Redis was unavailable)';
          this._engagedAt = stored.engagedAt || null;
          this._drawdownPct = stored.drawdownPct || 0;

          log.error({
            reason: this._reason,
            engagedAt: this._engagedAt,
            source: 'file',
          }, '🛑 KILL SWITCH RESTORED FROM FILE — Redis was unavailable at prior engage()');

          // Re-persist to Redis now that we have the state
          await this._persistToRedis();
        }
      }
    } catch (fsErr) {
      log.warn({ err: fsErr.message }, 'Kill switch file fallback read failed — starting unengaged');
    }
  }

  /**
   * Verify that in-memory state matches Redis state on startup.
   *
   * Catches the scenario where the app crashed after in-memory engage
   * but before Redis write completed (or vice versa).
   *
   * Policy: if Redis says engaged but memory says not → ENGAGE (fail-safe).
   *         if Redis is unreachable → ENGAGE (fail-safe).
   *
   * MUST be called AFTER loadFromRedis() during startup.
   *
   * @returns {Promise<{ consistent: boolean, action: string }>}
   */
  async verifyIntegrity() {
    if (!this._cacheGet) {
      return { consistent: true, action: 'No Redis — skipped' };
    }

    try {
      const stored = await this._cacheGet(REDIS_KEY);
      const redisEngaged = stored?.engaged === true;
      const memoryEngaged = this._engaged;

      // Case 1: Both agree → consistent
      if (redisEngaged === memoryEngaged) {
        log.info({
          memoryEngaged,
          redisEngaged,
        }, 'Kill switch integrity check PASSED — states match');
        return { consistent: true, action: 'States match' };
      }

      // Case 2: Redis says engaged, memory says not → ENGAGE (fail-safe)
      if (redisEngaged && !memoryEngaged) {
        this._engaged = true;
        this._reason = stored.reason || 'Integrity check: Redis-memory conflict';
        this._engagedAt = stored.engagedAt || new Date().toISOString();
        this._drawdownPct = stored.drawdownPct || 0;

        log.error({
          memoryEngaged,
          redisEngaged,
          action: 'ENGAGED (fail-safe)',
        }, '🛑 INTEGRITY CONFLICT: Redis=engaged, Memory=not → engaging fail-safe');

        return {
          consistent: false,
          action: 'ENGAGED — Redis had engaged state that memory lost',
        };
      }

      // Case 3: Memory says engaged, Redis says not → persist to Redis
      if (memoryEngaged && !redisEngaged) {
        log.error({
          memoryEngaged,
          redisEngaged,
          action: 'PERSISTING memory state to Redis',
        }, '⚠ INTEGRITY CONFLICT: Memory=engaged, Redis=not → persisting to Redis');

        await this._persistToRedis();

        return {
          consistent: false,
          action: 'PERSISTED — memory state written to Redis',
        };
      }
    } catch (err) {
      // Redis unreachable during integrity check → ENGAGE (fail-safe)
      log.error({ err: err.message }, '🛑 INTEGRITY CHECK FAILED: Redis unreachable — engaging fail-safe');

      this._engaged = true;
      this._reason = `Integrity check failed: Redis unreachable (${err.message})`;
      this._engagedAt = new Date().toISOString();

      return {
        consistent: false,
        action: 'ENGAGED — Redis unreachable, fail-safe triggered',
      };
    }

    return { consistent: true, action: 'No conflict detected' };
  }

  /**
   * Engage the kill switch. Immediately blocks all trading.
   *
   * Sets in-memory state synchronously, then AWAITS the Redis write.
   * Callers should `await` this to ensure persistence before continuing,
   * but `isEngaged()` will return true immediately regardless.
   *
   * @param {string} reason - Why it was engaged
   * @param {number} [drawdownPct=0] - Current drawdown percentage
   * @returns {Promise<void>}
   */
  async engage(reason, drawdownPct = 0) {
    // Step 1: in-memory — immediate, synchronous
    this._engaged = true;
    this._reason = reason;
    this._engagedAt = new Date().toISOString();
    this._drawdownPct = drawdownPct;

    log.error({
      reason,
      drawdownPct,
      engagedAt: this._engagedAt,
    }, '🛑 KILL SWITCH ENGAGED — ALL TRADING HALTED');

    // Step 2: persist — AWAITED, not fire-and-forget
    await this._persistToRedis();

    // Step 3: notify external systems (Telegram, etc.)
    if (this._onEngage) {
      try {
        await this._onEngage({ reason, drawdownPct, engagedAt: this._engagedAt });
      } catch (notifyErr) {
        log.error({ err: notifyErr.message }, 'onEngage notification failed');
      }
    }
  }

  /**
   * Check if kill switch is currently engaged.
   * This is a SYNCHRONOUS check — no async gaps.
   * @returns {boolean}
   */
  isEngaged() {
    return this._engaged;
  }

  /**
   * Get full kill switch status.
   * @returns {{ engaged: boolean, reason: string|null, engagedAt: string|null, drawdownPct: number }}
   */
  getStatus() {
    return {
      engaged: this._engaged,
      reason: this._reason,
      engagedAt: this._engagedAt,
      drawdownPct: this._drawdownPct,
    };
  }

  /**
   * Manually reset the kill switch. Should only be called by operator.
   * Requires explicit confirmation string to prevent accidental reset.
   * Awaits Redis clear before returning.
   *
   * @param {string} confirmation - Must be 'CONFIRM_RESET'
   * @returns {Promise<boolean>} True if reset succeeded
   */
  async reset(confirmation) {
    if (confirmation !== 'CONFIRM_RESET') {
      log.warn('Kill switch reset rejected — invalid confirmation');
      return false;
    }

    log.warn({
      previousReason: this._reason,
      wasEngagedAt: this._engagedAt,
    }, '✅ KILL SWITCH MANUALLY RESET — trading may resume');

    this._engaged = false;
    this._reason = null;
    this._engagedAt = null;
    this._drawdownPct = 0;

    // Await persistence clear (Redis + File)
    await this._persistToRedis();

    // BUG #23 FIX: unlinkSync is now statically imported at the top of the file.
    // Previously this used `await import('node:fs')` which is redundant
    // (node:fs is already imported) and adds needless async overhead here.
    try {
      if (existsSync(KILL_SWITCH_FILE)) {
        unlinkSync(KILL_SWITCH_FILE);
        log.info({ path: KILL_SWITCH_FILE }, 'Kill switch file cleared on reset');
      }
    } catch (fsErr) {
      log.warn({ err: fsErr.message }, 'Failed to delete kill switch file on reset');
    }

    return true;
  }

  /**
   * Persist current state to Redis (primary) and local file (secondary).
   * Both are attempted independently — Redis failure does NOT skip file write.
   * @private
   * @returns {Promise<void>}
   */
  async _persistToRedis() {
    const state = {
      engaged: this._engaged,
      reason: this._reason,
      engagedAt: this._engagedAt,
      drawdownPct: this._drawdownPct,
    };

    // ── Primary: Redis ────────────────────────────────────────────
    let redisError = null;
    if (this._cacheSet) {
      try {
        await this._cacheSet(REDIS_KEY, state);
        log.debug('Kill switch state persisted to Redis');
      } catch (err) {
        log.error({ err: err.message },
          'CRITICAL: Failed to persist kill switch state to Redis — using file fallback only');
        redisError = err;
      }
    }

    // ── Secondary: Local file ─────────────────────────────────────
    // BUG #23 FIX: No longer uses `await import('node:fs')` — unlinkSync
    // is now statically imported at the top of the file.
    try {
      if (this._engaged) {
        writeFileSync(KILL_SWITCH_FILE, JSON.stringify(state), 'utf8');
        log.debug({ path: KILL_SWITCH_FILE }, 'Kill switch state persisted to file');
      } else {
        if (existsSync(KILL_SWITCH_FILE)) {
          unlinkSync(KILL_SWITCH_FILE);
        }
      }
    } catch (fsErr) {
      log.warn({ err: fsErr.message }, 'Kill switch file persistence failed');
    }

    // Re-throw Redis error so callers (and tests) know persistence is compromised.
    if (redisError) throw redisError;
  }
}