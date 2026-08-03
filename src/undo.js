(function () {
/**
 * Undo: GameState.undoCheckpoint holds a single snapshot (not a stack --
 * see the JSDoc on GameState.undoCheckpoint in game-state.js for why one
 * slot is all that's ever needed). recordCheckpoint() is called at 3 confirmed moments: just before
 * rolling color/white dice (see setup.rollInitialColorDice, turn-flow.startRound), and once at the
 * start of each player's TURN regardless of whether anything rolls (added 2026-07-30, per user
 * feedback -- see main.js's render()). Leaf-level die-granting code (executor.grantOneDie) does NOT
 * record its own checkpoint (removed 2026-08-02 -- it used to, but conflicted with the turn-start
 * checkpoint whenever a die was granted mid-turn, e.g. AREA007's CHANGE((A,B,C),D): the mid-action
 * checkpoint would overwrite the turn-start one with a snapshot where the triggering placement had
 * already happened, so Undo could no longer revert the whole placement).
 */

'use strict';

const { cloneState } = require('./game-state');

/** Records the current state as the (single) undo checkpoint, overwriting any previous one. */
function recordCheckpoint(state) {
  const snapshot = cloneState(state);
  snapshot.undoCheckpoint = null; // don't let the snapshot recursively carry a stale copy of itself
  state.undoCheckpoint = snapshot;
}

/**
 * Restores state to the last recorded checkpoint, in place (mutates the
 * live `state` object's contents -- same caveat as executor.runProgram's
 * rollback: any reference into state's nested objects grabbed before this
 * call is stale afterward; re-fetch by id from `state`).
 */
function undo(state) {
  if (!state.undoCheckpoint) return { success: false, reason: 'NO_CHECKPOINT' };
  const checkpoint = state.undoCheckpoint;
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, checkpoint);
  return { success: true };
}

module.exports = { recordCheckpoint, undo };

})();
