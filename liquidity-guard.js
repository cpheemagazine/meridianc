/**
 * liquidity-guard.js — real-time TVL/volume collapse detection.
 *
 * The normal stop-loss reacts to PnL, which is a mark-to-market price read.
 * On a thin pool, price can lag an actual liquidity pull by several ticks —
 * by the time PnL has caught up enough to trip the stop-loss threshold, the
 * position may already be exiting into a pool that's lost most of its real
 * depth, producing far worse realized slippage than the stop-loss threshold
 * ever implied. This module watches TVL/volume directly (not price) and
 * closes fast once either collapses relative to its own recent rolling high
 * — catching the root cause (liquidity disappearing) rather than waiting for
 * the lagging symptom (price finally reflecting it).
 *
 * Toggle: config.management.volumeTrendEnabled (user-config.json key
 * "volumeTrendEnabled") — reuses the exact key name from the pre-existing
 * (previously unwired) config so no config changes are needed to activate
 * this for anyone who already had it set.
 *
 * config.management.liquidityRsiConfirm (default false) changes what
 * happens once a collapse is CONFIRMED (registerExitSignal's confirm-tick
 * state machine below is unaffected either way — same detection, same
 * noise-filtering): instead of closing immediately, waits for RSI(2) to
 * reach exitRsiThreshold (or its own safety timeout, exitRsiMaxWaitMinutes)
 * before actually closing — same shared config trailingTpRsiConfirm/
 * oorRsiConfirm/lowYieldRsiConfirm already use, same "sell into strength
 * instead of into whatever the price happens to be" reasoning. Handled by
 * checkLiquidityRsiConfirm() below, called from its own faster cron tick
 * (exitRsiGuardIntervalMin) — kept separate from checkLiquidityCollapse's
 * own (slower) detection cadence deliberately, so waiting for an RSI
 * bounce doesn't also slow down how fast a genuine collapse gets detected.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { getTrackedPositions, recordLiquiditySample, registerExitSignal } from "./state.js";
import { safeNumber } from "./utils/number.js";
import { acquireRsiWaitLock, releaseRsiWaitLock } from "./rsi-wait-lock.js";

const HOLDER = "liquidity-guard";
const CONFIRM_TICKS = 2; // consecutive checks required before acting — one bad API read can't trigger a close

let _busy = false;

// Positions whose liquidity collapse is confirmed but waiting on
// liquidityRsiConfirm — separate from registerExitSignal's confirm-tick
// state above (that's about confirming the collapse itself; this is about
// what happens once it's already confirmed). position -> { since,
// lastRsiCheckAt, baseReason }.
const pendingRsiConfirm = new Map();

/**
 * Check all open positions for a TVL/volume collapse relative to their own
 * recent rolling high, and close directly (no LLM) on confirmed collapse.
 * Called from a dedicated cron interval in index.js, cadence =
 * config.management.volumeTrendCheckIntervalMin minutes.
 */
export async function checkLiquidityCollapse() {
  if (config.management.volumeTrendEnabled === false) return;
  if (_busy) return;
  _busy = true;

  try {
    const open = getTrackedPositions(true);
    if (open.length === 0) return;

    // Lazy import to avoid a module-load-order cycle with tools/dlmm.js.
    const { fetchPoolMarketSnapshot } = await import("./tools/dlmm.js");
    const { executeTool } = await import("./tools/executor.js");

    const thresholdPct = Number(config.management.volumeTrendCollapseThresholdPct ?? -60);
    const minBaseline = Number(config.management.volumeTrendMinBaselineVolume ?? 1000);

    for (const pos of open) {
      let snap;
      try {
        snap = await fetchPoolMarketSnapshot(pos.pool);
      } catch (e) {
        log("liquidity_guard", `Snapshot failed for ${pos.pool?.slice(0, 8)}: ${e.message}`);
        continue;
      }
      if (snap.tvl == null && snap.volume == null) continue;

      const sample = recordLiquiditySample(pos.position, { tvl: snap.tvl, volume: snap.volume });
      if (!sample) continue; // first sample for this position — nothing to compare against yet

      // Only evaluate against a baseline that was actually meaningful — avoids
      // false positives on a pool that was already near-zero-volume/thin from
      // the start (nothing to "collapse" from).
      const tvlBaselineUsable = sample.baselineTvl >= minBaseline;
      const volumeBaselineUsable = sample.baselineVolume >= minBaseline;

      const tvlCollapsed = tvlBaselineUsable && sample.tvlDropPct != null && sample.tvlDropPct <= thresholdPct;
      const volumeCollapsed = volumeBaselineUsable && sample.volumeDropPct != null && sample.volumeDropPct <= thresholdPct;
      const collapsed = tvlCollapsed || volumeCollapsed;

      const signal = collapsed ? "LIQUIDITY_COLLAPSE" : null;
      const { fire } = registerExitSignal(pos.position, signal, CONFIRM_TICKS, "liquidity");

      if (collapsed) {
        const which = tvlCollapsed
          ? `TVL $${sample.baselineTvl.toFixed(0)} → $${sample.currentTvl.toFixed(0)} (${sample.tvlDropPct.toFixed(1)}%)`
          : `volume $${sample.baselineVolume.toFixed(0)} → $${sample.currentVolume.toFixed(0)} (${sample.volumeDropPct.toFixed(1)}%)`;
        log("liquidity_guard", `${pos.pool_name || pos.pool?.slice(0, 8)}: collapse detected — ${which}${fire ? " — CONFIRMED, closing" : " — awaiting confirmation"}`);
      }

      if (!fire) continue;

      const reason = tvlCollapsed
        ? `Liquidity collapse: TVL dropped ${sample.tvlDropPct.toFixed(1)}% from recent high ($${sample.baselineTvl.toFixed(0)} → $${sample.currentTvl.toFixed(0)})`
        : `Liquidity collapse: volume dropped ${sample.volumeDropPct.toFixed(1)}% from recent high ($${sample.baselineVolume.toFixed(0)} → $${sample.currentVolume.toFixed(0)})`;

      if (config.management.liquidityRsiConfirm) {
        if (!pendingRsiConfirm.has(pos.position)) {
          // Another guard (e.g. stoploss-rsi-guard.js) may already be
          // waiting on this exact position for its own reason — don't
          // start a competing wait; tools/executor.js's close_position
          // gate keeps the position safe from an unclaimed close in the
          // meantime, so it's fine to just try again next tick.
          if (!acquireRsiWaitLock(pos.position, HOLDER)) {
            log("liquidity_guard", `${pos.pool_name || pos.pool}: collapse CONFIRMED but another guard already holds this position's RSI-wait lock — deferring`);
            continue;
          }
          pendingRsiConfirm.set(pos.position, { since: Date.now(), lastRsiCheckAt: 0, baseReason: reason });
          log("liquidity_guard", `${pos.pool_name || pos.pool}: collapse CONFIRMED — liquidityRsiConfirm is on, waiting for RSI(${Number(config.management.stopLossRsiLength ?? 2)}) >= ${Number(config.management.exitRsiThreshold ?? 70)} before closing (checkLiquidityRsiConfirm handles this on its own faster cadence)`);
        }
        continue; // checkLiquidityRsiConfirm() owns the close from here
      }

      log("liquidity_guard", `${pos.pool_name || pos.pool}: CLOSING — ${reason}`);

      try {
        const res = await executeTool("close_position", { position_address: pos.position, reason }, { trusted: true, source: HOLDER }).catch((e) => ({ error: e.message }));
        const ok = res?.success !== false && !res?.error && !res?.blocked;
        log("liquidity_guard", `${pos.pool_name}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
      } catch (e) {
        log("cron_error", `Liquidity-collapse close failed for ${pos.pool_name}: ${e.message}`);
      }
    }
  } finally {
    _busy = false;
  }
}

/**
 * For positions whose liquidity collapse is confirmed and waiting on
 * liquidityRsiConfirm: check RSI, close once it reaches exitRsiThreshold
 * (or the exitRsiMaxWaitMinutes safety timeout elapses — never waits
 * forever, same guarantee every other RSI-confirm feature in this
 * codebase makes). Called from its own cron interval in index.js, on the
 * same faster cadence exit-rsi-guard.js uses (exitRsiGuardIntervalMin) —
 * deliberately not tied to checkLiquidityCollapse's own slower detection
 * cadence, so waiting for a bounce doesn't also slow down collapse
 * detection itself.
 */
export async function checkLiquidityRsiConfirm() {
  if (!config.management.liquidityRsiConfirm) return;
  if (pendingRsiConfirm.size === 0) return;

  const threshold = Number(config.management.exitRsiThreshold ?? 70);
  const rsiInterval = config.management.stopLossRsiInterval || "15_MINUTE";
  const rsiLength = Number(config.management.stopLossRsiLength ?? 2);
  const maxWaitMs = Math.max(1, Number(config.management.exitRsiMaxWaitMinutes ?? 30)) * 60_000;
  const recheckMs = Math.max(10, Number(config.management.exitRsiRecheckSec ?? 60)) * 1000;

  const { getMyPositions } = await import("./tools/dlmm.js");
  const { executeTool } = await import("./tools/executor.js");
  const { fetchChartIndicatorsForMint } = await import("./tools/chart-indicators.js");

  const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
  const liveById = new Map((live?.positions || []).map((p) => [p.position, p]));

  for (const [position, entry] of [...pendingRsiConfirm.entries()]) {
    const p = liveById.get(position);
    if (!p) {
      // Closed elsewhere (manual close, another guard, etc.) — stop tracking it.
      releaseRsiWaitLock(position, HOLDER);
      pendingRsiConfirm.delete(position);
      continue;
    }

    const waitedMs = Date.now() - entry.since;
    if (waitedMs >= maxWaitMs) {
      log("liquidity_guard", `${p.pair}: ${(maxWaitMs / 60000).toFixed(0)}m RSI-confirm safety timeout reached — closing now regardless`);
      await closeLiquidityPosition(executeTool, p, `${entry.baseReason} (RSI-confirm timeout: no RSI(${rsiLength})@${rsiInterval}>=${threshold} within ${(maxWaitMs / 60000).toFixed(0)}m)`);
      releaseRsiWaitLock(position, HOLDER);
      pendingRsiConfirm.delete(position);
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
      log("liquidity_guard", `${p.pair}: RSI check failed (${e.message.slice(0, 100)}) — still waiting, ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
      continue;
    }

    if (rsi != null && rsi >= threshold) {
      log("liquidity_guard", `${p.pair}: RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${threshold} — closing now (waited ${(waitedMs / 60000).toFixed(1)}m for a better exit)`);
      await closeLiquidityPosition(executeTool, p, `${entry.baseReason} (RSI-confirmed: RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${threshold})`);
      releaseRsiWaitLock(position, HOLDER);
      pendingRsiConfirm.delete(position);
    } else {
      log("liquidity_guard", `${p.pair}: still waiting — RSI(${rsiLength})@${rsiInterval}=${rsi ?? "n/a"} (need >=${threshold}), ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
    }
  }
}

async function closeLiquidityPosition(executeTool, p, reason) {
  try {
    const res = await executeTool("close_position", { position_address: p.position, reason }, { trusted: true, source: HOLDER }).catch((e) => ({ error: e.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    log("liquidity_guard", `${p.pair}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
  } catch (e) {
    log("cron_error", `Liquidity-collapse RSI-confirm close failed for ${p.pair}: ${e.message}`);
  }
}
