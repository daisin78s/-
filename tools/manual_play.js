/**
 * Interactive driver (2026-09-06, per user request: "クロードコードさんが AI LV4 3体と対戦することは可能
 * ですか" -> "フルマニュアル" -> "クロードコードさんが何点くらいとれるか見てみたい") letting Claude Code
 * itself play one seat of a real game, turn by turn, against 3 AI-LV4-controlled opponents, by pausing at
 * every decision point that belongs to that one seat (RESOURCE card choice, JOB draft, CON face, every
 * die placement/free action/TAP/END_TURN during a TURN, and any UNTAP_CHOICE) instead of auto-picking it.
 * The 3 AI seats are driven automatically the whole way, reusing game-runner.js's own driveSmartOnboarding/
 * driveTurn exactly as tools/ai_data_report.js's own "AI LV4" games do (src/ai/levels.js's LV4 entry:
 * lookahead+round-4 deep search, qstAware/conBuildAware/monumentIncentiveAware evaluator, smart onboarding
 * via smart-onboarding.js's pickJob/pickConFace/pickResourceCards).
 *
 * User's own rules for this exercise (verbatim): initial setup (board/shop/dice/JOB pool/CON deal, i.e.
 * everything the FIXED_SEED below determines) never changes between attempts; any number of full retries
 * allowed; no hard time limit; wants the single highest-scoring attempt plus its full move-by-move replay
 * log; may also want to play the identical seed themselves afterward for comparison.
 *
 * Session state persists as plain JSON in <sessionDir>/session.json between CLI invocations (this process
 * exits after every command -- there is no long-running server). GameState itself is plain
 * structuredClone-able data (same assumption the rest of this codebase's checkpoint/undo/resume code
 * already relies on), so this is a direct JSON.stringify/parse round-trip, no custom serialization needed.
 *
 * Usage:
 *   node tools/manual_play.js new <sessionDir>                 -- start a fresh attempt from FIXED_SEED
 *   node tools/manual_play.js state <sessionDir>                -- reprint the current decision point
 *   node tools/manual_play.js choose <sessionDir> <value...>    -- resolve an onboarding/UNTAP_CHOICE pause
 *   node tools/manual_play.js act <sessionDir> <moveIndex>      -- apply move #moveIndex from a TURN pause
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex, getAreaRow, getCardRow } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { getLevel } = require('../src/ai/levels');
const { Evaluator } = require('../src/ai/evaluator');
const { MoveGenerator } = require('../src/ai/move-generator');
const { Simulator, applyInPlace } = require('../src/ai/simulator');
const { AIPlayer } = require('../src/ai/ai-player');
const gameRunner = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const setup = require('../src/setup');
const turnFlow = require('../src/turn-flow');
const qst = require('../src/qst');
const scoring = require('../src/scoring');
const executor = require('../src/executor');
const { createEmptyGameState } = require('../src/game-state');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');

// Fixed for every attempt, per the user's own rule ("一番初めに生成されたカードなどの初期配置は変えない").
// Never change this once attempts have started, or later attempts stop being comparable to earlier ones.
const FIXED_SEED = 'manual-challenge-2026-09-06';
const MY_PLAYER_ID = 'P1';
const PLAYER_NAMES = ['Claude', 'AI-2', 'AI-3', 'AI-4'];

function loadIndex() {
  const raw = loadGameData(DATA_PATH);
  return { raw, index: buildDataIndex(raw) };
}

function buildAiContext(raw, index) {
  const lv4 = getLevel('LV4');
  const evalTable = buildEvalTable(raw);
  const evaluator = new Evaluator(index, evalTable, lv4.evaluatorOptions);
  const moveGenerator = new MoveGenerator(lv4.moveGeneratorOptions);
  const simulator = new Simulator();
  const synergyTable3 = buildResourceSynergyTable(raw);
  const synergyTable2 = buildConJobSynergyTable(raw);
  const resourceCardPicker = (candidateIds, state, idx, player) =>
    pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);
  const aiPlayersByPlayerId = {};
  for (const playerId of ['P2', 'P3', 'P4']) {
    aiPlayersByPlayerId[playerId] = new AIPlayer(index, moveGenerator, evaluator, simulator, lv4.aiOptions);
  }
  return { evaluator, moveGenerator, simulator, synergyTable2, resourceCardPicker, aiPlayersByPlayerId };
}

function sessionPaths(sessionDir) {
  return { sessionFile: path.join(sessionDir, 'session.json'), logFile: path.join(sessionDir, 'log.txt') };
}

function appendLog(sessionDir, text) {
  fs.appendFileSync(sessionPaths(sessionDir).logFile, text + '\n');
}

function saveSession(sessionDir, session) {
  fs.writeFileSync(sessionPaths(sessionDir).sessionFile, JSON.stringify(session));
}

function loadSession(sessionDir) {
  return JSON.parse(fs.readFileSync(sessionPaths(sessionDir).sessionFile, 'utf8'));
}

/** Custom setup mirroring game-runner.js's own setupGame, except MY_PLAYER_ID's RESOURCE-card choice is
 * left as a genuine pending choice (see this module's own doc) instead of being auto-picked -- the other
 * 3 seats use LV4's own smart-onboarding resourceCardPicker exactly as tools/ai_data_report.js's real
 * LV4 games do. */
function customSetup(index, aiCtx) {
  const state = createEmptyGameState(FIXED_SEED);
  setup.createPlayers(state, PLAYER_NAMES);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  setup.rollInitialColorDice(state);
  setup.dealConCards(state);
  setup.dealJobPool(state, index);
  setup.dealResourceCandidates(state, index);
  for (const player of state.players) {
    if (player.id === MY_PLAYER_ID) continue;
    const choice = state.pendingChoices.find((c) => c.playerId === player.id && c.kind === 'SELECT_RESOURCE_CARDS');
    const pair = aiCtx.resourceCardPicker(choice.context.candidates, state, index, player);
    setup.chooseResourceCards(state, player.id, pair);
  }
  return state;
}

/** Runs state forward (AI seats auto-play; ROUND_OVER auto-transitions) until either MY_PLAYER_ID has a
 * real decision to make or the game ends. Returns a `{kind, ...}` pause descriptor -- see the CLI's own
 * `describePause` for how each kind gets rendered. Mutates `session` in place (state, aiOpenTurn,
 * myHasPlacedDieThisTurn, log entries) but never writes to disk itself -- callers save once, after this
 * returns, alongside whatever result info this decision point implies. */
function advanceUntilMyDecision(session, index, aiCtx) {
  const state = session.state;

  // RESOURCE choice happens before round 1 even starts -- resolved separately from the main TURN/
  // ONBOARDING_NEEDED loop below (setup.computeStartOrder/qst.setupQuests/turnFlow.startRound haven't run
  // yet at this point in a brand-new session).
  const myResourceChoice = state.pendingChoices.find((c) => c.playerId === MY_PLAYER_ID && c.kind === 'SELECT_RESOURCE_CARDS');
  if (myResourceChoice) return { kind: 'SELECT_RESOURCE_CARDS', choice: myResourceChoice };

  if (!session.roundStarted) {
    setup.computeStartOrder(state, index);
    qst.setupQuests(state);
    turnFlow.startRound(state);
    session.roundStarted = true;
    session.lastSeenRound = state.round;
  }

  // Self-healing reset for myHasPlacedDieThisTurn (found 2026-09-06, round 1->2 transition): once I've
  // placed my LAST unplaced die, turnFlow.getNextTurn simply stops dispatching TURN to me at all (its own
  // gate is "has ANY unplaced die", not "called END_TURN") -- there is no explicit END_TURN pause left to
  // reset this flag at, so a brand-new round's fresh dice were wrongly treated as "already placed this
  // turn" (MoveGenerator silently omitted every PLACE_WILDCARD_DIE option). Tracking the round number here
  // and resetting whenever it changes is robust regardless of how the previous round's own last turn ended.
  if (state.round !== session.lastSeenRound) {
    session.myHasPlacedDieThisTurn = false;
    session.lastSeenRound = state.round;
  }

  while (state.phase !== 'GAME_END') {
    // Any other pendingChoice of mine (PICK_JOB_REPLACEMENT, UNTAP_CHOICE -- e.g. 農夫) blocks
    // getNextTurn/generateMoves from offering anything at all until resolved, same as the real engine.
    const myPendingChoice = state.pendingChoices.find((c) => c.playerId === MY_PLAYER_ID);
    if (myPendingChoice) return { kind: myPendingChoice.kind, choice: myPendingChoice };

    // turn-flow.js's getNextTurn only ever gates ONBOARDING_NEEDED on jobCardId being null (see its own
    // doc) -- once JOB_CHOICE resolves, it reports TURN immediately even though CON_CHOICE/
    // receiveInitialResources haven't happened yet. Checked here, every iteration, rather than nested
    // inside the ONBOARDING_NEEDED branch below (which a real ONBOARDING_NEEDED dispatch for ME can only
    // ever reach once, while jobCardId is still null).
    const myPlayer = state.players.find((p) => p.id === MY_PLAYER_ID);
    if (myPlayer.jobCardId && !myPlayer.conFace) return { kind: 'CON_CHOICE' };

    // Mirrors game-runner.js's own driveTurn: once a turn is genuinely open for ME, it stays open (able
    // to BARE_TAP/free-action/END_TURN) across repeated CLI invocations regardless of whether I still
    // have an unplaced die -- turnFlow.getNextTurn's own gate is "has ANY unplaced die", so relying on it
    // alone would silently skip my last few in-turn actions the moment my last die is placed (found
    // 2026-09-06: a build's own TAP was never offered because control jumped straight to round-over).
    if (session.myTurnOpen) return { kind: 'TURN' };

    const next = turnFlow.getNextTurn(state);
    if (next.type === 'ROUND_OVER') {
      turnFlow.endRound(state, index);
      if (state.phase !== 'GAME_END') turnFlow.startRound(state);
      continue;
    }
    if (next.type === 'ONBOARDING_NEEDED') {
      if (next.playerId === MY_PLAYER_ID) return { kind: 'JOB_CHOICE' };
      gameRunner.driveSmartOnboarding(state, index, next.playerId, aiCtx.synergyTable2, aiCtx.moveGenerator, aiCtx.simulator);
      continue;
    }
    // next.type === 'TURN'
    if (next.playerId === MY_PLAYER_ID) {
      session.myTurnOpen = true;
      return { kind: 'TURN' };
    }
    const roundBeforeTurn = state.round;
    const initialHasPlacedDie = next.playerId === session.aiOpenTurn.playerId ? session.aiOpenTurn.hasPlacedDie : false;
    const moves = gameRunner.driveTurn(state, index, next.playerId, aiCtx.aiPlayersByPlayerId[next.playerId], initialHasPlacedDie);
    const endedTurn = moves.some((m) => m.move.type === 'END_TURN' && m.result.success);
    if (endedTurn || state.round > roundBeforeTurn) {
      session.aiOpenTurn = { playerId: null, hasPlacedDie: false };
    } else {
      session.aiOpenTurn = {
        playerId: next.playerId,
        hasPlacedDie: initialHasPlacedDie || moves.some((m) => ['PLACE_DIE', 'PLACE_WILDCARD_DIE', 'PLACE_DICE_GROUP', 'PASS_DIE'].includes(m.move.type) && m.result.success),
      };
    }
  }
  return { kind: 'GAME_END' };
}

function resourceName(index, id) {
  try { return getCardRow(index, id).NAME || id; } catch (e) { return id; }
}

function areaName(index, mapId, state) {
  const map = state.maps[mapId];
  const row = getAreaRow(index, map.currentAreaId);
  return `${mapId}:${row.NAME || map.currentAreaId}`;
}

function dieDesc(state, dieId) {
  for (const player of state.players) {
    const die = player.dice.find((d) => d.id === dieId);
    if (die) return `${die.kind}${die.wildcard ? '/☆' : ''} value=${die.value}`;
  }
  return dieId;
}

/** Human(Claude)-readable one-line summary of a legal Move -- special-cases the common types, falls back
 * to raw JSON for anything else (FREE_ACTION/TAP/fee-collection moves are rarer here and their own fields
 * are already self-explanatory enough from a raw dump). */
function describeMove(state, index, move) {
  switch (move.type) {
    case 'PLACE_DIE':
    case 'PLACE_WILDCARD_DIE': {
      const area = areaName(index, move.mapId, state);
      const die = dieDesc(state, move.dieId);
      const slot = move.slotIndex !== undefined ? ` slot=${move.slotIndex}` : '';
      const build = move.buildCandidateIndex !== undefined ? ` buildCandidateIndex=${move.buildCandidateIndex}` : '';
      return `${move.type} die(${die}) -> ${area}${slot}${build}`;
    }
    case 'PLACE_DICE_GROUP': {
      const area = areaName(index, move.mapId, state);
      const dice = move.dieIds.map((id) => dieDesc(state, id)).join(' + ');
      const build = move.buildCandidateIndex !== undefined ? ` buildCandidateIndex=${move.buildCandidateIndex}` : '';
      return `PLACE_DICE_GROUP dice(${dice}) -> ${area}${build}`;
    }
    case 'PASS_DIE':
      return `PASS_DIE die(${dieDesc(state, move.dieId)})`;
    case 'END_TURN':
      return 'END_TURN';
    default:
      return `${move.type} ${JSON.stringify(move)}`;
  }
}

function printPlayerSummary(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const dice = player.dice.map((d) => `${d.id}:${d.kind}${d.wildcard ? '/☆' : ''}=${d.value}${d.placedMapId ? `@${d.placedMapId}` : d.passed ? '(passed)' : ''}`).join(', ');
  const cards = player.ownedCardPhysicalIds.map((id) => {
    const card = state.cards[id];
    const row = getCardRow(index, card.currentFaceId);
    return `${card.currentFaceId}${card.tapped ? '(tapped)' : ''}:${row.NAME || ''}`;
  }).join(', ');
  console.log(`--- ${playerId} (${player.name}) round=${state.round} ---`);
  console.log(`  JOB=${player.jobCardId ? `${player.jobCardId}:${resourceName(index, player.jobCardId)}` : '(none)'}  CON=${player.conPhysicalId || ''}${player.conFace || ''}`);
  console.log(`  resources: ${JSON.stringify(player.resources)}`);
  console.log(`  dice: ${dice || '(none)'}`);
  console.log(`  cards: ${cards || '(none)'}`);
}

/** Computes+stores session.pendingMoves for a TURN pause without printing anything -- used by cmdAct to
 * get a guaranteed-fresh move list right before indexing into it, without describePause's own console
 * noise (which cmdAct's caller already saw once when this same pause was first reached). No-op for any
 * other pause kind. */
function computeMyPendingMoves(session, index, aiCtx, pause) {
  if (pause.kind !== 'TURN') return;
  const context = { hasPlacedDieThisTurn: session.myHasPlacedDieThisTurn };
  session.pendingMoves = aiCtx.moveGenerator.generateMoves(session.state, index, MY_PLAYER_ID, context);
}

function describePause(session, index, aiCtx, pause) {
  const state = session.state;
  console.log(`\n=== Decision point: ${pause.kind} (round ${state.round}) ===`);
  printPlayerSummary(state, index, MY_PLAYER_ID);
  if (pause.kind === 'SELECT_RESOURCE_CARDS') {
    console.log('Pick exactly 2 (choose <sessionDir> id1,id2):');
    pause.choice.context.candidates.forEach((id) => console.log(`  ${id}: ${resourceName(index, id)}`));
  } else if (pause.kind === 'JOB_CHOICE') {
    console.log('Pick 1 JOB face id from the pool (choose <sessionDir> <jobFaceId>):');
    state.jobPool.forEach((id) => console.log(`  ${id}: ${resourceName(index, id)}`));
  } else if (pause.kind === 'CON_CHOICE') {
    const player = state.players.find((p) => p.id === MY_PLAYER_ID);
    console.log('Pick a face, A or B (choose <sessionDir> A|B):');
    for (const face of ['A', 'B']) {
      const faceId = `${player.conPhysicalId}${face}`;
      let row;
      try { row = getCardRow(index, faceId); } catch (e) { row = null; }
      console.log(`  ${face} (${faceId}): ${row ? JSON.stringify(row) : '(no data)'}`);
    }
  } else if (pause.kind === 'PICK_JOB_REPLACEMENT') {
    console.log('Pick a replacement id (choose <sessionDir> <id>):');
    pause.choice.context.candidates.forEach((id) => console.log(`  ${id}: ${resourceName(index, id)}`));
  } else if (pause.kind === 'UNTAP_CHOICE') {
    const { candidates, weights, count } = pause.choice.context;
    console.log(`Pick any combo of tapped cards whose combined weight <= ${count} (choose <sessionDir> id1,id2,...):`);
    candidates.forEach((id) => console.log(`  ${id}: weight=${weights[id]} ${resourceName(index, id)}`));
  } else if (pause.kind === 'TURN') {
    computeMyPendingMoves(session, index, aiCtx, pause);
    console.log(`Legal moves (act <sessionDir> <index>) -- hasPlacedDieThisTurn=${session.myHasPlacedDieThisTurn}:`);
    session.pendingMoves.forEach((m, i) => console.log(`  [${i}] ${describeMove(state, index, m)}`));
  } else if (pause.kind === 'GAME_END') {
    const rankings = scoring.rankPlayers(state, index);
    console.log('GAME_END. Final rankings:');
    rankings.forEach((r, i) => console.log(`  #${i + 1}: ${r.playerId} score=${r.score}`));
    session.finalRankings = rankings;
  }
}

function ensureSessionDir(sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

function cmdNew(sessionDir) {
  ensureSessionDir(sessionDir);
  const { raw, index } = loadIndex();
  const aiCtx = buildAiContext(raw, index);
  const state = customSetup(index, aiCtx);
  const session = { state, roundStarted: false, lastSeenRound: -1, aiOpenTurn: { playerId: null, hasPlacedDie: false }, myHasPlacedDieThisTurn: false, myTurnOpen: false, pendingMoves: null };
  const pause = advanceUntilMyDecision(session, index, aiCtx);
  appendLog(sessionDir, `NEW seed=${FIXED_SEED} myPlayerId=${MY_PLAYER_ID}`);
  describePause(session, index, aiCtx, pause);
  saveSession(sessionDir, session);
}

function cmdState(sessionDir) {
  const { raw, index } = loadIndex();
  const aiCtx = buildAiContext(raw, index);
  const session = loadSession(sessionDir);
  const pause = advanceUntilMyDecision(session, index, aiCtx);
  describePause(session, index, aiCtx, pause);
  saveSession(sessionDir, session);
}

function cmdChoose(sessionDir, rawValue) {
  const { raw, index } = loadIndex();
  const aiCtx = buildAiContext(raw, index);
  const session = loadSession(sessionDir);
  const state = session.state;
  const pause = advanceUntilMyDecision(session, index, aiCtx); // re-derive which choice is actually pending
  if (pause.kind === 'SELECT_RESOURCE_CARDS') {
    const ids = rawValue.split(',').map((s) => s.trim());
    const result = setup.chooseResourceCards(state, MY_PLAYER_ID, ids);
    appendLog(sessionDir, `CHOOSE SELECT_RESOURCE_CARDS ${rawValue} -> ${JSON.stringify(result)}`);
  } else if (pause.kind === 'JOB_CHOICE') {
    setup.chooseJob(state, index, MY_PLAYER_ID, rawValue.trim());
    appendLog(sessionDir, `CHOOSE JOB_CHOICE ${rawValue}`);
  } else if (pause.kind === 'CON_CHOICE') {
    setup.chooseConFace(state, index, MY_PLAYER_ID, rawValue.trim());
    setup.receiveInitialResources(state, index, MY_PLAYER_ID);
    appendLog(sessionDir, `CHOOSE CON_CHOICE ${rawValue}`);
  } else if (pause.kind === 'PICK_JOB_REPLACEMENT') {
    setup.resolveJobReplacementChoice(state, index, MY_PLAYER_ID, rawValue.trim());
    appendLog(sessionDir, `CHOOSE PICK_JOB_REPLACEMENT ${rawValue}`);
  } else if (pause.kind === 'UNTAP_CHOICE') {
    const ids = rawValue.trim() === '' ? [] : rawValue.split(',').map((s) => s.trim());
    executor.resolveUntapChoice(state, MY_PLAYER_ID, ids);
    appendLog(sessionDir, `CHOOSE UNTAP_CHOICE ${rawValue}`);
  } else {
    console.log(`Nothing to choose right now -- current pause kind is ${pause.kind}. Use 'act' instead if it's TURN.`);
    describePause(session, index, aiCtx, pause);
    saveSession(sessionDir, session);
    return;
  }
  const nextPause = advanceUntilMyDecision(session, index, aiCtx);
  describePause(session, index, aiCtx, nextPause);
  saveSession(sessionDir, session);
}

function cmdAct(sessionDir, moveIndexArg) {
  const { raw, index } = loadIndex();
  const aiCtx = buildAiContext(raw, index);
  const session = loadSession(sessionDir);
  const state = session.state;
  const pause = advanceUntilMyDecision(session, index, aiCtx);
  if (pause.kind !== 'TURN') {
    console.log(`Not my TURN right now -- current pause kind is ${pause.kind}. Use 'choose' instead.`);
    describePause(session, index, aiCtx, pause);
    saveSession(sessionDir, session);
    return;
  }
  computeMyPendingMoves(session, index, aiCtx, pause); // ensures session.pendingMoves reflects THIS exact pause, freshly, without re-printing it
  const moveIndex = Number(moveIndexArg);
  const move = session.pendingMoves[moveIndex];
  if (!move) {
    console.log(`No such move index ${moveIndexArg} (0..${session.pendingMoves.length - 1}).`);
    return;
  }
  const result = applyInPlace(state, index, move);
  appendLog(sessionDir, `ACT ${describeMove(state, index, move)} -> success=${result.success}${result.success ? '' : ` reason=${result.reason}`}`);
  if (!result.success) {
    console.log(`Move failed: ${JSON.stringify(result)}`);
    saveSession(sessionDir, session);
    return;
  }
  if (['PLACE_DIE', 'PLACE_WILDCARD_DIE', 'PLACE_DICE_GROUP', 'PASS_DIE'].includes(move.type)) session.myHasPlacedDieThisTurn = true;
  if (move.type === 'END_TURN') {
    session.myHasPlacedDieThisTurn = false;
    session.myTurnOpen = false; // see advanceUntilMyDecision's own doc on myTurnOpen
  }
  let nextPause = advanceUntilMyDecision(session, index, aiCtx);
  if (nextPause.kind === 'TURN') {
    computeMyPendingMoves(session, index, aiCtx, nextPause);
    if (session.pendingMoves.length === 0) {
      // Mirrors game-runner.js's driveTurn: `if (!move) break;` -- genuinely nothing left to do (stuck),
      // close the turn and re-derive what actually comes next (another player's AI turn, round-over,
      // etc.) instead of reporting an empty TURN pause.
      session.myTurnOpen = false;
      nextPause = advanceUntilMyDecision(session, index, aiCtx);
    }
  }
  describePause(session, index, aiCtx, nextPause);
  saveSession(sessionDir, session);
}

function main() {
  const [cmd, sessionDirArg, ...rest] = process.argv.slice(2);
  if (!cmd || !sessionDirArg) {
    console.error('Usage: node tools/manual_play.js <new|state|choose|act> <sessionDir> [value]');
    process.exit(1);
  }
  const sessionDir = path.resolve(sessionDirArg);
  if (cmd === 'new') cmdNew(sessionDir);
  else if (cmd === 'state') cmdState(sessionDir);
  else if (cmd === 'choose') cmdChoose(sessionDir, rest.join(' '));
  else if (cmd === 'act') cmdAct(sessionDir, rest[0]);
  else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
}

main();
