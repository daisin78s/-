(function () {
/**
 * SetupManager: the one-time game-setup steps from [[project-dice-wp-flow-spec]]'s
 * "セットアップ手順" (steps 1-8), plus the per-player round-1 onboarding
 * actions referenced in steps 9-12. This module only performs the
 * *mechanical* parts (shuffling, dealing, dice rolls, bookkeeping); it does
 * not decide game flow (e.g. it doesn't itself interleave onboarding with
 * each player's first turn -- that sequencing belongs to a future turn-flow
 * controller, which should call these functions in the right order).
 *
 * Card-instance bookkeeping convention used here: M/A/B/C cards are a
 * shared, visible pool (shop + draw piles) from the start of the game, so
 * they get a GameState.cards entry immediately (ownerId: null) once
 * prepareShops() runs. CON/RESOURCE/JOB cards are private per-player deals
 * where most of what's dealt/offered never ends up owned (1 of 5 CON cards
 * unused in a 4p game, 2 of 4 dealt RESOURCE cards discarded per player,
 * only 1 JOB chosen) -- for those, no GameState.cards entry is created until
 * the player actually keeps/chooses that specific card. Discarded/unused
 * cards of these types are simply never represented in state (nothing in
 * the DSL ever references "the discard pile").
 */

'use strict';

const { shuffle, rollDie } = require('./rng');
const {
  createPlayer,
  createCardInstance,
  createMapState,
  createShopDeck,
  createDie,
  splitCardId,
  PLAYER_COLORS,
  INITIAL_COLOR_DICE,
} = require('./game-state');
const { getAreaRow, getCardRow } = require('./data-loader');
const { runProgram } = require('./executor');
const { recordCheckpoint } = require('./undo');
const board = require('./board');

const MONUMENT_SHOP_SLOT_IDS = ['SHOP001', 'SHOP002', 'SHOP003', 'SHOP004', 'SHOP005', 'SHOP006'];
const NORMAL_SHOP_SLOT_IDS = ['SHOP101', 'SHOP102', 'SHOP103', 'SHOP104', 'SHOP105', 'SHOP106'];
const SPECIAL_SHOP_SLOT_IDS = ['SHOP201', 'SHOP202', 'SHOP203'];
const CON_PHYSICAL_IDS = ['CON001', 'CON002', 'CON003', 'CON004', 'CON005', 'CON006'];
// JOB ids dropped their trailing tier letter (2026-08-0X, per user edit to game.xlsx -- JOB never had
// a real B-tier sibling anyway, so the "A" was just a leftover from the {physicalId}{tier} pattern
// every other tiered deck uses; JOB is now bare, same shape as M). See game-state.js's splitCardId,
// which already treats a bare id (no trailing letter) as {tier: null} without any change needed here.
// (No fixed JOB_FACE_IDS list here -- unlike CON_PHYSICAL_IDS above, the JOB sheet's own row count isn't
// fixed by the game's rules; dealJobPool reads index.raw.JOB directly instead, see its own doc for why.)

// ---------------------------------------------------------------------------
// Steps 1-2: players, board, shop
// ---------------------------------------------------------------------------

/** @param {string[]} playerNames - confirmed 2026-07-29: player N gets PLAYER_COLORS[N-1] (P1=PINK, ...) */
function createPlayers(state, playerNames) {
  playerNames.forEach((name, i) => {
    state.players.push(createPlayer(`P${i + 1}`, name, PLAYER_COLORS[i]));
  });
}

/** Creates MapState for every MAP row, sized to its starting AREA's non-"NONE" slot count. */
function prepareMaps(state, index) {
  for (const mapRow of index.raw.MAP) {
    const areaRow = getAreaRow(index, mapRow.CURRENT_AREA);
    const slotCount = ['SLOT1', 'SLOT2', 'SLOT3', 'SLOT4', 'SLOT5', 'SLOT6'].filter(
      (key) => areaRow[key] !== 'NONE'
    ).length;
    const map = createMapState(mapRow.ID, mapRow.CURRENT_AREA);
    // Array.from, not .fill([]) -- .fill() would give every slot the *same* array instance.
    map.slots = Array.from({ length: slotCount }, () => []);
    state.maps[mapRow.ID] = map;
  }
}

function registerCardPool(state, faceIds) {
  for (const faceId of faceIds) {
    const inst = createCardInstance(faceId);
    state.cards[inst.physicalId] = inst;
  }
}

/** Every monument, base-tier-A face, e.g. "A001A".."A007A" (008 is reserved for the special shop). */
function collectNormalShopFaceIds(index) {
  const ids = [];
  for (const sheet of ['A', 'B', 'C']) {
    for (const row of index.raw[sheet]) {
      const { physicalId, tier } = splitCardId(row.ID);
      const num = Number(physicalId.slice(1));
      if (tier === 'A' && num <= 7) ids.push(row.ID);
    }
  }
  return ids;
}

function fillShopSlots(shopDeck) {
  for (const slotId of Object.keys(shopDeck.slots)) {
    if (shopDeck.slots[slotId] === null && shopDeck.drawPile.length > 0) {
      shopDeck.slots[slotId] = shopDeck.drawPile.shift();
    }
  }
}

/**
 * Shuffles and fills the monument (SHOP001-006) and normal-card (SHOP101-106)
 * shops immediately (confirmed 2026-07-29: SHOP sheet's ROUND_MIN=1 for
 * both). Also shuffles the special shop's draw order but leaves its slots
 * empty -- see revealSpecialShop().
 *
 * preferredNormalFaceIds (optional, up to 6, 2026-08-13 debug-setup feature): those faces fill
 * SHOP101/102/... in that order first (deduped, and only ones actually in the normal pool), any
 * remaining slots filled by the usual random shuffle of whatever's left -- see fillShopSlots, which
 * always fills in slotId order from the front of the draw pile. Every other caller passes no 3rd
 * argument and sees identical behavior to before.
 */
function prepareShops(state, index, preferredNormalFaceIds) {
  const monumentIds = index.raw.M.map((r) => r.ID);
  registerCardPool(state, monumentIds);
  state.shops.M = createShopDeck(shuffle(state.rng, monumentIds), MONUMENT_SHOP_SLOT_IDS);
  fillShopSlots(state.shops.M);

  const normalIds = collectNormalShopFaceIds(index);
  registerCardPool(state, normalIds);
  const preferred = [...new Set(preferredNormalFaceIds || [])]
    .filter((id) => normalIds.includes(id))
    .slice(0, NORMAL_SHOP_SLOT_IDS.length);
  const normalOrder = preferred.length > 0
    ? [...preferred, ...shuffle(state.rng, normalIds.filter((id) => !preferred.includes(id)))]
    : shuffle(state.rng, normalIds);
  state.shops.NORMAL = createShopDeck(normalOrder, NORMAL_SHOP_SLOT_IDS);
  fillShopSlots(state.shops.NORMAL);

  const specialIds = ['A008A', 'B008A', 'C008A'];
  registerCardPool(state, specialIds);
  state.shops.SPECIAL = createShopDeck(shuffle(state.rng, specialIds), SPECIAL_SHOP_SLOT_IDS);
  // Deliberately not filled yet -- SHOP sheet's ROUND_MIN=2 for SHOP201-203 (revealSpecialShop()).
}

/** Call when round 2 starts (SHOP sheet: SHOP201-203's ROUND_MIN=2). */
function revealSpecialShop(state) {
  fillShopSlots(state.shops.SPECIAL);
}

// ---------------------------------------------------------------------------
// Step 3: initial color dice
// ---------------------------------------------------------------------------

let diceCounter = 0;
function nextSetupDieId() {
  diceCounter += 1;
  return `setup-d${diceCounter}`;
}

/** Rolls each player's starting color dice (INITIAL_COLOR_DICE, confirmed count -- shared with
 * executor.js's EXTRA_D_PLUS_ABC_COUNT metric, see that constant's own doc). Records the pre-roll undo
 * checkpoint. */
function rollInitialColorDice(state) {
  recordCheckpoint(state);
  for (const player of state.players) {
    for (let i = 0; i < INITIAL_COLOR_DICE; i++) {
      const die = createDie(nextSetupDieId(), 'COLOR');
      die.value = rollDie(state.rng);
      player.dice.push(die);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4: CON cards
// ---------------------------------------------------------------------------

/**
 * Deals one CON physicalId to each player (records the assignment only --
 * no GameState.cards entry yet, no tier chosen; see chooseConFace() for the
 * round-1 onboarding step that actually commits it).
 *
 * forcedAssignments (optional, {playerId: physicalId}, 2026-08-13 debug-setup feature): those players
 * get exactly that physical CON card instead of a random one; the remaining physical cards are shuffled
 * among everyone else as usual. Which FACE (A/B) they end up with is untouched by this -- that's still
 * chooseConFace()'s own normal onboarding-time player choice, same as any other player. Every other
 * caller passes no 2nd argument and sees identical behavior to before.
 */
function dealConCards(state, forcedAssignments) {
  const forced = forcedAssignments || {};
  const forcedIds = new Set(Object.values(forced));
  const shuffledRemaining = shuffle(state.rng, CON_PHYSICAL_IDS.filter((id) => !forcedIds.has(id)));
  let cursor = 0;
  state.players.forEach((player) => {
    player.conPhysicalId = forced[player.id] || shuffledRemaining[cursor++];
  });
}

// ---------------------------------------------------------------------------
// Steps 5-6: RESOURCE cards (deal 4, keep 2)
// ---------------------------------------------------------------------------

let choiceCounter = 0;
function nextChoiceId() {
  choiceCounter += 1;
  return `choice${choiceCounter}`;
}

/** Deals 4 RESOURCE candidates to each player as a pending SELECT_RESOURCE_CARDS choice.
 * skipPlayerIds (optional array, 2026-08-13 debug-setup feature): those players get no candidates/
 * pendingChoice at all here -- used when grantResourceCards() below has already directly settled their
 * 2 RESOURCE cards, so there's nothing left for them to choose. Every other caller passes no 3rd
 * argument and sees identical behavior to before. */
function dealResourceCandidates(state, index, skipPlayerIds) {
  const skip = new Set(skipPlayerIds || []);
  const allIds = index.raw.RESOURCE.map((r) => r.ID);
  const shuffled = shuffle(state.rng, allIds);
  let cursor = 0;
  for (const player of state.players) {
    if (skip.has(player.id)) continue;
    const candidates = shuffled.slice(cursor, cursor + 4);
    cursor += 4;
    state.pendingChoices.push({
      id: nextChoiceId(),
      playerId: player.id,
      kind: 'SELECT_RESOURCE_CARDS',
      context: { candidates },
    });
  }
}

/** Re-deals a fresh SELECT_RESOURCE_CARDS choice for playerId, undoing whatever RESOURCE cards they
 * already own if any (2026-08-21, per user request: switching a player from AI to HUMAN mid-selection
 * -- main.js's player-role control -- should cancel whatever the AI already auto-picked for them,
 * letting the human choose for real instead of inheriting the AI's pick). No-op once state.round has
 * actually started (round 1's turn order is already computed from the ORIGINAL picks' START_ORDER by
 * then, so silently redealing would desync it) -- the caller should only invoke this during round 0.
 * Chosen RESOURCE cards never run their ONCE at this stage (see chooseResourceCards' own doc -- that
 * happens later, at CON-face onboarding), so there's no resource grant to reverse, only ownership
 * bookkeeping. Candidates exclude every RESOURCE physicalId already owned by anyone, or already offered
 * as another player's own still-pending candidate, so this can never hand out a card someone else has
 * already spoken for. */
function redealResourceCandidates(state, index, playerId) {
  if (state.round !== 0) return;
  const player = state.players.find((p) => p.id === playerId);
  const ownedResourceIds = player.ownedCardPhysicalIds.filter((id) => id.startsWith('R'));
  for (const id of ownedResourceIds) delete state.cards[id];
  player.ownedCardPhysicalIds = player.ownedCardPhysicalIds.filter((id) => !id.startsWith('R'));
  state.pendingChoices = state.pendingChoices.filter((c) => !(c.playerId === playerId && c.kind === 'SELECT_RESOURCE_CARDS'));

  const usedIds = new Set();
  for (const p of state.players) {
    for (const id of p.ownedCardPhysicalIds) if (id.startsWith('R')) usedIds.add(id);
  }
  for (const choice of state.pendingChoices) {
    if (choice.kind === 'SELECT_RESOURCE_CARDS') for (const id of choice.context.candidates) usedIds.add(id);
  }
  const available = index.raw.RESOURCE.map((r) => r.ID).filter((id) => !usedIds.has(id));
  const candidates = shuffle(state.rng, available).slice(0, 4);
  state.pendingChoices.push({
    id: nextChoiceId(),
    playerId,
    kind: 'SELECT_RESOURCE_CARDS',
    context: { candidates },
  });
}

/**
 * Resolves a player's SELECT_RESOURCE_CARDS choice: the 2 chosenIds become
 * owned card instances (untapped, ownerId set); the other 2 are discarded
 * (never represented in state). Does NOT run their ONCE effects -- that
 * happens later, at onboarding (see receiveInitialResources()).
 */
function chooseResourceCards(state, playerId, chosenIds) {
  const player = state.players.find((p) => p.id === playerId);
  const choiceIndex = state.pendingChoices.findIndex(
    (c) => c.playerId === playerId && c.kind === 'SELECT_RESOURCE_CARDS'
  );
  if (choiceIndex === -1) return { success: false, reason: 'NO_PENDING_CHOICE' };
  const choice = state.pendingChoices[choiceIndex];
  // context.count (2026-08-15 debug-setup feature, see grantOneResourceCardAndDealRest): how many of
  // candidates must be picked to complete this choice. Defaults to 2 -- the normal, non-debug path's
  // pendingChoices never set this field at all, so every existing caller sees identical behavior.
  const requiredCount = choice.context.count || 2;
  if (chosenIds.length !== requiredCount || chosenIds.some((id) => !choice.context.candidates.includes(id))) {
    return { success: false, reason: 'INVALID_SELECTION' };
  }
  for (const faceId of chosenIds) {
    const inst = createCardInstance(faceId);
    inst.ownerId = playerId;
    state.cards[inst.physicalId] = inst;
    player.ownedCardPhysicalIds.push(inst.physicalId);
  }
  state.pendingChoices.splice(choiceIndex, 1);
  return { success: true };
}

/**
 * Directly grants playerId exactly 2 owned RESOURCE cards, bypassing the normal deal-4-candidates/
 * choose-2 SELECT_RESOURCE_CARDS flow entirely (2026-08-13 debug-setup feature -- see the matching
 * dealResourceCandidates skipPlayerIds param, which must be used for the same playerId so no leftover
 * pendingChoice asks them to pick 2 more on top of these). preferredFaceIds (up to 2, deduped, only
 * ones that are actually valid RESOURCE ids) are used first; any remaining slot is filled by a random
 * draw from whatever's left, so this always leaves the player with exactly 2, same as the normal path.
 * Does NOT run their ONCE effects -- same as chooseResourceCards, that's still deferred to the normal
 * onboarding-time receiveInitialResources() call.
 */
function grantResourceCards(state, index, playerId, preferredFaceIds) {
  const allIds = index.raw.RESOURCE.map((r) => r.ID);
  const preferred = [...new Set(preferredFaceIds || [])].filter((id) => allIds.includes(id)).slice(0, 2);
  const needed = 2 - preferred.length;
  const fill = needed > 0 ? shuffle(state.rng, allIds.filter((id) => !preferred.includes(id))).slice(0, needed) : [];
  const player = state.players.find((p) => p.id === playerId);
  for (const faceId of [...preferred, ...fill]) {
    const inst = createCardInstance(faceId);
    inst.ownerId = playerId;
    state.cards[inst.physicalId] = inst;
    player.ownedCardPhysicalIds.push(inst.physicalId);
  }
}

/**
 * Directly grants playerId one owned RESOURCE card (preferredFaceId), then deals 3 more random
 * candidates (excluding it) as a pending SELECT_RESOURCE_CARDS choice needing exactly 1 more pick to
 * reach the normal total of 2 (2026-08-15 debug-setup feature, for when only 1 of the 2 initial
 * RESOURCE cards was preselected -- see createInitialState's own doc for the 0/1/2-preselected split).
 * Mirrors grantResourceCards' direct-grant style for the locked-in card, and dealResourceCandidates'
 * pending-choice style for the rest -- see chooseResourceCards' context.count for how the "pick 1, not
 * 2" requirement is carried through to resolution.
 */
function grantOneResourceCardAndDealRest(state, index, playerId, preferredFaceId) {
  const allIds = index.raw.RESOURCE.map((r) => r.ID);
  const inst = createCardInstance(preferredFaceId);
  inst.ownerId = playerId;
  state.cards[inst.physicalId] = inst;
  const player = state.players.find((p) => p.id === playerId);
  player.ownedCardPhysicalIds.push(inst.physicalId);
  const candidates = shuffle(state.rng, allIds.filter((id) => id !== preferredFaceId)).slice(0, 3);
  state.pendingChoices.push({
    id: nextChoiceId(),
    playerId,
    kind: 'SELECT_RESOURCE_CARDS',
    context: { candidates, count: 1 },
  });
}

// ---------------------------------------------------------------------------
// Step 7: start order
// ---------------------------------------------------------------------------

/**
 * turnOrder = ascending by (CON.START_ORDER + sum of the 2 kept RESOURCE
 * cards' START_ORDER); ties broken by ascending CON.START_ORDER. Requires
 * every player to already have conPhysicalId set and exactly 2 owned
 * RESOURCE cards (i.e. dealConCards() + chooseResourceCards() for everyone).
 */
function computeStartOrder(state, index) {
  const scored = state.players.map((player) => {
    const conRow = getCardRow(index, `${player.conPhysicalId}A`); // START_ORDER is identical on both faces
    const resourceIds = player.ownedCardPhysicalIds.filter((id) => id.startsWith('R'));
    const resourceSum = resourceIds.reduce((sum, id) => sum + getCardRow(index, id).START_ORDER, 0);
    return { playerId: player.id, total: conRow.START_ORDER + resourceSum, conStartOrder: conRow.START_ORDER };
  });
  scored.sort((a, b) => a.total - b.total || a.conStartOrder - b.conStartOrder);
  state.turnOrder = scored.map((s) => s.playerId);
  return state.turnOrder;
}

// ---------------------------------------------------------------------------
// Round-1 onboarding actions (steps 9-12): JOB choice, CON face choice,
// initial resource receipt. Sequencing these per-player alongside first
// turns is the future turn-flow controller's job -- these are just the
// atomic building blocks it will call.
// ---------------------------------------------------------------------------

/**
 * Reveals 6 of the 8 JOB cards as a shared draft pool (confirmed
 * 2026-07-29): the other 2 are never revealed and go unused for the whole
 * game. Players draft one each from this pool, in start-play order, during
 * round-1 onboarding (see chooseJob()); after all 4 have drafted, the 2
 * left in the pool plus the original 2 never-revealed ones (4 total) go
 * unused. Call once, before the first player's onboarding.
 *
 * preferredFaceIds (optional, up to 6, deduped, 2026-08-13 debug-setup feature): those are guaranteed
 * in the revealed pool, the remaining slots filled by the usual random draw from whatever's left. Who
 * actually drafts which one out of the pool is still each player's own normal chooseJob() pick, exactly
 * as before. Every other caller passes no 3rd argument and sees identical behavior to before.
 *
 * Reads the live JOB sheet (index.raw.JOB) rather than the old hardcoded JOB_FACE_IDS list (2026-08-17
 * fix, per user report: "開拓者出てきません テストゲームで選んでも出てきません") -- that list was
 * defined before JOB009 existed, so both the random draw AND the debug picker's preferredFaceIds filter
 * silently excluded it entirely, the same class of "stale hardcoded list" bug the CON-sheet-reorg
 * incident already caught elsewhere. index is now a required 2nd argument -- see this function's 4 call
 * sites (game-runner.js, main.js, tests) for the matching update.
 */
function dealJobPool(state, index, preferredFaceIds) {
  const allJobFaceIds = index.raw.JOB.map((r) => r.ID);
  const preferred = [...new Set(preferredFaceIds || [])].filter((id) => allJobFaceIds.includes(id)).slice(0, 6);
  const rest = shuffle(state.rng, allJobFaceIds.filter((id) => !preferred.includes(id)));
  state.jobPool = [...preferred, ...rest].slice(0, 6);
}

/** Drafts jobFaceId out of state.jobPool for playerId (must currently be in the pool). */
function chooseJob(state, index, playerId, jobFaceId) {
  const poolIndex = state.jobPool.indexOf(jobFaceId);
  if (poolIndex === -1) return { success: false, reason: 'NOT_IN_JOB_POOL' };
  state.jobPool.splice(poolIndex, 1);

  const player = state.players.find((p) => p.id === playerId);
  const inst = createCardInstance(jobFaceId);
  inst.ownerId = playerId;
  state.cards[inst.physicalId] = inst;
  player.ownedCardPhysicalIds.push(inst.physicalId);
  player.jobCardId = jobFaceId;
  const row = getCardRow(index, jobFaceId);
  const onceResult = runProgram(state, index, { playerId, sourcePhysicalId: inst.physicalId }, row.ONCE);
  if (row.NAME === '革命家') grantRevolutionaryBonusIfEarned(state, index, playerId);
  return onceResult;
}

/** JOB010/革命家's bespoke ONCE-equivalent (2026-08-21, per user's new INST text -- no DSL, same
 * "bespoke, NAME-matched" approach as board.hasWildcardDice/hasPioneerAbility/hasLandlordAbility):
 * "Bカード革命の兆し(B007A)をSHOPか山札から探して獲得する。革命の兆しがいずれかのプレイヤーに先に獲得
 * されていたならば、代わりに山札からJOBを3枚引きその中からJOBを選ぶ（選んだJOBが革命家を置き換える）"。
 * Called from chooseJob right after JOB010's own (empty) ONCE, so every one of chooseJob's existing
 * callers gets this for free without their own bookkeeping (confirmed via Explore agent: none of them
 * inspect chooseJob's return value). No cost paid either way -- this is a drafted bonus, not a build. */
function grantRevolutionaryBonusIfEarned(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (state.cards.B007.ownerId === null) {
    const shop = state.shops.NORMAL;
    const slotId = Object.keys(shop.slots).find((id) => shop.slots[id] === 'B007A');
    if (slotId) {
      shop.slots[slotId] = null;
      board.compactShop(state, 'NORMAL');
    } else {
      const drawIndex = shop.drawPile.indexOf('B007A');
      if (drawIndex !== -1) shop.drawPile.splice(drawIndex, 1);
      // If B007A is in neither the shop slots nor the draw pile, it must already be owned -- but that's
      // exactly the state.cards.B007.ownerId check above, so this branch is unreachable in practice.
    }
    const inst = createCardInstance('B007A');
    inst.ownerId = playerId;
    state.cards[inst.physicalId] = inst;
    player.ownedCardPhysicalIds.push(inst.physicalId);
    return;
  }

  const takenJobFaceIds = new Set([...state.jobPool, ...state.players.map((p) => p.jobCardId).filter(Boolean)]);
  const remaining = index.raw.JOB.map((r) => r.ID).filter((id) => !takenJobFaceIds.has(id));
  const candidates = shuffle(state.rng, remaining).slice(0, 3);
  state.pendingChoices.push({
    id: nextChoiceId(),
    playerId,
    kind: 'PICK_JOB_REPLACEMENT',
    context: { candidates },
  });
}

/** Resolves a player's PICK_JOB_REPLACEMENT choice (see grantRevolutionaryBonusIfEarned's own doc):
 * chosenFaceId must be one of choice.context.candidates. The pick REPLACES JOB010 entirely (2026-08-21,
 * per user decision) -- JOB010 is removed from the player's owned cards and its state.cards entry
 * released (ownerId: null, left in state rather than deleted, same convention as every other card-
 * removal in this codebase), then the new JOB is drafted via the same steps chooseJob itself uses
 * (own state.cards entry, ownedCardPhysicalIds, jobCardId, run its ONCE). Deliberately does not call
 * chooseJob() itself, since chosenFaceId is never in state.jobPool (this is a private 3-card draw, not
 * the shared pool -- see grantRevolutionaryBonusIfEarned's own doc) and chooseJob would reject that. */
function resolveJobReplacementChoice(state, index, playerId, chosenFaceId) {
  const choiceIndex = state.pendingChoices.findIndex((c) => c.playerId === playerId && c.kind === 'PICK_JOB_REPLACEMENT');
  if (choiceIndex === -1) return { success: false, reason: 'NO_PENDING_CHOICE' };
  const choice = state.pendingChoices[choiceIndex];
  if (!choice.context.candidates.includes(chosenFaceId)) return { success: false, reason: 'INVALID_SELECTION' };

  const player = state.players.find((p) => p.id === playerId);
  const oldJobPhysicalId = player.jobCardId;
  player.ownedCardPhysicalIds = player.ownedCardPhysicalIds.filter((id) => id !== oldJobPhysicalId);
  state.cards[oldJobPhysicalId].ownerId = null;

  const inst = createCardInstance(chosenFaceId);
  inst.ownerId = playerId;
  state.cards[inst.physicalId] = inst;
  player.ownedCardPhysicalIds.push(inst.physicalId);
  player.jobCardId = chosenFaceId;

  state.pendingChoices.splice(choiceIndex, 1);
  const row = getCardRow(index, chosenFaceId);
  const onceResult = runProgram(state, index, { playerId, sourcePhysicalId: inst.physicalId }, row.ONCE);
  return { success: true, onceResult };
}

/** @param {'A'|'B'} face */
function chooseConFace(state, index, playerId, face) {
  const player = state.players.find((p) => p.id === playerId);
  const faceId = `${player.conPhysicalId}${face}`;
  const inst = createCardInstance(faceId);
  inst.ownerId = playerId;
  state.cards[inst.physicalId] = inst;
  player.ownedCardPhysicalIds.push(inst.physicalId);
  player.conFace = face;
  const row = getCardRow(index, faceId);
  return runProgram(state, index, { playerId, sourcePhysicalId: inst.physicalId }, row.ONCE);
}

/** Runs the ONCE effect of both of the player's chosen RESOURCE cards (the "初期資源受取" step). */
function receiveInitialResources(state, index, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const results = [];
  for (const physicalId of player.ownedCardPhysicalIds) {
    if (!physicalId.startsWith('R')) continue;
    const row = getCardRow(index, physicalId);
    results.push(runProgram(state, index, { playerId, sourcePhysicalId: physicalId }, row.ONCE));
  }
  return results;
}

module.exports = {
  createPlayers,
  prepareMaps,
  prepareShops,
  collectNormalShopFaceIds,
  revealSpecialShop,
  rollInitialColorDice,
  dealConCards,
  dealResourceCandidates,
  redealResourceCandidates,
  chooseResourceCards,
  grantResourceCards,
  grantOneResourceCardAndDealRest,
  computeStartOrder,
  dealJobPool,
  chooseJob,
  resolveJobReplacementChoice,
  chooseConFace,
  receiveInitialResources,
};

})();
