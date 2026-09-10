/**
 * Post-close price/volume shadow tracking.
 *
 * After a position closes, Meridian normally loses all visibility into that
 * pool — if price kept ripping right after an exit, there's no record of it.
 * This module watches closed positions for a short window afterward (30 and
 * 60 minute checkpoints) and computes what PnL *would* have looked like if
 * the exposure had simply been held, so exit quality (especially trailing-TP
 * closes) can actually be evaluated against what happened next.
 *
 * Two files:
 *  - post-close-tracking.json — small, active/in-window watches only.
 *  - post-close-history.json  — permanent, finalized records (capped) for
 *    later analysis; this is the rich one, with the full sample series.
 *
 * pool-memory.json only gets a lean summary (attachPostCloseOutcome), not
 * the raw sample series, to keep it small.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { fetchPoolMarketSnapshot } from "./tools/dlmm.js";
import { attachPostCloseOutcome } from "./pool-memory.js";

const TRACK_FILE = repoPath("post-close-tracking.json");
const HISTORY_FILE = repoPath("post-close-history.json");

const CHECKPOINT_MINUTES = [30, 60];
const MAX_WINDOW_MIN = Math.max(...CHECKPOINT_MINUTES);
const POLL_GRACE_MIN = 3; // finalize a bit past 60min rather than exactly on it, since polling is ~2min cadence
const MAX_ACTIVE_WATCHES = 200; // safety cap; drop oldest if something stalls finalization
const MAX_HISTORY_ENTRIES = 1000; // cap post-close-history.json growth

// A move needs to be at least this many percentage points to call the
// exit "early" or "good" rather than just noise/neutral.
const VERDICT_THRESHOLD_PCT = 5;

function loadJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadWatches() {
  return loadJson(TRACK_FILE, []);
}

function saveWatches(watches) {
  saveJson(TRACK_FILE, watches);
}

function loadHistory() {
  return loadJson(HISTORY_FILE, []);
}

function saveHistory(history) {
  // Cap growth — keep the most recent entries.
  const trimmed = history.length > MAX_HISTORY_ENTRIES
    ? history.slice(history.length - MAX_HISTORY_ENTRIES)
    : history;
  saveJson(HISTORY_FILE, trimmed);
}

/**
 * Register a just-closed position for post-close tracking.
 * Called from tools/dlmm.js closePosition() right after recordPerformance().
 * No-op (skips silently) if disabled or missing the cost-basis data needed
 * to compute a meaningful hypothetical PnL.
 */
export function registerPostCloseWatch({
  position,
  pool,
  pool_name,
  base_mint,
  close_reason,
  close_pnl_pct,
  initial_value_usd,
  exit_mcap,
  exit_tvl,
  exit_volume,
}) {
  if (config.management.postCloseTrackEnabled === false) return;
  if (!position || !pool) return;
  // Without an exit mcap we have no price proxy to compare future samples
  // against, so there's nothing meaningful to track.
  if (exit_mcap == null || !(exit_mcap > 0)) {
    log("post-close-track", `Skipped watch for ${pool_name || pool}: no exit_mcap available`);
    return;
  }

  const watches = loadWatches();

  if (watches.length >= MAX_ACTIVE_WATCHES) {
    watches.sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));
    watches.shift(); // drop the oldest stalled watch
  }

  watches.push({
    position,
    pool,
    pool_name: pool_name || pool.slice(0, 8),
    base_mint: base_mint || null,
    closed_at: new Date().toISOString(),
    close_reason: close_reason || null,
    close_pnl_pct: Number.isFinite(close_pnl_pct) ? close_pnl_pct : 0,
    initial_value_usd: initial_value_usd ?? null,
    exit_mcap,
    exit_tvl: exit_tvl ?? null,
    exit_volume: exit_volume ?? null,
    samples: [],
    checkpoint_30: null,
    checkpoint_60: null,
  });

  saveWatches(watches);
  log("post-close-track", `Watching ${pool_name || pool.slice(0, 8)} for ${MAX_WINDOW_MIN}min post-close`);
}

function impliedPnlPct(watch, mcap) {
  if (mcap == null || !(mcap > 0)) return null;
  const priceRatio = mcap / watch.exit_mcap;
  // Compounds the PnL already locked in at close with the price move since —
  // i.e. "if instead of closing I'd kept holding this exposure, where would
  // my running PnL against the original cost basis be right now."
  // Approximation: uses mcap ratio as a price proxy (fine for short windows
  // on tokens with static supply; would drift if supply changes materially).
  return Math.round((((1 + watch.close_pnl_pct / 100) * priceRatio - 1) * 100) * 100) / 100;
}

function buildOutcome(watch) {
  const allPoints = [
    ...watch.samples,
    ...(watch.checkpoint_30 ? [watch.checkpoint_30] : []),
    ...(watch.checkpoint_60 ? [watch.checkpoint_60] : []),
  ].filter((p) => p.implied_pnl_pct != null);

  const peak = allPoints.reduce(
    (best, p) => (best == null || p.implied_pnl_pct > best.implied_pnl_pct ? p : best),
    null
  );
  const last = watch.checkpoint_60 || watch.checkpoint_30 || allPoints[allPoints.length - 1] || null;

  const upsideLeftOnTable = peak ? peak.implied_pnl_pct - watch.close_pnl_pct : 0;
  const driftSinceClose = last ? last.implied_pnl_pct - watch.close_pnl_pct : 0;

  let verdict = "neutral";
  if (peak && upsideLeftOnTable >= VERDICT_THRESHOLD_PCT) {
    verdict = "early_exit";
  } else if (last && driftSinceClose <= -VERDICT_THRESHOLD_PCT) {
    verdict = "good_exit";
  }

  let summary;
  if (verdict === "early_exit") {
    summary = `Price kept rising after close — peak +${upsideLeftOnTable.toFixed(1)}pp above the close PnL at +${peak.t_offset_min}min (would've been ${peak.implied_pnl_pct.toFixed(1)}% vs closed at ${watch.close_pnl_pct.toFixed(1)}%). Possible early exit.`;
  } else if (verdict === "good_exit") {
    summary = `Price fell after close — would've been ${last.implied_pnl_pct.toFixed(1)}% at +${last.t_offset_min}min vs closed at ${watch.close_pnl_pct.toFixed(1)}%. Exit looks correct.`;
  } else {
    summary = `Price roughly held near the close level in the following ${MAX_WINDOW_MIN}min (closed ${watch.close_pnl_pct.toFixed(1)}%${last ? `, ${last.implied_pnl_pct.toFixed(1)}% at +${last.t_offset_min}min` : ""}). Exit timing looks neutral.`;
  }

  return {
    verdict,
    close_pnl_pct: watch.close_pnl_pct,
    peak_pnl_pct_after_close: peak?.implied_pnl_pct ?? null,
    peak_at_min: peak?.t_offset_min ?? null,
    pnl_pct_at_30min: watch.checkpoint_30?.implied_pnl_pct ?? null,
    pnl_pct_at_60min: watch.checkpoint_60?.implied_pnl_pct ?? null,
    summary,
  };
}

/**
 * Poll all active watches: sample any pool whose window hasn't elapsed yet,
 * capture 30/60min checkpoints as they're crossed, and finalize (write to
 * pool-memory + history, drop from active list) anything past the window.
 * Called from a cron interval in index.js — cheap no-op when nothing's active.
 */
export async function pollPostCloseWatches() {
  if (config.management.postCloseTrackEnabled === false) return;

  const watches = loadWatches();
  if (watches.length === 0) return;

  const remaining = [];
  const finalized = [];

  for (const watch of watches) {
    const elapsedMin = (Date.now() - new Date(watch.closed_at).getTime()) / 60000;

    if (elapsedMin >= MAX_WINDOW_MIN + POLL_GRACE_MIN) {
      finalized.push(watch); // past the window and never got a clean 60min sample — finalize with what we have
      continue;
    }

    try {
      const snap = await fetchPoolMarketSnapshot(watch.pool);
      if (snap.mcap != null) {
        const point = {
          t_offset_min: Math.round(elapsedMin),
          mcap: snap.mcap,
          tvl: snap.tvl ?? null,
          volume: snap.volume ?? null,
          implied_pnl_pct: impliedPnlPct(watch, snap.mcap),
        };
        watch.samples.push(point);

        for (const cp of CHECKPOINT_MINUTES) {
          const field = `checkpoint_${cp}`;
          if (!watch[field] && elapsedMin >= cp) {
            watch[field] = point;
          }
        }
      }
    } catch (e) {
      log("post-close-track", `Snapshot failed for ${watch.pool_name}: ${e.message}`);
    }

    if (watch.checkpoint_60 || elapsedMin >= MAX_WINDOW_MIN) {
      finalized.push(watch);
    } else {
      remaining.push(watch);
    }
  }

  saveWatches(remaining);

  if (finalized.length > 0) {
    const history = loadHistory();
    for (const watch of finalized) {
      const outcome = buildOutcome(watch);
      history.push({ ...watch, outcome, finalized_at: new Date().toISOString() });
      attachPostCloseOutcome(watch.pool, watch.position, outcome);
      log("post-close-track", `Finalized ${watch.pool_name}: ${outcome.verdict} — ${outcome.summary}`);

      // Dedicated structured line for offline analysis (grep
      // "POST_CLOSE_METRICS"). Full watch record — everything captured
      // during the shadow-tracking window (exit snapshot, every sample
      // point, both checkpoints) plus the computed outcome/verdict, all
      // in one line per finalized position.
      log("post_close_metrics", JSON.stringify({
        position: watch.position,
        pool: watch.pool,
        pool_name: watch.pool_name,
        base_mint: watch.base_mint,
        closed_at: watch.closed_at,
        close_reason: watch.close_reason,
        close_pnl_pct: watch.close_pnl_pct,
        initial_value_usd: watch.initial_value_usd,
        exit_mcap: watch.exit_mcap,
        exit_tvl: watch.exit_tvl,
        exit_volume: watch.exit_volume,
        samples: watch.samples,
        checkpoint_30: watch.checkpoint_30,
        checkpoint_60: watch.checkpoint_60,
        outcome,
      }));
    }
    saveHistory(history);
  }
}
