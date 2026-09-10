// tools/audit.js — reconciles state.js's local position registry
// (state.json's `positions` map) against actual on-chain Meteora/Solana
// state. Originally the only way to catch either drift direction; as of
// 2026-08-13 state.js's syncOpenPositions() (stale) and autoAdoptGhosts()
// (ghost) both run automatically as a side effect of every getMyPositions()
// poll, so this command now mostly re-surfaces what already self-healed in
// the background moments earlier. It's still useful for:
//   - visibility — a structured, on-demand report instead of grepping cron
//     logs for [STATE] auto-adopted/auto-closed lines after the fact
//   - the narrow window autoAdoptGhosts() deliberately defers: a position
//     younger than its grace period is skipped automatically (to avoid
//     racing this process's own in-flight deploy write) — --fix here has
//     no such age gate, so it's the way to force-adopt one immediately if
//     you already know it's a genuine crash-orphan, not a race
//   - a final confirmation pass after any manual on-chain intervention
//
// Two failure modes this exists to catch:
//
//  1. GHOST (on-chain open, not tracked locally) — the deploy transaction
//     landed on-chain but trackPosition() never ran (process crash between
//     tx confirmation and state.json write). getMyPositions/screening's own
//     risk limits (maxPositions, duplicate-pool guard) DO see it, because
//     they enumerate on-chain ownership independent of the local file — but
//     it has no deposit basis on record, so PnL math, stop-loss/take-profit,
//     and every RSI-confirm guard can't evaluate it correctly until a
//     record exists. Historically had ZERO coverage in this codebase.
//
//  2. STALE (tracked locally as open, closed/burned on-chain) — already
//     handled automatically today by state.js's syncOpenPositions(), called
//     from inside getMyPositions() on every poll: it auto-closes a local
//     record once its position is missing from on-chain enumeration for
//     longer than SYNC_GRACE_MS. This audit re-surfaces that same
//     reconciliation as an on-demand, structured report (rather than
//     something you can only see by grepping cron logs after the fact) —
//     it does not duplicate or change that auto-close behavior.
//
// Report-only by default. --fix adopts ghosts with a BEST-EFFORT basis set
// to CURRENT mark value (flagged recoveredByAudit so it's never confused
// with a real recorded entry price) — recovering the true original entry
// price isn't possible, so this is reported clearly rather than silently
// trusted. Unlike the automatic background version, --fix here has no age
// gate — it adopts any ghost immediately, which is exactly the point of
// using this manually.
//
// If getMyPositions() itself fails (RPC/API down, not a per-position
// state), the WHOLE audit aborts and reports the error — nothing is
// touched, same fail-safe philosophy ruwethood's audit uses for its
// per-position "ambiguous" case. Meridiancx's on-chain enumeration is
// all-or-nothing (unlike ruwethood's dual RPC+Blockscout dependency),
// so there's no partial/per-position ambiguous state to report here.

import { getMyPositions } from "./dlmm.js";
import { getTrackedPositions, trackPosition } from "../state.js";
import { log } from "../logger.js";

/**
 * Reconcile local position tracking (state.json) against actual on-chain
 * state. Report-only unless fix=true.
 */
export async function auditPositions({ fix = false } = {}) {
  const live = await getMyPositions({ force: true, silent: true });
  if (live.error) {
    return {
      wallet: live.wallet ?? null,
      error: `On-chain enumeration failed — audit aborted, nothing touched: ${live.error}`,
    };
  }

  const onChainById = new Map(live.positions.map((p) => [p.position, p]));
  const localOpen = getTrackedPositions(true); // openOnly
  const localOpenIds = new Set(localOpen.map((p) => p.position));

  // Stale detection here is purely informational — syncOpenPositions()
  // already ran as a side effect of the getMyPositions() call above and
  // auto-closed anything past its own grace period. This just reports
  // which local records were (or are about to be, if still inside the
  // grace window) affected, for visibility.
  const stale = localOpen.filter((p) => !onChainById.has(p.position));
  const ghosts = live.positions.filter((p) => !localOpenIds.has(p.position));

  const result = {
    wallet: live.wallet,
    checked: localOpen.length,
    on_chain_open: live.positions.length,
    stale: stale.map((p) => ({
      position: p.position,
      pool_name: p.pool_name,
      deployed_at: p.deployed_at,
      note: "syncOpenPositions() already auto-closes this on its own schedule (or has already) — informational only, not something --fix touches separately.",
    })),
    ghosts: ghosts.map((p) => ({
      position: p.position,
      pair: p.pair,
      base_mint: p.base_mint,
      total_value_true_usd: p.total_value_true_usd,
      in_range: p.in_range,
    })),
    fixed: { ghosts_adopted: [] },
  };

  if (!fix) return result;

  for (const p of ghosts) {
    try {
      // Best-effort reconstruction — several fields (amount_sol, bin_step,
      // volatility, fee_tvl_ratio, organic_score, entry_mcap/tvl/volume/
      // holders) genuinely can't be recovered after the fact and are left
      // null. initial_value_usd is set to the CURRENT mark, not the real
      // original entry price (unknowable) — PnL on an adopted ghost is
      // only meaningful from this point forward, same caveat ruwethood's
      // ghost adoption carries.
      trackPosition({
        position: p.position,
        pool: p.pool,
        pool_name: p.pair,
        strategy: "recovered", // unknown — flagged below so this is never confused with a real deploy decision
        bin_range: { min: p.lower_bin, max: p.upper_bin },
        amount_sol: null,
        amount_x: 0,
        active_bin: p.active_bin,
        bin_step: null,
        volatility: null,
        fee_tvl_ratio: null,
        organic_score: null,
        initial_value_usd: p.total_value_true_usd ?? p.total_value_usd ?? 0,
        signal_snapshot: null,
        entry_mcap: null,
        entry_tvl: null,
        entry_volume: null,
        entry_holders: null,
      });
      result.fixed.ghosts_adopted.push({ position: p.position, pair: p.pair, basis_usd: p.total_value_true_usd ?? p.total_value_usd ?? 0 });
      log("audit", `${p.position.slice(0, 8)}: adopted untracked on-chain position (${p.pair}) — basis set to CURRENT mark (~$${(p.total_value_true_usd ?? p.total_value_usd ?? 0).toFixed(2)}), not the real original entry price. PnL from here forward only. bin_step/volatility/fee_tvl_ratio/entry_* unknown — review manually if this position needs full guard coverage (e.g. liquidity-collapse detection compares against entry conditions this record doesn't have).`);
    } catch (e) {
      log("audit", `${p.position.slice(0, 8)}: adopt failed (${e.message.slice(0, 120)}) — left untracked, re-run audit-positions --fix later`);
    }
  }

  return result;
}
