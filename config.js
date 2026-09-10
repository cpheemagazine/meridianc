import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;
// Meteora DLMM's own protocol-level ceiling — "Max position length is 1400"
// per @meteora-ag/dlmm's own SDK comments (node_modules/@meteora-ag/dlmm/
// dist/index.d.ts, near increasePositionLength/MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX).
// Verified against the actual installed package, not assumed — a position
// spanning this many bins needs the multi-transaction "Wide Range Path"
// tools/dlmm.js's deployPosition already has (createExtendedEmptyPosition +
// addLiquidityByStrategyChunkable), which is why maxDownsideModeEnabled
// (below) can safely request all of it in one deploy.
export const MAX_DOWNSIDE_BINS_BELOW = 1400;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

// Layered lookup for GMGN discovery settings: gmgn-config.json > legacy
// gmgn-prefixed key in user-config.json > fallback default. Ported from meridian15.
function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    // meteora | gmgn | both — which discovery source(s) getTopCandidates uses.
    source: nonEmptyString(u.screeningSource, "meteora").toLowerCase(),
    // Hard gate: when on, a candidate whose RSI(entryRsiGateLength) is NOT
    // below entryRsiThreshold gets rejected during screening — never even
    // reaches the LLM's deploy decision. Distinct from
    // config.indicators.enabled/entryPreset (the Supertrend-break-style
    // confirmation system) — this is a separate, independently-toggleable
    // check, not a mode of that one; you can run this with the indicator
    // system off, or vice versa. The goal here is narrow and specific:
    // don't open a new position into an already-overbought local top.
    // Fails OPEN (doesn't block the candidate) on a fetch failure, same
    // convention tools/screening.js's existing indicator-confirmation
    // catch block already uses — an RSI outage shouldn't silently halt
    // every deploy.
    entryRsiGateEnabled: u.entryRsiGateEnabled ?? false,
    entryRsiThreshold: u.entryRsiThreshold ?? 70,
    // Writes a full candidate-list snapshot (candidate-snapshots.js) and a
    // per-token pool-discovery log (pool-discovery-log.js) on every REAL
    // screening cycle (index.js's runScreeningCycle) — not on the
    // pools/candidates/census CLI previews, which don't write anything.
    // See candidate-snapshots.js's header comment for why this exists.
    candidateSnapshotEnabled: u.candidateSnapshotEnabled ?? true,
    candidateSnapshotRetentionDays: u.candidateSnapshotRetentionDays ?? 14,
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    // DATA-CAPTURE / DRY-RUN ONLY — every hard-reject screening filter
    // (TVL/volume/mcap/holders/fee/bin-step/honeypot/cooldowns, indicator
    // confirmation, entry RSI gate, GMGN's security checks) still
    // EVALUATES and LOGS what it would have rejected, but no longer
    // actually drops the candidate — so you can see the full, unfiltered
    // candidate universe and its data for analysis, without any of it
    // actually being eligible to deploy real capital.
    //
    // Deliberately NOT a standalone switch: this flag alone does nothing.
    // It only takes effect when process.env.DRY_RUN is ALSO "true" — see
    // isDryRunFilterBypassActive() below. That coupling is enforced in
    // code, not just by convention/naming, specifically so this can never
    // be live on a real, capital-deploying run even by a config mistake —
    // setting this true with DRY_RUN unset or false is a silent no-op by
    // design, not a footgun.
    dryRunBypassFilters: u.dryRunBypassFilters ?? false,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    // Whether the management cycle can trigger an extra screening cycle
    // reactively — zero open positions, or room for more after a cycle
    // finishes (see index.js's two runScreeningCycle call sites right
    // after this flag's check for the exact conditions). Off means
    // screening only ever runs on its own fixed schedule
    // (schedule.screeningIntervalMin). Does NOT gate the opportunity poll
    // (config.opportunity.enabled is that one's own on/off switch), the
    // one-time screening call at process startup, or manual triggers
    // (`node cli.js screen`, a chat/Telegram request) — none of those are
    // the kind of automatic reactive triggering this flag is about.
    //
    // Renamed from an earlier screeningOnScheduleOnly (inverse polarity,
    // config.screening) to match this codebase's current naming — the
    // fallback below means an existing screeningOnScheduleOnly in
    // user-config.json still works exactly as before, just no longer the
    // key to reach for going forward.
    triggerScreeningWhenIdle: u.triggerScreeningWhenIdle ?? (u.screeningOnScheduleOnly != null ? !u.screeningOnScheduleOnly : true),
    // Master switch for the stop-loss rule. true (default) = normal
    // behavior (stopLossPct applies as documented below). false = the
    // STOP_LOSS branch in state.js's updatePnlAndCheckExits and rule 1 in
    // index.js's getDeterministicCloseRule never fire, regardless of PnL —
    // positions can still exit via take-profit, OOR, low-yield, or manual
    // close, just never via this rule. Note: setting stopLossPct to null
    // does NOT achieve this — `u.stopLossPct ?? -50` treats null as
    // nullish and falls back to the -50 default, same as leaving it unset.
    // This flag is the actual off switch.
    //
    // Real tradeoff, not just a knob: stop-loss is the only thing that
    // closes a position whose price is genuinely collapsing. Turning it
    // off removes that net entirely, not just false-positive cases — if a
    // position's price really does crash, nothing here will close it until
    // take-profit/OOR/low-yield happens to trigger, if ever.
    stopLossEnabled:       u.stopLossEnabled       ?? true,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    // Instead of closing the instant PnL crosses stopLossPct, waits for an
    // RSI(stopLossRsiLength)@stopLossRsiInterval reading >= stopLossRsiThreshold
    // (a local bounce) before actually closing — trying for a better exit
    // price than selling at the exact moment the threshold is crossed. NOT
    // a way to hold a loss longer: stopLossRsiMaxWaitMinutes is a hard
    // safety timeout — past that, it closes anyway regardless of RSI. See
    // stoploss-rsi-guard.js for the full mechanism. Off by default.
    stopLossRsiConfirm:       u.stopLossRsiConfirm       ?? false,
    stopLossRsiThreshold:     u.stopLossRsiThreshold     ?? 85,
    stopLossRsiInterval:      u.stopLossRsiInterval      ?? "15_MINUTE",
    stopLossRsiLength:        u.stopLossRsiLength        ?? 2,
    stopLossRsiMaxWaitMinutes: u.stopLossRsiMaxWaitMinutes ?? 30,
    stopLossRsiRecheckSec:    u.stopLossRsiRecheckSec    ?? 60,
    stopLossRsiGuardIntervalMin: u.stopLossRsiGuardIntervalMin ?? 1,
    // While still in range, the position is earning fees against the
    // loss, so an RSI bounce alone isn't reason enough to sell — only
    // close early if it's ALSO out of range (no longer earning). If still
    // in range when RSI confirms, stoploss-rsi-guard.js keeps waiting
    // rather than closing — right up until stopLossRsiMaxWaitMinutes, at
    // which point the safety timeout closes it regardless of range or RSI,
    // same as always. This only affects the early-exit path, never the
    // timeout backstop. Default true — set false to close on RSI alone,
    // regardless of range status (the original behavior).
    stopLossRsiRequireOutOfRange: u.stopLossRsiRequireOutOfRange ?? true,
    // BUG FIXED 2026-08-16 (see stoploss-rsi-guard.js's header comment for
    // the full incident): the safety-timeout clock used to reset every
    // time PnL ticked back above the stop-loss line, even briefly — a
    // position oscillating around the threshold could indefinitely
    // postpone the "NOT optional" stopLossRsiMaxWaitMinutes backstop. Now
    // the clock only resets once PnL has stayed OUT of stop-loss territory
    // continuously for this many minutes — a brief bounce above the line
    // no longer counts as "recovered," so the guaranteed timeout is
    // actually guaranteed. Default 120 (2h) — long enough to be confident
    // it's a genuine recovery, not noise.
    stopLossRsiResetAfterMinutes: u.stopLossRsiResetAfterMinutes ?? 120,

    // Same idea as stopLossRsiConfirm above — wait for an RSI reading
    // before actually closing — but for three different triggers, and for
    // a different reason: these three aren't damage control on a falling
    // price, they're "we've decided to exit for an unrelated reason
    // (trailing TP hit, out of range too long, yield too low), so wait for
    // a local overbought reading to get a better fill instead of closing
    // into whatever the price happens to be at that instant." Each is
    // independently toggleable — off by default, same as stopLossRsiConfirm.
    // See exit-rsi-guard.js for the mechanism (same safety-timeout
    // guarantee as the stop-loss version: never waits forever).
    trailingTpRsiConfirm: u.trailingTpRsiConfirm ?? false,
    oorRsiConfirm: u.oorRsiConfirm ?? false,
    lowYieldRsiConfirm: u.lowYieldRsiConfirm ?? false,
    // Same idea, for liquidity-guard.js's TVL/volume-collapse close — shares
    // exitRsiThreshold/exitRsiMaxWaitMinutes/exitRsiRecheckSec with
    // trailingTpRsiConfirm/oorRsiConfirm/lowYieldRsiConfirm above rather than
    // getting its own dedicated threshold (unlike takeProfitRsiThreshold) —
    // "just like lowYieldRsiConfirm" was the ask, not a new number. Handled
    // inside liquidity-guard.js itself, not exit-rsi-guard.js — that module's
    // TVL/volume collapse detection has its own confirm-tick state machine
    // (registerExitSignal) that only liquidity-guard.js should ever drive;
    // re-deriving "is liquidity collapsing" a second time from a different
    // module would double-count samples against that state machine.
    liquidityRsiConfirm: u.liquidityRsiConfirm ?? false,
    // Deliberately separate from stopLossRsiThreshold (85) — waiting for a
    // bounce out of a loss vs. waiting for a peak on an otherwise-fine exit
    // are different situations and there's no reason they'd want the same
    // number. 70 = user-requested default.
    exitRsiThreshold: u.exitRsiThreshold ?? 70,
    exitRsiMaxWaitMinutes: u.exitRsiMaxWaitMinutes ?? 30,
    exitRsiRecheckSec: u.exitRsiRecheckSec ?? 60,
    exitRsiGuardIntervalMin: u.exitRsiGuardIntervalMin ?? 1,
    // Same idea again, for the one exit rule the other three didn't cover:
    // the FIXED take-profit threshold (pnl_pct >= takeProfitPct — rule 2 in
    // index.js's getDeterministicCloseRule; unlike trailing TP/OOR/low
    // yield, this one has no home in state.js at all, it only lives there).
    // Own dedicated threshold rather than reusing exitRsiThreshold — no
    // reason "good enough to lock in profit" and "good enough to accept an
    // otherwise-fine exit" need to share a number.
    takeProfitRsiConfirm: u.takeProfitRsiConfirm ?? false,
    takeProfitRsiThreshold: u.takeProfitRsiThreshold ?? 70,

    // Different mechanism from everything above — those wait for RSI to
    // confirm a close that's already been decided for some other reason.
    // This one's the reverse: fires the moment a NEW peak PnL is confirmed
    // (state.js's confirmPeak) if RSI(2) is already deep in overbought
    // territory right then — selling into strength at a fresh high,
    // instead of waiting for a pullback to prove the top has formed (that
    // waiting approach is what trailingDropPct/trailingTpRsiConfirm do —
    // this is a complementary strategy, not a replacement). See
    // peak-rsi-exit.js.
    peakRsiExitEnabled: u.peakRsiExitEnabled ?? false,
    peakRsiExitThreshold: u.peakRsiExitThreshold ?? 85,
    // Minimum gap between RSI fetches for the SAME position — a fast,
    // choppy uptrend can confirm a new peak every few seconds via the 3s
    // poller, and without this a strong rally would hammer the RSI API
    // once per confirmed peak instead of just checking periodically.
    peakRsiExitCooldownSec: u.peakRsiExitCooldownSec ?? 30,
    // While a position is still in range, it's earning fees — no reason to
    // exit early just because RSI happens to spike at a fresh peak. Once
    // it's out of range (no longer earning), the "sell into strength"
    // logic gets to act on the next RSI-overbought peak it sees. Default
    // true (the requested behavior) — set false to restore checking
    // regardless of range status.
    peakRsiExitRequireOutOfRange: u.peakRsiExitRequireOutOfRange ?? true,
    // Production data (2026-08-11 log analysis, meridiancx): RSI(2) on a
    // 15min candle regularly hits >=90 on the very first green candle of
    // any move — 6 of 8 peak-RSI-exit closes in that sample fired with a
    // peak PnL under 1% (0.01%–0.91%), and post-close shadow tracking
    // showed most of those continuing 50-680% higher shortly after. The
    // RSI condition alone isn't distinguishing a real exhausted top from
    // routine early-move noise. This adds a floor: a "new peak" only
    // counts as exit-worthy once it's cleared peakRsiExitMinPnlPct, same
    // as before that. Independently toggleable — set
    // peakRsiExitMinPnlPctEnabled false to go back to firing on RSI alone
    // regardless of peak size (the original behavior).
    peakRsiExitMinPnlPctEnabled: u.peakRsiExitMinPnlPctEnabled ?? true,
    peakRsiExitMinPnlPct: u.peakRsiExitMinPnlPct ?? 3,

    // Safety backstop, not a trading strategy choice — defaults ON (every
    // other *Confirm/*Enabled flag in this section defaults off since
    // those are genuine strategy preferences; this one is closer to the
    // deposits-missing cost-basis-fallback fix in tools/pnl.js, which also
    // wasn't made optional). Confirmed necessary in production 2026-08: a
    // position stuck in pnl_pct_suspicious (Meteora never indexed its
    // deposit — see tools/pnl.js's cost-basis fallback, which is supposed
    // to cover this but evidently didn't apply here) sat with stop-loss/
    // trailing-TP fully disabled for ~27 hours, effectively worthless
    // ($0 on-chain value) the whole time, until an hourly health-check LLM
    // call happened to notice and manually close it. This force-closes a
    // position that's been suspicious for too long AND reads as
    // effectively worthless on-chain — see dead-position-guard.js.
    deadPositionGuardEnabled: u.deadPositionGuardEnabled ?? true,
    deadPositionMaxSuspiciousMinutes: u.deadPositionMaxSuspiciousMinutes ?? 60,
    deadPositionMaxValueUsd: u.deadPositionMaxValueUsd ?? 1.0,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    // Different signal than the fee_per_tvl_24h check above: that one is a
    // 24h AVERAGE, so a position that earned well 12h ago and has been
    // dead for the last 6h can still read as "yield OK". This tracks time
    // since fees last actually increased (claimed + unclaimed combined),
    // regardless of how well it did earlier — see fee-stall-guard.js.
    // Off by default (an opt-in strategy choice, not a safety backstop).
    feeStallGuardEnabled: u.feeStallGuardEnabled ?? false,
    feeStallThresholdHours: u.feeStallThresholdHours ?? 6,
    feeStallMinAgeMinutes: u.feeStallMinAgeMinutes ?? 60,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // Wider trailing-drop used once a position has pumped far above its deployed
    // range (see state.js updatePnlAndCheckExits) -- the normal trailingDropPct is
    // tuned for range-bound LP noise and was found (via post-close tracking) to
    // cut real continuation pumps off almost instantly. Defaults to a flat 8% if
    // not set; not derived from trailingDropPct since the two protect against very
    // different things (noise vs. a genuine post-pump reversal).
    pumpTrailingDropPct:   u.pumpTrailingDropPct   ?? 8,
    // Rule 3 extreme-safety-valve multiplier: fires at outOfRangeBinsToClose *
    // this multiplier bins past range, as a last-resort circuit breaker only.
    pumpSafetyMultiplier:  u.pumpSafetyMultiplier  ?? 4,
    postCloseTrackEnabled: u.postCloseTrackEnabled ?? true, // shadow-track price for 30/60min after each close
    // Refuse deploy if position value would exceed this % of the pool's live TVL.
    // A pool can clear the flat minTvl floor while still being thin enough that a
    // fast dump traps a wide single-sided range deep underwater. Set to null/0 to disable.
    maxPositionToTvlPct:   u.maxPositionToTvlPct   ?? 3,
    // Max acceptable slippage (bps) on the auto-swap-back-to-SOL step (after close/claim).
    // Previously unset entirely -- Jupiter's Ultra "auto slippage" has no caller-side floor
    // on acceptable output. 500 = 5%. If the swap can't execute within this bound it fails
    // (and gets retried); the base token is left unsold rather than dumped at an arbitrary price.
    maxSwapSlippageBps:    u.maxSwapSlippageBps    ?? 500,
    // Real-time TVL/volume collapse guard (liquidity-guard.js) — reuses the
    // pre-existing volumeTrend* keys, previously defined but never wired to
    // anything. Set volumeTrendEnabled: false to disable.
    volumeTrendEnabled:              u.volumeTrendEnabled              ?? true,
    volumeTrendCheckIntervalMin:     u.volumeTrendCheckIntervalMin     ?? 7,
    volumeTrendCollapseThresholdPct: u.volumeTrendCollapseThresholdPct ?? -60,
    volumeTrendMinBaselineVolume:    u.volumeTrendMinBaselineVolume    ?? 1000,
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    // Alternative deploy sizing flow, sitting alongside the volatility-
    // interpolated minBinsBelow/maxBinsBelow system above, not replacing
    // it — toggle either way at will. When on, EVERY deploy ignores
    // whatever bins_below/downside_pct/bins_above the caller passed and
    // instead uses the maximum the DLMM protocol allows for downside
    // (MAX_DOWNSIDE_BINS_BELOW, see its own comment for where that number
    // comes from) with bins_above forced to 0 — pure single-sided
    // downside coverage, no upside range at all. Enforced in
    // tools/dlmm.js's deployPosition itself (not just prompt guidance to
    // the LLM), so it's guaranteed regardless of what gets passed in.
    maxDownsideModeEnabled: u.maxDownsideModeEnabled ?? false,
    // Additional safety ceiling on top of maxDownsideModeEnabled's
    // existing-bin-array cap (tools/dlmm.js's capBinsBelowToExistingBinArrays)
    // — the range never extends below this % drop from the current active-
    // bin price (the "top" of the range, since bins_above is forced to 0
    // in this mode), even if the pool happens to have existing bin arrays
    // reaching further than that. Whichever cap is MORE conservative wins.
    // 99.9 means the position's lowest bin sits at 0.1% of the current
    // price — already an extreme move; there's no real benefit to
    // extending further just because the bin arrays happen to exist.
    maxDownsideModeFloorPct: u.maxDownsideModeFloorPct ?? 99.9,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
    // Shifts this instance's cron trigger point within the minute (0-59s).
    // node-cron expressions are wall-clock-anchored regardless of process start
    // time, so multiple instances all land on the same :00/:15/:30/:45 etc.
    // Give each instance a different offset to stagger them (e.g. 0 and 30).
    scheduleOffsetSec:      u.scheduleOffsetSec      ?? 0,
    // Shifts which MINUTE this instance triggers on (0-59) -- e.g. offsetMin=2
    // with a 3-minute interval fires at :02, :05, :08... instead of :00, :03,
    // :06... Use this (not just scheduleOffsetSec) if you want two instances
    // to never even land in the same minute, not just the same minute at
    // different seconds.
    scheduleOffsetMin:      u.scheduleOffsetMin      ?? 0,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── GMGN (fee source for minTokenFeesSol gate) ──────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    requestDelayMs: Number(gmgnUserConfig.requestDelayMs ?? u.gmgnRequestDelayMs ?? 2500),
    maxRetries: Number(gmgnUserConfig.maxRetries ?? u.gmgnMaxRetries ?? 2),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),

    // ─── Pool-discovery pipeline (screeningSource: gmgn / both) ───────────
    // Ported from meridian15. Stage 1: rank filter.
    interval: gmgnValue("interval", "gmgnInterval", "5m"),
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minFeeActiveTvlRatio: gmgnValue("minFeeActiveTvlRatio", "gmgnMinFeeActiveTvlRatio", u.minFeeActiveTvlRatio ?? 0.05),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),

    // Stage 2/3: token-info + security + holders/traders analysis.
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    // "creator still holding" (analyzeSecurity in tools/gmgn.js) was
    // previously unconditional — no threshold, just an instant reject
    // whenever GMGN reports creator_token_status === "creator_hold". Off
    // by default (false = current behavior, still rejects) — set true to
    // stop treating this as disqualifying on its own. Note this is
    // independent of the other creator/holder-concentration checks above
    // (top10, rug ratio, bundler, insider, sniper) — turning this off
    // doesn't touch those; a token still has to clear all of them.
    allowCreatorHold: gmgnValue("allowCreatorHold", "gmgnAllowCreatorHold", false),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),

    // Stage 4: Meridian chart-indicator "bounce setup" confirmation.
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
    indicatorInterval: gmgnValue("indicatorInterval", "gmgnIndicatorInterval", "15_MINUTE"),
    indicatorRules: (() => {
      const r = gmgnUserConfig.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  logging: {
    // The "suspicious tick" [PNL_WARN] line (tools/pnl.js) fires on every
    // poll for a position that can't currently be priced/cost-based (e.g.
    // Meteora hasn't indexed a fresh deploy's deposit yet, or a Jupiter
    // outage) — genuinely useful while actively debugging one, but at the
    // ~3s fast-poll cadence it can produce thousands of near-identical
    // lines a day for a position stuck in that state for a while. Off by
    // default. Turning this off does NOT change any actual behavior —
    // pnl_pct_suspicious still gates stop-loss/trailing-TP/etc exactly the
    // same either way, this only silences the log line about it.
    suspiciousTickLogEnabled: u.suspiciousTickLogEnabled ?? false,
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    // "meridian" (default) — pre-computed RSI/Bollinger/Supertrend/Fibonacci
    // from the proprietary agent-meridian backend (api.agentmeridian.xyz).
    // "gecko" — same indicators, computed locally (tools/indicators-local.js)
    // from real OHLCV candles pulled from GeckoTerminal's free public API
    // (tools/gecko.js) instead of trusting a third party's precomputed
    // values. Both sides return the identical shape to every caller
    // (tools/screening.js's confirmIndicatorPreset, stoploss-rsi-guard.js) —
    // switching this does not require touching either of them.
    dataSource: indicatorUserConfig.dataSource === "gecko" ? "gecko" : "meridian",
    // GeckoTerminal's free public tier rate-limits aggressively — these pace
    // and retry requests the same way config.gmgn.requestDelayMs/maxRetries
    // already do for GMGN. Only relevant when dataSource is "gecko".
    geckoRequestDelayMs: indicatorUserConfig.geckoRequestDelayMs ?? 2500,
    geckoMaxRetries: indicatorUserConfig.geckoMaxRetries ?? 3,
    // How long a computed indicator result is reused for the same
    // (mint, interval, rsiLength) before fetching fresh candles again.
    // Cuts duplicate GeckoTerminal calls when the same token is checked
    // repeatedly in a short window — see indicators-local.js's comment.
    geckoResultCacheSec: indicatorUserConfig.geckoResultCacheSec ?? 60,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}

/**
 * The ONLY correct way to check whether hard-reject screening filters
 * should be bypassed for data-capture purposes — see
 * config.screening.dryRunBypassFilters's comment for why this requires
 * BOTH the config flag AND process.env.DRY_RUN==="true". Never read
 * config.screening.dryRunBypassFilters directly for this decision.
 */
export function isDryRunFilterBypassActive() {
  return config.screening.dryRunBypassFilters === true && process.env.DRY_RUN === "true";
}
