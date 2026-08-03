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
} = require('./game-state');
const { getAreaRow, getCardRow } = require('./data-loader');
const { runProgram } = require('./executor');
const { recordCheckpoint } = require('./undo');

const MONUMENT_SHOP_SLOT_IDS = ['SHOP001', 'SHOP002', 'SHOP003', 'SHOP004', 'SHOP005', 'SHOP006'];
const NORMAL_SHOP_SLOT_IDS = ['SHOP101', 'SHOP102', 'SHOP103', 'SHOP104', 'SHOP105', 'SHOP106'];
const SPECIAL_SHOP_SLOT_IDS = ['SHOP201', 'SHOP202', 'SHOP203'];
const CON_PHYSICAL_IDS = ['CON001', 'CON002', 'CON003', 'CON004', 'CON005'];
const JOB_FACE_IDS = ['JOB001A', 'JOB002A', 'JOB003A', 'JOB004A', 'JOB005A', 'JOB006A', 'JOB007A', 'JOB008A'];

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
 */
function prepareShops(state, index) {
  const monumentIds = index.raw.M.map((r) => r.ID);
  registerCardPool(state, monumentIds);
  state.shops.M = createShopDeck(shuffle(state.rng, monumentIds), MONUMENT_SHOP_SLOT_IDS);
  fillShopSlots(state.shops.M);

  const normalIds = collectNormalShopFaceIds(index);
  registerCardPool(state, normalIds);
  state.shops.NORMAL = createShopDeck(shuffle(state.rng, normalIds), NORMAL_SHOP_SLOT_IDS);
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

/** Rolls 3 color dice for every player (confirmed initial count). Records the pre-roll undo checkpoint. */
function rollInitialColorDice(state) {
  recordCheckpoint(state);
  for (const player of state.players) {
    for (let i = 0; i < 3; i++) {
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
 */
function dealConCards(state) {
  const shuffled = shuffle(state.rng, CON_PHYSICAL_IDS);
  state.players.forEach((player, i) => {
    player.conPhysicalId = shuffled[i];
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

/** Deals 4 RESOURCE candidates to each player as a pending SELECT_RESOURCE_CARDS choice. */
function dealResourceCandidates(state, index) {
  const allIds = index.raw.RESOURCE.map((r) => r.ID);
  const shuffled = shuffle(state.rng, allIds);
  let cursor = 0;
  for (const player of state.players) {
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
  if (chosenIds.length !== 2 || chosenIds.some((id) => !choice.context.candidates.includes(id))) {
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
 */
function dealJobPool(state) {
  state.jobPool = shuffle(state.rng, JOB_FACE_IDS).slice(0, 6);
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
  return runProgram(state, index, { playerId, sourcePhysicalId: inst.physicalId }, row.ONCE);
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
  revealSpecialShop,
  rollInitialColorDice,
  dealConCards,
  dealResourceCandidates,
  chooseResourceCards,
  computeStartOrder,
  dealJobPool,
  chooseJob,
  chooseConFace,
  receiveInitialResources,
};

})();
