// pnl-history.js — permanent, append-only record of peak_pnl_pct vs
// close_pnl_pct for every closed position, purpose-built to answer "top
// peak PnL" and "average PnL realization" without having to grep rotated
// pm2 log files by hand (which is how every prior version of this analysis
// in this codebase's history got done — one log upload, one manual pull,
// every single time).
//
// Realization ratio is the actual point of this file: close_pnl_pct /
// peak_pnl_pct tells you how much of the best gain a position ever reached
// actually got captured at close, versus given back before exiting. A
// position that peaked at 50% and closed at 45% realized 90% of its peak —
// a well-timed exit. One that peaked at 50% and closed at 5% realized only
// 10% — the exit strategy let most of the gain slip away. Averaged across
// many closes (overall, and per close-reason category), this is the
// clearest single number for "are our exit strategies actually capturing
// gains, or consistently giving them back."

import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";

const HISTORY_PATH = repoPath("pnl-history.jsonl");
const MAX_RECORDS = 5000; // bounded growth, same pattern as post-close-history.json

/**
 * Append one closed-position record. Called once per close, right
 * alongside recordClose/registerPostCloseWatch in tools/dlmm.js — this is
 * the one moment both peak_pnl_pct (from the position's own tracked
 * record) and close_pnl_pct (the just-computed realized result) are both
 * already in hand, so no extra fetch is needed.
 */
export function appendPnlRecord(record) {
  try {
    const lines = fs.existsSync(HISTORY_PATH) ? fs.readFileSync(HISTORY_PATH, "utf8").trim().split("\n").filter(Boolean) : [];
    lines.push(JSON.stringify({ ...record, recorded_at: new Date().toISOString() }));
    const trimmed = lines.length > MAX_RECORDS ? lines.slice(-MAX_RECORDS) : lines;
    fs.writeFileSync(HISTORY_PATH, trimmed.join("\n") + "\n");
  } catch (e) {
    log("cron_error", `pnl-history append failed: ${e.message}`);
  }
}

/** Load records, optionally filtered by recency, a since date, or a close-reason substring. */
export function loadPnlHistory({ limit = null, since = null, reason = null } = {}) {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  let records = fs.readFileSync(HISTORY_PATH, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!Number.isNaN(sinceMs)) records = records.filter((r) => r.closed_at && new Date(r.closed_at).getTime() >= sinceMs);
  }
  if (reason) {
    const needle = String(reason).toLowerCase();
    records = records.filter((r) => (r.close_reason || "").toLowerCase().includes(needle));
  }
  records.sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
  return limit ? records.slice(0, limit) : records;
}

/**
 * Categorize a raw close_reason string into a stable bucket — the same
 * categories used throughout this codebase's own manual log-analysis
 * sessions, kept consistent here so a `pnl-breakdown` run reads the same
 * way as every prior hand-done pull did.
 */
function categorize(reason) {
  const r = reason || "";
  if (/Peak RSI exit/i.test(r)) return "peak_rsi";
  if (/Take profit/i.test(r)) return "take_profit";
  if (/Liquidity collapse/i.test(r)) return "liquidity_collapse";
  if (/pumped extremely/i.test(r)) return "pumped_above_range";
  if (/Trailing TP/i.test(r)) return "trailing_tp";
  if (/Low yield/i.test(r)) return "low_yield";
  if (/^OOR\b|Out of range|Bid never filled/i.test(r)) return "oor";
  if (/Stop loss/i.test(r)) return "stop_loss";
  if (/Fee stall/i.test(r)) return "fee_stall";
  if (/Dead position/i.test(r)) return "dead_position";
  return "other";
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Top peaks + realization ratio, overall and per close-reason category.
 */
export function computePnlBreakdown(records, { topN = 10 } = {}) {
  const withPeak = records.filter((r) => typeof r.peak_pnl_pct === "number");
  const topPeaks = [...withPeak]
    .sort((a, b) => b.peak_pnl_pct - a.peak_pnl_pct)
    .slice(0, topN)
    .map((r) => ({
      pool_name: r.pool_name, closed_at: r.closed_at,
      peak_pnl_pct: round2(r.peak_pnl_pct),
      close_pnl_pct: typeof r.close_pnl_pct === "number" ? round2(r.close_pnl_pct) : null,
      close_reason: r.close_reason,
    }));

  // Realization only means something for a position that had a positive
  // peak to give back — a peak at or below 0% has nothing to "realize" in
  // this sense, so those are excluded from the ratio (not from the
  // dataset overall, just from this specific average).
  const realizable = records.filter((r) => typeof r.peak_pnl_pct === "number" && typeof r.close_pnl_pct === "number" && r.peak_pnl_pct > 0);
  const avgRealizationPct = realizable.length
    ? realizable.reduce((sum, r) => sum + (r.close_pnl_pct / r.peak_pnl_pct) * 100, 0) / realizable.length
    : null;

  const byCategory = {};
  for (const r of records) {
    const cat = categorize(r.close_reason);
    byCategory[cat] ??= { count: 0, peaks: [], realizable: [] };
    byCategory[cat].count++;
    if (typeof r.peak_pnl_pct === "number") byCategory[cat].peaks.push(r.peak_pnl_pct);
    if (typeof r.peak_pnl_pct === "number" && typeof r.close_pnl_pct === "number" && r.peak_pnl_pct > 0) {
      byCategory[cat].realizable.push((r.close_pnl_pct / r.peak_pnl_pct) * 100);
    }
  }
  const byCategoryStats = Object.entries(byCategory)
    .map(([category, d]) => ({
      category,
      count: d.count,
      avg_peak_pnl_pct: d.peaks.length ? round2(d.peaks.reduce((a, b) => a + b, 0) / d.peaks.length) : null,
      avg_realization_pct: d.realizable.length ? round2(d.realizable.reduce((a, b) => a + b, 0) / d.realizable.length) : null,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total_closes: records.length,
    top_peaks: topPeaks,
    avg_realization_pct: avgRealizationPct != null ? round2(avgRealizationPct) : null,
    realizable_sample_size: realizable.length,
    by_category: byCategoryStats,
  };
}
