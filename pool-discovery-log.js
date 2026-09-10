// pool-discovery-log.js — one JSON file per screening cycle, capturing
// EVERY fetchTopMeteoraDlmmPoolsForMint() call made during that cycle:
// which token, and every Meteora DLMM pool found for it (or the fact that
// none were).
//
// Why this exists: candidate-snapshots.js already captures the higher-level
// "which tokens became candidates, which got rejected and why" view — but
// GMGN's Stage 3 in tools/gmgn.js only keeps the top 2 pools per token
// after that lookup, and candidate-snapshots.js's rejection log doesn't
// preserve what the raw pool search actually returned for a token before
// selection happened. This captures that layer directly — useful for the
// same kind of question this is meant to answer for any token: "did this
// token actually have a Meteora pool, at what bin_step, what TVL" —
// without reconstructing it from scattered [GMGN] log lines after the
// fact.
//
// Ported from a sibling EVM fork's v4-discovery-log.js, which recorded
// discoverV4Pools() (a per-fee-tier RPC scan — Uniswap v4 pools for a
// token/quote pair are derivable on-chain across a small fixed set of fee
// tiers). That mechanism doesn't apply to Meteora: different bin_step
// pools for a pair are independently-created pools, not derivable from the
// token address the way v4's CREATE2 pools are — discoverable only via the
// datapi search this codebase already uses (tools/gmgn.js's
// fetchTopMeteoraDlmmPoolsForMint), which is what this records instead.

import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";

const LOG_DIR = repoPath("pool-discovery-logs");

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function filenameTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Save one screening cycle's full fetchTopMeteoraDlmmPoolsForMint call log
 * to its own timestamped file. Fire-and-forget by design (wrapped in
 * try/catch, never throws) — a save failing should never be able to abort
 * or delay the real screening cycle it's recording.
 *
 * @param {Array} records - whatever stopDiscoveryRecording() (tools/gmgn.js) returned
 * @param {object} [meta] - optional extra context (e.g. cycle type)
 * @returns {string|null} the file path written, or null if it was skipped/empty/failed
 */
export function saveDiscoveryLog(records, meta = {}) {
  if (config.screening.candidateSnapshotEnabled === false) return null; // same on/off switch as candidate-snapshots.js — one setting for both
  if (!records || !records.length) return null; // nothing was discovered this cycle (e.g. screening source wasn't gmgn/both, or it failed before reaching Stage 3) — no point writing an empty file
  try {
    ensureDir();
    const ts = new Date();
    const file = path.join(LOG_DIR, `${filenameTimestamp(ts)}.json`);
    const foundCount = records.filter((r) => r.pools_found > 0).length;
    fs.writeFileSync(file, JSON.stringify({
      ts: ts.toISOString(),
      cycle: meta.cycle || "screening",
      chain: "Solana (Meteora DLMM)",
      total_calls: records.length,
      calls_with_pools_found: foundCount,
      calls_with_nothing_found: records.length - foundCount,
      calls: records,
    }, null, 2));
    pruneOldLogs();
    return file;
  } catch (error) {
    log("pool_discovery_log_warn", `Failed to save discovery log: ${error.message}`);
    return null;
  }
}

/**
 * Delete logs older than config.screening.candidateSnapshotRetentionDays
 * (default 14) — same retention window as candidate-snapshots.js, same
 * reasoning (cheap at this file count, runs after every save instead of
 * needing a separate cron entry).
 */
function pruneOldLogs() {
  const days = Number(config.screening.candidateSnapshotRetentionDays ?? 14);
  if (!(days > 0)) return; // 0 or negative disables pruning — keep everything
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let files;
  try {
    files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const full = path.join(LOG_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* another process may have already removed it — not an error */ }
  }
}
