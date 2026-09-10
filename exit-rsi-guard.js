/**
 * exit-rsi-guard.js — waits for a local RSI(2) peak before executing an
 * exit that's already decided for a reason unrelated to price crashing,
 * instead of closing the instant the trigger condition is met.
 *
 * Covers four rules, each independently toggleable:
 *   - Take profit  (config.management.takeProfitRsiConfirm)
 *   - Trailing TP  (config.management.trailingTpRsiConfirm)
 *   - Out of range (config.management.oorRsiConfirm)
 *   - Low yield    (config.management.lowYieldRsiConfirm)
 *
 * Take profit uses its own dedicated threshold (takeProfitRsiThreshold);
 * the other three share exitRsiThreshold — no reason "good enough to lock
 * in profit" and "good enough to accept an otherwise-fine exit" need the
 * same number.
 *
 * Same mechanism as stoploss-rsi-guard.js, deliberately kept as a separate
 * module rather than merged into it — different rationale (a better fill
 * on an exit that's happening regardless, not "wait out a crash"), and
 * keeping them apart means this feature can't regress the already-working
 * stop-loss guard.
 *
 * Precedence matches the real rules exactly (trailing TP first via
 * state.js's updatePnlAndCheckExits, then take profit / OOR / low yield in
 * that order via index.js's getDeterministicCloseRule) — a position only
 * ever gets ONE pending wait at a time, for whichever condition would have
 * matched first.
 *
 * SAFETY: same as the stop-loss guard — exitRsiMaxWaitMinutes is NOT
 * optional. Past that timeout the position closes regardless of RSI,
 * falling back to the original "just close it" behavior. The RSI wait is
 * a best-effort improvement on exit price, never a reason to hold a
 * position past when the underlying rule already decided to exit it.
 *
 * Toggle: each of the four flags above, all default false. When any is
 * on, the matching immediate trigger in state.js/index.js's
 * getDeterministicCloseRule stands down — see the
 * bypass comments there — and this module owns that close decision.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { safeNumber } from "./utils/number.js";
import { getTrackedPosition } from "./state.js";
import { acquireRsiWaitLock, releaseRsiWaitLock } from "./rsi-wait-lock.js";

const HOLDER = "exit-rsi-guard";

let _busy = false;

// In-memory only — same reasoning as stoploss-rsi-guard.js's pending map:
// a restart naturally re-evaluates fresh next tick.
const pending = new Map(); // position -> { type, since, lastRsiCheckAt, lastRsi, baseReason }

/**
 * Re-derive whether a position currently matches one of the four exit
 * conditions — same logic and precedence as the real rules (state.js's
 * updatePnlAndCheckExits for trailing TP; index.js's
 * getDeterministicCloseRule for take profit/OOR/low yield, in that rule
 * order), kept in sync deliberately (this file's checks exist ONLY to
 * re-detect what those would have matched, for positions where the
 * corresponding *RsiConfirm flag made them stand down).
 */
function evaluateExitCandidate(p, tracked, mgmtConfig) {
  if (!tracked) return null;

  if (mgmtConfig.trailingTpRsiConfirm && tracked.trailing_active && !p.pnl_pct_suspicious && p.pnl_pct != null && tracked.peak_pnl_pct != null) {
    const pumpedFarAboveRange =
      p.active_bin != null &&
      p.upper_bin != null &&
      mgmtConfig.outOfRangeBinsToClose != null &&
      p.active_bin > p.upper_bin + mgmtConfig.outOfRangeBinsToClose;
    const dropThreshold = pumpedFarAboveRange
      ? (mgmtConfig.pumpTrailingDropPct ?? mgmtConfig.trailingDropPct)
      : mgmtConfig.trailingDropPct;
    const dropFromPeak = tracked.peak_pnl_pct - p.pnl_pct;
    if (dropFromPeak >= dropThreshold) {
      return {
        type: "trailing_tp",
        threshold: Number(mgmtConfig.exitRsiThreshold ?? 70),
        baseReason: pumpedFarAboveRange
          ? `Pump trailing stop: peak ${tracked.peak_pnl_pct.toFixed(2)}% → current ${p.pnl_pct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${dropThreshold}%, pumped far above range)`
          : `Trailing TP: peak ${tracked.peak_pnl_pct.toFixed(2)}% → current ${p.pnl_pct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${dropThreshold}%)`,
      };
    }
  }

  // Fixed take-profit — unlike the other three, this one has no home in
  // state.js at all, it only ever lived in index.js's
  // getDeterministicCloseRule (rule 2). Own dedicated threshold
  // (takeProfitRsiThreshold, not exitRsiThreshold) — see config.js's
  // comment for why.
  if (mgmtConfig.takeProfitRsiConfirm && !p.pnl_pct_suspicious && p.pnl_pct != null && mgmtConfig.takeProfitPct != null && p.pnl_pct >= mgmtConfig.takeProfitPct) {
    return {
      type: "take_profit",
      threshold: Number(mgmtConfig.takeProfitRsiThreshold ?? 70),
      baseReason: `Take profit: PnL ${p.pnl_pct.toFixed(2)}% >= ${mgmtConfig.takeProfitPct}%`,
    };
  }

  if (mgmtConfig.oorRsiConfirm && tracked.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return { type: "oor", threshold: Number(mgmtConfig.exitRsiThreshold ?? 70), baseReason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)` };
    }
  }

  if (mgmtConfig.lowYieldRsiConfirm && p.fee_per_tvl_24h != null && mgmtConfig.minFeePerTvl24h != null) {
    const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
    if (p.fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h && (p.age_minutes == null || p.age_minutes >= minAgeForYieldCheck)) {
      return { type: "low_yield", threshold: Number(mgmtConfig.exitRsiThreshold ?? 70), baseReason: `Low yield: fee/TVL ${p.fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${p.age_minutes ?? "?"}m)` };
    }
  }

  return null;
}

async function closePosition(executeTool, p, reason) {
  try {
    const res = await executeTool("close_position", { position_address: p.position, reason }, { trusted: true, source: HOLDER }).catch((e) => ({ error: e.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    log("exit_rsi", `${p.pair}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
  } catch (e) {
    log("cron_error", `Exit RSI-confirm close failed for ${p.pair}: ${e.message}`);
  }
}

/**
 * Check all open positions against the four RSI-gated exit conditions:
 * wait for RSI(2) to reach the configured threshold (or the safety
 * timeout) before actually closing. Called from a dedicated cron interval
 * in index.js.
 */
export async function checkExitRsiConfirm() {
  const mgmtConfig = config.management;
  if (!mgmtConfig.trailingTpRsiConfirm && !mgmtConfig.takeProfitRsiConfirm && !mgmtConfig.oorRsiConfirm && !mgmtConfig.lowYieldRsiConfirm) return; // nothing enabled — skip the whole cycle
  if (_busy) return;
  _busy = true;

  try {
    const rsiInterval = mgmtConfig.stopLossRsiInterval || "15_MINUTE"; // reuse the same interval knob as the stop-loss guard — one place to set candle granularity, not a separate one per rule
    const rsiLength = Number(mgmtConfig.stopLossRsiLength ?? 2);
    const maxWaitMs = Math.max(1, Number(mgmtConfig.exitRsiMaxWaitMinutes ?? 30)) * 60_000;
    const recheckMs = Math.max(10, Number(mgmtConfig.exitRsiRecheckSec ?? 60)) * 1000;

    // Lazy imports to avoid module-load-order cycles, same pattern as liquidity-guard.js / stoploss-rsi-guard.js.
    const { getMyPositions } = await import("./tools/dlmm.js");
    const { executeTool } = await import("./tools/executor.js");
    const { fetchChartIndicatorsForMint } = await import("./tools/chart-indicators.js");

    const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
    if (!live?.positions?.length) {
      for (const id of pending.keys()) releaseRsiWaitLock(id, HOLDER);
      pending.clear();
      return;
    }
    const openIds = new Set(live.positions.map((p) => p.position));
    for (const id of pending.keys()) {
      if (!openIds.has(id)) {
        releaseRsiWaitLock(id, HOLDER);
        pending.delete(id); // position closed elsewhere — stop tracking it
      }
    }

    for (const p of live.positions) {
      const tracked = getTrackedPosition(p.position);
      const candidate = evaluateExitCandidate(p, tracked, mgmtConfig);
      const entry = pending.get(p.position);

      if (!candidate) {
        if (entry) {
          log("exit_rsi", `${p.pair}: ${entry.type} condition no longer met — clearing pending RSI wait, no close needed`);
          releaseRsiWaitLock(p.position, HOLDER);
          pending.delete(p.position);
        }
        continue;
      }

      if (!entry || entry.type !== candidate.type) {
        // New trigger, or the matched condition changed type since the
        // last tick (e.g. dropped out of trailing-TP range but is now OOR)
        // — restart the wait against the new condition rather than
        // carrying over a stale timer (and threshold) for a different rule.
        // Another guard (e.g. liquidity-guard.js) may already be waiting on
        // this exact position for its own reason — don't start a competing
        // wait; tools/executor.js's close_position gate keeps the position
        // safe from an unclaimed close in the meantime, so it's fine to
        // just try again next tick.
        if (!acquireRsiWaitLock(p.position, HOLDER)) {
          log("exit_rsi", `${p.pair}: ${candidate.type} triggered but another guard already holds this position's RSI-wait lock — deferring`);
          continue;
        }
        pending.set(p.position, { type: candidate.type, threshold: candidate.threshold, since: Date.now(), lastRsiCheckAt: 0, lastRsi: null, baseReason: candidate.baseReason });
        log("exit_rsi", `${p.pair}: ${candidate.type} triggered (${candidate.baseReason}) — waiting for RSI(${rsiLength})@${rsiInterval} >= ${candidate.threshold} before closing (safety timeout ${maxWaitMs / 60000}m)`);
        continue; // don't fetch RSI on the same tick it first triggers — give it a beat
      }

      const waitedMs = Date.now() - entry.since;
      if (waitedMs >= maxWaitMs) {
        log("exit_rsi", `${p.pair}: ${(maxWaitMs / 60000).toFixed(0)}m safety timeout reached with no RSI confirmation — closing now regardless`);
        await closePosition(executeTool, p, `${entry.baseReason} (RSI-confirm timeout: no RSI(${rsiLength})@${rsiInterval}>=${entry.threshold} within ${(maxWaitMs / 60000).toFixed(0)}m)`);
        releaseRsiWaitLock(p.position, HOLDER);
        pending.delete(p.position);
        continue;
      }

      if (Date.now() - entry.lastRsiCheckAt < recheckMs) continue;
      entry.lastRsiCheckAt = Date.now();

      let rsi = null;
      try {
        if (!p.base_mint) throw new Error("position has no base_mint on file");
        const payload = await fetchChartIndicatorsForMint(p.base_mint, { interval: rsiInterval, rsiLength });
        rsi = safeNumber(payload?.latest?.rsi?.value);
      } catch (e) {
        log("exit_rsi", `${p.pair}: RSI check failed (${e.message.slice(0, 100)}) — still waiting, ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
        continue;
      }
      entry.lastRsi = rsi;

      if (rsi != null && rsi >= entry.threshold) {
        log("exit_rsi", `${p.pair}: RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${entry.threshold} — closing now (waited ${(waitedMs / 60000).toFixed(1)}m for a better exit)`);
        await closePosition(executeTool, p, `${entry.baseReason} (RSI-confirmed: RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${entry.threshold})`);
        releaseRsiWaitLock(p.position, HOLDER);
        pending.delete(p.position);
      } else {
        log("exit_rsi", `${p.pair}: still waiting — RSI(${rsiLength})@${rsiInterval}=${rsi ?? "n/a"} (need >=${entry.threshold}), ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
      }
    }
  } finally {
    _busy = false;
  }
}
