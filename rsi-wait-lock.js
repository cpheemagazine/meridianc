/**
 * rsi-wait-lock.js — cross-guard mutual exclusion for positions currently
 * in an RSI-confirm wait.
 *
 * Problem this fixes: stoploss-rsi-guard.js, exit-rsi-guard.js, and
 * liquidity-guard.js (when liquidityRsiConfirm is on) each maintain their
 * OWN local pending-wait state, with zero awareness of each other. A
 * position could be mid-wait for its stop-loss RSI confirmation while
 * liquidity-guard.js's completely independent TVL/volume collapse
 * detection closes it out from under that wait for an unrelated reason —
 * confirmed in production 2026-08-02: a STOPLOSS_RSI-pending position got
 * closed via "Liquidity collapse" before its own RSI threshold or safety
 * timeout ever resolved.
 *
 * This is a simple shared lock: whichever guard starts waiting on a
 * position first claims it. tools/executor.js's close_position gate
 * checks this before any close (the actual enforcement point) — every
 * close path (the three guards above, index.js's deterministic close-rule
 * dispatch, peak-rsi-exit.js) is expected to identify itself via
 * executeTool's `source` option so the gate can tell "the guard that owns
 * this wait is resolving it" (allowed) from "a different, unrelated
 * strategy is trying to close it" (blocked). Manual CLI closes
 * deliberately bypass this — an operator explicitly closing a position is
 * a deliberate override, not a competing automated strategy.
 */

const locks = new Map(); // position -> { holder, since }

/**
 * Claim the lock for `position` under `holder`'s name. Returns true if
 * acquired (including if `holder` already held it — idempotent, safe to
 * call every tick), false if held by a DIFFERENT holder — in which case
 * the caller should not start its own wait for that position this tick
 * (log it and try again next tick; the lock may have released by then).
 */
export function acquireRsiWaitLock(position, holder) {
  const existing = locks.get(position);
  if (existing && existing.holder !== holder) return false;
  locks.set(position, { holder, since: existing?.since ?? Date.now() });
  return true;
}

/** Release the lock, but only if `holder` is the one currently holding it — a guard can never release a lock it doesn't own. */
export function releaseRsiWaitLock(position, holder) {
  const existing = locks.get(position);
  if (existing && existing.holder === holder) locks.delete(position);
}

/** Who (if anyone) currently holds the lock for `position`. */
export function getRsiWaitLockHolder(position) {
  return locks.get(position)?.holder ?? null;
}
