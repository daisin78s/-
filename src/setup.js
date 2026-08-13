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

const MONUMENT_SHOP_SLOT_IDS = ['SHOP001', 'SHOP002', 'SHOP003', 'SHOP004', 'SHOP005', 'SHOP006'];
const NORMAL_SHOP_SLOT_IDS = ['SHOP101', 'SHOP102', 'SHOP103', 'SHOP104', 'SHOP105', 'SHOP106'];
const SPECIAL_SHOP_SLOT_IDS = ['SHOP201', 'SHOP202', 'SHOP203'];
const CON_PHYSICAL_IDS = ['CON001', 'CON002', 'CON003', 'CON004', 'CON005'];
// JOB ids dropped their trailing tier letter (2026-08-0X, per user edit to game.xlsx -- JOB never had
// a real B-tier sibling anyway, so the "A" was just a leftover from the {physicalId}{tier} pattern
// every other tiered deck uses; JOB is now bare, same shape as M). See game-state.js's splitCardId,
// which already treats a bare id (no trailing letter) as {tier: null} without any change needed here.
const JOB_FACE_IDS = ['JOB001', 'JOB002', 'JOB003', 'JOB004', 'JOB005', 'JOB006', 'JOB007', 'JOB008'];

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
 * as before. Every other caller passes no 2nd argument and sees identical behavior to before.
 */
function dealJobPool(state, preferredFaceIds) {
  const preferred = [...new Set(preferredFaceIds || [])].filter((id) => JOB_FACE_IDS.includes(id)).slice(0, 6);
  const rest = shuffle(state.rng, JOB_FACE_IDS.filter((id) => !preferred.includes(id)));
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
  collectNormalShopFaceIds,
  revealSpecialShop,
  rollInitialColorDice,
  dealConCards,
  dealResourceCandidates,
  chooseResourceCards,
  grantResourceCards,
  computeStartOrder,
  dealJobPool,
  chooseJob,
  chooseConFace,
  receiveInitialResources,
};

})();
