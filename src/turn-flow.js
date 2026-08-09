(function () {
/**
 * Turn-flow controller: orchestrates ROUND_START -> (round-1 onboarding
 * interleaved with normal turns) -> TURNEND -> ROUND_END across all 4
 * rounds, on top of setup.js/board.js/executor.js. This is the "who acts
 * next, and what phase are we in" layer; it does not itself decide what a
 * player should do (that's a future AI, or a human via UI).
 *
 * Round-1 onboarding sequencing (confirmed, [[project-dice-wp-flow-spec]]
 * steps 9-12): P1 onboards then takes turn 1, then P2 onboards then takes
 * turn 1, ... through P4, and only after that does normal round-robin
 * (everyone's turn 2+) begin. getNextTurn() surfaces this by returning
 * ONBOARDING_NEEDED for a player whose jobCardId is still null while
 * round === 1.
 *
 * Round-2+ turn order (confirmed 2026-07-29, "城への再配置"): recomputed
 * from the castle (MAP008)'s dice at endRound() via
 * computeNextRoundTurnOrder() -- see that function for the algorithm.
 *
 * Dice rolling (confirmed 2026-07-29): white dice are rolled exactly once,
 * the instant they're gained, and never rerolled again -- carried over
 * unchanged round to round (see executor.js's grantOneDie, which handles
 * this at the point of grant, not here). Color dice, by contrast, are ALL
 * rerolled in bulk at the end of every round -- EXCEPT round 4 (no round 5
 * to prepare dice for). See rerollColorDice()/endRound() below.
 */

'use strict';

const { rollDie } = require('./rng');
const { getAreaRow } = require('./data-loader');
const { getSlotRequirements, restockShop, CASTLE_MAP_ID } = require('./board');
const { recordCheckpoint } = require('./undo');
const setup = require('./setup');
// Named executorApi, not executor, just to disambiguate from board.js's own `const executor` at a
// glance when reading these files side by side (see qst.js's matching import). Purely a local
// binding name; module.exports is unaffected. (Each src/*.js file's top-level scope is isolated in
// the browser build via its own IIFE wrapper -- see index.html's comment -- so this no longer
// affects correctness, only readability.)
const executorApi = require('./executor');
const qst = require('./qst');

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

/** Re-rolls every COLOR die a player currently owns, in place. Records the pre-roll undo checkpoint. */
function rerollColorDice(state) {
  recordCheckpoint(state);
  for (const player of state.players) {
    for (const die of player.dice) if (die.kind === 'COLOR') die.value = rollDie(state.rng);
  }
}

/**
 * Advances state.round and prepares that round's board: reveals the special
 * shop at round 2 (SHOP sheet's ROUND_MIN=2). Does NOT roll dice -- color
 * dice are rerolled at the *end* of the previous round (see endRound()),
 * and white dice are never bulk-rerolled at all (rolled once on grant, see
 * executor.js's grantOneDie). Does not touch turnOrder or
 * currentPlayerIndex -- call this once, then drive play via
 * getNextTurn()/endTurn()/endRound().
 */
function startRound(state) {
  state.round += 1;
  state.phase = 'ROUND';
  if (state.round === 2) setup.revealSpecialShop(state);
  return state.round;
}

/** True once every player has placed or passed every die they currently hold (2026-08-03: a passed
 * die -- see board.passDie -- counts as resolved here the same way a placed one does, so a die with no
 * legal slot, or one the player simply doesn't want to use, can't deadlock the round). */
function isRoundOver(state) {
  return state.players.every((p) => p.dice.every((d) => d.placedMapId !== null || d.passed));
}

/**
 * What should happen next: an onboarding step (round 1 only, before that
 * player's first turn), a normal turn, or ROUND_OVER. Pure -- does not
 * mutate state. Scans from state.currentPlayerIndex forward (cyclically),
 * skipping players with no unplaced-and-unpassed dice left this round.
 */
function getNextTurn(state) {
  if (isRoundOver(state)) return { type: 'ROUND_OVER' };
  const n = state.turnOrder.length;
  for (let i = 0; i < n; i++) {
    const idx = (state.currentPlayerIndex + i) % n;
    const playerId = state.turnOrder[idx];
    const player = state.players.find((p) => p.id === playerId);
    if (!player.dice.some((d) => d.placedMapId === null && !d.passed)) continue;
    if (state.round === 1 && player.jobCardId === null) {
      return { type: 'ONBOARDING_NEEDED', playerId, playerIndex: idx };
    }
    return { type: 'TURN', playerId, playerIndex: idx };
  }
  return { type: 'ROUND_OVER' };
}

/**
 * Resolves a player's TURNEND and advances the turn cursor. Fails without
 * mutating anything if RESOURCE_TOTAL_LIMIT blocks TURNEND (see
 * executorApi.canEndTurn) -- the caller must fix that first (e.g. via a free
 * action, per the confirmed insertion-timing rule) and call this again.
 * Compacts (and, for M/NORMAL, restocks) every shop row (confirmed: still only at TURNEND, see
 * restockShop's own doc -- 2026-08-07 added SPECIAL here too, since it now also compacts/shifts left on
 * a build even though it still never refills).
 */
function endTurn(state, index, playerId) {
  const gate = executorApi.canEndTurn(state, index, playerId);
  if (!gate.ok) return { success: false, reason: 'BLOCKED_BY_RESOURCE_TOTAL_LIMIT', violations: gate.violations };

  executorApi.applyTurnEnd(state, index, playerId);
  restockShop(state, 'M');
  restockShop(state, 'NORMAL');
  restockShop(state, 'SPECIAL');

  const idx = state.turnOrder.indexOf(playerId);
  state.currentPlayerIndex = (idx + 1) % state.turnOrder.length;
  return { success: true };
}

/**
 * Next round's turn order, from the castle's (MAP008) dice this round
 * (confirmed 2026-07-29, "城への再配置"): for each player, find their
 * *last* (highest seq) castle placement that counts toward turn order
 * (countsForTurnOrder -- excludes GRANT_PLACE_ANYWHERE-forced placements
 * into an occupied slot). Players are ordered by recency of that last
 * placement, most recent first. Players who placed no counting die at the
 * castle this round keep their relative order from the *current*
 * state.turnOrder, appended after everyone who did place.
 *
 * Worked example (confirmed): castle placements in order Red, Green, Green,
 * Red (only those two colors ever placed there) -> new order is [Red,
 * Green, <Blue-or-Yellow in their old relative order>, <the other one>],
 * because Red's last placement (the 2nd Red) came after Green's last
 * placement (the 2nd Green).
 */
function computeNextRoundTurnOrder(state) {
  const castle = state.maps[CASTLE_MAP_ID];
  const lastSeqByPlayer = {};
  for (const occupants of castle.slots) {
    for (const occ of occupants) {
      if (!occ.countsForTurnOrder) continue;
      if (!(occ.playerId in lastSeqByPlayer) || occ.seq > lastSeqByPlayer[occ.playerId]) {
        lastSeqByPlayer[occ.playerId] = occ.seq;
      }
    }
  }
  const participants = Object.keys(lastSeqByPlayer).sort((a, b) => lastSeqByPlayer[b] - lastSeqByPlayer[a]);
  const nonParticipants = state.turnOrder.filter((id) => !(id in lastSeqByPlayer));
  return [...participants, ...nonParticipants];
}

/**
 * Recomputes turnOrder from the castle (see computeNextRoundTurnOrder, only
 * meaningful for rounds 1-3 -- there's no "round 5" to prepare, so this is
 * skipped once state.round hits 4, leaving state.turnOrder as the actual
 * final-round order for scoring.js's tie-break), returns all placed COLOR
 * dice to hand -- but a placed WHITE die is disposable (confirmed
 * 2026-08-09): once actually placed on a SLOT it is discarded for good
 * (removed from player.dice entirely) rather than returned, so it never
 * comes back next round even unrolled. A WHITE die merely *passed* on (never
 * placed this round) is untouched, same as before, and remains available
 * next round. Also clears every map's slots (recomputed from each map's *current*
 * AREA, in case a tier flip changed the slot layout since last round),
 * grants 3K for every still-unplaced COLOR die (confirmed 2026-07-29: a
 * color die a player chose not to place this round auto-resolves to 3K,
 * which is what makes it "used" -- every color die is collected and
 * rerolled the same way by round's end, whether it was actually placed or
 * fell back to this), re-rolls every COLOR die in bulk (skipped after round
 * 4, the one confirmed exception, since there's no next round to prepare
 * for; white dice are never re-rolled here at all, see the module doc), and
 * untaps every free action *and every card* (confirmed 2026-08-01: "ラウンド
 * 終了時ダイスを回収するときに全てのカードはUNTAPします" -- previously only
 * free actions were untapped here, leaving any card with no TURNEND=UNTAP()
 * of its own, e.g. C004A's bare TAP=ADD(K), stuck tapped forever after a
 * single use instead of being usable again every round). Call once
 * getNextTurn() reports ROUND_OVER. Does not advance state.round -- call
 * startRound() next for round 2+.
 */
function endRound(state, index) {
  if (state.round < 4) state.turnOrder = computeNextRoundTurnOrder(state);

  for (const player of state.players) {
    for (const die of player.dice) {
      // placedMapId===null covers both a genuinely-unplaced die and a passed one (2026-08-03, see
      // board.passDie) -- passing never sets placedMapId, only the separate `passed` flag, so this
      // check (and thus the 3K grant) already applies to both without any change needed here.
      if (die.kind === 'COLOR' && die.placedMapId === null) {
        executorApi.grantResourceAndEmitGet(state, index, { playerId: player.id }, 'K', 3);
      }
    }
  }
  for (const player of state.players) {
    player.dice = player.dice.filter((die) => {
      // A placed WHITE die is disposable (confirmed 2026-08-09): it's discarded here rather than
      // returned to hand, unlike a placed COLOR die (still returned/rerolled below) or a WHITE die
      // that was merely passed on -- placedMapId===null -- which is untouched and stays available.
      if (die.kind === 'WHITE' && die.placedMapId !== null) return false;
      die.placedMapId = null;
      die.passed = false;
      return true;
    });
  }
  for (const map of Object.values(state.maps)) {
    const areaRow = getAreaRow(index, map.currentAreaId);
    map.slots = Array.from({ length: getSlotRequirements(areaRow).length }, () => []);
  }
  executorApi.resetFreeActionsForNewRound(state);
  for (const cardState of Object.values(state.cards)) cardState.tapped = false;
  state.currentPlayerIndex = 0;
  if (state.round < 4) rerollColorDice(state);
  if (state.round >= 4) {
    state.phase = 'GAME_END';
    // QST's rank-based rewards (2026-08-09, see qst.js's own doc) settle exactly here, exactly once --
    // nothing after this point can trigger another round-4 endRound (the game loop stops advancing
    // turns once phase is GAME_END, both in main.js's UI and src/ai/game-runner.js), so this needs no
    // idempotency guard.
    qst.resolveEndGameRewards(state, index);
  }
}

module.exports = {
  rerollColorDice,
  startRound,
  isRoundOver,
  getNextTurn,
  endTurn,
  computeNextRoundTurnOrder,
  endRound,
};

})();
