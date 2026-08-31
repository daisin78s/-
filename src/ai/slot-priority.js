(function () {
'use strict';

/**
 * AI LV4 own-territory EX-slot tie-break (2026-08-31, per user request: "AIが自分の領地にダイスを置く
 * とき 1R2R3Rでは EXとそれ以外で置く場所を選べるなら EXに置くようにしてほしい" -- confirmed via
 * follow-up as a pure tie-break, only among moves the Evaluator already scored exactly equally, and
 * confirmed round 4 stays an exception ("4Rは例外で").
 *
 * Rationale (confirmed by board.js's own EX rule -- see placeDice's "EX_NOT_OWNER" check): an EX slot can
 * ONLY ever be occupied by the AREA's own owner, never an opponent, while an ANY slot can be used by
 * anyone (and generates a usage fee for the owner when an opponent uses it). So when the owner has a
 * genuine choice of which slot to place their own die in, taking the EX slot -- which nobody else could
 * ever have used anyway -- leaves the ANY slot open for a fee-paying opponent, instead of "wasting" that
 * more valuable, universally-usable slot on a placement only the owner needed to make at all.
 *
 * This is a pure tie-break: it only distinguishes between moves the Evaluator already scored exactly
 * equally (e.g. the same die could land on either an EX or an ANY slot at the same AREA, same resulting
 * action). It never changes which move wins when scores differ. See AIPlayer's own preferExOnOwnTerritory
 * option doc for where this plugs in; every other level never passes that option, so they stay
 * byte-for-byte unaffected.
 */

const { getAreaRow } = require('../data-loader');
const { getSlotRequirements } = require('../board');

/** Lower sorts first (more preferred). 0 = an EX slot on the mover's own AREA; 1 = everything else
 * (a non-EX slot, a slot on someone else's/unowned AREA, or a move with no slot at all). */
function exSlotRank(state, index, playerId, move) {
  if (move.slotIndex === undefined || !move.mapId) return 1;
  const map = state.maps[move.mapId];
  if (!map || map.feeOwnerId !== playerId) return 1;
  const requirements = getSlotRequirements(getAreaRow(index, map.currentAreaId));
  return requirements[move.slotIndex] === 'EX' ? 0 : 1;
}

/**
 * @param {GameState} state
 * @param {import('../data-loader').DataIndex} index
 * @param {string} playerId
 * @returns {(a:Object,b:Object)=>number} a comparator over Move objects for Array#sort -- negative means
 *   `a` should be preferred (sort first). Always compares equal (0) once state.round reaches 4 (per the
 *   user's own "4Rは例外で" -- round 4 already has its own generously deep lookahead, unaffected here).
 */
function compareExSlotPreference(state, index, playerId) {
  if (state.round >= 4) return () => 0;
  return function compareExSlotMoves(a, b) {
    return exSlotRank(state, index, playerId, a) - exSlotRank(state, index, playerId, b);
  };
}

module.exports = { compareExSlotPreference };

})();
