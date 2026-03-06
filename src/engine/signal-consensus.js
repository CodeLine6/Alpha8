import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('signal-consensus');

/**
 * Signal Consensus Layer.
 *
 * Runs multiple strategies against the same candles and requires
 * a minimum number of strategies to agree before generating a
 * final actionable signal.
 *
 * Requirement #6: "minimum 2 strategies must agree"
 *
 * @module signal-consensus
 */

export class SignalConsensus {
  /**
   * @param {Object} [config]
   * @param {number} [config.minAgreement=2] - Min strategies that must agree for signal
   * @param {number} [config.minConfidence=40] - Min individual confidence to count
   */
  constructor(config = {}) {
    this.minAgreement = config.minAgreement ?? 2;
    this.minConfidence = config.minConfidence ?? 40;

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
        details: [],
      };
    }

    const results = [];
    const votes = { buy: 0, sell: 0, hold: 0 };

    for (const strategy of this.strategies) {
      try {
        const result = strategy.analyze(candles);
        results.push(result);

        // Only count votes from signals above confidence threshold
        if (result.confidence >= this.minConfidence) {
          if (result.signal === SIGNAL.BUY) votes.buy++;
          else if (result.signal === SIGNAL.SELL) votes.sell++;
          else votes.hold++;
        } else {
          votes.hold++; // Low-confidence signals count as HOLD
        }
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
      }
    }

    // ─── Determine Consensus ─────────────────────────────
    let finalSignal = SIGNAL.HOLD;
    let finalConfidence = 0;
    let reason = '';

    if (votes.buy >= this.minAgreement && votes.buy > votes.sell) {
      finalSignal = SIGNAL.BUY;
      const buyResults = results.filter(
        (r) => r.signal === SIGNAL.BUY && r.confidence >= this.minConfidence
      );
      finalConfidence = Math.round(
        buyResults.reduce((sum, r) => sum + r.confidence, 0) / buyResults.length
      );
      reason = `BUY consensus: ${votes.buy}/${this.strategies.length} strategies agree`;
    } else if (votes.sell >= this.minAgreement && votes.sell > votes.buy) {
      finalSignal = SIGNAL.SELL;
      const sellResults = results.filter(
        (r) => r.signal === SIGNAL.SELL && r.confidence >= this.minConfidence
      );
      finalConfidence = Math.round(
        sellResults.reduce((sum, r) => sum + r.confidence, 0) / sellResults.length
      );
      reason = `SELL consensus: ${votes.sell}/${this.strategies.length} strategies agree`;
    } else {
      reason =
        `No consensus (need ${this.minAgreement}). ` +
        `Votes — BUY: ${votes.buy}, SELL: ${votes.sell}, HOLD: ${votes.hold}`;
    }

    log.info({
      signal: finalSignal,
      confidence: finalConfidence,
      votes,
      strategiesRun: this.strategies.length,
    }, reason);

    return {
      signal: finalSignal,
      confidence: finalConfidence,
      reason,
      votes,
      details: results,
    };
  }
}
