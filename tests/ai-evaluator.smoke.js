/**
 * Smoke test for src/ai/evaluator.js against real data. Expected numbers below are pulled straight
 * from the current "評価値" sheet (see ai-eval-table.smoke.js) plus each card's own printed VP column,
 * not re-derived independently -- if the sheet changes these must be re-checked, same as any other
 * data-driven test in this project.
 * Run: node tests/ai-evaluator.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { createEmptyGameState, createPlayer, createDie, createCardInstance } = require('../src/game-state');
const { buildEvalTable } = require('../src/ai/eval-table');
const { Evaluator } = require('../src/ai/evaluator');

const raw = loadGameData(path.join(__dirname, '..', 'data', 'game.json'));
const index = buildDataIndex(raw);
// CON005B used to carry TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7) before the 2026-08-13 CON rewrite (all
// new sin-themed names/abilities); no real card in the current dataset has RESOURCE_TOTAL_LIMIT at all
// anymore, so this patches a synthetic copy of it back onto CON005B's row (every other field left
// as-is) purely so the lockout-penalty tests below can keep exercising that still-real, still-used
// generic engine mechanism against an actual ownable card id.
index.byId.set('CON005B', { sheet: 'CON', row: { ...index.byId.get('CON005B').row, TURNEND: 'RESOURCE_TOTAL_LIMIT((A,B,C),7)' } });
const evalTable = buildEvalTable(raw);
const evaluator = new Evaluator(index, evalTable);
const evaluatorQstAware = new Evaluator(index, evalTable, { qstAware: true }); // see AI LV3's own doc in main.js

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

function freshState(round) {
  const state = createEmptyGameState('evaluator-smoke');
  state.round = round;
  const p1 = createPlayer('P1', 'Alice');
  state.players.push(p1);
  return state;
}

// ---------------------------------------------------------------------------
// Base resources + unplaced dice, round 1: K=3, A=5, VP=10, D=50, wD=10 per the current sheet.
// ---------------------------------------------------------------------------
{
  const state = freshState(1);
  const p1 = state.players[0];
  p1.resources.K = 2;
  p1.resources.A = 1;
  p1.resources.VP = 1;
  const colorDie = createDie('d1', 'COLOR');
  const whiteDie = createDie('d2', 'WHITE');
  p1.dice.push(colorDie, whiteDie);

  const expected = 2 * 3 + 1 * 5 + 1 * 10 + 1 * 50 + 1 * 10; // K + A + VP + unplaced D + unplaced wD
  check('Score sums resources + unplaced dice using round-1 eval-table weights', evaluator.score(state, 'P1'), expected);
}

// ---------------------------------------------------------------------------
// A passed color die (2026-08-03, see board.passDie) scores at v('K')*3, not the full v('D') --
// found via a real game trace (AI chose PASS_DIE 13 times vs PLACE_DIE once in one round): leaving a
// passed die at the full round-1 'D' weight (originally 40, now 50) made passing score *better* than
// almost any real placement (turn-flow.endRound's actual guaranteed payout for an unused color die is
// only 3K, i.e. v('K')*3 = 9), so the AI defaulted to passing instead of playing. White dice have no
// such guaranteed round-end conversion (only color dice do, see endRound's own code), so a passed wD
// keeps the normal 'wD' weight, unlike a passed color die.
// ---------------------------------------------------------------------------
{
  const state = freshState(1);
  const p1 = state.players[0];
  const unplacedDie = createDie('d1', 'COLOR');
  const passedDie = createDie('d2', 'COLOR');
  passedDie.passed = true;
  p1.dice.push(unplacedDie, passedDie);
  const expected = 1 * 50 + 1 * (3 * 3); // still-placeable D + passed die's guaranteed-3K-equivalent value
  check('A passed color die scores at its guaranteed round-end 3K value, not the full unplaced D weight', evaluator.score(state, 'P1'), expected);
}
{
  const state = freshState(1);
  const p1 = state.players[0];
  const passedWhiteDie = createDie('d1', 'WHITE');
  passedWhiteDie.passed = true;
  p1.dice.push(passedWhiteDie);
  check('A passed white die keeps the normal wD weight (no guaranteed round-end conversion exists for it)', evaluator.score(state, 'P1'), 10);
}

// ---------------------------------------------------------------------------
// A placed die contributes nothing (only *unplaced* dice count toward "value of holding one").
// ---------------------------------------------------------------------------
{
  const state = freshState(1);
  const p1 = state.players[0];
  const placedDie = createDie('d1', 'COLOR');
  placedDie.placedMapId = 'MAP001';
  p1.dice.push(placedDie);
  check('A placed die does not add to the score', evaluator.score(state, 'P1'), 0);
}

// ---------------------------------------------------------------------------
// Owned cards: A001A has eval-table value 30 (round 1) and printed VP 0 -- contributes exactly 30.
// M001 has eval-table value 0 (all rounds) and printed VP 4 -- contributes 4 * VP-weight(round 1) = 40.
// ---------------------------------------------------------------------------
function giveCard(state, faceId, playerId) {
  const inst = createCardInstance(faceId);
  inst.ownerId = playerId;
  state.cards[inst.physicalId] = inst;
  state.players.find((p) => p.id === playerId).ownedCardPhysicalIds.push(inst.physicalId);
  return inst;
}
{
  const state = freshState(1);
  giveCard(state, 'A001A', 'P1');
  check('Owned A001A (eval=30, VP=0) contributes exactly its eval-table value', evaluator.score(state, 'P1'), 30);
}
{
  const state = freshState(1);
  giveCard(state, 'M001', 'P1');
  check('Owned M001 (eval=0, VP=4) contributes 4 * VP-weight, not the raw VP count', evaluator.score(state, 'P1'), 40);
}

// ---------------------------------------------------------------------------
// Round sensitivity: the same holdings score differently across rounds, since weights (esp. D and VP)
// are round-dependent -- this is the whole point of a per-round eval table.
// ---------------------------------------------------------------------------
{
  const round1 = freshState(1);
  round1.players[0].resources.VP = 5;
  const round4 = freshState(4);
  round4.players[0].resources.VP = 5;
  check('The same 5 VP scores higher in round 4 than round 1 (VP weight climbs toward endgame)', evaluator.score(round4, 'P1') > evaluator.score(round1, 'P1'), true);
}

// ---------------------------------------------------------------------------
// Unknown/missing player returns 0 rather than throwing.
// ---------------------------------------------------------------------------
{
  const state = freshState(1);
  check('Scoring a nonexistent playerId returns 0', evaluator.score(state, 'NO_SUCH_PLAYER'), 0);
}

// ---------------------------------------------------------------------------
// Monument-sniping risk (2026-08-04, per user feedback: "そのモニュメントとられるかもは相手のダイス
// と資源が今足りているかで判断するようにしてください"): a monument still in the M shop that an
// opponent can already build right now (die value >= its DICE threshold, resources >= its COST)
// subtracts its would-be-owned value from this player's score. M012 (DICE=">=1", COST="13C", VP=6) is
// used since its threshold-1 requirement is satisfiable by any real die value (1-6) without needing the
// castle's multi-die accumulation this simple check doesn't model.
// ---------------------------------------------------------------------------
function stateWithM012InShop(round) {
  const state = freshState(round);
  const p2 = createPlayer('P2', 'Bob');
  state.players.push(p2);
  state.shops.M = { slots: { M1: 'M012' } };
  return state;
}
{
  const state = stateWithM012InShop(1);
  const p2 = state.players[1];
  const die = createDie('d1', 'COLOR');
  die.value = 3; // >= M012's threshold of 1
  p2.dice.push(die);
  p2.resources.C = 13; // M012's full COST
  const withoutM012Risk = evaluator.score(freshState(1), 'P1'); // 0, no cards/resources/dice at all
  const withM012Risk = evaluator.score(state, 'P1');
  check('An opponent who can already afford M012 right now subtracts its would-be value from the score', withM012Risk, withoutM012Risk - (0 /* M012's own eval-table value */ + 6 * 10 /* VP=6 * round-1 VP weight */));
}
{
  const state = stateWithM012InShop(1);
  const p2 = state.players[1];
  const die = createDie('d1', 'COLOR');
  die.value = 3;
  p2.dice.push(die);
  p2.resources.C = 12; // 1 short of M012's 13C cost
  check('An opponent who has a qualifying die but NOT enough resources is not "at risk"', evaluator.score(state, 'P1'), evaluator.score(freshState(1), 'P1'));
}
{
  const state = stateWithM012InShop(1);
  const p2 = state.players[1];
  p2.resources.C = 13; // affordable, but no die at all
  check('An opponent with enough resources but no unplaced die is not "at risk"', evaluator.score(state, 'P1'), evaluator.score(freshState(1), 'P1'));
}
{
  // The scoring player's OWN dice/resources never count as "opponent risk" against themselves --
  // compares the same P1 holdings with vs without M012 actually sitting in the shop; if self-risk were
  // (incorrectly) triggered, the "M012 in shop" version would score lower.
  function stateWithP1QualifyingHand(includeM012InShop) {
    const state = freshState(1);
    if (includeM012InShop) state.shops.M = { slots: { M1: 'M012' } };
    const p1 = state.players[0];
    const die = createDie('d1', 'COLOR');
    die.value = 3;
    p1.dice.push(die);
    p1.resources.C = 13;
    return state;
  }
  check(
    'This player having what it takes themselves is not treated as "at risk" against themselves',
    evaluator.score(stateWithP1QualifyingHand(true), 'P1'),
    evaluator.score(stateWithP1QualifyingHand(false), 'P1'),
  );
}

// ---------------------------------------------------------------------------
// Turn-end lockout penalty (2026-08-10, per user report: a greedy AI holding CON005B
// (TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7)) converted huge piles of K into A/B/C, then got stuck unable
// to end its turn for the rest of the round -- see Evaluator's own comment on this block).
// ---------------------------------------------------------------------------
{
  const state = freshState(1);
  const p1 = state.players[0];
  giveCard(state, 'CON005B', 'P1');
  p1.resources.A = 3;
  p1.resources.B = 2;
  p1.resources.C = 2; // total 7 -- exactly at CON005B's limit, not over it
  const expected = 3 * 5 + 2 * 5 + 2 * 5; // CON005B itself contributes 0 (eval=0, no printed VP)
  check('At exactly the RESOURCE_TOTAL_LIMIT (7), no lockout penalty applies', evaluator.score(state, 'P1'), expected);
}
{
  const state = freshState(1);
  const p1 = state.players[0];
  giveCard(state, 'CON005B', 'P1');
  p1.resources.A = 4;
  p1.resources.B = 2;
  p1.resources.C = 2; // total 8 -- 1 over CON005B's limit of 7
  const expected = 4 * 5 + 2 * 5 + 2 * 5 - 1000; // same holdings, minus the flat lockout penalty
  check('One unit over the RESOURCE_TOTAL_LIMIT, the 1000-point lockout penalty applies', evaluator.score(state, 'P1'), expected);
}
{
  const state = freshState(1);
  const p1 = state.players[0];
  p1.resources.A = 40; // huge pile, but no RESOURCE_TOTAL_LIMIT-granting card owned at all
  check('Large resource totals alone (no RESOURCE_TOTAL_LIMIT card owned) never trigger the lockout penalty', evaluator.score(state, 'P1'), 40 * 5);
}
{
  // Unpaid, currently-unaffordable USAGE_FEE also blocks canEndTurn (executor.canEndTurn checks both) --
  // confirms the penalty isn't hardcoded to RESOURCE_TOTAL_LIMIT specifically. p1.resources.A=1 (2026-08-27:
  // genuinely zero of every convertible resource now escapes the block entirely via a VP deduction
  // instead -- see executor.canEndTurn's own doc -- so this needs at least one, still-insufficient unit
  // to keep demonstrating a real lockout).
  const state = freshState(1);
  const p1 = state.players[0];
  p1.pendingFee = { mapId: 'MAP001', amount: 2 };
  p1.resources.K = 0; // can't cover the 2K fee
  p1.resources.A = 1; // present but insufficient -- doesn't trigger the VP-escape
  check('An unpayable pending USAGE_FEE also triggers the lockout penalty', evaluator.score(state, 'P1'), -1000 + 1 * 5);
}

// ---------------------------------------------------------------------------
// RESOURCE_LIMIT-aware resource scoring (2026-08-10, per user request: "K MAX7の時 1K+7Kで8Kになるのは
// 減らして7Kとして評価"): a resource held past an owned card's RESOURCE_LIMIT cap scores at its true
// post-TURNEND-clamp amount, not its raw current count -- the excess is worthless (auto-discarded, see
// executor.applyTurnEnd), so scoring it at face value overstates the gain.
// ---------------------------------------------------------------------------
{
  const state = freshState(1);
  giveCard(state, 'CON006A', 'P1'); // 暴食: TURNEND=RESOURCE_LIMIT(K,7), eval-table value 0, no printed VP -- moved from CON001A to CON006A (2026-08-17 CON sheet renumbering)
  const p1 = state.players[0];
  p1.resources.K = 8; // 1 over CON006A's limit of 7
  check('K clamped to CON006A\'s RESOURCE_LIMIT(K,7) cap (8 -> 7) when scoring', evaluator.score(state, 'P1'), 7 * 3);
}
{
  const state = freshState(1);
  const p1 = state.players[0];
  p1.resources.K = 8; // same 8K, but no RESOURCE_LIMIT-granting card owned at all
  check('Without a RESOURCE_LIMIT card owned, the same 8K scores at its raw, uncapped value', evaluator.score(state, 'P1'), 8 * 3);
}
{
  // The illustrative comparison itself: +7K (1->8, clamped to 7) should still outscore +3K (1->4, no
  // clamp needed) -- clamping to the true post-TURNEND value doesn't flip which option is better, it
  // just stops overstating the wasted excess.
  const withPlus7 = freshState(1);
  giveCard(withPlus7, 'CON006A', 'P1');
  withPlus7.players[0].resources.K = 8;
  const withPlus3 = freshState(1);
  giveCard(withPlus3, 'CON006A', 'P1');
  withPlus3.players[0].resources.K = 4;
  check(
    '+7K (clamped to 7) still scores higher than +3K (4), just not overstated as if it kept all 8',
    evaluator.score(withPlus7, 'P1') > evaluator.score(withPlus3, 'P1'),
    true,
  );
}

// ---------------------------------------------------------------------------
// QST awareness (2026-08-10, opt-in via policy.qstAware -- "AI LV3" only, per user request "AI LV3は
// QSTカードに対応してVPを稼ぐようにしたい"). Synthetic QST data injected into index.raw.QST (same
// pattern as tests/qst.smoke.js) so this stays fixed regardless of what the real QST sheet says.
// ---------------------------------------------------------------------------
index.raw.QST = [
  { ID: 'Q001A', NAME: 'Q001A', GOAL: 'CARD_COUNT', REWARD1: 'ADD(4VP)', REWARD2: 'ADD(2VP)', REWARD3: 'ADD(VP)', INST: '' },
];
{
  const state = freshState(1);
  const p2 = createPlayer('P2', 'Bob');
  state.players.push(p2);
  state.quests = { Q001A: true };
  giveCard(state, 'A001A', 'P1'); // eval=30, VP=0 -- CARD_COUNT=1, ahead of P2's 0
  const plainScore = evaluator.score(state, 'P1');
  check('The plain (non-qstAware) Evaluator ignores QST entirely (control)', plainScore, 30);
  check('qstAware credits the rank-1 REWARD1 (ADD(4VP)) on top of the normal score', evaluatorQstAware.score(state, 'P1'), 30 + 4 * 10);
}
{
  // Rank 4+ (only reachable with 4 players at 4 distinct values) earns nothing -- REWARD_FIELDS only
  // has 3 slots (see qst.js's own doc).
  const state = freshState(1);
  const p2 = createPlayer('P2', 'Bob');
  const p3 = createPlayer('P3', 'Carol');
  const p4 = createPlayer('P4', 'Dan');
  state.players.push(p2, p3, p4);
  state.quests = { Q001A: true };
  // createCardInstance derives physicalId deterministically from faceId (see game-state.js's
  // splitCardId) -- giving the SAME faceId to two players in one state would collide (the 2nd giveCard
  // call just reassigns the 1st's ownerId, silently "moving" it rather than creating a 2nd copy), so
  // every card below is a distinct faceId even though several are otherwise-identical-shaped A cards.
  giveCard(state, 'A001A', 'P1'); // 1 card -- fewest of the four, so last place
  giveCard(state, 'A002A', 'P2');
  giveCard(state, 'A003A', 'P2'); // 2 cards
  giveCard(state, 'A004A', 'P3');
  giveCard(state, 'A005A', 'P3');
  giveCard(state, 'A006A', 'P3'); // 3 cards
  giveCard(state, 'A201A', 'P4');
  giveCard(state, 'A202A', 'P4');
  giveCard(state, 'B001A', 'P4');
  giveCard(state, 'M001', 'P4'); // 4 cards (CARD_COUNT includes M) -- clear 1st
  check('P1, ranked last (4th) among 4 distinct CARD_COUNT values, gets no QST credit', evaluatorQstAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
// index.raw === raw (buildDataIndex wraps the same object, doesn't copy it), and nothing below this
// point needs real QST data -- no restoration necessary (each tests/*.smoke.js file also runs in its
// own separate `node` process, so this mutation can't leak into any other test file either).

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
