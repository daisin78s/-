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
const { ownedCardRows, collectVpModifiers } = require('./executor');
const qst = require('./qst');

/**
 * CON001B/CON004B (2026-08-13, per user spec): 2 CON cards whose penalty depends on cross-player QST
 * ranking -- doesn't fit the generic VP_MODIFIER/PASSIVE metric vocabulary (executor.evalMetric
 * deliberately doesn't know about qst.js -- executor.js sits BELOW qst.js in the layering, see qst.js's
 * own file doc), so these are recognized by exact owned face id instead, same precedent as
 * executor.js's PAYMENT_CHOICE_CON_FACE_ID. (CON005B used to live here too -- see the 2026-08-15
 * VP_PENALTY_IF_BELOW command, the general "○○が必要" shortfall rule, which now covers it as real
 * PASSIVE data instead, via collectVpModifiers.) Called from computeFinalScore below, which runs live
 * every render (not just at GAME_END), so the running score already previews what each would apply at
 * the real game end -- same as QST's own live rank preview elsewhere.
 * @returns {number} a VP delta (0 or negative -- neither of these ever grants VP)
 */
function conCardVpAdjustment(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const owned = new Set(player.ownedCardPhysicalIds.map((id) => state.cards[id].currentFaceId));
  let adjustment = 0;

  // CON001B (裏切): "QSTで1位がある→-4VP、1位がなく2位がある→-2VP、1-2位がなく3位がある→-1VP、
  // 1-2-3位がない→0VP" -- best (lowest-numbered) rank across every currently-revealed quest.
  if (owned.has('CON001B')) {
    const ranks = Object.keys(state.quests).map((faceId) => {
      const entry = qst.rankPlayersForQuest(state, index, faceId).find((e) => e.playerId === playerId);
      return entry.rank;
    });
    const bestRank = ranks.length ? Math.min(...ranks) : Infinity;
    if (bestRank === 1) adjustment -= 4;
    else if (bestRank === 2) adjustment -= 2;
    else if (bestRank === 3) adjustment -= 1;
  }

  // CON004B (嫉妬): "一番上のQSTカードの順位に応じて(順位-1)VP失う" -- "一番上" confirmed 2026-08-13 as
  // whichever quest is first in state.quests' own key order (画面表示順で一番左 -- currently reveal-
  // shuffle order, so this is a different quest each game, by design).
  if (owned.has('CON004B')) {
    const firstFaceId = Object.keys(state.quests)[0];
    if (firstFaceId) {
      const entry = qst.rankPlayersForQuest(state, index, firstFaceId).find((e) => e.playerId === playerId);
      adjustment -= entry.rank - 1;
    }
  }

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

module.exports = { computeFinalScore, rankPlayers, conCardVpAdjustment };

})();
