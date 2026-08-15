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
const { ownedCardRows, collectVpModifiers, activePassiveCommands, evalCountNode, evalMetric } = require('./executor');
const qst = require('./qst');

/** CON face ids whose PASSIVE-driven VP effect isn't attributable to a single card via the generic
 * collectVpModifiers sum alone -- see conCardOwnVpEffect's own doc for why each needs its own bespoke
 * branch here rather than a real DSL command. */
const BESPOKE_QST_RANK_CON_FACES = new Set(['CON001B', 'CON004B']);

/** CON001B's own VP effect (裏切, 2026-08-13, per user spec): "QSTで1位がある→-4VP、1位がなく2位がある
 * →-2VP、1-2位がなく3位がある→-1VP、1-2-3位がない→0VP" -- best (lowest-numbered) rank across every
 * currently-revealed quest. 0 if playerId doesn't actually own CON001B. */
function con001bVpEffect(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === 'CON001B');
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
 * CON001B/CON004B (bespoke, see their own doc above -- neither fits the generic VP_MODIFIER/PASSIVE
 * metric vocabulary since executor.evalMetric deliberately doesn't know about qst.js, which sits ABOVE
 * it in the layering) delegate to their own named functions. Everything else with a real PASSIVE
 * (VP_MODIFIER and/or VP_PENALTY_IF_BELOW clauses -- e.g. CON003A/CON005B) evaluates just THAT row's
 * own PASSIVE text via activePassiveCommands, the same per-row primitive collectVpModifiers itself
 * loops over every owned card with -- so this stays in sync automatically if either command's own
 * semantics ever change. 0 for a card with no such clause, or one playerId doesn't own at all.
 * @returns {number} a VP delta (0 or negative for every currently-defined case)
 */
function conCardOwnVpEffect(state, index, playerId, faceId) {
  if (faceId === 'CON001B') return con001bVpEffect(state, index, playerId);
  if (faceId === 'CON004B') return con004bVpEffect(state, index, playerId);
  const player = state.players.find((p) => p.id === playerId);
  const owned = player.ownedCardPhysicalIds.some((id) => state.cards[id].currentFaceId === faceId);
  if (!owned) return 0;
  const row = getCardRow(index, faceId);
  if (!row.PASSIVE) return 0;
  let sum = 0;
  for (const cmd of activePassiveCommands(state, index, playerId, row)) {
    if (cmd.type === 'VP_MODIFIER') sum += evalCountNode(state, index, playerId, cmd.count);
    else if (cmd.type === 'VP_PENALTY_IF_BELOW') sum -= Math.max(0, cmd.threshold - evalMetric(state, index, playerId, cmd.metric));
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
  const conAdjustment = conCardVpAdjustment(state, index, playerId);
  return cardVp + resourceVp + modifierVp + conAdjustment;
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
