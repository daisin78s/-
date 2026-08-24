(function () {
/**
 * GameState: the single mutable runtime state object for a game of Dice WP.
 * No DOM dependency. Pure data + factory/clone helpers -- no game rules here.
 * Game rules live in CommandBuilder/Executor (not yet implemented), which
 * read static card definitions from the loaded data (data/game.json) by ID
 * and only write into the *runtime* fields modeled here (location, tapped
 * state, resource counts, dice, log, ...). Static card fields (COST, DSL
 * strings, VP, DICE threshold, ...) are never copied into GameState.
 *
 * Design assumptions carried over from the "Undo/セーブ/ログ" spec:
 *  - The whole GameState must be snapshot-able and restorable (undo checkpoints
 *    are "just before rolling color dice" and "just before rolling white dice").
 *  - The action log alone must be enough to replay/reconstruct a game.
 *  - Every physical card in the game is unique (only one copy of e.g. "A001"
 *    exists across all decks/shops/players), so a card's base ID can serve as
 *    its stable identity even as it flips from tier A to tier B ("upgrade").
 */

'use strict';

const { createRng } = require('./rng');

// ---------------------------------------------------------------------------
// Card identity helpers
// ---------------------------------------------------------------------------

/**
 * Splits a data-sheet card ID into its physical identity and tier letter.
 * Tiered cards (A/B/C/CON decks) are named e.g. "A001A" / "A001B" -- two rows
 * in the data that represent the *same physical card*, face-up on tier A or
 * flipped to tier B. Non-tiered cards (M, JOB, RESOURCE) have no trailing
 * letter after the digits and are returned with tier: null.
 *
 * splitCardId('A001A') -> { physicalId: 'A001', tier: 'A' }
 * splitCardId('CON002B') -> { physicalId: 'CON002', tier: 'B' }
 * splitCardId('M001') -> { physicalId: 'M001', tier: null }
 * splitCardId('JOB001A') -> { physicalId: 'JOB001', tier: 'A' } // never has a 'B' sibling
 *
 * @param {string} cardId
 * @returns {{physicalId: string, tier: string|null}}
 */
function splitCardId(cardId) {
  const m = /^(.*\d)([A-Z])$/.exec(cardId);
  if (!m) return { physicalId: cardId, tier: null };
  return { physicalId: m[1], tier: m[2] };
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DieState
 * @property {string} id            - stable within the current round only
 * @property {'COLOR'|'WHITE'} kind
 * @property {number|null} value    - null until rolled this round
 * @property {string|null} placedMapId - MAP id this die currently occupies, or null if in hand
 * @property {boolean} placeAnywhereThisTurn - set by GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN)
 *   (e.g. B001A's TAP). Cleared at TURNEND. NOTE (2026-07-29): board.js's placeDice() does not yet
 *   honor this flag to bypass the SLOT_OCCUPIED check -- doing so properly requires deciding whether
 *   a slot can hold more than one die at once, which isn't settled (see [[project-dice-wp]]'s open
 *   gaps). The flag is tracked so that decision doesn't also require a GameState shape change later.
 * @property {boolean} passed - set by board.passDie (2026-08-03, per user feedback: "色ダイスを置けな
 *   い時、または起きたくない時ラウンドをパスする手段がありません") when the player declines to place
 *   this die at all this round, instead of being forced to keep facing "is there a legal slot" every
 *   time turn-flow.getNextTurn cycles back to them. Excluded from turn-flow's "still needs an action"
 *   checks the same way placedMapId!==null is, but NOT from endRound's "unused color die -> 3K" rule
 *   (a passed die is exactly as unused as a genuinely-unplaceable one) -- see turn-flow.js's own
 *   comments. Reset to false at round end, same lifetime as placedMapId.
 * @property {boolean} valueChangedThisTurn - set by executor.runSetDiceAny/runSetDieValue/
 *   runChangeDieValue (2026-08-18, per user report: 道化/JOB003's "ダイス目を変える" combined with its
 *   own GRANT_PLACE_ANYWHERE let a player freely conjure whatever value was needed to stack onto their
 *   own already-placed die at 王宮/元老院, summing buildValue -- e.g. a real die showing 3 plus a
 *   JOB003-set 4 reaching a monument's DICE>=7 threshold using what's really only 1 fresh placement.
 *   Especially severe once JOB003 became unlimited-use/no-tap -- see board.useBareTapAbility's own doc.
 *   board.placeDice reads this to block exactly that combo (changed value + stacking onto the SAME
 *   player's own die, at those 2 maps specifically) while leaving every other GRANT_PLACE_ANYWHERE use
 *   untouched, including the legitimate multi-turn castle-investment pattern with a naturally-rolled
 *   die. Cleared at TURNEND, same lifetime as placeAnywhereThisTurn just above.
 * @property {number|null} valueBeforeChangeThisTurn - the die's own value right before the FIRST
 *   SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE change this turn (2026-08-24, per user request: "すべ
 *   てのダイス目変更はターン終了時に変えた目が元に戻る"). executor.applyTurnEnd restores die.value
 *   from this if the die is still unplaced at that point -- a die actually placed this turn keeps
 *   showing its changed value, since the slot's own occupant record already holds an independent copy
 *   of it (see board.placeDice's own `value: die.value` snapshot), untouched by whatever this live Die
 *   object does afterward. null whenever valueChangedThisTurn is false.
 */

/**
 * @param {string} id
 * @param {'COLOR'|'WHITE'} kind
 * @returns {DieState}
 */
function createDie(id, kind) {
  return { id, kind, value: null, placedMapId: null, placeAnywhereThisTurn: false, passed: false, valueChangedThisTurn: false, valueBeforeChangeThisTurn: null };
}

/**
 * @typedef {Object} PlayerState
 * @property {string} id
 * @property {string} name
 * @property {string|null} jobCardId      - e.g. "JOB003A", chosen during round-1 onboarding
 * @property {string|null} conPhysicalId  - e.g. "CON002", the CON card dealt to this player
 * @property {'A'|'B'|null} conFace       - which face of the CON card was chosen (once, at onboarding)
 * @property {Object<string, number>} resources - keys: K, A, B, C, Z, VP, BZ (only positive/zero counts; BZ is spent immediately so usually stays 0)
 * @property {DieState[]} dice            - both COLOR and WHITE dice owned by this player this round
 * @property {number} colorDiceCap        - 5, kept here in case a card ever modifies it
 * @property {number} whiteDiceCap        - 5
 * @property {string[]} ownedCardPhysicalIds - physicalIds of cards this player has built/acquired (see GameState.cards for face/tapped)
 * @property {number} startOrderValue     - set during setup, used once to compute turn order
 * @property {Object<string, boolean>} freeActionTaps - tap flags per FREE_ACTION_IDS entry (confirmed
 *   2026-07-29). A/B/C/Z->K have no usage limit at all (confirmed by the user: "回数制限ありません") and
 *   never set their own entries here; those entries stay permanently false and are unused by
 *   executor.tryFreeAction. Usage-fee collection used to be the one exception gated by this (once per
 *   round, shared across every map) but that was reversed 2026-08-06 (per user feedback: "使用料回収は
 *   未回収の使用料がある限り何回でも使えるようにかえてください") -- collectUsageFee no longer reads or
 *   writes freeActionTaps at all, gated purely by each map's own accumulatedFee instead (see its own doc).
 *   (2026-08-07: wD->2K, formerly a 6th entry here, was abolished per user request -- see
 *   FREE_ACTION_IDS' own doc.)
 * @property {Object<string, boolean>} freeActionAutoMode - per FREE_ACTION_IDS entry: true ("オート") =
 *   auto-fire when usable, false ("マニュアル") = wait for the player. Defaults to false (manual) for
 *   every entry (confirmed 2026-07-29 -- all free actions default to manual); player-adjustable
 *   during play. The auto-fire trigger condition itself is not yet designed (see
 *   [[project-dice-wp-flow-spec]]) -- this only stores the current setting.
 * @property {Object<string, boolean>} cardAutoModeOverrides - sparse map, physicalId -> true/false,
 *   present only once the player has changed a card's TAP ability away from its data-sheet AUTO
 *   column default ("A"/"M", see [[project-dice-wp-flow-spec]]). Absence means "use the card's
 *   default" -- look it up via data, don't assume false. Player-adjustable during play (confirmed
 *   2026-07-29).
 * @property {string} color - one of PLAYER_COLORS, assigned by player order at game creation
 *   (confirmed 2026-07-29, provisional per the user: "暫定です後で変わるかも"). Purely an identity
 *   label (dice/pieces are this player's color) -- game logic keys everything off `id`, never color.
 * @property {string[]} blockedBuildCategoriesThisTurn - BUILD categories (e.g. "M") this player may not
 *   build this turn, set by DSL's BLOCK_BUILD(category,THIS_TURN) (confirmed 2026-08-04: using JOB004's
 *   TAP CHANGE(3K,2BZ) blocks building a monument for the rest of that turn). Turn-scoped like
 *   GRANT_PLACE_ANYWHERE's THIS_TURN flag -- reset in executor.applyTurnEnd.
 * @property {number} monumentDiceDiscountThisTurn - lowers a monument's own DICE threshold (e.g. ">=12")
 *   by this much when board.getBuildCandidates checks category "M", set by DSL's
 *   MONUMENT_DICE_DISCOUNT(n,THIS_TURN) (2026-08-18, JOB007/密使's revised TAP). Sums if granted more
 *   than once in the same turn (no card does today, but nothing stops a future one). Turn-scoped, same
 *   reset point as blockedBuildCategoriesThisTurn above.
 * @property {{mapId:string, amount:number}|null} pendingFee - set by board.placeDice/placeDiceGroup
 *   (2026-08-04, fixing a gap where accumulatedFee was never actually charged -- see executor.js's
 *   USAGE_FEE_BY_TIER) when this player places on a MAP whose feeOwnerId is someone else (tier B=1K,
 *   C=2K, confirmed: "持ち主自身が使う場合は使用料なし"). Resolved at this same TURNEND (confirmed:
 *   "使用料はTURNEND時に支払い（払えなければフリーアクションで変換 or 巻き戻し）") -- same
 *   gate-then-mutate pattern as RESOURCE_TOTAL_LIMIT: executor.canEndTurn blocks TURNEND while unpayable,
 *   executor.applyTurnEnd deducts K from the player and adds it to the map's accumulatedFee, then clears
 *   this back to null. At most one is ever pending at a time ("1ターン=ダイス1個の配置" means at most one
 *   placement per turn); Undo clears it for free since it's plain GameState.
 * @property {number} lockedK - K set aside for a pendingFee incurred specifically at 元老院/AREA009
 *   (board.AREA009_MAP_ID) -- executor.tryPay/resolvePayment refuse to spend below this floor on
 *   anything else (2026-08-11, per user report: with monument VP raised, a seeded AI game got JOB005's
 *   automatic ON(GET(K),CHANGE(K,Z)) reaction converting 1 of AREA009C's ADD(2K,BZ) reward into Z, which
 *   then paid for a monument build, leaving the AREA009 fee permanently unpayable -- see board.js's
 *   chargeUsageFeeIfOwed for where this gets set). Scoped to AREA009 only, per user decision (other
 *   tier B/C AREAs' fees keep the pre-existing, unreserved canAffordFee-at-placement-time behavior).
 *   Cleared back to 0 in lockstep with pendingFee, in executor.applyTurnEnd.
 * @property {number} bardEmblemUnitsGranted - 吟遊詩人/JOB008's own watermark (2026-08-17, replacing its
 *   old live VP_MODIFIER(TOTAL_EMBLEM_COUNT) formula per user request: "エンブレムが3個増えるごとにターン
 *   終了時1VPとZを得る"): how many complete 3-emblem groups this player has already been credited for.
 *   Checked/incremented once per TURNEND (see turn-flow.grantBardBonusIfEarned) -- floor(current
 *   TOTAL_EMBLEM_COUNT / 3) minus this value is how many new units to grant (1VP+1Z each) right now.
 *   Irrelevant for a player without 吟遊詩人 (stays 0, never read).
 */

/** Fixed palette, assigned in player order (player 1 = PINK, ...). Provisional -- see PlayerState.color. */
const PLAYER_COLORS = ['PINK', 'PURPLE', 'GREEN', 'ORANGE'];

/** Free-action IDs, see PlayerState.freeActionTaps. FEE_COLLECT is no longer one of these (2026-08-06,
 * see freeActionTaps' own doc) -- collectUsageFee never reads/writes freeActionTaps at all now. wD_K
 * (wD->2K) was removed (2026-08-07, per user request: "wD→２Kのフリーアクション廃止します") -- white dice
 * no longer have any free-action conversion to K at all; they're still spent via card/AREA effects and
 * still auto-overflow to 2K past the 5-die cap (an unrelated, always-on rule -- see executor.js's
 * grantOneDie, not a free action and not touched by this removal). */
const FREE_ACTION_IDS = ['A_K', 'B_K', 'C_K', 'Z_K'];

/** How many color dice every player starts the game holding (setup step 3, see setup.rollInitialColorDice).
 * Extracted as a shared constant 2026-08-11 because executor.js's EXTRA_D_PLUS_ABC_COUNT metric ("追加色
 * ダイス" = however many color dice a player has gained BEYOND their starting hand) has to subtract exactly
 * this number -- with colorDiceCap at 5, that metric's range is 0..2. Two copies of "3" that must agree is
 * the kind of thing that silently drifts, so both read this one. */
const INITIAL_COLOR_DICE = 3;

/**
 * @param {string} id
 * @param {string} name
 * @param {string|null} [color] - see PLAYER_COLORS; optional since most callers (tests, anything
 *   not building a real game) don't care about display identity
 * @returns {PlayerState}
 */
function createPlayer(id, name, color = null) {
  const freeActionTaps = {};
  const freeActionAutoMode = {};
  for (const actionId of FREE_ACTION_IDS) {
    freeActionTaps[actionId] = false;
    freeActionAutoMode[actionId] = false;
  }
  return {
    id,
    name,
    color,
    jobCardId: null,
    conPhysicalId: null,
    conFace: null,
    resources: { K: 0, A: 0, B: 0, C: 0, Z: 0, VP: 0, BZ: 0 },
    dice: [],
    colorDiceCap: 5,
    whiteDiceCap: 5,
    freeActionAutoMode,
    cardAutoModeOverrides: {},
    ownedCardPhysicalIds: [],
    startOrderValue: 0,
    freeActionTaps,
    blockedBuildCategoriesThisTurn: [],
    monumentDiceDiscountThisTurn: 0,
    pendingFee: null,
    lockedK: 0,
    bardEmblemUnitsGranted: 0,
  };
}

/**
 * @typedef {Object} CardInstanceState
 * @property {string} physicalId       - stable identity, e.g. "A001"
 * @property {string} currentFaceId    - the data-sheet row currently active, e.g. "A001A" or "A001B"
 * @property {string|null} ownerId     - null while sitting in a deck/shop, set once built/acquired
 * @property {boolean} tapped
 */

/**
 * @param {string} faceCardId - the card's starting face, e.g. "A001A" or "M001"
 * @returns {CardInstanceState}
 */
function createCardInstance(faceCardId) {
  const { physicalId } = splitCardId(faceCardId);
  return { physicalId, currentFaceId: faceCardId, ownerId: null, tapped: false };
}

/**
 * @typedef {Object} MapState
 * @property {string} mapId            - e.g. "MAP003"
 * @property {string} currentAreaId    - e.g. "AREA003A", flips via ONCE's "MAP{n}.CURRENT_AREA=..." assignment
 * @property {SlotDie[][]} slots       - length matches the active AREA's SLOT1..SLOT6 (see notes below).
 *   Each position holds an *array* of occupants, but never more than 1 real one (2026-08-21, per user
 *   request, replacing the earlier "stacking" model: a slot's array shape is kept only for a uniform
 *   empty-vs-occupied check, not because 2+ dice can ever coexist there). GRANT_PLACE_ANYWHERE
 *   (THIS_DICE,THIS_TURN) and JOB003/道化's ☆ forced-fallback are the only ways a die can join an
 *   *already-occupied* slot -- doing so EVICTS whatever was there instead of stacking onto it (see
 *   board.js's evictSlotOccupants/placeDice/placeWildcardDie/placeDiceGroup).
 * @property {number} accumulatedFee   - K owed to the tier-B/C owner, collected via the FEE_COLLECT free action
 * @property {string|null} feeOwnerId  - the player who built/upgraded the card that last flipped this
 *   map's tier (set whenever a "MAP{n}.CURRENT_AREA=..." assignment runs, in the context of whoever
 *   triggered it) -- only this player may collect accumulatedFee. Tier-A maps have no owner (no fee).
 * @property {{playerId:string, seq:number}[]} discardedTurnOrderEntries - 2026-08-21, per user request:
 *   when a die gets evicted here (see `slots` above), its own {playerId, seq} is preserved here (only if
 *   it was itself countsForTurnOrder -- see SlotDie's own doc) so it keeps influencing next round's
 *   turn order even though it no longer physically occupies a slot -- see board.js's
 *   evictSlotOccupants and turn-flow.js's computeNextRoundTurnOrder, the only reader (and only for the
 *   castle specifically, since that's the only map turn order is ever computed from). The evicted die's
 *   own Die object is untouched (its placedMapId still points here), so turn-flow.endRound()'s normal
 *   per-die COLOR-return/WHITE-discard logic picks it up exactly as if it were still genuinely placed --
 *   nothing else needs to know this array exists. Reset to [] every round in endRound(), alongside
 *   `slots`.
 */

/**
 * @typedef {Object} SlotDie
 * @property {string} playerId
 * @property {string} dieId
 * @property {number} value
 * @property {number} seq              - state.placementSeq at the moment this die was placed (global
 *   monotonic order, used e.g. to find each player's *last* placement on the castle for next-round
 *   turn-order -- see [[project-dice-wp-flow-spec]])
 * @property {boolean} countsForTurnOrder - false if this placement only succeeded because of
 *   GRANT_PLACE_ANYWHERE overriding an otherwise-illegal (occupied) slot, or JOB003/道化's ☆ forced-
 *   fallback (confirmed: such placements are excluded from the castle's next-turn-order calculation).
 *   True for every other placement. See MapState.discardedTurnOrderEntries' own doc for what happens to
 *   this value once a die carrying it gets evicted by a later placement.
 */

/**
 * @param {string} mapId
 * @param {string} initialAreaId
 * @returns {MapState}
 */
function createMapState(mapId, initialAreaId) {
  return { mapId, currentAreaId: initialAreaId, slots: [], accumulatedFee: 0, feeOwnerId: null, discardedTurnOrderEntries: [] };
}

/**
 * @typedef {Object} ShopDeckState
 * @property {string[]} drawPile - faceIds waiting to be revealed, draw order fixed at shuffle time
 * @property {Object<string, string|null>} slots - keyed by the SHOP-sheet position ID (e.g. "SHOP101"),
 *   value is the faceId currently displayed there or null = empty, awaiting TURNEND restock.
 *   Keying by SHOP-ID (rather than a plain array index) lets the position's own static build
 *   requirements (SHOP sheet's DICE_MIN/DICE_MAX, ROUND_MIN/ROUND_MAX) be looked up directly by
 *   the same key, independent of which card (any color, for the shared "normal card" shop) sits there.
 */

/**
 * @param {string[]} drawPile
 * @param {string[]} slotIds - SHOP-sheet position IDs this deck fills, e.g. ["SHOP101", ..., "SHOP106"]
 * @returns {ShopDeckState}
 */
function createShopDeck(drawPile, slotIds) {
  const slots = {};
  for (const id of slotIds) slots[id] = null;
  return { drawPile: drawPile.slice(), slots };
}

/**
 * @typedef {Object} PendingChoice
 * @property {string} id
 * @property {string} playerId
 * @property {string} kind        - e.g. "WARNING_CONFIRM", "SELECT_BUILD_TARGET", "SELECT_DIE_VALUE"
 * @property {Object} context     - kind-specific payload (candidates, source command, ...)
 */

/**
 * @typedef {Object} LogEntry
 * @property {number} seq
 * @property {string} playerId
 * @property {string} event       - e.g. "PLACE_DICE", "BUILD", "GET", "TURNEND"
 * @property {Object} detail      - event-specific payload, enough to replay this step
 */

/**
 * @typedef {Object} GameState
 * @property {{seed: string, state: number}} rng - the LIVE mulberry32 RNG state (see rng.js), not
 *   just a record of the seed -- every random draw in the game (dice rolls, shuffles) mutates
 *   `rng.state` in place via rng.js's next()/rollDie()/shuffle(state.rng, ...), so this must be part
 *   of the save/undo snapshot for exact replay. `seed` is kept alongside only for reference/debugging.
 * @property {'SETUP'|'ONBOARDING'|'ROUND'|'GAME_END'} phase
 * @property {number} round              - 1..4
 * @property {string[]} turnOrder        - player ids, current round's order
 * @property {number} currentPlayerIndex - index into turnOrder
 * @property {PlayerState[]} players
 * @property {Object<string, MapState>} maps        - keyed by mapId ("MAP001".."MAP010")
 * @property {Object<string, ShopDeckState>} shops   - keys:
 *   "M" - drawPile of the 12 base monuments (M001-012), fills SHOP001-006. M401-403 are excluded --
 *     they only ever surface via "SPECIAL"'s own wave 3 (see below).
 *   "NORMAL" - drawPile is a single shuffled pool of all 18 cards (A001-006 + B001-006 + C001-006
 *     mixed together), fills SHOP101-106; any color can land in any slot
 *   "SPECIAL" - fills SHOP201-203 (2026-08-24 rework, replacing the old fixed-3-card/round-2-gated
 *     design): drawPile is 3 waves concatenated in order -- wave 1 (A201/A202 families, 6 cards),
 *     wave 2 (A301 family, 3 cards, the former A008/B008/C008), wave 3 (M401-403, 3 monuments) -- each
 *     wave independently shuffled before concatenation. Filled immediately at game start (no round
 *     gate on visibility any more), and the ordinary FIFO restock naturally reveals each wave right as
 *     the previous one sells out (see board.restockShop/setup.prepareShops' own docs). *Purchasing*
 *     stays round-gated per-card via board.specialShopMinRound (2R/3R/4R for waves 1/2/3), independent
 *     of when a card becomes visible.
 * @property {Object<string, CardInstanceState>} cards - keyed by physicalId, covers every card in the game (deck/shop/owned)
 * @property {LogEntry[]} log
 * @property {GameState|null} undoCheckpoint - a single deep-cloned snapshot, not a stack (confirmed
 *   2026-07-29: undo is only ever meaningful back to the *most recent* pre-random-roll moment --
 *   once a further roll happens, any earlier checkpoint's window has already closed, so there's
 *   never a need for more than one). Recorded at exactly 2 kinds of moments (confirmed): just before
 *   rolling color dice, and just before rolling white dice. See src/undo.js.
 * @property {PendingChoice[]} pendingChoices
 * @property {Object<string, number>} passiveCounters - cumulative counters for PASSIVE limits that need
 *   to remember usage across separate effects. Currently EMPTY in every game: its only writer was
 *   CONVERT_LIMIT, which stopped accumulating on 2026-08-11 when that limit was corrected to a per-CHANGE
 *   cap (see executor.js's runChange), and UPGRADE_LIMIT -- the other limit that would need a counter --
 *   is parsed but not yet enforced anywhere. Kept as the place for that enforcement to land rather than
 *   removed and re-added later; nothing reads it today, so an empty object is the correct state.
 * @property {Object<string, true>} quests - the 3 QST cards revealed at setup (confirmed 2026-07-30:
 *   fixed for the whole game, no restock), keyed by the specific face ID that was revealed (e.g.
 *   "Q002B") -> true. QST has no in-game tier-flip the way CON/A/B/C do, so there's no need to track
 *   physicalId/currentFaceId separately the way GameState.cards does -- and (2026-08-09, rank-based
 *   rewards replacing the original claim-based design) no other per-card state either: standings are
 *   always computed fresh from current game state (see src/qst.js's rankPlayersForQuest), and rewards
 *   are granted automatically, once, at GAME_END (see src/qst.js's resolveEndGameRewards) rather than
 *   claimed by players during play, so this is purely a "which 3 cards are in play" record.
 * @property {Object<string, number>|null} qstRewardsGranted - playerId -> total VP gained from QST
 *   rewards, set exactly once by turn-flow.js's endRound right when the game reaches GAME_END (see
 *   that function's own comment); null until then. Read back by src/ai/game-runner.js to report a
 *   QST-specific average score in AI.DATA.xlsx separately from the overall (now QST-excluded) one.
 * @property {string[]} whiteOverflowEvents - playerIds, one entry per white-die overflow-to-2K
 *   conversion (executor.js's grantOneDie, whiteDiceCap=5 -- see FREE_ACTION_IDS' own comment for the
 *   underlying always-on rule) since this array was last drained. UI-only signal, not game data proper:
 *   main.js's render() drains it into a one-time warning message (2026-08-11, per user request: "白D
 *   を得たとき上限の5個を超えて得たとき...という警告文が表示されるようにしてほしい") and clears it right
 *   back to empty, the same way it reads and clears every other transient per-render notice. Nothing
 *   else in the engine reads this -- AI play (src/ai/game-runner.js) never looks at it, so leaving
 *   entries undrained between AI turns has no effect on anything but the display.
 */

/**
 * Creates a structurally-complete but empty GameState: no players, no maps,
 * no shop contents. This is the scaffolding SetupManager (not yet built) will
 * populate; it exists so CommandBuilder/Executor and their tests have a
 * concrete shape to work against.
 *
 * @param {string} seed
 * @returns {GameState}
 */
function createEmptyGameState(seed) {
  return {
    rng: { seed, ...createRng(seed) },
    phase: 'SETUP',
    round: 0,
    turnOrder: [],
    currentPlayerIndex: 0,
    placementSeq: 0, // global monotonic counter, bumped on every PLACE_DICE; see SlotDie.seq
    jobPool: [], // JOB face ids currently draftable at round-1 onboarding, see setup.dealJobPool
    players: [],
    maps: {},
    shops: {},
    cards: {},
    log: [],
    undoCheckpoint: null,
    pendingChoices: [],
    passiveCounters: {},
    quests: {},
    qstRewardsGranted: null,
    whiteOverflowEvents: [],
  };
}

/**
 * Deep clone via structuredClone (Node >=17 / modern browsers). Used both for
 * undo checkpoints and for save-data serialization (GameState contains only
 * plain data -- no functions, no class instances -- by design).
 * @param {GameState} state
 * @returns {GameState}
 */
function cloneState(state) {
  return structuredClone(state);
}

module.exports = {
  FREE_ACTION_IDS,
  INITIAL_COLOR_DICE,
  PLAYER_COLORS,
  splitCardId,
  createDie,
  createPlayer,
  createCardInstance,
  createMapState,
  createShopDeck,
  createEmptyGameState,
  cloneState,
};

})();
