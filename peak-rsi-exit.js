/**
 * peak-rsi-exit.js — closes a position the moment a NEW peak PnL is
 * confirmed AND RSI(2) is already deep into overbought territory: sell
 * into strength right at a fresh high, instead of waiting for a pullback
 * to prove the top has actually formed.
 *
 * Different mechanism from stoploss-rsi-guard.js / exit-rsi-guard.js —
 * those WAIT for RSI to reach a threshold before executing a close that's
 * already been decided for some other reason (stop loss, trailing TP,
 * OOR, low yield, take profit). This is the reverse: RSI-overbought-at-a-
 * fresh-peak IS the decision, not a confirmation gate on one. No pending
 * state, no safety timeout — nothing to get stuck waiting on, it's a
 * single check-and-act every time a new peak is confirmed.
 *
 * Complementary to, not a replacement for, trailingDropPct/
 * trailingTpRsiConfirm: those wait for price to actually drop back from
 * the peak before closing (confirms the top formed, but gives back
 * whatever the drop threshold is). This tries to catch the exit right at
 * the top instead, when RSI suggests the move is exhausted — a different
 * tradeoff (better fill if right, no confirmation if wrong), not a
 * strictly-better version of the other.
 *
 * Toggle: config.management.peakRsiExitEnabled (default false).
 * config.management.peakRsiExitMinPnlPctEnabled (default true) adds a
 * floor — see peakRsiExitMinPnlPct in config.js for why.
 *
 * Its close carries signalType: "PEAK_RSI_EXIT", exempting it from
 * tools/executor.js's cross-guard RSI-wait-lock (see LOCK_EXEMPT_SIGNALS
 * there) — this guard already makes its own RSI check before deciding to
 * close (that's the whole function), so it isn't "waiting" on anything an
 * unrelated guard's lock should be protecting; blocking it just delays an
 * already-decided exit for no benefit.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { safeNumber } from "./utils/number.js";

// Per-position cooldown so a fast, choppy uptrend confirming many peaks in
// quick succession doesn't fire an RSI fetch on every single one — this
// module has no periodic cron tick of its own to throttle against (unlike
// the other guards), it only ever runs reactively when a peak is
// confirmed, so the throttle lives here instead.
const lastCheckedAt = new Map(); // position -> timestamp ms

/**
 * Call right after state.js's confirmPeak() returns true for a position
 * (a new peak PnL was just confirmed this tick). Fire-and-forget from the
 * caller's side — does its own async RSI fetch and close, and never
 * throws back to the caller (callers should still `.catch()` when
 * invoking this, as a second line of defense, same as every other
 * fire-and-forget call in this codebase).
 */
export async function checkPeakRsiExit(p) {
  if (!config.management.peakRsiExitEnabled) return;
  if (p.pnl_pct_suspicious || p.pnl_pct == null) return; // same guard the rest of this codebase applies before acting on pnl_pct

  // While still in range, the position is earning fees — no reason to sell
  // into strength just because RSI happens to spike at a fresh peak. This
  // strategy is meant for "no longer earning, so take the best exit
  // available" territory. `p.in_range !== false` (not just `!p.in_range`)
  // deliberately: skip on `true` OR unknown/null status — only proceed
  // once out-of-range is explicitly confirmed, not just unconfirmed.
  if (config.management.peakRsiExitRequireOutOfRange && p.in_range !== false) return;

  // Floor on how small a "peak" can be before it's worth selling into
  // strength for — see config.js's comment for the production data behind
  // this. `p.pnl_pct` here IS the peak just confirmed by the caller
  // (confirmPeak already validated it as a new high before invoking this).
  if (config.management.peakRsiExitMinPnlPctEnabled) {
    const minPnlPct = Number(config.management.peakRsiExitMinPnlPct ?? 3);
    if (p.pnl_pct < minPnlPct) return; // no log — this runs on every confirmed peak, logging every miss below the floor would be noise
  }

  const cooldownMs = Math.max(1, Number(config.management.peakRsiExitCooldownSec ?? 30)) * 1000;
  const last = lastCheckedAt.get(p.position) ?? 0;
  if (Date.now() - last < cooldownMs) return;
  lastCheckedAt.set(p.position, Date.now());

  if (!p.base_mint) return;

  const threshold = Number(config.management.peakRsiExitThreshold ?? 85);
  const rsiInterval = config.management.stopLossRsiInterval || "15_MINUTE"; // reuse the same interval knob the other RSI features use — one place to set candle granularity
  const rsiLength = Number(config.management.stopLossRsiLength ?? 2);

  try {
    const { fetchChartIndicatorsForMint } = await import("./tools/chart-indicators.js");
    const payload = await fetchChartIndicatorsForMint(p.base_mint, { interval: rsiInterval, rsiLength });
    const rsi = safeNumber(payload?.latest?.rsi?.value);
    if (rsi == null || rsi < threshold) return; // no log line for the common case — this runs on every confirmed peak, logging every miss would be noise

    const reason = `Peak RSI exit: new peak ${p.pnl_pct.toFixed(2)}% confirmed with RSI(${rsiLength})@${rsiInterval}=${rsi.toFixed(1)} >= ${threshold} — selling into strength`;
    log("peak_rsi_exit", `${p.pair}: ${reason}`);

    const { executeTool } = await import("./tools/executor.js");
    const res = await executeTool("close_position", { position_address: p.position, reason }, { trusted: true, source: "peak-rsi-exit", signalType: "PEAK_RSI_EXIT" }).catch((e) => ({ error: e.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    if (!ok) log("peak_rsi_exit", `${p.pair}: close FAILED — ${res?.error || res?.reason || "unknown"}`);
  } catch (e) {
    log("cron_error", `Peak RSI exit check failed for ${p.pair}: ${e.message}`);
  }
}
