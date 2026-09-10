// candidate-snapshots.js — one JSON file per screening cycle, capturing the
// full candidate list exactly as the LLM saw it.
//
// Why this exists: reconstructing "why did it pick X over Y" or "was Z even
// a viable option that cycle" from agent-YYYY-MM-DD.log (prose summaries)
// and actions-YYYY-MM-DD.jsonl (tool call args/results) alone means piecing
// it back together after the fact — neither preserves the full ranked list
// (every candidate's fee/TVL, volume, volatility, degen score, etc.) that
// getTopCandidates() actually produced that cycle. This fills that gap: a
// raw, complete snapshot per cycle, written before any LLM reasoning runs.
//
// Ported from a sibling EVM fork of this bot, where this same idea grew out
// of repeated deployment-problem investigations that kept needing exactly
// this data and not finding it preserved anywhere.

import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { config, isDryRunFilterBypassActive } from "./config.js";

const SNAPSHOT_DIR = repoPath("candidate-snapshots");

function ensureDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

/** Filesystem-safe timestamp for a filename: colons/dots aren't valid on some OSes. */
function filenameTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Save one screening cycle's candidate list to its own timestamped file.
 * Fire-and-forget by design (wrapped in try/catch, never throws) — a
 * snapshot write failing should never be able to abort or delay the real
 * screening cycle it's recording.
 *
 * @param {object} topCandidates - whatever getTopCandidates({limit}) returned
 * @param {object} [meta] - optional extra context to attach (e.g. cycle type)
 * @returns {string|null} the file path written, or null if it was skipped/failed
 */
export function saveCandidateSnapshot(topCandidates, meta = {}) {
  if (config.screening.candidateSnapshotEnabled === false) return null;
  try {
    ensureDir();
    const ts = new Date();
    const candidates = topCandidates?.candidates || topCandidates?.pools || [];
    // all_filtered_examples: the FULL rejection list (every token/pool
    // considered and dropped, with its reason) — unlike filtered_examples
    // (capped at 3, meant only for the LLM's own prompt so it stays
    // small), this is uncapped. Costs nothing extra here — the data was
    // already fully computed during the real screening cycle
    // (tools/screening.js's pushFilteredReason calls, tools/gmgn.js's
    // per-stage filtered.push calls), just wasn't being retained past the
    // cycle before this. This is the field that makes this snapshot cover
    // the same ground as `node cli.js census` (every token considered,
    // pass or reject and why) — not just the winners, which is all this
    // snapshot captured before.
    const allFiltered = topCandidates?.all_filtered_examples || [];
    const file = path.join(SNAPSHOT_DIR, `${filenameTimestamp(ts)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      ts: ts.toISOString(),
      cycle: meta.cycle || "screening",
      chain: "Solana (Meteora DLMM)",
      timeframe: config.screening.timeframe,
      screening_source: config.screening.source,
      limit: meta.limit ?? candidates.length,
      total_candidates: candidates.length,
      total_screened: topCandidates?.total_screened ?? null,
      total_rejected: allFiltered.length,
      gmgn_stage_counts: topCandidates?.stage_counts ?? null,
      note: topCandidates?.note ?? null,
      // Makes it unambiguous from the file alone whether an unusually
      // large candidate count (or a candidate carrying a would_reject
      // field) reflects real screening or dry-run data-capture mode.
      dry_run_bypass_filters_active: isDryRunFilterBypassActive(),
      candidates,
      rejected: allFiltered,
    }, null, 2));
    pruneOldSnapshots();
    return file;
  } catch (error) {
    log("candidate_snapshot_warn", `Failed to save candidate snapshot: ${error.message}`);
    return null;
  }
}

/**
 * Delete snapshots older than config.screening.candidateSnapshotRetentionDays
 * (default 14). Runs after every save rather than on a separate schedule —
 * cheap at this file count (well under 100/day at the default screening
 * interval is nowhere near enough files for a directory listing + a few
 * stat calls to matter), and guarantees cleanup actually happens without
 * needing its own cron entry.
 */
function pruneOldSnapshots() {
  const days = Number(config.screening.candidateSnapshotRetentionDays ?? 14);
  if (!(days > 0)) return; // 0 or negative disables pruning — keep everything
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let files;
  try {
    files = fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const full = path.join(SNAPSHOT_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* another process may have already removed it — not an error */ }
  }
}

/**
 * List snapshot files newest-first, optionally within a time range.
 * Returns file metadata only (path, timestamp, size) — call
 * loadCandidateSnapshot() to read one's actual content.
 */
export function listCandidateSnapshots({ limit = 20, after = null, before = null } = {}) {
  ensureDir();
  let files;
  try {
    files = fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  let entries = files.map((f) => {
    const full = path.join(SNAPSHOT_DIR, f);
    const stat = fs.statSync(full);
    return { file: f, path: full, mtime: stat.mtime.toISOString(), size_bytes: stat.size };
  });
  if (after) entries = entries.filter((e) => e.mtime >= after);
  if (before) entries = entries.filter((e) => e.mtime <= before);
  entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return entries.slice(0, limit);
}

/** Load one snapshot's full content by file path (as returned by listCandidateSnapshots). */
export function loadCandidateSnapshot(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
