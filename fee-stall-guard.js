/**
 * fee-stall-guard.js — force-closes a position whose fee accrual has
 * genuinely STOPPED recently, even if it earned well earlier in its life.
 *
 * Why this is different from LOW_YIELD (state.js/index.js): that check
 * looks at fee_per_tvl_24h, a trailing-24h AVERAGE. A position that earned
 * well 12 hours ago and has been completely dead for the last 6 can still
 * read as "yield OK" on that average — the earlier activity props up the
 * number even though right now it's earning nothing. This guard tracks a
 * different thing: TIME SINCE FEES LAST ACTUALLY INCREASED, regardless of
 * what happened earlier in the position's life. A position deployed 12h
 * ago that earned well for its first 6h and has generated exactly $0 more
 * since gets caught here well before a 24h average would ever flag it.
 *
 * Tracks TOTAL LIFETIME FEES (claimed + currently-unclaimed), not just
 * unclaimed — comparing only unclaimed would misread a claim event (which
 * resets unclaimed to ~0) as a stall. Summing both gives a value that only
 * ever increases from genuine new fee accrual, immune to claim timing.
 *
 * Skips positions currently pnl_pct_suspicious — fee data can't be
 * trusted on those either; dead-position-guard.js owns that case instead.
 *
 * Toggle: config.management.feeStallGuardEnabled (default false — an
 * opt-in strategy choice, not a safety backstop like dead-position-guard,
 * so it follows the same off-by-default convention as the other optional
 * exit strategies in this codebase).
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { getTrackedPosition } from "./state.js";

let _busy = false;

// In-memory only, same reasoning as every other guard's pending state in
// this codebase — a restart just re-baselines from whatever the position's
// current lifetime-fee total is and starts the clock over from there,
// which is fine; feeStallThresholdHours is long enough that a restart
// mid-window isn't meaningfully delaying anything.
const feeHistory = new Map(); // position -> { lastTotalFees, lastIncreaseAt }

export async function checkFeeStall() {
  if (!config.management.feeStallGuardEnabled) return;
  if (_busy) return;
  _busy = true;

  try {
    const stallMs = Math.max(1, Number(config.management.feeStallThresholdHours ?? 6)) * 3_600_000;
    const minAgeMs = Math.max(0, Number(config.management.feeStallMinAgeMinutes ?? 60)) * 60_000;

    const { getMyPositions } = await import("./tools/dlmm.js");
    const { executeTool } = await import("./tools/executor.js");

    const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
    if (!live?.positions?.length) {
      feeHistory.clear();
      return;
    }
    const openIds = new Set(live.positions.map((p) => p.position));
    for (const id of feeHistory.keys()) if (!openIds.has(id)) feeHistory.delete(id); // closed elsewhere — stop tracking it

    for (const p of live.positions) {
      if (p.pnl_pct_suspicious) continue; // can't trust fee data here — dead-position-guard owns this case

      const tracked = getTrackedPosition(p.position);
      const deployedAt = tracked?.deployed_at ? new Date(tracked.deployed_at).getTime() : null;
      if (deployedAt != null && Date.now() - deployedAt < minAgeMs) continue; // too new — hasn't had a fair chance to earn yet

      const unclaimed = Number(p.unclaimed_fees_true_usd ?? p.unclaimed_fees_usd ?? p.unclaimed_fee_usd ?? 0);
      const claimed = Number(tracked?.total_fees_claimed_usd ?? 0);
      const totalLifetimeFees = (Number.isFinite(unclaimed) ? unclaimed : 0) + (Number.isFinite(claimed) ? claimed : 0);

      const prev = feeHistory.get(p.position);
      if (!prev || totalLifetimeFees > prev.lastTotalFees + 1e-6) {
        // First time seeing this position, or genuine new fee accrual
        // since the last check — (re)start the clock.
        feeHistory.set(p.position, { lastTotalFees: totalLifetimeFees, lastIncreaseAt: Date.now() });
        continue;
      }

      const stalledForMs = Date.now() - prev.lastIncreaseAt;
      if (stalledForMs < stallMs) continue; // still within the window — could still pick back up

      const reason = `Fee stall: no new fees earned in ${(stalledForMs / 3_600_000).toFixed(1)}h (limit ${(stallMs / 3_600_000).toFixed(1)}h) — total lifetime fees stuck at $${totalLifetimeFees.toFixed(2)}`;
      log("fee_stall_guard", `${p.pair}: ${reason}`);
      try {
        const res = await executeTool("close_position", { position_address: p.position, reason }, { trusted: true, source: "fee-stall-guard", signalType: "FEE_STALL" }).catch((e) => ({ error: e.message }));
        const ok = res?.success !== false && !res?.error && !res?.blocked;
        log("fee_stall_guard", `${p.pair}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
        if (ok) feeHistory.delete(p.position);
      } catch (e) {
        log("cron_error", `Fee-stall close failed for ${p.pair}: ${e.message}`);
      }
    }
  } finally {
    _busy = false;
  }
}
