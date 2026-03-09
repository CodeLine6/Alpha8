/**
 * @fileoverview Enhanced Signal Pipeline for Alpha8
 *
 * Drop-in upgrade for the original SignalConsensus. Adds 4 gates that each
 * block a different class of bad trade:
 *
 *   Gate 1 — Adaptive Weighted Consensus
 *             Strategies that have been accurate recently get more trust.
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
 *   In execution-engine.js, call pipeline.process(symbol, consensusDetails)
 *   instead of using the consensus signal directly.
 *   See execution-engine.js for the full integration.
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
            ? new AdaptiveWeightManager({ redis, logger: logFn })
            : null;

        this.newsSentiment = newsEnabled && geminiApiKey
            ? new NewsSentimentFilter({ redis, geminiApiKey, logger: logFn })
            : null;

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
     * @param {string}  symbol
     * @param {Array}   strategySignals  - details array from SignalConsensus.evaluate()
     *                                    Each: { signal, confidence, strategy, reason }
     * @returns {Promise<PipelineResult>}
     */
    async process(symbol, strategySignals) {
        const gateLog = [];
        let positionSizeMult = 1.0;

        // ── Gate 1: Adaptive Weighted Consensus ────────────────────────────────
        let finalSignal;
        if (this.adaptiveWeights) {
            finalSignal = await this.adaptiveWeights.weightedConsensus(strategySignals);
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
            const r = await this.trendFilter.check(symbol, finalSignal.signal);
            gateLog.push(r.allowed ? `✅ Trend: ${r.reason}` : `❌ Trend: ${r.reason}`);
            if (!r.allowed) return this._blocked('TREND_FILTER', gateLog, positionSizeMult);
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
     * Record a trade outcome for adaptive weight training.
     * Call this when a position closes (from execution-engine.js).
     *
     * @param {string} strategy  - strategy name
     * @param {string} signal    - 'BUY'|'SELL'
     * @param {string} symbol
     * @param {number} pnl
     */
    async recordTradeOutcome(strategy, signal, symbol, pnl) {
        if (!this.adaptiveWeights) return;
        const outcome = pnl > 0 ? 'WIN' : 'LOSS';
        await this.adaptiveWeights.recordOutcome({ strategy, signal, symbol, outcome, pnl });
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