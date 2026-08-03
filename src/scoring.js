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

/** @returns {number} */
function computeFinalScore(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const cardVp = ownedCardRows(state, index, playerId).reduce((sum, { row }) => {
    const vp = row.VP;
    return sum + (typeof vp === 'number' ? vp : 0);
  }, 0);
  const resourceVp = player.resources.VP || 0;
  const modifierVp = collectVpModifiers(state, index, playerId);
  return cardVp + resourceVp + modifierVp;
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

module.exports = { computeFinalScore, rankPlayers };

})();
