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
 * CON004A (傲慢) added 2026-08-22, per user request -- its existing PASSIVE=
 * BLOCK_UPGRADE_UNLESS_QST_RANK(Q004A,1) already gates upgrades on being ranked 1st on Q004A's
 * AREA_COUNT goal; the new rule adds an ONGOING VP cost for the same shortfall ("最多AREAが必要　足りない
 * １個につき-1VP"), same qst.rankPlayersForQuest-driven shape as 裏切/嫉妬 below, so it belongs here too
 * rather than as a new generic DSL command -- see con004aVpEffect's own doc. */
const BESPOKE_QST_RANK_CON_FACES = new Set(['CON006B', 'CON004B', 'CON004A']);

/** CON004A's own VP effect (傲慢, 2026-08-22, per user spec: "最多AREAが必要　足りない１個につき-1VP") --
 * -1VP for every AREA the player is short of whoever currently ranks 1st on Q004A's AREA_COUNT goal
 * (ties for 1st place have deficit 0, no penalty -- rankPlayersForQuest already gives every tied leader
 * rank 1). Live/dynamic like every other VP_PENALTY_* clause (recomputed at final scoring, not a
 * one-time snapshot). 0 if playerId doesn't actually own CON004A. */
function con004aVpEffect(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === 'CON004A');
  if (!owned) return 0;
  const ranked = qst.rankPlayersForQuest(state, index, 'Q004A');
  const myValue = ranked.find((e) => e.playerId === playerId).value;
  const leaderValue = Math.max(...ranked.map((e) => e.value));
  return -Math.max(0, leaderValue - myValue);
}

/** 裏切's own VP effect (2026-08-13, per user spec): "QSTで1位がある→-4VP、1位がなく2位がある→-2VP、
 * 1-2位がなく3位がある→-1VP、1-2-3位がない→0VP" -- best (lowest-numbered) rank across every currently-
 * revealed quest. 0 if playerId doesn't actually own 裏切. Still named con001bVpEffect after 裏切's
 * ORIGINAL physical id (CON001B) even though it now lives at CON006B -- see BESPOKE_QST_RANK_CON_FACES'
 * own doc. */
function con001bVpEffect(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === 'CON006B');
  if (!owned) return 0;
  const ranks = Object.keys(state.quests).map((faceId) => {
    const entry = qst.rankPlayersForQuest(state, index, faceId).find((e) => e.playerId === playerId);
    return entry.rank;
  });
  const bestRank = ranks.length ? Math.min(...ranks) : Infinity;
  if (bestRank === 1) return -4;
  if (bestRank === 2) return -2;
  if (bestRank === 3) return -1;
  return 0;
}

/** CON004B's own VP effect (嫉妬, 2026-08-13, per user spec): "一番上のQSTカードの順位に応じて
 * (順位-1)VP失う" -- "一番上" confirmed 2026-08-13 as whichever quest is first in state.quests' own key
 * order (画面表示順で一番左 -- currently reveal-shuffle order, so this is a different quest each game,
 * by design). 0 if playerId doesn't actually own CON004B. */
function con004bVpEffect(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === 'CON004B');
  if (!owned) return 0;
  const firstFaceId = Object.keys(state.quests)[0];
  if (!firstFaceId) return 0;
  const entry = qst.rankPlayersForQuest(state, index, firstFaceId).find((e) => e.playerId === playerId);
  return -(entry.rank - 1);
}

/**
 * The VP effect a single owned card FACE contributes on its own, independent of what else the player
 * owns (2026-08-15, for AI.DATA.xlsx's per-CON "VPペナルティ平均" column -- see tools/ai_data_report.js).
 * CON006B(裏切)/CON004B(嫉妬)/CON004A(傲慢) (bespoke, see their own doc above -- none fit the generic
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
  if (faceId === 'CON006B') return con001bVpEffect(state, index, playerId);
  if (faceId === 'CON004B') return con004bVpEffect(state, index, playerId);
  if (faceId === 'CON004A') return con004aVpEffect(state, index, playerId);
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
  const cardVp = ownedCardRows(state, index, playerId).reduce((sum, { row }) => {
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
