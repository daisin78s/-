/**
 * Shared reconstruction logic for tools/analyze_human_replay.js and tools/train_from_human_replay.js
 * (factored out 2026-09-07 while fixing a real bug -- see reconstructDecision's own doc).
 *
 * A main.js-exported replay is an array of GameState snapshots, one per real mutation, with no Move
 * object recorded alongside. Reconstructing "what did playerId actually decide here" means generating
 * every legal candidate Move and applying each until one produces the exact next snapshot.
 */

'use strict';

const { applyInPlace } = require('../../src/ai/simulator');

/** Every legal move for playerId at `state` under both possible hasPlacedDieThisTurn values (that flag
 * isn't itself part of GameState -- see move-generator.js's own context param), tagged with which
 * context produced it. */
function candidatesForBothContexts(moveGenerator, state, index, playerId) {
  const out = [];
  for (const hasPlacedDieThisTurn of [false, true]) {
    for (const move of moveGenerator.generateMoves(state, index, playerId, { hasPlacedDieThisTurn })) {
      out.push({ move, hasPlacedDieThisTurn });
    }
  }
  return out;
}

const MAX_LOOKAHEAD = 4;

/**
 * Reconstructs playerId's ONE real decision starting at replay[i], returning
 * {consumedSteps, move, hasPlacedDieThisTurn} or null if nothing matches within the search window.
 *
 * Bug fixed 2026-09-06 (per user report: a placement that opens a BUILD candidate choice -- e.g. at
 * 王宮/元老院 -- is TWO separate real-game actions, not one: (1) placing the die, which alone already
 * mutates GameState and gets its own recorded snapshot, THEN (2) clicking a candidate in the resulting
 * modal, a SEPARATE mutation/snapshot (main.js's own pendingBuildChoice, deliberately NOT part of
 * GameState -- see its own doc). main.js confirms there is no decline/cancel affordance once a BUILD
 * area triggers with >=1 real candidate -- choosing one is mandatory. The original version of this
 * function matched step (1)'s own intermediate, build-still-pending state directly against
 * MoveGenerator's own "PLACE_DIE, leave the build unresolved" candidate (offered there ONLY as an
 * AI-side fallback for when every candidate turns out unaffordable -- see move-generator.js's own doc)
 * and treated that as the complete, final decision -- silently misreading "hasn't clicked yet" as "chose
 * not to build", even though declining was never actually possible. Fixed by refusing to accept a
 * no-buildCandidateIndex match whenever the dry-run actually returned a pendingBuild (real candidates
 * existed), and instead searching forward, up to MAX_LOOKAHEAD replay steps, for whichever
 * buildCandidateIndex-carrying sibling of that same base move reproduces a LATER snapshot exactly --
 * that combined (placement + the build actually chosen) is the true, single real decision, consuming
 * more than 1 replay step. If no such resolution is found in the window, this returns null (the caller
 * counts it as unreconstructable) rather than guessing.
 */
function reconstructDecision(replay, i, moveGenerator, index, playerId) {
  const state = replay[i];
  const candidates = candidatesForBothContexts(moveGenerator, state, index, playerId);
  for (const candidate of candidates) {
    const clone = structuredClone(state);
    let result;
    try { result = applyInPlace(clone, index, candidate.move); } catch (e) { continue; }
    if (!result.success) continue;
    const hasPendingBuild = !!(result.actionResult && result.actionResult.pendingBuild);
    if (candidate.move.buildCandidateIndex === undefined && hasPendingBuild) continue; // see this file's own doc
    for (let steps = 1; steps <= MAX_LOOKAHEAD && i + steps < replay.length; steps++) {
      if (JSON.stringify(clone) === JSON.stringify(replay[i + steps])) {
        return { consumedSteps: steps, move: candidate.move, hasPlacedDieThisTurn: candidate.hasPlacedDieThisTurn };
      }
    }
  }
  return null;
}

module.exports = { candidatesForBothContexts, reconstructDecision };
