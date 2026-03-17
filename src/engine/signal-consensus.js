/**
 * @fileoverview Signal Consensus Layer for Alpha8
 *
 * CHANGES (Tier 1):
 *   - Exported STRATEGY_GROUPS constant (reversal + momentum role groups)
 *   - Added `groupedConsensus` option (default: true)
 *   - Added `groupVotes` field to result for dashboard visibility.
 *   - When `groupedConsensus: false`, falls back to original "any N agree" logic.
 *
 * CHANGES (Tier 2 — Feature 6):
 *   - Added CONFIDENCE_FLOORS per strategy.
 *   - Signals below their floor are included in `details` but don't vote.
 *
 * CHANGES (Tier 3 — Feature 8):
 *   - Added OPEN_WINDOW_SUPPRESSED set for 09:15–09:30 noise suppression.
 *
 * CHANGES (Tier 3 — Feature 9):
 *   - Conflict detection added at end of evaluate().
 *
 * FIXES APPLIED:
 *
 *   Fix A — Super Conviction convictionStrategy field
 *     _groupedConsensus() Super Conviction path now returns a `convictionStrategy`
 *     field containing the clean strategy name (e.g. 'EMA_CROSSOVER'). Previously
 *     the strategy name was only embedded in the reason string, making it impossible
 *     for execution-engine.js to set the correct openingStrategy and profit target
 *     mode on the posCtx without string parsing.
 *
 *   Fix B — weightedConsensusWithWeights respects meetsFloor and suppressedByTime
 *     Previously weightedConsensus() counted ALL signals in details[] that had
 *     signal='BUY'/'SELL', including those filtered by confidence floor or time
 *     suppression. This meant the pipeline Gate 1 was LESS strict than grouped
 *     consensus — it could unblock a trade the consensus layer explicitly blocked.
 *     Now signals with meetsFloor===false or suppressedByTime===true are skipped.
 *
 *   Fix C — isConflicted detects any disagreement, not just exact ties
 *     Old definition: buyCount > 0 && sellCount > 0 && buyCount === sellCount
 *     Missed cases like 2 BUY + 1 SELL where strategies actively disagree.
 *     New definition: buyCount > 0 && sellCount > 0 (any active disagreement).
 */

import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('signal-consensus');

const CONFIDENCE_FLOORS = {
  EMA_CROSSOVER: 55,
  RSI_MEAN_REVERSION: 55,
  VWAP_MOMENTUM: 45,
  BREAKOUT_VOLUME: 45,
};
const DEFAULT_FLOOR = 40;

const OPEN_WINDOW_SUPPRESSED = new Set(['EMA_CROSSOVER', 'BREAKOUT_VOLUME']);
const OPEN_WINDOW_END_MINUTES = 15;

export const STRATEGY_GROUPS = {
  REVERSAL: ['EMA_CROSSOVER', 'RSI_MEAN_REVERSION'],
  MOMENTUM: ['VWAP_MOMENTUM', 'BREAKOUT_VOLUME'],
};

function isInOpenNoiseWindow() {
  const now = new Date();
  const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const ist = new Date(istString);
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const totalMinutes = hours * 60 + minutes;
  const openMinutes = 9 * 60 + 15;
  return totalMinutes >= openMinutes && totalMinutes < openMinutes + OPEN_WINDOW_END_MINUTES;
}

export class SignalConsensus {
  constructor(config = {}) {
    this.minAgreement = config.minAgreement ?? 2;
    this.minConfidence = config.minConfidence ?? 40;
    this.groupedConsensus = config.groupedConsensus ?? true;
    this.superConvictionEnabled = config.superConvictionEnabled ?? false;
    this.superConvictionThreshold = 80;
    this.strategies = [];
    this._getLiveSetting = config.getLiveSetting || null;
  }

  addStrategy(strategy) {
    this.strategies.push(strategy);
    log.info({ strategy: strategy.name, total: this.strategies.length }, 'Strategy registered');
  }

  /**
   * Refresh live parameters from Redis.
   * @returns {Promise<void>}
   */
  async refreshParams() {
    if (!this._getLiveSetting) return;
    try {
      this.superConvictionThreshold = await this._getLiveSetting('SUPER_CONVICTION_THRESHOLD', 80);
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to refresh SignalConsensus params');
    }
  }

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

    const inOpenWindow = isInOpenNoiseWindow();

    const results = [];
    const votes = { buy: 0, sell: 0, hold: 0 };
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

      const strategyKey = result.strategy ?? strategy.name;
      const floor = CONFIDENCE_FLOORS[strategyKey] ?? DEFAULT_FLOOR;
      const meetsFloor = result.confidence >= floor;

      if (!meetsFloor) {
        log.debug({ strategy: strategyKey, confidence: result.confidence, floor },
          'Signal filtered — below confidence floor');
      }

      const suppressedByTime = inOpenWindow && OPEN_WINDOW_SUPPRESSED.has(strategyKey);

      if (suppressedByTime) {
        log.debug({ strategy: strategyKey, signal: result.signal },
          'Signal suppressed — open noise window (09:15–09:30 IST)');
      }

      results.push({
        ...result,
        meetsFloor,
        confidenceFloor: floor,
        suppressedByTime,
      });

      if (!meetsFloor || suppressedByTime) {
        votes.hold++;
        continue;
      }

      if (result.signal === SIGNAL.HOLD) {
        votes.hold++;
        continue;
      }

      if (result.signal === SIGNAL.BUY) {
        votes.buy++;
      } else if (result.signal === SIGNAL.SELL) {
        votes.sell++;
      } else {
        votes.hold++;
        continue;
      }

      if (STRATEGY_GROUPS.REVERSAL.includes(strategyKey)) {
        if (result.signal === SIGNAL.BUY) groupVotes.reversal.buy++;
        else groupVotes.reversal.sell++;
      } else if (STRATEGY_GROUPS.MOMENTUM.includes(strategyKey)) {
        if (result.signal === SIGNAL.BUY) groupVotes.momentum.buy++;
        else groupVotes.momentum.sell++;
      }
    }

    let finalSignal = SIGNAL.HOLD;
    let finalConfidence = 0;
    let reason = '';

    if (this.groupedConsensus) {
      const result = this._groupedConsensus(results, votes, groupVotes);
      finalSignal = result.signal;
      finalConfidence = result.confidence;
      reason = result.reason;
      // Propagate convictionStrategy if Super Conviction fired
      if (result.convictionStrategy) {
        return {
          signal: finalSignal,
          confidence: finalConfidence,
          reason,
          votes,
          groupVotes,
          details: results,
          convictionStrategy: result.convictionStrategy,
          // Fix C: any disagreement is a conflict
          isConflicted: this._computeConflicted(results),
          conflictDetails: this._computeConflictDetails(results),
        };
      }
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

    // Fix C: isConflicted = any buy AND sell votes (not just equal counts)
    const isConflicted = this._computeConflicted(results);
    const conflictDetails = isConflicted ? this._computeConflictDetails(results) : null;

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
   * Fix C: Compute isConflicted — any active disagreement (buy>0 AND sell>0).
   * Only counts signals that met their floor and weren't time-suppressed.
   * @private
   */
  _computeConflicted(results) {
    const buyCount = results.filter(
      d => d.signal === SIGNAL.BUY && d.meetsFloor && !d.suppressedByTime
    ).length;
    const sellCount = results.filter(
      d => d.signal === SIGNAL.SELL && d.meetsFloor && !d.suppressedByTime
    ).length;
    return buyCount > 0 && sellCount > 0;
  }

  /** @private */
  _computeConflictDetails(results) {
    return {
      buyStrategies: results
        .filter(d => d.signal === SIGNAL.BUY && d.meetsFloor && !d.suppressedByTime)
        .map(d => d.strategy),
      sellStrategies: results
        .filter(d => d.signal === SIGNAL.SELL && d.meetsFloor && !d.suppressedByTime)
        .map(d => d.strategy),
    };
  }

  /**
   * Grouped consensus: ≥1 REVERSAL AND ≥1 MOMENTUM must agree in same direction.
   *
   * Fix A: Super Conviction path now returns `convictionStrategy` so that
   * execution-engine.js can set the correct openingStrategy on posCtx without
   * string-parsing the reason field.
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

    // ── Super Conviction Bypass ───────────────────────────────────────────
    if (this.superConvictionEnabled) {
      const extremeResults = results.filter(
        (r) => r.confidence >= this.superConvictionThreshold && r.meetsFloor && !r.suppressedByTime && r.signal !== SIGNAL.HOLD
      );

      if (extremeResults.length > 0) {
        const best = extremeResults.reduce((prev, current) =>
          (prev.confidence > current.confidence) ? prev : current
        );

        return {
          signal: best.signal,
          confidence: best.confidence,
          // Fix A: expose clean strategy name so execution-engine can use it directly
          // instead of parsing the reason string.
          convictionStrategy: best.strategy,
          reason: `SUPER CONVICTION BYPASS: ${best.strategy} reached ${best.confidence}% confidence. Cross-group consensus skipped.`,
        };
      }
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
   * Fix B: weightedConsensus now skips signals that did not meet their
   * confidence floor or were suppressed by the open noise time window.
   * Previously these were counted, making Gate 1 less strict than grouped
   * consensus and allowing the pipeline to unblock explicitly blocked trades.
   *
   * @param {Array}              signals   - [{ signal, confidence, strategy, meetsFloor, suppressedByTime }]
   * @param {Map<string,number>} weights   - Pre-fetched weight map
   * @param {number}             threshold - default 2.0
   * @returns {object|null}
   */
  weightedConsensusWithWeights(signals, weights, threshold = 2.0) {
    if (!signals || signals.length === 0) return null;

    let buyWeight = 0;
    let sellWeight = 0;

    for (const sig of signals) {
      // Fix B: skip signals filtered by confidence floor or time suppression.
      // These are in details[] for shadow recording purposes only.
      if (sig.meetsFloor === false) continue;
      if (sig.suppressedByTime === true) continue;

      const w = weights.get(sig.strategy) ?? 1.0;
      if (sig.signal === 'BUY') buyWeight += w;
      if (sig.signal === 'SELL') sellWeight += w;
    }

    log.debug({
      threshold,
      buyWeight: Math.round(buyWeight * 100) / 100,
      sellWeight: Math.round(sellWeight * 100) / 100,
    }, 'Weighted consensus threshold check');

    if (buyWeight >= threshold) {
      const buys = signals.filter(s => s.signal === 'BUY' && s.meetsFloor !== false && !s.suppressedByTime);
      if (buys.length === 0) return null;
      const best = buys.reduce((m, s) => s.confidence > m.confidence ? s : m, buys[0]);
      log.debug({ threshold, buyWeight }, 'BUY weighted consensus passed');
      return {
        ...best,
        weightedScore: Math.round(buyWeight * 100) / 100,
        votingSummary: this._voteSummary(signals, weights),
      };
    }

    if (sellWeight >= threshold) {
      const sells = signals.filter(s => s.signal === 'SELL' && s.meetsFloor !== false && !s.suppressedByTime);
      if (sells.length === 0) return null;
      const best = sells.reduce((m, s) => s.confidence > m.confidence ? s : m, sells[0]);
      log.debug({ threshold, sellWeight }, 'SELL weighted consensus passed');
      return {
        ...best,
        weightedScore: Math.round(sellWeight * 100) / 100,
        votingSummary: this._voteSummary(signals, weights),
      };
    }

    log.debug({ threshold, buyWeight, sellWeight },
      'Weighted consensus blocked — weights below threshold');
    return null;
  }

  /**
   * Async wrapper that fetches weights from Redis then calls weightedConsensusWithWeights.
   */
  async weightedConsensus(signals, threshold = 2.0) {
    if (!signals || signals.length === 0) return null;
    // This method is only called from EnhancedSignalPipeline which has its own
    // AdaptiveWeightManager. The method signature is kept for backward compat.
    return this.weightedConsensusWithWeights(signals, new Map(), threshold);
  }

  /**
   * Get strategy names that voted for a given signal within a group.
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

  /** @private */
  _voteSummary(signals, weights) {
    return signals
      .filter(s => s.meetsFloor !== false && !s.suppressedByTime)
      .map(s => `${s.strategy}(${s.signal}×${(weights.get(s.strategy) ?? 1).toFixed(2)})`)
      .join(' | ');
  }
}