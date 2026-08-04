/**
 * Smoke test for src/ai/move-generator.js against real data.
 * Run: node tests/ai-move-generator.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState, createDie, createCardInstance } = require('../src/game-state');
const setup = require('../src/setup');
const executor = require('../src/executor');
const { MoveGenerator, bzConversionTap } = require('../src/ai/move-generator');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));
const moveGenerator = new MoveGenerator();

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}
function assertTrue(label, cond) { check(label, !!cond, true); }

function freshStateWithShops() {
  const state = createEmptyGameState('ai-move-generator-smoke');
  setup.createPlayers(state, ['Alice', 'Bob']);
  setup.prepareMaps(state, index);
  setup.prepareShops(state, index);
  return state;
}
function player(state, id) { return state.players.find((p) => p.id === id); }
function giveDie(state, playerId, value) {
  const die = createDie(`test-${playerId}-${value}-${Math.random()}`, 'COLOR');
  die.value = value;
  player(state, playerId).dice.push(die);
  return die;
}
function movesOfType(moves, type) { return moves.filter((m) => m.type === type); }

// ---------------------------------------------------------------------------
// context.hasPlacedDieThisTurn gates PLACE_DIE and END_TURN, mirroring main.js's turnActionTaken.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  giveDie(state, 'P1', 1);
  const beforePlace = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('PLACE_DIE moves exist while hasPlacedDieThisTurn is false', movesOfType(beforePlace, 'PLACE_DIE').length > 0);
  check('END_TURN never appears before a die is placed', movesOfType(beforePlace, 'END_TURN').length, 0);

  const afterPlace = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  check('PLACE_DIE disappears once hasPlacedDieThisTurn is true', movesOfType(afterPlace, 'PLACE_DIE').length, 0);
  assertTrue('END_TURN appears once hasPlacedDieThisTurn is true and canEndTurn is ok', movesOfType(afterPlace, 'END_TURN').length === 1);
}

// ---------------------------------------------------------------------------
// END_TURN is withheld while RESOURCE_TOTAL_LIMIT blocks it (CON005B), even with hasPlacedDieThisTurn.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const conInst = createCardInstance('CON005B');
  conInst.ownerId = 'P1';
  state.cards[conInst.physicalId] = conInst;
  p1.ownedCardPhysicalIds.push(conInst.physicalId);
  p1.resources.A = 8; // A+B+C=8 > limit 7
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  check('END_TURN is withheld while RESOURCE_TOTAL_LIMIT blocks it', movesOfType(moves, 'END_TURN').length, 0);
}

// ---------------------------------------------------------------------------
// A BUILD-triggering placement (castle) offers one move per candidate PLUS a "leave it unresolved"
// fallback (buildCandidateIndex omitted) -- since the die genuinely gets placed either way, unlike the
// BARE_TAP/CLAIM_QUEST cases below.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const die = giveDie(state, 'P1', 5);
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  const castleMoves = moves.filter((m) => m.type === 'PLACE_DIE' && m.mapId === 'MAP008' && m.dieId === die.id && m.slotIndex === 0);
  assertTrue('At least one per-candidate castle PLACE_DIE move exists', castleMoves.some((m) => m.buildCandidateIndex !== undefined));
  assertTrue('A "leave unresolved" castle PLACE_DIE move also exists (buildCandidateIndex omitted)', castleMoves.some((m) => m.buildCandidateIndex === undefined));
}

// ---------------------------------------------------------------------------
// A BUILD-kind BARE_TAP (B005A.TAP=BUILD((A,B,C,M),1)) offers one move per candidate and NO
// "leave unresolved" fallback (fixed 2026-08-02: that fallback was a true no-op for BARE_TAP since
// board.useBareTapAbility never taps the card or spends anything before returning pendingBuild --
// offering it let AIPlayer's tie-break pick it forever, see [[project-dice-wp]]).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('B005A');
  inst.ownerId = 'P1';
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);

  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  const bareTapMoves = moves.filter((m) => m.type === 'BARE_TAP' && m.physicalId === inst.physicalId);
  assertTrue('At least one per-candidate BARE_TAP move exists for B005A', bareTapMoves.length > 0);
  check('No "leave unresolved" BARE_TAP fallback (every move carries a buildCandidateIndex)', bareTapMoves.every((m) => m.buildCandidateIndex !== undefined), true);
}

// ---------------------------------------------------------------------------
// A tapped card offers no BARE_TAP moves at all.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const inst = createCardInstance('C001A');
  inst.ownerId = 'P1';
  inst.tapped = true;
  state.cards[inst.physicalId] = inst;
  p1.ownedCardPhysicalIds.push(inst.physicalId);
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  check('A tapped card offers no BARE_TAP moves', movesOfType(moves, 'BARE_TAP').filter((m) => m.physicalId === inst.physicalId).length, 0);
}

// ---------------------------------------------------------------------------
// FREE_ACTION: withheld entirely unless actually needed to unblock a RESOURCE_TOTAL_LIMIT-blocked turn
// end (2026-08-03, per user feedback: "AIが無駄にA→K...をやっています...意味がないため...基本的には
// やらないように") -- even though these have no usage limit (confirmed 2026-08-02), a simple
// linear-weighted Evaluator has no notion of "do I actually need K right now", so leaving them always
// offered meant the AI kept taking pointless conversions whenever the numbers happened to favor K.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.A = 1;
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  check('A_K is NOT offered while not blocked, even though affordable', movesOfType(moves, 'FREE_ACTION').length, 0);
}
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const conInst = createCardInstance('CON005B'); // TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7)
  conInst.ownerId = 'P1';
  state.cards[conInst.physicalId] = conInst;
  p1.ownedCardPhysicalIds.push(conInst.physicalId);
  p1.resources.A = 8; // A+B+C=8 > limit 7 -- blocks ending the turn

  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  assertTrue('A_K IS offered once RESOURCE_TOTAL_LIMIT actually blocks ending the turn', movesOfType(moves, 'FREE_ACTION').some((m) => m.freeActionId === 'A_K'));
  check('B_K is not offered (no B resource to pay)', movesOfType(moves, 'FREE_ACTION').some((m) => m.freeActionId === 'B_K'), false);

  executor.tryFreeAction(state, index, 'P1', 'A_K'); // A=7 now, no longer blocked
  const movesAfter = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  check('FREE_ACTION disappears again once no longer blocked (not because A_K got "used up")', movesOfType(movesAfter, 'FREE_ACTION').length, 0);
}

// ---------------------------------------------------------------------------
// COLLECT_FEE: offered only for the fee owner with a positive balance.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  state.maps['MAP001'].feeOwnerId = 'P1';
  state.maps['MAP001'].accumulatedFee = 2;
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  assertTrue('COLLECT_FEE is offered to the fee owner with a positive balance', movesOfType(moves, 'COLLECT_FEE').some((m) => m.mapId === 'MAP001'));
  const movesForOther = moveGenerator.generateMoves(state, index, 'P2', { hasPlacedDieThisTurn: true });
  check('COLLECT_FEE is not offered to a non-owner', movesOfType(movesForOther, 'COLLECT_FEE').length, 0);
}

// ---------------------------------------------------------------------------
// TAP_REACTION: both use:true and use:false are offered for each pending choice.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB005');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  executor.setCardAutoMode(state, 'P1', jobInst.physicalId, false);
  executor.grantResourceAndEmitGet(state, index, { playerId: 'P1' }, 'K', 1);

  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: true });
  const reactionMoves = movesOfType(moves, 'TAP_REACTION');
  check('Both use:true and use:false are offered for the pending reaction', reactionMoves.map((m) => m.use).sort(), [false, true]);
}

// ---------------------------------------------------------------------------
// bzConversionTap / forcedBzConversionMove (2026-08-04, per user feedback: "JOB004の効果は使えるときは
// 必ず使う") -- JOB004's TAP="CHANGE(3K,2BZ)" is detected as a forced BZ conversion; a card with no
// such ability, or JOB004 itself when unaffordable/already tapped, is not.
//
// 2026-08-0X update (per user feedback: "BZはターン終了時に無くなります...AIもBZを作る→無くなるという
// ことをしないようにしてください"): forcing this conversion is now ALSO gated on there being a reachable
// build-resolving move (a buildCandidateIndex-carrying move) this same turn -- otherwise the BZ would
// just evaporate at TURNEND for nothing. context is now a required 4th argument.
// ---------------------------------------------------------------------------
{
  check('bzConversionTap detects JOB004 ("CHANGE(3K,2BZ)")', !!bzConversionTap(index, 'JOB004'), true);
  check('bzConversionTap is null for a card with no TAP field at all (M001, printed VP only)', bzConversionTap(index, 'M001'), null);
  check('bzConversionTap is null for a bare TAP that does not produce BZ (C001A)', bzConversionTap(index, 'C001A'), null);
}
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB004');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  const context = { hasPlacedDieThisTurn: false };

  check('forcedBzConversionMove is null without enough K (0 < 3)', moveGenerator.forcedBzConversionMove(state, index, 'P1', context), null);

  p1.resources.K = 3;
  check(
    'forcedBzConversionMove is still null once affordable but with no build reachable this turn (no dice, no BUILD-kind bare TAP)',
    moveGenerator.forcedBzConversionMove(state, index, 'P1', context),
    null
  );

  giveDie(state, 'P1', 3); // castle's BUILD() at buildValue=3 includes A004A (COST="A,B", 2 units total) --
  // genuinely affordable using only the 2 BZ this conversion grants, 0 real resources needed (confirmed
  // via a one-off script against this exact seed).
  const forced = moveGenerator.forcedBzConversionMove(state, index, 'P1', context);
  check('forcedBzConversionMove returns the BARE_TAP move once affordable AND a build is reachable this turn', forced, { type: 'BARE_TAP', playerId: 'P1', physicalId: jobInst.physicalId });

  jobInst.tapped = true;
  check('forcedBzConversionMove is null once the card is already tapped', moveGenerator.forcedBzConversionMove(state, index, 'P1', context), null);
}

// ---------------------------------------------------------------------------
// Regression (2026-08-04, per user feedback: "JOB004のAIの平均点が低すぎます 3K→2BZ 使えていますか？"):
// "a build is reachable this turn" used to mean only dice/category-eligible (per #placeDieMoves' own
// doc, getBuildCandidates doesn't check affordability), so this used to force the conversion even when
// every reachable candidate was still unaffordable afterwards -- burning 3K and BLOCK_BUILD(M) for
// nothing. die value 6 on the castle (this seed) only reaches candidates costing 3+ units total
// (A005A=3, M007=9, M009=8, M012=13 -- confirmed via a one-off script), none of which 2 BZ alone (with
// 0 real A/B/C/Z on hand) can fully cover -- forcedBzConversionMove must now correctly decline.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB004');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  p1.resources.K = 3; // covers JOB004's own CHANGE(3K,2BZ) cost
  const context = { hasPlacedDieThisTurn: false };

  giveDie(state, 'P1', 6); // castle BUILD() at buildValue=6 -- cheapest reachable candidate costs 3 units
  check(
    'forcedBzConversionMove declines when every dice-reachable candidate is still unaffordable after the conversion (0 real A/B/C/Z, cheapest candidate needs 3 units and 2 BZ alone falls 1 short)',
    moveGenerator.forcedBzConversionMove(state, index, 'P1', context),
    null
  );

  // A005A COST="2A,B" -- maxBzDiscount assigns BZ to cost items in listed order, so both BZ land on the
  // 2A (first item) and leave the B unit real-paid; 1 real B (not A) is what makes it affordable.
  p1.resources.B = 1;
  const forced = moveGenerator.forcedBzConversionMove(state, index, 'P1', context);
  check('...but forces it once that same candidate becomes genuinely affordable (2 BZ + the 1 real B now on hand)', forced, { type: 'BARE_TAP', playerId: 'P1', physicalId: jobInst.physicalId });
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
