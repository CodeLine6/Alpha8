/**
 * @fileoverview Shadow Signal Recorder for Quant8
 *
 * PROBLEM SOLVED:
 *   Adaptive weights only train on trades that passed consensus (Gate 1).
 *   A strategy that fires solo — RSI BUY at 93% with no confirmation —
 *   is never evaluated because no trade executes. Over time, strategies that
 *   happen to cluster together dominate the weights while contrarian strategies
 *   are starved of feedback.
 *
 * SOLUTION:
 *   Record every individual strategy signal BEFORE Gate 1, then asynchronously
 *   check the price 15/30/60 minutes later to determine if the signal was correct.
 *   Adaptive weights should eventually read from shadow_signals instead of
 *   signal_outcomes to get unbiased accuracy data.
 *
 * USAGE:
 *   // In processSignal(), fire-and-forget after consensus.evaluate():
 *   shadowRecorder.recordSignals(
 *     symbol, consensusResult.details, consensusResult, acted, currentPrice, regime
 *   ).catch(err => log.warn(err));
 *
 *   // Background job every 30min during market hours:
 *   await shadowRecorder.fillPriceOutcomes();
 *
 *   // Adaptive weights reads:
 *   const accuracy = await shadowRecorder.getStrategyAccuracy('EMA_CROSSOVER', 14);
 *
 * @module shadow-recorder
 */

import { createLogger } from '../lib/logger.js';
import { query } from '../lib/db.js';

const log = createLogger('shadow-recorder');

// Minimum sample size before accuracy is considered meaningful
const MIN_SAMPLE_SIZE = 10;

// Strategy names must match exactly what strategies emit in their signal.strategy field
const VALID_STRATEGIES = new Set([
    'EMA_CROSSOVER',
    'RSI_MEAN_REVERSION',
    'VWAP_MOMENTUM',
    'BREAKOUT_VOLUME',
]);

export class ShadowRecorder {
    /**
     * @param {Object} opts
     * @param {Object} [opts.broker] - BrokerManager with getLTP() for price lookups
     */
    constructor({ broker = null } = {}) {
        this.broker = broker;
    }

    /**
     * Record every non-HOLD individual strategy signal for a scan cycle.
     * Called fire-and-forget — must never throw or block the signal loop.
     *
     * @param {string} symbol
     * @param {Array}  strategySignals - consensusResult.details:
     *                   [{ strategy, signal, confidence, reason }]
     * @param {Object} consensusResult - consensusResult from SignalConsensus.evaluate()
     *                   { signal, confidence, reason, details }
     * @param {boolean} actedOn        - did an order actually FILL this scan?
     * @param {number}  currentPrice   - market price at signal time (REQUIRED — skip if 0)
     * @param {string|null} regime     - TRENDING / SIDEWAYS / VOLATILE / UNKNOWN / null
     * @returns {Promise<void>}
     */
    async recordSignals(symbol, strategySignals, consensusResult, actedOn, currentPrice, regime) {
        try {
            if (!currentPrice || currentPrice <= 0) {
                log.warn({ symbol }, 'Shadow signal skipped — currentPrice is zero or missing');
                return;
            }

            if (!Array.isArray(strategySignals) || strategySignals.length === 0) {
                return;
            }

            // Filter to only actionable (non-HOLD) signals from known strategies
            const toRecord = strategySignals.filter(s =>
                s.signal !== 'HOLD' &&
                VALID_STRATEGIES.has(s.strategy) &&
                s.confidence > 0
            );

            if (toRecord.length === 0) return;

            const consensusReached = consensusResult?.signal === 'BUY' || consensusResult?.signal === 'SELL';

            // Batch INSERT — single round-trip regardless of how many strategies fired
            const values = [];
            const params = [];
            let paramIdx = 1;

            for (const sig of toRecord) {
                values.push(
                    `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
                    `$${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
                );
                params.push(
                    symbol,
                    sig.strategy,
                    sig.signal,           // 'BUY' or 'SELL'
                    sig.confidence,
                    currentPrice,
                    consensusReached,
                    actedOn,
                );
                // regime is optional — only available mid-scan, not on early HOLD returns
                if (regime !== undefined && regime !== null) {
                    values[values.length - 1] = values[values.length - 1].replace(
                        /\)$/,
                        `, $${paramIdx++})`
                    );
                    params.push(regime);
                }
            }

            // Regime column handling — simplest approach: always include it (NULL if absent)
            // Rebuild with explicit regime column for clean SQL
            await this._batchInsert(symbol, toRecord, currentPrice, consensusReached, actedOn, regime);

            log.debug({
                symbol,
                count: toRecord.length,
                consensus: consensusReached,
                actedOn,
                regime: regime || 'null',
            }, `Shadow signals recorded for ${symbol}`);
        } catch (err) {
            log.error({ symbol, err: err.message }, 'Shadow signal recording failed');
        }
    }

    /**
     * Background job — fill in price-after columns for shadow signals old enough
     * to have meaningful price movement data.
     *
     * Called every 30 minutes during market hours, and once at 16:00 IST for EOD.
     * Fetches LTP for unique symbols in batches of 50 to avoid broker rate limits.
     *
     * @returns {Promise<{ updated: number, symbols: string[] }>}
     */
    async fillPriceOutcomes() {
        if (!this.broker) {
            log.debug('fillPriceOutcomes skipped — no broker configured');
            return { updated: 0, symbols: [] };
        }

        try {
            // Find all rows that still have NULL price columns and are old enough
            // to have a meaningful reading. Each window is checked independently.
            const pendingResult = await query(`
        SELECT
          id,
          symbol,
          direction,
          price_at_signal,
          created_at,
          price_after_15min IS NULL AND created_at < NOW() - INTERVAL '15 minutes' AS needs_15min,
          price_after_30min IS NULL AND created_at < NOW() - INTERVAL '30 minutes' AS needs_30min,
          price_after_60min IS NULL AND created_at < NOW() - INTERVAL '60 minutes' AS needs_60min,
          price_eod IS NULL
            AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND (NOW() AT TIME ZONE 'Asia/Kolkata')::time >= '15:30:00'::time
            AS needs_eod
        FROM shadow_signals
        WHERE
          (price_after_15min IS NULL AND created_at < NOW() - INTERVAL '15 minutes')
          OR (price_after_30min IS NULL AND created_at < NOW() - INTERVAL '30 minutes')
          OR (price_after_60min IS NULL AND created_at < NOW() - INTERVAL '60 minutes')
          OR (
            price_eod IS NULL
            AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND (NOW() AT TIME ZONE 'Asia/Kolkata')::time >= '15:30:00'::time
          )
        ORDER BY created_at ASC
        LIMIT 500
      `);

            if (pendingResult.rows.length === 0) {
                log.debug('fillPriceOutcomes — no pending rows');
                return { updated: 0, symbols: [] };
            }

            // Get unique symbols, batch into groups of 50
            const uniqueSymbols = [...new Set(pendingResult.rows.map(r => r.symbol))];
            const priceMap = await this._fetchPricesBatched(uniqueSymbols, 50);

            if (Object.keys(priceMap).length === 0) {
                log.warn('fillPriceOutcomes — no prices fetched from broker');
                return { updated: 0, symbols: [] };
            }

            let updated = 0;
            const updatedSymbols = new Set();

            for (const row of pendingResult.rows) {
                const currentPrice = priceMap[row.symbol];
                if (!currentPrice || currentPrice <= 0) continue;

                const setClauses = [];
                const values = [row.id];
                let paramIdx = 2;

                const updateWithCorrectness = (priceCol, correctCol, needed) => {
                    if (!needed) return;
                    setClauses.push(`${priceCol} = $${paramIdx++}`);
                    values.push(currentPrice);

                    const isCorrect = row.direction === 'BUY'
                        ? currentPrice > parseFloat(row.price_at_signal)
                        : currentPrice < parseFloat(row.price_at_signal);
                    setClauses.push(`${correctCol} = $${paramIdx++}`);
                    values.push(isCorrect);
                };

                updateWithCorrectness('price_after_15min', 'was_correct_15min', row.needs_15min);
                updateWithCorrectness('price_after_30min', 'was_correct_30min', row.needs_30min);
                updateWithCorrectness('price_after_60min', 'was_correct_60min', row.needs_60min);

                if (row.needs_eod) {
                    setClauses.push(`price_eod = $${paramIdx++}`);
                    values.push(currentPrice);
                }

                if (setClauses.length === 0) continue;

                try {
                    await query(
                        `UPDATE shadow_signals SET ${setClauses.join(', ')} WHERE id = $1`,
                        values
                    );
                    updated++;
                    updatedSymbols.add(row.symbol);
                } catch (err) {
                    log.warn({ id: row.id, symbol: row.symbol, err: err.message },
                        'Failed to update shadow signal price outcome');
                }
            }

            log.info({
                pending: pendingResult.rows.length,
                updated,
                symbols: [...updatedSymbols],
            }, `fillPriceOutcomes complete — ${updated} rows updated`);

            return { updated, symbols: [...updatedSymbols] };
        } catch (err) {
            log.error({ err: err.message }, 'fillPriceOutcomes failed');
            return { updated: 0, symbols: [] };
        }
    }

    /**
     * Get unbiased accuracy stats for a strategy from shadow signals.
     * Use this instead of signal_outcomes for adaptive weight calculation
     * once enough shadow data has accumulated.
     *
     * @param {string} strategy - one of the VALID_STRATEGIES values
     * @param {number} [days=14] - lookback window in days
     * @returns {Promise<Object>}
     */
    async getStrategyAccuracy(strategy, days = 14) {
        try {
            const result = await query(`
        SELECT
          COUNT(*)                                                        AS total_signals,
          COUNT(*) FILTER (WHERE was_correct_30min IS NOT NULL)           AS evaluated,
          COUNT(*) FILTER (WHERE was_correct_30min = true)                AS correct_30min,
          COUNT(*) FILTER (WHERE consensus_reached = true)                AS consensus_count,
          COUNT(*) FILTER (WHERE acted_on = true)                         AS acted_on_count,
          COUNT(*) FILTER (WHERE was_correct_30min IS NOT NULL
                             AND consensus_reached = false)               AS solo_evaluated,
          COUNT(*) FILTER (WHERE was_correct_30min = true
                             AND consensus_reached = false)               AS solo_correct
        FROM shadow_signals
        WHERE strategy = $1
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
      `, [strategy, days]);

            const row = result.rows[0];
            const totalSignals = parseInt(row.total_signals, 10);
            const evaluated = parseInt(row.evaluated, 10);
            const correctCount = parseInt(row.correct_30min, 10);
            const soloEvaluated = parseInt(row.solo_evaluated, 10);
            const soloCorrect = parseInt(row.solo_correct, 10);

            if (evaluated < MIN_SAMPLE_SIZE) {
                return {
                    strategy,
                    days,
                    totalSignals,
                    evaluated,
                    sampleSize: evaluated,
                    insufficient: true,
                    minRequired: MIN_SAMPLE_SIZE,
                };
            }

            return {
                strategy,
                days,
                totalSignals,
                evaluated,
                sampleSize: evaluated,
                insufficient: false,
                // Overall accuracy (includes signals that reached consensus)
                accuracy30min: Math.round((correctCount / evaluated) * 100),
                correctCount,
                // How often this strategy reached consensus
                consensusRate: Math.round((parseInt(row.consensus_count, 10) / totalSignals) * 100),
                // How often a consensus trade was actually executed (gates 2-6 pass rate)
                actedOnRate: parseInt(row.consensus_count, 10) > 0
                    ? Math.round((parseInt(row.acted_on_count, 10) / parseInt(row.consensus_count, 10)) * 100)
                    : 0,
                // Accuracy when strategy fired SOLO (no consensus) — the key unbiased metric
                soloAccuracy30min: soloEvaluated >= MIN_SAMPLE_SIZE
                    ? Math.round((soloCorrect / soloEvaluated) * 100)
                    : null,
                soloEvaluated,
            };
        } catch (err) {
            log.error({ strategy, err: err.message }, 'getStrategyAccuracy failed');
            return { strategy, days, insufficient: true, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════
    // PRIVATE
    // ═══════════════════════════════════════════════════════

    /** @private */
    async _batchInsert(symbol, signals, currentPrice, consensusReached, actedOn, regime) {
        if (signals.length === 0) return;

        // Build parameterised batch INSERT
        const rowPlaceholders = [];
        const params = [];
        let p = 1;

        for (const sig of signals) {
            rowPlaceholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
            params.push(
                symbol,
                sig.strategy,
                sig.signal,
                sig.confidence,
                currentPrice,
                consensusReached,
                actedOn,
            );
        }

        // regime is the same for all signals in a scan cycle — update after INSERT
        await query(
            `INSERT INTO shadow_signals
         (symbol, strategy, direction, confidence, price_at_signal, consensus_reached, acted_on)
       VALUES ${rowPlaceholders.join(', ')}`,
            params
        );

        // Set regime in a single UPDATE if we have it — avoids inflating the INSERT params
        if (regime) {
            await query(`
        UPDATE shadow_signals
        SET regime = $1
        WHERE symbol = $2
          AND created_at >= NOW() - INTERVAL '30 seconds'
          AND regime IS NULL
      `, [regime, symbol]);
        }
    }

    /**
     * Fetch current prices for multiple symbols in batches.
     * Avoids overwhelming the broker API on large watchlists.
     * @private
     */
    async _fetchPricesBatched(symbols, batchSize) {
        const priceMap = {};

        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            try {
                const ltpKeys = batch.map(s => `NSE:${s}`);
                const ltpResult = await this.broker.getLTP(ltpKeys);

                for (const symbol of batch) {
                    const price = ltpResult?.[`NSE:${symbol}`]?.last_price;
                    if (price && price > 0) {
                        priceMap[symbol] = price;
                    }
                }
            } catch (err) {
                log.warn({ batch, err: err.message }, 'Price batch fetch failed — skipping batch');
            }
        }

        return priceMap;
    }
}