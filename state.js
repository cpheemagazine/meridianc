/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Mark a position as having crossed into "pumped far above range" territory
 * (Rule 3's trigger condition). Used by the pump-trailing-stop logic in
 * getDeterministicCloseRule — instead of closing the instant this condition
 * is met, we start timing from here and let a wider trailing-drop (against
 * the position's existing peak_pnl_pct) manage the actual exit.
 */
export function markPumpedAboveRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.pumped_above_range_since) {
    pos.pumped_above_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} pumped far above range — starting pump-trailing-stop`);
  }
}

/**
 * Clear pump-above-range tracking (e.g. if the position somehow re-enters
 * range rather than being closed — resets so a future pump starts fresh).
 */
export function clearPumpedAboveRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.pumped_above_range_since) {
    pos.pumped_above_range_since = null;
    save(state);
    log("state", `Position ${position_address} pump-above-range cleared`);
  }
}

/**
 * How many minutes has a position been in "pumped far above range" state?
 * Returns 0 if not currently in that state.
 */
export function minutesPumpedAboveRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.pumped_above_range_since) return 0;
  const ms = Date.now() - new Date(pos.pumped_above_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 *
 * @param {object} [extra] - optional extra context to include in the log/record.
 * @param {number|null} [extra.rsi] - the latest RSI reading at close time (best-effort,
 *   fetched by the caller before calling this — see tools/dlmm.js's closePosition for
 *   where this actually gets computed). Not required — omitted entirely if the fetch
 *   failed or wasn't attempted, rather than logging a misleading "n/a".
 * @param {number|null} [extra.rsiLength] - the RSI period used (e.g. 2 for RSI(2)),
 *   shown alongside the value so the log is self-describing without cross-referencing
 *   config.
 */
export function recordClose(position_address, reason, extra = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  if (extra.rsi != null) pos.rsi_at_close = extra.rsi;
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  const rsiSuffix = extra.rsi != null ? ` (RSI(${extra.rsiLength ?? "?"})=${extra.rsi.toFixed(1)})` : "";
  log("state", `Position ${position_address} marked closed: ${reason}${rsiSuffix}`);

  // Dedicated structured line for offline analysis — deliberately separate
  // from the human-readable line above (grep "CLOSE_METRICS" to pull just
  // these). Dumps every field tracked on this position across its whole
  // life: entry conditions, config-at-deploy context, everything recorded
  // along the way (claims, rebalances, peak PnL, OOR timing), and the
  // close itself — one line per closed position, whatever we happen to
  // have (some fields are null/absent depending on strategy and what
  // fired along the way, that's expected and fine for analysis).
  const holdMinutes = pos.deployed_at ? Math.round((new Date(pos.closed_at) - new Date(pos.deployed_at)) / 60000) : null;
  log("close_metrics", JSON.stringify({
    position: position_address,
    pool: pos.pool,
    pool_name: pos.pool_name,
    strategy: pos.strategy,
    close_reason: reason,
    closed_at: pos.closed_at,
    deployed_at: pos.deployed_at,
    hold_minutes: holdMinutes,
    // entry
    amount_sol: pos.amount_sol,
    amount_x: pos.amount_x,
    initial_value_usd: pos.initial_value_usd,
    bin_range: pos.bin_range,
    active_bin_at_deploy: pos.active_bin_at_deploy,
    bin_step: pos.bin_step,
    volatility: pos.volatility,
    fee_tvl_ratio: pos.fee_tvl_ratio,
    initial_fee_tvl_24h: pos.initial_fee_tvl_24h,
    organic_score: pos.organic_score,
    entry_mcap: pos.entry_mcap,
    entry_tvl: pos.entry_tvl,
    entry_volume: pos.entry_volume,
    entry_holders: pos.entry_holders,
    signal_snapshot: pos.signal_snapshot,
    // life-of-position
    out_of_range_since: pos.out_of_range_since,
    last_claim_at: pos.last_claim_at,
    total_fees_claimed_usd: pos.total_fees_claimed_usd,
    rebalance_count: pos.rebalance_count,
    peak_pnl_pct: pos.peak_pnl_pct,
    trailing_active: pos.trailing_active,
    // close
    rsi_at_close: extra.rsi ?? pos.rsi_at_close ?? null,
    rsi_length: extra.rsiLength ?? null,
  }));
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for a signal. The fast poller calls this every tick
 * with the exit action string detected this poll (or null when no exit). A signal
 * only fires after `confirmTicks` consecutive polls report the SAME value — so a
 * single noisy tick can't act on it. Streak resets whenever the signal clears or
 * changes. `namespace` lets independent checkers (e.g. the liquidity-collapse guard)
 * keep their own confirm streak on the same position without colliding with each
 * other's state -- default "exit" preserves the original field names/behavior.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2, namespace = "exit") {
  const actionField = namespace === "exit" ? "pending_exit_action" : `pending_${namespace}_action`;
  const countField = namespace === "exit" ? "pending_exit_count" : `pending_${namespace}_count`;
  const startedField = namespace === "exit" ? "pending_exit_started_at" : `pending_${namespace}_started_at`;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos[actionField] != null) {
      pos[actionField] = null;
      pos[countField] = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos[actionField] === signal) {
    pos[countField] = (pos[countField] ?? 1) + 1;
  } else {
    pos[actionField] = signal;
    pos[countField] = 1;
    pos[startedField] = new Date().toISOString();
  }

  const count = pos[countField];
  const fire = count >= confirmTicks;
  if (fire) {
    pos[actionField] = null;
    pos[countField] = 0;
    pos[startedField] = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} ${namespace} signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Record a TVL/volume sample for a position and compute how far the current
 * reading has dropped from the recent rolling high. Used by the
 * liquidity-collapse guard to detect a fast liquidity pull independent of
 * (and faster than) the PnL-based stop-loss, which only reacts to price —
 * price can lag a liquidity pull by several ticks, especially on a thin pool.
 *
 * The baseline is computed from samples BEFORE this one (not including the
 * current reading), so a genuine sudden drop is measured against real recent
 * history rather than being folded into its own baseline. Window is a fixed
 * sample count, not time-based, so it naturally forgets old data as it rolls.
 *
 * Returns null if this is the first sample (nothing to compare against yet).
 */
export function recordLiquiditySample(position_address, { tvl, volume }, lookback = 4) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const samples = pos.liquidity_samples || [];
  let result = null;

  if (samples.length > 0 && (tvl != null || volume != null)) {
    const baselineTvl = Math.max(...samples.map((s) => s.tvl ?? 0));
    const baselineVolume = Math.max(...samples.map((s) => s.volume ?? 0));
    result = {
      currentTvl: tvl ?? null,
      currentVolume: volume ?? null,
      baselineTvl,
      baselineVolume,
      tvlDropPct: tvl != null && baselineTvl > 0 ? ((tvl - baselineTvl) / baselineTvl) * 100 : null,
      volumeDropPct: volume != null && baselineVolume > 0 ? ((volume - baselineVolume) / baselineVolume) * 100 : null,
    };
  }

  samples.push({ t: new Date().toISOString(), tvl: tvl ?? null, volume: volume ?? null });
  pos.liquidity_samples = samples.length > lookback ? samples.slice(-lookback) : samples;
  save(state);

  return result;
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Deactivate trailing TP if PnL has fallen back below the trigger
  // threshold — trailing TP should only ever be able to close a position
  // while it's STILL genuinely above the profit-taking bar, never on a
  // position that's reverted back toward (or into) a loss just because it
  // once, at some point in the past, crossed the trigger. That's what
  // stop-loss is for, not trailing TP. Confirmed this was possible in
  // practice: trailing_active never turned itself back off, so a position
  // that peaked above the trigger and then dropped hard — but not hard
  // enough to hit stopLossPct — could still get closed and logged as
  // "Trailing TP" while genuinely underwater.
  //
  // Resets peak_pnl_pct to the current reading too, not just the flag —
  // otherwise the stale old peak would immediately re-satisfy the
  // activation condition again on literally the next tick (peak_pnl_pct
  // never decreases on its own), and a reactivation right after would
  // compute dropFromPeak against that stale, disconnected peak instead of
  // a real one — risking an instant close the moment it reactivates.
  // Clearing the pending (not-yet-confirmed) peak too so confirmPeak()
  // starts genuinely fresh from here rather than resuming a stale count.
  if (mgmtConfig.trailingTakeProfit && pos.trailing_active && !pnl_pct_suspicious && currentPnlPct != null && currentPnlPct < mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = false;
    pos.peak_pnl_pct = currentPnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    changed = true;
    log("state", `Position ${position_address} trailing TP deactivated — PnL ${currentPnlPct.toFixed(2)}% fell back below trigger ${mgmtConfig.trailingTriggerPct}% (peak reset to current, must climb back to the trigger to reactivate)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  // Update pump-above-range state (used to widen the trailing-drop threshold
  // below -- see "Trailing TP"). Same trigger condition as Rule 3 in
  // getDeterministicCloseRule, tracked here so both can see it.
  const pumpedFarAboveRange =
    positionData.active_bin != null &&
    positionData.upper_bin != null &&
    mgmtConfig.outOfRangeBinsToClose != null &&
    positionData.active_bin > positionData.upper_bin + mgmtConfig.outOfRangeBinsToClose;
  if (pumpedFarAboveRange && !pos.pumped_above_range_since) {
    pos.pumped_above_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} pumped far above range — starting pump-trailing-stop`);
  } else if (!pumpedFarAboveRange && pos.pumped_above_range_since) {
    pos.pumped_above_range_since = null;
    changed = true;
    log("state", `Position ${position_address} pump-above-range cleared`);
  }

  if (changed) save(state);

  // ── Stop loss ──────────────────────────────────────────────────
  // Master switch: config.management.stopLossEnabled=false disables this
  // whole rule, regardless of PnL. See that config's comment for the real
  // tradeoff before turning it off.
  // When stopLossRsiConfirm is on, this immediate trigger stands down —
  // stoploss-rsi-guard.js owns the close decision instead, waiting for an
  // RSI confirmation (or its own safety timeout) rather than closing the
  // instant the threshold is crossed.
  const stopLossEnabled = mgmtConfig.stopLossEnabled !== false;
  if (stopLossEnabled && !mgmtConfig.stopLossRsiConfirm && !pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    // Once price has pumped far above the deployed range, all liquidity has
    // converted to the base token -- it's pure directional exposure now, not
    // an LP position generating fees. The normal trailing-drop is tuned for
    // range-bound LP noise and fires almost instantly on any pullback, which
    // cuts genuine continuation pumps off at near-zero profit. Use a wider
    // drop threshold in this state so a real pump has room to keep running.
    // Confirmed via post-close tracking: "pumped far above range" closes left
    // an average of 21.6pp of further upside on the table, 5/5 times in the
    // historical sample.
    const dropThreshold = pumpedFarAboveRange
      ? (mgmtConfig.pumpTrailingDropPct ?? mgmtConfig.trailingDropPct)
      : mgmtConfig.trailingDropPct;

    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    // When trailingTpRsiConfirm is on, this immediate trigger stands down —
    // exit-rsi-guard.js owns the close decision instead, same reasoning
    // and mechanism as stopLossRsiConfirm's bypass above (different goal:
    // not damage control, just a better fill on an exit that's happening
    // either way).
    if (dropFromPeak >= dropThreshold && !mgmtConfig.trailingTpRsiConfirm) {
      return {
        action: "TRAILING_TP",
        reason: pumpedFarAboveRange
          ? `Pump trailing stop: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${dropThreshold}%, pumped far above range)`
          : `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${dropThreshold}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since && !mgmtConfig.oorRsiConfirm) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    !mgmtConfig.lowYieldRsiConfirm &&
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}

/**
 * BUG FIXED 2026-08-18 (ported preventively from ruwethood — same
 * syncOpenPositions/autoAdoptGhosts structure, same vulnerability;
 * confirmed happening in production there, not yet directly observed
 * here, but the code path is identical so there's no reason to assume
 * meridiancx is immune): syncOpenPositions above treats a single missing
 * poll the same as confirmed-gone — a transient RPC read failure gets
 * auto-closed exactly like a genuinely burned position. Once that
 * happens, autoAdoptGhosts can NEVER recover it — its ghost-detection
 * explicitly skips anything with an existing local record, open OR
 * closed (`if (state.positions[p.position]) continue`). A dead end with
 * no self-healing path, unlike the transient window the OTHER
 * reconciliation functions in this file are built to close.
 *
 * Safe to auto-correct without a grace period or extra confirmation:
 * on-chain position addresses are never reused once closed/burned, so if
 * getMyPositions() finds a specific address live, that unambiguously
 * means it's still genuinely open. There's no "maybe it's a coincidence"
 * case to guard against here the way autoAdoptGhosts needs
 * GHOST_ADOPT_GRACE_MS for.
 *
 * Restores the ORIGINAL entry record (deployed_at, initial_value_usd,
 * amount_sol, entry_tvl, etc.) rather than adopting fresh — unlike
 * autoAdoptGhosts, which has no choice but to fabricate a current-mark
 * basis for a position with no local history, this one's real deploy-time
 * data was never deleted, just flagged closed. Re-opening it recovers
 * full, ACCURATE guard coverage (real PnL against the real entry price),
 * not an approximation.
 */
export function reopenMisclosedPositions(livePositions) {
  const state = load();
  const liveIds = new Set(livePositions.map((p) => p.position));
  const reopened = [];

  for (const posId of liveIds) {
    const pos = state.positions[posId];
    if (!pos || !pos.closed) continue; // not tracked, or tracked-and-genuinely-open — nothing to correct
    pos.closed = false;
    pos.closed_at = null;
    pos.notes.push(`Re-opened ${new Date().toISOString()} — still found live on-chain despite being marked closed (a transient RPC read failure almost certainly caused a wrongful auto-close; on-chain position addresses are never reused, so this being found live is conclusive, not a guess)`);
    reopened.push(posId);
    log("state", `Position ${posId} RE-OPENED — still live on-chain despite local record showing closed (likely a transient RPC failure wrongly triggered auto-close earlier)`);
  }

  if (reopened.length > 0) save(state);
  return reopened;
}

/**
 * The other direction of syncOpenPositions: adopt an on-chain position
 * that has NO local record at all — the deploy tx confirmed but
 * trackPosition() never ran (process crash between tx confirmation and
 * state.json write). Previously the only way to catch this was the
 * manual `meridian audit-positions --fix` CLI command; this runs the same
 * recovery automatically on every position poll instead, so a
 * crash-orphaned position gets full guard coverage back within one poll
 * cycle rather than sitting unprotected until someone remembers to run
 * the CLI.
 *
 * GHOST_ADOPT_GRACE_MS exists for the same reason SYNC_GRACE_MS exists on
 * the stale side, but protects against a different race: a position
 * we're in the middle of deploying RIGHT NOW is on-chain (tx confirmed)
 * for a brief window before trackPosition() itself writes the record a
 * few lines later in the same deploy call — without this grace period,
 * this function could adopt our own in-flight deploy with a
 * current-mark basis instead of letting the real deploy flow record the
 * true entry price and conditions moments later. 10 minutes is generous
 * padding well beyond that window, while still being far faster than
 * waiting on a human to run the CLI.
 *
 * Basis is set to CURRENT mark value, NOT the real original entry price
 * (unrecoverable) — same caveat as the CLI's --fix. Several fields
 * (amount_sol, bin_step, volatility, fee_tvl_ratio, entry_mcap/tvl/
 * volume/holders) are left null since they're genuinely unknowable after
 * the fact; flagged recoveredByAudit:true so this is never confused with
 * a real deploy decision.
 */
const GHOST_ADOPT_GRACE_MS = 10 * 60_000; // don't adopt a position that might still be mid-deploy in this same process

export function autoAdoptGhosts(livePositions) {
  const state = load();
  const adopted = [];

  for (const p of livePositions) {
    if (state.positions[p.position]) continue; // already tracked (open or closed) — not a ghost
    if ((p.age_minutes ?? 0) < GHOST_ADOPT_GRACE_MS / 60_000) continue; // could still be our own in-flight deploy

    state.positions[p.position] = {
      position: p.position,
      pool: p.pool,
      pool_name: p.pair,
      strategy: "recovered", // unknown — flagged below so this is never confused with a real deploy decision
      bin_range: { min: p.lower_bin, max: p.upper_bin },
      amount_sol: null,
      amount_x: 0,
      active_bin_at_deploy: p.active_bin,
      bin_step: null,
      volatility: null,
      fee_tvl_ratio: null,
      initial_fee_tvl_24h: null,
      organic_score: null,
      initial_value_usd: p.total_value_true_usd ?? p.total_value_usd ?? 0,
      entry_mcap: null,
      entry_tvl: null,
      entry_volume: null,
      entry_holders: null,
      signal_snapshot: null,
      deployed_at: new Date().toISOString(), // true mint time unknown — age tracking starts from adoption, not the real entry
      out_of_range_since: null,
      last_claim_at: null,
      total_fees_claimed_usd: 0,
      rebalance_count: 0,
      closed: false,
      closed_at: null,
      notes: [`Auto-adopted during position sync — on-chain position had no local record (crash-recovery). Basis set to CURRENT mark (~$${(p.total_value_true_usd ?? p.total_value_usd ?? 0).toFixed(2)}), not the real original entry price.`],
      recoveredByAudit: true,
      recoveredAt: new Date().toISOString(),
    };
    adopted.push(p.position);
    log("state", `Position ${p.position} auto-adopted (on-chain, no local record — likely a crash between deploy tx confirming and state write). Basis set to CURRENT mark, not real entry price.`);
  }

  if (adopted.length > 0) save(state);
  return adopted;
}
