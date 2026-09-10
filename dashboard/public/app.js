const REFRESH_MS = 15000;

const state = {
  positions: [],
  summary: null,
  filter: "all",
  page: 1,
  pageSize: 20,
};

let priceChart = null;
let rsiChart = null;

// ─── Chart alignment tuning ────────────────────────────────────────────
// The price and RSI charts are two independent Chart.js instances in two
// separate boxes, each given the exact same x-axis data range (chartXMin/
// chartXMax below) so the same timestamp SHOULD land at the same x-pixel
// in both. In practice, two separately-boxed charts can still drift by a
// few pixels from things outside this file's control — subpixel font
// metrics, browser rounding, zoom level. These two constants are the
// adjustment knobs for that: change a number, refresh, done — no need to
// touch anything else in this file.
//
// CHART_Y_AXIS_WIDTH: pixel width BOTH charts reserve for their left-side
// y-axis (price labels like "$0.0000234" need more room than RSI's plain
// "0"/"25"/"100"). Widen this if labels look clipped on either chart.
const CHART_Y_AXIS_WIDTH = 62;
// CHART_RSI_X_AXIS_OFFSET_PX: fine-tune nudge applied ONLY to the RSI
// chart's y-axis width, on top of CHART_Y_AXIS_WIDTH above — this is the
// knob to reach for if the two charts' vertical lines are close but not
// exactly lined up: positive shifts the RSI chart's plot area right,
// negative shifts it left. Try ±1 to ±3 first.
const CHART_RSI_X_AXIS_OFFSET_PX = 0;

// Register the annotation plugin once both CDN scripts have loaded.
try {
  const annotationPlugin = window["chartjs-plugin-annotation"];
  if (window.Chart && annotationPlugin && !window.Chart.registry.plugins.get("annotation")) {
    window.Chart.register(annotationPlugin);
  }
} catch (e) {
  console.warn("chartjs annotation plugin registration skipped:", e.message);
}

// $, fmtUsd, fmtPct, fmtDate, fmtDuration, shortPool, fetchJSON, escapeHtml
// now live in common.js (shared with pools.html) — loaded before this file.

async function loadData() {
  const btn = $("#refreshBtn");
  btn.classList.add("spinning");
  try {
    const [summary, posResp] = await Promise.all([
      fetchJSON("/api/summary"),
      fetchJSON("/api/positions"),
    ]);
    state.summary = summary;
    state.positions = posResp.positions || [];
    render();
    $("#lastUpdated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $("#lastUpdated").textContent = `error: ${err.message}`;
    console.error(err);
  } finally {
    setTimeout(() => btn.classList.remove("spinning"), 400);
  }
}

function render() {
  renderSummary();
  renderPositions();
}

function renderSummary() {
  const s = state.summary;
  if (!s) return;
  const pnlClass = s.total_pnl_usd > 0 ? "positive" : s.total_pnl_usd < 0 ? "negative" : "";
  const cards = [
    { label: "Open Positions", value: s.open_count, cls: "neutral-teal" },
    { label: "Closed Positions", value: s.closed_count, cls: "" },
    { label: "Realized PnL", value: fmtUsd(s.total_pnl_usd, { forceSign: true }), cls: pnlClass, sub: fmtPct(s.avg_pnl_pct) + " avg" },
    { label: "Fees Earned", value: fmtUsd(s.total_fees_usd), cls: "neutral-amber" },
    { label: "Win Rate", value: s.win_rate_pct === null ? "—" : `${s.win_rate_pct}%`, cls: "", sub: `${s.wins}W / ${s.losses}L` },
    { label: "Deployed (all-time)", value: fmtUsd(s.total_deployed_usd), cls: "" },
  ];
  $("#summaryGrid").innerHTML = cards
    .map(
      (c) => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
      ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ""}
    </div>`
    )
    .join("");
}

// Performance-by-pool rendering moved to pools.html/pools.js.

function renderPositions() {
  let rows = state.positions;
  if (state.filter !== "all") rows = rows.filter((r) => r.status === state.filter);

  if (!rows.length) {
    $("#positionsList").innerHTML = `<div class="positions-empty">No ${state.filter === "all" ? "" : state.filter} positions found.</div>`;
    $("#positionsPagination").innerHTML = "";
    return;
  }

  // Client-side pagination — /api/positions already returns everything in
  // one call (no limit/offset support server-side), so this just chunks the
  // already-filtered array rather than requiring a new paginated endpoint.
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const startIdx = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(startIdx, startIdx + state.pageSize);

  $("#positionsList").innerHTML = pageRows.map((r) => positionCardHtml(r)).join("");

  document.querySelectorAll(".position-card").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });

  renderPagination(rows.length, totalPages);
}

function renderPagination(totalRows, totalPages) {
  const el = $("#positionsPagination");
  if (totalPages <= 1) {
    el.innerHTML = "";
    return;
  }
  const startIdx = (state.page - 1) * state.pageSize + 1;
  const endIdx = Math.min(state.page * state.pageSize, totalRows);
  el.innerHTML = `
    <span class="pagination-info">${startIdx}–${endIdx} of ${totalRows}</span>
    <div class="pagination-controls">
      <button class="pagination-btn" id="pagePrev" ${state.page <= 1 ? "disabled" : ""}>‹ Prev</button>
      <span class="pagination-current">Page ${state.page} of ${totalPages}</span>
      <button class="pagination-btn" id="pageNext" ${state.page >= totalPages ? "disabled" : ""}>Next ›</button>
    </div>
  `;
  $("#pagePrev")?.addEventListener("click", () => { state.page -= 1; renderPositions(); });
  $("#pageNext")?.addEventListener("click", () => { state.page += 1; renderPositions(); });
}

function pillFor(r) {
  if (r.status === "open") return `<span class="pill open">● live</span>`;
  if (r.pnl_usd > 0) return `<span class="pill closed-win">closed · win</span>`;
  if (r.pnl_usd < 0) return `<span class="pill closed-loss">closed · loss</span>`;
  return `<span class="pill closed-flat">closed</span>`;
}

function positionCardHtml(r) {
  const pnlValue = r.status === "open" ? r.peak_pnl_pct : r.pnl_pct;
  const pnlUsdValue = r.status === "open" ? null : r.pnl_usd;
  const pnlColor =
    pnlValue > 0 ? "var(--green)" : pnlValue < 0 ? "var(--red)" : "var(--text-muted)";

  const pnlDisplay =
    pnlUsdValue == null
      ? fmtPct(pnlValue)
      : `${fmtPct(pnlValue)} <span class="pc-pnl-usd">${fmtUsd(pnlUsdValue, { forceSign: true })}</span>`;

  return `
  <div class="position-card" data-id="${r.position}">
    <div class="status-dot ${r.status}"></div>
    <div>
      <div class="pc-name">${escapeHtml(r.pool_name || shortPool(r.pool) || "Unknown pool")}</div>
      <div class="pc-sub">#${r.position} · ${escapeHtml(r.strategy || "—")}</div>
    </div>
    <div class="pc-hide-mobile">
      <div class="pc-col-label">${r.status === "open" ? "Peak PnL" : "PnL"}</div>
      <div class="pc-col-value" style="color:${pnlColor}">${pnlDisplay}</div>
    </div>
    <div class="pc-hide-mobile">
      <div class="pc-col-label">Size</div>
      <div class="pc-col-value">${fmtUsd(r.initial_value_usd)}</div>
    </div>
    <div class="pc-hide-mobile">
      <div class="pc-col-label">Fee Earned</div>
      <div class="pc-col-value" style="color:var(--amber)">${fmtUsd(r.fees_earned_usd)}</div>
    </div>
    <div class="pc-hide-mobile">
      <div class="pc-col-label">Closed</div>
      <div class="pc-col-value pc-time">${r.status === "open" ? `<span style="color:var(--teal)">still open</span>` : fmtDate(r.closed_at)}</div>
    </div>
    <div style="text-align:right">${pillFor(r)}</div>
  </div>`;
}

function openDetail(id) {
  const r = state.positions.find((p) => p.position === id);
  if (!r) return;

  const statusBadge =
    r.status === "open"
      ? `<span class="badge-status" style="background:var(--teal-dim);color:var(--teal)">● Open</span>`
      : r.pnl_usd > 0
      ? `<span class="badge-status" style="background:var(--green-dim);color:var(--green)">Closed · Win</span>`
      : r.pnl_usd < 0
      ? `<span class="badge-status" style="background:var(--red-dim);color:var(--red)">Closed · Loss</span>`
      : `<span class="badge-status" style="background:var(--surface-3);color:var(--text-muted)">Closed</span>`;

  const items = [
    { label: "Position ID", value: `#${r.position}` },
    { label: "Strategy", value: r.strategy || "—" },
    { label: "Bin Step", value: r.bin_step ?? "—" },
    { label: "Volatility", value: r.volatility ?? "—" },
    { label: "Initial Value", value: fmtUsd(r.initial_value_usd) },
    { label: r.status === "open" ? "Fees So Far" : "Final Value", value: r.status === "open" ? fmtUsd(r.fees_earned_usd) : fmtUsd(r.final_value_usd) },
  ];

  if (r.status === "closed") {
    items.push(
      { label: "PnL", value: `${fmtUsd(r.pnl_usd, { forceSign: true })} (${fmtPct(r.pnl_pct)})`, color: r.pnl_usd >= 0 ? "var(--green)" : "var(--red)" },
      { label: "Fees Earned", value: fmtUsd(r.fees_earned_usd) },
      { label: "Held", value: fmtDuration(r.minutes_held) },
      { label: "In Range", value: fmtDuration(r.minutes_in_range) },
      { label: "Rebalances", value: r.rebalance_count ?? 0 },
      { label: "Range Efficiency", value: r.range_efficiency != null ? `${(r.range_efficiency * 100).toFixed(0)}%` : "—" }
    );
  } else {
    items.push(
      { label: "Peak PnL", value: fmtPct(r.peak_pnl_pct), color: r.peak_pnl_pct > 0 ? "var(--green)" : r.peak_pnl_pct < 0 ? "var(--red)" : undefined },
      { label: "Age", value: fmtDuration(r.minutes_held) },
      { label: "Out of Range Since", value: r.out_of_range_since ? fmtDate(r.out_of_range_since) : "In range" },
      { label: "Trailing Stop", value: r.trailing_active ? "Active" : "Inactive" },
      { label: "Rebalances", value: r.rebalance_count ?? 0 }
    );
  }

  const detailGrid = items
    .map(
      (i) => `
    <div class="detail-item">
      <div class="stat-label">${i.label}</div>
      <div class="stat-value" style="${i.color ? `color:${i.color}` : ""}">${i.value}</div>
    </div>`
    )
    .join("");

  const entryExitSection =
    r.entry
      ? `
    <div class="detail-section-title">Entry Snapshot</div>
    <div class="detail-notes">
      mcap: ${r.entry.mcap != null ? fmtUsd(r.entry.mcap) : "—"} · tvl: ${r.entry.tvl != null ? fmtUsd(r.entry.tvl) : "—"} · volume: ${r.entry.volume != null ? fmtUsd(r.entry.volume) : "—"}
    </div>`
      : "";

  const exitSection =
    r.exit && r.status === "closed"
      ? `
    <div class="detail-section-title">Exit Snapshot</div>
    <div class="detail-notes">
      mcap: ${r.exit.mcap != null ? fmtUsd(r.exit.mcap) : "—"} · tvl: ${r.exit.tvl != null ? fmtUsd(r.exit.tvl) : "—"} · volume: ${r.exit.volume != null ? fmtUsd(r.exit.volume) : "—"}
    </div>`
      : "";

  const closeReasonSection = r.close_reason
    ? `<div class="detail-section-title">Close Reason</div><div class="detail-notes">${escapeHtml(r.close_reason)}</div>`
    : "";

  const notesSection =
    r.notes && r.notes.length
      ? `<div class="detail-section-title">Notes</div><div class="detail-notes">${r.notes.map(escapeHtml).join("<br/>")}</div>`
      : "";

  const timingSection = `
    <div class="detail-section-title">Timing</div>
    <div class="detail-notes">Deployed: ${fmtDate(r.deployed_at)}${r.closed_at ? `<br/>Closed: ${fmtDate(r.closed_at)}` : ""}</div>
  `;

  $("#detailContent").innerHTML = `
    ${statusBadge}
    <div class="detail-title">${escapeHtml(r.pool_name || "Unknown pool")}</div>
    <div class="detail-pool-id">${escapeHtml(r.pool || "")}</div>
    <div class="detail-grid">${detailGrid}</div>
    <div class="detail-section-title">Price Chart</div>
    <div class="chart-wrap chart-wrap-price">
      <div id="chartStatus" class="chart-status">Loading chart…</div>
      <canvas id="priceChartCanvas" height="320"></canvas>
    </div>
    <div id="rsiChartWrap" class="chart-wrap chart-wrap-rsi hidden">
      <div class="chart-subtitle">RSI(<span id="rsiLengthLabel">2</span>)</div>
      <canvas id="rsiChartCanvas" height="150"></canvas>
    </div>
    ${entryExitSection}
    ${exitSection}
    ${closeReasonSection}
    ${timingSection}
    ${notesSection}
  `;

  $("#detailOverlay").classList.remove("hidden");
  loadPriceChart(r);
}

function destroyPriceChart() {
  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }
  if (rsiChart) {
    rsiChart.destroy();
    rsiChart = null;
  }
}

async function loadPriceChart(r) {
  destroyPriceChart();
  const statusEl = $("#chartStatus");
  const canvas = $("#priceChartCanvas");
  if (!statusEl || !canvas) return;

  try {
    const data = await fetchJSON(`/api/positions/${encodeURIComponent(r.position)}/chart`);
    if (!data.candles || !data.candles.length) {
      statusEl.textContent = "No chart data available for this pool.";
      canvas.style.display = "none";
      return;
    }

    statusEl.style.display = "none";
    canvas.style.display = "block";

    // {x, y} points on a real numeric (linear) x-axis, NOT a category scale
    // built from pre-formatted label strings. This is a deliberate fix: the
    // previous category-axis approach required deploy/close line
    // annotations to resolve either a raw array index or a label string to
    // a pixel position, and that resolution silently failed (no error, the
    // lines just never drew) even after correcting index->label. Using the
    // SAME numeric timestamp for both the data points and the annotations
    // removes that resolution step entirely — there's no separate "which
    // category is this" lookup for the plugin to get wrong.
    const points = data.candles.map((c) => ({ x: c.ts, y: c.c }));

    const deployedSec = data.deployed_at ? Math.floor(new Date(data.deployed_at).getTime() / 1000) : null;
    const closedSec = data.closed_at ? Math.floor(new Date(data.closed_at).getTime() / 1000) : null;

    // Computed once, directly from the data, and given to BOTH charts as
    // literal numbers below — not read back from priceChart.scales.x after
    // construction. That read-back approach (what this used to do) meant
    // the RSI chart's range depended on Chart.js's internal scale state at
    // whatever moment it happened to be read, which isn't guaranteed to be
    // final/settled yet (responsive layout can still be resolving), and
    // was the actual cause of the two panels' x-axes drifting out of sync
    // — not just the y-axis gutter width mismatch fixed earlier (that was
    // real too, but not the whole story). A shared min/max computed once
    // in plain JS has no such timing dependency: both charts are told the
    // exact same two numbers before either one exists.
    const xValues = points.map((p) => p.x);
    if (deployedSec != null) xValues.push(deployedSec);
    if (closedSec != null) xValues.push(closedSec);
    const chartXMin = Math.min(...xValues);
    const chartXMax = Math.max(...xValues);

    const annotations = {};

    if (data.bin_top_usd != null && data.bin_bottom_usd != null) {
      annotations.binRangeBand = {
        type: "box",
        yMin: data.bin_bottom_usd,
        yMax: data.bin_top_usd,
        backgroundColor: "rgba(95, 208, 192, 0.08)",
        borderColor: "rgba(95, 208, 192, 0.35)",
        borderWidth: 1,
      };
      annotations.binTop = {
        type: "line",
        yMin: data.bin_top_usd,
        yMax: data.bin_top_usd,
        borderColor: "#5fd0c0",
        borderWidth: 1,
        borderDash: [5, 4],
        label: { display: true, content: `Bin top $${fmtCompactPrice(data.bin_top_usd)}`, position: "start", backgroundColor: "#12161f", color: "#5fd0c0", font: { size: 10 }, padding: 4 },
      };
      annotations.binBottom = {
        type: "line",
        yMin: data.bin_bottom_usd,
        yMax: data.bin_bottom_usd,
        borderColor: "#5fd0c0",
        borderWidth: 1,
        borderDash: [5, 4],
        label: { display: true, content: `Bin bottom $${fmtCompactPrice(data.bin_bottom_usd)}`, position: "start", backgroundColor: "#12161f", color: "#5fd0c0", font: { size: 10 }, padding: 4 },
      };
    }

    if (deployedSec != null) {
      annotations.deployLine = {
        type: "line",
        xMin: deployedSec,
        xMax: deployedSec,
        borderColor: "#4ade80",
        borderWidth: 2,
        label: { display: true, content: "Deployed", position: "start", rotation: 0, backgroundColor: "#12161f", color: "#4ade80", font: { size: 10 }, padding: 4 },
      };
    }
    if (closedSec != null) {
      annotations.closeLine = {
        type: "line",
        xMin: closedSec,
        xMax: closedSec,
        borderColor: "#f2596a",
        borderWidth: 2,
        label: { display: true, content: "Closed", position: "end", rotation: 0, backgroundColor: "#12161f", color: "#f2596a", font: { size: 10 }, padding: 4 },
      };
    }

    // Bollinger band — the actual indicator the live bot's own entry/exit
    // confirmation reads (server.js's buildPriceChart computes it from the
    // same tools/indicators-local.js used there). Upper/lower shown as
    // visible lines with a light fill between them; middle band shown
    // faintly since it's the reference line the width is built from, not
    // itself a decision boundary.
    const bbUpperPoints = data.bollinger?.points?.map((p) => ({ x: p.ts, y: p.upper })) ?? [];
    const bbLowerPoints = data.bollinger?.points?.map((p) => ({ x: p.ts, y: p.lower })) ?? [];
    const bbMiddlePoints = data.bollinger?.points?.map((p) => ({ x: p.ts, y: p.middle })) ?? [];
    const hasBollinger = bbUpperPoints.length > 0;

    const datasets = [
      {
        label: "Price (USD)",
        data: points,
        borderColor: "#f2a65a",
        backgroundColor: "rgba(242, 166, 90, 0.08)",
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.15,
        order: 1,
      },
    ];
    if (hasBollinger) {
      datasets.push(
        {
          label: `Bollinger upper (${data.bollinger.interval})`,
          data: bbUpperPoints,
          borderColor: "rgba(129, 140, 248, 0.85)",
          backgroundColor: "rgba(129, 140, 248, 0.06)",
          borderWidth: 1.25,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: "+1", // fills down to the next dataset (lower band) — the band itself
          tension: 0.1,
          order: 2,
        },
        {
          label: `Bollinger lower (${data.bollinger.interval})`,
          data: bbLowerPoints,
          borderColor: "rgba(129, 140, 248, 0.85)",
          borderWidth: 1.25,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          order: 3,
        },
        {
          label: `Bollinger middle (${data.bollinger.interval})`,
          data: bbMiddlePoints,
          borderColor: "rgba(129, 140, 248, 0.35)",
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          order: 4,
        }
      );
    }

    priceChart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        parsing: false, // data is already {x, y} — skip Chart.js's default per-point parsing
        scales: {
          x: {
            type: "linear",
            min: chartXMin, // same shared range given to the RSI chart below — see chartXMin/chartXMax's definition, and CHART_Y_AXIS_WIDTH/CHART_RSI_X_AXIS_OFFSET_PX for the pixel-alignment knobs
            max: chartXMax,
            ticks: {
              color: "#5a6478", maxTicksLimit: 8, font: { size: 10 },
              callback: (v) => new Date(v * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            },
            grid: { color: "rgba(255,255,255,0.04)" },
          },
          y: {
            ticks: { color: "#5a6478", font: { size: 10 }, callback: (v) => `$${fmtCompactPrice(v)}` },
            grid: { color: "rgba(255,255,255,0.04)" },
            // Pinned to the SAME fixed width the RSI chart's y-axis uses
            // below (see RSI_Y_AXIS_WIDTH) — without this, each chart's
            // y-axis reserves however much space its own labels happen to
            // need (price: long strings like "$0.0000234"; RSI: short
            // "0"/"25"/.../"100"), so the two charts' plotting areas start
            // at different x-pixels even with an identical x-axis range.
            // That's what made the deploy/close vertical lines look
            // misaligned between the two panels — not the x-axis range
            // itself, which was already correct.
            afterFit: (scale) => { scale.width = CHART_Y_AXIS_WIDTH; },
          },
        },
        plugins: {
          legend: {
            display: hasBollinger,
            labels: { color: "#8a93a6", font: { size: 10 }, boxWidth: 14, boxHeight: 2, padding: 12, filter: (item) => item.text !== `Bollinger middle (${data.bollinger?.interval})` },
          },
          tooltip: {
            backgroundColor: "#191f2b",
            borderColor: "#262e3d",
            borderWidth: 1,
            titleColor: "#e8ebf1",
            bodyColor: "#e8ebf1",
            callbacks: {
              title: (items) => items.length ? new Date(items[0].parsed.x * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
              label: (ctx) => `${ctx.dataset.label}: $${fmtCompactPrice(ctx.parsed.y)}`,
            },
          },
          annotation: { annotations },
        },
      },
    });

    // RSI panel — separate Chart.js instance (not a second y-axis on the
    // same chart) since RSI's 0-100 range has nothing to do with the price
    // axis; sharing an axis would make both unreadable. Same x-axis type
    // and time window as the price chart above so a person can visually
    // line up a price move with the RSI reading at that exact moment.
    const rsiWrap = $("#rsiChartWrap");
    const rsiCanvas = $("#rsiChartCanvas");
    if (data.rsi?.points?.length && rsiWrap && rsiCanvas) {
      rsiWrap.classList.remove("hidden");
      $("#rsiLengthLabel").textContent = data.rsi.length ?? 2;
      const rsiPoints = data.rsi.points.map((p) => ({ x: p.ts, y: p.value }));

      const rsiAnnotations = {
        oversold: {
          type: "line", yMin: data.rsi.oversold, yMax: data.rsi.oversold,
          borderColor: "rgba(95, 208, 192, 0.5)", borderWidth: 1, borderDash: [4, 3],
          label: { display: true, content: `Oversold ${data.rsi.oversold}`, position: "start", backgroundColor: "#12161f", color: "#5fd0c0", font: { size: 9 }, padding: 3 },
        },
        overbought: {
          type: "line", yMin: data.rsi.overbought, yMax: data.rsi.overbought,
          borderColor: "rgba(242, 89, 106, 0.5)", borderWidth: 1, borderDash: [4, 3],
          label: { display: true, content: `Overbought ${data.rsi.overbought}`, position: "start", backgroundColor: "#12161f", color: "#f2596a", font: { size: 9 }, padding: 3 },
        },
      };
      // Only shown when stopLossRsiConfirm is actually on — this is the
      // exact threshold stoploss-rsi-guard.js waits for before closing a
      // stop-loss-triggered position, so seeing where it would have fired
      // historically is the whole point of this chart per the "find a new
      // exit strategy" ask.
      if (data.rsi.stop_loss_threshold != null) {
        rsiAnnotations.stopLossThreshold = {
          type: "line", yMin: data.rsi.stop_loss_threshold, yMax: data.rsi.stop_loss_threshold,
          borderColor: "#f2a65a", borderWidth: 1.5,
          label: { display: true, content: `Stop-loss RSI confirm ${data.rsi.stop_loss_threshold}`, position: "end", backgroundColor: "#12161f", color: "#f2a65a", font: { size: 9 }, padding: 3 },
        };
      }
      if (deployedSec != null) {
        rsiAnnotations.deployLine = { type: "line", xMin: deployedSec, xMax: deployedSec, borderColor: "#4ade80", borderWidth: 2 };
      }
      if (closedSec != null) {
        rsiAnnotations.closeLine = { type: "line", xMin: closedSec, xMax: closedSec, borderColor: "#f2596a", borderWidth: 2 };
      }

      rsiChart = new Chart(rsiCanvas.getContext("2d"), {
        type: "line",
        data: {
          datasets: [{
            label: `RSI(${data.rsi.length ?? 2})`,
            data: rsiPoints,
            borderColor: "#c084fc",
            backgroundColor: "rgba(192, 132, 252, 0.08)",
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          parsing: false,
          scales: {
            x: {
              type: "linear",
              min: chartXMin, // same shared range given to the price chart above — see chartXMin/chartXMax's definition
              max: chartXMax,
              ticks: {
                color: "#5a6478", maxTicksLimit: 8, font: { size: 10 },
                callback: (v) => new Date(v * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
              },
              grid: { color: "rgba(255,255,255,0.04)" },
            },
            y: {
              min: 0, max: 100,
              ticks: { color: "#5a6478", font: { size: 10 }, stepSize: 25 },
              grid: { color: "rgba(255,255,255,0.04)" },
              afterFit: (scale) => { scale.width = CHART_Y_AXIS_WIDTH + CHART_RSI_X_AXIS_OFFSET_PX; }, // see CHART_RSI_X_AXIS_OFFSET_PX's comment near the top of this file
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "#191f2b",
              borderColor: "#262e3d",
              borderWidth: 1,
              titleColor: "#e8ebf1",
              bodyColor: "#e8ebf1",
              callbacks: {
                title: (items) => items.length ? new Date(items[0].parsed.x * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
                label: (ctx) => `RSI: ${ctx.parsed.y.toFixed(1)}`,
              },
            },
            annotation: { annotations: rsiAnnotations },
          },
        },
      });
    } else if (rsiWrap) {
      rsiWrap.classList.add("hidden");
    }
  } catch (err) {
    statusEl.textContent = `Chart unavailable: ${err.message}`;
    canvas.style.display = "none";
    console.error(err);
  }
}

function nearestIndex(candles, targetTs) {
  let bestIdx = null;
  let bestDiff = Infinity;
  candles.forEach((c, i) => {
    const diff = Math.abs(c.ts - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function fmtCompactPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

function closeDetail() {
  $("#detailOverlay").classList.add("hidden");
  destroyPriceChart();
}

// escapeHtml now lives in common.js.

// ─── Wiring ─────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.filter = tab.dataset.filter;
    state.page = 1;
    renderPositions();
  });
});

$("#refreshBtn").addEventListener("click", loadData);
$("#detailClose").addEventListener("click", closeDetail);
$("#detailOverlay").addEventListener("click", (e) => {
  if (e.target === $("#detailOverlay")) closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

loadData();
setInterval(loadData, REFRESH_MS);
