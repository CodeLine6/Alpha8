/**
 * @fileoverview Signal Consensus Layer for Alpha8
 *
 * CHANGES (Tier 1):
 *   - Exported STRATEGY_GROUPS constant (reversal + momentum role groups)
 *   - Added `groupedConsensus` option (default: true) — requires ≥1 REVERSAL
 *     AND ≥1 MOMENTUM strategy to agree in the same direction before a signal
 *     fires. Eliminates false signals where a mean-reversion strategy fights a
 *     momentum strategy and they cancel each other out.
 *   - Added `groupVotes` field to result for dashboard visibility.
 *   - When `groupedConsensus: false`, falls back to original "any N agree" logic.
 *
 * CHANGES (Tier 2 — Feature 6):
 *   - Added CONFIDENCE_FLOORS per strategy. REVERSAL strategies (EMA, RSI)
 *     require ≥55% confidence; MOMENTUM strategies (VWAP, Breakout) require ≥45%.
 *     DEFAULT_FLOOR = 40 for any unrecognised strategy.
 *   - Signals below their floor are included in `details` (for shadow recording
 *     and dashboard visibility) but marked meetsFloor: false and do NOT count
 *     as a vote. This prevents weak noise signals from forming false consensus.
 *
 * CHANGES (Tier 3 — Feature 8):
 *   - Added OPEN_WINDOW_SUPPRESSED set: EMA_CROSSOVER and BREAKOUT_VOLUME are
 *     suppressed during the first 15 minutes after market open (09:15–09:30 IST).
 *     Gap-open flush makes crossovers and breakouts unreliable in this window.
 *     RSI and VWAP are unaffected — they use cumulative/mean data.
 *   - isInOpenNoiseWindow() is a synchronous helper (no external deps, zero latency).
 *   - suppressedByTime is included in details even when false — downstream
 *     shadow recording reads the full details array.
 *
 * CHANGES (Tier 3 — Feature 9):
 *   - Conflict detection added at end of evaluate(). A "conflict" is defined as
 *     buyCount > 0 AND sellCount > 0 AND buyCount === sellCount (after floor +
 *     time-gate filtering). isConflicted and conflictDetails are added to the
 *     return object for ExecutionEngine to act on.
 */

import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('signal-consensus');

/**
 * Minimum confidence required for a strategy's signal to count as a vote.
 * REVERSAL strategies (EMA, RSI) require higher conviction — they trade against momentum.
 * MOMENTUM strategies (VWAP, Breakout) have a slightly lower bar — they follow direction.
 */
const CONFIDENCE_FLOORS = {
  EMA_CROSSOVER: 55,
  RSI_MEAN_REVERSION: 55,
  VWAP_MOMENTUM: 45,
  BREAKOUT_VOLUME: 45,
};
const DEFAULT_FLOOR = 40;

/**
 * Strategies that are suppressed during the market open noise window (09:15–09:30 IST).
 * EMA crossovers and breakouts are unreliable during gap-open flush — they generate
 * signals that reverse within 1–2 candles as overnight orders clear.
 * RSI and VWAP are unaffected — they use cumulative/mean data less sensitive to gaps.
 */
const OPEN_WINDOW_SUPPRESSED = new Set(['EMA_CROSSOVER', 'BREAKOUT_VOLUME']);
const OPEN_WINDOW_END_MINUTES = 15; // suppress for first 15 minutes after 09:15

/**
 * Strategy role groups.
 *
 * REVERSAL  strategies detect mean-reversion opportunities (price gone too far).
 * MOMENTUM  strategies detect directional continuation (price moving with trend).
 *
 * A valid signal requires ≥1 vote from EACH group pointing the same direction.
 * This prevents structural deadlocks where a reversal strategy fights a momentum
 * strategy and the system permanently stalls on HOLD.
 *
 * @type {{ REVERSAL: string[], MOMENTUM: string[] }}
 */
export const STRATEGY_GROUPS = {
  REVERSAL: ['ema-crossover', 'rsi-reversion'],
  MOMENTUM: ['vwap-momentum', 'breakout-volume'],
};

/**
 * Pure helper — no external dependencies, synchronous, zero latency.
 * Returns true during first 15 minutes of market session (09:15–09:30 IST).
 * Uses the same toLocaleString IST pattern as market-hours.js.
 *
 * IMPORTANT: This function is called ONCE per evaluate() call (before the loop),
 * not once per strategy — the result is stored in const inOpenWindow.
 *
 * @returns {boolean}
 */
function isInOpenNoiseWindow() {
  const now = new Date();
  // Convert to IST using the same pattern as market-hours.js
  const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const ist = new Date(istString);
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const totalMinutes = hours * 60 + minutes;
  const openMinutes = 9 * 60 + 15;  // 09:15
  return totalMinutes >= openMinutes && totalMinutes < openMinutes + OPEN_WINDOW_END_MINUTES;
}

/**
 * Signal Consensus Layer.
 *
 * Runs multiple strategies against the same candles and determines whether
 * enough strategies agree to generate a final actionable signal.
 *
 * Two consensus modes:
 *   groupedConsensus: true  (default) — requires ≥1 REVERSAL + ≥1 MOMENTUM agreement
 *   groupedConsensus: false           — original "minAgreement strategies agree" logic
 *
 * @module signal-consensus
 */
export class SignalConsensus {
  /**
   * @param {Object} [config]
   * @param {number}  [config.minAgreement=2]     - Min strategies that must agree (fallback mode)
   * @param {number}  [config.minConfidence=40]   - Min individual confidence to count as a vote
   * @param {boolean} [config.groupedConsensus=true] - Use role-group logic instead of simple count
   */
  constructor(config = {}) {
    this.minAgreement = config.minAgreement ?? 2;
    this.minConfidence = config.minConfidence ?? 40;
    this.groupedConsensus = config.groupedConsensus ?? true;

    /** @type {import('../strategies/base-strategy.js').BaseStrategy[]} */
    this.strategies = [];
  }

  /**
   * Register a strategy instance.
   * @param {import('../strategies/base-strategy.js').BaseStrategy} strategy
   */
  addStrategy(strategy) {
    this.strategies.push(strategy);
    log.info({ strategy: strategy.name, total: this.strategies.length }, 'Strategy registered');
  }

  /**
   * Run all registered strategies and determine consensus.
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {{
   *   signal: 'BUY'|'SELL'|'HOLD',
   *   confidence: number,
   *   reason: string,
   *   votes: { buy: number, sell: number, hold: number },
   *   groupVotes: { reversal: { buy: number, sell: number }, momentum: { buy: number, sell: number } },
   *   details: Object[],
   *   isConflicted: boolean,
   *   conflictDetails: { buyStrategies: string[], sellStrategies: string[] } | null
   * }}
   */
  evaluate(candles) {
    if (this.strategies.length === 0) {
      return {
        signal: SIGNAL.HOLD,
        confidence: 0,
        reason: 'No strategies registered',
        votes: { buy: 0, sell: 0, hold: 0 },
        groupVotes: { reversal: { buy: 0, sell: 0 }, momentum: { buy: 0, sell: 0 } },
        details: [],
        isConflicted: false,
        conflictDetails: null,
      };
    }

    // ── Feature 8: compute time gate ONCE before the loop ─────────────────────
    const inOpenWindow = isInOpenNoiseWindow();

    const results = [];
    const votes = { buy: 0, sell: 0, hold: 0 };

    /** @type {{ reversal: { buy: number, sell: number }, momentum: { buy: number, sell: number } }} */
    const groupVotes = {
      reversal: { buy: 0, sell: 0 },
      momentum: { buy: 0, sell: 0 },
    };

    for (const strategy of this.strategies) {
      let result;
      try {
        result = strategy.analyze(candles);
      } catch (err) {
        log.error({ strategy: strategy.name, err: err.message },
          'Strategy threw an error — counting as HOLD');
        votes.hold++;
        results.push({
          signal: SIGNAL.HOLD,
          confidence: 0,
          reason: `Error: ${err.message}`,
          strategy: strategy.name,
          meetsFloor: false,
          confidenceFloor: CONFIDENCE_FLOORS[strategy.name] ?? DEFAULT_FLOOR,
          suppressedByTime: false,
        });
        continue;
      }

      // ── Confidence gate — must pass minConfidence before any vote is counted ─
      if (result.confidence < this.minConfidence) {
        votes.hold++;
        results.push({
          ...result,
          meetsFloor: false,
          confidenceFloor: CONFIDENCE_FLOORS[result.strategy ?? strategy.name] ?? DEFAULT_FLOOR,
          suppressedByTime: false,
        });
        continue;
      }

      // ── Feature 6: Per-strategy confidence floor ──────────────────────────────
      const strategyKey = result.strategy ?? strategy.name;
      const floor = CONFIDENCE_FLOORS[strategyKey] ?? DEFAULT_FLOOR;
      const meetsFloor = result.confidence >= floor;

      if (!meetsFloor) {
        log.debug({
          strategy: strategyKey,
          confidence: result.confidence,
          floor,
        }, 'Signal filtered — below confidence floor');
      }

      // ── Feature 8: Time gate — suppress EMA/Breakout during open noise window ─
      const suppressedByTime = inOpenWindow && OPEN_WINDOW_SUPPRESSED.has(strategyKey);

      if (suppressedByTime) {
        log.debug({
          strategy: strategyKey,
          signal: result.signal,
        }, 'Signal suppressed — open noise window (09:15–09:30 IST)');
      }

      // Include in details ALWAYS — shadow recording and dashboard need full picture.
      // suppressedByTime:false is explicit so downstream always has the field.
      results.push({
        ...result,
        meetsFloor,
        confidenceFloor: floor,
        suppressedByTime,
      });

      // Only count as vote if it meets floor AND is not time-suppressed
      if (!meetsFloor || suppressedByTime) {
        votes.hold++; // filtered signals count as HOLD
        continue;
      }

      if (result.signal === SIGNAL.HOLD) {
        votes.hold++;
        continue;
      }

      // ── Vote tallying ─────────────────────────────────────────────────────────
      if (result.signal === SIGNAL.BUY) {
        votes.buy++;
      } else if (result.signal === SIGNAL.SELL) {
        votes.sell++;
      } else {
        votes.hold++;
        continue;
      }

      // ── Group vote tallying (for grouped consensus mode) ──────────────────────
      if (STRATEGY_GROUPS.REVERSAL.includes(strategyKey)) {
        if (result.signal === SIGNAL.BUY) groupVotes.reversal.buy++;
        else groupVotes.reversal.sell++;
      } else if (STRATEGY_GROUPS.MOMENTUM.includes(strategyKey)) {
        if (result.signal === SIGNAL.BUY) groupVotes.momentum.buy++;
        else groupVotes.momentum.sell++;
      }
    }

    // ── Determine Consensus ──────────────────────────────────────────────
    let finalSignal = SIGNAL.HOLD;
    let finalConfidence = 0;
    let reason = '';

    if (this.groupedConsensus) {
      const result = this._groupedConsensus(results, votes, groupVotes);
      finalSignal = result.signal;
      finalConfidence = result.confidence;
      reason = result.reason;
    } else {
      const result = this._simpleConsensus(results, votes);
      finalSignal = result.signal;
      finalConfidence = result.confidence;
      reason = result.reason;
    }

    log.info({
      signal: finalSignal,
      confidence: finalConfidence,
      votes,
      groupVotes,
      mode: this.groupedConsensus ? 'grouped' : 'simple',
      inOpenWindow,
      strategiesRun: this.strategies.length,
    }, reason);

    // ── Feature 9: Conflict detection ────────────────────────────────────────
    // A conflict is BUY and SELL votes that perfectly cancel — both > 0 and equal.
    // Only counts votes that met floor AND were not time-suppressed.
    const buyCount = results.filter(d => d.signal === SIGNAL.BUY && d.meetsFloor && !d.suppressedByTime).length;
    const sellCount = results.filter(d => d.signal === SIGNAL.SELL && d.meetsFloor && !d.suppressedByTime).length;
    const isConflicted = buyCount > 0 && sellCount > 0 && buyCount === sellCount;

    const conflictDetails = isConflicted ? {
      buyStrategies: results.filter(d => d.signal === SIGNAL.BUY && d.meetsFloor && !d.suppressedByTime).map(d => d.strategy),
      sellStrategies: results.filter(d => d.signal === SIGNAL.SELL && d.meetsFloor && !d.suppressedByTime).map(d => d.strategy),
    } : null;

    return {
      signal: finalSignal,
      confidence: finalConfidence,
      reason,
      votes,
      groupVotes,
      details: results,
      isConflicted,
      conflictDetails,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Grouped consensus: ≥1 REVERSAL AND ≥1 MOMENTUM must agree in same direction.
   * @private
   */
  _groupedConsensus(results, votes, groupVotes) {
    // ── BUY check ─────────────────────────────────────────────────────────
    if (groupVotes.reversal.buy >= 1 && groupVotes.momentum.buy >= 1) {
      const buyResults = results.filter(
        (r) => r.signal === SIGNAL.BUY && r.confidence >= this.minConfidence && r.meetsFloor && !r.suppressedByTime
      );
      const confidence = Math.round(
        buyResults.reduce((sum, r) => sum + r.confidence, 0) / buyResults.length
      );

      const reversalNames = this._groupContributors(results, STRATEGY_GROUPS.REVERSAL, SIGNAL.BUY);
      const momentumNames = this._groupContributors(results, STRATEGY_GROUPS.MOMENTUM, SIGNAL.BUY);
      const reason = `BUY consensus: ${reversalNames.map(n => `${n}(reversal)`).join(' + ')} + ${momentumNames.map(n => `${n}(momentum)`).join(' + ')} agree`;

      return { signal: SIGNAL.BUY, confidence, reason };
    }

    // ── SELL check ────────────────────────────────────────────────────────
    if (groupVotes.reversal.sell >= 1 && groupVotes.momentum.sell >= 1) {
      const sellResults = results.filter(
        (r) => r.signal === SIGNAL.SELL && r.confidence >= this.minConfidence && r.meetsFloor && !r.suppressedByTime
      );
      const confidence = Math.round(
        sellResults.reduce((sum, r) => sum + r.confidence, 0) / sellResults.length
      );

      const reversalNames = this._groupContributors(results, STRATEGY_GROUPS.REVERSAL, SIGNAL.SELL);
      const momentumNames = this._groupContributors(results, STRATEGY_GROUPS.MOMENTUM, SIGNAL.SELL);
      const reason = `SELL consensus: ${reversalNames.map(n => `${n}(reversal)`).join(' + ')} + ${momentumNames.map(n => `${n}(momentum)`).join(' + ')} agree`;

      return { signal: SIGNAL.SELL, confidence, reason };
    }

    // ── No cross-group agreement ──────────────────────────────────────────
    const reason =
      `No cross-group consensus. ` +
      `Reversal — BUY:${groupVotes.reversal.buy} SELL:${groupVotes.reversal.sell} | ` +
      `Momentum — BUY:${groupVotes.momentum.buy} SELL:${groupVotes.momentum.sell}`;
    return { signal: SIGNAL.HOLD, confidence: 0, reason };
  }

  /**
   * Simple (original) consensus: minAgreement strategies must agree.
   * @private
   */
  _simpleConsensus(results, votes) {
    if (votes.buy >= this.minAgreement && votes.buy > votes.sell) {
      const buyResults = results.filter(
        (r) => r.signal === SIGNAL.BUY && r.confidence >= this.minConfidence && r.meetsFloor !== false && !r.suppressedByTime
      );
      const confidence = Math.round(
        buyResults.reduce((sum, r) => sum + r.confidence, 0) / buyResults.length
      );
      return {
        signal: SIGNAL.BUY,
        confidence,
        reason: `BUY consensus: ${votes.buy}/${this.strategies.length} strategies agree`,
      };
    }

    if (votes.sell >= this.minAgreement && votes.sell > votes.buy) {
      const sellResults = results.filter(
        (r) => r.signal === SIGNAL.SELL && r.confidence >= this.minConfidence && r.meetsFloor !== false && !r.suppressedByTime
      );
      const confidence = Math.round(
        sellResults.reduce((sum, r) => sum + r.confidence, 0) / sellResults.length
      );
      return {
        signal: SIGNAL.SELL,
        confidence,
        reason: `SELL consensus: ${votes.sell}/${this.strategies.length} strategies agree`,
      };
    }

    return {
      signal: SIGNAL.HOLD,
      confidence: 0,
      reason:
        `No consensus (need ${this.minAgreement}). ` +
        `Votes — BUY: ${votes.buy}, SELL: ${votes.sell}, HOLD: ${votes.hold}`,
    };
  }

  /**
   * Get strategy names that voted for a given signal within a group.
   * Only includes signals that met their confidence floor AND were not time-suppressed.
   * @private
   */
  _groupContributors(results, groupNames, targetSignal) {
    return results
      .filter(r =>
        groupNames.includes(r.strategy) &&
        r.signal === targetSignal &&
        r.confidence >= this.minConfidence &&
        r.meetsFloor !== false &&
        !r.suppressedByTime
      )
      .map(r => r.strategy);
  }
}
