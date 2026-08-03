(function () {
'use strict';

/**
 * GameRunner: orchestrates a full game (setup -> round 1 onboarding -> all 4 rounds -> GAME_END)
 * using one AIPlayer per seat. Deliberately separate from AIPlayer itself (which only picks one move
 * at a time, see its own doc) -- this is "how a whole turn/game gets driven", not "what move is best".
 *
 * Onboarding (resource card choice / JOB draft / CON face choice) isn't a MoveGenerator/AIPlayer
 * decision at all -- those are one-off setup.js calls with their own shapes, not moves in an ongoing
 * turn. Chosen genuinely at random here (2026-08-03, corrected from the original "simulate every
 * option, highest Evaluator.score wins" -- per the user: "初期資源、CON、JOBは現状は完全ランダムで
 * お願いします そのうち評価値を入れます") since RESOURCE/CON/JOB have no real eval-table values yet, so
 * scoring them was really just measuring each option's immediate ONCE-granted resources, not a
 * genuine preference -- and the whole point of this game-runner's history log is to gather CON x JOB
 * outcome data to fill those eval-table values in later, which requires actually seeing every
 * combination played, not the AI narrowing itself to whichever option happens to score highest by a
 * still-incomplete metric. Uses state.rng (never Math.random()) so games stay fully reproducible from
 * their seed, same as every other random choice in this project. Once real RESOURCE/CON/JOB eval-table
 * values exist, this should go back to the simulate-and-score pattern AIPlayer/MoveGenerator still use
 * for actual turn-by-turn Moves (unaffected by this change).
 */

const rng = require('../rng');
const setup = require('../setup');
const turnFlow = require('../turn-flow');
const qst = require('../qst');
const scoring = require('../scoring');

/** Runs setup steps 1-7 (players/board/shops/dice/CON+RESOURCE dealing) through computeStartOrder,
 * picking each player's 2 kept RESOURCE cards uniformly at random (see this module's own doc). Does
 * not touch JOB/CON face choice yet (round-1 onboarding, driven turn-by-turn in playGame). */
function setupGame(seed, playerNames, index, evaluator) {
  const { createEmptyGameState } = require('../game-state');
  const state = createEmptyGameState(seed);
  setup.createPlayers(state, playerNames);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  setup.dealConCards(state);
  setup.dealResourceCandidates(state, index);
  for (const player of state.players) {
    const choice = state.pendingChoices.find((c) => c.playerId === player.id);
    const pair = rng.shuffle(state.rng, choice.context.candidates).slice(0, 2);
    setup.chooseResourceCards(state, player.id, pair);
  }
  setup.computeStartOrder(state, index);
  qst.setupQuests(state);
  return state;
}

/** Round-1-only: JOB draft (from state.jobPool) + CON face choice + receiveInitialResources for one
 * player, both picked uniformly at random (see this module's own doc). */
function driveOnboarding(state, index, playerId, evaluator) {
  const jobFaceId = state.jobPool[Math.floor(rng.next(state.rng) * state.jobPool.length)];
  setup.chooseJob(state, index, playerId, jobFaceId);

  const face = rng.next(state.rng) < 0.5 ? 'A' : 'B';
  setup.chooseConFace(state, index, playerId, face);

  setup.receiveInitialResources(state, index, playerId);
}

/** Drives playerId through their entire current turn (repeated AIPlayer.selectMove + apply, until
 * END_TURN or no legal moves) -- mutates `state` in place, one real move at a time, same as a human
 * clicking through the UI. Returns the moves actually taken (for history logging -- e.g. the caller
 * can scan for the first successful PLACE_DIE-with-a-BUILD_NEW-result to log "first card built").
 *
 * initialHasPlacedDieThisTurn lets a caller resume a turn that's still open (turnFlow.getNextTurn keeps
 * returning the same playerId because turnFlow.endTurn hasn't succeeded yet -- e.g. blocked by
 * RESOURCE_TOTAL_LIMIT, see executor.canEndTurn) without re-allowing a second PLACE_DIE. GameState
 * itself has no "already placed a die this still-open turn" field (same as main.js's UI-only
 * turnActionTaken flag, see main.js's own doc) -- the caller (playGame) is responsible for tracking and
 * passing this forward across repeated TURN dispatches to the same player. */
function driveTurn(state, index, playerId, aiPlayer, initialHasPlacedDieThisTurn) {
  const { applyInPlace } = require('./simulator');
  let hasPlacedDieThisTurn = !!initialHasPlacedDieThisTurn;
  const movesTaken = [];
  const MAX_MOVES = 50; // safety valve against a runaway/looping bug, not a real game limit
  while (movesTaken.length < MAX_MOVES) {
    const move = aiPlayer.selectMove(state, playerId, { hasPlacedDieThisTurn });
    if (!move) break;
    const result = applyInPlace(state, index, move);
    if (!result.success) break; // defensive -- selectMove only offers moves MoveGenerator pre-validated
    movesTaken.push({ move, result });
    if (move.type === 'PLACE_DIE' || move.type === 'PASS_DIE') hasPlacedDieThisTurn = true;
    if (move.type === 'END_TURN') break;
  }
  return movesTaken;
}

/**
 * Plays one full game from scratch to GAME_END using aiPlayersByPlayerId (one AIPlayer per seat, all
 * sharing the same Evaluator so onboarding/turn decisions are consistent). Returns
 * {state, historyByPlayerId, roundDetailByPlayerId}.
 *
 * historyByPlayerId[playerId] = {conFaceId, jobFaceId, firstRound1BuildFaceId, round1DDiceGained,
 * finalScore} -- exactly the 5 fields the user asked for as the human-facing log (2026-08-01: "IDでCON
 * JOB 1R目に建築したはじめのカード 1R目に手に入れた色D 最終得点"). Never add fields here -- per the
 * user's own instruction ("それ以外の情報はいまのところ人間側には不要です"), extra data belongs in
 * roundDetailByPlayerId instead.
 *
 * roundDetailByPlayerId[playerId] = {buildsByRound: {1:[faceId,...], 2:[...], 3:[...], 4:[...]},
 * colorDiceGainedByRound: {1:n, 2:n, 3:n, 4:n}} -- AI-side data the human log doesn't need but
 * tools/ai_data_report.js does, to fill in AI.DATA.xlsx's ABCM sheet (per-round build counts/average
 * scores for every card face, not just round 1's first build). buildsByRound lists every face actually
 * built/upgraded-into that round (BUILD_NEW's own faceId, or UPGRADE's toFaceId -- see
 * simulator.js's candidate field, added 2026-08-03 specifically so this can tell BUILD_NEW and UPGRADE
 * apart without re-deriving it from buildResult, which doesn't carry a faceId for UPGRADE at all).
 *
 * aiOptions (2026-08-04, optional, default undefined -- i.e. AIPlayer's own default of
 * lookaheadExtraTurns:0/"LV1"): passed straight through to every seat's AIPlayer constructor, e.g.
 * {lookaheadExtraTurns:1} for "LV2" (main.js's aiPlayerLv2 uses the exact same option). Left undefined
 * by every existing caller (tools/ai_batch_run.js's default CLI usage) so this stays the fast LV1-
 * equivalent behavior unless a caller opts in -- see ai-player.js's own doc for why the *class* default
 * stays cheap.
 */
function playGame(seed, playerNames, index, evalTable, aiOptions) {
  const { Evaluator } = require('./evaluator');
  const { MoveGenerator } = require('./move-generator');
  const { Simulator } = require('./simulator');
  const { AIPlayer } = require('./ai-player');

  const evaluator = new Evaluator(index, evalTable);
  const moveGenerator = new MoveGenerator();
  const simulator = new Simulator();
  const aiPlayersByPlayerId = {};

  const state = setupGame(seed, playerNames, index, evaluator);
  for (const player of state.players) {
    aiPlayersByPlayerId[player.id] = new AIPlayer(index, moveGenerator, evaluator, simulator, aiOptions);
  }

  const round1ColorDiceBefore = {};
  const buildsByRound = {};
  const colorDiceCountAtRoundStart = {};
  const colorDiceGainedByRound = {};
  for (const player of state.players) {
    round1ColorDiceBefore[player.id] = player.dice.filter((d) => d.kind === 'COLOR').length;
    buildsByRound[player.id] = { 1: [], 2: [], 3: [], 4: [] };
    colorDiceGainedByRound[player.id] = { 1: 0, 2: 0, 3: 0, 4: 0 };
    colorDiceCountAtRoundStart[player.id] = round1ColorDiceBefore[player.id];
  }
  const round1ColorDiceAfter = {};
  const firstRound1BuildFaceId = {};

  turnFlow.startRound(state);
  setup.dealJobPool(state);

  // Round transitions actually happen *inside* driveTurn (applyInPlace's END_TURN case calls
  // turnFlow.endRound/startRound itself, same as main.js's UI does) -- getNextTurn() in this outer
  // loop essentially never observes ROUND_OVER directly (by the time control returns here, whichever
  // move ended the round already advanced state.round/started the next one). round1EndCaptured tracks
  // whether we've already snapshotted post-round-1 dice counts, checked right after every driveTurn
  // call since that's the only place the round-1->2 transition can actually happen.
  let round1EndCaptured = false;
  // Tracks "has this player already placed their die for the turn that's still open" across repeated
  // TURN dispatches to the same playerId (getNextTurn returns the same player again whenever their
  // endTurn hasn't actually succeeded yet, e.g. blocked by RESOURCE_TOTAL_LIMIT) -- reset once a
  // different player becomes current, or once this player's turn actually ends. See driveTurn's own doc.
  let openTurnPlayerId = null;
  let openTurnHasPlacedDie = false;
  const MAX_ITERATIONS = 2000; // safety valve
  let iterations = 0;
  while (state.phase !== 'GAME_END' && iterations < MAX_ITERATIONS) {
    iterations++;
    const next = turnFlow.getNextTurn(state);
    if (next.type === 'ROUND_OVER') {
      // Defensive fallback (see this block's comment above) -- not expected to fire in practice.
      turnFlow.endRound(state, index);
      if (state.phase !== 'GAME_END') turnFlow.startRound(state);
      openTurnPlayerId = null;
      continue;
    }
    if (next.type === 'ONBOARDING_NEEDED') {
      driveOnboarding(state, index, next.playerId, evaluator);
      continue;
    }
    // next.type === 'TURN'
    const roundBeforeTurn = state.round;
    const initialHasPlacedDie = next.playerId === openTurnPlayerId ? openTurnHasPlacedDie : false;
    const moves = driveTurn(state, index, next.playerId, aiPlayersByPlayerId[next.playerId], initialHasPlacedDie);
    const endedTurn = moves.some((m) => m.move.type === 'END_TURN' && m.result.success);
    if (endedTurn || state.round > roundBeforeTurn) {
      openTurnPlayerId = null;
    } else {
      openTurnPlayerId = next.playerId;
      openTurnHasPlacedDie = initialHasPlacedDie || moves.some((m) => (m.move.type === 'PLACE_DIE' || m.move.type === 'PASS_DIE') && m.result.success);
    }
    // Re-checks every round-1 turn for this player (not just their first) until a build is actually
    // found -- a player typically gets *several* separate turns during round 1 (one per die, per
    // "1ターン＝ダイス1個の配置"), so their first build easily happens on turn 2, 3, etc., not
    // necessarily turn 1.
    if (roundBeforeTurn === 1 && (firstRound1BuildFaceId[next.playerId] === undefined || firstRound1BuildFaceId[next.playerId] === 'NONE')) {
      const build = moves.find((m) => m.move.buildCandidateIndex !== undefined && m.result.success && m.result.buildResult && m.result.buildResult.physicalId);
      firstRound1BuildFaceId[next.playerId] = build ? state.cards[build.result.buildResult.physicalId].currentFaceId : 'NONE';
    }
    // Every build/upgrade this turn, for every round (not just round 1's first) -- see this function's
    // own doc on why candidate (not buildResult) is the reliable source of the resulting faceId.
    for (const m of moves) {
      if (m.move.buildCandidateIndex === undefined || !m.result.success || !m.result.candidate) continue;
      const c = m.result.candidate;
      const faceId = c.type === 'BUILD_NEW' ? c.faceId : c.toFaceId;
      buildsByRound[next.playerId][roundBeforeTurn].push(faceId);
    }
    if (!round1EndCaptured && roundBeforeTurn === 1 && state.round > 1) {
      for (const player of state.players) {
        round1ColorDiceAfter[player.id] = player.dice.filter((d) => d.kind === 'COLOR').length;
      }
      round1EndCaptured = true;
    }
    // Color-dice-gained accounting, generalized to every round (round1ColorDiceBefore/After above stay
    // as the original round-1-only fields historyByPlayerId exposes; this is the same idea per round).
    // Dice counts are monotonically non-decreasing across a game (nothing ever removes an owned die),
    // so "gained this round" is always current-count-so-far minus whatever it was at this round's start.
    if (state.round > roundBeforeTurn) {
      for (const player of state.players) {
        const countNow = player.dice.filter((d) => d.kind === 'COLOR').length;
        colorDiceGainedByRound[player.id][roundBeforeTurn] = countNow - colorDiceCountAtRoundStart[player.id];
        colorDiceCountAtRoundStart[player.id] = countNow;
      }
    }
  }
  // Final round's gains never get captured by the "state.round > roundBeforeTurn" check above (there's
  // no round 5 to transition into) -- captured once more here after the loop exits.
  for (const player of state.players) {
    const countNow = player.dice.filter((d) => d.kind === 'COLOR').length;
    colorDiceGainedByRound[player.id][state.round] = countNow - colorDiceCountAtRoundStart[player.id];
  }

  const rankings = scoring.rankPlayers(state, index);
  const scoreByPlayerId = {};
  for (const r of rankings) scoreByPlayerId[r.playerId] = r.score;

  const historyByPlayerId = {};
  const roundDetailByPlayerId = {};
  for (const player of state.players) {
    historyByPlayerId[player.id] = {
      conFaceId: `${player.conPhysicalId}${player.conFace}`,
      jobFaceId: player.jobCardId,
      firstRound1BuildFaceId: firstRound1BuildFaceId[player.id] || 'NONE',
      round1DDiceGained: (round1ColorDiceAfter[player.id] || 0) - round1ColorDiceBefore[player.id],
      finalScore: scoreByPlayerId[player.id],
    };
    roundDetailByPlayerId[player.id] = {
      buildsByRound: buildsByRound[player.id],
      colorDiceGainedByRound: colorDiceGainedByRound[player.id],
      finalScore: scoreByPlayerId[player.id],
    };
  }

  return { state, historyByPlayerId, roundDetailByPlayerId };
}

module.exports = { setupGame, driveOnboarding, driveTurn, playGame };

})();
