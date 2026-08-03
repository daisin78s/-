(function () {
/**
 * Deterministic PRNG. GameState must be fully reconstructable from its log
 * (see [[project-dice-wp-flow-spec]]'s Undo/save/log rules), so every random
 * choice in the game (shuffles, dice rolls) must go through here rather than
 * Math.random().
 *
 * mulberry32: small, fast, good-enough distribution for a board game, and its
 * entire state is one 32-bit integer -- trivial to store in GameState.rng and
 * survive structuredClone()/JSON serialization for save data.
 */

'use strict';

/** Turns a string seed into a 32-bit integer starting state (djb2-ish hash). */
function hashSeed(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/**
 * @param {string|number} seed
 * @returns {{state: number}} - pass this object into next()/shuffle()/rollDie(); it mutates in place
 */
function createRng(seed) {
  const state = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed));
  return { state };
}

/** Advances the RNG and returns a float in [0, 1). Mutates rng.state. */
function next(rng) {
  let t = (rng.state += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  rng.state = rng.state >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** @returns {number} integer in [1, 6] */
function rollDie(rng) {
  return Math.floor(next(rng) * 6) + 1;
}

/** Fisher-Yates. Returns a new shuffled array; does not mutate the input. */
function shuffle(rng, array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next(rng) * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

module.exports = { createRng, next, rollDie, shuffle };

})();
