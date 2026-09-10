// tools/pools-table.js — Meridian screen-only candidate table.
// Pure formatting, no side effects other than returning a string. Kept separate
// from cli.js so it's testable in isolation and reusable by other surfaces
// (e.g. the dashboard) without dragging in argv parsing.

export function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

export function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return `${Number(n).toFixed(digits)}%`;
}

function pad(str, width, align = "left") {
  const s = String(str ?? "—");
  const clipped = s.length > width ? s.slice(0, width - 1) + "…" : s;
  const gap = " ".repeat(Math.max(0, width - clipped.length));
  return align === "right" ? gap + clipped : clipped + gap;
}

const COLS = [
  { key: "rank", label: "#", width: 3, align: "right" },
  { key: "pair", label: "Pair", width: 22 },
  { key: "binStep", label: "BinStep", width: 7, align: "right" },
  { key: "fee", label: "Fee%", width: 7, align: "right" },
  { key: "tvl", label: "TVL", width: 9, align: "right" },
  { key: "volume", label: "Volume", width: 9, align: "right" },
  { key: "feeTvl", label: "Fee/TVL", width: 8, align: "right" },
  { key: "volTvl", label: "Vol/TVL", width: 8, align: "right" },
  { key: "score", label: "Degen", width: 6, align: "right" },
  { key: "vola", label: "Vola%", width: 7, align: "right" },
  { key: "age", label: "Age(h)", width: 7, align: "right" },
  { key: "holders", label: "Holders", width: 8, align: "right" },
];

/**
 * Shape a raw screening candidate (condensePool's output, from
 * tools/screening.js's getTopCandidates) into the flat, machine-readable
 * record used by `pools --json`.
 */
export function toCandidateRecord(c, i, degenScoreFn, opportunityConfig) {
  return {
    rank: i + 1,
    pair: c.name,
    token: c.base?.mint,
    pool: c.pool,
    bin_step: c.bin_step,
    fee_pct: c.fee_pct,
    tvl_usd: c.tvl,
    volume_usd: c.volume_window,
    fee_tvl_pct: c.fee_active_tvl_ratio,
    volume_tvl_pct: c.volume_active_tvl_ratio,
    degen_score: Math.round(degenScoreFn(c, opportunityConfig) * 10) / 10,
    volatility_pct: c.volatility,
    age_hours: c.token_age_hours,
    holders: c.holders,
    organic_score: c.organic_score,
    launchpad: c.launchpad,
  };
}

/**
 * Render candidates into an aligned plain-text table: pair, bin step, fee,
 * TVL, volume, fee/TVL, vol/TVL, degen score, volatility, age, holders.
 * Returns a single string — callers decide how to emit it (stdout, a file,
 * a chat reply, etc).
 */
export function renderPoolsTable(candidates, { timeframe, sortBy, note, ms } = {}) {
  const lines = [];
  lines.push(`Meridian — Meteora DLMM pool screening (window: ${timeframe || "?"}, sorted by: ${sortBy || "degen_score"}, scanned in ${ms ?? "?"}ms)`);
  lines.push(`Screen-only mode — no deployment. ${candidates.length} candidate(s).`);
  lines.push("");

  if (!candidates.length) {
    lines.push(note ? `No candidates: ${note}` : "No candidates passed the screening filters this cycle.");
    return lines.join("\n") + "\n";
  }

  lines.push(COLS.map((c) => pad(c.label, c.width, c.align)).join(" │ "));
  lines.push(COLS.map((c) => "─".repeat(c.width)).join("─┼─"));

  candidates.forEach((c, i) => {
    const row = {
      rank: i + 1,
      pair: c.name,
      binStep: c.bin_step ?? "—",
      fee: fmtPct(c.fee_pct),
      tvl: fmtUsd(c.tvl),
      volume: fmtUsd(c.volume_window),
      feeTvl: fmtPct(c.fee_active_tvl_ratio),
      volTvl: fmtPct(c.volume_active_tvl_ratio),
      score: Number.isFinite(c._degenScore) ? c._degenScore.toFixed(1) : "—",
      vola: fmtPct(c.volatility),
      age: c.token_age_hours != null ? c.token_age_hours.toFixed(1) : "—",
      holders: c.holders ?? "—",
    };
    lines.push(COLS.map((col) => pad(row[col.key], col.width, col.align)).join(" │ "));
  });

  lines.push("");
  lines.push("Token/pool addresses: pass --json for the full machine-readable record.");
  lines.push("Next phase (not run here): deploy_position against one of these candidates.");
  return lines.join("\n") + "\n";
}

const CENSUS_COLS = [
  { key: "rank", label: "#", width: 4, align: "right" },
  { key: "pair", label: "Pair", width: 22 },
  { key: "binStep", label: "BinStep", width: 7, align: "right" },
  { key: "tvl", label: "TVL", width: 9, align: "right" },
  { key: "volume", label: "Volume", width: 9, align: "right" },
  { key: "mcap", label: "Mcap", width: 9, align: "right" },
  { key: "vola", label: "Vola%", width: 7, align: "right" },
  { key: "age", label: "Age(h)", width: 7, align: "right" },
  { key: "holders", label: "Holders", width: 8, align: "right" },
  { key: "verdict", label: "Screening verdict", width: 44 },
];

/**
 * Render the full pre-filter pool universe (tools/screening.js's
 * getCensusUniverse) — every dlmm pool the discovery API returns under a
 * deliberately loose filter, BEFORE the real config filters (minTvl,
 * minOrganic, quote-must-be-SOL, cooldowns, etc). That's why there's no
 * fee/TVL or degen_score column here — those are meaningful once a pool
 * survives far enough to be scored, which this view deliberately skips for
 * speed/breadth (see getCensusUniverse's comment for why). Use this to see
 * WHY a token isn't showing up as a candidate at all, not to pick a deploy
 * target — for that, use `node cli.js pools`.
 */
export function renderCensusTable(entries, { timeframe, ms, passingOnly, wouldPassCount } = {}) {
  const lines = [];
  lines.push(`Meridian — Meteora DLMM full census universe (window: ${timeframe || "?"}, scanned in ${ms ?? "?"}ms)`);
  lines.push(`${entries.length} pool(s) shown${passingOnly ? " (screening-passing only)" : ""}${wouldPassCount != null ? ` — ${wouldPassCount} would currently pass screening` : ""}.`);
  lines.push("");

  if (!entries.length) {
    lines.push("No pools found — pool discovery API returned nothing for this window.");
    return lines.join("\n") + "\n";
  }

  lines.push(CENSUS_COLS.map((c) => pad(c.label, c.width, c.align)).join(" │ "));
  lines.push(CENSUS_COLS.map((c) => "─".repeat(c.width)).join("─┼─"));

  entries.forEach((e, i) => {
    const row = {
      rank: i + 1,
      pair: e.name,
      binStep: e.bin_step ?? "—",
      tvl: fmtUsd(e.tvl),
      volume: fmtUsd(e.volume_window),
      mcap: fmtUsd(e.mcap),
      vola: fmtPct(e.volatility),
      age: e.token_age_hours != null ? e.token_age_hours.toFixed(1) : "—",
      holders: e.holders ?? "—",
      verdict: e.would_pass_screening ? "passes current filters" : (e.reject_reason || "rejected"),
    };
    lines.push(CENSUS_COLS.map((col) => pad(row[col.key], col.width, col.align)).join(" │ "));
  });

  lines.push("");
  lines.push("Token/pool addresses: pass --json for the full machine-readable record.");
  lines.push("fee/TVL and degen_score aren't shown here — those only exist for pools that reach real scoring. Use `node cli.js pools` for that, on filter-surviving candidates.");
  return lines.join("\n") + "\n";
}

const DLMM_POOLS_COLS = [
  { key: "rank", label: "#", width: 4, align: "right" },
  { key: "pair", label: "Token", width: 16 },
  { key: "binStep", label: "BinStep", width: 8, align: "right" },
  { key: "fee", label: "Fee%", width: 8, align: "right" },
  { key: "tvl", label: "TVL", width: 9, align: "right" },
  { key: "vol24", label: "Vol 24h", width: 9, align: "right" },
];

/**
 * Render getDlmmPoolsUniverse's output — ALL real Meteora DLMM pools per
 * token (every bin_step/fee variant searchPools finds, not just the single
 * pool discoverPools()/getTopCandidates() picked), one row per (token,
 * pool). A token with 3 pools at different bin steps gets 3 rows, grouped
 * together and sorted by TVL descending, so row 1 per token is the deepest
 * pool for that token.
 */
export function renderDlmmPoolsTable(tokens, { ms, tokensScanned, totalPools } = {}) {
  const lines = [];
  lines.push(`Meridian — Meteora DLMM per-token pool discovery (scanned ${tokensScanned ?? tokens.length} token(s) in ${ms ?? "?"}ms)`);
  lines.push(`${totalPools ?? tokens.reduce((n, t) => n + (t.pools?.length || 0), 0)} pool(s) found across ${tokens.length} token(s) shown.`);
  lines.push("");

  const rows = [];
  const rowNotes = []; // index-aligned with rows: a full-width note under a no-pool row instead of squeezing it into one column
  for (const t of tokens) {
    if (!t.pools || !t.pools.length) {
      rows.push({ pair: t.name, binStep: "—", fee: "—", tvl: fmtUsd(t.tvl), vol24: "—" });
      rowNotes.push(t.error ? `    ↳ ${t.error}` : "    ↳ no additional pool found via search");
      continue;
    }
    t.pools.forEach((p, i) => {
      rows.push({
        pair: i === 0 ? t.name : "",
        binStep: p.bin_step ?? "—",
        fee: fmtPct(p.fee_pct),
        tvl: fmtUsd(p.tvl),
        vol24: fmtUsd(p.volume_24h),
      });
      rowNotes.push(null);
    });
  }

  if (!rows.length) {
    lines.push("No tokens scanned — nothing passed the passingOnly/tokenLimit scope, or the census itself returned nothing.");
    return lines.join("\n") + "\n";
  }

  lines.push(DLMM_POOLS_COLS.map((c) => pad(c.label, c.width, c.align)).join(" │ "));
  lines.push(DLMM_POOLS_COLS.map((c) => "─".repeat(c.width)).join("─┼─"));
  rows.forEach((row, i) => {
    lines.push(DLMM_POOLS_COLS.map((col) => pad(col.key === "rank" ? i + 1 : row[col.key], col.width, col.align)).join(" │ "));
    if (rowNotes[i]) lines.push(rowNotes[i]);
  });

  lines.push("");
  lines.push("Rows grouped by token — a token with multiple bin-step pools gets one row per pool, sorted by TVL descending.");
  return lines.join("\n") + "\n";
}
