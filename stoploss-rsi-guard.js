/**
 * stoploss-rsi-guard.js — stop-loss that waits for an RSI bounce before
 * selling, instead of closing the instant the threshold is crossed.
 *
 * Rationale: a stop-loss triggered at the exact moment PnL crosses the
 * threshold sells into whatever the price is at that instant — often the
 * worst possible moment, mid-crash. If price is genuinely going to keep
 * falling, waiting doesn't help; but a real reversal frequently follows a
 * sharp drop (the "sell the panic" pattern), and RSI(2) — a fast,
 * short-period oscillator — is specifically built to catch that kind of
 * quick bounce. This module waits for RSI to reach an overbought reading
 * before actually closing, hoping to exit into strength rather than into
 * the drop itself.
 *
 * RSI comes from tools/chart-indicators.js (fetchChartIndicatorsForMint),
 * which sources candles from Meridian's own backend — no new external
 * dependency needed here, unlike the Robinhood-Chain fork this was ported
 * from, which had to add a GeckoTerminal client because its chain wasn't
 * covered by that backend. Solana already is.
 *
 * SAFETY: waiting for a condition that might never arrive is a real risk —
 * a token that just keeps falling would otherwise never trigger a close,
 * turning a bounded stop-loss into unbounded downside exposure. This is
 * why stopLossRsiMaxWaitMinutes exists and is NOT optional: past that
 * timeout, the position closes regardless of RSI (AND regardless of range
 * status — see below), falling back to the original "just close it"
 * behavior. The RSI wait is a best-effort improvement on exit price, never
 * a reason to hold longer than the original stop-loss intended.
 *
 * BUG FIXED 2026-08-16: the safety-timeout clock used to be tied to
 * `pending`'s `since` field, which got deleted — clock and all — every
 * time PnL ticked back above the stop-loss line, even for a single poll.
 * A position oscillating around the threshold (exactly the choppy price
 * action a token in real trouble tends to show) could reset its "NOT
 * optional" 24h clock indefinitely and never actually reach it. Real
 * production incident: K-HOME-SOL crossed the stop-loss line and recovered
 * above it 5 times in 75 minutes, restarting the full safety timeout each
 * time; the position was never rescued by this guard's own backstop at
 * all — it kept falling for 18 hours and was only eventually closed by an
 * unrelated feature (fee-stall-guard.js), by which point it had lost an
 * extra ~23 percentage points versus where the "guaranteed" timeout should
 * have capped it.
 *
 * Fix: `firstHitAt` (in the separate `stopLossHistory` map below) is the
 * safety-timeout clock's origin, and it is NOT cleared just because PnL
 * ticks back above the threshold for a moment — only after PnL has stayed
 * OUT of stop-loss territory continuously for stopLossRsiResetAfterMinutes
 * (default 120m) is the episode considered genuinely over and the clock
 * allowed to reset for a future, unrelated dip. `pending`'s own `since`
 * (this specific active wait) is untouched and still governs RSI-recheck
 * throttling and the "no close needed, PnL recovered" log line — only the
 * safety-timeout comparison itself now reads from `firstHitAt`.
 *
 * config.management.stopLossRsiRequireOutOfRange (default true) adds one
 * more condition to the early-exit path: even once RSI confirms, don't
 * actually close while the position is still in range — it's still
 * earning fees against the loss, so there's no rush. Only fires the close
 * once BOTH RSI has confirmed AND the position is out of range. This does
 * NOT touch the safety timeout above — that always closes regardless of
 * RSI or range once stopLossRsiMaxWaitMinutes is reached, same as before.
 *
 * Toggle: config.management.stopLossRsiConfirm (default false). When on,
 * the immediate stop-loss triggers in state.js and index.js stand down —
 * see the bypass comments there — and this module owns the close decision.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { safeNumber } from "./utils/number.js";
import { acquireRsiWaitLock, releaseRsiWaitLock } from "./rsi-wait-lock.js";

const HOLDER = "stoploss-rsi-guard";

let _busy = false;

// In-memory only — a restart naturally re-evaluates fresh next tick, same
// as this codebase's other exit-confirmation state that isn't meant to
// survive a restart (e.g. the fast PnL poller's own confirmTicks streaks
// are similarly transient by design).
const pending = new Map(); // position -> { since, lastRsiCheckAt, lastRsi } — the CURRENT active RSI-wait
// position -> { firstHitAt, recoveredAt } — the safety-timeout clock's
// origin. Deliberately a SEPARATE map from `pending`, and NOT cleared on
// every brief recovery — see the BUG FIXED header comment above.
const stopLossHistory = new Map();

async function closePosition(executeTool, p, reason) {
  try {
    const res = await executeTool("close_position", { position_address: p.position, reason }, { trusted: true, source: HOLDER }).catch((e) => ({ error: e.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    log("stoploss_rsi", `${p.pair}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
  } catch (e) {
    log("cron_error", `Stop-loss RSI-confirm close failed for ${p.pair}: ${e.message}`);
  }
}

/**
 * Check all open positions currently below the stop-loss threshold: wait
 * for an RSI bounce (or the safety timeout) before actually closing.
 * Called from a dedicated cron interval in index.js.
 */
export async function checkStopLossRsiConfirm() {
  if (!config.management.stopLossRsiConfirm) return;
  // Same master switch as state.js/index.js's stop-loss paths — see
  // config.management.stopLossEnabled's comment in config.js.
  if (config.management.stopLossEnabled === false) return;
  if (_busy) return;
  _busy = true;

  try {
    const stopLossPct = config.management.stopLossPct;
    if (stopLossPct == null) return; // nothing to confirm against

    const rsiThreshold = Number(config.management.stopLossRsiThreshold ?? 85);
    const rsiInterval = config.management.stopLossRsiInterval || "15_MINUTE";
    const rsiLength = Number(config.management.stopLossRsiLength ?? 2);
    const maxWaitMs = Math.max(1, Number(config.management.stopLossRsiMaxWaitMinutes ?? 30)) * 60_000;
    const recheckMs = Math.max(10, Number(config.management.stopLossRsiRecheckSec ?? 60)) * 1000;
    const resetAfterMs = Math.max(1, Number(config.management.stopLossRsiResetAfterMinutes ?? 120)) * 60_000;

    // Lazy imports to avoid module-load-order cycles, same pattern as liquidity-guard.js.
    const { getMyPositions } = await import("./tools/dlmm.js");
    const { executeTool } = await import("./tools/executor.js");
    const { fetchChartIndicatorsForMint } = await import("./tools/chart-indicators.js");

    const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
    if (!live?.positions?.length) {
      for (const id of pending.keys()) releaseRsiWaitLock(id, HOLDER);
      pending.clear(); // nothing open — clear any stale pending state
      stopLossHistory.clear();
      return;
    }
    const openIds = new Set(live.positions.map((p) => p.position));
    for (const id of pending.keys()) {
      if (!openIds.has(id)) {
        releaseRsiWaitLock(id, HOLDER);
        pending.delete(id); // position closed elsewhere — stop tracking it
      }
    }
    for (const id of stopLossHistory.keys()) {
      if (!openIds.has(id)) stopLossHistory.delete(id);
    }

    for (const p of live.positions) {
      if (p.pnl_pct_suspicious || p.pnl_pct == null) continue;
      const inStopLoss = p.pnl_pct <= stopLossPct;
      const entry = pending.get(p.position);
      const history = stopLossHistory.get(p.position);

      if (!inStopLoss) {
        if (entry) {
          log("stoploss_rsi", `${p.pair}: PnL recovered above stop-loss (${p.pnl_pct.toFixed(2)}% > ${stopLossPct}%) — clearing pending RSI wait, no close needed`);
          releaseRsiWaitLock(p.position, HOLDER);
          pending.delete(p.position);
        }
        // Safety-timeout clock (stopLossHistory) is intentionally NOT
        // cleared here just because this one tick recovered — only after
        // a SUSTAINED recovery (resetAfterMs) is the episode considered
        // over. See the BUG FIXED header comment for why.
        if (history) {
          if (!history.recoveredAt) {
            history.recoveredAt = Date.now();
          } else if (Date.now() - history.recoveredAt >= resetAfterMs) {
            log("stoploss_rsi", `${p.pair}: PnL has stayed above stop-loss for ${(resetAfterMs / 60000).toFixed(0)}m — clearing stop-loss history, a future dip starts a fresh safety-timeout clock`);
            stopLossHistory.delete(p.position);
          }
        }
        continue;
      }

      // Back in stop-loss territory — if we'd started a recovery clock,
      // it wasn't sustained; cancel it, but keep firstHitAt as-is (same
      // episode, not a fresh one).
      if (history?.recoveredAt) history.recoveredAt = null;

      if (!entry) {
        // Another guard (e.g. liquidity-guard.js) may already be waiting on
        // this exact position for its own reason — don't start a competing
        // wait; the position isn't going anywhere unclaimed in the
        // meantime (tools/executor.js's close_position gate enforces that),
        // so it's safe to just try again next tick.
        if (!acquireRsiWaitLock(p.position, HOLDER)) {
          log("stoploss_rsi", `${p.pair}: hit stop-loss but another guard already holds this position's RSI-wait lock — deferring`);
          continue;
        }
        if (!history) {
          stopLossHistory.set(p.position, { firstHitAt: Date.now(), recoveredAt: null });
        }
        pending.set(p.position, { since: Date.now(), lastRsiCheckAt: 0, lastRsi: null });
        log("stoploss_rsi", `${p.pair}: hit stop-loss (${p.pnl_pct.toFixed(2)}% <= ${stopLossPct}%) — waiting for RSI(${rsiLength})@${rsiInterval} >= ${rsiThreshold} before closing (safety timeout ${maxWaitMs / 60000}m)`);
        continue; // don't fetch RSI on the same tick it first triggers — give it a beat
      }

      // Safety-timeout clock reads from stopLossHistory's firstHitAt, NOT
      // entry.since — this is the actual fix. entry.since (this specific
      // active wait's start) still governs RSI-recheck throttling below.
      const firstHitAt = stopLossHistory.get(p.position)?.firstHitAt ?? entry.since;
      const waitedMs = Date.now() - firstHitAt;
      if (waitedMs >= maxWaitMs) {
        log("stoploss_rsi", `${p.pair}: ${(maxWaitMs / 60000).toFixed(0)}m safety timeout reached with no RSI confirmation — closing now regardless (never hold a loss indefinitely waiting for a bounce that may not come)`);
        await closePosition(executeTool, p, `Stop loss (RSI-confirm timeout): PnL ${p.pnl_pct.toFixed(2)}% <= ${stopLossPct}%, no RSI(${rsiLength})@${rsiInterval}>=${rsiThreshold} within ${(maxWaitMs / 60000).toFixed(0)}m`);
        releaseRsiWaitLock(p.position, HOLDER);
        pending.delete(p.position);
        stopLossHistory.delete(p.position);
        continue;
      }

      // Throttle actual RSI fetches — checking every single guard tick is
      // both wasteful (RSI on a 15m candle can't meaningfully change every
      // few seconds) and adds real API load for no benefit.
      if (Date.now() - entry.lastRsiCheckAt < recheckMs) continue;
      entry.lastRsiCheckAt = Date.now();

      let rsi = null;
      try {
        if (!p.base_mint) throw new Error("position has no base_mint on file");
        const payload = await fetchChartIndicatorsForMint(p.base_mint, { interval: rsiInterval, rsiLength });
        rsi = safeNumber(payload?.latest?.rsi?.value);
      } catch (e) {
        log("stoploss_rsi", `${p.pair}: RSI check failed (${e.message.slice(0, 100)}) — still waiting, ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
        continue;
      }
      entry.lastRsi = rsi;

      if (rsi != null && rsi >= rsiThreshold) {
        if (config.management.stopLossRsiRequireOutOfRange && p.in_range !== false) {
          log("stoploss_rsi", `${p.pair}: RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${rsiThreshold} confirmed, but still in range (still earning) — holding, ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
          continue;
        }
        log("stoploss_rsi", `${p.pair}: RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${rsiThreshold} — closing now (waited ${(waitedMs / 60000).toFixed(1)}m for a better exit)`);
        await closePosition(executeTool, p, `Stop loss (RSI-confirmed): PnL ${p.pnl_pct.toFixed(2)}% <= ${stopLossPct}%, RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${rsiThreshold}`);
        releaseRsiWaitLock(p.position, HOLDER);
        pending.delete(p.position);
        stopLossHistory.delete(p.position);
      } else {
        log("stoploss_rsi", `${p.pair}: still waiting — RSI(${rsiLength})@${rsiInterval}=${rsi ?? "n/a"} (need >=${rsiThreshold}), ${((maxWaitMs - waitedMs) / 60000).toFixed(1)}m left before timeout fallback`);
      }
    }
  } finally {
    _busy = false;
  }
}
