/**
 * @fileoverview Signal Consensus Layer for Quant8
 *
 * CHANGES (Tier 1):
 *   - Exported STRATEGY_GROUPS constant (reversal + momentum role groups)
 *   - Added `groupedConsensus` option (default: true) — requires ≥1 REVERSAL
 *     AND ≥1 MOMENTUM strategy to agree in the same direction before a signal
 *     fires. Eliminates false signals where a mean-reversion strategy fights a
 *     momentum strategy and they cancel each other out.
 *   - Added `groupVotes` field to result for dashboard visibility.
 *   - When `groupedConsensus: false`, falls back to original "any N agree" logic.
 */

import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('signal-consensus');

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
   *   details: Object[]
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
      };
    }

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
        results.push(result);
      } catch (err) {
        log.error({ strategy: strategy.name, err: err.message },
          'Strategy threw an error — counting as HOLD');
        votes.hold++;
        results.push({
          signal: SIGNAL.HOLD,
          confidence: 0,
          reason: `Error: ${err.message}`,
          strategy: strategy.name,
        });
        continue;
      }

      // ── Confidence gate — must pass before any vote is counted ──────────
      if (result.confidence < this.minConfidence) {
        votes.hold++; // Low-confidence signals count as HOLD
        continue;
      }

      // ── Vote tallying ────────────────────────────────────────────────────
      if (result.signal === SIGNAL.BUY) {
        votes.buy++;
      } else if (result.signal === SIGNAL.SELL) {
        votes.sell++;
      } else {
        votes.hold++;
        continue; // HOLD signals don't belong to either group
      }

      // ── Group vote tallying (for grouped consensus mode) ─────────────────
      const stratName = result.strategy ?? strategy.name;
      if (STRATEGY_GROUPS.REVERSAL.includes(stratName)) {
        if (result.signal === SIGNAL.BUY) groupVotes.reversal.buy++;
        else groupVotes.reversal.sell++;
      } else if (STRATEGY_GROUPS.MOMENTUM.includes(stratName)) {
        if (result.signal === SIGNAL.BUY) groupVotes.momentum.buy++;
        else groupVotes.momentum.sell++;
      }
    }

    // ── Determine Consensus ──────────────────────────────────────────────
    let finalSignal = SIGNAL.HOLD;
    let finalConfidence = 0;
    let reason = '';

    if (this.groupedConsensus) {
      // ── Grouped mode: ≥1 REVERSAL + ≥1 MOMENTUM must agree ─────────────
      const result = this._groupedConsensus(results, votes, groupVotes);
      finalSignal = result.signal;
      finalConfidence = result.confidence;
      reason = result.reason;
    } else {
      // ── Fallback mode: original "any minAgreement agree" logic ───────────
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
      strategiesRun: this.strategies.length,
    }, reason);

    return {
      signal: finalSignal,
      confidence: finalConfidence,
      reason,
      votes,
      groupVotes,
      details: results,
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
        (r) => r.signal === SIGNAL.BUY && r.confidence >= this.minConfidence
      );
      const confidence = Math.round(
        buyResults.reduce((sum, r) => sum + r.confidence, 0) / buyResults.length
      );

      // Build descriptive reason listing contributing strategies
      const reversalNames = this._groupContributors(results, STRATEGY_GROUPS.REVERSAL, SIGNAL.BUY);
      const momentumNames = this._groupContributors(results, STRATEGY_GROUPS.MOMENTUM, SIGNAL.BUY);
      const reason = `BUY consensus: ${reversalNames.map(n => `${n}(reversal)`).join(' + ')} + ${momentumNames.map(n => `${n}(momentum)`).join(' + ')} agree`;

      return { signal: SIGNAL.BUY, confidence, reason };
    }

    // ── SELL check ────────────────────────────────────────────────────────
    if (groupVotes.reversal.sell >= 1 && groupVotes.momentum.sell >= 1) {
      const sellResults = results.filter(
        (r) => r.signal === SIGNAL.SELL && r.confidence >= this.minConfidence
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
        (r) => r.signal === SIGNAL.BUY && r.confidence >= this.minConfidence
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
        (r) => r.signal === SIGNAL.SELL && r.confidence >= this.minConfidence
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
   * @private
   * @param {Object[]} results
   * @param {string[]} groupNames
   * @param {string}   targetSignal
   * @returns {string[]}
   */
  _groupContributors(results, groupNames, targetSignal) {
    return results
      .filter(r => groupNames.includes(r.strategy) && r.signal === targetSignal && r.confidence >= this.minConfidence)
      .map(r => r.strategy);
  }
}
