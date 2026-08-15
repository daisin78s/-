/**
 * Smoke test: exercises Executor against real card data from data/game.json.
 * Not a full test suite (no framework, no assertions library) -- just prints
 * expected-vs-actual for a human to eyeball while the engine is still taking
 * shape. Run: node tests/executor.smoke.js
 */

'use strict';

const path = require('path');
const { loadGameData, buildDataIndex, getCardRow } = require('../src/data-loader');
const { createEmptyGameState, createPlayer, createMapState, createCardInstance, createDie, splitCardId, INITIAL_COLOR_DICE } = require('../src/game-state');
const executor = require('../src/executor');

const index = buildDataIndex(loadGameData(path.join(__dirname, '..', 'data', 'game.json')));

// CON005B used to carry TURNEND=RESOURCE_TOTAL_LIMIT((A,B,C),7) before the 2026-08-13 CON rewrite (all
// new sin-themed names/abilities); no real card in the current dataset has RESOURCE_TOTAL_LIMIT at all
// anymore, so this patches a synthetic copy of it back onto CON005B's row (every other field left
// as-is) purely so the tests below can keep exercising that still-real, still-used generic engine
// mechanism (canEndTurn's TOTAL_LIMIT gate) against an actual ownable card id.
index.byId.set('CON005B', { sheet: 'CON', row: { ...index.byId.get('CON005B').row, TURNEND: 'RESOURCE_TOTAL_LIMIT((A,B,C),7)' } });

let passCount = 0;
let failCount = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (ok) passCount++; else failCount++;
}

function freshState() {
  const state = createEmptyGameState('smoke-seed');
  state.players.push(createPlayer('P1', 'Alice'));
  return state;
}

/** Gives a card to a player as an owned, untapped instance at its base (tier-A-ish) face. */
function giveCard(state, faceCardId, ownerId) {
  const inst = createCardInstance(faceCardId);
  inst.ownerId = ownerId;
  state.cards[inst.physicalId] = inst;
  getPlayerRef(state, ownerId).ownedCardPhysicalIds.push(inst.physicalId);
  return inst.physicalId;
}
function getPlayerRef(state, id) { return state.players.find((p) => p.id === id); }
// runProgram() rolls back by replacing state's nested objects (players/dice/etc.) wholesale from a
// clone when a command fails -- any previously-cached reference (e.g. a `die` variable grabbed
// before the call) goes stale. Always re-fetch by id after a runProgram() call, as this does.
function getDieRef(state, playerId, dieId) { return getPlayerRef(state, playerId).dice.find((d) => d.id === dieId); }

// ---------------------------------------------------------------------------
// 1. CON001A: ONCE=ADD(6K), TURNEND=RESOURCE_LIMIT(K,7)
// ---------------------------------------------------------------------------
{
  const state = freshState();
  const physicalId = giveCard(state, 'CON001A', 'P1');
  const row = getCardRow(index, 'CON001A');
  const context = { playerId: 'P1', sourcePhysicalId: physicalId };

  executor.runProgram(state, index, context, row.ONCE);
  check('CON001A ONCE grants 6K', getPlayerRef(state, 'P1').resources.K, 6);

  getPlayerRef(state, 'P1').resources.K = 10; // simulate accumulating over the limit
  executor.applyTurnEnd(state, index, 'P1');
  check('CON001A TURNEND caps K at 7', getPlayerRef(state, 'P1').resources.K, 7);
}

// ---------------------------------------------------------------------------
// 1b. Usage fee is paid BEFORE RESOURCE_LIMIT's auto-discard (2026-08-11, per user report on CON001A:
//     "現在　上限7K→使用料を払う　になっています　使用料を払う→上限7K　に直してください" -- it used to
//     be the other way round, which wasted K to the discard that should have gone toward the fee
//     instead). 10K, CON001A's cap-7, and a 2K pending fee: paying first (10-2=8K) then capping (8-1=7K)
//     ends higher than capping first (10-3=7K) then paying (7-2=5K) would have.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  state.maps['MAP001'] = createMapState('MAP001', 'AREA001A');
  giveCard(state, 'CON001A', 'P1');
  const player = getPlayerRef(state, 'P1');
  player.resources.K = 10;
  player.pendingFee = { mapId: 'MAP001', amount: 2 };
  executor.applyTurnEnd(state, index, 'P1');
  check('Usage fee paid first, THEN capped to 7 (10-2=8, capped to 7) -- not capped-then-paid (would be 5)', getPlayerRef(state, 'P1').resources.K, 7);
  check('...and the fee itself was actually collected (pendingFee cleared)', getPlayerRef(state, 'P1').pendingFee, null);
  check('...landing on the map as accumulatedFee', state.maps['MAP001'].accumulatedFee, 2);
}

// ---------------------------------------------------------------------------
// 2. CON002A: PASSIVE=REPLACE_ADD(D,wD) forces ADD(D) -> ADD(wD)
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'CON002A', 'P1');
  const context = { playerId: 'P1' };
  executor.runCommand(state, index, context, { type: 'ADD', items: [{ resource: 'D', count: { kind: 'literal', value: 1 } }] });
  const player = getPlayerRef(state, 'P1');
  check(
    'CON002A REPLACE_ADD(D,wD) turns ADD(D) into a white die',
    { color: player.dice.filter((d) => d.kind === 'COLOR').length, white: player.dice.filter((d) => d.kind === 'WHITE').length },
    { color: 0, white: 1 }
  );
}

// ---------------------------------------------------------------------------
// 3. CON003A: PASSIVE=VP_PENALTY_IF_BELOW(EMBLEM_COUNT(天,M),2) (2026-08-15, per user spec: the card's
// original IF(CARD_COUNT<=6,VP_MODIFIER(-2)) clause is retired entirely -- "建築数が6以下で-2VPは廃止
// して" -- replaced outright by this monument-emblem shortfall rule, "モニュメント天エンブレムが2個
// 未満だと、不足1個につき-1VP" -- not added alongside the old clause). No M-sheet card is ever owned in
// this block, so EMBLEM_COUNT(天,M) stays 0 -> short 2 -> -2, regardless of how many other (non-M)
// cards this player owns.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'CON003A', 'P1');
  check('CON003A: no monuments -> EMBLEM_COUNT(天,M)=0, short 2 -> -2VP', executor.collectVpModifiers(state, index, 'P1'), -2);

  for (let i = 1; i <= 8; i++) giveCard(state, `A00${i}A`, 'P1'); // owning lots of non-M cards changes nothing
  check('CON003A: owning 8 more (non-M) cards does not affect the monument-only shortfall, still -2VP', executor.collectVpModifiers(state, index, 'P1'), -2);
}

// ---------------------------------------------------------------------------
// 3a. CON005A: PASSIVE=VP_PENALTY_PER(LEVEL_COUNT(1)) (2026-08-15, per user spec: "LV1のカード１枚に
// つき-1VP", correcting the card's original flat IF(LEVEL_COUNT(1)>=1,VP_MODIFIER(-2)) "any LV1 card at
// all -> flat -2" shape into a genuine per-card scale instead -- 0 LV1 cards -> 0VP, not still -2).
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'CON005A', 'P1');
  check('CON005A: no LV1 cards at all -> 0VP (not a flat -2)', executor.collectVpModifiers(state, index, 'P1'), 0);

  giveCard(state, 'A001A', 'P1'); // LEVEL=1
  check('CON005A: 1 LV1 card -> -1VP', executor.collectVpModifiers(state, index, 'P1'), -1);

  giveCard(state, 'A002A', 'P1');
  giveCard(state, 'A003A', 'P1'); // 3 LV1 cards total now
  check('CON005A: 3 LV1 cards -> -3VP (scales per card, not a flat threshold)', executor.collectVpModifiers(state, index, 'P1'), -3);
}

// ---------------------------------------------------------------------------
// 3b. B008B: PASSIVE=VP_MODIFIER(COUNT(天)) -- persistent, not a one-time ONCE snapshot (2026-08-12,
//     per user request: "即時ではなく永続効果にしたい" -- moved off ONCE precisely so it keeps
//     recomputing). Recomputed live from currently-owned 天-emblem cards every time
//     collectVpModifiers is called, same as computeFinalScore recomputes card VP live.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'B008B', 'P1'); // EMBLEM_B=2 -> already contributes 2 to COUNT(天) on its own
  check('B008B: VP_MODIFIER(COUNT(天)) starts at 2 (from B008B\'s own 2 EMBLEM_B)', executor.collectVpModifiers(state, index, 'P1'), 2);

  giveCard(state, 'B001A', 'P1'); // EMBLEM_B=1 -> +1 天
  check('B008B: VP_MODIFIER(COUNT(天)) rises to 3 as soon as another 天-emblem card is owned (live, not frozen at LVUP time)', executor.collectVpModifiers(state, index, 'P1'), 3);
}

// ---------------------------------------------------------------------------
// 4. JOB005: TAP=ON(GET(K),CHANGE(K,Z)), TURNEND=UNTAP()
// ---------------------------------------------------------------------------
{
  const state = freshState();
  const physicalId = giveCard(state, 'JOB005', 'P1');
  const player = getPlayerRef(state, 'P1');
  player.resources.K = 5;

  const { availableReactions } = executor.emit(state, index, 'P1', 'GET', 'K', { playerId: 'P1' });
  check('JOB005 offers a reaction on GET(K) while untapped', availableReactions.length, 1);

  const result = executor.resolveTapReaction(state, index, { playerId: 'P1' }, physicalId, availableReactions[0].effect);
  check('Tapping JOB005 runs CHANGE(K,Z): pays 1K', player.resources.K, 4);
  check('Tapping JOB005 runs CHANGE(K,Z): gains 1Z', player.resources.Z, 1);
  check('Tapping JOB005 taps the card', state.cards[physicalId].tapped, true);

  const secondTry = executor.emit(state, index, 'P1', 'GET', 'K', { playerId: 'P1' });
  check('JOB005 no longer offers a reaction once tapped', secondTry.availableReactions.length, 0);

  executor.applyTurnEnd(state, index, 'P1');
  check('JOB005 TURNEND=UNTAP() untaps it again', state.cards[physicalId].tapped, false);
}

// ---------------------------------------------------------------------------
// 5. (removed 2026-08-04) JOB008 used to be PASSIVE=MODIFY_CONVERT_VALUE(ANY,ANY,+1); the user
// replaced JOB008's own content with an unrelated EMBLEM-based VP effect ("以前のJOB008は問題がある
// ことがわかりました 以前のJOB008は抹消します"), so this card no longer exercises
// MODIFY_CONVERT_VALUE at all. No other real card currently has a MODIFY_CONVERT_VALUE PASSIVE --
// the engine mechanism itself (executor.js's runChange reading getPassiveRules(...,
// 'MODIFY_CONVERT_VALUE')) is unchanged and still fully data-driven, it's just untested against real
// data until some future card actually uses it again. Left undeleted rather than replaced with a
// synthetic non-real-card row, per this project's own convention of testing against real data only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. MAP.CURRENT_AREA assignment (A005A.ONCE = 'MAP001.CURRENT_AREA=AREA001B')
// ---------------------------------------------------------------------------
{
  const state = freshState();
  state.maps['MAP001'] = createMapState('MAP001', 'AREA001A');
  // Simulates a die that was placed under AREA001A before the flip (2026-08-04, per user bug report:
  // "建築したりアップグレードしたときにおかれているダイスがそのままでSLOTが空きません") -- map.slots
  // used to be left completely untouched by a CURRENT_AREA flip, so a stale occupant like this stuck
  // around forever, blocking/misrepresenting a slot position that now belongs to a different area.
  state.maps['MAP001'].slots = [[{ playerId: 'P1', dieId: 'stale-die', value: 1, seq: 1, countsForTurnOrder: true }], [], []];
  const row = getCardRow(index, 'A005A');
  executor.runProgram(state, index, { playerId: 'P1' }, row.ONCE);
  check('A005A.ONCE flips MAP001 to AREA001B', state.maps['MAP001'].currentAreaId, 'AREA001B');
  check('A005A.ONCE makes P1 the fee owner of MAP001', state.maps['MAP001'].feeOwnerId, 'P1');
  check('A005A.ONCE resets MAP001.slots to fresh empty slots matching AREA001B (3 active SLOT columns)', state.maps['MAP001'].slots, [[], [], []]);
}

// ---------------------------------------------------------------------------
// 7. RESOURCE_TOTAL_LIMIT gates TURNEND rather than auto-discarding (CON005B)
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'CON005B', 'P1');
  const player = getPlayerRef(state, 'P1');
  player.resources.A = 3;
  player.resources.B = 3;
  player.resources.C = 3; // total 9 > limit 7
  const gate = executor.canEndTurn(state, index, 'P1');
  check('CON005B: RESOURCE_TOTAL_LIMIT(7) blocks TURNEND at total 9', gate.ok, false);
  player.resources.C = 1; // total 7, at the limit
  check('CON005B: RESOURCE_TOTAL_LIMIT(7) allows TURNEND at total 7', executor.canEndTurn(state, index, 'P1').ok, true);
}

// ---------------------------------------------------------------------------
// 8. Free actions: A/B/C/Z->K have no usage limit at all (confirmed 2026-08-02: "回数制限ありません")
//    -- repeatable any number of times, limited only by having the resource. (wD->2K, a 5th free action
//    here at the time, was abolished 2026-08-07 per user request -- see game-state.js's FREE_ACTION_IDS.)
// ---------------------------------------------------------------------------
{
  const state = freshState();
  const player = getPlayerRef(state, 'P1');
  player.resources.A = 2;
  player.resources.B = 1;

  const first = executor.tryFreeAction(state, index, 'P1', 'A_K');
  check('A->K free action succeeds', first, { success: true });
  check('A->K pays 1A, gains 1K', { A: player.resources.A, K: player.resources.K }, { A: 1, K: 1 });

  const second = executor.tryFreeAction(state, index, 'P1', 'A_K');
  check('A->K free action can be used again immediately (no usage limit)', second, { success: true });
  check('A->K pays the remaining 1A, gains a 2nd K', { A: player.resources.A, K: player.resources.K }, { A: 0, K: 2 });

  const third = executor.tryFreeAction(state, index, 'P1', 'A_K');
  check('A->K refuses once out of A (INSUFFICIENT_RESOURCES, not a tap gate)', third, { success: false, reason: 'INSUFFICIENT_RESOURCES' });

  const bAction = executor.tryFreeAction(state, index, 'P1', 'B_K');
  check('B->K works independently of A->K', bAction, { success: true });

  // wD_K (wD->2K) was abolished 2026-08-07, per user request -- no longer a recognized free action at all.
  let wdKThrew = false;
  try { executor.tryFreeAction(state, index, 'P1', 'wD_K'); } catch (e) { wdKThrew = true; }
  check('wD_K is no longer a recognized free action (throws, not INSUFFICIENT_RESOURCES)', wdKThrew, true);
  check('...FREE_ACTION_IDS no longer lists it', require('../src/game-state').FREE_ACTION_IDS.includes('wD_K'), false);
}

// ---------------------------------------------------------------------------
// 9. Usage fee collection: only the fee owner can collect, no per-round limit (2026-08-06, per user
// feedback: "使用料回収は未回収の使用料がある限り何回でも使えるようにかえてください" -- reverses the
// previous once-per-round-shared-tap rule; collectible again as soon as accumulatedFee is next >0,
// whether that's the same map re-accruing or a different tiered-up map this same player owns).
// ---------------------------------------------------------------------------
{
  const state = freshState();
  state.maps['MAP001'] = createMapState('MAP001', 'AREA001B');
  state.maps['MAP001'].feeOwnerId = 'P1';
  state.maps['MAP001'].accumulatedFee = 3;
  getPlayerRef(state, 'P1');
  state.players.push(require('../src/game-state').createPlayer('P2', 'Bob'));

  const wrongOwner = executor.collectUsageFee(state, index, { playerId: 'P2' }, 'MAP001');
  check('P2 (not the fee owner) cannot collect', wrongOwner.success, false);

  const collected = executor.collectUsageFee(state, index, { playerId: 'P1' }, 'MAP001');
  check('P1 (the fee owner) collects the accumulated 3K', collected, { success: true, amount: 3 });
  check('Fee is cleared from the map after collection', state.maps['MAP001'].accumulatedFee, 0);
  check('P1 gained the 3K', getPlayerRef(state, 'P1').resources.K, 3);

  const nothingLeft = executor.collectUsageFee(state, index, { playerId: 'P1' }, 'MAP001');
  check('Collecting again with nothing accrued since fails (NO_FEE_TO_COLLECT, not a round-scoped tap)', nothingLeft, { success: false, reason: 'NO_FEE_TO_COLLECT' });

  state.maps['MAP001'].accumulatedFee = 2; // more fee accrues later the same round
  const collectedAgain = executor.collectUsageFee(state, index, { playerId: 'P1' }, 'MAP001');
  check('...but collects again once more fee has accrued, same round, no tap blocking it', collectedAgain, { success: true, amount: 2 });
  check('P1 now has 5K total (3 + 2)', getPlayerRef(state, 'P1').resources.K, 5);
}

// ---------------------------------------------------------------------------
// 10. Auto/manual mode: free actions default true; card TAP abilities default
//     from the data sheet's AUTO column, until the player overrides them.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  check('Free actions default to manual (false)', executor.isFreeActionAutoMode(state, 'P1', 'A_K'), false);
  executor.setFreeActionAutoMode(state, 'P1', 'A_K', true);
  check('Free action auto mode can be switched to auto', executor.isFreeActionAutoMode(state, 'P1', 'A_K'), true);

  const jobPhysicalId = giveCard(state, 'JOB005', 'P1'); // AUTO="A" in game.xlsx
  check('JOB005 defaults to auto per its AUTO column', executor.isCardAutoMode(state, index, 'P1', jobPhysicalId), true);

  const cPhysicalId = giveCard(state, 'C001A', 'P1'); // AUTO="M" in game.xlsx
  check('C001A defaults to manual per its AUTO column', executor.isCardAutoMode(state, index, 'P1', cPhysicalId), false);

  executor.setCardAutoMode(state, 'P1', cPhysicalId, true);
  check('Player can override a card away from its default', executor.isCardAutoMode(state, index, 'P1', cPhysicalId), true);
}

// ---------------------------------------------------------------------------
// 11. ADD/CHANGE now auto-emit GET and auto-resolve AUTO-mode TAP reactions
//     (previously emit() had to be called by hand); MANUAL-mode reactions
//     queue a pendingChoice instead of firing.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  const jobPhysicalId = giveCard(state, 'JOB005', 'P1'); // TAP=ON(GET(K),CHANGE(K,Z)), AUTO="A"
  const player = getPlayerRef(state, 'P1');

  // AREA001A.ACTION = ADD(3K) -- simulate resolving that AREA action directly via runCommand.
  executor.runCommand(state, index, { playerId: 'P1' }, { type: 'ADD', items: [{ resource: 'K', count: { kind: 'literal', value: 3 } }] });
  check('Auto-mode JOB005 reacts to the ADD(3K)-triggered GET(K) without being told to', player.resources.Z, 1);
  check('...paying 1K for it (3 gained - 1 paid = 2)', player.resources.K, 2);
  check('...and taps itself in the process', state.cards[jobPhysicalId].tapped, true);
  check('No leftover pendingChoice was created for an auto-resolved reaction', state.pendingChoices.length, 0);
}
{
  const state = freshState();
  const jobPhysicalId = giveCard(state, 'JOB005', 'P1');
  executor.setCardAutoMode(state, 'P1', jobPhysicalId, false); // force manual for this test
  const player = getPlayerRef(state, 'P1');

  executor.runCommand(state, index, { playerId: 'P1' }, { type: 'ADD', items: [{ resource: 'K', count: { kind: 'literal', value: 3 } }] });
  check('Manual-mode JOB005 does NOT auto-fire', player.resources.Z, 0);
  check('...and instead queues a TAP_REACTION_AVAILABLE pendingChoice', state.pendingChoices.length, 1);
  check('...for the right card/event', {
    kind: state.pendingChoices[0].kind,
    physicalId: state.pendingChoices[0].context.physicalId,
    eventName: state.pendingChoices[0].context.eventName,
  }, { kind: 'TAP_REACTION_AVAILABLE', physicalId: jobPhysicalId, eventName: 'GET' });
}

console.log(`\n${passCount} passed, ${failCount} failed`);
// ---------------------------------------------------------------------------
// 12. Dice-value DSLs: SET_DICE_ANY, SET_DIE_VALUE, CHANGE_DIE_VALUE (with
//     wraparound), and GRANT_PLACE_ANYWHERE picking up THIS_DICE via
//     context.lastTargetedDieId across statements in the same field.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'JOB003', 'P1'); // TAP=SET_DICE_ANY()
  const player = getPlayerRef(state, 'P1');
  const die = createDie('d1', 'COLOR');
  die.value = 4;
  player.dice.push(die);

  const row = getCardRow(index, 'JOB003');
  const missingChoice = executor.runProgram(state, index, { playerId: 'P1' }, row.TAP);
  check('SET_DICE_ANY() without a choice fails with CHOICE_REQUIRED', missingChoice.reason, 'CHOICE_REQUIRED');

  const withChoice = executor.runProgram(state, index, { playerId: 'P1', chosenDieId: 'd1', chosenValue: 6 }, row.TAP);
  check('SET_DICE_ANY() with a choice succeeds', withChoice.success, true);
  check('...and sets the die to the chosen value', getDieRef(state, 'P1', 'd1').value, 6);
}
{
  const state = freshState();
  giveCard(state, 'B001A', 'P1'); // TAP=SET_DIE_VALUE(SELF2|3);GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN)
  const player = getPlayerRef(state, 'P1');
  const die = createDie('d1', 'COLOR');
  die.value = 1;
  player.dice.push(die);

  const row = getCardRow(index, 'B001A');
  const badChoice = executor.runProgram(state, index, { playerId: 'P1', chosenDieId: 'd1', chosenValue: 5 }, row.TAP);
  check('SET_DIE_VALUE(SELF2|3) rejects a value outside {2,3}', badChoice.reason, 'INVALID_CHOICE');

  const context = { playerId: 'P1', chosenDieId: 'd1', chosenValue: 3 };
  const result = executor.runProgram(state, index, context, row.TAP);
  check('SET_DIE_VALUE(SELF2|3) with chosenValue=3 succeeds', result.success, true);
  check('...sets the die to 3', getDieRef(state, 'P1', 'd1').value, 3);
  check('...and GRANT_PLACE_ANYWHERE(THIS_DICE,...) found it via context.lastTargetedDieId', getDieRef(state, 'P1', 'd1').placeAnywhereThisTurn, true);

  executor.applyTurnEnd(state, index, 'P1');
  check('placeAnywhereThisTurn is cleared at TURNEND (THIS_TURN scope)', getDieRef(state, 'P1', 'd1').placeAnywhereThisTurn, false);
}
{
  const state = freshState();
  giveCard(state, 'B003A', 'P1'); // TAP=CHANGE_DIE_VALUE(SELF±1);GRANT_PLACE_ANYWHERE(...)
  const player = getPlayerRef(state, 'P1');
  const die = createDie('d1', 'COLOR');
  die.value = 6;
  player.dice.push(die);

  const row = getCardRow(index, 'B003A');
  const result = executor.runProgram(state, index, { playerId: 'P1', chosenDieId: 'd1', chosenDelta: 1 }, row.TAP);
  check('CHANGE_DIE_VALUE(SELF±1) with +1 succeeds', result.success, true);
  check('...wraps 6 -> 1 rather than 7', die.value, 1);

  const badDelta = executor.runProgram(state, index, { playerId: 'P1', chosenDieId: 'd1', chosenDelta: 2 }, row.TAP);
  check('CHANGE_DIE_VALUE(SELF±1) rejects a delta outside {+1,-1}', badDelta.reason, 'INVALID_CHOICE');
}

// ---------------------------------------------------------------------------
// 13. Newly-granted dice (ADD(D)/ADD(wD)) are rolled immediately (confirmed
//     2026-07-29: white dice roll once on acquisition, color dice need a
//     value to be placeable this round too). grantOneDie itself does NOT record an undo checkpoint
//     (corrected 2026-08-02: it used to, but that conflicted with main.js's later "checkpoint once at
//     turn start" mechanism -- a mid-turn die grant would silently overwrite the turn-start checkpoint
//     with a snapshot where the triggering placement had already happened, breaking Undo. Checkpointing
//     is now exclusively the 3 higher-level callers' job: setup.rollInitialColorDice,
//     turn-flow.startRound, and main.js's render()).
// ---------------------------------------------------------------------------
{
  const state = freshState();
  executor.runCommand(state, index, { playerId: 'P1' }, { type: 'ADD', items: [{ resource: 'wD', count: { kind: 'literal', value: 1 } }] });
  const whiteDie = getPlayerRef(state, 'P1').dice.find((d) => d.kind === 'WHITE');
  assertNotUndefined('A newly-granted white die has a rolled value (1-6), not null', whiteDie && whiteDie.value >= 1 && whiteDie.value <= 6);
  check('grantOneDie does not record its own undo checkpoint', state.undoCheckpoint, null);

  const state2 = freshState();
  executor.runCommand(state2, index, { playerId: 'P1' }, { type: 'ADD', items: [{ resource: 'D', count: { kind: 'literal', value: 1 } }] });
  const colorDie = getPlayerRef(state2, 'P1').dice.find((d) => d.kind === 'COLOR');
  assertNotUndefined('A newly-granted color die also has a rolled value immediately', colorDie && colorDie.value >= 1 && colorDie.value <= 6);
}
function assertNotUndefined(label, cond) { check(label, !!cond, true); }

// ---------------------------------------------------------------------------
// 13b. A white die granted past whiteDiceCap (5) converts to 2K instead (unrelated to the ADD-rolls-
//     immediately rule above -- this is the always-on overflow rule, see FREE_ACTION_IDS' own comment)
//     and records the event on GameState.whiteOverflowEvents for main.js's warning banner (2026-08-11,
//     per user request: "白Dを得たとき上限の5個を超えて得たとき...という警告文が表示されるようにして
//     ほしい"). The array starts empty and is otherwise untouched by ordinary play.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  check('whiteOverflowEvents starts empty', state.whiteOverflowEvents, []);
  const player = getPlayerRef(state, 'P1');
  for (let i = 0; i < 5; i++) player.dice.push(createDie(`preexisting-w${i}`, 'WHITE'));
  const kBefore = player.resources.K;
  executor.runCommand(state, index, { playerId: 'P1' }, { type: 'ADD', items: [{ resource: 'wD', count: { kind: 'literal', value: 1 } }] });
  check('At the 5-die cap, a 6th wD grant does not add a 6th die', getPlayerRef(state, 'P1').dice.filter((d) => d.kind === 'WHITE').length, 5);
  check('...it converts to 2K instead', getPlayerRef(state, 'P1').resources.K, kBefore + 2);
  check('...and is recorded on whiteOverflowEvents', state.whiteOverflowEvents, ['P1']);

  // Below the cap, granting a wD normally does NOT touch whiteOverflowEvents.
  const state2 = freshState();
  executor.runCommand(state2, index, { playerId: 'P1' }, { type: 'ADD', items: [{ resource: 'wD', count: { kind: 'literal', value: 1 } }] });
  check('A normal (non-overflow) wD grant leaves whiteOverflowEvents empty', state2.whiteOverflowEvents, []);
}

// ---------------------------------------------------------------------------
// 14. CONVERT_LIMIT(ALL,n): a PER-CHANGE cap on ALL-based CHANGEs -- each one is measured on its own,
//     with nothing carried between them, and it applies to EVERY ALL-based CHANGE regardless of what
//     triggered it (corrected 2026-08-11, per the user: "意図した制限は一回のCHANGEでMAX4個までしか交換
//     できない" -- it used to subtract a whole-game cumulative counter, and only applied to
//     AREA003/004/005). Fixed-count CHANGEs stay unaffected.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'CON003B', 'P1'); // PASSIVE=CONVERT_LIMIT(ALL,4)
  const player = getPlayerRef(state, 'P1');
  player.resources.K = 20;

  const changeAllK2A = { type: 'CHANGE', pay: [{ resource: 'K', count: { kind: 'literal', value: 1 } }], gain: [{ resource: 'A', count: { kind: 'literal', value: 1 } }], times: { kind: 'all' } };

  const first = executor.runCommand(state, index, { playerId: 'P1' }, changeAllK2A);
  check('An ALL-conversion is capped at CONVERT_LIMIT(4) even though 20K is affordable', first.timesExecuted, 4);
  check('...spending exactly 4K', player.resources.K, 16);

  // The user's own worked example: 10K, same turn, two separate ALL-CHANGEs (C001B's TAP and a die on
  // AREA003A) -> 4 each, NOT 4 total.
  const second = executor.runCommand(state, index, { playerId: 'P1' }, changeAllK2A);
  check('A SECOND ALL-conversion gets its own full 4 (no cumulative carry-over)', second.timesExecuted, 4);
  const third = executor.runCommand(state, index, { playerId: 'P1' }, changeAllK2A);
  check('...and so does a third', third.timesExecuted, 4);
  check('12K spent across the three, 8 left', player.resources.K, 8);
  check('Nothing is accumulated into passiveCounters any more', state.passiveCounters['P1:CONVERT_LIMIT:ALL'], undefined);

  // Still capped by affordability when that is the smaller of the two.
  player.resources.K = 3;
  const short = executor.runCommand(state, index, { playerId: 'P1' }, changeAllK2A);
  check('Below the cap, affordability still decides (3K -> 3 executions)', short.timesExecuted, 3);
}
{
  // A raw 'literal'-kind CHANGE (always exactly N, all-or-nothing -- see runChange's own doc; command-
  // builder.js never actually lowers DSL text to 'literal' with N>1 any more, only to this engine-level
  // shape directly) is never touched by CONVERT_LIMIT either, same as 'capped' below.
  const state = freshState();
  giveCard(state, 'CON003B', 'P1');
  getPlayerRef(state, 'P1').resources.K = 20;
  const changeSixTimes = { type: 'CHANGE', pay: [{ resource: 'K', count: { kind: 'literal', value: 1 } }], gain: [{ resource: 'A', count: { kind: 'literal', value: 1 } }], times: { kind: 'literal', value: 6 } };
  const result = executor.runCommand(state, index, { playerId: 'P1' }, changeSixTimes);
  check('A raw literal-kind CHANGE(K,A,6) is NOT capped by CONVERT_LIMIT(ALL,4)', result.timesExecuted, 6);
}

// ---------------------------------------------------------------------------
// 14b. 'capped'-kind CHANGE (explicit numeric third argument, e.g. C001A's real TAP=CHANGE(K,A,2)):
//     executes up to N times, scaled down to whatever's affordable, instead of requiring the full amount
//     (2026-08-11, per user request: "C001A 002 003 2K→2A を1Kしか持ってないときにTAPしたら 1K→1Aに
//     なるように" -- these 3 cards used to be a flat CHANGE(2K,2A) and needed the full 2K or did nothing).
// ---------------------------------------------------------------------------
{
  const row = getCardRow(index, 'C001A');
  check('C001A\'s real TAP is now CHANGE(K,A,2), not the old flat CHANGE(2K,2A)', row.TAP, 'CHANGE(K,A,2)');

  const state = freshState();
  const physicalId = giveCard(state, 'C001A', 'P1');
  const context = { playerId: 'P1', sourcePhysicalId: physicalId };

  getPlayerRef(state, 'P1').resources.K = 2;
  const full = executor.runProgram(state, index, context, getCardRow(index, 'C001A').TAP);
  check('With the full 2K available, TAP succeeds', full.success, true);
  check('...still converts 2K -> 2A (unchanged from before)', getPlayerRef(state, 'P1').resources.K, 0);
  check('...granting 2A', getPlayerRef(state, 'P1').resources.A, 2);

  const state2 = freshState();
  giveCard(state2, 'C001A', 'P1');
  getPlayerRef(state2, 'P1').resources.K = 1;
  const partial = executor.runProgram(state2, index, context, getCardRow(index, 'C001A').TAP);
  check('With only 1K, TAP succeeds instead of failing outright', partial.success, true);
  check('...converts the 1K -> 1A', getPlayerRef(state2, 'P1').resources.K, 0);
  check('...granting exactly 1A', getPlayerRef(state2, 'P1').resources.A, 1);

  const state3 = freshState();
  giveCard(state3, 'C001A', 'P1');
  getPlayerRef(state3, 'P1').resources.K = 5;
  executor.runProgram(state3, index, context, getCardRow(index, 'C001A').TAP);
  check('With MORE than 2K, the cap still holds at 2 -- only 2 of the 5K spent, not "convert everything"', getPlayerRef(state3, 'P1').resources.K, 3);
  check('...granting 2A, not 5', getPlayerRef(state3, 'P1').resources.A, 2);

  const state4 = freshState();
  giveCard(state4, 'CON003B', 'P1'); // PASSIVE=CONVERT_LIMIT(ALL,4) -- must NOT reach into 'capped' mode
  getPlayerRef(state4, 'P1').resources.K = 2;
  executor.runProgram(state4, index, context, getCardRow(index, 'C001A').TAP);
  check('CONVERT_LIMIT(ALL,4) from an unrelated owned card does not affect capped-mode at all (still spends 2K, not further reduced)', getPlayerRef(state4, 'P1').resources.K, 0);
}
{
  // Without the CON003B PASSIVE there's no cap at all -- the whole 20K converts.
  const state = freshState();
  getPlayerRef(state, 'P1').resources.K = 20;
  const changeAllK2A = { type: 'CHANGE', pay: [{ resource: 'K', count: { kind: 'literal', value: 1 } }], gain: [{ resource: 'A', count: { kind: 'literal', value: 1 } }], times: { kind: 'all' } };
  const result = executor.runCommand(state, index, { playerId: 'P1' }, changeAllK2A);
  check('With no CONVERT_LIMIT PASSIVE owned, an ALL-conversion is limited only by affordability', result.timesExecuted, 20);
}

// ---------------------------------------------------------------------------
// 15. EMBLEM_COUNT/EMBLEM_SET_COUNT with multi-emblem monuments (2026-07-30: game.xlsx's M sheet
// split EMBLEM into per-type EMBLEM_A/EMBLEM_B/EMBLEM_C counts, so a single monument can now count
// toward more than one emblem -- e.g. M004 has EMBLEM_A=1,EMBLEM_B=1,EMBLEM_C=1, i.e. one each of
// 地/天/人; M012 has EMBLEM_C=3, i.e. three 人). Regression test for the emblemCountsForRow fix.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'M004', 'P1'); // EMBLEM_A=1(地), EMBLEM_B=1(天), EMBLEM_C=1(人)
  check('EMBLEM_COUNT(天) counts M004\'s 天 emblem', executor.evalMetric(state, index, 'P1', { name: 'EMBLEM_COUNT', args: ['天'] }), 1);
  check('EMBLEM_COUNT(地) counts M004\'s 地 emblem', executor.evalMetric(state, index, 'P1', { name: 'EMBLEM_COUNT', args: ['地'] }), 1);
  check('COUNT(人) (EMBLEM_COUNT alias) counts M004\'s 人 emblem', executor.evalMetric(state, index, 'P1', { name: 'COUNT', args: ['人'] }), 1);
  check('EMBLEM_SET_COUNT is 1 with exactly one of each emblem', executor.evalMetric(state, index, 'P1', { name: 'EMBLEM_SET_COUNT', args: [] }), 1);

  giveCard(state, 'M012', 'P1'); // EMBLEM_C=3 (three 人), no 天/地
  check('EMBLEM_COUNT(人) sums across cards: M004\'s 1 + M012\'s 3', executor.evalMetric(state, index, 'P1', { name: 'EMBLEM_COUNT', args: ['人'] }), 4);
  check('EMBLEM_SET_COUNT stays capped by the scarcest emblem (天=1, 地=1) despite 人=3', executor.evalMetric(state, index, 'P1', { name: 'EMBLEM_SET_COUNT', args: [] }), 1);
}

// ---------------------------------------------------------------------------
// 16. MAX_EMBLEM_COUNT/TOTAL_EMBLEM_COUNT/COST_TOTAL (2026-07-30, added for QST GOAL conditions --
// see [[project-dice-wp-qst-spec]]). Reuses the same M004(地1,天1,人1)/M012(人3) fixtures as #15.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'M004', 'P1'); // COST=2A,2B,2C (total 6); EMBLEM 地1,天1,人1
  check('MAX_EMBLEM_COUNT is 1 with exactly one of each emblem', executor.evalMetric(state, index, 'P1', { name: 'MAX_EMBLEM_COUNT', args: [] }), 1);
  check('TOTAL_EMBLEM_COUNT sums all three types: 1+1+1', executor.evalMetric(state, index, 'P1', { name: 'TOTAL_EMBLEM_COUNT', args: [] }), 3);
  check('COST_TOTAL reads M004\'s printed COST (2A+2B+2C)', executor.evalMetric(state, index, 'P1', { name: 'COST_TOTAL', args: [] }), 6);

  giveCard(state, 'M012', 'P1'); // COST=13C (total 13); EMBLEM 人3 (no 天/地)
  check('MAX_EMBLEM_COUNT now follows 人 (1+3=4), ahead of 天/地 (1 each)', executor.evalMetric(state, index, 'P1', { name: 'MAX_EMBLEM_COUNT', args: [] }), 4);
  check('TOTAL_EMBLEM_COUNT sums across cards too: (1+1+1) + 3', executor.evalMetric(state, index, 'P1', { name: 'TOTAL_EMBLEM_COUNT', args: [] }), 6);
  check('COST_TOTAL sums across cards: M004\'s 6 + M012\'s 13', executor.evalMetric(state, index, 'P1', { name: 'COST_TOTAL', args: [] }), 19);

  giveCard(state, 'A001A', 'P1'); // COST=2A (total 2)
  check('COST_TOTAL keeps summing a 3rd card: 19 + 2', executor.evalMetric(state, index, 'P1', { name: 'COST_TOTAL', args: [] }), 21);
}

// ---------------------------------------------------------------------------
// 17. RESOURCE(x) (2026-07-30, added for QST GOAL conditions -- e.g. Q001B's "VP 8"): the only
// metric that reads PlayerState.resources directly instead of counting owned cards.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  check('RESOURCE(VP) is 0 for a fresh player', executor.evalMetric(state, index, 'P1', { name: 'RESOURCE', args: ['VP'] }), 0);
  getPlayerRef(state, 'P1').resources.VP = 8;
  check('RESOURCE(VP) reads the player\'s current VP', executor.evalMetric(state, index, 'P1', { name: 'RESOURCE', args: ['VP'] }), 8);
  getPlayerRef(state, 'P1').resources.K = 5;
  check('RESOURCE(K) reads a different resource independently', executor.evalMetric(state, index, 'P1', { name: 'RESOURCE', args: ['K'] }), 5);
}

// ---------------------------------------------------------------------------
// 18. Z as a universal substitute for A/B/C payments (confirmed 2026-07-31, see
// [[project-dice-wp-dsl-spec]]): payCostList (BUILD/UPGRADE cost) auto-covers a real-resource
// shortfall with Z, real always drained first by default.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  getPlayerRef(state, 'P1').resources.A = 1;
  getPlayerRef(state, 'P1').resources.Z = 5;
  const result = executor.payCostList(state, 'P1', [{ resource: 'A', count: 3 }]);
  check('payCostList succeeds when real+Z combined cover the cost', result.success, true);
  check('...real A drained first (all 1 used)', getPlayerRef(state, 'P1').resources.A, 0);
  check('...Z covers the remaining shortfall (2 of the needed 3)', getPlayerRef(state, 'P1').resources.Z, 3);
}
{
  const state = freshState();
  getPlayerRef(state, 'P1').resources.A = 1;
  getPlayerRef(state, 'P1').resources.Z = 1;
  const result = executor.payCostList(state, 'P1', [{ resource: 'A', count: 3 }]);
  check('payCostList fails when real+Z combined still fall short', result, { success: false, reason: 'INSUFFICIENT_RESOURCES', resource: 'A' });
  check('...nothing was paid on failure (atomic)', getPlayerRef(state, 'P1').resources, { K: 0, A: 1, B: 0, C: 0, Z: 1, VP: 0, BZ: 0 });
}

// ---------------------------------------------------------------------------
// 19. hasPaymentChoiceAbility / colorPreference (CON002B's "real or Z, player's choice"): false/
// ignored without the card, honored with it.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  check('hasPaymentChoiceAbility is false without CON002B', executor.hasPaymentChoiceAbility(state, 'P1'), false);
  giveCard(state, 'CON002B', 'P1');
  check('hasPaymentChoiceAbility is true once CON002B is owned', executor.hasPaymentChoiceAbility(state, 'P1'), true);
}
{
  // Without CON002B, a colorPreference of 'Z' must be silently ignored (defense in depth against a
  // UI bug granting the choice to someone who doesn't have it) -- real is still drained first.
  const state = freshState();
  getPlayerRef(state, 'P1').resources.B = 5;
  getPlayerRef(state, 'P1').resources.Z = 5;
  executor.payCostList(state, 'P1', [{ resource: 'B', count: 2 }], { B: 'Z' });
  check('colorPreference is ignored without CON002B (real B still drained)', getPlayerRef(state, 'P1').resources, { K: 0, A: 0, B: 3, C: 0, Z: 5, VP: 0, BZ: 0 });
}
{
  // With CON002B, colorPreference:'Z' actually prefers Z even though real is fully affordable --
  // e.g. to spend Z down before CON002B's own TURNEND=FORCE_CONVERT(Z,K,1) claims it anyway.
  const state = freshState();
  giveCard(state, 'CON002B', 'P1');
  getPlayerRef(state, 'P1').resources.B = 5;
  getPlayerRef(state, 'P1').resources.Z = 5;
  executor.payCostList(state, 'P1', [{ resource: 'B', count: 2 }], { B: 'Z' });
  check('colorPreference:Z is honored with CON002B (Z drained instead of real B)', getPlayerRef(state, 'P1').resources, { K: 0, A: 0, B: 5, C: 0, Z: 3, VP: 0, BZ: 0 });
}

// ---------------------------------------------------------------------------
// 20. AREA007's ACTION=CHANGE((A,B,C),D) ("ABC→色D") -- Z substitution applies equally to CHANGE's
// pay side, not just BUILD/UPGRADE COST (both go through executor.resolvePayment).
// ---------------------------------------------------------------------------
{
  const state = freshState();
  getPlayerRef(state, 'P1').resources.A = 1; // real A short by 0
  getPlayerRef(state, 'P1').resources.B = 0; // real B short by 1 -- Z must cover it
  getPlayerRef(state, 'P1').resources.C = 1;
  getPlayerRef(state, 'P1').resources.Z = 3;
  const result = executor.runProgram(state, index, { playerId: 'P1' }, 'CHANGE((A,B,C),D)');
  check('CHANGE((A,B,C),D) succeeds using Z to cover the missing B', result.success, true);
  check('...real A and C were spent, Z covered B\'s shortfall (1 of 3 Z used)', getPlayerRef(state, 'P1').resources, { K: 0, A: 0, B: 0, C: 0, Z: 2, VP: 0, BZ: 0 });
  check('...a colored die (D) was granted', getPlayerRef(state, 'P1').dice.filter((d) => d.kind === 'COLOR').length, 1);
}

// 21. Arithmetic offset on a dynamic count expression (2026-08-02, added when the user nerfed B008A
// from ADD(COUNT(天)*wD) to ADD((COUNT(天)-1)*wD)): the DSL grammar previously had no way to subtract
// from a Call's result, so this string failed to parse until dsl-parser.js/executor.js were extended
// (see [[project-dice-wp-dsl-spec]]). A negative result must clamp to 0 (granting nothing), not throw
// or go negative, since 0 天-emblem cards minus 1 is a perfectly normal "you get nothing" case, not an
// error.
{
  const bTierACards = ['B001A', 'B002A', 'B003A', 'B004A']; // all EMBLEM_B=天
  for (const [tenCount, expectedWd] of [[0, 0], [1, 0], [2, 1], [3, 2]]) {
    const state = freshState();
    for (let i = 0; i < tenCount; i++) giveCard(state, bTierACards[i], 'P1');
    const before = getPlayerRef(state, 'P1').dice.filter((d) => d.kind === 'WHITE').length;
    const result = executor.runProgram(state, index, { playerId: 'P1' }, 'ADD((COUNT(天)-1)*wD)');
    const after = getPlayerRef(state, 'P1').dice.filter((d) => d.kind === 'WHITE').length;
    check(`ADD((COUNT(天)-1)*wD) with ${tenCount} 天-emblem cards grants ${expectedWd} wD (nerfed by 1)`, { success: result.success, granted: after - before }, { success: true, granted: expectedWd });
  }
}

// ---------------------------------------------------------------------------
// BZ is turn-scoped (2026-08-0X, per user feedback: "BZはターン終了時に無くなります") -- any left
// unspent at TURNEND is lost, not carried into the next turn.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  getPlayerRef(state, 'P1').resources.BZ = 2;
  executor.applyTurnEnd(state, index, 'P1');
  check('Unspent BZ is cleared to 0 at TURNEND', getPlayerRef(state, 'P1').resources.BZ, 0);
}
{
  const state = freshState();
  getPlayerRef(state, 'P1').resources.BZ = 0;
  executor.applyTurnEnd(state, index, 'P1');
  check('BZ already at 0 stays 0 at TURNEND (no-op case)', getPlayerRef(state, 'P1').resources.BZ, 0);
}

// ---------------------------------------------------------------------------
// BLOCK_BUILD(category,THIS_TURN) (2026-08-04, per user feedback: using JOB004's TAP
// "CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)" blocks that player from building a monument for the rest of
// the turn). Turn-scoped like GRANT_PLACE_ANYWHERE's THIS_TURN flag -- reset at TURNEND.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  const result = executor.runProgram(state, index, { playerId: 'P1' }, 'BLOCK_BUILD(M,THIS_TURN)');
  check('BLOCK_BUILD(M,THIS_TURN) succeeds', result.success, true);
  check('...and records M in blockedBuildCategoriesThisTurn', getPlayerRef(state, 'P1').blockedBuildCategoriesThisTurn, ['M']);
}
{
  const state = freshState();
  getPlayerRef(state, 'P1').blockedBuildCategoriesThisTurn = ['M'];
  executor.applyTurnEnd(state, index, 'P1');
  check('blockedBuildCategoriesThisTurn is cleared at TURNEND', getPlayerRef(state, 'P1').blockedBuildCategoriesThisTurn, []);
}
{
  const state = freshState();
  const row = getCardRow(index, 'JOB004');
  const player = getPlayerRef(state, 'P1');
  player.resources.K = 3;
  const result = executor.runProgram(state, index, { playerId: 'P1' }, row.TAP);
  check('JOB004\'s TAP (CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)) succeeds and pays/grants correctly', { success: result.success, K: player.resources.K, BZ: player.resources.BZ }, { success: true, K: 0, BZ: 2 });
  check('...and blocks M for this player this turn', player.blockedBuildCategoriesThisTurn, ['M']);
}

// ---------------------------------------------------------------------------
// runChange's gain side fires GET again (2026-08-04, per user feedback: "JOB006はCHANGEで色Dを手に入れ
// ても発動するようにしてください"), reverting the part of the 2026-08-03 fix that went further than the
// actual complaint. tryFreeAction (the 6 built-in free actions) stays silent -- that's the narrower
// scope this was meant to have all along, since no CHANGE(...) DSL command anywhere in the data grants K
// (the resource JOB005's reaction is keyed on), so only the free actions could ever trigger it.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  giveCard(state, 'JOB006', 'P1'); // PASSIVE=ON(GET(D),ADD(Z));ON(GET(wD),ADD(K))
  const player = getPlayerRef(state, 'P1');
  const before = player.dice.filter((d) => d.kind === 'COLOR').length;
  const result = executor.runCommand(state, index, { playerId: 'P1' }, { type: 'CHANGE', pay: [], gain: [{ resource: 'D', count: { kind: 'literal', value: 1 } }], times: { kind: 'literal', value: 1 } });
  check('A bare CHANGE(...,D) succeeds and grants the color die', { success: result.success, diceGained: player.dice.filter((d) => d.kind === 'COLOR').length - before }, { success: true, diceGained: 1 });
  check('...and JOB006 auto-reacts to the CHANGE-triggered GET(D), granting Z', player.resources.Z, 1);
}
{
  // GET fires once *per die* for a multi-die grant, not once for the whole grant (2026-08-06, per user
  // report: "B004AなどでダイスX2個手に入れた時それぞれ発動...2回発動するようにしてください" -- B004A's
  // ONCE=ADD(2wD) only triggered JOB006's ON(GET(wD),ADD(K)) once instead of twice). Mirrors
  // board.placeDiceGroup's own PLACE(mapId), which already emits once per die in a multi-die placement.
  const state = freshState();
  giveCard(state, 'JOB006', 'P1'); // PASSIVE=ON(GET(D),ADD(Z));ON(GET(wD),ADD(K))
  const player = getPlayerRef(state, 'P1');
  const result = executor.runProgram(state, index, { playerId: 'P1' }, 'ADD(2wD)'); // B004A's real ONCE
  check('ADD(2wD) succeeds and grants both white dice', { success: result.success, wD: player.dice.filter((d) => d.kind === 'WHITE').length }, { success: true, wD: 2 });
  check('...and JOB006 reacted to GET(wD) twice, once per die, granting 2K not 1', player.resources.K, 2);
}
{
  const state = freshState();
  giveCard(state, 'JOB005', 'P1'); // TAP=ON(GET(K),CHANGE(K,Z)), AUTO="A"
  const player = getPlayerRef(state, 'P1');
  player.resources.A = 1;
  const result = executor.tryFreeAction(state, index, 'P1', 'A_K');
  check('The A->K free action still succeeds', result.success, true);
  check('...but does NOT trigger JOB005\'s GET(K) reaction (free actions stay silent, unlike CHANGE)', player.resources.Z, 0);
}

// ---------------------------------------------------------------------------
// FEE_COLLECT (unlike the other 5 free actions above) DOES fire GET(K) (2026-08-04, per user feedback:
// "使用料回収のフリーアクションでJOB005が反応しなくなりました...これはフリーアクションですが反応する
// ように") -- singled out from tryFreeAction's silence deliberately, see collectUsageFee's own comment.
// ---------------------------------------------------------------------------
{
  const state = freshState();
  state.maps['MAP001'] = createMapState('MAP001', 'AREA001B');
  state.maps['MAP001'].feeOwnerId = 'P1';
  state.maps['MAP001'].accumulatedFee = 3;
  giveCard(state, 'JOB005', 'P1'); // TAP=ON(GET(K),CHANGE(K,Z)), AUTO="A"
  const player = getPlayerRef(state, 'P1');
  const result = executor.collectUsageFee(state, index, { playerId: 'P1' }, 'MAP001');
  check('Fee collection still succeeds', result, { success: true, amount: 3 });
  check('...and JOB005 auto-reacts to the fee-collection-triggered GET(K), converting 1K into 1Z', player.resources.Z, 1);
  check('...leaving the other 2K from the fee alone', player.resources.K, 2);
}

// ---------------------------------------------------------------------------
// 22. EXTRA_D_PLUS_ABC_COUNT (2026-08-11, Q001B's GOAL "ABC建築数+追加色ダイス"): CARD_COUNT(A,B,C) plus
// however many color dice the player holds BEYOND the starting INITIAL_COLOR_DICE, floored at 0. Replaces
// the earlier D_PLUS_ABC_COUNT (which counted all color dice, so it started at 3 rather than 0).
// ---------------------------------------------------------------------------
const EXTRA_D = { name: 'EXTRA_D_PLUS_ABC_COUNT', args: [] };
{
  const state = freshState();
  const player = getPlayerRef(state, 'P1');
  check('No dice, no cards = 0', executor.evalMetric(state, index, 'P1', EXTRA_D), 0);

  for (let i = 0; i < INITIAL_COLOR_DICE; i++) player.dice.push(createDie(`start-${i}`, 'COLOR'));
  check('Exactly the starting color dice still counts 0 (the game-start state every QST goal now shares)', executor.evalMetric(state, index, 'P1', EXTRA_D), 0);

  const extraPlaced = createDie('extra-placed', 'COLOR');
  extraPlaced.placedMapId = 'MAP001'; // placed dice count too -- a color die stays in hand all round
  player.dice.push(extraPlaced);
  check('One die past the starting hand counts 1, even though it is already placed', executor.evalMetric(state, index, 'P1', EXTRA_D), 1);

  player.dice.push(createDie('white', 'WHITE')); // white dice are not color dice
  check('A white die does not count as an additional color die', executor.evalMetric(state, index, 'P1', EXTRA_D), 1);

  player.dice.push(createDie('extra-2', 'COLOR'));
  check('At the 5-die color cap the metric maxes out at 2 additional dice', executor.evalMetric(state, index, 'P1', EXTRA_D), 2);

  giveCard(state, 'A001A', 'P1');
  giveCard(state, 'B001A', 'P1');
  giveCard(state, 'M001', 'P1'); // M (monument) is excluded from CARD_COUNT(A,B,C)
  check('Adds CARD_COUNT(A,B,C) (2 -- A001A+B001A, M001 excluded) on top of the 2 additional dice', executor.evalMetric(state, index, 'P1', EXTRA_D), 4);
}
{
  // Floored at 0, never negative -- defensive only (nothing in the game removes a color die).
  const state = freshState();
  getPlayerRef(state, 'P1').dice.push(createDie('lonely', 'COLOR'));
  check('Fewer color dice than the starting count floors at 0 rather than going negative', executor.evalMetric(state, index, 'P1', EXTRA_D), 0);
}

// ---------------------------------------------------------------------------
// 23. UNTAP_CHOICE(SELF,3) (2026-08-15, replacing C004B/C005B/C006B/C007B/C008A/C008B's old
// UNTAP_ALL(SELF): "自分のカード3枚をアンタップにする") -- 3-or-fewer tapped cards auto-untap
// immediately with no choice; 4+ tapped cards queue an UNTAP_CHOICE pendingChoice instead.
// ---------------------------------------------------------------------------
const UNTAP_CHOICE_3 = { type: 'UNTAP_CHOICE', scope: 'SELF', count: 3 };
{
  const state = freshState();
  const a = giveCard(state, 'A001A', 'P1');
  const b = giveCard(state, 'B001A', 'P1');
  const c = giveCard(state, 'C001A', 'P1');
  state.cards[a].tapped = true;
  state.cards[b].tapped = true;
  state.cards[c].tapped = false;
  const result = executor.runCommand(state, index, { playerId: 'P1' }, UNTAP_CHOICE_3);
  check('runCommand succeeds with 2 tapped cards (<=3)', result.success, true);
  check('Both tapped cards auto-untap immediately', [state.cards[a].tapped, state.cards[b].tapped], [false, false]);
  check('No pendingChoice was created', state.pendingChoices.length, 0);
}
{
  const state = freshState();
  const ids = ['A001A', 'B001A', 'C001A', 'A002A'].map((faceId) => giveCard(state, faceId, 'P1'));
  for (const id of ids) state.cards[id].tapped = true; // 4 tapped cards -- exceeds count=3
  const result = executor.runCommand(state, index, { playerId: 'P1' }, UNTAP_CHOICE_3);
  check('runCommand succeeds with 4 tapped cards (>3)', result.success, true);
  check('None untap yet -- a choice is required first', ids.every((id) => state.cards[id].tapped === true), true);
  check('Exactly one UNTAP_CHOICE pendingChoice was queued', state.pendingChoices.filter((c) => c.kind === 'UNTAP_CHOICE').length, 1);
  const choice = state.pendingChoices.find((c) => c.kind === 'UNTAP_CHOICE');
  check('...candidates are exactly the 4 tapped physicalIds', [...choice.context.candidates].sort(), [...ids].sort());
  check('...count is 3', choice.context.count, 3);

  const badCount = executor.resolveUntapChoice(state, 'P1', ids.slice(0, 2));
  check('resolveUntapChoice fails with the wrong number of picks', badCount, { success: false, reason: 'INVALID_SELECTION' });
  const badId = executor.resolveUntapChoice(state, 'P1', [ids[0], ids[1], 'not-a-real-card']);
  check('resolveUntapChoice fails with an id not among the candidates', badId, { success: false, reason: 'INVALID_SELECTION' });

  const picked = ids.slice(0, 3);
  const ok = executor.resolveUntapChoice(state, 'P1', picked);
  check('resolveUntapChoice succeeds with exactly 3 valid picks', ok.success, true);
  check('...those 3 are now untapped', picked.every((id) => state.cards[id].tapped === false), true);
  check('...the 4th (not picked) stays tapped', state.cards[ids[3]].tapped, true);
  check('...the pendingChoice is gone', state.pendingChoices.filter((c) => c.kind === 'UNTAP_CHOICE').length, 0);

  const stale = executor.resolveUntapChoice(state, 'P1', picked);
  check('A second resolve attempt fails -- nothing left pending', stale, { success: false, reason: 'NO_PENDING_CHOICE' });
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
