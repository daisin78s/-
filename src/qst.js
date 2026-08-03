(function () {
/**
 * QST (Quest) cards: a small side-objective system layered on top of the existing engine, per the
 * user's spec (2026-07-30). Deliberately data-driven -- no QST-card-specific branching anywhere
 * here. GOAL is evaluated by the same IF-condition pipeline PASSIVE effects already use
 * (evalCondition/evalMetric), and REWARD1-3 are plain DSL programs run through the normal
 * executor/board pipeline (ADD/CHANGE/BUILD/... all "just work", including BUILD's two-phase
 * candidate-selection when a reward needs it). Adding or changing a QST card is purely an
 * data/game.xlsx edit; nothing here needs to change for that.
 *
 * Confirmed design decisions (see chat, 2026-07-30):
 *  - QST has 4 physical cards (Q001-Q004), each with an A and B face, like CON/A/B/C. Setup reveals
 *    3 of the 4 physical cards, picking one face (A or B) at random for each -- so the two faces of
 *    the same physical card can never both be revealed in the same game (only one face is ever
 *    chosen per physical id). Fixed for the whole game; no restock when a card COMPLETEs.
 *  - GOAL is a single bare comparison in the *existing* IF-condition grammar (e.g. "CARD_COUNT(M)>=1"),
 *    not a new mini-language -- reuses dsl-parser's parseArgList + command-builder's lowerCondition +
 *    executor's evalCondition/evalMetric exactly as PASSIVE's IF(...) does internally.
 *  - Claiming a reward is a "free action" only in the sense of "usable anytime during your own turn,
 *    no dice/turn cost" -- it does NOT use the TAP/UNTAP-per-round free-action mechanism
 *    (PlayerState.freeActionTaps), because a claim is permanent (claimedPlayers) and each player can
 *    only ever claim once per card, so no round-reset is meaningful here.
 *  - Reward order: 1st claimer on a card gets REWARD1, 2nd gets REWARD2, 3rd gets REWARD3, 4th+ gets
 *    nothing (claimCount already 3 = COMPLETE, canClaim() rejects further claims). Each player is
 *    also capped at 2 QST rewards total across the whole game (PlayerState.qstRewardCount).
 */

'use strict';

const { getQstRow } = require('./data-loader');
const { parseArgList } = require('./dsl-parser');
const { lowerCondition } = require('./command-builder');
const { shuffle, next } = require('./rng');
// Named executorApi, not executor (see turn-flow.js's matching comment) -- purely to disambiguate
// from board.js's own `const executor` at a glance; module.exports is unaffected.
const executorApi = require('./executor');
const board = require('./board');

const QST_PHYSICAL_IDS = ['Q001', 'Q002', 'Q003', 'Q004'];
const REWARD_FIELDS = ['REWARD1', 'REWARD2', 'REWARD3'];
const MAX_QST_REWARDS_PER_PLAYER = 2;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Reveals 3 of the 4 QST cards, one random face each. See the file-level comment for why this
 * structurally rules out both faces of one physical card appearing together.
 */
function setupQuests(state) {
  const chosen = shuffle(state.rng, QST_PHYSICAL_IDS).slice(0, 3);
  state.quests = {};
  for (const physicalId of chosen) {
    const tier = next(state.rng) < 0.5 ? 'A' : 'B';
    state.quests[`${physicalId}${tier}`] = { claimCount: 0, claimedPlayers: [] };
  }
}

// ---------------------------------------------------------------------------
// GOAL
// ---------------------------------------------------------------------------

/**
 * GOAL text is a single bare comparison, e.g. "CARD_COUNT(M)>=1" -- the same grammar as the
 * left-hand side of PASSIVE's IF(condition, effect), just without the IF(...) wrapper (since a QST
 * GOAL has no attached effect of its own; the effect is the separate REWARD field). Empty/missing
 * GOAL is never met (a QST card without a GOAL can't be claimed).
 */
function goalMet(state, index, playerId, goalText) {
  if (!goalText) return false;
  const [conditionNode] = parseArgList(goalText);
  return executorApi.evalCondition(state, index, playerId, lowerCondition(conditionNode));
}

// ---------------------------------------------------------------------------
// Claim eligibility
// ---------------------------------------------------------------------------

/** REWARD field this player would receive by claiming now, or null if no slot is available to them
 * (already COMPLETE, or they already claimed from this specific card). */
function nextRewardField(quest, playerId) {
  if (quest.claimCount >= REWARD_FIELDS.length) return null;
  if (quest.claimedPlayers.includes(playerId)) return null;
  return REWARD_FIELDS[quest.claimCount];
}

/**
 * Checks every claim precondition without mutating anything: quest exists, player hasn't hit the
 * game-wide 2-reward cap, a reward slot is available to this player on this card, and GOAL is met.
 * @returns {{ok:true, rewardField:string}|{ok:false, reason:string}}
 */
function canClaim(state, index, playerId, questFaceId) {
  const quest = state.quests[questFaceId];
  if (!quest) return { ok: false, reason: 'UNKNOWN_QUEST' };
  const player = state.players.find((p) => p.id === playerId);
  if (player.qstRewardCount >= MAX_QST_REWARDS_PER_PLAYER) return { ok: false, reason: 'PLAYER_LIMIT_REACHED' };
  const rewardField = nextRewardField(quest, playerId);
  if (!rewardField) return { ok: false, reason: quest.claimCount >= REWARD_FIELDS.length ? 'COMPLETE' : 'ALREADY_CLAIMED' };
  const row = getQstRow(index, questFaceId);
  if (!goalMet(state, index, playerId, row.GOAL)) return { ok: false, reason: 'GOAL_NOT_MET' };
  return { ok: true, rewardField };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Commits a successful claim: bumps the card's claimCount, records the player, bumps their
 * game-wide qstRewardCount. Called only after the reward's DSL has actually run successfully, so a
 * failed/rolled-back reward never counts as a claim. */
function commitClaim(state, questFaceId, playerId) {
  const quest = state.quests[questFaceId];
  quest.claimCount += 1;
  quest.claimedPlayers.push(playerId);
  state.players.find((p) => p.id === playerId).qstRewardCount += 1;
}

/**
 * Claims questFaceId's next available reward for context.playerId, as a free action (see file-level
 * comment -- no TAP state, just the permanent claimedPlayers/qstRewardCount bookkeeping).
 *
 * If the reward's DSL starts with BUILD (candidate selection needed), this can't complete
 * synchronously -- board.resolveProgramOrBuild returns pendingBuild for the caller to resolve via
 * completeQuestClaim(), instead of committing the claim yet (no die value to fall back on here, unlike
 * an AREA-triggered BUILD -- a QST reward's BUILD either states its own threshold explicitly, e.g.
 * "BUILD(M,12)", or, if omitted, is treated as unconditional via Infinity, confirmed 2026-07-30 as the
 * sensible reading of "no threshold specified" when there's no die to derive one from). Otherwise runs
 * the full reward program immediately and commits the claim right away.
 */
function claimQuestReward(state, index, context, questFaceId) {
  const check = canClaim(state, index, context.playerId, questFaceId);
  if (!check.ok) return { success: false, reason: check.reason };

  const row = getQstRow(index, questFaceId);
  const rewardText = row[check.rewardField];
  const result = board.resolveProgramOrBuild(state, index, context, rewardText, Infinity);

  if (result.pendingBuild) {
    return { success: true, pendingBuild: { questFaceId, rewardField: check.rewardField, ...result.pendingBuild } };
  }
  if (!result.success) return result;
  commitClaim(state, questFaceId, context.playerId);
  return { success: true, result };
}

/** Completes a pendingBuild from claimQuestReward(): commits the chosen candidate, runs any DSL that
 * followed BUILD(...) in the reward field, then commits the claim. Mirrors board.js's
 * completeAreaBuild exactly (same non-atomicity trade-off: a failure partway through the "remaining
 * commands" doesn't unwind the BUILD itself, matching how AREA builds already behave). */
function completeQuestClaim(state, index, context, pendingBuild, candidate) {
  const buildResult = board.resolveBuild(state, index, context, candidate);
  if (!buildResult.success) return buildResult;
  for (const cmd of pendingBuild.remainingCommands || []) {
    executorApi.runCommand(state, index, context, cmd);
  }
  commitClaim(state, pendingBuild.questFaceId, context.playerId);
  return { success: true, buildResult };
}

module.exports = {
  QST_PHYSICAL_IDS,
  REWARD_FIELDS,
  MAX_QST_REWARDS_PER_PLAYER,
  setupQuests,
  goalMet,
  nextRewardField,
  canClaim,
  claimQuestReward,
  completeQuestClaim,
  commitClaim,
};

})();
