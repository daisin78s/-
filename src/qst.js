(function () {
/**
 * QST (Quest) cards: a small side-objective system layered on top of the existing engine.
 * Deliberately data-driven -- no QST-card-specific branching anywhere here.
 *
 * **Rank-based rewards (2026-08-09, replacing the original claim-based design -- see below for what
 * changed and why):** GOAL is now a bare metric expression (e.g. "CARD_COUNT" or "LEVEL_COUNT(A,2)"),
 * evaluated as a NUMBER for every player rather than a yes/no condition. At GAME_END (and, for live
 * display purposes, at any point during the game -- see rankPlayersForQuest), players are ranked by
 * that number using competition ranking ("1224": ties share a rank, and the rank right after a tie is
 * skipped by the tie's size -- e.g. build counts 8/8/7/7 -> ranks 1/1/3/3, nobody is "2nd"). Whoever
 * lands in rank 1/2/3 receives REWARD1/REWARD2/REWARD3 respectively (a plain DSL program, same
 * ADD/CHANGE/BUILD pipeline as any other effect); rank 4+ (only possible in a game with 4+ distinct
 * values) gets nothing. Rewards are granted automatically, exactly once, when the game actually ends
 * -- see resolveEndGameRewards, called from turn-flow.js's endRound.
 *
 * **What this replaced (2026-07-30 original design, per user feedback 2026-08-09: "QSTカードの仕様を
 * 変更します GOALはすべてゲーム終了後に[付与]" + confirming the old claim mechanic should be fully
 * removed, not kept alongside):** GOAL used to be a boolean IF-style condition (e.g. "CARD_COUNT>=7"),
 * and REWARD1/REWARD2-3 were claimed manually, one at a time, by whichever player reached the GOAL
 * first/second/third -- a "free action" claim button, capped at 2 claims per player for the whole
 * game (PlayerState.qstRewardCount, now removed). That whole claim/eligibility layer (canClaim,
 * claimQuestReward, completeQuestClaim, commitClaim, nextRewardField, REWARD_FIELDS,
 * MAX_QST_REWARDS_PER_PLAYER) is gone -- there is no player-facing QST action left at all; a QST card
 * is now pure information (a live-updating ranking preview) until GAME_END settles it automatically.
 * QuestState (GameState.quests[faceId]) shrank accordingly: it used to track claimCount/claimedPlayers
 * per card; now it's just a revealed-marker (see setupQuests) since ranking is always computed fresh
 * from current game state, never accumulated.
 *
 *  - QST has 4 physical cards (Q001-Q004), each with an A and B face, like CON/A/B/C. Setup reveals
 *    3 of the 4 physical cards, picking one face (A or B) at random for each -- so the two faces of
 *    the same physical card can never both be revealed in the same game (only one face is ever
 *    chosen per physical id). Fixed for the whole game; no restock.
 */

'use strict';

const { getQstRow } = require('./data-loader');
const { parseArgList } = require('./dsl-parser');
const { lowerMetric } = require('./command-builder');
const { shuffle, next } = require('./rng');
// Named executorApi, not executor (see turn-flow.js's matching comment) -- purely to disambiguate
// from board.js's own `const executor` at a glance; module.exports is unaffected.
const executorApi = require('./executor');

const QST_PHYSICAL_IDS = ['Q001', 'Q002', 'Q003', 'Q004'];
const REWARD_FIELDS = ['REWARD1', 'REWARD2', 'REWARD3'];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Reveals 3 of the 4 QST cards, one random face each. See the file-level comment for why this
 * structurally rules out both faces of one physical card appearing together. Each revealed face maps
 * to `true` -- there's no other per-card state to track anymore (see file-level comment).
 */
function setupQuests(state) {
  const chosen = shuffle(state.rng, QST_PHYSICAL_IDS).slice(0, 3);
  state.quests = {};
  for (const physicalId of chosen) {
    const tier = next(state.rng) < 0.5 ? 'A' : 'B';
    state.quests[`${physicalId}${tier}`] = true;
  }
}

// ---------------------------------------------------------------------------
// GOAL
// ---------------------------------------------------------------------------

/**
 * Evaluates GOAL text (a single bare metric expression, e.g. "CARD_COUNT" or "LEVEL_COUNT(A,2)" --
 * same grammar as a COST list, reused via parseArgList/lowerMetric) as a number for playerId. Empty/
 * missing GOAL evaluates to 0 for everyone (so a QST card with no GOAL data yet just ties everyone at
 * rank 1, rather than crashing -- keeps this safe to call from the live-preview UI at any time).
 */
function evalGoalMetric(state, index, playerId, goalText) {
  if (!goalText) return 0;
  const [metricNode] = parseArgList(goalText);
  const metric = lowerMetric(metricNode);
  return executorApi.evalMetric(state, index, playerId, metric);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** The rank a player gets when they have no claim on any reward at all. One past the last REWARD field,
 * so resolveEndGameRewards' own `rank > REWARD_FIELDS.length` check skips them and main.js's 1位/2位/3位
 * columns simply don't list them. With 3 REWARD fields this is "4位", matching how the user stated the
 * rule ("QSTカードの目標が０の時は４位になる"). */
const NO_REWARD_RANK = REWARD_FIELDS.length + 1;

/**
 * Ranks every player by questFaceId's GOAL metric (highest value first), competition-style: rank =
 * 1 + (how many players scored strictly higher). Pure/read-only -- safe to call at any point during
 * the game for a live standings preview (see main.js's QST card UI), not just at GAME_END.
 *
 * A GOAL value of 0 is always NO_REWARD_RANK, never 1st/2nd/3rd (2026-08-11, per user rule: "QSTカードの
 * 目標が０の時は４位になる（２人プレイなどでも）" -- e.g. on an 所有AREA数 quest, a player owning no AREA
 * places 4th even in a 2-player game where competition ranking alone would have handed them 1st or 2nd).
 * Without this, every quest would pay out its full 1位/2位/3位 rewards at game start, when nobody has
 * achieved anything yet and all four players are tied on 0 -- the whole point of also re-basing Q001B's
 * metric to start at 0 (see executor.js's EXTRA_D_PLUS_ABC_COUNT). Note this is deliberately NOT the same
 * as "exclude zeros and rank the rest": players with a positive value keep the rank their own value earns
 * them, since a zero was never above them anyway.
 *
 * @returns {{playerId:string, value:number, rank:number}[]} one entry per player, sorted by value
 *   descending, so equal-rank entries sit together.
 */
function rankPlayersForQuest(state, index, questFaceId) {
  const row = getQstRow(index, questFaceId);
  const scored = state.players.map((p) => ({ playerId: p.id, value: evalGoalMetric(state, index, p.id, row.GOAL) }));
  scored.sort((a, b) => b.value - a.value);
  return scored.map((entry) => ({
    ...entry,
    rank: entry.value === 0
      ? NO_REWARD_RANK
      : 1 + scored.filter((other) => other.value > entry.value).length,
  }));
}

// ---------------------------------------------------------------------------
// End-of-game reward resolution
// ---------------------------------------------------------------------------

/**
 * Grants REWARD1/REWARD2/REWARD3 to whoever ranks 1st/2nd/3rd (see rankPlayersForQuest) on each
 * currently-revealed QST card, running each reward's DSL through the normal executor pipeline exactly
 * once. Called from turn-flow.js's endRound right when state.phase becomes 'GAME_END' -- nothing
 * after that point can trigger another round-4 endRound, so this is safe to run unconditionally with
 * no idempotency guard (see that call site's own comment). Ties share the same reward (e.g. two
 * players tied for rank 1 both get REWARD1 in full, not split); rank 4+ (only reachable with 4+
 * distinct values among the 4 players) gets nothing, since only 3 REWARD fields exist. A reward whose
 * DSL needs a further choice (e.g. BUILD(...)) is deliberately out of scope for this data set (see
 * [[project-dice-wp-qst-spec]]'s own history) -- runProgram runs each reward to completion with no
 * pending-choice handling, matching every other REWARD row actually in play today (plain ADD(nVP)).
 * @returns {Object<string, number>} playerId -> total VP actually gained from QST rewards this call
 *   (every REWARD cell today is a plain ADD(nVP), but this reads the real before/after
 *   player.resources.VP delta rather than assuming that shape, so it stays correct even if a future
 *   reward grants VP alongside something else). 2026-08-09, per user request for AI.DATA.xlsx's new
 *   "QST平均得点" columns (see tools/ai_data_report.js) -- turn-flow.js's endRound stashes this return
 *   value on state.qstRewardsGranted for game-runner.js to read back after the game ends.
 */
function resolveEndGameRewards(state, index) {
  const vpGranted = {};
  for (const player of state.players) vpGranted[player.id] = 0;
  for (const questFaceId of Object.keys(state.quests)) {
    const row = getQstRow(index, questFaceId);
    for (const entry of rankPlayersForQuest(state, index, questFaceId)) {
      if (entry.rank > REWARD_FIELDS.length) continue;
      const rewardText = row[REWARD_FIELDS[entry.rank - 1]];
      if (!rewardText) continue;
      const player = state.players.find((p) => p.id === entry.playerId);
      const vpBefore = player.resources.VP || 0;
      executorApi.runProgram(state, index, { playerId: entry.playerId, sourcePhysicalId: questFaceId }, rewardText);
      vpGranted[entry.playerId] += (player.resources.VP || 0) - vpBefore;
    }
  }
  return vpGranted;
}

module.exports = {
  QST_PHYSICAL_IDS,
  REWARD_FIELDS,
  NO_REWARD_RANK,
  setupQuests,
  evalGoalMetric,
  rankPlayersForQuest,
  resolveEndGameRewards,
};

})();
