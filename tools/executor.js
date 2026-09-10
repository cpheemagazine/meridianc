import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";
import { getRsiWaitLockHolder } from "../rsi-wait-lock.js";

import { getPoolMemory, addPoolNote, recordDeployFailure } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
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
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  // Liquidity-concentration check: a pool can clear the flat minTvl floor
  // (e.g. $10k) while still being thin enough that your own position is a
  // meaningful fraction of it -- and thin enough that a fast dump can trap a
  // wide single-sided range deep underwater with real exit slippage on top
  // of the market move itself. Cap position size relative to *live* TVL
  // (fetched fresh above, not the possibly-stale screening-time snapshot).
  const maxPositionToTvlPct = numberOrNull(config.management.maxPositionToTvlPct);
  if (maxPositionToTvlPct != null && maxPositionToTvlPct > 0) {
    const deployAmountSol = Number(args.amount_y ?? args.amount_sol ?? 0);
    if (deployAmountSol > 0) {
      const balances = await getWalletBalances().catch(() => null);
      const solPrice = balances?.sol_price;
      if (solPrice != null && solPrice > 0) {
        const deployValueUsd = deployAmountSol * solPrice;
        const positionToTvlPct = (deployValueUsd / tvl) * 100;
        if (positionToTvlPct > maxPositionToTvlPct) {
          return {
            pass: false,
            reason: `Position size $${deployValueUsd.toFixed(2)} would be ${positionToTvlPct.toFixed(1)}% of this pool's $${tvl} TVL — above configured maxPositionToTvlPct ${maxPositionToTvlPct}%. Pool is too thin for this position size.`,
          };
        }
      }
      // If SOL price couldn't be resolved, don't block the deploy on that
      // alone -- the other threshold checks (TVL floor, fee/TVL ratio,
      // volatility) already ran and passed.
    }
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  return { pass: true, entryMarketData };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "stopLossEnabled",
    "stopLossRsiConfirm",
    "stopLossRsiRequireOutOfRange",
    "trailingTpRsiConfirm",
    "oorRsiConfirm",
    "lowYieldRsiConfirm",
    "liquidityRsiConfirm",
    "triggerScreeningWhenIdle",
    "takeProfitRsiConfirm",
    "peakRsiExitEnabled",
    "entryRsiGateEnabled",
    "dryRunBypassFilters",
    "deadPositionGuardEnabled",
    "feeStallGuardEnabled",
    "maxDownsideModeEnabled",
    "peakRsiExitRequireOutOfRange",
    "peakRsiExitMinPnlPctEnabled",
    "suspiciousTickLogEnabled",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
    "postCloseTrackEnabled",
    "volumeTrendEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "gmgnFeeSource",
    "gmgnApiKey",
    "screeningSource",
    "stopLossRsiInterval",
    "indicatorDataSource",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      screeningSource: ["screening", "source"],
      triggerScreeningWhenIdle: ["management", "triggerScreeningWhenIdle"],
      entryRsiGateEnabled: ["screening", "entryRsiGateEnabled"],
      dryRunBypassFilters: ["screening", "dryRunBypassFilters"],
      entryRsiThreshold: ["screening", "entryRsiThreshold"],
      deadPositionGuardEnabled: ["management", "deadPositionGuardEnabled"],
      deadPositionMaxSuspiciousMinutes: ["management", "deadPositionMaxSuspiciousMinutes"],
      deadPositionMaxValueUsd: ["management", "deadPositionMaxValueUsd"],
      feeStallGuardEnabled: ["management", "feeStallGuardEnabled"],
      feeStallThresholdHours: ["management", "feeStallThresholdHours"],
      feeStallMinAgeMinutes: ["management", "feeStallMinAgeMinutes"],
      suspiciousTickLogEnabled: ["logging", "suspiciousTickLogEnabled"],
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossEnabled: ["management", "stopLossEnabled"],
      stopLossPct: ["management", "stopLossPct"],
      stopLossRsiConfirm: ["management", "stopLossRsiConfirm"],
      stopLossRsiThreshold: ["management", "stopLossRsiThreshold"],
      stopLossRsiInterval: ["management", "stopLossRsiInterval"],
      stopLossRsiLength: ["management", "stopLossRsiLength"],
      stopLossRsiMaxWaitMinutes: ["management", "stopLossRsiMaxWaitMinutes"],
      stopLossRsiRecheckSec: ["management", "stopLossRsiRecheckSec"],
      stopLossRsiGuardIntervalMin: ["management", "stopLossRsiGuardIntervalMin"],
      stopLossRsiRequireOutOfRange: ["management", "stopLossRsiRequireOutOfRange"],
      stopLossRsiResetAfterMinutes: ["management", "stopLossRsiResetAfterMinutes"],
      trailingTpRsiConfirm: ["management", "trailingTpRsiConfirm"],
      oorRsiConfirm: ["management", "oorRsiConfirm"],
      lowYieldRsiConfirm: ["management", "lowYieldRsiConfirm"],
      liquidityRsiConfirm: ["management", "liquidityRsiConfirm"],
      exitRsiThreshold: ["management", "exitRsiThreshold"],
      exitRsiMaxWaitMinutes: ["management", "exitRsiMaxWaitMinutes"],
      exitRsiRecheckSec: ["management", "exitRsiRecheckSec"],
      exitRsiGuardIntervalMin: ["management", "exitRsiGuardIntervalMin"],
      takeProfitRsiConfirm: ["management", "takeProfitRsiConfirm"],
      takeProfitRsiThreshold: ["management", "takeProfitRsiThreshold"],
      peakRsiExitEnabled: ["management", "peakRsiExitEnabled"],
      peakRsiExitThreshold: ["management", "peakRsiExitThreshold"],
      peakRsiExitCooldownSec: ["management", "peakRsiExitCooldownSec"],
      peakRsiExitRequireOutOfRange: ["management", "peakRsiExitRequireOutOfRange"],
      peakRsiExitMinPnlPctEnabled: ["management", "peakRsiExitMinPnlPctEnabled"],
      peakRsiExitMinPnlPct: ["management", "peakRsiExitMinPnlPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pumpTrailingDropPct: ["management", "pumpTrailingDropPct"],
      pumpSafetyMultiplier: ["management", "pumpSafetyMultiplier"],
      postCloseTrackEnabled: ["management", "postCloseTrackEnabled"],
      maxPositionToTvlPct: ["management", "maxPositionToTvlPct"],
      maxSwapSlippageBps: ["management", "maxSwapSlippageBps"],
      volumeTrendEnabled: ["management", "volumeTrendEnabled"],
      volumeTrendCheckIntervalMin: ["management", "volumeTrendCheckIntervalMin"],
      volumeTrendCollapseThresholdPct: ["management", "volumeTrendCollapseThresholdPct"],
      volumeTrendMinBaselineVolume: ["management", "volumeTrendMinBaselineVolume"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      scheduleOffsetSec: ["schedule", "scheduleOffsetSec"],
      scheduleOffsetMin: ["schedule", "scheduleOffsetMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      maxDownsideModeEnabled: ["strategy", "maxDownsideModeEnabled"],
      maxDownsideModeFloorPct: ["strategy", "maxDownsideModeFloorPct"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source", ["pnlSource"]],
      pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
      // gmgn fee source
      gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
      gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorDataSource: ["indicators", "dataSource", ["chartIndicators", "dataSource"]],
      geckoRequestDelayMs: ["indicators", "geckoRequestDelayMs", ["chartIndicators", "geckoRequestDelayMs"]],
      geckoMaxRetries: ["indicators", "geckoMaxRetries", ["chartIndicators", "geckoMaxRetries"]],
      geckoResultCacheSec: ["indicators", "geckoResultCacheSec", ["chartIndicators", "geckoResultCacheSec"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals (or their offsets) changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null
      || applied.scheduleOffsetSec != null || applied.scheduleOffsetMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s, offset: ${config.schedule.scheduleOffsetMin}m${config.schedule.scheduleOffsetSec}s`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
async function swapBaseToSolWithRetry(baseMint, label) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.usd < 0.10) {
        // Nothing left to swap (already sold or dust) — treat as done.
        return { swapped: attempt > 1, result: null, token: null };
      }
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  return { swapped: false, result: null, token: null };
}

/**
 * Execute a tool call with safety checks and logging.
 *
 * `trusted` is NOT part of the LLM-facing tool schema and can only be set by
 * our own internal callers (index.js's deterministic close dispatch,
 * liquidity-guard.js, stoploss-rsi-guard.js) — agent.js's LLM tool-calling
 * loop always calls executeTool(functionName, functionArgs) with exactly two
 * positional args, so there is no way for a model's tool-call JSON to ever
 * set this. See the stopLossRsiConfirm gate below for why that separation
 * matters.
 *
 * `source` identifies WHICH internal caller this is (e.g.
 * "stoploss-rsi-guard", "liquidity-guard", "exit-rsi-guard",
 * "deterministic-rule", "peak-rsi-exit", "manual-cli") — used by the
 * cross-guard RSI-wait-lock gate below to tell "the guard that owns this
 * position's active wait is resolving it" from "an unrelated strategy is
 * trying to close it out from under that wait." Also not LLM-settable, for
 * the same reason `trusted` isn't.
 */
export async function executeTool(name, args, { trusted = false, source = null, signalType = null } = {}) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Cross-guard RSI-wait-lock ────────────
  // Whichever guard starts waiting on a position first (rsi-wait-lock.js)
  // owns it until that wait resolves — RSI-confirmed close, or its own
  // safety timeout. Every OTHER close path is blocked in the meantime,
  // regardless of trusted/untrusted: this is a trusted-vs-trusted conflict
  // (e.g. liquidity-guard.js closing a position stoploss-rsi-guard.js is
  // still waiting on), not the LLM-vs-guard case the stopLossRsiConfirm
  // check below handles — confirmed happening in production 2026-08-02.
  // "manual-cli" is exempt: an operator explicitly closing a position via
  // `node cli.js close` is a deliberate override, not a competing
  // automated strategy.
  //
  // LOCK_EXEMPT_SIGNALS are ALSO exempt, for a different reason than
  // manual-cli: every one of these is only ever returned by
  // state.js's updatePnlAndCheckExits or index.js's
  // getDeterministicCloseRule when that SPECIFIC condition's own
  // RSI-confirm flag is off (PUMPED_FAR_ABOVE_RANGE never has one at all)
  // — i.e. none of these closes ever asked to wait on anything of their
  // own. Confirmed costly in production 2026-08-12 (BOT-SOL, TRAILING_TP):
  // a confirmed +8.46%-peak trailing TP got held behind an unrelated
  // take-profit RSI-wait for 39 minutes while price crashed, and finally
  // closed at -25.16% once the OTHER guard's wait gave up on its own.
  // Blocking a decided, no-wait-of-its-own signal to protect a DIFFERENT
  // condition's wait was never the intent — the 2026-08-02 case this lock
  // was built for was two guards each with their OWN pending RSI-wait
  // racing each other, which this exemption doesn't reopen (none of these
  // signals ever register a wait of their own to race with in the first
  // place). STOP_LOSS gets the same treatment even though no incident is
  // confirmed for it yet — unlike TRAILING_TP (bounded downside: gives
  // back some profit) a blocked stop-loss has NO floor for as long as the
  // lock holds, so it's the highest-risk case to leave exposed.
  //
  // DEAD_POSITION and PEAK_RSI_EXIT added 2026-09-03 — same exemption
  // category, but these two are STANDALONE guard modules (dead-position-
  // guard.js, peak-rsi-exit.js), not part of the deterministic dispatcher
  // the rest of this set comes from, which is why they were missed the
  // first time: neither has ever depended on a lock of its own, so
  // neither should have been blockable in the first place. Confirmed
  // costly in production 2026-08-27/28: a position dead-position-guard
  // had already confirmed worth $0.00 (a rugged/failed deploy) was
  // blocked by liquidity-guard's unrelated RSI-wait 838 times across two
  // positions, one stretch lasting over 2 hours, before liquidity-guard's
  // own wait eventually gave up on its own. RSI-based confirmation is
  // meaningless on a $0 position anyway — there was never anything for
  // dead-position-guard to wait on, own lock or otherwise.
  const LOCK_EXEMPT_SIGNALS = new Set(["TRAILING_TP", "STOP_LOSS", "TAKE_PROFIT", "OUT_OF_RANGE", "LOW_YIELD", "PUMPED_FAR_ABOVE_RANGE", "FEE_STALL", "DEAD_POSITION", "PEAK_RSI_EXIT"]);
  if (name === "close_position" && source !== "manual-cli" && !LOCK_EXEMPT_SIGNALS.has(signalType)) {
    const lockHolder = getRsiWaitLockHolder(args?.position_address);
    if (lockHolder && lockHolder !== source) {
      const msg = `This position is currently waiting on ${lockHolder}'s own RSI confirmation (or its safety timeout) before closing. A different strategy (${source || "untrusted/LLM"}) cannot close it in the meantime. It will close automatically once ${lockHolder} resolves — or close manually via the CLI if you need to override this now.`;
      log("safety_block", `close_position blocked (locked by ${lockHolder}, requested by ${source || "untrusted/LLM"}): ${args?.position_address?.slice(0, 8)}`);
      return { success: false, blocked: true, reason: msg };
    }
  } else if (name === "close_position" && LOCK_EXEMPT_SIGNALS.has(signalType)) {
    const lockHolder = getRsiWaitLockHolder(args?.position_address);
    if (lockHolder && lockHolder !== source) {
      log("safety_block", `close_position: ${signalType} bypassing lock held by ${lockHolder} (own condition never required an RSI wait): ${args?.position_address?.slice(0, 8)}`);
    }
  }

  // ─── stopLossRsiConfirm guard-rail ────────
  // When RSI-confirm is on, PnL-driven closes are supposed to go through
  // stoploss-rsi-guard.js (which waits for a bounce or its own safety
  // timeout) — not close instantly. The deterministic paths (state.js,
  // index.js's getDeterministicCloseRule) already stand down for this on
  // their own. But nothing stopped an untrusted caller — chiefly the LLM,
  // during the hourly health-check agent loop or a manual chat request —
  // from independently deciding "PnL is bad, close it" and calling
  // close_position directly with its own stop-loss-flavored reasoning,
  // fully bypassing the guard. Confirmed happening in production logs
  // 2026-07-26 (position 3aQvzMQZ...): health-check LLM closed at -19.5%
  // citing "Stop loss: PnL -19.50% <= -12%" while the guard had never even
  // logged a pending wait for that position.
  //
  // This only blocks UNTRUSTED calls (trusted=false, i.e. the LLM) whose
  // reason text is itself stop-loss/negative-PnL-flavored. It does not
  // touch: take-profit-flavored or other-reasoned LLM closes (those aren't
  // what RSI-confirm is meant to gate), or any trusted internal caller —
  // including stoploss-rsi-guard.js's own closes, which are the intended
  // way a PnL-driven close happens while this is on.
  if (name === "close_position" && !trusted && config.management.stopLossEnabled !== false && config.management.stopLossRsiConfirm) {
    const reasonText = String(args?.reason || "");
    const looksLikeStopLoss = /stop[\s-]?loss/i.test(reasonText) || /pnl[^\d]{0,40}-\d/i.test(reasonText);
    if (looksLikeStopLoss) {
      const msg = `stopLossRsiConfirm is on — PnL/stop-loss-driven closes must go through stoploss-rsi-guard.js, not a direct close_position call. If this position needs to close for a different reason (OOR, low yield, liquidity), rephrase without stop-loss/negative-PnL language. Otherwise wait for the guard, or ask to disable stopLossRsiConfirm first.`;
      log("safety_block", `close_position blocked (untrusted stop-loss/PnL reason while stopLossRsiConfirm is on): ${args?.position_address?.slice(0, 8)} — "${reasonText.slice(0, 140)}"`);
      return { success: false, blocked: true, reason: msg };
    }
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        if (!args.skip_swap && result.base_mint) {
          const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after close");
          if (swapped) {
            // Tell the model the swap already happened so it doesn't call swap_token again
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) {
        // Cooldown this pool so it doesn't keep resurfacing as "the top
        // candidate" every screening cycle right after failing a live
        // re-verification. Reuses the exact mechanism already used for
        // actual on-chain deploy failures (tools/dlmm.js's deployPosition
        // catch blocks) — this just extends it to the PRE-flight gate,
        // which never triggered it before. pool_address is already the
        // canonical Meteora pool address used consistently everywhere
        // else in this codebase (screening.js's isPoolOnCooldown(p.pool)
        // check, and dlmm.js's own recordDeployFailure calls) — no
        // separate resolution needed, unlike ruwethood's EVM v4 pipeline
        // where args.pool_address can be a token address rather than the
        // canonical poolId.
        //
        // Scoped to validateDeployPoolThresholds ONLY — deliberately NOT
        // wrapping the checks further below in this function (args shape,
        // max positions, duplicate-pool/duplicate-token guards, wallet
        // balance). Those aren't signals about the POOL's quality — a
        // "max positions reached" or "insufficient balance" rejection
        // says nothing bad about this specific pool, and cooling it down
        // would suppress a perfectly good candidate for an unrelated
        // reason. Only the checks that just freshly re-verified the
        // pool's own live condition (TVL, fee/TVL, volatility, bin_step,
        // position-size-to-TVL) belong here.
        recordDeployFailure(args.pool_address, { pool_name: args.pool_name, base_mint: args.base_mint, error: poolThresholds.reason, hours: 2 });
        return poolThresholds;
      }
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
