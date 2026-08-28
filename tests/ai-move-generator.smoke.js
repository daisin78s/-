/**
 * Smoke test for src/ai/move-generator.js against real data.
 * Run: node tests/ai-move-generator.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState, createDie, createCardInstance, cloneState } = require('../src/game-state');
const setup = require('../src/setup');
const executor = require('../src/executor');
const board = require('../src/board');
const { MoveGenerator, bzConversionTap } = require('../src/ai/move-generator');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));
// CON005B used to carry TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7) before the 2026-08-13 CON rewrite (all
// new sin-themed names/abilities); no real card in the current dataset has RESOURCE_TOTAL_LIMIT at all
// anymore, so this patches a synthetic copy of it back onto CON005B's row (every other field left
// as-is) purely so the tests below can keep exercising that still-real, still-used generic engine
// mechanism (END_TURN/FREE_ACTION gating) against an actual ownable card id.
index.byId.set('CON005B', { sheet: 'CON', row: { ...index.byId.get('CON005B').row, TURNEND: 'RESOURCE_TOTAL_LIMIT((A,B,C),7)' } });
// JOB004's own TAP used to be CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN) -- the original real-data vehicle
// for bzConversionTap's CHANGE-based (as opposed to ADD-based, like JOB007) detection branch -- until
// the 2026-08-24 SHOP201-203 rework changed it to CHANGE(3K,2Z), a genuinely different resource/mechanic.
// No card in the current dataset grants BZ via CHANGE any more, but bzConversionTap is meant to
// recognize that *shape* generically (see its own doc), so this patches the old text back onto JOB004's
// row (every other field left as-is) purely so the tests below can keep exercising that still-real,
// still-used CHANGE branch against an actual ownable card id.
index.byId.set('JOB004', { sheet: 'JOB', row: { ...index.byId.get('JOB004').row, TAP: 'CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)' } });
const moveGenerator = new MoveGenerator();
// Generic avoidMapIdFromRound policy exercise (2026-08-28: no longer used by any AI level -- LV3's own
// MAP007/round-3 usage of this was removed per user request "3Rから訓練場を避けるは削除してください" --
// but the mechanism itself stays in MoveGenerator for future reuse, so this keeps testing it directly
// with arbitrary params rather than deleting the coverage).
const moveGeneratorPoliced = new MoveGenerator({
  avoidMapIdFromRound: { mapId: 'MAP007', round: 3 },
});

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
// BARE_TAP case below. Requires BZ (2026-08-04, per user feedback: "AREA008 009は建築完了
// 出来ないときはダイスが置けません" -- board.js's wouldAreaActionHaveEffect now gates the placement
// itself on at least one AFFORDABLE candidate existing, not just a dice-eligible one; a generous BZ
// grant covers whatever the cheapest candidate at this seed/buildValue turns out to be).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  const die = giveDie(state, 'P1', 5);
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  const castleMoves = moves.filter((m) => m.type === 'PLACE_DIE' && m.mapId === 'MAP008' && m.dieId === die.id && m.slotIndex === 0);
  assertTrue('At least one per-candidate castle PLACE_DIE move exists', castleMoves.some((m) => m.buildCandidateIndex !== undefined));
  assertTrue('A "leave unresolved" castle PLACE_DIE move also exists (buildCandidateIndex omitted)', castleMoves.some((m) => m.buildCandidateIndex === undefined));
}

// ---------------------------------------------------------------------------
// PLACE_DICE_GROUP (2026-08-21, per user request "AIがダイスを２個使ってモニュメントを獲得できるように
// してほしい" -- see move-generator.js's own doc): pairs summing >6 at 王宮/元老院 (MAP008/MAP009) only.
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // covers whatever monument candidate the combined value reaches
  const dieA = giveDie(state, 'P1', 4);
  const dieB = giveDie(state, 'P1', 5); // 4+5=9 > 6
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  const groupMoves = movesOfType(moves, 'PLACE_DICE_GROUP');
  assertTrue('A 2-die pair summing to 9 (>6) yields at least one PLACE_DICE_GROUP move', groupMoves.length > 0);
  check('...every PLACE_DICE_GROUP move is scoped to 王宮/元老院 only', groupMoves.every((m) => m.mapId === 'MAP008' || m.mapId === 'MAP009'), true);
  check('...every PLACE_DICE_GROUP move carries exactly this pair\'s 2 dieIds', groupMoves.every((m) => [...m.dieIds].sort().join() === [dieA.id, dieB.id].sort().join()), true);
  assertTrue('At least one per-candidate move exists (buildCandidateIndex set)', groupMoves.some((m) => m.buildCandidateIndex !== undefined));
  assertTrue('A "leave unresolved" move also exists (buildCandidateIndex omitted)', groupMoves.some((m) => m.buildCandidateIndex === undefined));
}
{
  // A pair summing to <=6 never yields a PLACE_DICE_GROUP move at all -- a single die already reaches
  // that range via PLACE_DIE, so MoveGenerator doesn't even attempt the pair.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20;
  giveDie(state, 'P1', 2);
  giveDie(state, 'P1', 4); // 2+4=6, not >6
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  check('A pair summing to exactly 6 yields zero PLACE_DICE_GROUP moves', movesOfType(moves, 'PLACE_DICE_GROUP').length, 0);
}
{
  // JOB003/道化 (hasWildcardDice): group placement is refused outright by board.placeDiceGroup itself
  // (WILDCARD_GROUP_NOT_ALLOWED) -- MoveGenerator skips generating it entirely rather than dry-running
  // pairs that would always fail.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB003';
  const jobInst = createCardInstance('JOB003');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  p1.resources.BZ = 20;
  giveDie(state, 'P1', 5);
  giveDie(state, 'P1', 6); // 5+6=11 > 6, would otherwise qualify
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  check('A 道化 (JOB003) player never gets a PLACE_DICE_GROUP move, even with a qualifying pair', movesOfType(moves, 'PLACE_DICE_GROUP').length, 0);
}

// ---------------------------------------------------------------------------
// A BUILD-kind BARE_TAP (B005A.TAP=PAY(K);BUILD((A,B,C,M),1)) offers one move per candidate and NO
// "leave unresolved" fallback (fixed 2026-08-02: that fallback was a true no-op for BARE_TAP since
// board.useBareTapAbility never taps the card or spends anything before returning pendingBuild --
// offering it let AIPlayer's tie-break pick it forever, see [[project-dice-wp]]).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.resources.K = 1; // 2026-08-21 data edit: TAP now costs PAY(K) up front, before the BUILD half
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
  check('bzConversionTap detects JOB007 ("ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+2);BLOCK_BUILD(A/B/C,THIS_TURN)", 2026-08-24)', !!bzConversionTap(index, 'JOB007'), true);
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

// ---------------------------------------------------------------------------
// forcedJob004ConversionMove (2026-08-28, per user request/experiment: "策士は3K以上あれば基本的に毎ターン
// 使うでどうでしょうか") -- unconditional: forces CHANGE(3K,2Z) whenever the player owns an untapped
// JOB004 with >=3K, with no build-outlet check at all (unlike forcedBzConversionMove above).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB004');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);

  p1.resources.K = 2;
  check('forcedJob004ConversionMove is null with less than 3K', moveGenerator.forcedJob004ConversionMove(state, index, 'P1'), null);

  p1.resources.K = 3;
  check(
    'forcedJob004ConversionMove forces the tap at exactly 3K, with no build outlet needed at all',
    moveGenerator.forcedJob004ConversionMove(state, index, 'P1'),
    { type: 'BARE_TAP', playerId: 'P1', physicalId: jobInst.physicalId }
  );

  jobInst.tapped = true;
  check('forcedJob004ConversionMove is null once the card is already tapped', moveGenerator.forcedJob004ConversionMove(state, index, 'P1'), null);
}
{
  const state = freshStateWithShops();
  player(state, 'P1').resources.K = 10;
  check('forcedJob004ConversionMove is null for a player who doesn\'t own JOB004 at all', moveGenerator.forcedJob004ConversionMove(state, index, 'P1'), null);
}

// ---------------------------------------------------------------------------
// forcedEndSignLv2Move (2026-08-28, per user request: "終わりの兆しLV2は獲得できるカードがあればすぐ使う
// ようにしてください 使用対象が複数の時はダイス目高いほうを優先で"): forces B202B's BUILD(M,12) tap
// whenever at least one monument candidate is genuinely affordable, preferring the candidate with the
// HIGHEST DICE threshold when more than one qualifies. M001(記念碑, DICE>=12, COST=C) and M002(鐘楼,
// DICE>=11, COST=2B) are both reachable at buildValue=12 -- a clean pair with different thresholds.
// ---------------------------------------------------------------------------
function giveB202B(state, playerId) {
  const cardInst = createCardInstance('B202B');
  cardInst.ownerId = playerId;
  state.cards[cardInst.physicalId] = cardInst;
  player(state, playerId).ownedCardPhysicalIds.push(cardInst.physicalId);
  return cardInst;
}
{
  const state = freshStateWithShops();
  state.shops.M.slots.SHOP001 = 'M001'; // DICE>=12, COST=C
  state.shops.M.slots.SHOP002 = 'M002'; // DICE>=11, COST=2B
  const cardInst = giveB202B(state, 'P1');
  const p1 = player(state, 'P1');

  p1.resources.C = 0;
  p1.resources.B = 0;
  check('forcedEndSignLv2Move is null with nothing affordable', moveGenerator.forcedEndSignLv2Move(state, index, 'P1'), null);

  p1.resources.B = 2; // only M002 (DICE>=11) affordable
  const onlyM002 = moveGenerator.forcedEndSignLv2Move(state, index, 'P1');
  assertTrue('Only M002 affordable: forces the tap', onlyM002 !== null && onlyM002.type === 'BARE_TAP' && onlyM002.physicalId === cardInst.physicalId);

  p1.resources.C = 1; // now BOTH M001 (DICE>=12) and M002 (DICE>=11) are affordable
  const both = moveGenerator.forcedEndSignLv2Move(state, index, 'P1');
  const clone = require('../src/game-state').cloneState(state);
  const applied = require('../src/ai/simulator').applyInPlace(clone, index, both);
  check('Both affordable: prefers the HIGHER DICE threshold (M001, >=12, over M002, >=11)', applied.candidate.faceId, 'M001');

  cardInst.tapped = true;
  check('forcedEndSignLv2Move is null once the card is already tapped', moveGenerator.forcedEndSignLv2Move(state, index, 'P1'), null);
}

// ---------------------------------------------------------------------------
// forcedTrainingGroundMove (2026-08-28, per user request: "訓練場の支配も獲得したら必ずすぐに訓練場に
// ダイスを置いて追加色ダイスを獲得するようにしてほしい"; scoped to "新しい色ダイスが得られる時だけ強制"):
// forces a PLACE_DIE at 訓練場(MAP007) once the player owns A202A/A202B, but ONLY when it would actually
// raise their own color-dice count -- not merely "the placement succeeds".
// ---------------------------------------------------------------------------
function giveTrainingGroundControl(state, playerId, faceId) {
  const cardInst = createCardInstance(faceId);
  cardInst.ownerId = playerId;
  state.cards[cardInst.physicalId] = cardInst;
  player(state, playerId).ownedCardPhysicalIds.push(cardInst.physicalId);
  return cardInst;
}
{
  const state = freshStateWithShops();
  giveTrainingGroundControl(state, 'P1', 'A202A');
  const p1 = player(state, 'P1');
  p1.resources.A = 1; // MAP007's default tier-A ACTION is CHANGE((A,B,C),D) -- needs 1 of each to trigger
  p1.resources.B = 1;
  p1.resources.C = 1;
  const die = giveDie(state, 'P1', 3);
  const context = { hasPlacedDieThisTurn: false };
  const forced = moveGenerator.forcedTrainingGroundMove(state, index, 'P1', context);
  check(
    'Owns 訓練場の支配, has an unplaced die: forces a PLACE_DIE at MAP007',
    forced && forced.type === 'PLACE_DIE' && forced.mapId === 'MAP007' && forced.dieId === die.id,
    true
  );
}
{
  // No unplaced die at all -- nothing to force.
  const state = freshStateWithShops();
  giveTrainingGroundControl(state, 'P1', 'A202A');
  check('No unplaced die: forcedTrainingGroundMove is null', moveGenerator.forcedTrainingGroundMove(state, index, 'P1', { hasPlacedDieThisTurn: false }), null);
}
{
  // Doesn't own 訓練場の支配 at all.
  const state = freshStateWithShops();
  giveDie(state, 'P1', 3);
  check('Doesn\'t own 訓練場の支配: forcedTrainingGroundMove is null', moveGenerator.forcedTrainingGroundMove(state, index, 'P1', { hasPlacedDieThisTurn: false }), null);
}
{
  // Already placed a die this turn -- PLACE_DIE-family gating applies.
  const state = freshStateWithShops();
  giveTrainingGroundControl(state, 'P1', 'A202B');
  giveDie(state, 'P1', 3);
  check('hasPlacedDieThisTurn already true: forcedTrainingGroundMove is null', moveGenerator.forcedTrainingGroundMove(state, index, 'P1', { hasPlacedDieThisTurn: true }), null);
}

// ---------------------------------------------------------------------------
// Regression (2026-08-06, per user feedback: "AIは建築しないときはJOB004をTAPしない（できない）"):
// forcedBzConversionMove already declined to *force* JOB004's tap with no build outlet (previous
// block), but #bareTapMoves still offered the same tap as a normal generateMoves candidate regardless
// -- letting the Evaluator's flat per-unit BZ weight (which doesn't know BZ evaporates at TURNEND) pick
// it anyway and waste 3K. generateMoves must now omit it entirely with no outlet, and still include it
// once one exists (so a human-equivalent "I could tap this AND spend it" option stays available even in
// states forcedBzConversionMove itself never gets to check, e.g. a Simulator lookahead node).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const jobInst = createCardInstance('JOB004');
  jobInst.ownerId = 'P1';
  state.cards[jobInst.physicalId] = jobInst;
  p1.ownedCardPhysicalIds.push(jobInst.physicalId);
  p1.resources.K = 3;
  const context = { hasPlacedDieThisTurn: false };

  const movesNoOutlet = moveGenerator.generateMoves(state, index, 'P1', context);
  assertTrue(
    'generateMoves omits the JOB004 BARE_TAP candidate entirely when no build outlet exists (no dice at all)',
    !movesNoOutlet.some((m) => m.type === 'BARE_TAP' && m.physicalId === jobInst.physicalId)
  );

  giveDie(state, 'P1', 3); // same affordable-with-just-2-BZ setup as the earlier forced-conversion test.
  const movesWithOutlet = moveGenerator.generateMoves(state, index, 'P1', context);
  assertTrue(
    'generateMoves still includes the JOB004 BARE_TAP candidate once a build outlet exists',
    movesWithOutlet.some((m) => m.type === 'BARE_TAP' && m.physicalId === jobInst.physicalId)
  );
}

// ---------------------------------------------------------------------------
// Regression (2026-08-28, per user report: "AILV4が無意味にダイス変換を使ってターン終了時に元に戻って
// います"): a die whose value is changed via a bare SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE TAP but
// never actually PLACED that same turn silently reverts to its original value at TURNEND (see
// executor.js's own valueChangedThisTurn revert) -- so offering the tap at all with nowhere useful to
// spend the new value burns the once-per-round tap for nothing. Refined the same day, per user spec:
// "置かないダイスにダイス変換を使わない 結果がだいたい同じときは（同じSLOTにおけて同じカードが獲得でき
// るとき、残すダイスが違ってもOK）ダイス変換を使わない" -- only offered once it lets THIS die reach a
// genuinely NEW (mapId,slotIndex,outcome) it couldn't already reach at its original value (see
// #dieReachableOutcomes' own doc). B003A/運命の導き ("CHANGE_DIE_VALUE(SELF+2)", no other side effect) is
// the cleanest real vehicle for this.
// ---------------------------------------------------------------------------
function giveB003A(state, playerId) {
  const cardInst = createCardInstance('B003A');
  cardInst.ownerId = playerId;
  state.cards[cardInst.physicalId] = cardInst;
  player(state, playerId).ownedCardPhysicalIds.push(cardInst.physicalId);
  return cardInst;
}
const offersB003ATap = (moves, cardInst, die) => moves.some((m) => m.type === 'BARE_TAP' && m.physicalId === cardInst.physicalId && m.chosenDieId === die.id && m.chosenDelta === 2);
{
  // Positive case: even with 0 resources, MAP001's own tier-A area happens to give every exact die value
  // its own uniquely-reachable free slot (empirically confirmed) -- so 1->3 genuinely opens a NEW slot
  // (MAP001 slot index 2) neither value could reach before, and the tap is offered.
  const state = freshStateWithShops();
  const cardInst = giveB003A(state, 'P1');
  const die = giveDie(state, 'P1', 1);
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('Offered: converting 1->3 reaches a genuinely new slot even with 0 resources', offersB003ATap(moves, cardInst, die));
}
{
  // Blocked case 1 (rule 1: nothing to place at all): MAP001/MAP002 swapped to 王宮's own ANY-slot,
  // BUILD()-gated area (AREA008) -- unlike MAP001/002's own tier-A areas, a BUILD()-gated area genuinely
  // offers nothing with 0 resources, for any die value, so there is no map left where 1 or 3 reach
  // anything at all.
  const state = freshStateWithShops();
  state.maps.MAP001.currentAreaId = 'AREA008';
  state.maps.MAP002.currentAreaId = 'AREA008';
  const cardInst = giveB003A(state, 'P1');
  const die = giveDie(state, 'P1', 1);
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('Blocked: nothing reachable at all, at either value, with 0 resources', !offersB003ATap(moves, cardInst, die));
}
{
  // Blocked case 2 (rule 2: same result either way): same neutralized fixture, now with BZ=20. Every
  // ANY-slot BUILD() area reaches the identical cheapest candidate regardless of the die's exact value,
  // so 1->3 doesn't open anything NEW -- converting would be pure waste even though real resources (and a
  // real build outlet) now genuinely exist.
  const state = freshStateWithShops();
  state.maps.MAP001.currentAreaId = 'AREA008';
  state.maps.MAP002.currentAreaId = 'AREA008';
  player(state, 'P1').resources.BZ = 20;
  const cardInst = giveB003A(state, 'P1');
  const die = giveDie(state, 'P1', 1);
  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('Blocked: a real build outlet exists, but 1 and 3 reach the exact same outcome', !offersB003ATap(moves, cardInst, die));
}

// ---------------------------------------------------------------------------
// avoidMapIdFromRound mechanism (see MoveGenerator's own doc). The shared, policy-free `moveGenerator`
// is used as a same-state control to confirm the policy is opt-in, not a global behavior change.
// ---------------------------------------------------------------------------
{
  // AREA007 avoidance (avoidMapIdFromRound -- see MoveGenerator's own doc): from the configured round
  // onward, MAP007 (AREA007, ACTION=CHANGE((A,B,C),D)) is dropped from PLACE_DIE candidates entirely,
  // for every die/slot -- not just build-resolving decision points.
  const state = freshStateWithShops();
  // AREA007's CHANGE((A,B,C),D) pays the whole A+B+C bundle at once (double-parens = bundle, not a
  // choice of one -- see project-dice-wp-dsl-spec's own doc), so all three are needed to afford it and
  // avoid a separate "no-op placement" rejection (board.wouldAreaActionHaveEffect) that would otherwise
  // block this test's die regardless of the avoidMapIdFromRound policy under test.
  player(state, 'P1').resources.A = 1;
  player(state, 'P1').resources.B = 1;
  player(state, 'P1').resources.C = 1;
  const die = giveDie(state, 'P1', 1); // AREA007's 3 SLOTs are all ANY
  const context = { hasPlacedDieThisTurn: false };
  const offersMap007 = (moves) => moves.some((m) => m.type === 'PLACE_DIE' && m.dieId === die.id && m.mapId === 'MAP007');

  state.round = 2;
  assertTrue(
    'Before avoidMapIdFromRound\'s threshold, the policed generator still offers a placement on MAP007 (AREA007)',
    offersMap007(moveGeneratorPoliced.generateMoves(state, index, 'P1', context))
  );

  state.round = 3;
  assertTrue(
    'At/after avoidMapIdFromRound\'s threshold, the policed generator no longer offers MAP007 at all',
    !offersMap007(moveGeneratorPoliced.generateMoves(state, index, 'P1', context))
  );
  assertTrue(
    'The unpoliced MoveGenerator still offers MAP007 at the very same round (control)',
    offersMap007(moveGenerator.generateMoves(state, index, 'P1', context))
  );
}

// ---------------------------------------------------------------------------
// preferCastleOverSenate (2026-08-28, "AI LV4", see MoveGenerator's own doc): 王宮(MAP008)/元老院(MAP009)
// are functionally identical, so offering both every turn is redundant search -- when both currently
// have a legal move, drop 元老院 in favor of 王宮, UNLESS the player holds 開拓者 (JOB009), whose bonus
// only fires on a currently-empty AREA, in which case the CURRENTLY-EMPTY one wins instead (falling back
// to plain 王宮 preference on a tie).
// ---------------------------------------------------------------------------
const moveGeneratorLv4 = new MoveGenerator({ preferCastleOverSenate: true });
function offersMapId(moves, dieId, mapId) { return moves.some((m) => m.dieId === dieId && m.mapId === mapId); }

{
  // Plain (non-開拓者) player: both empty (fresh board) -- 元老院 dropped, 王宮 kept.
  const state = freshStateWithShops();
  player(state, 'P1').resources.BZ = 20; // covers whatever candidate the die's buildValue reaches
  const die = giveDie(state, 'P1', 5);
  const context = { hasPlacedDieThisTurn: false };
  const policedMoves = moveGeneratorLv4.generateMoves(state, index, 'P1', context);
  assertTrue('Non-開拓者: 王宮 is kept', offersMapId(policedMoves, die.id, 'MAP008'));
  assertTrue('Non-開拓者: 元老院 is dropped in favor of 王宮', !offersMapId(policedMoves, die.id, 'MAP009'));
  const unpolicedMoves = moveGenerator.generateMoves(state, index, 'P1', context);
  assertTrue('Control: the unpoliced MoveGenerator still offers 王宮', offersMapId(unpolicedMoves, die.id, 'MAP008'));
  assertTrue('Control: the unpoliced MoveGenerator still offers 元老院 too', offersMapId(unpolicedMoves, die.id, 'MAP009'));
}

{
  // 開拓者 owner, 王宮 already occupied (by someone else) / 元老院 still empty -- keeps 元老院 (the
  // currently-empty one, for the pioneer bonus), drops 王宮 -- the OPPOSITE of the plain preference.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB009'; // hasPioneerAbility only reads this field -- see board.js's own doc
  p1.resources.BZ = 20;
  state.maps['MAP008'].slots[0].push({ playerId: 'P2', dieId: 'occupant', value: 3, seq: 1, countsForTurnOrder: true });
  const die = giveDie(state, 'P1', 5);
  const moves = moveGeneratorLv4.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('開拓者, 王宮 occupied/元老院 empty: 元老院 is kept', offersMapId(moves, die.id, 'MAP009'));
  assertTrue('開拓者, 王宮 occupied/元老院 empty: 王宮 is dropped', !offersMapId(moves, die.id, 'MAP008'));
}

{
  // 開拓者 owner, 元老院 already occupied / 王宮 still empty -- keeps 王宮 (same outcome as the plain
  // preference here, but for the pioneer-bonus reason, not the default fallback).
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB009';
  p1.resources.BZ = 20;
  state.maps['MAP009'].slots[0].push({ playerId: 'P2', dieId: 'occupant', value: 3, seq: 1, countsForTurnOrder: true });
  const die = giveDie(state, 'P1', 5);
  const moves = moveGeneratorLv4.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('開拓者, 元老院 occupied/王宮 empty: 王宮 is kept', offersMapId(moves, die.id, 'MAP008'));
  assertTrue('開拓者, 元老院 occupied/王宮 empty: 元老院 is dropped', !offersMapId(moves, die.id, 'MAP009'));
}

{
  // 開拓者 owner, BOTH already occupied (a tie -- neither triggers the bonus) -- falls back to the plain
  // 王宮 preference.
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  p1.jobCardId = 'JOB009';
  p1.resources.BZ = 20;
  state.maps['MAP008'].slots[0].push({ playerId: 'P2', dieId: 'occupant8', value: 3, seq: 1, countsForTurnOrder: true });
  state.maps['MAP009'].slots[0].push({ playerId: 'P2', dieId: 'occupant9', value: 3, seq: 1, countsForTurnOrder: true });
  const die = giveDie(state, 'P1', 5);
  const moves = moveGeneratorLv4.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('開拓者, both occupied (tie): 王宮 is kept', offersMapId(moves, die.id, 'MAP008'));
  assertTrue('開拓者, both occupied (tie): 元老院 is dropped', !offersMapId(moves, die.id, 'MAP009'));
}

{
  // Scoped to rounds 1-2 only (2026-08-28 follow-up: "元老院と王宮どちらも置けるときに王宮にするという
  // のは 1-2R限定の話です") -- from round 3 on, preferCastleOverSenate is a complete no-op and both
  // areas stay full, independent candidates, same as the unpoliced generator.
  const state = freshStateWithShops();
  state.round = 3;
  player(state, 'P1').resources.BZ = 20;
  const die = giveDie(state, 'P1', 5);
  const moves = moveGeneratorLv4.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  assertTrue('Round 3+: 王宮 is still offered', offersMapId(moves, die.id, 'MAP008'));
  assertTrue('Round 3+: 元老院 is NOT dropped -- the preference no longer applies', offersMapId(moves, die.id, 'MAP009'));
}

// ---------------------------------------------------------------------------
// #wildcardPlaceDieMoves' EX-vs-ANY choice (2026-08-28, see board.wildcardExAnyChoice's own doc): a ☆
// die offers BOTH slots as separate Moves when the player's own empty EX slot and an empty non-EX slot
// are both available at an AREA, instead of a single slotIndex-less Move. AREA003B/城下町LV1 has
// SLOT1=ANY, SLOT2=EX -- a clean 2-slot mixed layout (same fixture as board.smoke.js's own test).
// ---------------------------------------------------------------------------
{
  const state = freshStateWithShops();
  const p1 = player(state, 'P1');
  const wildInst = createCardInstance('JOB003');
  wildInst.ownerId = 'P1';
  state.cards[wildInst.physicalId] = wildInst;
  p1.ownedCardPhysicalIds.push(wildInst.physicalId);
  state.maps.MAP003.currentAreaId = 'AREA003B';
  state.maps.MAP003.feeOwnerId = 'P1';
  const die = giveDie(state, 'P1', 4);

  const moves = moveGenerator.generateMoves(state, index, 'P1', { hasPlacedDieThisTurn: false });
  const wildcardMoves = moves.filter((m) => m.type === 'PLACE_WILDCARD_DIE' && m.dieId === die.id && m.mapId === 'MAP003');
  assertTrue('Both the ANY slot (index 0) and the EX slot (index 1) are offered as separate Moves', wildcardMoves.some((m) => m.slotIndex === 0) && wildcardMoves.some((m) => m.slotIndex === 1));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
