(function () {
/**
 * Final scoring (GAME_END, after round 4). [[project-dice-wp-flow-spec]]
 * confirms: highest total VP wins (reaching a VP threshold mid-game does
 * NOT win immediately), ties broken by earlier position in the final
 * round's turn order.
 *
 * VP sources (the "final calculation" the DSL spec's VP_MODIFIER note
 * refers to): each owned/built card's own VP column, plus the player's
 * accumulated VP resource (direct grants like ADD(VP)), plus every active
 * VP_MODIFIER PASSIVE rule. Assumption flagged for confirmation: summing
 * built cards' printed VP column isn't spelled out verbatim anywhere in the
 * flow spec, but every card sheet (M/A/B/C/CON/JOB/RESOURCE) has a VP
 * column and VP_MODIFIER is explicitly described as a "final calculation"
 * adjustment, so scoring only the resource counter without the cards'
 * printed VP would make that column meaningless.
 *
 * Known gap: tie-breaking uses state.turnOrder, which (see
 * [[project-dice-wp]]'s open gaps) is not yet redetermined each round via
 * the castle mechanic -- so this is only exactly correct for a game where
 * that never mattered.
 */

'use strict';

const { getCardRow } = require('./data-loader');
const { ownedCardRows, collectVpModifiers, collectFinalOnlyVpModifiers, activePassiveCommands, evalCountNode, evalMetric } = require('./executor');
const qst = require('./qst');

/** CON face ids whose PASSIVE-driven VP effect isn't attributable to a single card via the generic
 * collectVpModifiers sum alone -- see conCardOwnVpEffect's own doc for why each needs its own bespoke
 * branch here rather than a real DSL command.
 *
 * 2026-08-17: the user reorganized game.xlsx's CON sheet so each physical slot's number matches its own
 * START_ORDER (CON001x=0 ... CON006x=5) -- 裏切 moved from CON001B to CON006B; 嫉妬 happened to stay at
 * CON004B. These two ids (and con001bVpEffect's own internal check below) were bumped to match; the
 * function is still NAMED con001bVpEffect (historical, matching its ORIGINAL id, not its current one) to
 * keep this diff small -- don't take the name as the live physical id, check BESPOKE_QST_RANK_CON_FACES
 * or the id literal inside the function itself for that.
 *
 * 2026-09-26: 裏切/暴食 swapped which face of CON006 is 表/裏 (per user request: "暴食 表／裏切 裏 を
 * 裏切 表／暴食 裏 にしたい") -- 裏切 now lives at CON006A (was CON006B), 暴食 at CON006B (was CON006A).
 * Bumped here and in con001bVpEffect's own check below to follow it; tools/ai_data_report.js's own
 * mirrored CON_VP_PENALTY_FACES set and tests/scoring.smoke.js/tests/executor.smoke.js/
 * tests/ai-evaluator.smoke.js's hardcoded ids were updated to match in the same commit.
 *
 * CON004A (傲慢) added 2026-08-22, per user request -- its existing PASSIVE=
 * BLOCK_UPGRADE_UNLESS_QST_RANK(Q004A,1) already gates upgrades on being ranked 1st on Q004A's
 * AREA_COUNT goal; the new rule adds an ONGOING VP cost for the same shortfall ("最多AREAが必要　足りない
 * １個につき-1VP"), same qst.rankPlayersForQuest-driven shape as 裏切/嫉妬 below, so it belongs here too
 * rather than as a new generic DSL command -- see con004aVpEffect's own doc. */
//
// 2026-11-02 CON redesign (per user「性格かなり変更しました」): the old 傲慢 VP shortfall, old 裏切 (best-rank
// penalty) and old 嫉妬 (top-quest rank-1) are gone. 嫉妬 now lives at CON004A with a new rule (see
// jealousyVpEffect); the new 裏切 (CON004B,「クエストからVPを得ることができない」) is handled where quest rewards are
// granted (qst.resolveEndGameRewards / qst.forfeitsQuestRewards), not as a VP penalty here.
const JEALOUSY_CON_FACE_ID = 'CON004A';
const BESPOKE_QST_RANK_CON_FACES = new Set([JEALOUSY_CON_FACE_ID]);

/** 嫉妬 (CON004A, 2026-11-02, per user INST「ゲーム終了時クエスト１位が必要 １位でないクエスト数だけ-1VP」, tie for
 * 1st counts as 1st per user「同点の1位でもよい」) -- -2VP (was -1VP) per revealed quest this player isn't ranked 1st on.
 * 0 if playerId doesn't own CON004A. */
function jealousyVpEffect(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === JEALOUSY_CON_FACE_ID);
  if (!owned) return 0;
  let notFirst = 0;
  for (const faceId of Object.keys(state.quests)) {
    const entry = qst.rankPlayersForQuest(state, index, faceId).find((e) => e.playerId === playerId);
    if (entry.rank !== 1) notFirst++;
  }
  return -notFirst; // -1VP -> -2VP (2026-11-02) -> -1VP (2026-11-04, per user data edit「嫉妬変更しました」: INST「１位でないクエスト数だけ-1VP」)
}

/**
 * The VP effect a single owned card FACE contributes on its own, independent of what else the player
 * owns (2026-08-15, for AI.DATA.xlsx's per-CON "VPペナルティ平均" column -- see tools/ai_data_report.js).
 * CON006A(裏切)/CON004B(嫉妬)/CON004A(傲慢) (bespoke, see their own doc above -- none fit the generic
 * VP_MODIFIER/PASSIVE metric vocabulary since executor.evalMetric deliberately doesn't know about
 * qst.js, which sits ABOVE it in the layering) delegate to their own named functions. Everything else
 * with a real PASSIVE (VP_MODIFIER/VP_PENALTY_IF_BELOW/VP_PENALTY_PER clauses -- e.g. CON003A/CON002A/
 * CON002B as of 2026-08-17's physical-slot reorg) evaluates
 * just THAT row's own PASSIVE text via activePassiveCommands, the same per-row primitive
 * collectVpModifiers itself loops over every owned card with -- so this stays in sync automatically if
 * any of those commands' own semantics ever change. 0 for a card with no such clause, or one playerId
 * doesn't own at all.
 * @returns {number} a VP delta (0 or negative for every currently-defined case)
 */
function conCardOwnVpEffect(state, index, playerId, faceId) {
  if (faceId === JEALOUSY_CON_FACE_ID) return jealousyVpEffect(state, index, playerId);
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === faceId);
  if (!owned) return 0;
  const row = getCardRow(index, faceId);
  if (!row.PASSIVE) return 0;
  let sum = 0;
  for (const cmd of activePassiveCommands(state, index, playerId, row)) {
    if (cmd.type === 'VP_MODIFIER') sum += evalCountNode(state, index, playerId, cmd.count);
    else if (cmd.type === 'VP_PENALTY_IF_BELOW') sum -= Math.max(0, cmd.threshold - evalMetric(state, index, playerId, cmd.metric));
    else if (cmd.type === 'VP_PENALTY_PER') sum -= evalMetric(state, index, playerId, cmd.metric);
  }
  return sum;
}

/** Sum of conCardOwnVpEffect across every currently-known bespoke-or-PASSIVE-driven CON face the player
 * owns (2026-08-13/15). Folded into computeFinalScore below. Deliberately only sums the BESPOKE
 * (qst-dependent) faces here plus nothing else -- a PASSIVE-driven card's own VP_MODIFIER/
 * VP_PENALTY_IF_BELOW clauses are already counted once by collectVpModifiers' own sweep across every
 * owned card, so re-adding them via conCardOwnVpEffect here would double-count them. Only
 * BESPOKE_QST_RANK_CON_FACES needs this separate top-up, since those two never had real PASSIVE data
 * for collectVpModifiers to find in the first place. */
function conCardVpAdjustment(state, index, playerId) {
  let adjustment = 0;
  for (const faceId of BESPOKE_QST_RANK_CON_FACES) adjustment += conCardOwnVpEffect(state, index, playerId, faceId);
  return adjustment;
}

/** @returns {number} */
function computeFinalScore(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  // RESOURCE cards (physicalId starting with 'R') are excluded here (2026-09-23): their own printed VP
  // is now granted live into resources.VP by setup.receiveInitialResources instead of being counted as
  // printed-card VP -- see that function's own doc. Counting it here too would double it.
  const cardVp = ownedCardRows(state, index, playerId).reduce((sum, { physicalId, row }) => {
    if (physicalId.startsWith('R')) return sum;
    const vp = row.VP;
    return sum + (typeof vp === 'number' ? vp : 0);
  }, 0);
  const resourceVp = player.resources.VP || 0;
  const modifierVp = collectVpModifiers(state, index, playerId);
  // 2026-09-01, M401/晩餐会's own "ゲーム終了時持っている2Kにつき1VP(MAX10VP)" -- see
  // executor.collectFinalOnlyVpModifiers's own doc for why this is 0 for every state until the game
  // has actually ended (state.phase==='GAME_END'), so this function's own "safe to call every render"
  // contract (main.js's live running-score display) is unaffected before then.
  const finalOnlyModifierVp = collectFinalOnlyVpModifiers(state, index, playerId);
  const conAdjustment = conCardVpAdjustment(state, index, playerId);
  return cardVp + resourceVp + modifierVp + finalOnlyModifierVp + conAdjustment;
}

/**
 * @returns {{playerId:string, score:number}[]} every player, sorted winner-first
 *   (highest score; ties broken by earlier position in state.turnOrder)
 */
function rankPlayers(state, index) {
  const scored = state.players.map((p) => ({
    playerId: p.id,
    score: computeFinalScore(state, index, p.id),
    turnOrderIndex: state.turnOrder.indexOf(p.id),
  }));
  scored.sort((a, b) => b.score - a.score || a.turnOrderIndex - b.turnOrderIndex);
  return scored.map(({ playerId, score }) => ({ playerId, score }));
}

module.exports = { computeFinalScore, rankPlayers, conCardVpAdjustment, conCardOwnVpEffect };

})();
