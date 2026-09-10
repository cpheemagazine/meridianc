import { config, isDryRunFilterBypassActive } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { confirmIndicatorPreset, fetchChartIndicatorsForMint } from "./chart-indicators.js";
import { discoverGmgnPools } from "./gmgn.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this reference
// window, so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity   → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity        → unique_lps + positions_created
 *   3. Fees paid to LPs          → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity                 → active_tvl (log floor — dust pools can't win on ratios)
 * Efficiency only (no momentum/change_pct), per design. Targets are configurable so the
 * score can be calibrated; each sub-score saturates at its target.
 *
 * The volume/fee/LP inputs are measured over `config.screening.timeframe`, so they are
 * normalized to a fixed 30m reference window before scoring — the targets are expressed
 * in 30m terms and stay valid even if the timeframe changes (5m, 1h, 24h, …). Liquidity
 * is a level, not a rate, so it is not scaled.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,    // (30m) volume/active_tvl that earns a full trading sub-score
    targetLpCount = 40,     // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,  // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  // Meridian is single-sided-SOL-only (deploy_position always sets amount_y=SOL,
  // amount_x=0) — a pool whose quote token isn't SOL will pass every other filter
  // here and then fail deploy every single time with an opaque on-chain error.
  // Confirmed live on 2026-07-20: a USDC-quoted pool (Jimothy-USDC) got 10 repeated
  // failed deploy attempts over 3.5 hours before anyone noticed why.
  const quoteMint = quote?.address;
  if (quoteMint && quoteMint !== config.tokens.SOL) {
    return `quote token is ${quote?.symbol || quoteMint.slice(0, 8)}, not SOL — single-sided SOL deploys aren't compatible with this pool`;
  }

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot
      await refreshDiscordOnlyPools(rawPools, s.timeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, s.timeframe);
      }
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const source = String(config.screening.source || "meteora").toLowerCase();
  if (!["meteora", "gmgn", "both"].includes(source)) {
    throw new Error(`Invalid screeningSource: ${config.screening.source}. Use meteora, gmgn, or both.`);
  }

  let pools = [];
  let filteredOut = [];
  let gmgnStageCounts = null; // set below when the gmgn/both source path runs — surfaced in the final return for candidate-snapshots.js

  if (source === "both") {
    const [meteoraResult, gmgnResult] = await Promise.allSettled([
      discoverPools({ page_size: 50 }),
      discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) }),
    ]);

    if (meteoraResult.status === "fulfilled") {
      pools.push(...(meteoraResult.value.pools || []));
      filteredOut.push(...(meteoraResult.value.filtered_examples || []));
      log("screening", `Dual-source: Meteora returned ${meteoraResult.value.pools?.length ?? 0} pools`);
    } else {
      log("screening", `Dual-source: Meteora failed — ${meteoraResult.reason?.message}`);
    }

    if (gmgnResult.status === "fulfilled") {
      const gmgnPools = gmgnResult.value.pools || [];
      filteredOut.push(...(gmgnResult.value.filtered_examples || []));
      gmgnStageCounts = gmgnResult.value.stage_counts || null;
      log("screening", `Dual-source: GMGN returned ${gmgnPools.length} pools`);

      // Blacklist + dev check for GMGN pools (Meteora's discoverPools does this internally)
      const gmgnFiltered = gmgnPools.filter((p) => {
        if (isBlacklisted(p.base?.mint)) {
          return pushFilteredReason(filteredOut, p, "blacklisted token", "blacklisted");
        }
        if (p.dev && isDevBlocked(p.dev)) {
          return pushFilteredReason(filteredOut, p, "blocked deployer", "blocked_deployer");
        }
        return true;
      });
      pools.push(...gmgnFiltered);
    } else {
      log("screening", `Dual-source: GMGN failed — ${gmgnResult.reason?.message}`);
    }

    // Deduplicate by pool address — prefer the GMGN entry on a tie (richer data:
    // KOL info, smart wallets, bot degen rates).
    const seenPools = new Map();
    for (const p of pools) {
      if (!p.pool) continue;
      const existing = seenPools.get(p.pool);
      if (!existing || p.gmgn) seenPools.set(p.pool, p);
    }
    pools = [...seenPools.values()];
    log("screening", `Dual-source: merged to ${pools.length} unique pools`);
  } else if (source === "gmgn") {
    const discovery = await discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) });
    filteredOut.push(...(discovery.filtered_examples || []));
    gmgnStageCounts = discovery.stage_counts || null;
    pools = (discovery.pools || []).filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        return pushFilteredReason(filteredOut, p, "blacklisted token", "blacklisted");
      }
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol}`);
        return pushFilteredReason(filteredOut, p, "blocked deployer", "blocked_deployer");
      }
      return true;
    });
  } else {
    const discovery = await discoverPools({ page_size: 50 });
    pools = discovery.pools || [];
    filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];
  }

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);

  const eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        return pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`, "min_tvl");
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        return pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`, "max_tvl");
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        return pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`, "min_fee_tvl_ratio");
      }
      if (!isUsableVolatility(p.volatility)) {
        return pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`, "no_volatility");
      }
      if (occupiedPools.has(p.pool)) {
        return pushFilteredReason(filteredOut, p, "already have an open position in this pool", "already_open_pool");
      }
      if (occupiedMints.has(p.base?.mint)) {
        return pushFilteredReason(filteredOut, p, "already holding this base token in another pool", "already_holding_token");
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        return pushFilteredReason(filteredOut, p, "pool cooldown active", "pool_cooldown");
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        return pushFilteredReason(filteredOut, p, "token cooldown active", "token_cooldown");
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      const bypassActive = isDryRunFilterBypassActive();
      pvpRemoved.forEach((p) => {
        pushFilteredReason(filteredOut, p, "PVP hard filter", "pvp_filter");
        if (bypassActive) p.would_reject ??= { reason: "PVP hard filter", code: "pvp_filter" };
      });
      if (!bypassActive) eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Dev blocklist check — filter pools whose creator is on the blocklist
  if (eligible.length > 0) {
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        return pushFilteredReason(filteredOut, p, "blocked deployer", "blocked_deployer");
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via dev blocklist`);
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`, "indicator_reject");
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  // Entry RSI hard gate — separate from the block above (that one is the
  // Supertrend-break-style preset system, gated by config.indicators.enabled;
  // this is its own independently-toggleable check). Rejects any candidate
  // whose RSI is NOT below entryRsiThreshold — i.e. don't buy into an
  // already-overbought local top.
  if (config.screening.entryRsiGateEnabled && eligible.length > 0) {
    const rsiInterval = config.management.stopLossRsiInterval || "15_MINUTE"; // same interval knob every other RSI feature in this codebase reads — "RSI(2)" should mean the same thing everywhere
    const rsiLength = Number(config.management.stopLossRsiLength ?? 2);
    const threshold = Number(config.screening.entryRsiThreshold ?? 70);

    const rsiChecks = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const payload = await fetchChartIndicatorsForMint(pool.base?.mint, { interval: rsiInterval, rsiLength });
          return { pool: pool.pool, rsi: safeNumber(payload?.latest?.rsi?.value) };
        } catch (error) {
          log("indicators_warn", `Entry RSI gate: fetch failed for ${pool.name} (${pool.pool.slice(0, 8)}): ${error.message}`);
          return { pool: pool.pool, rsi: null, error: error.message }; // fails OPEN below — see this block's header comment
        }
      }),
    );
    const rsiByPool = new Map(rsiChecks.map((entry) => [entry.pool, entry]));
    const beforeRsiGate = eligible.length;
    const rsiPassedEligible = eligible.filter((pool) => {
      const check = rsiByPool.get(pool.pool);
      pool.entry_rsi = check?.rsi ?? null;
      if (check?.rsi == null) return true; // fetch failed or no data — fail open, don't block on an RSI outage
      if (check.rsi < threshold) return true;
      log("screening", `Entry RSI gate rejected ${pool.name} (${pool.pool.slice(0, 8)}): RSI(${rsiLength})@${rsiInterval}=${check.rsi.toFixed(1)} >= ${threshold}`);
      return pushFilteredReason(filteredOut, pool, `entry RSI gate: RSI(${rsiLength})@${rsiInterval}=${check.rsi.toFixed(1)} >= ${threshold}`, "entry_rsi_gate");
    });
    eligible.splice(0, eligible.length, ...rsiPassedEligible);
    if (eligible.length < beforeRsiGate) {
      log("screening", `Entry RSI gate removed ${beforeRsiGate - eligible.length} candidate(s)`);
    }
  }

  // Filter funnel summary — reliable, per-category breakdown of WHICH
  // filter is doing the rejecting, on every cycle. Tallied from
  // filteredOut's `code` field (pushFilteredReason's 4th arg) rather than
  // parsing the free-text reason strings — those have a different $/%
  // figure embedded per candidate, so exact string matching can't count
  // them reliably. Entries without a code (e.g. any pre-existing rejection
  // from discoverPools()'s own server-side Meteora query filtering, folded
  // into filteredOut before this function's own checks ever run) fall
  // into "other" rather than being silently dropped from the tally.
  // Logged unconditionally — including when eligible.length is 0, since
  // that's exactly the case this is most useful for.
  {
    const tally = {};
    for (const f of filteredOut) {
      const code = f.code || "other";
      tally[code] = (tally[code] || 0) + 1;
    }
    const tallyEntries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (tallyEntries.length > 0) {
      const breakdown = tallyEntries.map(([code, n]) => `${code}=${n}`).join(", ");
      log("screening", `Filter funnel: ${filteredOut.length} rejected of ${pools.length} raw → ${breakdown} → ${eligible.length} survived`);
    }
    if (gmgnStageCounts) log("screening", `GMGN funnel: ${JSON.stringify(gmgnStageCounts)}`);
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
    // Uncapped rejection list — filtered_examples above stays capped at 3
    // (kept small deliberately, it feeds the LLM's own prompt), this is
    // the full list for candidate-snapshots.js, covering the same ground
    // as `node cli.js census` (every pool considered, pass or reject and
    // why) rather than just the winners.
    all_filtered_examples: filteredOut,
    stage_counts: gmgnStageCounts,
  };
}

/**
 * Re-sort an already-fetched candidate list by a named mode. Used by the CLI
 * `pools` command for a one-off view without touching config.screening.sortBy
 * (which controls what the real screening cycle actually uses — see
 * scoreCandidate, used inside getTopCandidates's own .sort() before this
 * function would ever see the list). Operates on condensePool's shape.
 */
export function sortCandidates(candidates, sortBy, opportunityConfig = {}) {
  const list = [...candidates];
  switch (sortBy) {
    case "fee_tvl":
      return list.sort((a, b) => (b.fee_active_tvl_ratio ?? -Infinity) - (a.fee_active_tvl_ratio ?? -Infinity));
    case "volume":
      return list.sort((a, b) => (b.volume_window ?? -Infinity) - (a.volume_window ?? -Infinity));
    case "volume_tvl_ratio":
      return list.sort((a, b) => (b.volume_active_tvl_ratio ?? -Infinity) - (a.volume_active_tvl_ratio ?? -Infinity));
    case "tvl":
      return list.sort((a, b) => (b.tvl ?? -Infinity) - (a.tvl ?? -Infinity));
    case "activity":
      return list.sort((a, b) => (b.unique_lps ?? -Infinity) - (a.unique_lps ?? -Infinity));
    case "fee_asc":
      return list.sort((a, b) => (a.fee_pct ?? Infinity) - (b.fee_pct ?? Infinity));
    case "degen_score":
    default:
      return list.sort((a, b) => degenScore(b, opportunityConfig) - degenScore(a, opportunityConfig));
  }
}

/**
 * `census` — the full pre-filter (token, pool) universe, unlike
 * getTopCandidates which only returns what survives every config filter.
 * This is the "why isn't X showing up as a candidate at all" view.
 *
 * discoverPools() (above) applies the whole filter set SERVER-SIDE, as a
 * filter_by= query string the pool-discovery API evaluates before it ever
 * returns pools — so there's no client-side "broad fetch, then filter"
 * step to skip the way an EVM/DexScreener-batch pipeline would have. To
 * get a genuine pre-filter view here, this fetches with a deliberately
 * loose filter (pool_type=dlmm + a low TVL floor, just enough to keep the
 * page from being dominated by total dust) and evaluates each RAW pool
 * against the real filters client-side via getRawPoolScreeningRejectReason
 * — the exact same function discoverPools() itself uses to build its
 * filtered_examples, so "would this pass" here can't drift from what the
 * real screening cycle actually decides.
 */
export async function getCensusUniverse({ page_size = 100, minTvlFloor = 1000 } = {}) {
  const s = config.screening;
  const t0 = Date.now();

  const filters = ["pool_type=dlmm", `tvl>=${minTvlFloor}`].join("&&");
  let data;
  try {
    data = await fetchPoolDiscoveryPage({ page_size, filters, timeframe: s.timeframe, category: s.category });
  } catch (err) {
    return { entries: [], total_pairs: 0, scanned_ms: Date.now() - t0, note: `Census fetch failed: ${err.message}` };
  }

  const rawPools = Array.isArray(data.data) ? data.data : [];
  const entries = rawPools.map((raw) => {
    const rejectReason = getRawPoolScreeningRejectReason(raw, s);
    const c = condensePool(raw);
    return { ...c, would_pass_screening: rejectReason === null, reject_reason: rejectReason };
  });

  return {
    entries,
    total_pairs: entries.length,
    would_pass_count: entries.filter((e) => e.would_pass_screening).length,
    timeframe: s.timeframe,
    scanned_ms: Date.now() - t0,
    note: data.total > rawPools.length ? `Showing ${rawPools.length} of ${data.total} total dlmm pools (increase page_size for more)` : null,
  };
}

/**
 * Runs async fn over items with bounded concurrency. Small local helper —
 * not worth a new module for one use site.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * `dlmm-pools` — every real Meteora DLMM pool per candidate token, not just
 * the single best one discoverPools()/getTopCandidates() would return.
 *
 * Ported from a sibling EVM fork's "v4pools" (per-token fee-tier discovery
 * via on-chain RPC across a small fixed set of Uniswap v4 fee tiers). That
 * mechanism doesn't translate: DLMM pools aren't derivable on-chain from a
 * token address the way CREATE2 v4 pools are — different bin_step pools
 * for the same pair are independently created pools, discoverable only via
 * the datapi search API (tools/dlmm.js's searchPools), not RPC. So this
 * calls searchPools per token instead of an RPC tick-scan — genuinely
 * cheaper than the EVM version (one HTTP call per token vs. several RPC
 * round-trips), but still bounded by tokenLimit + concurrency out of the
 * same caution: no need to hammer the datapi harder than a human scanning
 * the terminal actually needs.
 */
export async function getDlmmPoolsUniverse({ tokenLimit = 30, passingOnly = true, concurrency = 3 } = {}) {
  const { searchPools } = await import("./dlmm.js");
  const census = await getCensusUniverse({});
  let scope = census.entries;
  if (passingOnly) scope = scope.filter((e) => e.would_pass_screening);
  // One row per token, not per pool — a token can have multiple pools in
  // the census itself (different bin_step on the same pair).
  const byToken = new Map();
  for (const e of scope) {
    if (!e.base?.mint) continue;
    if (!byToken.has(e.base.mint)) byToken.set(e.base.mint, e);
  }
  scope = [...byToken.values()].slice(0, tokenLimit);

  const t0 = Date.now();
  const results = await mapLimit(scope, concurrency, async (e) => {
    let found;
    try {
      found = await searchPools({ query: e.base.symbol || e.base.mint, limit: 20 });
    } catch (err) {
      return { ...e, pools: [], error: err.message?.slice(0, 100) ?? "search failed" };
    }
    // searchPools matches by name/symbol text search, which can surface
    // other tokens with similar tickers — keep only pools that actually
    // have this exact base mint on one side.
    const pools = (found.pools || []).filter((p) => p.token_x?.mint === e.base.mint || p.token_y?.mint === e.base.mint);
    const poolRows = pools
      .map((p) => ({
        pool: p.pool,
        name: p.name,
        bin_step: p.bin_step,
        fee_pct: p.fee_pct,
        tvl: p.tvl,
        volume_24h: p.volume_24h,
      }))
      .sort((a, b) => (b.tvl ?? -Infinity) - (a.tvl ?? -Infinity));
    return { ...e, pools: poolRows, total_pools_found: poolRows.length };
  });

  return {
    tokens_scanned: scope.length,
    total_dlmm_pools: results.reduce((n, r) => n + r.pools.length, 0),
    scanned_ms: Date.now() - t0,
    tokens: results,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    unique_lps_change_pct: fix(p.unique_lps_change_pct, 1),
    positions_created: p.positions_created,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

// Returns true = caller should reject/continue as normal; false = the
// bypass is active, caller should let the candidate through instead (see
// isDryRunFilterBypassActive's comment in config.js). Still records the
// reason either way — this is what makes dryRunBypassFilters a genuine
// data-capture mode rather than just "screening off": you get the full
// candidate universe AND a record of what would have rejected each one.
function pushFilteredReason(list, pool, reason, code = "other") {
  if (!list || !pool) return true;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
    code,
  });
  if (isDryRunFilterBypassActive()) {
    pool.would_reject = pool.would_reject || { reason, code };
    return false;
  }
  return true;
}
