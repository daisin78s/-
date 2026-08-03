(function () {
'use strict';

/**
 * Evaluator: scores a GameState from playerId's own perspective -- higher is better. This is the
 * *only* piece that knows about the "評価値" sheet (see eval-table.js); MoveGenerator/Simulator never
 * touch it, so swapping in a different Evaluator (e.g. one driven by a genetic-algorithm-tuned table,
 * or a learned value function) never requires touching either of them.
 *
 * Key design point (2026-08-01, confirmed with the user across the whole "評価値" chat): this scores
 * the *resulting* state directly (resources on hand, dice on hand, cards owned) rather than trying to
 * separately parse "what did this move just grant". Since Simulator always hands back the state
 * *after* a move's ONCE/PASSIVE effects have already run, everything the move granted (resources,
 * dice, a MAP tier flip's downstream effect on future AREA actions) is already reflected in the
 * numbers being summed here -- so printed VP/COST/ONCE-granted resources never need separate handling,
 * exactly the "don't duplicate what the data already expresses" principle the eval-table sheet itself
 * follows. A card's own eval-table entry is reserved for what genuinely can't be derived this way
 * (PASSIVE/TAP ongoing worth, emblem synergy, a board-altering ONCE like a MAP tier flip).
 */

const { getCardRow } = require('../data-loader');
const { lowerCostList } = require('../command-builder');
const executor = require('../executor');
const { evalValue } = require('./eval-table');

/** Same regex board.js's own (unexported) parseMonumentThreshold uses, e.g. ">=12" -> 12. Duplicated
 * rather than exported from board.js purely for this one line -- see monumentAtRiskFromOpponents. */
function parseMonumentThreshold(diceString) {
  const match = /^>=(\d+)$/.exec(diceString);
  return match ? Number(match[1]) : null;
}

/** Whether some OTHER player already has, right now, both a qualifying unplaced color die and enough
 * resources to build monumentFaceId (2026-08-04, per user feedback: "そのモニュメントとられるかもは
 * 相手のダイスと資源が今足りているかで判断するようにしてください フリーアクションやJOBは現在は考慮
 * しなくていいです") -- a cheap current-state-only snapshot: never simulates an opponent's future
 * turns, and deliberately ignores free actions (e.g. A->K) or JOB abilities that could let them convert
 * toward affording it -- just their raw held resources and raw die values right now. Only checks the
 * die-value threshold (not e.g. the castle's own same-value-stacking accumulation), matching the common
 * case of a monument reachable via a normal AREA's own die value. */
function monumentAtRiskFromOpponents(state, index, playerId, monumentFaceId) {
  const row = getCardRow(index, monumentFaceId);
  const threshold = parseMonumentThreshold(row.DICE);
  if (threshold === null) return false;
  const costItems = lowerCostList(row.COST);
  for (const opponent of state.players) {
    if (opponent.id === playerId) continue;
    const hasQualifyingDie = opponent.dice.some((d) => d.kind === 'COLOR' && d.placedMapId === null && !d.passed && d.value !== null && d.value >= threshold);
    if (!hasQualifyingDie) continue;
    const canAfford = costItems.every((item) => (opponent.resources[item.resource] || 0) >= item.count);
    if (canAfford) return true;
  }
  return false;
}

class Evaluator {
  /** @param {DataIndex} index @param {Object} evalTable - see eval-table.js's buildEvalTable() */
  constructor(index, evalTable) {
    this.index = index;
    this.evalTable = evalTable;
  }

  /** @returns {number} playerId's position score in state, at state's current round. */
  score(state, playerId) {
    const round = state.round || 1;
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return 0;
    const v = (id) => evalValue(this.evalTable, round, id);

    let total = 0;

    for (const resource of ['K', 'A', 'B', 'C', 'Z', 'BZ']) {
      total += (player.resources[resource] || 0) * v(resource);
    }
    total += (player.resources.VP || 0) * v('VP');

    // A passed die (2026-08-03, see board.passDie) is scored separately from a genuinely-still-
    // placeable one -- found via a real game trace (AI chose PASS_DIE 13 times vs PLACE_DIE once in a
    // single round 1): the full 'D' weight (40 in round 1) represents the *option value* of a die that
    // can still be placed for whatever an AREA grants, but a passed die has already given that up for
    // this round -- its only remaining guaranteed value is turn-flow.endRound's "unused color die ->
    // 3K" rule (v('K')*3), which is far below 'D''s weight. Leaving passed dice at the full 'D' value
    // made passing score *better* than almost any real placement (since most single-AREA gains are
    // worth less than 40), so the AI passed by default instead of playing. White dice have no such
    // guaranteed round-end conversion (only color dice do), so passed wD keeps the normal 'wD' weight.
    const unplacedColor = player.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null && !d.passed).length;
    const passedColor = player.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null && d.passed).length;
    const unplacedWhite = player.dice.filter((d) => d.kind === 'WHITE' && d.placedMapId === null).length;
    total += unplacedColor * v('D');
    total += passedColor * v('K') * 3;
    total += unplacedWhite * v('wD');

    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState) continue;
      let row;
      try { row = getCardRow(this.index, cardState.currentFaceId); } catch (e) { continue; }
      total += v(cardState.currentFaceId);
      if (typeof row.VP === 'number') total += row.VP * v('VP');
    }

    total += executor.collectVpModifiers(state, this.index, playerId) * v('VP');

    // Monument-sniping risk (2026-08-04, per user feedback -- see monumentAtRiskFromOpponents' own
    // doc): for each monument still sitting in the M shop, if it's "at risk" (some opponent already has
    // what it takes to grab it right now), subtract the value it *would* have contributed if owned
    // (same eval-table-value + VP*VP-weight formula as an owned card, just as a penalty instead of a
    // credit). This discourages the AI's lookahead from banking toward, or passively leaving unclaimed,
    // a monument someone else could take first -- and rewards a path where THIS player claims it
    // instead, since claiming it removes it from the shop and the penalty stops applying.
    if (state.shops && state.shops.M) {
      for (const faceId of Object.values(state.shops.M.slots)) {
        if (!faceId) continue;
        if (monumentAtRiskFromOpponents(state, this.index, playerId, faceId)) {
          const row = getCardRow(this.index, faceId);
          const vp = typeof row.VP === 'number' ? row.VP : 0;
          total -= v(faceId) + vp * v('VP');
        }
      }
    }

    return total;
  }
}

module.exports = { Evaluator };

})();
