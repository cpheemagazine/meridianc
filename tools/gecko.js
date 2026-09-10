// tools/gecko.js — GeckoTerminal OHLCV client (Solana).
//
// Alternative candle source to the proprietary agent-meridian backend
// (api.agentmeridian.xyz), selected via config.indicators.dataSource ===
// "gecko". GeckoTerminal (CoinGecko's on-chain DEX data arm) covers Solana
// under the network slug "solana" via a free, public, no-key REST API.
// This module fetches raw OHLCV candles and resolves a token to its
// deepest pool via GeckoTerminal's own token-pools endpoint (no third API
// dependency needed); tools/indicators-local.js computes RSI/Bollinger/
// Supertrend/Fibonacci from the candles locally.
//
// GeckoTerminal's free public tier rate-limits aggressively (observed:
// 429s under normal indicator-confirmation + RSI-guard polling load with
// no pacing at all). Paced + retried the same way tools/gmgn.js already
// paces/retries GMGN requests — same pattern, not a new one.

import { config } from "../config.js";
import { log } from "../logger.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A plain "check elapsed time, sleep if needed" pacer races under concurrent
// callers: tools/screening.js's indicator-confirmation step fires
// confirmIndicatorPreset for every eligible candidate via Promise.all, so
// N calls can all read the same lastRequestAt before any of them advances
// it, all conclude "enough time has passed", and all fire at once —
// confirmed in production logs 2026-07-27 (three different pools' OHLCV
// requests within 1ms of each other, all 429). A serialized queue closes
// that race: every request — including retries — waits its turn in one
// FIFO line, so the pacing delay is enforced between literally every HTTP
// call to GeckoTerminal regardless of how many callers are waiting.
let geckoQueueTail = Promise.resolve();
let lastGeckoRequestAt = 0;
function runPacedOnQueue(fn) {
  const run = async () => {
    const delayMs = Math.max(0, Number(config.indicators?.geckoRequestDelayMs ?? 2500));
    if (delayMs) {
      const elapsed = Date.now() - lastGeckoRequestAt;
      if (elapsed < delayMs) await sleep(delayMs - elapsed);
    }
    lastGeckoRequestAt = Date.now();
    return fn();
  };
  // Chain onto the tail regardless of whether the previous entry
  // succeeded or failed, so one failed/slow request can't wedge the queue
  // for everything queued behind it.
  const result = geckoQueueTail.then(run, run);
  geckoQueueTail = result.then(() => {}, () => {});
  return result;
}

/** GET with pacing + 429 retry/backoff (Retry-After header if present, else exponential). Every attempt — including retries — goes through the same serialized queue. */
async function geckoFetch(url, label) {
  const maxRetries = Math.max(0, Number(config.indicators?.geckoMaxRetries ?? 3));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await runPacedOnQueue(() => fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }));
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < maxRetries) {
      // r.headers.get() returns null when the header is absent (observed:
      // GeckoTerminal's 429s never send Retry-After) — Number(null) is 0,
      // NOT NaN, so checking isFinite() on that directly always looked
      // "valid" and took a 0ms backoff every time, completely skipping the
      // exponential fallback below. That's why production logs showed
      // "retrying in 0s" on every single attempt: retries were hammering
      // right back at normal pacing speed instead of actually backing off,
      // so they kept 429ing until every retry was burned.
      const retryAfterHeader = r.headers.get("retry-after");
      const retryAfter = retryAfterHeader != null ? Number(retryAfterHeader) : NaN;
      // Floor at 1s even when a real header value comes back — a 429
      // response telling you to wait 0 seconds isn't a useful instruction
      // (seen from some CDN/edge block pages sitting in front of the real
      // API), and trusting it verbatim reproduces the exact same
      // hammering behavior the bug above caused, just from a different
      // root cause.
      const backoffMs = Number.isFinite(retryAfter) ? Math.max(1000, retryAfter * 1000) : Math.min(30000, 3000 * Math.pow(2, attempt));
      log("indicators_warn", `GeckoTerminal 429 for ${label} — retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(backoffMs);
      continue;
    }
    throw new Error(`GeckoTerminal ${label} ${r.status}`);
  }
  throw new Error(`GeckoTerminal ${label} failed after ${maxRetries} retries (rate limited)`);
}

// Token → pool resolution rarely changes — cache it so repeated indicator
// checks on the same token (stoploss-rsi-guard.js's recheck loop,
// confirmIndicatorPreset across multiple intervals) don't cost a second
// API call every time, on top of pacing. Same TTL pattern as
// tools/dlmm.js's poolMetadataCache.
const poolResolutionCache = new Map();
setInterval(() => poolResolutionCache.clear(), 15 * 60 * 1000);

/** Deepest Solana pool for a token, via GeckoTerminal's own token-pools endpoint. */
export async function bestPoolForToken(token) {
  if (poolResolutionCache.has(token)) return poolResolutionCache.get(token);

  const url = `${GECKO_BASE}/networks/${NETWORK}/tokens/${token}/pools?page=1`;
  const j = await geckoFetch(url, `token-pools ${token.slice(0, 10)}`);
  const pools = Array.isArray(j?.data) ? j.data : [];
  // Sort by reserve (TVL) descending — the endpoint's default order isn't
  // documented as liquidity-sorted, so don't rely on it.
  const best = pools
    .map((p) => ({
      poolAddress: p?.attributes?.address,
      dex: p?.relationships?.dex?.data?.id || null,
      pair: p?.attributes?.name || null,
      reserveUsd: Number(p?.attributes?.reserve_in_usd) || 0,
    }))
    .filter((p) => p.poolAddress)
    .sort((a, b) => b.reserveUsd - a.reserveUsd)[0] || null;

  poolResolutionCache.set(token, best);
  return best;
}

// Meridian's "5_MINUTE"/"15_MINUTE" interval naming → GeckoTerminal's
// {timeframe, aggregate} pair. A couple of extras added since GeckoTerminal
// supports more granularity than Meridian's original two options — only
// 5_MINUTE/15_MINUTE are exposed through config.indicators.intervals today
// (see chart-indicators.js's normalizeIntervals), but any of these work if
// that allow-list is widened later.
const INTERVAL_MAP = {
  "1_MINUTE": { timeframe: "minute", aggregate: 1 },
  "5_MINUTE": { timeframe: "minute", aggregate: 5 },
  "15_MINUTE": { timeframe: "minute", aggregate: 15 },
  "1_HOUR": { timeframe: "hour", aggregate: 1 },
  "4_HOUR": { timeframe: "hour", aggregate: 4 },
  "1_DAY": { timeframe: "day", aggregate: 1 },
};

export function normalizeInterval(interval) {
  const key = String(interval || "15_MINUTE").trim().toUpperCase();
  return INTERVAL_MAP[key] ? key : "15_MINUTE";
}

/**
 * Raw OHLCV candles for a pool, oldest-first. Each candle:
 * { ts (unix seconds), open, high, low, close, volume }.
 * `before` (unix seconds) anchors the window for historical charts —
 * without it GeckoTerminal always returns the most recent candles, which
 * is wrong for a position that closed a while ago.
 */
export async function fetchOhlcv(poolAddress, { interval = "15_MINUTE", limit = 300, before } = {}) {
  const key = normalizeInterval(interval);
  const { timeframe, aggregate } = INTERVAL_MAP[key];
  const params = new URLSearchParams({
    aggregate: String(aggregate),
    limit: String(Math.min(1000, Math.max(2, limit))),
    currency: "usd",
  });
  if (before) params.set("before_timestamp", String(Math.floor(before)));
  const url = `${GECKO_BASE}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}?${params.toString()}`;
  const j = await geckoFetch(url, `OHLCV ${poolAddress.slice(0, 10)}`);
  const rows = j?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error("GeckoTerminal returned no OHLCV data (pool may be too new/thin, or not indexed yet)");
  // [timestamp, open, high, low, close, volume] — GeckoTerminal returns newest-first; sort oldest-first for indicator math.
  return rows
    .map(([ts, open, high, low, close, volume]) => ({ ts, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) }))
    .filter((c) => Number.isFinite(c.close))
    .sort((a, b) => a.ts - b.ts);
}

/** Candles + resolved pool metadata for a token address, in one call. */
export async function fetchOhlcvForToken(token, opts = {}) {
  const pool = await bestPoolForToken(token);
  if (!pool) throw new Error(`No Solana pool found for token ${token.slice(0, 10)} on GeckoTerminal`);
  const candles = await fetchOhlcv(pool.poolAddress, opts);
  return { pool, candles };
}

