/**
 * @fileoverview Enhanced Signal Pipeline for Alpha8
 *
 * CHANGES (Tier 1 — Task 3):
 *   - Exported REGIME_THRESHOLDS constant (TRENDING/SIDEWAYS/VOLATILE/UNKNOWN → threshold)
 *   - process() accepts optional `regime` parameter passed from execution-engine.js.
 *     The regime is fetched once per scan cycle in execution-engine, passed here, then
 *     looked up in REGIME_THRESHOLDS to set the weightedConsensus threshold.
 *     This avoids double-detection and keeps separation of concerns clean.
 *
 * Drop-in upgrade for the original SignalConsensus. Adds 4 gates that each
 * block a different class of bad trade:
 *
 *   Gate 1 — Adaptive Weighted Consensus
 *             Strategies that have been accurate recently get more trust.
 *             Threshold is now regime-adaptive (see REGIME_THRESHOLDS).
 *
 *   Gate 2 — Trend Filter (SMA20 + SMA50)
 *             Only BUY when the stock is actually going up in the big picture.
 *
 *   Gate 3 — Regime Detector (ATR + ADX on Nifty 50)
 *             VOLATILE market → pause all trading.
 *             SIDEWAYS market → reduce position size 50%.
 *
 *   Gate 4 — News Sentiment (Gemini API + Google News RSS)
 *             Block BUYs when recent headlines are strongly negative.
 *
 * INTEGRATION:
 *   In execution-engine.js, call pipeline.process(symbol, consensusDetails, regime)
 *   instead of using the consensus signal directly.
 *
 * ALL GATES FAIL-OPEN:
 *   If a gate errors or has no data, it allows the signal through.
 *   The risk manager (unchanged) is the hard safety net.
 */

import { createLogger } from '../lib/logger.js';
import { TrendFilter } from '../filters/trend-filter.js';
import { RegimeDetector } from '../filters/regime-detector.js';
import { AdaptiveWeightManager } from './adaptive-weights.js';
import { NewsSentimentFilter } from './news-sentiment.js';

const log = createLogger('enhanced-pipeline');

/**
 * Consensus threshold by market regime.
 *
 * TRENDING  → 1.8  Lower bar — strong directional conviction, capture moves early.
 * SIDEWAYS  → 2.0  Default — unchanged from original implementation.
 * VOLATILE  → 2.5  Higher bar — noisy signals, reduce false positives.
 * UNKNOWN   → 2.0  Default — no regime data available.
 *
 * These values are passed into AdaptiveWeightManager.weightedConsensus() as the
 * `threshold` argument. A signal's combined weight must exceed this number to trade.
 *
 * @type {Record<string, number>}
 */
export const REGIME_THRESHOLDS = {
    TRENDING: 1.8,
    SIDEWAYS: 2.0,
    VOLATILE: 2.5,
    UNKNOWN: 2.0,
};

/**
 * @typedef {object} PipelineResult
 * @property {boolean}     allowed          - true if all gates passed
 * @property {object|null} signal           - winning signal (with adjusted confidence)
 * @property {number}      positionSizeMult - 1.0 normal, 0.5 sideways
 * @property {string[]}    log              - per-gate decision log (for Telegram/dashboard)
 * @property {string|null} blockedBy        - which gate blocked (if any)
 */

export class EnhancedSignalPipeline {
    /**
     * @param {object} opts
     * @param {object}   opts.redis
     * @param {object}   [opts.broker]           - BrokerManager (for trend filter)
     * @param {object}   [opts.instrumentManager] - For token lookup in trend filter
     * @param {string}   [opts.geminiApiKey]      - For news sentiment
     * @param {boolean}  [opts.trendEnabled=true]
     * @param {boolean}  [opts.regimeEnabled=true]
     * @param {boolean}  [opts.adaptiveEnabled=true]
     * @param {boolean}  [opts.newsEnabled=true]
     * @param {Function} [opts.logger]
     * @param {import('../intelligence/intraday-decay.js').IntradayDecayManager} [opts.intradayDecay]
     */
    constructor({
        redis,
        broker = null,
        instrumentManager = null,
        geminiApiKey = null,
        trendEnabled = true,
        regimeEnabled = true,
        adaptiveEnabled = true,
        newsEnabled = true,
        intradayDecay = null,
        logger,
    }) {
        const logFn = logger || ((msg, meta) => log.info(meta || {}, msg));

        this.trendFilter = trendEnabled
            ? new TrendFilter({ redis, broker, instrumentManager, logger: logFn })
            : null;

        this.regimeDetector = regimeEnabled
            ? new RegimeDetector({ redis, logger: logFn })
            : null;

        this.adaptiveWeights = adaptiveEnabled
            ? new AdaptiveWeightManager({ redis, intradayDecay, logger: logFn })
            : null;

        this.newsSentiment = newsEnabled && geminiApiKey
            ? new NewsSentimentFilter({ redis, geminiApiKey, logger: logFn })
            : null;

        this.intradayDecay = intradayDecay || null;

        this._logger = logFn;

        logFn(`[Pipeline] Initialized — trend=${trendEnabled} regime=${regimeEnabled} adaptive=${adaptiveEnabled} news=${!!geminiApiKey}`);
    }

    /**
     * Pre-market warm-up (9:00 AM IST).
     * Pre-fetches trend data so the first scan doesn't have cold-cache latency.
     *
     * @param {string[]} watchlist        - symbols to warm up
     * @param {Array}    niftyDailyCandles - for regime detector (can be [])
     */
    async warmUp(watchlist, niftyDailyCandles = []) {
        this._logger('[Pipeline] Pre-market warm-up starting...');
        const tasks = [];

        if (this.trendFilter && watchlist.length > 0) {
            tasks.push(this.trendFilter.warmUp(watchlist));
        }

        if (this.regimeDetector && niftyDailyCandles.length > 0) {
            tasks.push(this.regimeDetector.update(niftyDailyCandles));
        }

        await Promise.allSettled(tasks);
        this._logger('[Pipeline] Pre-market warm-up complete');
    }

    /**
     * Main pipeline function — runs a signal through all 4 gates.
     *
     * @param {string}       symbol
     * @param {Array}        strategySignals  - details array from SignalConsensus.evaluate()
     *                                         Each: { signal, confidence, strategy, reason }
     * @param {string|null}  [regime=null]    - current market regime from execution-engine.js.
     *                                         One of: 'TRENDING'|'SIDEWAYS'|'VOLATILE'|'UNKNOWN'.
     *                                         Fetched ONCE per scan cycle in execution-engine.js
     *                                         and passed here to avoid double-detection.
     *                                         Falls back to default threshold (2.0) if null.
     * @param {boolean}      [isConvictionBypass=false] - If true, skips Gate 1 (Weighted Consensus).
     * @returns {Promise<PipelineResult>}
     */
    async process(symbol, strategySignals, regime = null, isConvictionBypass = false) {
        const gateLog = [];
        let positionSizeMult = 1.0;

        // ── Gate 1: Adaptive Weighted Consensus ────────────────────────────────
        // Regime-adaptive threshold: TRENDING=1.8 | SIDEWAYS=2.0 | VOLATILE=2.5
        // The regime is detected once per scan cycle in execution-engine.js,
        // passed here as a parameter to keep detection logic in one place.
        const threshold = REGIME_THRESHOLDS[regime] ?? 2.0;
        log.debug({ regime, threshold, isConvictionBypass }, 'Gate 1 threshold resolved');

        let finalSignal;

        if (isConvictionBypass) {
            // Feature 10: Super Conviction Bypass
            // If the consensus layer flagged this as an extreme conviction signal,
            // we bypass the weighted consensus requirement but still run Trend/Regime/News.
            finalSignal = strategySignals.find(s => s.confidence >= 80 && s.signal !== 'HOLD');
            if (finalSignal) {
                gateLog.push(`⏩ Super Conviction Bypass: ${finalSignal.strategy} (${finalSignal.confidence}%)`);
            } else {
                // Should not happen if flag is true, but safety first
                gateLog.push('❌ Conviction bypass requested but no high-confidence signal found');
                return this._blocked('CONSENSUS', gateLog, positionSizeMult);
            }
        } else if (this.adaptiveWeights) {
            // Feature 7: Fetch base weights, apply intraday decay multipliers (if available),
            // then call weightedConsensusWithWeights() to skip the redundant Redis fetch.
            // On any failure, falls back to the original weightedConsensus() call.
            try {
                const baseWeights = await this.adaptiveWeights.getWeights();
                const effectiveWeights = this.intradayDecay
                    ? await this.intradayDecay.applyDecay(baseWeights)
                    : baseWeights;
                finalSignal = this.adaptiveWeights.weightedConsensusWithWeights(
                    strategySignals, effectiveWeights, threshold
                );
            } catch (err) {
                log.warn({ err: err.message }, 'Intraday decay failed — falling back to standard weighted consensus');
                finalSignal = await this.adaptiveWeights.weightedConsensus(strategySignals, threshold);
            }
            if (finalSignal) {
                gateLog.push(`✅ Weighted consensus: ${finalSignal.signal} (score=${finalSignal.weightedScore})`);
            } else {
                gateLog.push('❌ No weighted consensus — insufficient agreement');
                return this._blocked('CONSENSUS', gateLog, positionSizeMult);
            }
        } else {
            finalSignal = this._simpleConsensus(strategySignals);
            if (!finalSignal) {
                gateLog.push('❌ No simple consensus');
                return this._blocked('CONSENSUS', gateLog, positionSizeMult);
            }
            gateLog.push(`✅ Simple consensus: ${finalSignal.signal}`);
        }

        // ── Gate 2: Trend Filter ────────────────────────────────────────────────
        if (this.trendFilter) {
            if (isConvictionBypass) {
                gateLog.push('⏩ Trend Filter: Bypassed via Super Conviction');
            } else {
                const r = await this.trendFilter.check(symbol, finalSignal.signal);
                gateLog.push(r.allowed ? `✅ Trend: ${r.reason}` : `❌ Trend: ${r.reason}`);
                if (!r.allowed) return this._blocked('TREND_FILTER', gateLog, positionSizeMult);
            }
        }

        // ── Gate 3: Regime Detector ─────────────────────────────────────────────
        if (this.regimeDetector) {
            const r = await this.regimeDetector.check();
            gateLog.push(r.allowed ? `✅ Regime: ${r.reason}` : `❌ Regime: ${r.reason}`);
            if (!r.allowed) return this._blocked('REGIME', gateLog, positionSizeMult);

            positionSizeMult = r.sizeMultiplier;
            if (positionSizeMult < 1.0) {
                gateLog.push(`⚠️  Position size → ${positionSizeMult * 100}% (sideways market)`);
            }
        }

        // ── Gate 4: News Sentiment ──────────────────────────────────────────────
        if (this.newsSentiment) {
            const r = await this.newsSentiment.check(symbol, finalSignal.signal);
            gateLog.push(r.allowed ? `✅ News: ${r.reason}` : `❌ News: ${r.reason}`);
            if (!r.allowed) return this._blocked('NEWS_SENTIMENT', gateLog, positionSizeMult);

            if (r.confidenceBoost > 0) {
                finalSignal = {
                    ...finalSignal,
                    confidence: Math.min(100, finalSignal.confidence + r.confidenceBoost),
                    reason: `${finalSignal.reason} [+${r.confidenceBoost} news boost]`,
                };
            }
        }

        gateLog.push('🟢 All gates passed');
        return { allowed: true, signal: finalSignal, positionSizeMult, log: gateLog, blockedBy: null };
    }


    /**
     * Weekly maintenance — update strategy weights.
     * Called every Sunday after market close.
     */
    async weeklyMaintenance() {
        if (!this.adaptiveWeights) return;
        this._logger('[Pipeline] Running weekly adaptive weight update...');
        await this.adaptiveWeights.weeklyUpdate();
    }

    /**
     * Update the regime from fresh Nifty 50 candles.
     * Called every 30 minutes during trading day by the scheduler.
     * @param {Array} niftyCandles
     */
    async updateRegime(niftyCandles) {
        if (this.regimeDetector) {
            await this.regimeDetector.update(niftyCandles);
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _blocked(gate, gateLog, positionSizeMult) {
        return { allowed: false, signal: null, positionSizeMult, log: gateLog, blockedBy: gate };
    }

    _simpleConsensus(signals, minAgree = 2) {
        if (!signals || signals.length === 0) return null;
        const buys = signals.filter(s => s.signal === 'BUY');
        const sells = signals.filter(s => s.signal === 'SELL');
        if (buys.length >= minAgree) return buys.reduce((m, s) => s.confidence > m.confidence ? s : m, buys[0]);
        if (sells.length >= minAgree) return sells.reduce((m, s) => s.confidence > m.confidence ? s : m, sells[0]);
        return null;
    }
}