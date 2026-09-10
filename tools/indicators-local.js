// tools/indicators-local.js — RSI/Bollinger/Supertrend/Fibonacci computed
// locally from real OHLCV candles (tools/gecko.js), as the "gecko" option
// for config.indicators.dataSource. Standard, auditable TA formulas — no
// dependency on a third party's precomputed values, the way the "meridian"
// data source's agent-meridian backend works.
//
// getLocalChartIndicators() below returns the SAME nested payload shape
// tools/chart-indicators.js's fetchChartIndicatorsForMint() returns from
// the agent-meridian backend ({ latest: { candle, previousCandle, rsi,
// bollinger, supertrend, states, fibonacci } }) — deliberately, so that
// buildSignalSummary/evaluatePreset in chart-indicators.js, and every
// downstream caller (stoploss-rsi-guard.js's payload?.latest?.rsi?.value,
// tools/screening.js's confirmIndicatorPreset), work identically no matter
// which data source is selected. Only chart-indicators.js's two exported
// functions know a dispatch even happened.

import { config } from "../config.js";
import { fetchOhlcv, fetchOhlcvForToken, normalizeInterval } from "./gecko.js";

// ─── RSI (Wilder's smoothing) ────────────────────────────────────────────────

/** RSI at every bar from index `period` onward. closes.length must be > period. */
export function computeRSI(closes, period) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d >= 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ─── Bollinger Bands ─────────────────────────────────────────────────────────

export function computeBollinger(closes, period, mult) {
  const n = closes.length;
  const upper = new Array(n).fill(null), middle = new Array(n).fill(null), lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += closes[k];
    const mean = sum / period;
    let variance = 0;
    for (let k = i - period + 1; k <= i; k++) variance += (closes[k] - mean) ** 2;
    const stdDev = Math.sqrt(variance / period); // population std dev
    middle[i] = mean;
    upper[i] = mean + mult * stdDev;
    lower[i] = mean - mult * stdDev;
  }
  return { upper, middle, lower };
}

// ─── ATR (Wilder's smoothing) — feeds Supertrend ─────────────────────────────

export function computeATR(highs, lows, closes, period) {
  const n = closes.length;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const atr = new Array(n).fill(null);
  if (n <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// ─── Supertrend ──────────────────────────────────────────────────────────────

/** Returns { value[], direction[] } — direction is "bullish" | "bearish" | null. */
export function computeSupertrend(highs, lows, closes, period, mult) {
  const n = closes.length;
  const atr = computeATR(highs, lows, closes, period);
  const finalUpper = new Array(n).fill(null), finalLower = new Array(n).fill(null);
  const value = new Array(n).fill(null), direction = new Array(n).fill(null);
  const start = period + 1; // first index with a valid ATR AND a prior close
  if (start >= n) return { value, direction };

  for (let i = start; i < n; i++) {
    const mid = (highs[i] + lows[i]) / 2;
    const basicUpper = mid + mult * atr[i];
    const basicLower = mid - mult * atr[i];

    if (i === start) {
      finalUpper[i] = basicUpper;
      finalLower[i] = basicLower;
      // Seed direction from where price sits relative to the bands — no prior bar to compare against.
      direction[i] = closes[i] <= basicUpper ? "bearish" : "bullish";
      value[i] = direction[i] === "bearish" ? finalUpper[i] : finalLower[i];
      continue;
    }

    finalUpper[i] = (basicUpper < finalUpper[i - 1] || closes[i - 1] > finalUpper[i - 1]) ? basicUpper : finalUpper[i - 1];
    finalLower[i] = (basicLower > finalLower[i - 1] || closes[i - 1] < finalLower[i - 1]) ? basicLower : finalLower[i - 1];

    const prevWasUpper = value[i - 1] === finalUpper[i - 1];
    if (prevWasUpper) {
      direction[i] = closes[i] <= finalUpper[i] ? "bearish" : "bullish";
    } else {
      direction[i] = closes[i] >= finalLower[i] ? "bullish" : "bearish";
    }
    value[i] = direction[i] === "bearish" ? finalUpper[i] : finalLower[i];
  }
  return { value, direction };
}

// ─── Fibonacci retracement ───────────────────────────────────────────────────

/** Levels between the swing high/low of the given candle window. */
export function computeFibonacci(highs, lows, lookback) {
  const n = highs.length;
  const start = Math.max(0, n - lookback);
  let swingHigh = -Infinity, swingLow = Infinity;
  for (let i = start; i < n; i++) {
    if (highs[i] > swingHigh) swingHigh = highs[i];
    if (lows[i] < swingLow) swingLow = lows[i];
  }
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow) || swingHigh <= swingLow) return {};
  const range = swingHigh - swingLow;
  const levels = {};
  for (const f of [0.236, 0.382, 0.5, 0.618, 0.786]) {
    levels[f.toFixed(3)] = swingLow + f * range;
  }
  return { swingHigh, swingLow, levels };
}

/**
 * Compute all indicators for a candle series and shape the result exactly
 * like agent-meridian's `/chart-indicators/{mint}` response's `.latest`
 * field (candle/previousCandle/rsi.value/bollinger/supertrend/states/
 * fibonacci.levels) — see this file's header comment for why that shape is
 * load-bearing, not incidental.
 */
function buildLatestPayload(candles, { rsiPeriod, bbPeriod, bbMult, stPeriod, stMult, fibLookback }) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const n = closes.length;
  const last = n - 1, prev = n - 2;

  const rsiArr = computeRSI(closes, rsiPeriod);
  const bb = computeBollinger(closes, bbPeriod, bbMult);
  const st = computeSupertrend(highs, lows, closes, stPeriod, stMult);
  const fib = computeFibonacci(highs, lows, fibLookback);

  const supertrendDirection = st.direction[last] ?? "unknown";
  const prevDirection = prev >= 0 ? st.direction[prev] : null;
  const supertrendBreakUp = prevDirection === "bearish" && supertrendDirection === "bullish";
  const supertrendBreakDown = prevDirection === "bullish" && supertrendDirection === "bearish";

  return {
    candle: { close: closes[last] ?? null },
    previousCandle: { close: prev >= 0 ? closes[prev] : null },
    rsi: { value: rsiArr[last] ?? null },
    bollinger: { lower: bb.lower[last] ?? null, middle: bb.middle[last] ?? null, upper: bb.upper[last] ?? null },
    supertrend: { value: st.value[last] ?? null, direction: supertrendDirection },
    states: { supertrendBreakUp, supertrendBreakDown },
    fibonacci: {
      levels: {
        "0.500": fib.levels?.["0.500"] ?? null,
        "0.618": fib.levels?.["0.618"] ?? null,
        "0.786": fib.levels?.["0.786"] ?? null,
      },
    },
    candleCount: n,
    latestCandleTs: candles[last]?.ts ?? null,
  };
}

/**
 * Local equivalent of chart-indicators.js's fetchChartIndicatorsForMint —
 * same call signature, same `{ latest: {...} }` return shape, backed by
 * GeckoTerminal candles + locally-computed TA instead of agent-meridian.
 *
 * Cached briefly (config.indicators.geckoResultCacheSec, default 60s) per
 * (mint, interval, rsiLength) — the same token can get checked multiple
 * times in quick succession (several configured intervals, a screening
 * cycle and stoploss-rsi-guard.js's recheck loop landing close together,
 * multiple eligible candidates sharing a token) and a 5-minute candle's
 * indicators genuinely can't have changed meaningfully within a minute
 * anyway. This is on top of — not instead of — tools/gecko.js's own
 * pacing/retry/pool-resolution-cache; it just avoids re-earning the same
 * answer from GeckoTerminal at all when nothing could have changed.
 */
const resultCache = new Map(); // key -> { at, value }

export async function getLocalChartIndicators(mint, { interval, candles: candleCount = 298, rsiLength = 2 } = {}) {
  const normalizedInterval = normalizeInterval(interval);
  const cacheKey = `${mint}:${normalizedInterval}:${rsiLength}:${candleCount}`;
  const ttlMs = Math.max(0, Number(config.indicators?.geckoResultCacheSec ?? 60)) * 1000;
  if (ttlMs > 0) {
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  }

  const { candles } = await fetchOhlcvForToken(mint, { interval: normalizedInterval, limit: candleCount });
  if (candles.length < 20) {
    throw new Error(`Only ${candles.length} candles available (need >=20 for meaningful indicators) — pool may be too new or too thin for this timeframe`);
  }

  const latest = buildLatestPayload(candles, {
    rsiPeriod: Number(rsiLength),
    bbPeriod: 20,
    bbMult: 2,
    stPeriod: 10,
    stMult: 3,
    fibLookback: Math.min(candles.length, 100),
  });

  const value = { latest };
  if (ttlMs > 0) resultCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
