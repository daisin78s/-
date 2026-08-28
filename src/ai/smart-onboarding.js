(function () {
'use strict';

/**
 * "AI LV4" smart onboarding policy -- hand-authored domain knowledge (game.xlsx's 評価値_2/評価値_3
 * sheets) driving the onboarding decisions the ordinary random-onboarding AI (LV1-3, see
 * game-runner.js's own doc on why RESOURCE/CON/JOB stay random there) never bothered with. Only
 * resource-card selection is implemented so far (2026-08-27); CON/JOB selection are a planned follow-up
 * -- see this file's own git history once added.
 *
 * Design (agreed with the user, 2026-08-27): "基本的には資源カードは数字の大きい2枚をとります ただし
 * 自分の持っているCONの片面と相性の悪い初期資源はマイナス評価します 逆に自分の持っているCONや見えている
 * JOBと相性のいいカードはプラス評価します" -- the "数字" is each RESOURCE card's own START_ORDER (a
 * plain data field, not a computed eval-table score -- confirmed 2026-08-27), adjusted by summing
 * 評価値_3's synergy value for every name relevant to this pick: both faces of the player's own dealt CON
 * (confirmed: a penalty applies if EITHER face clashes, not just the one that ends up chosen later) plus
 * every JOB currently visible in state.jobPool. The adjustment is added directly onto START_ORDER itself
 * (confirmed via a worked example: "先行順6のカードが-2だったら4扱い"), not treated as a mere tie-break,
 * so a strong enough synergy can outrank a card that would otherwise win on raw START_ORDER alone. Ties
 * (equal effective order) fall back to ascending numeric ID, matching the original random-pick code's own
 * tie-shape (deterministic, not random) now that this path is no longer randomized at all.
 *
 * Requires state.jobPool to already be populated (setup.dealJobPool) -- per user confirmation, real
 * physical play already reveals the JOB pool before resource cards are chosen (main.js's own setup order
 * already does this correctly; only game-runner.js's Node-only AI driver had this backwards -- see its
 * own fix alongside this file).
 */

const { getCardRow } = require('../data-loader');
const { synergyValue } = require('./resource-card-synergy');
const conJobSynergy = require('./con-job-synergy');
const rng = require('../rng');
const setup = require('../setup');
const { cloneState } = require('../game-state');

function numericIdSuffix(id) {
  return Number(String(id).replace(/^[A-Z]+/, ''));
}

/**
 * @param {string[]} candidateIds - the 5 dealt RESOURCE card ids for this player.
 * @param {GameState} state - state.jobPool must already be populated.
 * @param {DataIndex} index
 * @param {Object} synergyTable - see resource-card-synergy.js's buildResourceSynergyTable.
 * @param {string} conPhysicalId - the player's own dealt CON card (e.g. "CON002").
 * @returns {string[]} the 2 ids to keep, best-first.
 */
function pickResourceCards(candidateIds, state, index, synergyTable, conPhysicalId) {
  const conFaceNames = ['A', 'B']
    .map((face) => {
      try { return getCardRow(index, `${conPhysicalId}${face}`).NAME; } catch (e) { return null; }
    })
    .filter(Boolean);
  const jobNames = (state.jobPool || []).map((jobId) => getCardRow(index, jobId).NAME);
  const relevantNames = [...conFaceNames, ...jobNames];

  const scored = candidateIds.map((id) => {
    const row = getCardRow(index, id);
    const synergy = relevantNames.reduce((sum, name) => sum + synergyValue(synergyTable, name, row.ONCE), 0);
    const baseOrder = typeof row.START_ORDER === 'number' ? row.START_ORDER : 0;
    return { id, effectiveOrder: baseOrder + synergy };
  });

  scored.sort((a, b) => b.effectiveOrder - a.effectiveOrder || numericIdSuffix(a.id) - numericIdSuffix(b.id));
  return scored.slice(0, 2).map((s) => s.id);
}

/**
 * Finds every outcome actually reachable this turn from `state` for `playerId`, via a single real legal
 * move (2026-08-27, for pickJob's own reachability check -- per user spec: "実際に獲得できるカードにか
 * ぎる ダイス目が悪くて取れないなど"). Reuses the real MoveGenerator/Simulator rather than re-deriving
 * board legality/affordability here, so this stays correct if either one's own rules ever change.
 * Deliberately only 1-ply (does every currently-legal move immediately achieve X), not a multi-move
 * search -- matches every worked example the user gave (a single die placement either builds a card or
 * grants a color die).
 * @returns {{cardFaceIds: Set<string>, colorDiceGained: boolean}}
 */
function findReachableOutcomes(state, index, playerId, moveGenerator, simulator) {
  const outcomes = { cardFaceIds: new Set(), colorDiceGained: false };
  const player = state.players.find((p) => p.id === playerId);
  const beforeColorCount = player.dice.filter((d) => d.kind === 'COLOR').length;
  const moves = moveGenerator.generateMoves(state, index, playerId, { hasPlacedDieThisTurn: false });
  for (const move of moves) {
    const { state: resultState, result } = simulator.apply(state, index, move);
    if (!result.success) continue;
    if (result.candidate) {
      const faceId = result.candidate.type === 'BUILD_NEW' ? result.candidate.faceId : result.candidate.toFaceId;
      outcomes.cardFaceIds.add(faceId);
    }
    const resultPlayer = resultState.players.find((p) => p.id === playerId);
    if (resultPlayer.dice.filter((d) => d.kind === 'COLOR').length > beforeColorCount) {
      outcomes.colorDiceGained = true;
    }
  }
  return outcomes;
}

/** The single best 評価値_2 value achievable this turn for (jobId, conFaceId), given `state` already has
 * that JOB/CON face's ONCE effects (and the player's own already-chosen RESOURCE cards' ONCE effects)
 * applied -- see pickJobAndConFace's own doc for how that clone gets built. Candidates considered:
 *   - The CON face's own row -- unconditional (choosing it IS achieving it, no board-state check).
 *   - Every LV1 card row that's actually reachable this turn (findReachableOutcomes).
 *   - The "D" row (renamed from "色ダイス" 2026-08-28), if gaining a color die is actually reachable
 *     this turn.
 * Only non-negative candidates are ever picked (2026-08-27, per user spec: "マイナスのついている組み合
 * わせは選ばない") -- if every candidate here is negative, returns -Infinity so this (job, face) pair
 * always loses to any pairing with a genuine non-negative option. Never sums multiple simultaneously-
 * achievable rows together (confirmed with the user: take the single best one). */
function bestAchievableSynergyValue(state, index, playerId, jobId, conFaceId, synergyTable2, moveGenerator, simulator) {
  const candidates = [];
  const conFaceName = getCardRow(index, conFaceId).NAME;
  candidates.push(conJobSynergy.synergyValue(synergyTable2, conFaceName, jobId));

  const reachable = findReachableOutcomes(state, index, playerId, moveGenerator, simulator);
  for (const faceId of reachable.cardFaceIds) {
    const cardName = getCardRow(index, faceId).NAME;
    candidates.push(conJobSynergy.synergyValue(synergyTable2, cardName, jobId));
  }
  if (reachable.colorDiceGained) {
    candidates.push(conJobSynergy.synergyValue(synergyTable2, conJobSynergy.COLOR_DICE_ROW_NAME, jobId));
  }

  const nonNegative = candidates.filter((v) => v >= 0);
  return nonNegative.length > 0 ? Math.max(...nonNegative) : -Infinity;
}

/** Builds a throwaway clone of `state` with jobId drafted, conFace chosen, and the player's own
 * already-owned RESOURCE cards' ONCE effects applied -- exactly the real onboarding sequence (see
 * setup.chooseJob/chooseConFace/receiveInitialResources), just run against a disposable clone so
 * evaluating a candidate never touches the real game. state.jobPool must still contain jobId (not yet
 * actually drafted for real). */
function simulateOnboardingChoice(state, index, playerId, jobId, face) {
  const clone = cloneState(state);
  setup.chooseJob(clone, index, playerId, jobId);
  const conPhysicalId = clone.players.find((p) => p.id === playerId).conPhysicalId;
  setup.chooseConFace(clone, index, playerId, face);
  setup.receiveInitialResources(clone, index, playerId);
  return { clone, conFaceId: `${conPhysicalId}${face}` };
}

/**
 * Picks the best JOB to draft from state.jobPool (2026-08-27, "AI LV4" -- per user design: for every
 * (JOB, CON face) combination, simulate through the resulting onboarding state and take the best
 * achievable 評価値_2 value (see bestAchievableSynergyValue) -- excluding negative-only combos entirely.
 * The JOB associated with the single highest value across BOTH of the player's CON faces wins; ties broken
 * uniformly at random (per user spec: "評価値が同じなら最上位評価値の中からランダムに選ぶ"). Does NOT
 * commit anything -- purely picks which jobId setup.chooseJob should then be called with for real.
 * @param {GameState} state - state.jobPool populated, playerId not yet onboarded.
 * @returns {string} the chosen jobId.
 */
function pickJob(state, index, playerId, synergyTable2, moveGenerator, simulator, rngState) {
  let bestValue = -Infinity;
  let bestJobIds = [];
  for (const jobId of state.jobPool) {
    let jobValue = -Infinity;
    for (const face of ['A', 'B']) {
      const { clone, conFaceId } = simulateOnboardingChoice(state, index, playerId, jobId, face);
      const value = bestAchievableSynergyValue(clone, index, playerId, jobId, conFaceId, synergyTable2, moveGenerator, simulator);
      if (value > jobValue) jobValue = value;
    }
    if (jobValue > bestValue) {
      bestValue = jobValue;
      bestJobIds = [jobId];
    } else if (jobValue === bestValue) {
      bestJobIds.push(jobId);
    }
  }
  return bestJobIds[Math.floor(rng.next(rngState) * bestJobIds.length)];
}

/**
 * Picks the better of the player's own 2 CON faces, now that jobId is already fixed (2026-08-27, "AI
 * LV4") -- a direct lookup, no simulation needed (confirmed with the user: unlike JOB, which previews
 * both faces via a full reachability simulation, the CON face decision itself just compares
 * 評価値_2[jobId][faceA] vs [faceB] directly). Ties broken uniformly at random, same as pickJob.
 * @returns {'A'|'B'}
 */
function pickConFace(state, index, playerId, jobId, synergyTable2, rngState) {
  const conPhysicalId = state.players.find((p) => p.id === playerId).conPhysicalId;
  const values = ['A', 'B'].map((face) => {
    const name = getCardRow(index, `${conPhysicalId}${face}`).NAME;
    return conJobSynergy.synergyValue(synergyTable2, name, jobId);
  });
  if (values[0] === values[1]) return rng.next(rngState) < 0.5 ? 'A' : 'B';
  return values[0] > values[1] ? 'A' : 'B';
}

module.exports = { pickResourceCards, pickJob, pickConFace };

})();
