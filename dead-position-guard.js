/**
 * dead-position-guard.js — force-closes a position that's been stuck
 * pnl_pct_suspicious (tools/pnl.js) for too long AND reads as effectively
 * worthless on-chain.
 *
 * Why this exists: pnl_pct_suspicious correctly disables stop-loss/
 * trailing-TP/etc when a position can't be reliably priced — that's the
 * right call moment-to-moment (better to hold briefly than act on garbage
 * data). tools/pnl.js's cost-basis fallback is supposed to cover the most
 * common cause (Meteora hasn't indexed a fresh deploy's deposit yet) by
 * falling back to the recorded deploy cost basis. But confirmed in
 * production 2026-08: a position (deposits never indexed, for reasons the
 * fallback evidently didn't cover — no state.json for it to inspect
 * after the fact) stayed suspicious for its ENTIRE ~27 hour life, with
 * $0 on-chain value the whole time. Every deterministic protection was
 * correctly stood down that whole time — because that's what suspicious
 * is supposed to do — but nothing ever stepped back in once it became
 * clear this wasn't a brief indexing delay, it was a dead position. It
 * only got closed because the hourly health-check LLM call happened to
 * keep noticing "$0 value" and eventually acted on its own.
 *
 * This is the deterministic version of that same judgment call: if a
 * position has been suspicious for longer than
 * deadPositionMaxSuspiciousMinutes AND its on-chain value is at or below
 * deadPositionMaxValueUsd (a small dust allowance, not exactly zero), it
 * gets force-closed regardless of the suspicious flag. Unlike the RSI
 * guards, this isn't waiting for a better exit price — there's no price
 * signal available at all here (that's the whole problem), so there's
 * nothing to wait for. It's purely "stop tying up a deploy slot and
 * relying on luck for something that's already worth nothing."
 *
 * Toggle: config.management.deadPositionGuardEnabled (default true — see
 * config.js's comment for why this one defaults on unlike the strategy
 * toggles elsewhere in this codebase).
 *
 * Its close carries signalType: "DEAD_POSITION", exempting it from
 * tools/executor.js's cross-guard RSI-wait-lock (see LOCK_EXEMPT_SIGNALS
 * there) — this guard's decision never depends on RSI or any wait of its
 * own, so it shouldn't be blockable by an unrelated guard's pending wait.
 * Confirmed costly before this was added: blocked 838 times across two
 * confirmed-$0 positions, one stretch over 2 hours, by liquidity-guard's
 * unrelated lock.
 */

import { log } from "./logger.js";
import { config } from "./config.js";

let _busy = false;

// In-memory only, same reasoning as every other guard's pending state in
// this codebase — a restart naturally re-evaluates fresh (a position
// that's still genuinely suspicious will just start its clock over,
// which is fine; deadPositionMaxSuspiciousMinutes is deliberately long
// enough that a restart mid-window isn't meaningfully delaying anything).
const firstSuspiciousAt = new Map(); // position -> timestamp ms

export async function checkDeadPositions() {
  if (!config.management.deadPositionGuardEnabled) return;
  if (_busy) return;
  _busy = true;

  try {
    const maxSuspiciousMs = Math.max(1, Number(config.management.deadPositionMaxSuspiciousMinutes ?? 60)) * 60_000;
    const maxValueUsd = Math.max(0, Number(config.management.deadPositionMaxValueUsd ?? 1.0));

    const { getMyPositions } = await import("./tools/dlmm.js");
    const { executeTool } = await import("./tools/executor.js");

    const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
    if (!live?.positions?.length) {
      firstSuspiciousAt.clear();
      return;
    }
    const openIds = new Set(live.positions.map((p) => p.position));
    for (const id of firstSuspiciousAt.keys()) if (!openIds.has(id)) firstSuspiciousAt.delete(id); // closed elsewhere — stop tracking it

    for (const p of live.positions) {
      if (!p.pnl_pct_suspicious) {
        if (firstSuspiciousAt.has(p.position)) {
          log("dead_position_guard", `${p.pair}: no longer suspicious — clearing tracked window`);
          firstSuspiciousAt.delete(p.position);
        }
        continue;
      }

      if (!firstSuspiciousAt.has(p.position)) {
        firstSuspiciousAt.set(p.position, Date.now());
        continue; // just started — nothing to act on yet
      }

      const suspiciousForMs = Date.now() - firstSuspiciousAt.get(p.position);
      if (suspiciousForMs < maxSuspiciousMs) continue; // still within the grace window — could still be a brief indexing delay

      const value = Number(p.total_value_true_usd);
      if (!Number.isFinite(value) || value > maxValueUsd) {
        // Suspicious for a long time but genuinely still has value on-chain
        // (or we can't tell) — not this guard's call to make. Keep
        // tracking; if it drops to ~zero later this will still catch it.
        continue;
      }

      const reason = `Dead position: pnl_pct_suspicious for ${(suspiciousForMs / 60000).toFixed(0)}m (limit ${(maxSuspiciousMs / 60000).toFixed(0)}m) with on-chain value $${value.toFixed(2)} <= $${maxValueUsd.toFixed(2)} — likely a rugged/failed deploy Meteora never indexed a deposit for`;
      log("dead_position_guard", `${p.pair}: ${reason}`);
      try {
        const res = await executeTool("close_position", { position_address: p.position, reason }, { trusted: true, source: "dead-position-guard", signalType: "DEAD_POSITION" }).catch((e) => ({ error: e.message }));
        const ok = res?.success !== false && !res?.error && !res?.blocked;
        log("dead_position_guard", `${p.pair}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
        if (ok) firstSuspiciousAt.delete(p.position);
      } catch (e) {
        log("cron_error", `Dead-position close failed for ${p.pair}: ${e.message}`);
      }
    }
  } finally {
    _busy = false;
  }
}
