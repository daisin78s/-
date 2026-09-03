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
// 評価値_CON's real "D"(追加色ダイス, renamed from "色ダイス" 2026-08-28)x"憤怒" cell is currently blank --
// patches a synthetic non-zero value onto that one cell (every other cell left as-is) purely so the
// conBuildAware color-dice test below can exercise that row at all; the card-row ("双星の加護LV1"x
// "憤怒") test doesn't need a patch since that cell is already the real -200 that motivated wiring
// 評価値_CON in to begin with.
raw['評価値_CON'].find((r) => r.NAME === 'D').憤怒 = -7;
// monument-incentive.js's COMBO_TARGETS rows (2026-09-03, per user request: "大いなる導きLV2 や 運命の
// 導きLV1 2 宮廷人 などの複合でもAIが判断できるように") don't exist in the real 評価値_戦略 sheet yet (the
// user still needs to add them in game.xlsx with real per-round point values) -- synthetic placeholder
// rows patched in here (same pattern as 評価値_CON's own patch just above) purely so the combo tests below
// can exercise the new reachability logic against a real, nonzero incentive value.
for (const name of ['複合ダイス強化で天空の塔を獲得', '複合ダイス強化で凱旋門を獲得', '複合ダイス強化で騎士像を獲得', '複合ダイス強化で鐘楼を獲得', '複合ダイス強化で宮殿を獲得', '複合ダイス強化で施療院を獲得']) {
  raw['評価値_戦略'].push({ NAME: name, '1R': '', '2R': '', '3R': '', '4R': 999 });
}
const evalTable = buildEvalTable(raw);
const evaluator = new Evaluator(index, evalTable);
const evaluatorQstAware = new Evaluator(index, evalTable, { qstAware: true }); // see AI LV3's own doc in main.js
const evaluatorConBuildAware = new Evaluator(index, evalTable, { conBuildAware: true }); // see AI LV4's own doc in main.js
const evaluatorMonumentIncentiveAware = new Evaluator(index, evalTable, { monumentIncentiveAware: true }); // see AI LV4's own doc in main.js

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
// Base resources + unplaced dice, round 1: K=3, A=5, VP=1, D=50, wD=10 per the current sheet
// (VP's own round-1 weight was lowered from 10 to 1, 2026-09-02, per user request).
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

  const expected = 2 * 3 + 1 * 5 + 1 * 1 + 1 * 50 + 1 * 10; // K + A + VP + unplaced D + unplaced wD
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
// M001 has eval-table value 0 (all rounds) and printed VP 4 -- contributes 4 * VP-weight(round 2) = 40.
// Checked at round 2 rather than round 1 (2026-09-02): round 1's own VP-weight was lowered from 10 to 1
// (per user request, following empirical AI-battle data showing a round-1-monument-build strategy had a
// notably low win rate) -- at weight 1, "4 * VP-weight" and "the raw VP count" are numerically identical
// (both 4), so the round-1 case could no longer actually distinguish the two; round 2's own weight was
// also later lowered, 12->10 (2026-09-02, same reason: round-2-monument-build also had a low win rate),
// but 10 still keeps the round-1-vs-weighted distinction meaningful (4 vs 40).
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
  const state = freshState(2);
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
  check('An opponent who can already afford M012 right now subtracts its would-be value from the score', withM012Risk, withoutM012Risk - (0 /* M012's own eval-table value */ + 6 * 1 /* VP=6 * round-1 VP weight (lowered from 10 to 1, 2026-09-02) */));
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
  check('qstAware credits the rank-1 REWARD1 (ADD(4VP)) on top of the normal score', evaluatorQstAware.score(state, 'P1'), 30 + 4 * 1 /* round-1 VP weight, lowered from 10 to 1, 2026-09-02 */);
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

// ---------------------------------------------------------------------------
// conBuildAware (2026-08-28, "AI LV4" only -- see Evaluator's own doc and con-build-synergy.js for the
// motivating bug report): 評価値_CON's real "双星の加護LV1"x"憤怒" cell is -1000 (2026-08-30, raised from
// -200 as part of a broader spreadsheet rebalance -- see 評価値 round-3 weights' own comment further down
// for the sibling change from that same pass); a 憤怒 (CON005B) player owning B201A (双星の加護LV1,
// eval=100 round2, VP=0) should score 100 + (-1000), not just 100.
// ---------------------------------------------------------------------------
{
  const state = freshState(2);
  const p1 = state.players[0];
  p1.conPhysicalId = 'CON005';
  p1.conFace = 'B'; // CON005B/憤怒
  giveCard(state, 'B201A', 'P1');
  const plainScore = evaluator.score(state, 'P1');
  check('The plain (non-conBuildAware) Evaluator ignores 評価値_CON entirely (control)', plainScore, 100);
  check('conBuildAware applies 評価値_CON\'s -1000 for 憤怒 x 双星の加護LV1 on top of the normal eval-table value', evaluatorConBuildAware.score(state, 'P1'), 100 - 1000);
}

{
  // Same pairing, but the LV2-upgraded face (B201B, eval=50 round2, VP=1) -- still matches 評価値_CON's
  // LV1-named row via normalizeToLv1Name (per user confirmation: the penalty is just as real post-upgrade).
  const state = freshState(2);
  const p1 = state.players[0];
  p1.conPhysicalId = 'CON005';
  p1.conFace = 'B';
  giveCard(state, 'B201B', 'P1');
  const plainScore = evaluator.score(state, 'P1');
  check('Control: plain Evaluator score for the LV2 face', plainScore, 50 + 1 * 10); // VP-weight(round2)=10, lowered from 12 on 2026-09-02
  check('conBuildAware still applies the LV1 row\'s -1000 to the LV2-upgraded card', evaluatorConBuildAware.score(state, 'P1'), (50 + 1 * 10) - 1000);
}

{
  // "色ダイス" row = "追加色ダイス" (2026-08-28, per user clarification: "色ダイスは追加色ダイスのこと
  // です" -- only color dice PAST the 5-die baseline count, "何で得た分か追跡不要です"). Patched to -7
  // for 憤怒 (see this file's own raw['評価値_CON'] patch near the top -- the real cell is blank). 6 total
  // color dice = 1 additional (6-5) -- contributes 1 * -7, not 6 * -7.
  const state = freshState(2);
  const p1 = state.players[0];
  p1.conPhysicalId = 'CON005';
  p1.conFace = 'B';
  for (let i = 0; i < 6; i++) p1.dice.push(createDie(`cd${i}`, 'COLOR'));
  const plainScore = evaluator.score(state, 'P1');
  check('conBuildAware\'s 追加色ダイス penalty applies only to the 1 die past the 5-die baseline', evaluatorConBuildAware.score(state, 'P1'), plainScore - 7);
}

{
  // Exactly at the baseline (5) -- 0 additional color dice, no adjustment at all.
  const state = freshState(2);
  const p1 = state.players[0];
  p1.conPhysicalId = 'CON005';
  p1.conFace = 'B';
  for (let i = 0; i < 5; i++) p1.dice.push(createDie(`cd${i}`, 'COLOR'));
  check('Exactly at the 5-die baseline: no 追加色ダイス adjustment', evaluatorConBuildAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}

{
  // conBuildAware is a genuine no-op before CON is chosen (conFace still null, e.g. mid-onboarding) --
  // must not throw, and must match the plain Evaluator exactly.
  const state = freshState(2);
  giveCard(state, 'B201A', 'P1');
  check('conBuildAware with no CON face chosen yet behaves exactly like the plain Evaluator', evaluatorConBuildAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}

// ---------------------------------------------------------------------------
// monumentIncentiveAware (2026-08-29, "AI LV4" only -- see Evaluator's own doc and monument-incentive.js
// for the motivating report). Expected numbers below are pulled straight from the current 評価値_戦略
// sheet, same convention as this file's own top-of-file note for the main 評価値 sheet -- re-check if the
// sheet changes.
// ---------------------------------------------------------------------------
{
  // 宮廷人(JOB007)の実際のTAPは+3 (2026-09-02, monument-incentive.js's SINGLE_DIE_ROWS own bonus was
  // fixed from a stale 1 -- see that file's own comment) -- needs an unplaced die showing exactly 4
  // (4+3=7=施療院/M006's own DICE threshold).
  const state = freshState(3);
  giveCard(state, 'JOB007', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 4;
  state.players[0].dice.push(d1);
  const plainScore = evaluator.score(state, 'P1');
  check('plain Evaluator ignores 評価値_戦略 entirely (control)', plainScore, evaluator.score(state, 'P1'));
  check('monumentIncentiveAware credits 宮廷人+1施療院 (round3=200) with a qualifying die=4', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 200);
}
{
  // Same setup, but die=3 -- 3+3=6, doesn't reach 施療院's >=7 -- no credit.
  const state = freshState(3);
  giveCard(state, 'JOB007', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 3;
  state.players[0].dice.push(d1);
  check('No credit when the die value is 1 short of what 宮廷人\'s +1 needs', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // Same setup (die=4), but 宮廷人 already tapped this round -- the ability isn't available, no credit.
  const state = freshState(3);
  const inst = giveCard(state, 'JOB007', 'P1');
  inst.tapped = true;
  const d1 = createDie('d1', 'COLOR');
  d1.value = 4;
  state.players[0].dice.push(d1);
  check('No credit once 宮廷人 is already tapped', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // Same setup (die=4, untapped), but 施療院 has already been built by someone -- no longer unclaimed.
  const state = freshState(3);
  giveCard(state, 'JOB007', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 4;
  state.players[0].dice.push(d1);
  const built = createCardInstance('M006');
  built.ownerId = 'P1';
  state.cards[built.physicalId] = built;
  check('No credit once 施療院 is already claimed (by anyone)', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // Same setup (die=4), but at round 1 -- 評価値_戦略's own 1R column is blank(0) for this row, so the
  // condition being true still contributes nothing (round-gating lives in the sheet, not extra code).
  const state = freshState(1);
  giveCard(state, 'JOB007', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 4;
  state.players[0].dice.push(d1);
  check('No credit at round 1 (sheet\'s own 1R column is blank for this row)', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // 運命の導きLV2(B003B)の実際のTAPは+4 (2026-09-02, same stale-bonus fix as 宮廷人 above -- was 3) --
  // needs die=5 (5+4=9=凱旋門/M004's own DICE threshold). Also confirms an owned card (not a JOB) is
  // matched the same way as 宮廷人 above.
  const state = freshState(4);
  giveCard(state, 'B003B', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 5;
  state.players[0].dice.push(d1);
  const plainScore = evaluator.score(state, 'P1');
  check('monumentIncentiveAware credits 運命の導きLV2+3凱旋門 (round4=300)', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 300);
}

// ---------------------------------------------------------------------------
// COMBO_TARGETS (2026-09-03, per user request: "大いなる導きLV2 や 運命の導きLV1 2 宮廷人 などの複合でも
// AIが判断できるように") -- stacking 2+ die-boosting TAPs onto the SAME die. Synthetic 999-point rows
// patched into raw['評価値_戦略'] at the top of this file stand in for the real point values (not yet
// added to game.xlsx) -- only the reachability logic is under test here.
// ---------------------------------------------------------------------------
{
  // The user's own headline example: 宮廷人(+3) + 運命の導きLV2(+4) = +7, on a real die=6 -> 13, exactly
  // 天空の塔/M403's own DICE threshold. Neither ability alone gets remotely close (max single delta is
  // 4, from 運命の導きLV2), so this only fires through the new combo path.
  const state = freshState(4);
  giveCard(state, 'JOB007', 'P1');
  giveCard(state, 'B003B', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 6;
  state.players[0].dice.push(d1);
  const plainScore = evaluator.score(state, 'P1');
  check('monumentIncentiveAware credits 宮廷人+運命の導きLV2 combo -> 天空の塔 (die=6, +3+4=13)', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 999);
}
{
  // Same die (=6), but only 宮廷人 owned (no second die-boosting card) -- exactly 1 die-boost source, so
  // the combo gate (needs 2+) blocks it entirely. (宮廷人 alone would need die=4 for its own M006 row --
  // die=6 doesn't satisfy that either, so this is a clean "no credit anywhere" case.)
  const state = freshState(4);
  giveCard(state, 'JOB007', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 6;
  state.players[0].dice.push(d1);
  check('No combo credit with only 1 die-boosting card owned (gate requires 2+)', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // 大いなる導きLV2(B002B, SET to 6|7) + 運命の導きLV1(B003A, +2): reachable = {6+2, 7+2} = {8, 9} ->
  // 宮殿/M005 (>=8) AND 凱旋門/M004 (>=9) both look individually reachable, but the SET only fixes ONE
  // real die to ONE of its 2 choices -- only the higher-priority target (凱旋門, listed first in
  // COMBO_TARGETS) should actually credit, not both. Die's own real value (1) is irrelevant here since
  // SET_DIE_VALUE overwrites it -- just needs to exist, unplaced.
  const state = freshState(4);
  giveCard(state, 'B002B', 'P1');
  giveCard(state, 'B003A', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 1;
  state.players[0].dice.push(d1);
  const plainScore = evaluator.score(state, 'P1');
  check('monumentIncentiveAware credits 大いなる導きLV2+運命の導きLV1 combo -> only 凱旋門, not also 宮殿', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 999);
}
{
  // Same setup, but 大いなる導きLV2 already tapped -- only 1 usable source (運命の導きLV1 alone) left,
  // gate blocks it (and 運命の導きLV1 alone doesn't reach anything at die=1 either: 1+2=3, no target).
  const state = freshState(4);
  const setInst = giveCard(state, 'B002B', 'P1');
  setInst.tapped = true;
  giveCard(state, 'B003A', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 1;
  state.players[0].dice.push(d1);
  check('No combo credit once the SET ability is already tapped (back down to 1 source)', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // Same combo (宮廷人+運命の導きLV2, die=6, reaches 天空の塔) but the monument was already claimed --
  // no longer unclaimed, no credit.
  const state = freshState(4);
  giveCard(state, 'JOB007', 'P1');
  giveCard(state, 'B003B', 'P1');
  const d1 = createDie('d1', 'COLOR');
  d1.value = 6;
  state.players[0].dice.push(d1);
  const built = createCardInstance('M403');
  built.ownerId = 'P1';
  state.cards[built.physicalId] = built;
  check('No combo credit once 天空の塔 is already claimed (by anyone)', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}

{
  // 歓楽街の支配LV2(A006B) + 王都建設(M402, COST=5A,5B,5C -> 15 units -> needs 2*15=30K held).
  const state = freshState(3);
  giveCard(state, 'A006B', 'P1');
  state.players[0].resources.K = 30;
  const plainScore = evaluator.score(state, 'P1');
  check('monumentIncentiveAware credits 歓楽街LV2+王都建設 (round3=500) with exactly 30K held', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 500);
}
{
  // Same setup, but only 11K -- below even the group's cheapest threshold (凱旋門's own 2*6=12) -- no
  // row in the group can possibly credit anything.
  const state = freshState(3);
  giveCard(state, 'A006B', 'P1');
  state.players[0].resources.K = 11;
  check('No credit anywhere in the 歓楽街LV2 group with K below every target\'s own threshold', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // 30K clears every target's threshold at once, but an opponent can already snipe 王都建設 (and, at
  // this die value, also 聖王城/円形闘技場 -- die>=their own lower thresholds too) right now -- per user
  // spec ("他プレイヤーの動向も見る"), this suppresses 王都建設's own credit specifically. Per priority
  // order, the group then falls back to 中央広場 (DICE>=6, the opponent's die=5 doesn't reach it -- not
  // at risk), the next-highest-priority target P1's own 30K still clears -- "そうでなければとれるものを
  // とる": a target actually safe to hold for still credits, even though the very top choice doesn't.
  const state = freshState(3);
  state.players.push(createPlayer('P2', 'Bob'));
  giveCard(state, 'A006B', 'P1');
  state.players[0].resources.K = 30;
  const opponentDie = createDie('opp-d1', 'COLOR');
  opponentDie.value = 5; // meets M402/M008/M009's own DICE thresholds (5/5/4), not M007's (6) or M004's (9)
  state.players[1].dice.push(opponentDie);
  state.players[1].resources = { ...state.players[1].resources, A: 5, B: 5, C: 5 };
  const plainScore = evaluator.score(state, 'P1');
  check('王都建設 itself gets no credit while at risk, but the group falls back to 中央広場 (round3=300)', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 300);
}
{
  // Same risk, but P1 only holds 18K -- exactly enough for 中央広場 (2*9), not for anything above it in
  // priority order that could have masked the fallback. Isolates the fallback-credit path more directly.
  const state = freshState(3);
  state.players.push(createPlayer('P2', 'Bob'));
  giveCard(state, 'A006B', 'P1');
  state.players[0].resources.K = 18;
  const opponentDie = createDie('opp-d1', 'COLOR');
  opponentDie.value = 5;
  state.players[1].dice.push(opponentDie);
  state.players[1].resources = { ...state.players[1].resources, A: 5, B: 5, C: 5 };
  const plainScore = evaluator.score(state, 'P1');
  check('With exactly 18K (only 中央広場 reachable), credits 中央広場 (round3=300) directly', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 300);
}
{
  // Same 18K, but the opponent's die is 9 -- meets every one of the group's 5 own DICE thresholds at
  // once (max is 凱旋門's own >=9) -- combined with A=5,B=5,C=5 covering every target's own COST too,
  // every target P1's 18K could otherwise reach (中央広場 directly, 凱旋門 as a would-be fallback) is at
  // risk simultaneously -- no credit anywhere in the group.
  const state = freshState(3);
  state.players.push(createPlayer('P2', 'Bob'));
  giveCard(state, 'A006B', 'P1');
  state.players[0].resources.K = 18;
  const opponentDie = createDie('opp-d1', 'COLOR');
  opponentDie.value = 9;
  state.players[1].dice.push(opponentDie);
  state.players[1].resources = { ...state.players[1].resources, A: 5, B: 5, C: 5 };
  check('No credit anywhere once the opponent can snipe every target P1\'s K could reach', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // 農園または小麦畑の支配(いずれか) + 13K以上保有 (round3=100). Confirms 小麦畑 (A004A) counts the same
  // as 農園 itself, per "小麦畑も農園と同じ扱い".
  const state = freshState(3);
  giveCard(state, 'A004A', 'P1');
  state.players[0].resources.K = 13;
  const plainScore = evaluator.score(state, 'P1');
  check('monumentIncentiveAware credits the 13K row via 小麦畑の支配LV1 (round3=100)', evaluatorMonumentIncentiveAware.score(state, 'P1'), plainScore + 100);
}
{
  // Same setup, but only 12K -- 1 short -- no credit.
  const state = freshState(3);
  giveCard(state, 'A004A', 'P1');
  state.players[0].resources.K = 12;
  check('No credit for the 13K row with 1K short', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}
{
  // monumentIncentiveAware is a genuine no-op with none of the qualifying cards owned at all.
  const state = freshState(3);
  state.players[0].resources.K = 999;
  const d1 = createDie('d1', 'COLOR');
  d1.value = 6;
  state.players[0].dice.push(d1);
  check('monumentIncentiveAware with no qualifying cards owned behaves exactly like the plain Evaluator', evaluatorMonumentIncentiveAware.score(state, 'P1'), evaluator.score(state, 'P1'));
}

// ---------------------------------------------------------------------------
// M401/晩餐会's own VP_MODIFIER_FINAL(PER(K,1),10) (2026-09-01, per user spec: "ゲーム終了時にVPが
// プラスされることはAIが把握できるようにしてください" while also confirming a mid-game hoarding
// incentive should NOT exist) -- the Evaluator must score this as exactly 0 for any non-GAME_END state
// (no reward for holding K early) but the real, round-4-VP-weighted value once state.phase is actually
// 'GAME_END' (reachable via AIPlayer's own round-4 rollout once this player's last die is spent).
// ---------------------------------------------------------------------------
{
  const state = freshState(4);
  giveCard(state, 'M401', 'P1');
  state.players[0].resources.K = 9;

  state.phase = 'ROUND';
  const midGameScore = evaluator.score(state, 'P1');

  state.phase = 'GAME_END';
  const atEndScore = evaluator.score(state, 'P1');

  const bonusVp = 9; // well under the 10VP cap
  check('Reaching the real GAME_END adds exactly 9K -> 9VP, weighted by round 4\'s own v(VP)=1000', atEndScore - midGameScore, bonusVp * 1000);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
