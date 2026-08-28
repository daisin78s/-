(function () {
'use strict';

/**
 * AI LV4 die-scarcity tie-break (2026-08-28, per user request, given as: "カードを獲得する時置けるダイス
 * が複数あるなら、まだ置いていないダイスの目で多いものから使う(ダイス目3が場に多く残っているならそれ
 * から先に使う) 同じなら1、2Rなら大きい目から3、4Rなら小さい目から使う wDとDならDから使う" -- confirmed
 * via follow-up Q&A to apply to EVERY placement decision (not just card acquisition), to count across
 * ALL players' currently-unplaced dice (not just this AI's own), and to use the die-value-count
 * comparison BEFORE the wD(white/wildcard)-vs-D(color) fallback).
 *
 * This is a pure tie-break: it only distinguishes between moves the Evaluator already scored exactly
 * equally (e.g. several of the AI's own dice can all reach the same outcome) -- it never changes which
 * move wins when scores differ. See AIPlayer's own dieScarcityTieBreak option doc for where this plugs
 * in; LV1/2/3 never pass that option, so they stay byte-for-byte unaffected.
 */

/** @returns {Object<number,number>} count of not-yet-placed dice across every player, keyed by die
 * value (1-6). "Not yet placed" = placedMapId still null (mirrors board.js's own placement bookkeeping). */
function countUnplacedDiceByValue(state) {
  const counts = {};
  for (const player of state.players) {
    for (const die of player.dice) {
      if (die.placedMapId !== null || die.value === null) continue;
      counts[die.value] = (counts[die.value] || 0) + 1;
    }
  }
  return counts;
}

function findDie(state, dieId) {
  for (const player of state.players) {
    const die = player.dice.find((d) => d.id === dieId);
    if (die) return die;
  }
  return null;
}

/** @returns {string[]} the die id(s) a Move consumes -- PLACE_DIE/PLACE_WILDCARD_DIE carry one
 * (`dieId`), PLACE_DICE_GROUP carries two (`dieIds`); anything else (PASS_DIE, free actions, ...)
 * carries none and is left untouched by this tie-break. */
function moveDieIds(move) {
  if (move.dieIds) return move.dieIds;
  if (move.dieId) return [move.dieId];
  return [];
}

/** Per-die priority key: lower sorts first (more preferred to spend now). */
function dieRank(state, dieId, round, countsByValue) {
  const die = findDie(state, dieId);
  if (!die) return null;
  return {
    count: countsByValue[die.value] || 0,
    value: die.value,
    isWild: die.kind === 'WHITE',
  };
}

/** Compares two same-value-shaped dieRank objects; negative = a preferred over b. */
function compareRanks(a, b, round) {
  if (a.count !== b.count) return b.count - a.count; // higher remaining count spent first
  if (a.value !== b.value) return round <= 2 ? b.value - a.value : a.value - b.value;
  if (a.isWild !== b.isWild) return a.isWild ? 1 : -1; // real color die before white/wildcard
  return 0;
}

/**
 * @param {GameState} state
 * @param {number} round
 * @param {Object<number,number>} [countsByValue] - pass a precomputed countUnplacedDiceByValue(state)
 *   result to avoid recomputing it for every comparison in a sort; defaults to computing it fresh.
 * @returns {(a:Object,b:Object)=>number} a comparator over Move objects for Array#sort -- negative
 *   means `a` should be preferred (sort first). Moves with no die (PASS_DIE, free actions) always
 *   compare equal (0) to anything, leaving their relative order to whatever tie-break runs next.
 */
function compareDicePriority(state, round, countsByValue) {
  const counts = countsByValue || countUnplacedDiceByValue(state);
  return function comparePlaceDieMoves(a, b) {
    const idsA = moveDieIds(a);
    const idsB = moveDieIds(b);
    if (idsA.length === 0 || idsB.length === 0) return 0;
    const ranksA = idsA.map((id) => dieRank(state, id, round, counts)).sort((x, y) => compareRanks(x, y, round));
    const ranksB = idsB.map((id) => dieRank(state, id, round, counts)).sort((x, y) => compareRanks(x, y, round));
    const len = Math.min(ranksA.length, ranksB.length);
    for (let i = 0; i < len; i++) {
      const cmp = compareRanks(ranksA[i], ranksB[i], round);
      if (cmp !== 0) return cmp;
    }
    if (ranksA.length !== ranksB.length) return ranksA.length - ranksB.length;
    // Fully tied on priority -- fall back to a stable, deterministic order (sorted dieIds joined).
    const keyA = idsA.slice().sort().join(',');
    const keyB = idsB.slice().sort().join(',');
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  };
}

module.exports = { countUnplacedDiceByValue, compareDicePriority };

})();
