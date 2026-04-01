/**
 * @fileoverview Signal Consensus Layer for Alpha8
 *
 * CHANGES (Tier 1):
 *   - Exported STRATEGY_GROUPS constant (reversal + momentum role groups)
 *   - Added `groupedConsensus` option (default: true)
 *   - Added `groupVotes` field to result for dashboard visibility
 *   - When `groupedConsensus: false`, falls back to original "any N agree" logic
 *
 * CHANGES (Tier 2 — Feature 6):
 *   - Added CONFIDENCE_FLOORS per strategy
 *   - Signals below their floor are included in `details` but don't vote
 *
 * CHANGES (Tier 3 — Feature 8):
 *   - Added OPEN_WINDOW_SUPPRESSED set for 09:15–09:30 noise suppression
 *
 * CHANGES (Tier 3 — Feature 9):
 *   - Conflict detection added at end of evaluate()
 *
 * CHANGES (Short Selling):
 *   - Exported SHORT_INELIGIBLE_STRATEGIES — RSI cannot open short positions
 *   - _groupedConsensus() SELL path excludes RSI from short-entry consensus
 *   - isShortEntry flag added to SELL consensus result
 *   - RSI-only SELL marked isShortEntry:false (valid long exit, not a short entry)
 *   - Super Conviction SELL also respects SHORT_INELIGIBLE_STRATEGIES
 *
 * FIXES APPLIED:
 *
 *   Fix A — Super Conviction convictionStrategy field
 *     _groupedConsensus() Super Conviction path now returns a `convictionStrategy`
 *     field containing the clean strategy name.
 *
 *   Fix B — weightedConsensusWithWeights respects meetsFloor and suppressedByTime
 *     Signals with meetsFloor===false or suppressedByTime===true are skipped.
 *
 *   Fix C — isConflicted detects any disagreement, not just exact ties
 *     New definition: buyCount > 0 && sellCount > 0 (any active disagreement).
 */

import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('signal-consensus');

// ── Confidence floors ─────────────────────────────────────────────────────────

const CONFIDENCE_FLOORS = {
  ORB: 55,   // Opening Range Breakout — range-confirmed, reliable
  BAVI: 50,   // Bid-Ask Volume Imbalance — tick-based, reliable early
  VWAP_MOMENTUM: 45,
  BREAKOUT_VOLUME: 45,
};
const DEFAULT_FLOOR = 40;

// ── Open-window noise suppression ─────────────────────────────────────────────

// ── Open-window noise suppression ─────────────────────────────────────────────
// BAVI is suppressed until 9:30 — needs enough ticks (≥ 50) to be reliable.
// ORB self-suppresses via its own time check (OR incomplete until 9:45) —
// adding it here is redundant and would prevent the strategy's own HOLD reason.
const OPEN_WINDOW_SUPPRESSED = new Set(['BAVI']);
const OPEN_WINDOW_END_MINUTES = 15;

// ── Strategy groups ───────────────────────────────────────────────────────────
//
// REVERSAL: ORB (opening range breakout) + BAVI (order-flow imbalance)
// MOMENTUM: VWAP_MOMENTUM + BREAKOUT_VOLUME — unchanged
//
// Cross-group consensus rule is unchanged:
//   BUY  consensus requires ≥1 REVERSAL AND ≥1 MOMENTUM to agree.
//   SELL consensus (short entry) requires the same cross-group agreement.
//   ORB + BAVI alone → HOLD (same group).
//   VWAP + Breakout alone → HOLD (same group).
export const STRATEGY_GROUPS = {
  REVERSAL: ['ORB', 'BAVI'],
  MOMENTUM: ['VWAP_MOMENTUM', 'BREAKOUT_VOLUME'],
};

// ── Short selling eligibility ─────────────────────────────────────────────────
//
// ORB:  bearish breakdown below OR low is a textbook short setup.
// BAVI: seller-dominated order flow with price below VWAP is short-eligible.
// RSI is no longer in consensus — removed from this set.
export const SHORT_INELIGIBLE_STRATEGIES = new Set();
// (empty — all four active consensus strategies can open short positions)

// ── Helpers ───────────────────────────────────────────────────────────────────

function isInOpenNoiseWindow() {
  const now = new Date();
  const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const ist = new Date(istString);
  const totalMinutes = ist.getHours() * 60 + ist.getMinutes();
  const openMinutes = 9 * 60 + 15;
  return totalMinutes >= openMinutes && totalMinutes < openMinutes + OPEN_WINDOW_END_MINUTES;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SignalConsensus
// ═══════════════════════════════════════════════════════════════════════════════

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
   */
  async refreshParams() {
    if (!this._getLiveSetting) return;
    try {
      this.superConvictionThreshold = await this._getLiveSetting('SUPER_CONVICTION_THRESHOLD', 80);
      // Fix BUG-17: also refresh minConfidence and minAgreement so /set commands take effect
      this.minConfidence = await this._getLiveSetting('MIN_CONFIDENCE', this.minConfidence);
      this.minAgreement = await this._getLiveSetting('MIN_AGREEMENT', this.minAgreement);
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to refresh SignalConsensus params');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // evaluate()
  // ─────────────────────────────────────────────────────────────────────────

  evaluate(candles, symbol = 'unknown') {
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
        isShortEntry: false,
      };
    }

    const inOpenWindow = isInOpenNoiseWindow();

    const results = [];
    const votes = { buy: 0, sell: 0, hold: 0 };
    const groupVotes = {
      reversal: { buy: 0, sell: 0 },
      momentum: { buy: 0, sell: 0 },
    };

    // ── Run each strategy ─────────────────────────────────────────────────
    for (const strategy of this.strategies) {
      let result;
      try {
        result = strategy.analyze(candles, symbol);
        log.debug({ strategy: strategy.name, signal: result.signal, confidence: result.confidence, reason: result.reason },
          `[${strategy.name}] → ${result.signal} (${result.confidence}%)`);
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

      // Below global minConfidence → HOLD
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
      const suppressedByTime = inOpenWindow && OPEN_WINDOW_SUPPRESSED.has(strategyKey);

      if (!meetsFloor) {
        log.debug({ strategy: strategyKey, confidence: result.confidence, floor },
          'Signal filtered — below confidence floor');
      }
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

      // Accumulate group votes
      if (STRATEGY_GROUPS.REVERSAL.includes(strategyKey)) {
        if (result.signal === SIGNAL.BUY) groupVotes.reversal.buy++;
        else groupVotes.reversal.sell++;
      } else if (STRATEGY_GROUPS.MOMENTUM.includes(strategyKey)) {
        if (result.signal === SIGNAL.BUY) groupVotes.momentum.buy++;
        else groupVotes.momentum.sell++;
      }
    }

    // ── Resolve final signal ──────────────────────────────────────────────
    let finalSignal = SIGNAL.HOLD;
    let finalConfidence = 0;
    let reason = '';
    let isShortEntry = false;
    let convictionStrategy = undefined;

    if (this.groupedConsensus) {
      const gr = this._groupedConsensus(results, votes, groupVotes, symbol);
      finalSignal = gr.signal;
      finalConfidence = gr.confidence;
      reason = gr.reason;
      isShortEntry = gr.isShortEntry ?? false;
      convictionStrategy = gr.convictionStrategy;

      // Super Conviction path returns early with convictionStrategy
      if (convictionStrategy) {
        return {
          signal: finalSignal,
          confidence: finalConfidence,
          reason,
          votes,
          groupVotes,
          details: results,
          convictionStrategy,
          isShortEntry,
          isConflicted: this._computeConflicted(results),
          conflictDetails: this._computeConflictDetails(results),
        };
      }
    } else {
      const sr = this._simpleConsensus(results, votes);
      finalSignal = sr.signal;
      finalConfidence = sr.confidence;
      reason = sr.reason;
      // In simple mode, SELL consensus is treated as a short entry
      // only if at least one short-eligible strategy voted SELL
      if (finalSignal === SIGNAL.SELL) {
        isShortEntry = results.some(
          r => r.signal === SIGNAL.SELL &&
            r.meetsFloor !== false &&
            !r.suppressedByTime &&
            !SHORT_INELIGIBLE_STRATEGIES.has(r.strategy)
        );
      }
    }

    log.info({
      symbol,   // ← ADD THIS LINE
      signal: finalSignal,
      confidence: finalConfidence,
      votes,
      groupVotes,
      isShortEntry,
      mode: this.groupedConsensus ? 'grouped' : 'simple',
      inOpenWindow,
      strategiesRun: this.strategies.length,
    }, reason);

    // When all strategies vote HOLD, log each strategy's reason so operators
    // can see exactly why ORB/BAVI/VWAP/Breakout are holding (range-bound,
    // insufficient volume, no OR candles yet, weak tick imbalance, etc.).
    if (finalSignal === SIGNAL.HOLD && votes.buy === 0 && votes.sell === 0) {
      for (const r of results) {
        log.info(
          {
            symbol, strategy: r.strategy, signal: r.signal, confidence: r.confidence,
            meetsFloor: r.meetsFloor, suppressedByTime: r.suppressedByTime
          },
          `  ↳ [${symbol}/${r.strategy}] HOLD — ${r.reason}`
        );
      }
    }

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
      isShortEntry,
      isConflicted,
      conflictDetails,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // _groupedConsensus()
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cross-group consensus: ≥1 REVERSAL AND ≥1 MOMENTUM must agree.
   *
   * BUY  (open long):  all strategies eligible.
   * SELL (open short): SHORT_INELIGIBLE_STRATEGIES excluded from vote.
   *                    RSI-only SELL → isShortEntry:false (long exit only).
   */
  _groupedConsensus(results, votes, groupVotes, symbol = 'unknown') {

    // ── BUY check (open long) ─────────────────────────────────────────────
    if (groupVotes.reversal.buy >= 1 && groupVotes.momentum.buy >= 1) {
      const buyResults = results.filter(
        r => r.signal === SIGNAL.BUY &&
          r.confidence >= this.minConfidence &&
          r.meetsFloor &&
          !r.suppressedByTime
      );
      const confidence = Math.round(
        buyResults.reduce((sum, r) => sum + r.confidence, 0) / buyResults.length
      );
      const reversalNames = this._groupContributors(results, STRATEGY_GROUPS.REVERSAL, SIGNAL.BUY);
      const momentumNames = this._groupContributors(results, STRATEGY_GROUPS.MOMENTUM, SIGNAL.BUY);
      return {
        signal: SIGNAL.BUY,
        confidence,
        isShortEntry: false,
        reason: `BUY consensus: ${reversalNames.map(n => `${n}(reversal)`).join(' + ')} + ${momentumNames.map(n => `${n}(momentum)`).join(' + ')} agree`,
      };
    }

    // ── SELL check (open short) ───────────────────────────────────────────
    // RSI_MEAN_REVERSION is excluded from short-entry consensus.
    // It is valid as a long EXIT but cannot open a new short position.
    const shortEligibleResults = results.filter(
      r => !SHORT_INELIGIBLE_STRATEGIES.has(r.strategy)
    );

    // Recount group votes for short-eligible strategies only
    const shortGroupVotes = { reversal: { sell: 0 }, momentum: { sell: 0 } };
    for (const r of shortEligibleResults) {
      if (!r.meetsFloor || r.suppressedByTime || r.signal !== SIGNAL.SELL) continue;
      if (STRATEGY_GROUPS.REVERSAL.includes(r.strategy)) shortGroupVotes.reversal.sell++;
      if (STRATEGY_GROUPS.MOMENTUM.includes(r.strategy)) shortGroupVotes.momentum.sell++;
    }

    if (shortGroupVotes.reversal.sell >= 1 && shortGroupVotes.momentum.sell >= 1) {
      const sellResults = shortEligibleResults.filter(
        r => r.signal === SIGNAL.SELL &&
          r.confidence >= this.minConfidence &&
          r.meetsFloor &&
          !r.suppressedByTime
      );
      const confidence = Math.round(
        sellResults.reduce((sum, r) => sum + r.confidence, 0) / sellResults.length
      );
      const reversalNames = this._groupContributors(shortEligibleResults, STRATEGY_GROUPS.REVERSAL, SIGNAL.SELL);
      const momentumNames = this._groupContributors(shortEligibleResults, STRATEGY_GROUPS.MOMENTUM, SIGNAL.SELL);
      return {
        signal: SIGNAL.SELL,
        confidence,
        isShortEntry: true,   // ← eligible to open a new short position
        reason: `SELL consensus (SHORT): ${reversalNames.map(n => `${n}(reversal)`).join(' + ')} + ${momentumNames.map(n => `${n}(momentum)`).join(' + ')} agree`,
      };
    }

    // ── RSI-only SELL: valid long exit, NOT a short entry ─────────────────
    // If the only SELL voters are SHORT_INELIGIBLE (e.g. RSI alone),
    // surface the SELL so a held long position can be closed, but flag
    // isShortEntry:false so the engine does NOT open a new short.
    if (groupVotes.reversal.sell >= 1 || groupVotes.momentum.sell >= 1) {
      const hasShortEligibleSell = shortEligibleResults.some(
        r => r.signal === SIGNAL.SELL && r.meetsFloor && !r.suppressedByTime
      );
      if (!hasShortEligibleSell) {
        const sellResults = results.filter(
          r => r.signal === SIGNAL.SELL &&
            r.confidence >= this.minConfidence &&
            r.meetsFloor &&
            !r.suppressedByTime
        );
        if (sellResults.length > 0) {
          const confidence = Math.round(
            sellResults.reduce((sum, r) => sum + r.confidence, 0) / sellResults.length
          );
          return {
            signal: SIGNAL.SELL,
            confidence,
            isShortEntry: false,   // ← exit long only, do NOT open short
            reason: 'SELL signal (EXIT LONG ONLY — RSI overbought, not eligible to open short)',
          };
        }
      }
    }

    // ── Super Conviction Bypass ───────────────────────────────────────────
    if (this.superConvictionEnabled) {
      const extremeResults = results.filter(
        r => r.confidence >= this.superConvictionThreshold &&
          r.meetsFloor &&
          !r.suppressedByTime &&
          r.signal !== SIGNAL.HOLD
      );

      if (extremeResults.length > 0) {
        const best = extremeResults.reduce((prev, cur) =>
          prev.confidence > cur.confidence ? prev : cur
        );

        // RSI cannot bypass into a short entry
        const isShortEntry = best.signal === SIGNAL.SELL &&
          !SHORT_INELIGIBLE_STRATEGIES.has(best.strategy);

        // ── HARDENED SHORT CONVICTION ──────────────────────────────────
        // For SELL (short), super conviction requires:
        //   1. Higher threshold (superConvictionThreshold + 10, e.g. 90%)
        //   2. At least 1 OTHER strategy also voting SELL (no single-strategy shorts)
        // A single strategy at 80% misfiring should NOT open a short.
        if (isShortEntry) {
          const shortConvictionThreshold = this.superConvictionThreshold + 10;
          const otherSellVoters = results.filter(
            r => r.signal === SIGNAL.SELL &&
              r.meetsFloor &&
              !r.suppressedByTime &&
              r.strategy !== best.strategy &&
              !SHORT_INELIGIBLE_STRATEGIES.has(r.strategy)
          );

          if (best.confidence < shortConvictionThreshold || otherSellVoters.length === 0) {
            log.info({
              symbol, strategy: best.strategy, confidence: best.confidence,
              threshold: shortConvictionThreshold, otherSellVoters: otherSellVoters.length,
            }, '🚫 Super Conviction SHORT blocked — need ≥' + shortConvictionThreshold +
               '% AND ≥1 other SELL voter');
            // Fall through to HOLD instead of opening a bad short
          } else {
            log.info({
              symbol, signal: best.signal, strategy: best.strategy,
              confidence: best.confidence, threshold: shortConvictionThreshold,
              supporters: otherSellVoters.map(r => r.strategy),
              isShortEntry,
            }, `⏩ Super Conviction SHORT: ${best.strategy} (${best.confidence}%) + ${otherSellVoters.length} supporter(s)`);

            return {
              signal: best.signal,
              confidence: best.confidence,
              convictionStrategy: best.strategy,
              isShortEntry,
              reason: `SUPER CONVICTION SHORT: ${best.strategy} ${best.confidence}% + ${otherSellVoters.map(r => r.strategy).join(', ')} supporting.`,
            };
          }
        } else {
          // BUY super conviction — unchanged, single strategy at ≥80% can open a long
          log.info({
            symbol, signal: best.signal, strategy: best.strategy,
            confidence: best.confidence, threshold: this.superConvictionThreshold,
            isShortEntry,
          }, `⏩ Super Conviction BYPASS: ${best.strategy} (${best.confidence}%) → ${best.signal}`);

          return {
            signal: best.signal,
            confidence: best.confidence,
            convictionStrategy: best.strategy,
            isShortEntry,
            reason: `SUPER CONVICTION BYPASS: ${best.strategy} reached ${best.confidence}% confidence. Cross-group consensus skipped.`,
          };
        }
      }
    }

    // ── No cross-group agreement ──────────────────────────────────────────
    return {
      signal: SIGNAL.HOLD,
      confidence: 0,
      isShortEntry: false,
      reason: `No cross-group consensus. ` +
        `Reversal — BUY:${groupVotes.reversal.buy} SELL:${groupVotes.reversal.sell} | ` +
        `Momentum — BUY:${groupVotes.momentum.buy} SELL:${groupVotes.momentum.sell}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // _simpleConsensus()
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Original "any N strategies agree" logic.
   * Used when groupedConsensus: false.
   */
  _simpleConsensus(results, votes) {
    if (votes.buy >= this.minAgreement && votes.buy > votes.sell) {
      const buyResults = results.filter(
        r => r.signal === SIGNAL.BUY &&
          r.confidence >= this.minConfidence &&
          r.meetsFloor !== false &&
          !r.suppressedByTime
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
        r => r.signal === SIGNAL.SELL &&
          r.confidence >= this.minConfidence &&
          r.meetsFloor !== false &&
          !r.suppressedByTime
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
      reason: `No consensus (need ${this.minAgreement}). ` +
        `Votes — BUY: ${votes.buy}, SELL: ${votes.sell}, HOLD: ${votes.hold}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // weightedConsensusWithWeights() — REMOVED (Fix Bug 17)
  // ─────────────────────────────────────────────────────────────────────────
  //
  // This method was a duplicate of AdaptiveWeightManager.weightedConsensusWithWeights().
  // The canonical implementation lives in src/intelligence/adaptive-weights.js.
  // EnhancedSignalPipeline should call AdaptiveWeightManager.weightedConsensusWithWeights()
  // directly. Having two implementations risked divergence.
  //

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fix C: isConflicted — any active disagreement (buy > 0 AND sell > 0).
   * Only counts signals that met floor and weren't time-suppressed.
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

  /** Get strategy names that voted for a given signal within a group. */
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

  _voteSummary(signals, weights) {
    return signals
      .filter(s => s.meetsFloor !== false && !s.suppressedByTime)
      .map(s => `${s.strategy}(${s.signal}×${(weights.get(s.strategy) ?? 1).toFixed(2)})`)
      .join(' | ');
  }
}