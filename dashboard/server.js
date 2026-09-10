/**
 * Meridian LP Dashboard
 * ─────────────────────
 * Read-only web dashboard over the bot's own history files:
 *   - state.json               → currently open positions (+ closed, thin record)
 *   - lessons.json.performance → full detail for every closed position
 *   - post-close-tracking.json → positions still being shadow-tracked after close
 *   - post-close-history.json  → completed shadow-tracking verdicts (early_exit / good_exit / neutral)
 *
 * This process never writes to any of the bot's files — strictly read-only.
 * Run standalone (`node dashboard/server.js` / `npm run dashboard`) or via
 * PM2 (see ecosystem.config.cjs, app "meridian-dashboard").
 *
 * Ported from a sibling EVM/Uniswap-v4 fork of this bot. Two things differ
 * for Meteora DLMM on Solana and are called out where they appear below:
 *   1. Price-range overlay: DLMM uses bin IDs, not Uniswap ticks. Converted
 *      via @meteora-ag/dlmm's own getPriceOfBinByBinId — the bot's own
 *      deploy code (tools/dlmm.js) already uses this exact function, so
 *      this is the same math the bot itself relies on, not a reimplementation.
 *   2. Candle source: Meteora's own OHLCV API instead of GeckoTerminal.
 */

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, ".."); // meridian project root

const FILES = {
  state: path.join(REPO_ROOT, "state.json"),
  lessons: path.join(REPO_ROOT, "lessons.json"),
  postCloseTracking: path.join(REPO_ROOT, "post-close-tracking.json"),
  postCloseHistory: path.join(REPO_ROOT, "post-close-history.json"),
};

const PORT = process.env.DASHBOARD_PORT || 4477;
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0"; // bind all interfaces so it's reachable off-box

// ─── Safe JSON read helpers ─────────────────────────────────────

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[dashboard] failed to read ${path.basename(filePath)}: ${err.message}`);
    return fallback;
  }
}

function readState() {
  return readJSON(FILES.state, { positions: {}, recentEvents: [], lastUpdated: null });
}

function readLessons() {
  return readJSON(FILES.lessons, { lessons: [], performance: [] });
}

function readPostCloseTracking() {
  return readJSON(FILES.postCloseTracking, []);
}

function readPostCloseHistory() {
  return readJSON(FILES.postCloseHistory, []);
}

// ─── Data assembly ───────────────────────────────────────────────

/**
 * Merge state.json positions + lessons.json performance records into one
 * unified list of position rows for the UI.
 *
 * - Open positions come from state.json (closed === false).
 * - Closed positions prefer the richer lessons.json performance record
 *   (has pnl_usd, pnl_pct, fees_earned_usd, minutes_held, range_efficiency, etc).
 *   If a position is marked closed in state.json but has no matching
 *   performance record (edge case — e.g. lessons.js skipped recording it as
 *   an absurd/suspicious-unit-mix outlier, see lessons.js's recordPerformance),
 *   it's still included using the thinner state.json record so nothing
 *   silently disappears from the list.
 */
function buildPositions() {
  const state = readState();
  const lessons = readLessons();
  const postCloseHistory = readPostCloseHistory();
  const postCloseTracking = readPostCloseTracking();

  const perfByPosition = new Map();
  for (const p of lessons.performance || []) {
    perfByPosition.set(String(p.position), p);
  }
  // post-close-history.json entries are { ...watch, outcome: {verdict, ...}, finalized_at }
  // — verdict lives under .outcome, not top-level (differs from the fork this was ported from).
  const postCloseByPosition = new Map();
  for (const p of postCloseHistory || []) {
    if (p.position != null) postCloseByPosition.set(String(p.position), p);
  }
  // post-close-tracking.json entries use named checkpoint_30/checkpoint_60 fields
  // (not a generic checkpoints/checks array).
  const trackingByPosition = new Map();
  for (const p of postCloseTracking || []) {
    if (p.position != null) trackingByPosition.set(String(p.position), p);
  }

  const rows = [];
  const statePositions = state.positions || {};

  for (const [id, sp] of Object.entries(statePositions)) {
    const perf = perfByPosition.get(String(id));
    const postClose = postCloseByPosition.get(String(id));
    const tracking = trackingByPosition.get(String(id));
    const postCloseOut = postClose
      ? {
          verdict: postClose.outcome?.verdict ?? null,
          summary: postClose.outcome?.summary ?? null,
          peak_pnl_pct_after_close: postClose.outcome?.peak_pnl_pct_after_close ?? null,
          pnl_pct_at_30min: postClose.outcome?.pnl_pct_at_30min ?? postClose.checkpoint_30?.implied_pnl_pct ?? null,
          pnl_pct_at_60min: postClose.outcome?.pnl_pct_at_60min ?? postClose.checkpoint_60?.implied_pnl_pct ?? null,
        }
      : null;

    if (sp.closed) {
      if (perf) {
        rows.push({
          position: String(id),
          status: "closed",
          pool: perf.pool ?? sp.pool ?? null,
          pool_name: perf.pool_name ?? sp.pool_name ?? null,
          strategy: perf.strategy ?? sp.strategy ?? null,
          bin_range: perf.bin_range ?? sp.bin_range ?? null,
          bin_step: perf.bin_step ?? sp.bin_step ?? null,
          active_bin_at_deploy: sp.active_bin_at_deploy ?? null,
          volatility: perf.volatility ?? sp.volatility ?? null,
          fee_tvl_ratio: perf.fee_tvl_ratio ?? null,
          organic_score: perf.organic_score ?? null,
          amount_sol: perf.amount_sol ?? sp.amount_sol ?? null,
          initial_value_usd: perf.initial_value_usd ?? sp.initial_value_usd ?? null,
          final_value_usd: perf.final_value_usd ?? null,
          fees_earned_usd: perf.fees_earned_usd ?? 0,
          pnl_usd: perf.pnl_usd ?? null,
          pnl_pct: perf.pnl_pct ?? null,
          range_efficiency: perf.range_efficiency ?? null,
          minutes_held: perf.minutes_held ?? null,
          minutes_in_range: perf.minutes_in_range ?? null,
          rebalance_count: perf.rebalance_count ?? sp.rebalance_count ?? 0,
          close_reason: perf.close_reason ?? (sp.notes && sp.notes[sp.notes.length - 1]) ?? null,
          entry: {
            mcap: perf.entry_mcap ?? sp.entry_mcap ?? null,
            tvl: perf.entry_tvl ?? sp.entry_tvl ?? null,
            volume: perf.entry_volume ?? sp.entry_volume ?? null,
            holders: perf.entry_holders ?? sp.entry_holders ?? null,
          },
          exit: {
            mcap: perf.exit_mcap ?? null,
            tvl: perf.exit_tvl ?? null,
            volume: perf.exit_volume ?? null,
          },
          deployed_at: sp.deployed_at ?? null,
          closed_at: sp.closed_at ?? perf.recorded_at ?? null,
          notes: sp.notes ?? [],
          post_close: postCloseOut,
          source: "lessons.performance",
        });
      } else {
        // Closed in state.json but no performance record — still surface it.
        rows.push({
          position: String(id),
          status: "closed",
          pool: sp.pool ?? null,
          pool_name: sp.pool_name ?? null,
          strategy: sp.strategy ?? null,
          bin_range: sp.bin_range ?? null,
          bin_step: sp.bin_step ?? null,
          active_bin_at_deploy: sp.active_bin_at_deploy ?? null,
          organic_score: null,
          amount_sol: sp.amount_sol ?? null,
          initial_value_usd: sp.initial_value_usd ?? null,
          final_value_usd: null,
          fees_earned_usd: sp.total_fees_claimed_usd ?? 0,
          pnl_usd: null,
          pnl_pct: null,
          range_efficiency: null,
          minutes_held: null,
          minutes_in_range: null,
          rebalance_count: sp.rebalance_count ?? 0,
          close_reason: sp.notes && sp.notes.length ? sp.notes[sp.notes.length - 1] : null,
          entry: {
            mcap: sp.entry_mcap ?? null,
            tvl: sp.entry_tvl ?? null,
            volume: sp.entry_volume ?? null,
            holders: sp.entry_holders ?? null,
          },
          exit: { mcap: null, tvl: null, volume: null },
          deployed_at: sp.deployed_at ?? null,
          closed_at: sp.closed_at ?? null,
          notes: sp.notes ?? [],
          post_close: postCloseOut,
          source: "state.json",
        });
      }
    } else {
      // Open position
      rows.push({
        position: String(id),
        status: "open",
        pool: sp.pool ?? null,
        pool_name: sp.pool_name ?? null,
        strategy: sp.strategy ?? null,
        bin_range: sp.bin_range ?? null,
        bin_step: sp.bin_step ?? null,
        active_bin_at_deploy: sp.active_bin_at_deploy ?? null,
        volatility: sp.volatility ?? null,
        fee_tvl_ratio: sp.fee_tvl_ratio ?? null,
        organic_score: sp.organic_score ?? null,
        amount_sol: sp.amount_sol ?? null,
        initial_value_usd: sp.initial_value_usd ?? null,
        final_value_usd: null,
        fees_earned_usd: sp.total_fees_claimed_usd ?? 0,
        pnl_usd: null,
        pnl_pct: null,
        peak_pnl_pct: sp.peak_pnl_pct ?? null,
        range_efficiency: null,
        minutes_held: sp.deployed_at
          ? Math.round((Date.now() - new Date(sp.deployed_at).getTime()) / 60000)
          : null,
        out_of_range_since: sp.out_of_range_since ?? null,
        trailing_active: sp.trailing_active ?? false,
        rebalance_count: sp.rebalance_count ?? 0,
        entry: {
          mcap: sp.entry_mcap ?? null,
          tvl: sp.entry_tvl ?? null,
          volume: sp.entry_volume ?? null,
          holders: sp.entry_holders ?? null,
        },
        deployed_at: sp.deployed_at ?? null,
        closed_at: null,
        notes: sp.notes ?? [],
        liquidity_samples: sp.liquidity_samples ?? [],
        tracking: tracking
          ? { checkpoint_30: tracking.checkpoint_30 ?? null, checkpoint_60: tracking.checkpoint_60 ?? null, samples: tracking.samples ?? [] }
          : null,
        source: "state.json",
      });
    }
  }

  // Sort newest deployed first
  rows.sort((a, b) => new Date(b.deployed_at || 0) - new Date(a.deployed_at || 0));
  return rows;
}

function buildSummary(rows) {
  const open = rows.filter((r) => r.status === "open");
  const closed = rows.filter((r) => r.status === "closed");
  const closedWithPnl = closed.filter((r) => typeof r.pnl_usd === "number");

  const totalPnlUsd = closedWithPnl.reduce((sum, r) => sum + (r.pnl_usd || 0), 0);
  const totalFeesUsd = rows.reduce((sum, r) => sum + (r.fees_earned_usd || 0), 0);
  const wins = closedWithPnl.filter((r) => r.pnl_usd > 0).length;
  const losses = closedWithPnl.filter((r) => r.pnl_usd <= 0).length;
  const winRate = closedWithPnl.length ? (wins / closedWithPnl.length) * 100 : null;
  const avgPnlPct = closedWithPnl.length
    ? closedWithPnl.reduce((sum, r) => sum + (r.pnl_pct || 0), 0) / closedWithPnl.length
    : null;
  const totalDeployedUsd = rows.reduce((sum, r) => sum + (r.initial_value_usd || 0), 0);

  // Pool-level breakdown across closed positions
  const poolMap = new Map();
  for (const r of closedWithPnl) {
    const key = r.pool_name || r.pool || "unknown";
    if (!poolMap.has(key)) poolMap.set(key, { pool_name: key, trades: 0, pnl_usd: 0, wins: 0 });
    const entry = poolMap.get(key);
    entry.trades += 1;
    entry.pnl_usd += r.pnl_usd || 0;
    if (r.pnl_usd > 0) entry.wins += 1;
  }
  const byPool = Array.from(poolMap.values())
    .map((p) => ({ ...p, pnl_usd: Math.round(p.pnl_usd * 100) / 100, win_rate: Math.round((p.wins / p.trades) * 1000) / 10 }))
    .sort((a, b) => b.pnl_usd - a.pnl_usd);

  return {
    open_count: open.length,
    closed_count: closed.length,
    total_positions: rows.length,
    total_pnl_usd: Math.round(totalPnlUsd * 100) / 100,
    total_fees_usd: Math.round(totalFeesUsd * 100) / 100,
    total_deployed_usd: Math.round(totalDeployedUsd * 100) / 100,
    win_rate_pct: winRate === null ? null : Math.round(winRate * 10) / 10,
    avg_pnl_pct: avgPnlPct === null ? null : Math.round(avgPnlPct * 100) / 100,
    wins,
    losses,
    by_pool: byPool,
    last_updated: new Date().toISOString(),
  };
}

// ─── DLMM bin ↔ price (Meteora, not Uniswap ticks) ────────────────

// @meteora-ag/dlmm ships CJS under an ESM default-export wrapper — same
// dynamic-import dance tools/dlmm.js already does for this package, kept
// consistent here rather than re-deriving it.
let _getPriceOfBinByBinId = null;
async function getPriceOfBinByBinId() {
  if (!_getPriceOfBinByBinId) {
    const mod = await import("@meteora-ag/dlmm");
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId || mod.default?.getPriceOfBinByBinId;
    if (!_getPriceOfBinByBinId) throw new Error("@meteora-ag/dlmm did not export getPriceOfBinByBinId — check package version");
  }
  return _getPriceOfBinByBinId;
}

/**
 * Price at `binId` relative to a REAL reference price at `referenceBinId` —
 * same pattern as this dashboard's original (pre-Meteora-port) reference,
 * which anchored Uniswap tick prices to an actual candle close rather than
 * computing an absolute price from tick math alone. Ported here because
 * the previous version of this function (binRangeToUsd, now removed) tried
 * to derive an ABSOLUTE USD price directly from getPriceOfBinByBinId(),
 * which returns a raw ratio in whatever units the SDK's internal bin-step
 * formula produces — NOT decimals-adjusted to the pool's actual token
 * decimals (tools/dlmm.js only ever uses this function's output in RATIO
 * form — activePrice * (1 ± pct/100) — never as a standalone absolute
 * value, which is exactly why that gap was never hit before). Treating it
 * as an absolute USD value could be off by orders of magnitude, which
 * would explain the reported flat-line-at-0 price chart: Chart.js's y-axis
 * auto-scales to fit every dataset including the bin-range annotation, so
 * a badly-scaled bin_top_usd would stretch the axis and squash the real
 * (correctly-scaled) GeckoTerminal price line down to visually nothing.
 *
 * Taking a RATIO of two getPriceOfBinByBinId() calls at the same bin_step
 * cancels out whatever fixed scaling convention the SDK uses internally,
 * regardless of what it is — so multiplying that ratio by a real anchor
 * price (an actual GeckoTerminal candle close near deploy time) guarantees
 * the result lands in the same, correct scale as the rest of the chart.
 */
async function priceAtBin(binId, referenceBinId, binStep, referencePriceUsd) {
  if (binId == null || referenceBinId == null || !referencePriceUsd) return null;
  try {
    const priceFn = await getPriceOfBinByBinId();
    const pTarget = Number(priceFn(binId, binStep).toString());
    const pReference = Number(priceFn(referenceBinId, binStep).toString());
    if (!(pReference > 0) || !Number.isFinite(pTarget)) return null;
    return referencePriceUsd * (pTarget / pReference);
  } catch (err) {
    console.error(`[dashboard] bin price conversion failed: ${err.message}`);
    return null;
  }
}

function closestCandle(candles, targetTs) {
  let best = null;
  let bestDiff = Infinity;
  for (const c of candles) {
    const diff = Math.abs(c.ts - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

// ─── Price chart (GeckoTerminal OHLCV + bin-range/Bollinger overlays) ────

// This dashboard used to route through config.indicators.dataSource — the
// SAME switch that governs the live bot's RSI-confirm/entry-confirm
// indicator source. That coupling was a mistake: that switch exists to
// manage GeckoTerminal rate-limit pressure from checking many tokens every
// few minutes on the live bot, which has nothing to do with this
// dashboard's load (one human, one chart, viewed occasionally). Worse, it
// meant that setting dataSource back to "meridian" for the live bot's rate
// limits (as recommended after the 2026-07-27 GeckoTerminal incident)
// silently switched this chart over to fetchMeteoraOhlcv — which was
// written without ever confirming Meteora's OHLCV response shape against a
// live call, unlike tools/gecko.js's GeckoTerminal client, which has been
// proven working against real traffic this session. That mismatch is the
// most likely reason the chart wasn't drawing. Decoupled: this dashboard
// now always uses GeckoTerminal directly via tools/gecko.js, independent
// of whatever the live bot's indicator dataSource is set to.

// GeckoTerminal's interval naming ("5_MINUTE") — same span-based
// granularity bucketing as before, just no longer conditional on a switch.
function pickGeckoInterval(spanMinutes) {
  if (spanMinutes <= 180) return "1_MINUTE";
  if (spanMinutes <= 720) return "5_MINUTE";
  if (spanMinutes <= 3 * 24 * 60) return "15_MINUTE";
  if (spanMinutes <= 14 * 24 * 60) return "1_HOUR";
  return "4_HOUR";
}

/**
 * GeckoTerminal candle fetch, normalized to { ts, o, h, l, c, v } —
 * public/app.js's chart rendering shape.
 */
async function fetchGeckoOhlcvForChart(poolAddress, { geckoInterval, before } = {}) {
  const { fetchOhlcv } = await import("../tools/gecko.js");
  const candles = await fetchOhlcv(poolAddress, { interval: geckoInterval, limit: 500, before });
  return candles.map((c) => ({ ts: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
}

async function buildPriceChart(row) {
  if (!row.pool) throw new Error("Position has no pool address on record");

  const deployedAtSec = row.deployed_at ? Math.floor(new Date(row.deployed_at).getTime() / 1000) : null;
  if (!deployedAtSec) throw new Error("Position has no deployed_at timestamp on record");
  const closedAtSec = row.closed_at ? Math.floor(new Date(row.closed_at).getTime() / 1000) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowEndSec = closedAtSec || nowSec;

  const spanMinutes = Math.max(5, Math.round((windowEndSec - deployedAtSec) / 60));
  const paddingMinutes = Math.max(15, Math.round(spanMinutes * 0.25));
  const paddedEndSec = windowEndSec + paddingMinutes * 60;
  const before = paddedEndSec < nowSec ? paddedEndSec : undefined;

  const interval = pickGeckoInterval(spanMinutes + paddingMinutes * 2);
  const rawCandles = await fetchGeckoOhlcvForChart(row.pool, { geckoInterval: interval, before });

  // Bin range overlay — anchored to a real candle price near deploy time
  // (see priceAtBin's comment for why this replaced a from-scratch
  // absolute-price calculation). row.active_bin_at_deploy is the bin ID
  // recorded at deploy (state.js's trackPosition) — the reference point
  // both the bin range and the reference candle correspond to the same
  // moment.
  let binTopUsd = null, binBottomUsd = null;
  const referenceCandle = rawCandles.length ? closestCandle(rawCandles, deployedAtSec) : null;
  if (row.bin_range && row.bin_step != null && row.active_bin_at_deploy != null && referenceCandle) {
    const { min, max } = row.bin_range;
    const referencePriceUsd = referenceCandle.c;
    const pLower = await priceAtBin(min, row.active_bin_at_deploy, row.bin_step, referencePriceUsd);
    const pUpper = await priceAtBin(max, row.active_bin_at_deploy, row.bin_step, referencePriceUsd);
    if (pLower != null && pUpper != null) {
      binTopUsd = Math.max(pLower, pUpper);
      binBottomUsd = Math.min(pLower, pUpper);
    }
  }

  // Bollinger band + RSI — the SAME indicators config.indicators feeds
  // into entry/exit confirmation (tools/chart-indicators.js /
  // tools/indicators-local.js), so these overlays match what the live bot
  // itself would be looking at, not approximations invented just for this
  // chart. RSI in particular uses config.indicators.rsiLength (default 2)
  // — the exact same RSI(2) stoploss-rsi-guard.js waits on before closing
  // a stop-loss-triggered position, so this is directly useful for seeing
  // where that threshold (config.management.stopLossRsiThreshold) would
  // actually have fired historically, not just in the abstract.
  //
  // One real discrepancy worth knowing: live confirmation resolves a pool
  // via GeckoTerminal's token-pools search (tools/gecko.js's
  // bestPoolForToken), which could pick a DIFFERENT pool than this exact
  // one if the token has multiple Meteora pools at different bin_steps.
  // This fetches directly against row.pool instead — the exact pool this
  // chart's price line already shows — for self-consistency with what's
  // displayed, at the cost of not being byte-identical to whatever pool
  // resolution happened to pick live.
  let bollinger = null;
  let rsi = null;
  try {
    const { fetchOhlcv } = await import("../tools/gecko.js");
    const { computeBollinger, computeRSI } = await import("../tools/indicators-local.js");
    const indInterval = config.indicators.intervals?.[0] || "15_MINUTE";
    const indCandleCount = Number(config.indicators.candles ?? 300);
    const indRaw = indInterval === interval
      ? rawCandles.map((c) => ({ ts: c.ts, close: c.c })) // same interval as the display chart already fetched — reuse, no second fetch
      : (await fetchOhlcv(row.pool, { interval: indInterval, limit: indCandleCount })).map((c) => ({ ts: c.ts, close: c.close }));
    const closes = indRaw.map((c) => c.close);

    if (closes.length >= 20) {
      const bb = computeBollinger(closes, 20, 2);
      const points = indRaw
        .map((c, i) => ({ ts: c.ts, lower: bb.lower[i], middle: bb.middle[i], upper: bb.upper[i] }))
        .filter((p) => p.lower != null); // first (bbPeriod-1) entries are null — not enough candles behind them yet
      if (points.length) bollinger = { interval: indInterval, points };
    }

    const rsiLength = Number(config.indicators.rsiLength ?? 2);
    if (closes.length > rsiLength) {
      const rsiArr = computeRSI(closes, rsiLength);
      const points = indRaw
        .map((c, i) => ({ ts: c.ts, value: rsiArr[i] }))
        .filter((p) => p.value != null); // first `rsiLength` entries are null — not enough candles behind them yet
      if (points.length) {
        rsi = {
          interval: indInterval,
          length: rsiLength,
          points,
          oversold: Number(config.indicators.rsiOversold ?? 30),
          overbought: Number(config.indicators.rsiOverbought ?? 80),
          stop_loss_threshold: config.management.stopLossRsiConfirm ? Number(config.management.stopLossRsiThreshold ?? 85) : null,
        };
      }
    }
  } catch { /* non-fatal — chart still renders without these overlays */ }

  const candles = rawCandles;

  return {
    position: row.position,
    pool: row.pool,
    pool_name: row.pool_name,
    interval,
    source: "gecko",
    candles,
    bin_top_usd: binTopUsd,
    bin_bottom_usd: binBottomUsd,
    bollinger,
    rsi,
    deployed_at: row.deployed_at,
    closed_at: row.closed_at,
  };
}

// ─── App ──────────────────────────────────────────────────────────

const app = express();

app.get("/api/positions", (req, res) => {
  try {
    const rows = buildPositions();
    const { status } = req.query;
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    res.json({ positions: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/positions/:id", (req, res) => {
  try {
    const rows = buildPositions();
    const row = rows.find((r) => r.position === String(req.params.id));
    if (!row) return res.status(404).json({ error: "position not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/positions/:id/chart", async (req, res) => {
  try {
    const rows = buildPositions();
    const row = rows.find((r) => r.position === String(req.params.id));
    if (!row) return res.status(404).json({ error: "position not found" });
    const chart = await buildPriceChart(row);
    res.json(chart);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/summary", (req, res) => {
  try {
    const rows = buildPositions();
    res.json(buildSummary(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, files: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, fs.existsSync(v)])) });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, HOST, () => {
  console.log(`[dashboard] Meridian LP dashboard listening on http://${HOST}:${PORT}`);
  console.log(`[dashboard] → local:   http://localhost:${PORT}`);
  console.log(`[dashboard] → network: http://<this-machine's-ip>:${PORT}  (no auth — restrict via firewall/security group if exposed to the internet)`);
  console.log(`[dashboard] reading history from: ${REPO_ROOT}`);
});
