const REFRESH_MS = 15000;

async function loadData() {
  const btn = $("#refreshBtn");
  btn.classList.add("spinning");
  try {
    const summary = await fetchJSON("/api/summary");
    renderPools(summary.by_pool || []);
    $("#lastUpdated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $("#lastUpdated").textContent = `error: ${err.message}`;
    console.error(err);
  } finally {
    setTimeout(() => btn.classList.remove("spinning"), 400);
  }
}

function renderPools(pools) {
  if (!pools.length) {
    $("#poolTable").innerHTML = `<div class="pool-empty">No closed trades yet — pool performance will appear here once positions close.</div>`;
    return;
  }
  const rows = pools
    .map(
      (p) => `
    <div class="pool-row">
      <div class="pname">${escapeHtml(p.pool_name)}</div>
      <div class="num">${p.trades}</div>
      <div class="num">${p.win_rate}%</div>
      <div class="num" style="color:${p.pnl_usd >= 0 ? "var(--green)" : "var(--red)"}">${fmtUsd(p.pnl_usd, { forceSign: true })}</div>
    </div>`
    )
    .join("");
  $("#poolTable").innerHTML = `
    <div class="pool-row header">
      <div>Pool</div><div class="num">Trades</div><div class="num">Win%</div><div class="num">PnL</div>
    </div>
    ${rows}
  `;
}

$("#refreshBtn").addEventListener("click", loadData);

loadData();
setInterval(loadData, REFRESH_MS);
