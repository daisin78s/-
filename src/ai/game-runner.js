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
const executor = require('../executor');

/** Maps a MAP id to the one A-deck face whose ONCE assigns that MAP's CURRENT_AREA (confirmed via
 * data/game.json: only A001A-A008A do this -- B/C decks' tier-A ONCE effects are unrelated, e.g. wD
 * grants or nothing at all). Used by playGame's "使用回数" fee-tracking below (2026-08-07, per user
 * spec: "Aカードは該当AREAで得た使用料の合計です アップグレードしたあとに得た資源も含みます") to
 * attribute a COLLECT_FEE move's amount back to the specific A-card that made the player that MAP's
 * feeOwnerId in the first place -- static and tier-independent (upgrading to A00NB/C never changes which
 * MAP it governs or who owns it, only the tier), so this one table covers a card's whole game lifetime. */
const AREA_CARD_BY_MAP = {
  MAP003: 'A001A', MAP004: 'A002A', MAP005: 'A003A', MAP010: 'A004A',
  MAP001: 'A005A', MAP002: 'A006A', MAP006: 'A007A', MAP009: 'A008A',
};

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
    // UNTAP_CHOICE (2026-08-15, see executor.runUntapChoice's own doc): C004B/C005B/C006B/C007B/
    // C008A/C008B's ONCE effect queues this pendingChoice instead of resolving immediately whenever the
    // player's tapped cards' combined weight exceeds the budget -- nothing else in this loop (or
    // MoveGenerator's own move list) ever surfaces or gates on it, so it must be resolved right here or
    // it would sit in state.pendingChoices forever, silently never granting its own benefit. Random
    // pick, matching this whole module's existing policy for choices with no eval-table weight yet (see
    // setupGame's own RESOURCE-choice pick, same reasoning). Since 2026-08-17 this is a weighted budget,
    // not a flat count (see executor.untapChoiceWeight's own doc), so candidates are shuffled and
    // greedily added while they still fit the remaining budget, rather than just slicing the first
    // `count` of them.
    const untapChoice = state.pendingChoices.find((c) => c.playerId === playerId && c.kind === 'UNTAP_CHOICE');
    if (untapChoice) {
      const { candidates, weights, count } = untapChoice.context;
      const picked = [];
      let usedWeight = 0;
      for (const id of rng.shuffle(state.rng, candidates)) {
        if (usedWeight + weights[id] <= count) {
          picked.push(id);
          usedWeight += weights[id];
        }
      }
      executor.resolveUntapChoice(state, playerId, picked);
    }
    if (move.type === 'PLACE_DIE' || move.type === 'PASS_DIE') hasPlacedDieThisTurn = true;
    if (move.type === 'END_TURN') break;
  }
  return movesTaken;
}

/**
 * Plays one full game from scratch to GAME_END using aiPlayersByPlayerId (one AIPlayer per seat, all
 * sharing the same Evaluator so onboarding/turn decisions are consistent). Returns
 * {state, historyByPlayerId, roundDetailByPlayerId, activationCounts}.
 *
 * historyByPlayerId[playerId] = {conFaceId, jobFaceId, firstRound1BuildFaceId, round1DDiceGained,
 * finalScore} -- exactly the 5 fields the user asked for as the human-facing log (2026-08-01: "IDでCON
 * JOB 1R目に建築したはじめのカード 1R目に手に入れた色D 最終得点"). Never add fields here -- per the
 * user's own instruction ("それ以外の情報はいまのところ人間側には不要です"), extra data belongs in
 * roundDetailByPlayerId instead.
 *
 * roundDetailByPlayerId[playerId] = {buildsByRound: {1:[faceId,...], 2:[...], 3:[...], 4:[...]},
 * colorDiceGainedByRound: {1:n, 2:n, 3:n, 4:n}, areaFeeByRoundAndCard: {1:{faceId:amount,...}, ...},
 * job008BonusVp: n|null, finalScore: n, qstScore: n} -- AI-side data the human log doesn't need but
 * tools/ai_data_report.js does, to fill in AI.DATA.xlsx's ABCM/CONJOB sheets (2026-08-07, per user spec
 * for the "使用回数" columns; 2026-08-09, qstScore added for the new "QST平均得点" columns -- VP gained
 * from QST's rank-based rewards this game, see turn-flow.js's own comment on state.qstRewardsGranted --
 * so tools/ai_data_report.js can report both the existing "平均得点" metric with QST *excluded*
 * (finalScore - qstScore, per user request) and QST's own average separately, without re-deriving the
 * split itself. See the fields' own inline docs below for what each one means and how it's derived).
 * B008A's "使用回数" (LVUP success rate) and B008B's (天 emblem count at GAME_END) are NOT separate
 * fields here (2026-08-12, per user spec: "B008AはLVUPできたときの割合", "B008Bはゲーム終了時のエンブレム
 * 天の数") -- tools/ai_data_report.js derives both directly from the returned `state` and
 * buildsByRound/historyByPlayerId it already gets back from this function, so no new tracking was
 * needed here.
 *
 * activationCounts (2026-08-07, game-wide -- not per-player, since at most one player ever owns/builds
 * any single card face in one game, see AREA_CARD_BY_MAP's own doc for the same reasoning) = {faceId:
 * count} -- how many times each card's TAP or PASSIVE actually fired this game (per user spec: "使用回数
 * はTAPがあるJOB ABCカードはTAPした回数です TAPがないJOB006は発動した回数（資源内容問わない）"). Captured
 * via executor.setActivationListener, the only way to see AUTO-mode TAP reactions and PASSIVE reactions
 * at all -- neither produces a discrete Move (see executor.notifyActivation's own doc).
 *
 * buildsByRound lists every face actually built/upgraded-into that round (BUILD_NEW's own faceId, or
 * UPGRADE's toFaceId -- see simulator.js's candidate field, added 2026-08-03 specifically so this can
 * tell BUILD_NEW and UPGRADE apart without re-deriving it from buildResult, which doesn't carry a faceId
 * for UPGRADE at all).
 *
 * aiOptions (2026-08-04, optional, default undefined -- i.e. AIPlayer's own default of
 * lookaheadExtraTurns:0/"LV1"): passed straight through to every seat's AIPlayer constructor, e.g.
 * {lookaheadExtraTurns:1} for "LV2" (main.js's aiPlayerLv2 uses the exact same option). Left undefined
 * by every existing caller (tools/ai_batch_run.js's default CLI usage) so this stays the fast LV1-
 * equivalent behavior unless a caller opts in -- see ai-player.js's own doc for why the *class* default
 * stays cheap.
 *
 * moveGeneratorOptions (2026-08-09, optional, default undefined): passed straight through to the
 * single MoveGenerator instance every seat's AIPlayer shares, e.g. {avoidMapIdFromRound:{...}} for
 * "LV3" (main.js's aiMoveGeneratorLv3 uses the exact same option -- see MoveGenerator's own doc). Left
 * undefined by every existing caller so this stays policy-free (LV1/LV2-equivalent) unless a caller
 * opts in.
 *
 * evaluatorOptions (2026-08-10, optional, default undefined): passed straight through to the single
 * Evaluator instance every seat's AIPlayer shares, e.g. {qstAware:true} for "LV3" (main.js's
 * aiEvaluatorLv3 uses the exact same option -- see Evaluator's own doc). Left undefined by every
 * existing caller so this stays policy-free (LV1/LV2-equivalent) unless a caller opts in.
 *
 * levelByPlayerId (2026-08-10, optional, default undefined, for tools/ai_level_comparison.js's random
 * level-mix battles): {playerId: levelName} (levelName from src/ai/levels.js's LEVELS). When present,
 * OVERRIDES aiOptions/moveGeneratorOptions/evaluatorOptions entirely -- each player gets the AIPlayer
 * that levels.js's own entry for their assigned level describes, instead of every seat uniformly
 * sharing one. One (MoveGenerator, Evaluator) pair is built per DISTINCT level actually assigned this
 * game (not one per player), same sharing main.js does between its own LV1/LV2 (one policy-free
 * instance) and LV3 (its own). setupGame/driveOnboarding still just take the base, policy-free
 * `evaluator` regardless -- onboarding (JOB/CON/RESOURCE) is pure RNG (see this file's own doc), so
 * which Evaluator instance reaches it has never mattered. Every existing caller leaves this undefined,
 * so the uniform single-evaluator/moveGenerator behavior below is completely unaffected.
 */
function playGame(seed, playerNames, index, evalTable, aiOptions, moveGeneratorOptions, evaluatorOptions, levelByPlayerId) {
  const { Evaluator } = require('./evaluator');
  const { MoveGenerator } = require('./move-generator');
  const { Simulator } = require('./simulator');
  const { AIPlayer } = require('./ai-player');

  const evaluator = new Evaluator(index, evalTable, evaluatorOptions);
  const moveGenerator = new MoveGenerator(moveGeneratorOptions);
  const simulator = new Simulator();
  const aiPlayersByPlayerId = {};

  const state = setupGame(seed, playerNames, index, evaluator);
  if (levelByPlayerId) {
    const { getLevel } = require('./levels');
    const instancesByLevelName = new Map();
    for (const player of state.players) {
      const levelName = levelByPlayerId[player.id];
      if (!instancesByLevelName.has(levelName)) {
        const level = getLevel(levelName);
        instancesByLevelName.set(levelName, {
          evaluator: new Evaluator(index, evalTable, level.evaluatorOptions),
          moveGenerator: new MoveGenerator(level.moveGeneratorOptions),
          aiOptions: level.aiOptions,
        });
      }
      const lv = instancesByLevelName.get(levelName);
      aiPlayersByPlayerId[player.id] = new AIPlayer(index, lv.moveGenerator, lv.evaluator, simulator, lv.aiOptions);
    }
  } else {
    for (const player of state.players) {
      aiPlayersByPlayerId[player.id] = new AIPlayer(index, moveGenerator, evaluator, simulator, aiOptions);
    }
  }

  const round1ColorDiceBefore = {};
  const buildsByRound = {};
  const colorDiceCountAtRoundStart = {};
  const colorDiceGainedByRound = {};
  const areaFeeByPlayerAndCard = {}; // playerId -> {faceId: totalAmountThisGame}, see AREA_CARD_BY_MAP
  for (const player of state.players) {
    round1ColorDiceBefore[player.id] = player.dice.filter((d) => d.kind === 'COLOR').length;
    buildsByRound[player.id] = { 1: [], 2: [], 3: [], 4: [] };
    colorDiceGainedByRound[player.id] = { 1: 0, 2: 0, 3: 0, 4: 0 };
    colorDiceCountAtRoundStart[player.id] = round1ColorDiceBefore[player.id];
    areaFeeByPlayerAndCard[player.id] = {};
  }
  const round1ColorDiceAfter = {};
  const firstRound1BuildFaceId = {};

  // See this function's own doc on activationCounts -- registered for the duration of this one game
  // only, and always cleared in a finally below so a crash mid-game (or the next playGame() call in the
  // same process, e.g. tools/ai_data_report.js's own loop) never leaks a stale listener. Filters on
  // `receivedState === state` (see executor.notifyActivation's own doc, corrected 2026-08-07): AIPlayer/
  // Simulator score candidate moves by running this same code against throwaway cloneState(state) clones
  // -- without this check, every speculative, never-committed evaluation would count too, wildly
  // overcounting (confirmed while testing: JOB005 showed 2000+ "activations" in one 4-round game before
  // this filter was added).
  const activationCounts = {};
  executor.setActivationListener((receivedState, playerId, physicalId, faceId) => {
    if (receivedState !== state) return;
    activationCounts[faceId] = (activationCounts[faceId] || 0) + 1;
  });

  try {

  turnFlow.startRound(state);
  setup.dealJobPool(state, index);

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
    // Usage-fee collection, attributed to the A-deck card that made this player the fee owner in the
    // first place (2026-08-07, per user spec: "Aカードは該当AREAで得た使用料の合計です アップグレード
    // したあとに得た資源も含みます" -- summed across the whole game regardless of round, then matched to
    // whichever round buildsByRound says that card was actually built in, once the game ends below).
    for (const m of moves) {
      if (m.move.type !== 'COLLECT_FEE' || !m.result.success) continue;
      const cardFaceId = AREA_CARD_BY_MAP[m.move.mapId];
      if (!cardFaceId) continue; // defensive -- every real MAP with a fee-collectible AREA is in the table
      const byCard = areaFeeByPlayerAndCard[next.playerId];
      byCard[cardFaceId] = (byCard[cardFaceId] || 0) + m.result.amount;
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
  // VP actually gained from QST's rank-based rewards, per player (2026-08-09, see turn-flow.js's own
  // comment on where this gets set -- always populated by now, since this function only reaches here
  // once state.phase is GAME_END, which is exactly when endRound sets it). Exposed alongside finalScore
  // (which already includes it) so tools/ai_data_report.js can report both the existing "平均得点"
  // metric with QST *excluded* (per user request: "QSTカードなしの今までの得点で平均を出してください",
  // i.e. finalScore - qstScore) and a new QST-only "QST平均得点" metric, without either one needing to
  // re-derive the split itself.
  const qstScoreByPlayerId = state.qstRewardsGranted || {};

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
    // Which round each fee-generating A-card was built in (see AREA_CARD_BY_MAP's own doc) -- the same
    // buildsByRound this function already tracks for the ABCM sheet's own 試行回数/平均得点 columns, just
    // used here as a lookup instead of a list. A card whose fee total is nonzero but was never found in
    // buildsByRound (shouldn't happen -- collecting a fee requires having been feeOwnerId, which requires
    // having built or upgraded it) is defensively dropped rather than guessed at.
    const areaFeeByRoundAndCard = { 1: {}, 2: {}, 3: {}, 4: {} };
    for (const [cardFaceId, amount] of Object.entries(areaFeeByPlayerAndCard[player.id])) {
      const round = [1, 2, 3, 4].find((r) => buildsByRound[player.id][r].includes(cardFaceId));
      if (round) areaFeeByRoundAndCard[round][cardFaceId] = amount;
    }
    // JOB008's own bonus VP only (2026-08-07, per user spec: "JOB008は最終的に得たVP" -> clarified as
    // "JOB008自体のVP_MODIFIER効果で加算された分だけ", not the player's overall finalScore). 2026-08-17:
    // JOB008 switched from a live PASSIVE=VP_MODIFIER(TOTAL_EMBLEM_COUNT) formula to a real per-TURNEND
    // grant (see turn-flow.grantBardBonusIfEarned) -- player.bardEmblemUnitsGranted (1 unit = 1 VP, by
    // then fully caught up since every player's last turn has already gone through endTurn once GAME_END
    // is reached) is now the exact same number this used to compute by summing VP_MODIFIER clauses.
    const job008BonusVp = player.jobCardId === 'JOB008' ? player.bardEmblemUnitsGranted : null;
    roundDetailByPlayerId[player.id] = {
      buildsByRound: buildsByRound[player.id],
      colorDiceGainedByRound: colorDiceGainedByRound[player.id],
      areaFeeByRoundAndCard,
      job008BonusVp,
      finalScore: scoreByPlayerId[player.id],
      qstScore: qstScoreByPlayerId[player.id] || 0,
    };
  }

  return { state, historyByPlayerId, roundDetailByPlayerId, activationCounts };

  } finally {
    executor.setActivationListener(null);
  }
}

module.exports = { setupGame, driveOnboarding, driveTurn, playGame, AREA_CARD_BY_MAP };

})();
