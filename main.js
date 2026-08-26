/**
 * UI layer, wired to the real game engine (src/*.js, loaded via index.html's window.__modules
 * registry -- see that file's comments). `STATE` is a real GameState built once via setup.js's setup
 * pipeline (see createInitialState()) and mutated in place by the same setup.js/turn-flow.js/board.js/
 * executor.js/qst.js functions the engine's own tests use -- this file only renders `STATE` to the DOM
 * and translates clicks into those engine calls, no game logic of its own.
 *
 * As of 2026-07-30, everything is wired to the real engine end-to-end: round-1 onboarding, dice
 * placement, BUILD/UPGRADE candidate selection, TAP reactions, free actions, and TURNEND/round-end.
 * QST (2026-08-09) is pure display -- a live standings preview computed via qst.js's real
 * evalGoalMetric/rankPlayersForQuest -- with no player action at all; rewards are granted
 * automatically at GAME_END (qst.resolveEndGameRewards, called from turn-flow.js).
 */

'use strict';

// ---------------------------------------------------------------------------
// Engine bootstrap: pull the already-loaded modules out of window.__modules (see index.html) and
// build the DataIndex once. INDEX is read-only card/board data; STATE is the live, mutable GameState.
// ---------------------------------------------------------------------------

const dataLoaderMod = window.__modules['data-loader'];
const rngMod = window.__modules['rng'];
const gameStateMod = window.__modules['game-state'];
const setupMod = window.__modules['setup'];
const turnFlowMod = window.__modules['turn-flow'];
const boardMod = window.__modules['board'];
const qstMod = window.__modules['qst'];
const scoringMod = window.__modules['scoring'];
const undoMod = window.__modules['undo'];
const executorMod = window.__modules['executor'];
const commandBuilderMod = window.__modules['command-builder'];
const dslParserMod = window.__modules['dsl-parser'];
const evalTableMod = window.__modules['eval-table'];
const simulatorMod = window.__modules['simulator'];
const moveGeneratorMod = window.__modules['move-generator'];
const evaluatorMod = window.__modules['evaluator'];
const aiPlayerMod = window.__modules['ai-player'];

const INDEX = dataLoaderMod.buildDataIndex(dataLoaderMod.loadGameData(window.GAME_DATA));

// sessionStorage key for the debug test-game picker's pending plan (2026-08-13) -- declared up here,
// not down near the rest of that feature's code, since createInitialState()/STATE below already need
// to read it at page-load time (see consumeDebugSetupPlan/openDebugSetupFlow/advanceDebugSetupFlow).
const DEBUG_SETUP_PLAN_KEY = 'diceWpDebugSetupPlan';

/**
 * Builds one fresh GameState via setup.js's real setup pipeline (steps 1-5 + JOB pool reveal + QST
 * reveal -- mirrors tests/setup.smoke.js's runFullSetup up through dealResourceCandidates). Steps 6-8
 * (each player choosing 2 RESOURCE cards, then computeStartOrder + turnFlow.startRound) happen later,
 * player-by-player, via renderResourceChoice's click handler + maybeStartRound1 below -- see that
 * function's comment for why step 6 can't happen here (it needs a player decision).
 */
/** Random per page load (corrected 2026-08-03 -- was a hardcoded dev seed, 'dice-wp-dev-seed', so dice
 * rolls and shop layouts were identical every game; per user feedback, "現在ダイス目やSHOPのカードが
 * 固定になっているのでそれをランダムにして"). Math.random() only ever seeds the deterministic RNG here
 * (once, at game creation) -- everything downstream (dice rolls, shop shuffles, AI decisions) still
 * flows through state.rng exactly as before, so replays/undo/AI determinism are unaffected. */
function randomSeed() {
  return `game-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Reads and clears a pending debug test-game plan from sessionStorage (see openDebugSetupFlow/
 * advanceDebugSetupFlow further below) -- set right before location.reload() once the "テストゲーム
 *開始" picker flow's last step finishes, so createInitialState() below can pick it up on the resulting
 * fresh page load. Consumed exactly once (removed immediately) so a later plain refresh/reopen doesn't
 * replay the same selections into every subsequent game. null if no debug plan is pending (the normal,
 * fully-random case). */
function consumeDebugSetupPlan() {
  const raw = sessionStorage.getItem(DEBUG_SETUP_PLAN_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(DEBUG_SETUP_PLAN_KEY);
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** plan (2026-08-13, debug test-game feature -- see consumeDebugSetupPlan) applies P1-only overrides on
 * top of the normal random setup pipeline: P1's physical CON card (still picks their own face normally
 * at onboarding, see setup.dealConCards' own doc), P1's exact 2 initial RESOURCE cards (granted
 * directly, no candidate/choose-2 step for P1 -- see setup.grantResourceCards), which faces are
 * guaranteed in the JOB draft pool, and which faces seed SHOP101/102/... in the NORMAL shop. P2-P4 are
 * completely unaffected either way. plan.qst (2026-08-18, not P1-scoped at all -- QST reveals are
 * whole-game, shared by every player) forces which QST faces get revealed, in pick order -- see
 * qst.setupQuests' own doc. */
function createInitialState(plan) {
  const state = gameStateMod.createEmptyGameState(randomSeed());
  setupMod.createPlayers(state, ['Alice', 'Bob', 'Carol', 'Dan']);
  setupMod.prepareMaps(state, INDEX);
  setupMod.prepareShops(state, INDEX, plan ? plan.abc : undefined);
  setupMod.rollInitialColorDice(state);
  const forcedCon = plan && plan.con.length > 0 ? { P1: gameStateMod.splitCardId(plan.con[0]).physicalId } : undefined;
  setupMod.dealConCards(state, forcedCon);
  // Resource step (2026-08-15, per user feedback: choosing 0 preferred resources used to still bypass
  // P1's normal choice and hand them 2 fully random cards -- P1 should instead see the exact same
  // 5-candidates/pick-2 flow as P2-4 whenever nothing was preselected. Choosing exactly 1 locks that
  // card in and lets P1 pick the 2nd from 4 more candidates (setup.grantOneResourceCardAndDealRest),
  // rather than the 2nd being auto-filled randomly with no choice at all. Choosing 2 keeps the original
  // full-bypass behavior unchanged.
  const resourceCount = plan ? plan.resource.length : 0;
  if (resourceCount === 2) {
    setupMod.dealResourceCandidates(state, INDEX, ['P1']);
    setupMod.grantResourceCards(state, INDEX, 'P1', plan.resource);
  } else if (resourceCount === 1) {
    setupMod.dealResourceCandidates(state, INDEX, ['P1']);
    setupMod.grantOneResourceCardAndDealRest(state, INDEX, 'P1', plan.resource[0]);
  } else {
    setupMod.dealResourceCandidates(state, INDEX);
  }
  setupMod.dealJobPool(state, INDEX, plan ? plan.job : undefined);
  qstMod.setupQuests(state, plan ? plan.qst : undefined);
  return state;
}

const STATE = createInitialState(consumeDebugSetupPlan());

// ---------------------------------------------------------------------------
// AI players (2026-08-03, per user feedback: "プレイヤー1は人間 プレイヤー2 3 4はAIの対戦を実装して
// 欲しい", generalized same day: "4人のプレイヤー人間 AIをそれぞれ選べるようにしてほしい", then split
// into 2 strengths once AIPlayer grew a lookahead option: "先程のAIをLV1 新しく作ったAIをLV2として
// ...選べるようにしてください"). Each player seat holds one of 3 roles in playerRoles -- 'HUMAN',
// 'AI_LV1' (the original pure-1-ply-greedy AIPlayer, lookaheadExtraTurns:0 -- fast, no multi-turn
// planning), or 'AI_LV2' (lookaheadExtraTurns:1, see ai-player.js's own doc for what that buys and
// costs: a real game now takes on the order of a minute instead of ~10s). Both AI levels share the same
// stateless MoveGenerator/Evaluator/Simulator instances (only the AIPlayer wrapper differs), same as
// game-runner.js's own pattern for AI-vs-AI batch games. Defaults to P1-human, everyone else the
// strongest AI level currently defined (DEFAULT_AI_ROLE below -- was a flat AI_LV2 default until
// 2026-08-11, per user request: "デフォルトのAILVを3にして　今後デフォルトは一番高いAILVを選択して
// ください"); renderPlayerRoleControl lets the human change any seat's role at any time, including
// mid-game -- this is purely a UI-driving concern (which player's turn gets a click-through vs an
// automatic driveOneAiStep), not part of GameState itself, so there's nothing structurally stopping a
// mid-game switch.
// ---------------------------------------------------------------------------

// Ascending strength order (HUMAN first, then every AI level weakest-to-strongest) -- shared by
// renderPlayerRoleControl's toggle buttons and DEFAULT_AI_ROLE below, so the two can never drift apart
// the way two separately-hardcoded copies eventually would. Adding a future AI_LV4/5/... only ever means
// appending one more [id, label] entry here, in order -- everything that cares "which level is strongest"
// (right now, just the default below) then already sees it with no further edits.
const PLAYER_ROLE_OPTIONS = [['HUMAN', '人間'], ['AI_LV1', 'AI LV1'], ['AI_LV2', 'AI LV2'], ['AI_LV3', 'AI LV3']];
// The strongest AI level currently defined -- the last entry in PLAYER_ROLE_OPTIONS (2026-08-11, per user
// request: "デフォルトのAILVを3にして　今後デフォルトは一番高いAILVを選択してください"). Was a hardcoded
// 'AI_LV2' before LV3 existed; now derived so it keeps pointing at whichever level is actually strongest
// without needing to be hand-updated again the next time one is added.
const DEFAULT_AI_ROLE = PLAYER_ROLE_OPTIONS[PLAYER_ROLE_OPTIONS.length - 1][0];
const playerRoles = new Map([['P1', 'HUMAN'], ['P2', DEFAULT_AI_ROLE], ['P3', DEFAULT_AI_ROLE], ['P4', DEFAULT_AI_ROLE]]);
function isAiPlayer(playerId) { return playerRoles.get(playerId) !== 'HUMAN'; }

const aiEvalTable = evalTableMod.buildEvalTable(INDEX.raw);
const aiEvaluator = new evaluatorMod.Evaluator(INDEX, aiEvalTable);
const aiMoveGenerator = new moveGeneratorMod.MoveGenerator();
const aiSimulator = new simulatorMod.Simulator();
const aiPlayerLv1 = new aiPlayerMod.AIPlayer(INDEX, aiMoveGenerator, aiEvaluator, aiSimulator, { lookaheadExtraTurns: 0 });
const aiPlayerLv2 = new aiPlayerMod.AIPlayer(INDEX, aiMoveGenerator, aiEvaluator, aiSimulator, { lookaheadExtraTurns: 1 });
// AI LV3 (2026-08-09). Gets its OWN MoveGenerator instance built with an avoidMapIdFromRound policy
// (see that class's own doc) -- LV1/LV2's shared aiMoveGenerator above stays policy-free and therefore
// completely unaffected. Reuses LV2's lookaheadExtraTurns:1 (not asked about specifically; matched to
// LV2 rather than LV1's 0, since LV3 is meant to be the stronger/smarter option, not a speed tier).
// avoidMapIdFromRound (2026-08-10, per user request: "R3からAREA007にダイスを置かないようにかえたい") --
// AREA007 (訓練場, always MAP007's CURRENT_AREA -- it has no B/C tier) stops being a legal placement for
// LV3 from round 3 onward. See MoveGenerator's own doc for why this is a soft removal, not a hard block.
// (2026-08-10: this used to also carry a monumentFocusFromRound policy -- removed per user request once
// QST's rank-based rewards rework made the round 3/4 new-A/B/C-build restriction it existed for
// unnecessary. See MoveGenerator's own doc.)
const aiMoveGeneratorLv3 = new moveGeneratorMod.MoveGenerator({
  avoidMapIdFromRound: { mapId: 'MAP007', round: 3 },
});
// Own Evaluator instance too (2026-08-10, per user request: "AI LV3はQSTカードに対応してVPを稼ぐように
// したい") -- qstAware:true (see Evaluator's own doc), sharing aiEvalTable with the LV1/LV2-shared
// aiEvaluator above, which stays policy-free and therefore completely unaffected.
const aiEvaluatorLv3 = new evaluatorMod.Evaluator(INDEX, aiEvalTable, { qstAware: true });
// Round-4-only deep lookahead + wider beam (2026-08-10, per user request: "4Rのみ最後まで深堀させます" +
// "R4だけビーム幅も広げるでいきます") -- see AIPlayer's own roundOverrides doc for the full mechanics.
// Round 4 is the last round, so the own-turns-only rollout naturally stops once this player's own dice
// for the round run out (no artificial early cutoff from a small lookaheadExtraTurns/maxRolloutMoves),
// and the extra beamWidth cost is bounded since there's no round 5 left to also pay it in.
const aiPlayerLv3 = new aiPlayerMod.AIPlayer(INDEX, aiMoveGeneratorLv3, aiEvaluatorLv3, aiSimulator, {
  lookaheadExtraTurns: 1,
  roundOverrides: { 4: { lookaheadExtraTurns: 20, beamWidth: 10, maxRolloutMoves: 200 } },
});
/** Which AIPlayer instance drives playerId's own TURN moves -- see playerRoles' own comment. */
function aiPlayerFor(playerId) {
  const role = playerRoles.get(playerId);
  if (role === 'AI_LV1') return aiPlayerLv1;
  if (role === 'AI_LV3') return aiPlayerLv3;
  return aiPlayerLv2;
}

// 'instant' (AI plays out immediately, no visible pause) | 'delayed' (one Move every AI_STEP_DELAY_MS,
// so the board visibly updates step by step) | 'manual' (only advances on the "次のAI行動へ" button
// click) -- all 3 selectable per user feedback ("上記3をえらべるように"), see renderAiPacingControl.
// Defaults to 'delayed' (2026-08-04, per user feedback: "AI進行のデフォルトを1手ずつにして").
let aiPacingMode = 'delayed';
const AI_STEP_DELAY_MS = 600;
// setTimeout handle for 'delayed' mode -- tracked so switching pacing modes mid-flight (or a render
// triggered by something else while a step is already scheduled) never stacks up duplicate timers.
let aiPumpTimer = null;

// Tracks "has THIS AI player already placed their die for the turn that's still open" independently of
// the human-facing turnActionTaken flag (found 2026-08-03): pumpAiInstant can cycle through several
// different AI players' turns within a single render() call, all before render()'s own
// lastTurnPlayerId-transition reset ever runs (that only fires once, after the whole pump completes) --
// reusing turnActionTaken directly let a 2nd/3rd AI player in the same pump inherit "true" from
// whichever AI played right before them, so MoveGenerator never offered PLACE_DIE for them and they got
// stuck repeating (mirrors the exact openTurnPlayerId/openTurnHasPlacedDie fix already applied to
// src/ai/game-runner.js's playGame for the identical reason). Reset naturally: aiOpenTurnHasPlacedDie is
// only ever read when next.playerId still matches aiOpenTurnPlayerId, so a different player (human or
// AI) simply misses and starts fresh.
let aiOpenTurnPlayerId = null;
let aiOpenTurnHasPlacedDie = false;
// Set to playerId exactly when that AI's own END_TURN move succeeds (alongside aiOpenTurnPlayerId being
// reset to null there), consumed by driveOneAiStepInner's very next call regardless of which player it's
// for (2026-08-17 fix, replacing the `ctx.playerId !== aiOpenTurnPlayerId` forceNewTurn signal that
// caused main.js's own "JOBが選べなくなりました" regression -- see noteActiveTurnPlayerForJobPool's own
// doc for the full incident). aiOpenTurnPlayerId being null is ambiguous: it means EITHER "this player's
// turn was never opened yet" (their first-ever move this turn -- NOT a repeat) OR "this player's own
// turn just properly closed and they're straight back up" (a genuine repeat, once everyone else is out
// of dice -- the actual SHOP101 case forceNewTurn exists for). `ctx.playerId !== aiOpenTurnPlayerId` is
// true in BOTH cases, so it couldn't tell them apart -- and the first case is common (render() itself
// already calls noteActiveTurnPlayerForJobPool the moment it notices a fresh next.playerId, well before
// this AI's own first move ever runs), so treating it as "force" there double-counted a turn that had
// already been counted once. This flag is only ever true in the second case.
let lastEndedAiTurnPlayerId = null;

// ---------------------------------------------------------------------------
// 変化ハイライト (2026-08-16, replacing a considered-but-rejected move animation -- see this app's
// full-DOM-rebuild-every-render architecture, which has no element to animate a smooth move across).
// Shows what changed on the board (dice newly placed, cards newly acquired -- any player's, not just
// the viewer's) since a human player's own turn last ended, so a human doesn't have to watch every
// individual AI move to know what happened -- especially under 'instant' pacing, which resolves an
// entire AI backlog before ever painting anything.
// ---------------------------------------------------------------------------
// A structuredClone(state) taken the moment a human's own turn ends (advanceTurnIfPossible), i.e.
// "the board as the human left it" -- the diff baseline. Consumed (set back to null) the next time
// render()'s transition block detects control passing to a human, at which point changeHighlightDiff
// is computed from it. Stays null the rest of the time (nothing to diff against).
let changeHighlightBaseline = null;
// {slotKeys:Set<"mapId|slotIndex">, cardKeys:Set<"playerId|physicalId">} once computed, or null.
let changeHighlightDiff = null;
// True once changeHighlightDiff has been painted by one render() call -- render()'s own top clears
// changeHighlightDiff the NEXT time it's called while this is true, since nothing in this app ever
// calls render() on its own (no polling/interval) -- the next call is always caused by the human doing
// something, which is exactly when the highlight should disappear (see render()'s own comment).
let changeHighlightPainted = false;
// { playerId, dieId } | null -- 'delayed' pacing's own extra highlight (per user request, "1手ずつの
// ときは、それに加えて、おかれる直前のダイスが光る"): which of an AI's own in-hand dice it's about to
// place, shown during the same existing AI_STEP_DELAY_MS wait pumpAiDelayed already has (no added
// delay) -- see pumpAiDelayed's own doc.
let aiPreHighlightMove = null;

/** Pure diff between a structuredClone(state) baseline and the current state (2026-08-16) -- see the
 * change-highlight state block above. Only looks at the two things that matter for this feature: newly
 * occupied AREA slots (a die placed there since baseline) and newly owned cards (any physicalId in
 * ownedCardPhysicalIds now that wasn't there in baseline) -- both are simple presence diffs, nothing
 * about VALUES that might have changed (a resource count, a card's tapped state, etc.) is tracked, since
 * only "a die landed here" / "a card was acquired" were asked for.
 * @returns {{slotKeys: Set<string>, cardKeys: Set<string>}}
 */
function computeChangeDiff(baseline, state) {
  const slotKeys = new Set();
  for (const mapId of Object.keys(state.maps)) {
    const baselineSlots = baseline.maps[mapId] ? baseline.maps[mapId].slots : [];
    state.maps[mapId].slots.forEach((occupants, i) => {
      const baselineDieIds = new Set((baselineSlots[i] || []).map((o) => o.dieId));
      if (occupants.some((o) => !baselineDieIds.has(o.dieId))) slotKeys.add(`${mapId}|${i}`);
    });
  }
  const cardKeys = new Set();
  for (const player of state.players) {
    const baselinePlayer = baseline.players.find((p) => p.id === player.id);
    const baselineIds = new Set(baselinePlayer ? baselinePlayer.ownedCardPhysicalIds : []);
    for (const physicalId of player.ownedCardPhysicalIds) {
      if (!baselineIds.has(physicalId)) cardKeys.add(`${player.id}|${physicalId}`);
    }
  }
  return { slotKeys, cardKeys };
}

/** Whoever's own turn is genuinely still open right now -- they've already resolved this turn's die
 * (placed or passed it) but haven't ended the turn yet -- or null if nobody is mid-turn.
 *
 * GameState itself has no such field: turn-flow.getNextTurn only ever answers "who has an unplaced die",
 * which is a DIFFERENT question. Once a player resolves their last die of the round, getNextTurn skips
 * straight past them to whoever still holds one -- correct for finding a *just-ended* turn's successor,
 * but indistinguishable from "this player is still mid-turn and hasn't clicked ターン終了". That's what
 * turnActionTaken/lastTurnPlayerId track (see turnActionTaken's own comment), and pendingBuildChoice is
 * the same thing one step earlier (the die is placed, but a BUILD/UPGRADE candidate choice is still open,
 * and applyPlaceDiceResult deliberately leaves turnActionTaken false until it's committed).
 *
 * Single source of truth for all three callers (2026-08-10, per user report: "1R最後のダイスを置いたとき
 * ターン終了を押していないのに強制的にターン終了し次のラウンドダイスが選択できませんでした") -- render()
 * for what the board displays, and hasAiWorkPending/driveOneAiStep for whether the AI pump may act at
 * all. Before this, only render() applied the correction, from its own inline copy; both pump functions
 * asked raw getNextTurn directly, so they read that skip-ahead as "it's the AI's turn now" and drove a
 * whole AI turn out from under the still-open human one -- whose eventual END_TURN then advanced
 * currentPlayerIndex past the human entirely (they never got to end their own turn), leaving
 * turnActionTaken stuck true forever, which is what made every later round's dice unselectable (see
 * renderPlayers' own `!turnActionTaken` gate). */
function openTurnPlayerId() {
  if (pendingBuildChoice) return pendingBuildChoice.playerId;
  return turnActionTaken ? lastTurnPlayerId : null;
}

/** True if some AI-controlled player has an immediately-actionable decision pending right now (a
 * SELECT_RESOURCE_CARDS choice, or turn-flow.getNextTurn reporting ONBOARDING_NEEDED/TURN for them) --
 * a read-only peek, mirrors driveOneAiStep's own gating exactly but never mutates state. Used to decide
 * whether to keep pumping (any mode) and whether to show the manual-mode button at all. */
function hasAiWorkPending(state) {
  // A BUILD/UPGRADE candidate choice is always mid-resolution for the human (AI moves never go through
  // this UI-only flow -- see pendingBuildChoice's own comment) -- found 2026-08-06, per user report:
  // "最後の1個のダイスで建築するとき　どれを選ぶか考えてる間にAIプレイヤーが次のターンを始めました".
  // Root cause: placing the die that triggers the modal already marks it placedMapId-wise, so
  // turn-flow.getNextTurn (which pendingBuildChoice isn't part of) reports the *next* player's turn
  // immediately -- if that's an AI, every pacing mode (instant/delayed/manual) would happily drive
  // their whole turn while the human's modal was still open, silently racing ahead of the still-unmade
  // choice. See driveOneAiStep's matching guard (the one that actually blocks the pump; this one just
  // keeps hasAiWorkPending's own answer -- and therefore the manual-mode button's visibility -- honest).
  if (pendingBuildChoice) return false;
  if (state.pendingChoices.some((c) => c.kind === 'SELECT_RESOURCE_CARDS' && isAiPlayer(c.playerId))) return true;
  if (state.pendingChoices.some((c) => c.kind === 'UNTAP_CHOICE' && isAiPlayer(c.playerId))) return true;
  if (state.round === 0) return false; // still waiting on the human's own resource choice
  if (state.phase === 'GAME_END') return false;
  // A human who's resolved this turn's die but hasn't clicked ターン終了 still owns the turn -- see
  // openTurnPlayerId's own doc (and driveOneAiStep's matching guard, the one that actually blocks the
  // pump; this one keeps hasAiWorkPending's answer, and therefore the manual-mode button's visibility,
  // honest). Checked BEFORE getNextTurn below precisely because getNextTurn is what skips past them.
  const openTurn = openTurnPlayerId();
  if (openTurn && !isAiPlayer(openTurn)) return false;
  // An AI that's already acted but hasn't ended its turn still owes an END_TURN, and getNextTurn has
  // no way to say so -- it skips straight past a player with no dice left. See driveOneAiStep's matching
  // guard (2026-08-11) for why that matters: without this, the pump reports "nothing to do" and the AI's
  // TURNEND (which is what restocks the shops) silently never happens.
  if (aiOpenTurnPlayerId !== null) return true;
  const next = turnFlowMod.getNextTurn(state);
  // getNextTurn's raw ROUND_OVER can fire purely because every die is placed-or-passed, even while
  // whoever placed/passed the very last one hasn't actually ended their turn yet -- see
  // driveOneAiStep's matching override (2026-08-09 fix, per user report: "ラウンド最後のダイスを置くと
  // その瞬間強制的にラウンド終了してしまいます") for the full story, including why this can't be
  // answered from state.turnOrder[state.currentPlayerIndex] (that's just a rotating next-slot cursor,
  // not "who's mid-turn" -- it lags whenever per-player die counts diverge this round). aiOpenTurnPlayerId
  // is the reliable answer instead: driveOneAiStep itself sets it the moment it starts driving an AI's
  // real turn, and clears it only once that same AI's own END_TURN move actually succeeds -- so
  // non-null here means an AI genuinely still has an open turn; null means either the human is the one
  // mid-turn (nothing for the AI pump to do until they click ターン終了) or nobody is (also nothing to
  // do, and reporting true here would just make pumpAiDelayed re-arm forever for no reason).
  if (next.type === 'ROUND_OVER') return aiOpenTurnPlayerId !== null;
  return (next.type === 'ONBOARDING_NEEDED' || next.type === 'TURN') && isAiPlayer(next.playerId);
}

/** Performs exactly one atomic AI decision -- a RESOURCE-card pick, a JOB draft, a CON face choice
 * (+ its immediate receiveInitialResources), or one real-TURN Move (selectMove + applyInPlace, same as
 * src/ai/game-runner.js's driveTurn but one step at a time so aiPacingMode's delayed/manual modes can
 * pace it visibly) -- for whichever AI-controlled player currently has something to do. Every decision
 * is picked by simulating each legal option and keeping the highest Evaluator.score, ties broken by
 * option order (confirmed 2026-08-01, no randomness anywhere in AI decision-making) -- identical
 * decision logic to game-runner.js's setupGame/driveOnboarding/driveTurn, just inlined here so it can
 * be driven one step at a time from the UI's own render loop instead of run to completion in one call.
 * @returns {boolean} true if it did something (caller should render, and keep pumping if instant/
 *   delayed); false if there's nothing for an AI player to do right now (including "it's the human's
 *   turn", which is not an error -- just nothing to pump).
 */
/** Thin wrapper around #driveOneAiStepInner (2026-08-1X) -- records one replay entry per individual AI
 * decision, the single choke point every AI move funnels through regardless of aiPacingMode. Needed
 * because pumpAiInstant's while loop calls this directly, in a tight synchronous loop with no render()
 * in between (see pumpAiInstant's own doc) -- without a hook right here, 'instant' pacing would resolve
 * an entire AI backlog before render()'s own recordReplaySnapshotIfChanged ever got a chance to run,
 * collapsing many real moves into a single replay entry instead of one each. See this file's "Move-by-
 * move game replay" section for the full picture. */
function driveOneAiStep(state) {
  const did = driveOneAiStepInner(state);
  if (did) recordReplaySnapshotIfChanged(state);
  return did;
}

/** Read-only "what would driveOneAiStepInner do right now" (2026-08-16) -- extracted verbatim from what
 * used to be driveOneAiStepInner's own inline guard logic (same order, same conditions, no behavior
 * change) so pumpAiDelayed can peek at an about-to-happen AI move -- for the 'delayed'-pacing
 * pre-placement die highlight -- without duplicating or mutating anything. Never mutates state; the
 * mutating branches all still live in driveOneAiStepInner below, which just switches on this result
 * instead of inlining these checks itself.
 * @returns {null | {type:'RESOURCE_CHOICE', resourceChoice} | {type:'UNTAP_CHOICE', untapChoice} |
 *   {type:'ONBOARDING', playerId, player} | {type:'TURN', playerId, hasPlacedDieThisTurn}}
 */
function resolveAiTurnContext(state) {
  // The real block -- see hasAiWorkPending's matching guard for the full story. pumpAiInstant's while
  // loop calls driveOneAiStepInner directly (not hasAiWorkPending) each iteration, so the guard has to
  // live here too, not just in hasAiWorkPending, or 'instant' mode would still blow straight through the
  // human's still-open BUILD/UPGRADE choice modal.
  if (pendingBuildChoice) return null;
  const resourceChoice = state.pendingChoices.find((c) => c.kind === 'SELECT_RESOURCE_CARDS' && isAiPlayer(c.playerId));
  if (resourceChoice) return { type: 'RESOURCE_CHOICE', resourceChoice };

  // UNTAP_CHOICE (2026-08-15, see executor.runUntapChoice's own doc): same "random, not simulate-and-
  // score" placeholder policy as the RESOURCE choice just above -- which of the player's own tapped
  // cards is most worth keeping tapped has no eval-table weight to judge it by yet.
  const untapChoice = state.pendingChoices.find((c) => c.kind === 'UNTAP_CHOICE' && isAiPlayer(c.playerId));
  if (untapChoice) return { type: 'UNTAP_CHOICE', untapChoice };

  if (state.round === 0) return null;
  // Found 2026-08-03 (all-AI game): without this, a finished game's every round-4 die stays "placed",
  // so isRoundOver(state) (and therefore getNextTurn) keeps reporting ROUND_OVER forever after
  // GAME_END, and the ROUND_OVER branch below has no way to tell "just ended" from "already over" --
  // it kept calling endRound/startRound every single call, eventually only stopped by
  // pumpAiInstant's MAX_STEPS safety valve, which is real (non-trivial) work repeated 20000 times.
  // Previously unreachable because there was always at least one human player to naturally stop the
  // pump before/at GAME_END.
  if (state.phase === 'GAME_END') return null;
  // The real block for a still-open HUMAN turn (2026-08-10) -- see openTurnPlayerId's own doc for the
  // full story. Must be checked before getNextTurn below: that call is exactly what skips past a human
  // who has no unplaced die left, handing their still-open turn to the next AI.
  const openTurn = openTurnPlayerId();
  if (openTurn && !isAiPlayer(openTurn)) return null;
  let next = turnFlowMod.getNextTurn(state);
  // getNextTurn's raw ROUND_OVER only means "every die is placed-or-passed" -- it does NOT mean every
  // player has actually clicked/decided ターン終了 yet (2026-08-09 fix, per user report: "ラウンド最後
  // のダイスを置くと　その瞬間強制的にラウンド終了してしまいます" + "AIがダイスを使い切ると人間がターン
  // エンドできなくなります"). This function used to treat raw ROUND_OVER as "call endRound right now",
  // which fired the instant the very last die anywhere on the board got placed -- even if that placer
  // (human OR AI) hadn't ended their own turn yet, skipping their final TAP/free-action window and their
  // own TURNEND processing entirely, and stranding the human's ターン終了 button (whose state assumed
  // their turn was still open) once the round silently rolled out from under them.
  // endRound must ONLY ever run immediately after a REAL END_TURN move -- see advanceTurnIfPossible
  // (human, "ターン終了" button) and simulator.applyInPlace's own END_TURN case (AI's own selectMove
  // choosing to end its turn), both of which already call it correctly, right there, the instant
  // isRoundOver flips true from an actual end-of-turn. So: if aiOpenTurnPlayerId is set, an AI genuinely
  // still has an open turn -- let it keep acting below (its own eventual END_TURN move is what
  // legitimately advances the round). If it's null, either the human is the one mid-turn or genuinely
  // nobody is -- either way there's nothing for THIS function to do; wait for the human's own click.
  // (aiOpenTurnPlayerId, not state.turnOrder[state.currentPlayerIndex] -- see hasAiWorkPending's matching
  // comment for why that index can't answer "who's mid-turn" reliably here.)
  //
  // Generalised 2026-08-11 (per user report: "AIが最後のダイスを使って建築したあとにんげんのターンになって
  // もSHOPが空いたまま"). ROUND_OVER was only the case where getNextTurn's skip-ahead ran out of players
  // entirely; the same blind spot bites whenever it skips a still-open AI to report SOMEONE ELSE's turn --
  // which is what happens the moment an AI resolves its last die of the round. The pump would then drive
  // that other player and abandon the first AI's turn without ever running its END_TURN, so its TURNEND
  // never fired -- and TURNEND is what restocks the shops (turn-flow.endTurn -> restockShop). If the
  // abandoned AI was the last one before the human, nothing else came along to restock either, leaving the
  // human staring at the gap the AI's own build had just made. So: whenever an AI still owes an END_TURN,
  // it keeps the turn regardless of who getNextTurn would rather hand it to.
  if (aiOpenTurnPlayerId !== null && next.playerId !== aiOpenTurnPlayerId) {
    next = { type: 'TURN', playerId: aiOpenTurnPlayerId };
  } else if (next.type === 'ROUND_OVER') {
    return null; // nobody mid-turn and no dice left -- wait for the human's own ターン終了
  }
  if (!isAiPlayer(next.playerId)) return null;
  const player = state.players.find((p) => p.id === next.playerId);

  // turn-flow.getNextTurn reports 'TURN' as soon as JOB is drafted, even before CON is chosen (same
  // quirk main.js's own hasFinishedOnboarding works around everywhere else -- see its doc) -- so
  // onboarding isn't gated on next.type==='ONBOARDING_NEEDED' alone, it's "not finished yet" by
  // whichever type getNextTurn happens to report. Found 2026-08-03: without this, an AI player who'd
  // drafted JOB but not yet chosen CON fell into the TURN branch below and got stuck (selectMove trying
  // to place a die for a player who hasn't received their initial resources yet).
  if (next.type === 'ONBOARDING_NEEDED' || !hasFinishedOnboarding(player)) {
    return { type: 'ONBOARDING', playerId: next.playerId, player };
  }

  // next.type === 'TURN' && hasFinishedOnboarding(player), i.e. a genuine real turn. See
  // aiOpenTurnPlayerId's own comment for why this can't just reuse turnActionTaken directly.
  const hasPlacedDieThisTurn = next.playerId === aiOpenTurnPlayerId ? aiOpenTurnHasPlacedDie : false;
  return { type: 'TURN', playerId: next.playerId, hasPlacedDieThisTurn };
}

function driveOneAiStepInner(state) {
  const ctx = resolveAiTurnContext(state);
  if (!ctx) return false;

  if (ctx.type === 'RESOURCE_CHOICE') {
    // Random, not simulate-and-score (2026-08-03, per user feedback: "初期資源、CON、JOBは現状は完全
    // ランダムでお願いします そのうち評価値を入れます" -- see src/ai/game-runner.js's matching fix and
    // its own doc for why: RESOURCE/CON/JOB have no real eval-table values yet).
    const pair = rngMod.shuffle(state.rng, ctx.resourceChoice.context.candidates).slice(0, 2);
    setupMod.chooseResourceCards(state, ctx.resourceChoice.playerId, pair);
    maybeStartRound1(state);
    return true;
  }

  if (ctx.type === 'UNTAP_CHOICE') {
    // Random, not simulate-and-score (same policy as the other bespoke choices in this function). Since
    // 2026-08-17 this is a weighted budget (see executor.untapChoiceWeight's own doc), not a flat count,
    // so candidates are shuffled and greedily added while they still fit the remaining budget, rather
    // than just slicing the first `count` of them.
    const { candidates, weights, count } = ctx.untapChoice.context;
    const picked = [];
    let usedWeight = 0;
    for (const id of rngMod.shuffle(state.rng, candidates)) {
      if (usedWeight + weights[id] <= count) {
        picked.push(id);
        usedWeight += weights[id];
      }
    }
    executorMod.resolveUntapChoice(state, ctx.untapChoice.playerId, picked);
    return true;
  }

  if (ctx.type === 'ONBOARDING') {
    if (!ctx.player.jobCardId) {
      // Random, not simulate-and-score (2026-08-03, per user feedback -- see the resource-choice
      // branch above, and src/ai/game-runner.js's matching fix and its own doc for why).
      const jobFaceId = state.jobPool[Math.floor(rngMod.next(state.rng) * state.jobPool.length)];
      setupMod.chooseJob(state, INDEX, ctx.playerId, jobFaceId);
      // No auto/manual-mode prompt for AI (unlike the human path, e.g. renderJobPool's click handler)
      // -- pendingAutoModeChoice is a human-UI convenience only; MoveGenerator's own move generation
      // already accounts for whichever mode (auto/manual) is actually active, see its own doc.
      // JOB010/革命家's PICK_JOB_REPLACEMENT (2026-08-21, see setup.grantRevolutionaryBonusIfEarned's
      // own doc): same random-pick policy as src/ai/game-runner.js's matching driveOnboarding hook --
      // must resolve synchronously here or it sits in state.pendingChoices forever (renderJobPool's own
      // "still drafting" check only ever looks at jobCardId, which is already non-null by this point).
      const jobReplacementChoice = state.pendingChoices.find((c) => c.playerId === ctx.playerId && c.kind === 'PICK_JOB_REPLACEMENT');
      if (jobReplacementChoice) {
        const picked = jobReplacementChoice.context.candidates[Math.floor(rngMod.next(state.rng) * jobReplacementChoice.context.candidates.length)];
        setupMod.resolveJobReplacementChoice(state, INDEX, ctx.playerId, picked);
      }
    } else {
      const face = rngMod.next(state.rng) < 0.5 ? 'A' : 'B';
      setupMod.chooseConFace(state, INDEX, ctx.playerId, face);
      setupMod.receiveInitialResources(state, INDEX, ctx.playerId);
    }
    return true;
  }

  // ctx.type === 'TURN'. noteActiveTurnPlayerForJobPool here (not just render()'s copy) so a turn-start
  // is caught even when pumpAiInstant blows straight through this AI's whole turn without render() ever
  // pausing on it -- see lastNotedActiveTurnPlayerId's own comment. forceNewTurn: true only when THIS
  // player's own turn just properly closed via END_TURN and they're straight back up (the genuine
  // same-player-repeat case, once everyone else is out of dice) -- see lastEndedAiTurnPlayerId's own doc
  // for why this can't just be `ctx.playerId !== aiOpenTurnPlayerId` (that's also true for this player's
  // ordinary first move of an already-render()-noted fresh turn, which isn't a repeat at all).
  const forceNewTurn = ctx.playerId === lastEndedAiTurnPlayerId;
  lastEndedAiTurnPlayerId = null;
  noteActiveTurnPlayerForJobPool(state, ctx.playerId, forceNewTurn);
  const move = aiPlayerFor(ctx.playerId).selectMove(state, ctx.playerId, { hasPlacedDieThisTurn: ctx.hasPlacedDieThisTurn });
  if (!move) return false; // defensive -- canEndTurn should always eventually free this up
  const result = simulatorMod.applyInPlace(state, INDEX, move);
  if (move.type === 'END_TURN' && result.success) {
    aiOpenTurnPlayerId = null;
    lastEndedAiTurnPlayerId = ctx.playerId;
  } else {
    aiOpenTurnPlayerId = ctx.playerId;
    // JOB003/道化 (2026-08-20 fix, per user bug report: "AIが道化を選んだ時...すべてのダイス4個をいきな
    // り使ってスタートしました") -- PLACE_WILDCARD_DIE is JOB003's own die-placement move type (see
    // move-generator.js's #wildcardPlaceDieMoves) and counts as "placed a die this turn" exactly like
    // PLACE_DIE does; omitting it here left this flag permanently false for a ☆-owning AI, so every
    // later call back into this function kept seeing hasPlacedDieThisTurn:false and let it place another
    // die immediately, round after round, no END_TURN in between (same root cause fixed in
    // src/ai/game-runner.js's driveTurn/ai-player.js's #rolloutScore -- this is main.js's own separate
    // copy of the same tracking, used when a human is actually watching the AI play live).
    aiOpenTurnHasPlacedDie = ctx.hasPlacedDieThisTurn || ((move.type === 'PLACE_DIE' || move.type === 'PLACE_WILDCARD_DIE' || move.type === 'PLACE_DICE_GROUP' || move.type === 'PASS_DIE') && result.success);
  }
  return true;
}

/** 'instant' mode: runs driveOneAiStep to completion (every AI player's entire backlog, up through
 * whatever comes right before the human's next actionable moment) before render() paints anything --
 * called from render()'s own top, so no other call site needs to change. MAX_STEPS is a safety valve
 * against a genuine bug turning this into an infinite loop, not a real gameplay limit (a real game
 * never remotely approaches it). */
function pumpAiInstant(state) {
  let steps = 0;
  const MAX_STEPS = 20000;
  while (driveOneAiStep(state)) {
    steps++;
    if (steps > MAX_STEPS) {
      console.error('pumpAiInstant: exceeded MAX_STEPS, stopping (likely an AI decision-loop bug)');
      break;
    }
  }
}

/** 'delayed' mode: schedules exactly one driveOneAiStep AI_STEP_DELAY_MS from now (re-render happens
 * inside the timeout so the board visibly updates one step at a time), then re-arms itself if more AI
 * work remains. Guarded by aiPumpTimer so overlapping calls (e.g. a render triggered by something else
 * while a step is already scheduled) never stack up duplicate timers.
 *
 * Pre-placement die highlight (2026-08-16, per user request: "1手ずつのときは、それに加えて、おかれる
 * 直前のダイスが光る", explicitly required not to add any perceptible wait): peeks at what the AI is
 * about to do via resolveAiTurnContext (read-only) + selectMove (pure, no state/rng side effects --
 * confirmed no src/ai/*.js file besides the offline game-runner.js CLI tool touches state.rng) and, if
 * it's a PLACE_DIE/PASS_DIE, renders once with that die highlighted in-hand. This doesn't add any delay:
 * it just uses the existing AI_STEP_DELAY_MS wait that was already happening, instead of leaving the
 * board static for it. At the end of that same wait, driveOneAiStep runs as before (re-deriving the same
 * move the normal way) and clears the pre-highlight.
 *
 * The peek+render is deferred one tick via its own setTimeout(...,0) (2026-08-16) rather than called
 * synchronously here -- pumpAiDelayed is itself invoked from render()'s own top, to arm the *next* step,
 * before that in-progress render() has painted the *current* move's result yet. Rendering the next move's
 * pre-highlight synchronously at that point would paint it before the current result ever appeared,
 * showing them in the wrong order. Deferring to a fresh tick lets the in-progress render() finish first. */
function pumpAiDelayed() {
  if (aiPumpTimer !== null) return;
  aiPumpTimer = setTimeout(() => {
    aiPumpTimer = null;
    aiPreHighlightMove = null;
    if (!hasAiWorkPending(STATE)) return;
    driveOneAiStep(STATE);
    render(STATE);
  }, AI_STEP_DELAY_MS);
  setTimeout(() => {
    if (aiPumpTimer === null) return; // fired, or canceled by a mode switch, before this tick ran
    const ctx = resolveAiTurnContext(STATE);
    if (ctx && ctx.type === 'TURN') {
      const move = aiPlayerFor(ctx.playerId).selectMove(STATE, ctx.playerId, { hasPlacedDieThisTurn: ctx.hasPlacedDieThisTurn });
      // PLACE_WILDCARD_DIE (2026-08-20) included alongside PLACE_DIE -- see aiOpenTurnHasPlacedDie's own
      // comment above for the main bug; this one is cosmetic only (which die glows before "1手ずつ"
      // places it), but the same move type was missing here too. PLACE_DICE_GROUP (2026-08-21) has 2
      // dieIds instead of a single dieId -- just glows the first of the pair (aiPreHighlightMove/its
      // one consumer at renderPlayers only ever track a single die.id, not worth generalizing to a set
      // for a cosmetic-only highlight).
      if (move && (move.type === 'PLACE_DIE' || move.type === 'PLACE_WILDCARD_DIE' || move.type === 'PLACE_DICE_GROUP' || move.type === 'PASS_DIE')) {
        aiPreHighlightMove = { playerId: ctx.playerId, dieId: move.dieId !== undefined ? move.dieId : move.dieIds[0] };
        render(STATE);
      }
    }
  }, 0);
}

// Dice-placement scratch state (2026-07-30, real engine wiring pass 2 -- not part of GameState, pure
// UI selection bookkeeping). See renderPlayers (die click) and renderBoard/placeSelectedDie (slot
// click) below.
// Ordered array, not a single id (2026-08-02, per user feedback: on the castle/AREA009, several dice --
// even different values, not just doubles -- can be selected together and placed as one monument-only
// group, see board.placeDiceGroup/placeSelectedDiceGroup). Order matters for the "placed on any OTHER
// area" fallback, which uses whichever die was selected *last* (confirmed 2026-08-02: "最後に選んだ方
// をそのスロットに配置"). Selecting a single die (the normal, non-castle/009 case) is just the
// length-1 case of the same array -- no separate code path.
let selectedDieIds = [];
let placementMessage = '';
// Snapshot taken immediately before a die placement is attempted (2026-08-10, per user request:
// "ダイスをSLOTに置いたときにやり直したい時のために...ダイスをキャンセルボタンが欲しい これを押すと
// ダイスを置くのをキャンセルする"). Unlike undoMod's own once-per-turn checkpoint (state.undoCheckpoint,
// which reverts everything done since the turn began, including any free actions/bare TAPs taken
// *before* this die was placed), this is scoped to just the placement itself -- captured right before
// board.placeDice/placeDiceGroup runs (see placeSelectedDie/placeSelectedDiceGroup), committed only once
// that call actually succeeds (a failed attempt never touched state, so there's nothing to arm), and
// cleared again once used (handleDiceCancelClick) or once a new turn begins (see render()'s turn-start
// checkpoint block) or a full ターン開始に戻す fires (handleUndoClick -- that already reverts past this
// point, so a stale die-cancel checkpoint pointing at a since-undone placement would be wrong to keep).
// Kept as plain UI-only state (like selectedDieIds), not GameState, since nothing outside this file
// (tests, AI, save data) needs to know about it. Stores turnActionTaken alongside the state clone since
// that flag also lives outside GameState and placing a die is exactly what sets it true.
let dicePlacementCheckpoint = null; // { state: GameState, turnActionTaken: boolean } | null
// Static text for GameState.whiteOverflowEvents (2026-08-11, per user request) -- see render()'s own
// drain of that array, right below this declaration's use site. This is the passive, after-the-fact
// fallback notice -- still shown for any wD-granting path not explicitly wrapped by
// pendingWhiteOverflowConfirm below (e.g. a TAP reaction), so an overflow the player had no chance to
// confirm in advance is still at least explained afterward. Was "1Kに変換されます" (itself lowered from
// 2K, 2026-08-19) until 2026-08-20, per user request: the overflow die is now simply lost, no resource
// granted at all -- see executor.grantOneDie's own doc.
const WHITE_OVERFLOW_WARNING_TEXT = '白ダイスの所有上限は5個です。それを超えたものは失われます。';
// { onConfirm: () => void } | null -- set by placeSelectedDie/placeSelectedDiceGroup/
// commitBuildCandidate/the JOB-draft pick handler (2026-08-19, per user request: "上限を超えた🎲はKに
// なります よろしいですか" -- cancelable, unlike the passive WHITE_OVERFLOW_WARNING_TEXT notice above)
// whenever wouldCauseWhiteOverflow predicts the real action about to run would trip a wD-cap overflow
// for the acting player. "はい" runs onConfirm (the actual commit, deferred until now); "いいえ" just
// clears this with no state change -- the real action was never attempted in the first place, matching
// dicePlacementCheckpoint's own "nothing to undo" cases, not a rollback.
let pendingWhiteOverflowConfirm = null;

/** Predicts whether running `action` (a function taking a GameState and performing some real engine
 * mutation on it) would trip a wD-cap overflow for anyone -- runs `action` against a disposable clone of
 * `state` and compares GameState.whiteOverflowEvents' length before vs after, rather than assuming
 * `state.whiteOverflowEvents` itself starts empty (an earlier action's events may not have been drained
 * into placementMessage by render() yet). Never touches the real `state`. */
function wouldCauseWhiteOverflow(state, action) {
  const before = state.whiteOverflowEvents.length;
  const clone = gameStateMod.cloneState(state);
  action(clone);
  return clone.whiteOverflowEvents.length > before;
}

function renderWhiteOverflowConfirmModal() {
  document.getElementById('white-overflow-confirm-overlay').hidden = !pendingWhiteOverflowConfirm;
}

// { playerId, dieId, onProceed } | null -- set by withJob007TapPrompt whenever a die placement about to
// run would offer an UPGRADE/monument BUILD_NEW candidate while JOB007/宮廷人 is owned and untapped
// (2026-08-22, per user request: "LVアップかモニュメント獲得しようとしたとき　宮廷人をタップしますか
// はい　いいえ"). dieId (2026-08-25, added when JOB007's own TAP changed to a die-boosting ability) is
// the specific die JOB007's TAP will target if accepted -- the one about to be placed. "はい" taps
// JOB007 for real (board.useBareTapAbility, targeting dieId -- gains BZ, applies
// MONUMENT_CHANGE_DIE_VALUE(SELF+2) to that die, blocks A/B/C builds this turn) THEN runs onProceed (the
// placement that was paused, which will now place that same die at its boosted value); "いいえ" just
// runs onProceed without tapping -- same "optional, not a blocking warning" shape as
// renderBuildChoiceBzTapPrompt's own tap-first offer, not
// pendingWhiteOverflowConfirm's "are you sure, this loses something" shape, so declining never cancels
// the placement itself.
let pendingJob007TapPrompt = null;

/** True if playerId's own JOB is 宮廷人/JOB007 and it isn't currently tapped -- see
 * pendingJob007TapPrompt's own doc. JOB has no A/B tier the way CON does, so 'JOB007' is a stable
 * physical id (matching how it's already referenced literally elsewhere, e.g. scoring.js's Q004A/
 * CON004A handling), no NAME-matching indirection needed the way board.js's CON-facing bespoke checks
 * (hasPioneerAbility etc.) use. */
function hasUntappedJob007(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  return player.jobCardId === 'JOB007' && !state.cards.JOB007.tapped;
}

/** Predicts whether running `action` (a function taking a GameState and returning a placeDice-shaped
 * result) would offer an UPGRADE or monument BUILD_NEW candidate -- runs `action` against a disposable
 * clone of `state` and inspects the *returned* pendingBuild.candidates (unlike wouldCauseWhiteOverflow,
 * which compares a GameState field before/after; here the relevant signal is the action's own return
 * value). Never touches the real `state`. See board.getBuildCandidates' own doc for candidate shape:
 * {type:'UPGRADE',...} or {type:'BUILD_NEW', shopKey:'M', ...} for a monument.
 *
 * dieId (2026-08-25, updated for JOB007's revised TAP -- see pendingJob007TapPrompt's own doc): before
 * running the dry-run placement, this first simulates tapping JOB007 against dieId on the SAME clone --
 * JOB007's own MONUMENT_CHANGE_DIE_VALUE(SELF+2) only ever helps THIS specific die reach a higher
 * threshold now (unlike the old MONUMENT_DICE_DISCOUNT, a global threshold reduction independent of any
 * one die), so the prediction must boost the same die the real "はい" tap would boost, or it would
 * under-predict (never offer the prompt in exactly the cases where the +2 is what unlocks a candidate). */
function wouldOfferUpgradeOrMonument(state, playerId, dieId, action) {
  const clone = gameStateMod.cloneState(state);
  if (dieId !== null) boardMod.useBareTapAbility(clone, INDEX, { playerId, chosenDieId: dieId }, 'JOB007');
  const result = action(clone);
  const candidates = result && result.actionResult && result.actionResult.pendingBuild && result.actionResult.pendingBuild.candidates;
  if (!candidates) return false;
  return candidates.some((c) => c.type === 'UPGRADE' || c.shopKey === 'M');
}

/** Shared entry point for all 3 die-placement paths (placeSelectedDie/placeSelectedWildcardDie/
 * placeSelectedDiceGroup) -- see pendingJob007TapPrompt's own doc. dieId is the (single, representative)
 * die JOB007's own TAP would target if accepted -- the die being placed for placeSelectedDie/
 * placeSelectedWildcardDie, or the first die of the group for placeSelectedDiceGroup (2026-08-25,
 * updated for JOB007's revised die-boosting TAP -- previously unused, since the old MONUMENT_DICE_
 * DISCOUNT never targeted a specific die at all). dryRunAction mirrors the real placement call
 * (board.placeDice/placeWildcardDie/placeDiceGroup) so wouldOfferUpgradeOrMonument can predict its
 * outcome; proceed is the real (unmodified) continuation to run either way. */
function withJob007TapPrompt(state, playerId, dieId, dryRunAction, proceed) {
  if (hasUntappedJob007(state, playerId) && wouldOfferUpgradeOrMonument(state, playerId, dieId, dryRunAction)) {
    pendingJob007TapPrompt = { playerId, dieId, onProceed: proceed };
    render(STATE);
    return;
  }
  proceed();
}

function renderJob007TapPromptModal() {
  document.getElementById('job007-tap-prompt-overlay').hidden = !pendingJob007TapPrompt;
}

// playerId | null -- set by advanceTurnIfPossible when RESOURCE_TOTAL_LIMIT blocks ending that
// player's turn (their die is already placed; only their resource total is in the way), cleared once
// it actually succeeds. Lets the free-action click handler below retry ending the turn immediately
// after a free action brings the total back under the limit, instead of leaving the player stuck with
// no way to actually finish (2026-07-31 fix -- free actions exist and are usable here, but nothing
// previously re-attempted the turn-end they're meant to unblock).
let pendingTurnEndPlayerId = null;
// { playerId, warnings } | null -- set by attemptAdvanceTurn when ending playerId's turn right now
// would trigger a RESOURCE_LIMIT/FORCE_CONVERT WARNING (see turnEndWarnings/
// renderTurnEndWarningModal). Cancelable ("いいえ" just leaves the turn as-is, nothing has happened
// yet at this point -- ending the turn is exactly what's being confirmed).
let pendingTurnEndWarning = null;
// { playerId } | null -- set by the "ラウンドパス" header button, confirmed/canceled via
// renderRoundPassConfirmModal (2026-08-02, per user feedback). Nothing has happened yet at this point
// (mirrors pendingTurnEndWarning's own cancelable-until-confirmed shape).
let pendingRoundPassConfirm = null;
// { playerId, categories, buildValue, candidates, remainingCommands } | null -- see placeSelectedDie
// and renderBuildChoiceModal (real engine wiring pass 3, BUILD/UPGRADE candidate selection).
let pendingBuildChoice = null;
// {A:'AUTO'|'Z', B:..., C:...} -- 色欲's "real or Z" payment choice for whichever BUILD/UPGRADE
// candidate ends up picked in the modal above (see renderBuildChoicePaymentControls). Reset whenever
// pendingBuildChoice changes; irrelevant (never read) for players without the ability, since
// executor.resolvePayment ignores colorPreference unless hasPaymentChoiceAbility is true anyway.
let buildColorPreference = {};
// { candidate, outcomes } | null -- BZ is spent automatically now (2026-08-04, per user feedback:
// "デフォルトでBZを使って建築するようにして"; see executor.enumerateBzOutcomes for the full rationale).
// Clicking a BUILD_NEW candidate computes every distinct affordable way to spend the max usable BZ; if
// there's only one, the build commits immediately with no extra step. If there's more than one (2+
// resource types in the cost, and the player holds enough of more than one to actually change which
// real resource gets spent), this holds the pending choice while renderBzOutcomeChoice asks which
// outcome to commit. Applies to UPGRADE too (2026-08-06, per user feedback -- BZ discounts an UPGRADE's
// COST exactly like a BUILD_NEW's, against the *original* tier's COST; see board.resolveUpgrade). Reset
// alongside buildColorPreference wherever a fresh pendingBuildChoice is set.
let pendingBzOutcomeChoice = null;
// { mapId, slotIndex, colors, colorPreference } | null -- 色欲's payment choice for an AREA whose
// own ACTION pays A/B/C directly (see attemptPlaceSelectedDie/areaColorPayResources/
// renderPlacementChoiceModal). Set instead of placing immediately; the die isn't placed yet at this
// point, so unlike pendingBuildChoice this one has a real cancel affordance.
let pendingPlacementChoice = null;
// { physicalId, playerId, bareTap:{kind,choices?}, dieId, value } | null -- a bare TAP ability that
// needs a die+value choice before it can run (SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE, see
// attachTapToggle/bareTapKind/renderTapChoiceModal). dieId/value start null (nothing picked yet); the
// modal's confirm button is disabled until both are set. Cancelable -- nothing committed yet.
let pendingTapChoice = null;
// { physicalId, playerId } | null -- shown right after a card with a reactive (ON(...)-wrapped) TAP
// ability enters a player's possession (BUILD/UPGRADE commit, or JOB draft, per user feedback
// 2026-07-31: "建築時にオート/マニュアルを選べるように"/"JOBを選択したときに選べるように") -- lets them
// confirm or flip its auto/manual mode away from the data's own AUTO-column default right at
// acquisition, via executor.setCardAutoMode. See reactiveTapKind/renderAutoModeChoiceModal. Not a
// blocking choice (the default already applies on its own) -- just dismissable.
let pendingAutoModeChoice = null;
// Tracks whose TURN a checkpoint was last auto-recorded for (2026-07-30, per user feedback: "調整段階
// なのでターン開始時に戻る、ダイスが振られても振られなくても関係無し") -- see render()'s own
// checkpoint-recording logic and handleUndoClick below. null whenever nobody's mid-TURN (onboarding,
// or before round 1 starts).
let lastTurnPlayerId = null;
// Tracks round 1's original turnOrder[0] ("1番手") and how many genuine TURNs they've started, purely
// to drive renderJobPool's auto-hide (2026-08-04, per user feedback: "えらばれなかったJOBは1番手の２
// ターン目から片付けてください"). Snapshotted once (turnOrder is recomputed every round, but "1番手"
// here specifically means round 1's first player) the first time a real TURN exists.
let round1FirstPlayerId = null;
let round1FirstPlayerTurnStartCount = 0;
// Separate from lastTurnPlayerId on purpose: lastTurnPlayerId is only checked once per render() call
// (see render()'s own comment on why it's guarded that way, for undo-checkpoint purposes), but
// pumpAiInstant can blow through several different AI players' *entire* turns inside a single render()
// call before that check ever runs -- e.g. with 1 human + 3 AI, ending the human's turn triggers one
// render() whose pumpAiInstant silently drives all 3 AI turns back-to-back before returning control, so
// a lastTurnPlayerId-style single comparison after the pump would only ever see "human -> human" and
// completely miss the 3 AI turn-starts in between. noteActiveTurnPlayerForJobPool is instead called at
// per-move granularity from inside driveOneAiStep itself (which runs once per single AI move, so it sees
// every turn boundary as it happens), as well as from render() for the human's own turn -- both paths
// share this one last-seen variable so a turn-start is counted exactly once regardless of which path
// (AI-blown-through-in-a-pump, or human-paced-by-clicks) actually crossed it.
let lastNotedActiveTurnPlayerId = null;
/** Call once per confirmed "this playerId's TURN is now active" observation (idempotent -- a repeat call
 * with the same playerId no-ops, UNLESS forceNewTurn is true), from both driveOneAiStep (AI path) and
 * render() (human path). See lastNotedActiveTurnPlayerId's own comment for why two call sites are needed.
 *
 * forceNewTurn (2026-08-17, per user report: "デバッグモードで戻ったときSHOP101が空のままで詰めていかな
 * かった") -- the playerId-only dedup above missed exactly the same edge case turnJustEnded was already
 * invented to fix for the undo-checkpoint transition block (see its own doc): the SAME player taking
 * several turns in a row once everyone else is out of dice for the round. Each caller passes true only
 * when IT already knows this is a genuinely new turn boundary despite playerId being unchanged --
 * render() passes turnJustEnded itself; driveOneAiStepInner passes `ctx.playerId === lastEndedAiTurnPlayerId`
 * (see that variable's own doc -- NOT simply "this AI's turn isn't currently open", which sounded
 * equivalent but wasn't: that was also true for a player's ordinary first move of a turn render() had
 * already noted moments earlier, over-forcing a double-count and regressing into the exact "JOBが選べな
 * くなりました" symptom this whole mechanism exists to avoid -- found 2026-08-17, fixed by tracking the
 * actual END_TURN transition explicitly instead of inferring it from aiOpenTurnPlayerId's mere nullness).
 * Without correctly detecting the real repeat case, a later turn in that same run-of-consecutive-turns
 * silently got no turnHistory entry at all -- so stepping through the debug TURN timeline could skip
 * straight over a shop restock that happened on one of those un-recorded turns, landing on a snapshot
 * from before it with an empty SHOP101 that never "catches up". */
function noteActiveTurnPlayerForJobPool(state, playerId, forceNewTurn) {
  if (playerId === lastNotedActiveTurnPlayerId && !forceNewTurn) return;
  lastNotedActiveTurnPlayerId = playerId;
  if (round1FirstPlayerId === null && state.turnOrder && state.turnOrder.length > 0) round1FirstPlayerId = state.turnOrder[0];
  if (playerId === round1FirstPlayerId) round1FirstPlayerTurnStartCount++;
  // Debug turn-history timeline (2026-08-04, dev/verification feature, separate from the normal Undo
  // button -- see recordTurnHistorySnapshot's own doc). Reuses this exact "fires once per genuine turn
  // boundary, from both the AI path (driveOneAiStep) and the human path (render())" signal rather than
  // inventing a third copy of the same dedup machinery lastNotedActiveTurnPlayerId's own comment
  // describes -- it's already exactly the "start of a real TURN" moment this needs.
  recordTurnHistorySnapshot(state, playerId);
}

// ---------------------------------------------------------------------------
// Debug turn-history timeline (2026-08-04, per user request) -- a developer/verification tool, fully
// separate from the normal in-game Undo (undo.js's single "start of this turn" checkpoint, used during
// real play). This instead keeps a full timeline of every turn boundary crossed so far this session, and
// lets the debug panel jump freely to any of them (or step by TURN/ROUND) to re-test from that exact
// point. Only active while debugMode is on (see toggleDebugMode) -- recording a full GameState clone
// every turn boundary isn't free, and this feature is opt-in by design.
// ---------------------------------------------------------------------------
// Defaults to on (2026-08-04, per user feedback: "デバッグモードのデフォルトもONにして").
let debugMode = true;
/** @type {{round:number, playerId:string, snapshot:Object}[]} */
let turnHistory = [];
/** Index into turnHistory currently being viewed. -1 means "no history recorded yet". */
let historyCursor = -1;

/** Records a full GameState snapshot as "the state at the start of playerId's turn" (called only from
 * noteActiveTurnPlayerForJobPool, which already fires exactly once per genuine turn boundary -- see its
 * own doc). structuredClone (already used the same way in board.js's wouldAreaActionHaveEffect) gives an
 * independent deep copy, so later play can never mutate an already-recorded snapshot out from under it
 * (spec item 11). If historyCursor isn't already at the end -- i.e. the player jumped back to an earlier
 * point and then took a genuinely new action that led to a new turn boundary -- the old "future" beyond
 * that point is discarded first (spec item 9: a new branch replaces it, it doesn't get appended after). */
function recordTurnHistorySnapshot(state, playerId) {
  // GAME_END guard (found via headless testing): turnFlow.getNextTurn keeps returning a normal
  // {type:'TURN', playerId} even once state.phase is 'GAME_END' (nothing about "whose turn is next"
  // stops making sense just because the game is over), and render()'s own call into
  // noteActiveTurnPlayerForJobPool doesn't gate on phase either -- so without this check, the very
  // next render() after reaching GAME_END would record one bogus trailing "turn" that doesn't
  // correspond to any real, replayable action. Left alone, jumping back to an earlier point and letting
  // play run back up to GAME_END again would append a *different* bogus tail each time (whichever
  // player getNextTurn happened to name that pass), making the timeline drift on repeated round-trips.
  if (!debugMode || state.phase === 'GAME_END') return;
  if (historyCursor < turnHistory.length - 1) turnHistory = turnHistory.slice(0, historyCursor + 1);
  turnHistory.push({ round: state.round, playerId, snapshot: structuredClone(state) });
  historyCursor = turnHistory.length - 1;
}

/** Restores turnHistory[idx]'s snapshot as the live STATE (spec items 11 & 13: a fresh deep copy, no
 * game logic/triggers re-run -- just the raw GameState swapped in, then a normal render() to rebuild the
 * UI from it, same "mutate STATE's own keys in place" idiom executor.runProgram's own rollback uses,
 * since STATE is a `const` reference the rest of this file already closes over). UI-only scratch state
 * (not part of GameState -- selectedDieIds, pendingBuildChoice, etc.) is cleared the same way
 * handleUndoClick already does, since none of it survives a jump to a different point in time. Also
 * re-arms the normal Undo checkpoint from this new position, so Undo behaves normally if play resumes
 * from here (matching handleUndoClick's own post-undo re-arm). */
function jumpToHistoryIndex(idx) {
  if (idx < 0 || idx >= turnHistory.length) return;
  historyCursor = idx;
  const restored = structuredClone(turnHistory[idx].snapshot);
  Object.keys(STATE).forEach((k) => delete STATE[k]);
  Object.assign(STATE, restored);
  selectedDieIds = [];
  pendingBuildChoice = null;
  pendingPlacementChoice = null;
  pendingTapChoice = null;
  pendingAutoModeChoice = null;
  pendingTurnEndPlayerId = null;
  pendingTurnEndWarning = null;
  pendingRoundPassConfirm = null;
  pendingWhiteOverflowConfirm = null;
  pendingJob007TapPrompt = null;
  turnActionTaken = false;
  placementMessage = '';
  // aiOpenTurnPlayerId/aiOpenTurnHasPlacedDie (found via headless testing): also not part of GameState,
  // but unlike the UI-only vars above they directly feed driveOneAiStep's hasPlacedDieThisTurn decision
  // -- leaving them stale after a jump could make an AI think it already placed this "turn" when the
  // restored GameState says otherwise (or vice versa), corrupting the very next AI move it picks. A
  // debug jump always lands exactly at a turn's start, so "no AI has an open turn right now" is always
  // the correct reset, same as a fresh game load's own initial values.
  aiOpenTurnPlayerId = null;
  aiOpenTurnHasPlacedDie = false;
  lastEndedAiTurnPlayerId = null; // same reasoning -- a jump always lands at a turn's start, never mid-repeat
  // lastNotedActiveTurnPlayerId/lastTurnPlayerId (found via headless testing): render()'s own top-level
  // "a new turn just started" detection compares next.playerId against these two dedup vars completely
  // independently of historyCursor -- left stale after a jump, the very render() call below would see
  // "a different player is active now" (true, but only because we jumped, not because a genuine new turn
  // began) and treat it as a fresh boundary: noteActiveTurnPlayerForJobPool would fire again, calling
  // recordTurnHistorySnapshot a second time for the *same* turn this jump just landed on, which -- since
  // historyCursor already sits before the end of turnHistory whenever jumping backward -- would truncate
  // and immediately re-append an entry, silently overwriting whatever was really there. Pre-seeding both
  // with this entry's own playerId makes render() correctly recognize "already noted" and skip that.
  lastNotedActiveTurnPlayerId = turnHistory[idx].playerId;
  lastTurnPlayerId = turnHistory[idx].playerId;
  // round1FirstPlayerId/round1FirstPlayerTurnStartCount (found 2026-08-05, per user bug report: "デバッ
  // グモードで初期状態まで戻るとJOB選択をする時JOBが非表示でえらべない") -- same class of bug as
  // aiOpenTurnPlayerId/lastNotedActiveTurnPlayerId above (a UI-only var outside GameState, left stale by
  // a jump): renderJobPool permanently hides the pool once this count reaches 2, and jumping back to
  // round 0 left it at whatever forward-progressed value it last reached, so the pool stayed hidden even
  // though nobody had drafted yet in the restored state. Recomputed by replaying the exact same rule
  // noteActiveTurnPlayerForJobPool applies (turnHistory only ever contains genuine TURN-start entries,
  // one per real turn boundary -- see its own doc -- so this reproduces exactly what live play would
  // have counted by this point) rather than just zeroing it, since a jump *forward* past round 1's 2nd
  // turn must still correctly keep the pool hidden.
  round1FirstPlayerId = null;
  round1FirstPlayerTurnStartCount = 0;
  for (let i = 0; i <= idx; i++) {
    const entry = turnHistory[i];
    if (!entry.playerId) continue; // the pre-onboarding seed entry (turnHistory[0] before round 1 starts)
    if (round1FirstPlayerId === null && entry.snapshot.turnOrder && entry.snapshot.turnOrder.length > 0) {
      round1FirstPlayerId = entry.snapshot.turnOrder[0];
    }
    if (entry.playerId === round1FirstPlayerId) round1FirstPlayerTurnStartCount++;
  }
  undoMod.recordCheckpoint(STATE);
  render(STATE);
}

function handleDebugTurnBack() { jumpToHistoryIndex(historyCursor - 1); }
function handleDebugTurnForward() { jumpToHistoryIndex(historyCursor + 1); }
/** ROUND back/forward (spec items 7-8): jump to the *first* recorded entry of the previous/next round
 * relative to the currently-viewed entry -- i.e. that round's own start, not just "one round-number
 * away" from wherever mid-round the cursor happens to sit. findIndex's own first-match semantics give
 * this "the start of" meaning for free in either direction; a target round not yet reached in the
 * recorded history (e.g. stepping forward past the latest turn played) simply no-ops. */
function jumpToAdjacentRound(direction) {
  if (historyCursor < 0) return;
  const targetRound = turnHistory[historyCursor].round + direction;
  const idx = turnHistory.findIndex((e) => e.round === targetRound);
  if (idx === -1) return;
  jumpToHistoryIndex(idx);
}
function handleDebugRoundBack() { jumpToAdjacentRound(-1); }
function handleDebugRoundForward() { jumpToAdjacentRound(1); }

// ---------------------------------------------------------------------------
// Move-by-move game replay (2026-08-1X, per user request: game-end's final results screen gets a
// "リプレイ" button that opens a read-only mode -- "結果は固定で 進む 戻る で1手づつ確認できる". Unlike
// turnHistory above (TURN-boundary granularity, gated behind debugMode, purpose-built for the debug
// panel's own "jump back and replay the live game" workflow -- see jumpToHistoryIndex, which actually
// restores STATE itself), this is: (1) always recording, regardless of debugMode, since it needs the
// WHOLE game available once GAME_END is reached, not just whatever happened to be recorded after the
// user toggled debug mode on; (2) one entry per individual Move, not per turn, since "1手づつ" means
// stepping through a BUILD/TAP/free-action/PLACE_DIE/END_TURN one at a time, not turn-at-a-time; (3)
// purely read-only when browsing -- replayCursor never touches the live STATE object at all, it's
// rendered straight from replayHistory's own snapshots by renderReplayFrame (a stripped-down parallel to
// render() that reuses the same renderShops/renderBoard/renderPlayers/renderJobPool/
// renderPlayerCards building blocks, but skips every side-effecting/live-only piece of render() itself --
// AI pumping, checkpoint recording, turnActionTaken/lastTurnPlayerId bookkeeping, all the *-choice modals
// -- and neutralizes whatever interactivity those shared builders still attach via the
// .replay-locked/pointer-events:none wrapper in style.css, so a stray click during replay can never
// mutate a recorded snapshot or the live game).
//
// Recording hooks into exactly the two places a Move can ever actually apply: render()'s own top (every
// human action handler mutates STATE then calls render(STATE), so this catches all of them in one place)
// and driveOneAiStep's wrapper below (the single choke point for every individual AI decision -- without
// this, 'instant' AI pacing's pumpAiInstant would resolve an entire multi-move AI backlog inside one
// render() call, collapsing it to a single replay entry instead of one per move). Both funnel into
// recordReplaySnapshotIfChanged, which dedupes against the last-recorded snapshot so pure UI-only
// re-renders (selecting a die, opening a modal -- STATE itself unchanged) never add a spurious entry.
// ---------------------------------------------------------------------------
let replayHistory = [];
let replayCursor = -1;
let lastReplaySnapshotJson = null;
let replayMode = false;

function recordReplaySnapshotIfChanged(state) {
  const json = JSON.stringify(state);
  if (json === lastReplaySnapshotJson) return;
  lastReplaySnapshotJson = json;
  replayHistory.push(structuredClone(state));
}

// Set only while viewing a saved ranking entry's replay (2026-08-16) -- see enterReplayMode's
// historyOverride param. Holds the live game's own replayHistory/replayCursor so exitReplayMode can
// restore them, since replayHistory is temporarily swapped to the ranking entry's saved history.
let liveReplayBackup = null;

/** @param {object[]} [historyOverride] - if given (a saved ranking entry's replay, see ranking.js),
 *   views that history instead of the live game's own replayHistory, restoring the live one on
 *   exitReplayMode (2026-08-16, for the ranking list's ▶ button). */
function enterReplayMode(historyOverride) {
  const history = historyOverride || replayHistory;
  if (history.length === 0) return;
  // Defensively force every other overlay closed (2026-08-1X) -- GAME_END is only ever reached right
  // after a real END_TURN resolves (see renderGameEndOverlay's own doc), so in practice none of these
  // should ever be open at this point, but renderReplayFrame doesn't render (or re-hide) any of them
  // itself, and .replay-locked's pointer-events:none never reaches these -- they live outside #app (see
  // index.html's own comment) same as #replay-controls does on purpose.
  for (const id of ['card-inst-overlay', 'build-choice-overlay', 'placement-choice-overlay',
    'tap-choice-overlay', 'auto-mode-choice-overlay', 'turn-end-warning-overlay', 'round-pass-confirm-overlay',
    'white-overflow-confirm-overlay', 'job-replacement-choice-overlay', 'ranking-overlay']) {
    document.getElementById(id).hidden = true;
  }
  if (historyOverride) {
    liveReplayBackup = { history: replayHistory, cursor: replayCursor };
    replayHistory = historyOverride;
  }
  replayMode = true;
  replayCursor = history.length - 1; // start at the final result already on screen
  render(STATE);
}

function exitReplayMode() {
  replayMode = false;
  if (liveReplayBackup) {
    replayHistory = liveReplayBackup.history;
    replayCursor = liveReplayBackup.cursor;
    liveReplayBackup = null;
  }
  render(STATE);
}

function handleReplayBack() { if (replayCursor > 0) { replayCursor--; render(STATE); } }
function handleReplayForward() { if (replayCursor < replayHistory.length - 1) { replayCursor++; render(STATE); } }

/** Jumps straight to round N's own first recorded entry (2026-08-17, per user request: "リプレイモードに
 * R1（ラウンド1　ゲーム開始時）R2　R3　R4に飛べるボタンが欲しい") -- R1's target is always index 0 (the
 * very first entry recording ever starts at, necessarily round 1), the others wherever that round's own
 * first move first got recorded. No-op if that round was never reached this game (see
 * renderReplayControls, which disables the button in that case) -- shouldn't normally happen for a
 * finished 4-round game, but stays safe rather than throwing if this is ever called against a shorter
 * history (e.g. a saved ranking-entry replay from before round 4, if that's ever possible). */
function jumpToReplayRound(round) {
  const idx = replayHistory.findIndex((s) => s.round === round);
  if (idx === -1) return;
  replayCursor = idx;
  render(STATE);
}

/** The replay-mode counterpart of render() (see this section's own doc for why it's a separate,
 * side-effect-free function rather than branching deep inside render() itself). Computes `next` the same
 * way render() does (minus the live-only stillMidTurnPlayerId/aiOpenTurnPlayerId override, which reads
 * module state that has no meaning against a frozen historical snapshot) purely so the board visually
 * matches what was actually clickable at that point in history -- .replay-locked's pointer-events:none
 * (see style.css) is what actually guarantees none of it responds to a click. */
function renderReplayFrame() {
  // Defensive try/catch (2026-08-18, per user report: "前のランキングのリプレイだったためIDがずれていて
  // 変な挙動でした") -- a ranking entry's saved replay can predate a physical-id reorg (e.g. the CON
  // sheet reshuffle) or a since-added card, so its snapshots' ids can mean something different, or
  // nothing at all, under the *current* data.json. Rendering one of those can throw (e.g. getCardRow on
  // an id that no longer exists) partway through this function, which -- without this guard -- would
  // leave replayMode stuck true (it's set before this ever runs, see enterReplayMode) with no code path
  // left to un-stick it, since nothing else calls exitReplayMode automatically. Falls back to exiting
  // replay mode outright and telling the user, rather than a broken/half-drawn board staying on screen.
  try {
    const snapshot = replayHistory[replayCursor];
    const next = snapshot.round >= 1 ? turnFlowMod.getNextTurn(snapshot) : null;
    document.getElementById('app').classList.add('replay-locked');
    document.getElementById('game-end-overlay').hidden = true;
    renderShops(snapshot);
    renderBoard(snapshot, next);
    renderPlayers(snapshot, next);
    renderJobPool(snapshot, next);
    renderPlayerCards(snapshot, next);
    document.getElementById('board-message').textContent = '';
    renderReplayControls();
  } catch (e) {
    console.error('renderReplayFrame failed (likely a stale/incompatible saved replay):', e);
    exitReplayMode();
    window.alert('このリプレイは表示できませんでした（データの更新により古いリプレイと互換性がなくなった可能性があります）。ランキング画面からリセットできます。');
  }
}

function renderReplayControls() {
  const controls = document.getElementById('replay-controls');
  controls.hidden = !replayMode;
  const appEl = document.getElementById('app');
  if (!replayMode) {
    appEl.style.paddingTop = ''; // back to the plain CSS default (see #app's own rule)
    return;
  }
  document.getElementById('replay-back').disabled = replayCursor <= 0;
  document.getElementById('replay-forward').disabled = replayCursor >= replayHistory.length - 1;
  document.getElementById('replay-position').textContent = `手 ${replayCursor + 1} / ${replayHistory.length}`;
  // R1-R4 jump buttons (see jumpToReplayRound's own doc) -- disabled for any round this particular
  // history never actually reached, same "don't offer a jump with nowhere to land" reasoning as
  // replay-back/forward's own disabled states above.
  for (let round = 1; round <= 4; round++) {
    document.getElementById(`replay-round-${round}`).disabled = !replayHistory.some((s) => s.round === round);
  }
  // Reserves enough top space that .replay-controls' own fixed position (see style.css) never covers
  // the board underneath (2026-08-1X, found via tablet-width testing -- iPad portrait's narrower
  // #game-layout stack has shop cards right at the top, and the bar sat directly on top of them,
  // obscuring/blocking a couple of SHOP slots entirely). Measured live rather than a fixed guess: the
  // bar's own width/wrapping (and therefore height) already varies by viewport and by how long
  // replayHistory's move count gets ("手 205 / 205" vs "手 12 / 12"), so a hardcoded padding would drift
  // out of sync on some width instead of tracking it. +16px breathing room below the bar.
  appEl.style.paddingTop = `${controls.getBoundingClientRect().bottom + 16}px`;
}

/** Turns debugMode on/off (spec item 14: the history UI itself is hidden while off, see
 * renderDebugPanel). Turning it on for the first time this session seeds turnHistory with the *current*
 * live state as history entry 0, so the panel has something to show/navigate immediately rather than
 * waiting for the next turn boundary (recordTurnHistorySnapshot only fires going forward from here).
 * Turning it off again does not clear turnHistory -- toggling back on later still has the full timeline
 * (recording just pauses while off, per debugMode's own gate in recordTurnHistorySnapshot). */
/** Shared by toggleDebugMode and the startup path (now that debugMode defaults to true, 2026-08-04, per
 * user feedback: "デバッグモードのデフォルトもONにして" -- the panel needs the same "something to show
 * immediately" seeding either way, not just when toggled on by hand mid-game). */
function seedDebugHistoryIfNeeded() {
  if (!debugMode || turnHistory.length > 0) return;
  const next = STATE.round >= 1 ? turnFlowMod.getNextTurn(STATE) : null;
  turnHistory.push({ round: STATE.round, playerId: next ? next.playerId : null, snapshot: structuredClone(STATE) });
  historyCursor = 0;
}

function toggleDebugMode() {
  debugMode = !debugMode;
  seedDebugHistoryIfNeeded();
  render(STATE);
}

// ---------------------------------------------------------------------------
// Debug test-game setup (2026-08-13, per user request): a "テストゲーム開始" button opens an image
// picker, one category at a time (CON -> JOB -> 初期資源 -> ABCカード), that lets P1 pre-decide which
// cards show up in a fresh game; P2-P4 stay fully random regardless (see createInitialState's own doc
// for exactly what each category controls). Reaching a category's own max count auto-advances to the
// next one immediately; the END button also advances at any time, with fewer (including zero) picked.
// Unrelated to debugMode/turnHistory above -- this is "configure the next game's setup", not "replay
// the current one".
// ---------------------------------------------------------------------------

/** One entry per picker screen, in the order shown. max=1 for CON reads the same as the others --
 * "pick at most one", not mandatory; pressing END with nothing picked is always valid everywhere.
 * columns (2026-08-13, per user request) sets #debug-setup-list's grid width for that step -- chosen
 * per step to exactly fit its own card count with no partial last row (CON 6x2=12 (2026-08-15, updated
 * after CON006A/B brought the CON sheet from 10 faces to 12), ABC 7x3=21), not a single shared
 * column count across every step. JOB wraps 6+5 at its current 11 faces (2026-08-22, per user request
 * "JOBカード６枚で折り返すようにして" -- supersedes the earlier 2026-08-17 "5個で折り返す" call, from
 * back when there were only 9 JOB faces and no clean split existed either way). */
const DEBUG_SETUP_STEPS = [
  { key: 'con', label: 'CON（最大1枚）', max: 1, columns: 6, faceIds: () => INDEX.raw.CON.map((r) => r.ID) },
  { key: 'job', label: 'JOB（最大6枚）', max: 6, columns: 6, faceIds: () => INDEX.raw.JOB.map((r) => r.ID) },
  { key: 'resource', label: '初期資源（最大2枚）', max: 2, columns: 6, faceIds: () => INDEX.raw.RESOURCE.map((r) => r.ID) },
  { key: 'abc', label: 'ABCカード（最大6枚、選んだ順にSHOP101→106）', max: 6, columns: 7, faceIds: () => setupMod.collectNormalShopFaceIds(INDEX) },
  // QST (2026-08-18, per user request: "テストゲームでQSTも選べるようにしてください 選んだ順に上から
  // おかれる") -- unlike the 3 steps above, not P1-scoped at all (QST reveals are shared by the whole
  // game, see qst.setupQuests). Both tiers (A/B) of the same physical QST card can never be picked
  // together -- see toggleDebugSetupSelection's own doc for the swap-in-place handling.
  { key: 'qst', label: 'QST（最大3枚、選んだ順に上から表示）', max: 3, columns: 4, faceIds: () => INDEX.raw.QST.map((r) => r.ID) },
];

/** null while the picker is closed; otherwise {stepIndex, selections: {con:[], job:[], resource:[],
 * abc:[], qst:[]}} (each an array of faceIds, in the order clicked -- order matters for 'abc' and
 * 'qst', see DEBUG_SETUP_STEPS' own doc; 'con' holds at most one specific face, e.g. "CON003B", even
 * though only its physical id ends up used -- see createInitialState). Purely UI-scratch, never touches
 * STATE/GameState. */
let debugSetupFlow = null;

function openDebugSetupFlow() {
  debugSetupFlow = { stepIndex: 0, selections: { con: [], job: [], resource: [], abc: [], qst: [] } };
  render(STATE);
}

function cancelDebugSetupFlow() {
  debugSetupFlow = null;
  render(STATE);
}

/** Toggles faceId in/out of the current step's selection (click a picked one again to deselect it).
 * Auto-advances the instant the step's own max is reached -- see this section's own doc.
 *
 * QST (2026-08-18): both tiers (A/B) of the same physical QST card can never be revealed together (see
 * qst.setupQuests' own doc), so picking one while its sibling tier is already selected swaps it in
 * place -- removes the sibling first (freeing a slot even if the list was already at max), rather than
 * silently doing nothing the way clicking an unrelated face at max would. */
function toggleDebugSetupSelection(faceId) {
  const step = DEBUG_SETUP_STEPS[debugSetupFlow.stepIndex];
  const list = debugSetupFlow.selections[step.key];
  const i = list.indexOf(faceId);
  if (i >= 0) {
    list.splice(i, 1);
  } else {
    if (step.key === 'qst') {
      const physicalId = faceId.slice(0, -1);
      const siblingIndex = list.findIndex((id) => id.slice(0, -1) === physicalId);
      if (siblingIndex >= 0) list.splice(siblingIndex, 1);
    }
    if (list.length < step.max) list.push(faceId);
  }
  if (list.length >= step.max) {
    advanceDebugSetupFlow();
    return;
  }
  render(STATE);
}

/** Moves to the next picker step (from an END click or toggleDebugSetupSelection hitting max). Once the
 * last step (ABC) is done, stashes the finished plan into sessionStorage and reloads the page --
 * createInitialState() picks it up on the resulting fresh load (see consumeDebugSetupPlan) the same way
 * it would for a normal new game, just with these overrides applied. Reload (rather than rebuilding
 * STATE in place) sidesteps every other piece of module-scope UI scratch state this file accumulates
 * during play (selectedDieIds, turnHistory, replayMode, ...) that would otherwise need resetting by
 * hand one at a time. */
function advanceDebugSetupFlow() {
  if (debugSetupFlow.stepIndex + 1 < DEBUG_SETUP_STEPS.length) {
    debugSetupFlow.stepIndex += 1;
    render(STATE);
    return;
  }
  sessionStorage.setItem(DEBUG_SETUP_PLAN_KEY, JSON.stringify(debugSetupFlow.selections));
  location.reload();
}

/** Renders the current picker step into #debug-setup-overlay -- hidden entirely while debugSetupFlow is
 * null. Reuses buildCardVisual/the owned-card-cell grid vocabulary already used by
 * renderResourceChoice's candidate picker, plus a small numbered badge on 'abc'/'qst' picks (the steps
 * where pick ORDER itself is meaningful -- see DEBUG_SETUP_STEPS). QST (2026-08-18) uses
 * buildQstCardVisual instead of buildCardVisual -- a completely different DOM shape/template (.qst-card,
 * not .shop-card) that every other card type doesn't need, so it also gets its own wider column size
 * (244px, vs. the 122px shop-card width every other step shares) rather than squeezing into that -- the
 * column width matches .owned-card-cell--qst's own fixed size exactly (2026-08-20 fix, per user report:
 * before this the column was 260px against a still-122px cell, leaving a large unexplained gap beside
 * every QST card -- see that CSS class's own doc), same pixel-perfect column-fill every other step's
 * 122px cell/column pairing already has. */
function renderDebugSetupOverlay() {
  const overlay = document.getElementById('debug-setup-overlay');
  if (!debugSetupFlow) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const step = DEBUG_SETUP_STEPS[debugSetupFlow.stepIndex];
  document.getElementById('debug-setup-title').textContent = step.label;
  const selected = debugSetupFlow.selections[step.key];
  const list = document.getElementById('debug-setup-list');
  list.innerHTML = '';
  list.style.gridTemplateColumns = step.key === 'qst' ? `repeat(${step.columns}, 244px)` : `repeat(${step.columns}, 122px)`;
  for (const faceId of step.faceIds()) {
    const cardNode = step.key === 'qst'
      // showRankHeaders:false (2026-08-18, per user report the picker's display was broken) -- this
      // step is choosing which QST cards to include, before any game/ranking exists yet, so every
      // player is tied at 0 and the "1位/2位/3位" rank headers/columns have nothing real to show.
      // showLiveRanking:false (2026-08-22, per user report: "最多エンブレムやエンブレム総数で１の
      // キャラがいて持っているのが分かってしまう") -- this button reconfigures the *next* game using
      // the *currently still-loaded* one's real STATE/players, so without this the value/swatches were
      // leaking that in-progress game's real card ownership -- see buildQstCardVisual's own doc.
      ? buildQstCardVisual(faceId, STATE, { showRankHeaders: false, showLiveRanking: false, noInteraction: true })
      : buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    // QST (2026-08-20, per user report: "カードの大きさをそろえて...不自然に横に広がっている") -- gets
    // its own fixed-size cell class (.owned-card-cell--qst, matching the 244px grid column this step
    // already sets above) instead of falling through to the plain 122px default every non-A/B/C step
    // used, which left QST's own wider card content unconstrained -- see that class's own CSS doc.
    const cellClass = step.key === 'qst'
      ? 'owned-card-cell owned-card-cell--qst owned-card-cell--selectable'
      : tall
        ? 'owned-card-cell owned-card-cell--tall owned-card-cell--selectable'
        : 'owned-card-cell owned-card-cell--selectable';
    const cell = el('div', cellClass);
    const pickIndex = selected.indexOf(faceId);
    if (pickIndex >= 0) {
      cell.classList.add('owned-card-cell--selected');
      cell.appendChild(cardNode);
      if (step.max > 1) cell.appendChild(el('span', 'debug-setup-pick-badge', String(pickIndex + 1)));
    } else {
      cell.appendChild(cardNode);
    }
    cell.addEventListener('click', () => toggleDebugSetupSelection(faceId));
    list.appendChild(cell);
  }
}

// ---------------------------------------------------------------------------
// カードリスト (2026-08-22, per user request): a read-only browser over every card/resource type in
// the game, opened via the "カードリスト" button beside "テストゲーム開始" (unrelated to it -- this
// doesn't touch STATE at all, purely a data viewer). See CARD_LIST_NAV for the persistent bottom-nav
// category list and renderCardListOverlay for the dispatch.
// ---------------------------------------------------------------------------

/** null while closed; otherwise the currently shown category key (see CARD_LIST_NAV). Purely
 * UI-scratch, like debugSetupFlow above. */
let cardListView = null;

function openCardListOverlay() {
  cardListView = 'resource';
  render(STATE);
}
function closeCardListOverlay() {
  cardListView = null;
  render(STATE);
}
function setCardListView(key) {
  cardListView = key;
  render(STATE);
}

/** Bottom nav bar order, per user request. 'resource' is also the view opened by default. null key
 * marks "ゲームに戻る" (closes the overlay instead of switching view). */
const CARD_LIST_NAV = [
  { key: 'resource', label: '資源や用語一覧' },
  { key: 'con', label: 'CON一覧' },
  { key: 'job', label: 'JOB一覧' },
  { key: 'initialResource', label: '初期資源一覧' },
  { key: 'A', label: '領地カード一覧' },
  { key: 'B', label: '天運カード一覧' },
  { key: 'C', label: '人材カード一覧' },
  { key: 'monument', label: 'モニュメントカード一覧' },
  { key: 'qst', label: 'QSTカード一覧' },
  { key: null, label: 'ゲームに戻る' },
];

/** JOB/初期資源(RESOURCE)/モニュメント(M)/QST -- each sheet's rows already ARE the individual faces to
 * show (unlike A/B/C, see collectNormalShopFaceIds's own doc), so a single flat grid per category is
 * enough; no row-split treatment needed here. columns chosen the same way DEBUG_SETUP_STEPS' own
 * columns field is (exact fit where possible, e.g. M=12->6x2, QST=8->4x2; JOB wraps 6+5 at its current
 * 11 faces, matching the debug picker's own JOB step -- see that step's own doc for the "6枚で折り返
 * す" 2026-08-22 request). CON gets its own dedicated renderCardListConCategory instead (表/裏 row
 * split, per user request), so it's not listed here. */
const CARD_LIST_FLAT_CATEGORIES = {
  job: { label: 'JOB一覧', columns: 6, isQst: false, faceIds: () => INDEX.raw.JOB.map((r) => r.ID) },
  // 24 rows -> columns:6 gives a clean 6x4 grid (2026-08-25, per user spec: "初期資源カード一覧
  // 横６枚　縦４枚の配置にして" -- was columns:8/8x3 since the RESOURCE sheet grew from 18 to 24
  // on 2026-08-22).
  initialResource: { label: '初期資源一覧', columns: 6, isQst: false, faceIds: () => INDEX.raw.RESOURCE.map((r) => r.ID) },
  monument: { label: 'モニュメントカード一覧', columns: 6, isQst: false, faceIds: () => INDEX.raw.M.map((r) => r.ID) },
  qst: { label: 'QSTカード一覧', columns: 4, isQst: true, faceIds: () => INDEX.raw.QST.map((r) => r.ID) },
};

/** Builds one read-only grid cell for カードリスト -- a fresh noInteraction card/QST visual, wired for
 * tap-to-enlarge only. Non-QST faces use attachPickableEnlarge(..., null) (no pick button, see that
 * function's own doc: pickAction:null is exactly the "read-only preview" case it already supports) --
 * but that function always builds its enlarge visual via buildCardVisual, which doesn't understand QST
 * faceIds (2026-08-22, per user report: tapping a QST card here opened a broken enlarge modal showing
 * just the raw id, e.g. "Q001A", instead of the real card -- buildCardVisual/getCardRow don't know
 * QST's sheet at all, see data-loader.getQstRow's own doc on why QST has a separate lookup). QST faces
 * get their own click handler instead, mirroring buildQstCardVisual's built-in one (used when
 * noInteraction is false elsewhere, e.g. the real in-game QST panel) but explicitly carrying
 * showLiveRanking:false through to the enlarged copy too -- otherwise the grid would hide real
 * values/swatches while tapping through to enlarge would leak them right back. */
function buildCardListCell(faceId, isQst) {
  const cardNode = isQst
    // showLiveRanking:false (2026-08-22, per user report: same leak as the テストゲーム開始 QST step's
    // own doc -- カードリスト is meant to be a neutral reference browser, not a leaderboard of the
    // currently-loaded game's real progress. See buildQstCardVisual's own doc.
    ? buildQstCardVisual(faceId, STATE, { showRankHeaders: false, showLiveRanking: false, noInteraction: true })
    // req (2026-08-22, per user report: "モニュメントカード一覧にダイス目がない") -- buildCardVisual
    // doesn't derive a monument's DICE threshold on its own (see fillCardFace's own options.req use);
    // every other caller passes req: factsForFaceId(faceId).req explicitly (e.g. buildShopSlotNode),
    // which this had omitted. Harmless for non-monument sheets, where .req is just '' (row has no DICE
    // column) and .shop-card__req collapses away via its own :empty rule.
    : buildCardVisual(faceId, { req: factsForFaceId(faceId).req, showEffect: true, allowTextFallback: false, noInteraction: true });
  const tall = cardNode.classList.contains('shop-card--tall');
  const cellClass = isQst
    ? 'owned-card-cell owned-card-cell--qst'
    : tall
      ? 'owned-card-cell owned-card-cell--tall'
      : 'owned-card-cell';
  const cell = el('div', cellClass);
  cell.appendChild(cardNode);
  if (isQst) {
    cell.addEventListener('click', () => {
      const sibling = siblingFaceId(faceId);
      const hasSiblingData = sibling && qstFaceExists(sibling);
      const visualNode = buildQstCardVisual(faceId, STATE, { noInteraction: true, showRankHeaders: true, showLiveRanking: false });
      const siblingVisualNode = hasSiblingData
        ? buildQstCardVisual(sibling, STATE, { noInteraction: true, showRankHeaders: true, showLiveRanking: false })
        : null;
      showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null, siblingVisualNode);
    });
  } else {
    attachPickableEnlarge(cell, faceId, null);
  }
  return cell;
}

function renderCardListFlatCategory(key, container) {
  const config = CARD_LIST_FLAT_CATEGORIES[key];
  const grid = el('div', 'card-list-grid');
  grid.style.gridTemplateColumns = config.isQst ? `repeat(${config.columns}, 244px)` : `repeat(${config.columns}, 122px)`;
  for (const faceId of config.faceIds()) {
    grid.appendChild(buildCardListCell(faceId, config.isQst));
  }
  container.appendChild(grid);
}

/** CON一覧, per user request ("上段左側に表 下段左側に裏と表記"): tier-A (表) faces on their own row,
 * tier-B (裏) faces on their own row below, each row labeled at its left edge. data/game.json's CON
 * sheet already lists every tier-A row before every tier-B row (confirmed 2026-08-22), so this is a
 * straightforward tier split, not a same-numbered-pairing exercise like A/B/C's own row layout. Plain
 * flex-wrap (not a fixed-column grid) so each row sizes to its cards' own real width instead of
 * guessing a column pixel size independent of whether the card ends up shop-card--tall or not. */
function renderCardListConCategory(container) {
  const tierA = [];
  const tierB = [];
  for (const row of INDEX.raw.CON) {
    const { tier } = gameStateMod.splitCardId(row.ID);
    if (tier === 'A') tierA.push(row.ID); else if (tier === 'B') tierB.push(row.ID);
  }
  const wrap = el('div', 'card-list-con-wrap');
  wrap.appendChild(buildCardListConRow('表', tierA));
  wrap.appendChild(buildCardListConRow('裏', tierB));
  container.appendChild(wrap);
}

function buildCardListConRow(label, faceIds) {
  const row = el('div', 'card-list-con-row');
  row.appendChild(el('div', 'card-list-con-row__label', label));
  const cards = el('div', 'card-list-con-row__cards');
  for (const faceId of faceIds) cards.appendChild(buildCardListCell(faceId, false));
  row.appendChild(cards);
  return row;
}

/** 領地(A)/天運(B)/人材(C)一覧, per user request: same-numbered LV1(表/A面) on top, LV2(裏/B面) on the
 * bottom, with each SHOP201-203 special-shop family (200-299 = wave 1, ROUND_MIN=2; 300-399 = wave 2,
 * round 3+ -- see setup.prepareShops/board.specialShopMinRound) pulled out to its own column at the far
 * right, one column per family (e.g. A201/A202 each get their own wave-1 column, A301 its own wave-2
 * column), labeled "2ラウンドから登場"/"3ラウンドから登場" above each (2026-08-25, per user request:
 * "2R　3Rから出てくるカードも表示して可能な限り　今と同じ列で" -- this replaces the old single-008-pair
 * column from before the SHOP201-203 rework, which silently showed nothing for any of these ids since
 * none of them is literally numbered "008" any more). Sheet's NAME column confirms the A/B/C=領地/天運/
 * 人材 mapping (see plan file), not otherwise recorded anywhere in code. */
function renderCardListAbcCategory(sheet, container) {
  const tierA = [];
  const tierB = [];
  const specialFamilies = new Map(); // physicalId -> {num, a, b}
  for (const row of INDEX.raw[sheet]) {
    const { physicalId, tier } = gameStateMod.splitCardId(row.ID);
    const num = Number(physicalId.slice(1));
    if (num <= 7) {
      if (tier === 'A') tierA.push(row.ID); else if (tier === 'B') tierB.push(row.ID);
      continue;
    }
    if (!specialFamilies.has(physicalId)) specialFamilies.set(physicalId, { num, a: null, b: null });
    const fam = specialFamilies.get(physicalId);
    if (tier === 'A') fam.a = row.ID; else if (tier === 'B') fam.b = row.ID;
  }
  const wrap = el('div', 'card-list-abc-wrap');

  const mainGrid = el('div', 'card-list-grid');
  mainGrid.style.gridTemplateColumns = `repeat(${tierA.length}, 122px)`;
  for (const faceId of tierA) mainGrid.appendChild(buildCardListCell(faceId, false));
  for (const faceId of tierB) mainGrid.appendChild(buildCardListCell(faceId, false));
  wrap.appendChild(mainGrid);

  // Grouped in their own row (2026-08-25, per user request: "孤児院の支配と訓練場の支配と元老院の支配の
  // 間が空きすぎなので詰めて") so a tighter gap can apply between the special columns themselves without
  // touching the wider gap that separates them from mainGrid -- see .card-list-abc-special-group in
  // style.css.
  const specialGroup = el('div', 'card-list-abc-special-group');
  const sortedFamilies = [...specialFamilies.values()].sort((x, y) => x.num - y.num);
  for (const fam of sortedFamilies) {
    // "2Rから登場"/"3Rから登場" (2026-08-25, per user request, shortened from "2ラウンドから登場"/
    // "3ラウンドから登場").
    const label = fam.num < 300 ? '2Rから登場' : '3Rから登場';
    const specialCol = el('div', 'card-list-abc-special');
    specialCol.appendChild(el('div', 'card-list-abc-special__label', label));
    if (fam.a) specialCol.appendChild(buildCardListCell(fam.a, false));
    if (fam.b) specialCol.appendChild(buildCardListCell(fam.b, false));
    specialGroup.appendChild(specialCol);
  }
  if (sortedFamilies.length > 0) wrap.appendChild(specialGroup);

  container.appendChild(wrap);

  // カード一覧とナビボタンの間にINSTシートの説明文を表示 (2026-08-22, per user request) -- INDEX.raw.INST
  // has one row per sheet keyed "Aカード"/"Bカード"/"Cカード" for exactly this purpose (see
  // instDescriptionText's own doc). Empty for now (no description column filled in yet) -- the element
  // itself just collapses via :empty, same convention as .shop-card__req etc. elsewhere.
  container.appendChild(el('div', 'card-list-abc-inst', instDescriptionText(`${sheet}カード`)));
}

/** Looks up one INDEX.raw.INST row by its ID (e.g. "Aカード") and joins every non-ID, non-empty field
 * into display text -- same generic "don't assume a column name" approach as
 * renderCardListResourceCategory's own INST loop, since the sheet currently only has an ID column
 * populated; whatever description column the user adds later is picked up automatically. '' (renders
 * nothing, collapses via :empty) if the row doesn't exist or has no other fields yet. */
function instDescriptionText(instId) {
  const row = (INDEX.raw.INST || []).find((r) => r.ID === instId);
  if (!row) return '';
  return Object.entries(row)
    .filter(([column, value]) => column !== 'ID' && value !== '' && value !== undefined && value !== null)
    .map(([, value]) => String(value))
    .join('\n');
}

/** Basic resource/term quick-reference, names per user request (2026-08-22). Each id matches an
 * INDEX.raw.INST row's own ID exactly (VP/K/A/B/C/Z/BZ/D/wD/TAP), so instDescriptionText(code) looks
 * up its detail text directly, no id-mapping needed (unlike A/B/C's own "Aカード"-suffixed rows). */
const CARD_LIST_RESOURCE_GLOSSARY = [
  { code: 'VP', name: '名声' },
  { code: 'K', name: '食料' },
  { code: 'A', name: '権力' },
  { code: 'B', name: '信心' },
  { code: 'C', name: '金貨' },
  { code: 'Z', name: 'コネ' },
  { code: 'BZ', name: '口利き' },
  { code: 'D', name: '行動力' },
  { code: 'wD', name: '恩寵' },
  { code: 'TAP', name: 'タップ' },
];

/** VP (2026-08-22, per user request: "名声のアイコンはVP") -- plain "VP" text badge, matching how VP
 * is shown everywhere else in the app (never a colored dot, see renderResourceBadge's own doc: "VPは
 * 常にプレーンテキスト"). D (2026-08-22, per user request + a circled screenshot of Alice's actual
 * dice in the standings panel: "行動力のアイコンは色ダイスのピンク（ALICE）のダイスの1の目") -- reuses
 * renderDie() directly (the real player-dice component, 22x22px .die--PINK with a plain digit "1"),
 * not the ⚀-⚅ die-face glyph vocabulary used elsewhere here -- the screenshot made clear the user meant
 * the actual round colored die TOKEN shown next to a player's name, not the monument/TAP-icon glyph
 * style. Already sized to match this grid's other 22px icons (.action-dot), no extra scoping needed.
 * TAP reuses TAP_COST_ICON (⤵️), the same marker every TAP ability already shows. */
function cardListResourceIcon(code) {
  if (code === 'wD') return actionEmoji('🎲');
  if (code === 'TAP') return actionEmoji(TAP_COST_ICON);
  if (code === 'VP') return el('span', 'card-list-term-cell__vp-icon', 'VP');
  if (code === 'D') return renderDie({ color: 'PINK', value: 1 });
  return actionDot(code);
}

/** 資源や用語一覧 (2026-08-22, per user request: "横長ではなくほかのカードのように表示 タップすると
 * 詳細を表示") -- each term is its own square tile (not a flat icon+text row), tap opens the same
 * plain-text detail modal AREA tiles use (see showAreaEnlargeModal), showing INST's description for
 * that term via showCardListTermModal below. */
function renderCardListResourceCategory(container) {
  const grid = el('div', 'card-list-grid');
  grid.style.gridTemplateColumns = `repeat(5, 122px)`;
  for (const { code, name } of CARD_LIST_RESOURCE_GLOSSARY) {
    grid.appendChild(buildCardListTermCell(code, name));
  }
  container.appendChild(grid);
}

function buildCardListTermCell(code, name) {
  const cell = el('div', 'card-list-term-cell');
  const icon = cardListResourceIcon(code);
  if (icon) cell.appendChild(icon);
  cell.appendChild(el('div', 'card-list-term-cell__name', name || code));
  if (name) cell.appendChild(el('div', 'card-list-term-cell__code', `（${code}）`));
  cell.addEventListener('click', () => showCardListTermModal(name ? `${name}（${code}）` : code, code));
  return cell;
}

/** Plain-text detail popup for one 資源や用語一覧 tile -- same #card-inst-overlay chrome/renderInstBody
 * showAreaEnlargeModal uses for AREA tiles (title + INST text, no card visual/flip/pick button), just
 * without that function's multi-tile tier-chain row (a single term has no such chain).
 * .card-inst-modal--term (2026-08-22, per user request: "文字の大きさを２倍にして　画面の横幅を4倍に")
 * -- widens the modal to 4x its plain-text base (280px -> 1120px, still capped by .card-inst-modal's
 * own max-width:calc(100vw-32px) safety net on narrow screens) and doubles .card-inst-modal__body's
 * font-size, scoped to this popup only -- showCardEnlargeModal/showAreaEnlargeModal both remove this
 * class themselves so a leftover --term doesn't widen/enlarge an unrelated card/AREA popup afterward. */
function showCardListTermModal(title, instId) {
  const overlay = document.getElementById('card-inst-overlay');
  const modal = overlay.querySelector('.card-inst-modal');
  const visualContainer = overlay.querySelector('.card-inst-modal__visual');
  const flipBtn = overlay.querySelector('.card-inst-modal__flip-button');
  const pickBtn = overlay.querySelector('.card-inst-modal__pick-button');

  overlay.hidden = false;
  modal.classList.remove('card-inst-modal--wide', 'card-inst-modal--area-wide');
  modal.classList.add('card-inst-modal--term');
  flipBtn.hidden = true;
  pickBtn.hidden = true;
  visualContainer.innerHTML = '';
  visualContainer.style.width = '';
  visualContainer.style.height = '';

  overlay.querySelector('.card-inst-modal__title').textContent = title;
  renderInstBody(overlay.querySelector('.card-inst-modal__body'), instDescriptionText(instId));
}

/** Renders #card-list-overlay -- hidden entirely while cardListView is null. Dispatches to the flat
 * grid / A-B-C / resource-glossary renderers above based on the current view, then rebuilds the
 * persistent bottom nav (CARD_LIST_NAV) every time so its --active highlight always matches. */
function renderCardListOverlay() {
  const overlay = document.getElementById('card-list-overlay');
  if (!cardListView) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;

  const body = document.getElementById('card-list-body');
  body.innerHTML = '';
  if (cardListView === 'resource') {
    document.getElementById('card-list-title').textContent = '資源や用語一覧';
    renderCardListResourceCategory(body);
  } else if (cardListView === 'A' || cardListView === 'B' || cardListView === 'C') {
    document.getElementById('card-list-title').textContent = CARD_LIST_NAV.find((n) => n.key === cardListView).label;
    renderCardListAbcCategory(cardListView, body);
  } else if (cardListView === 'con') {
    document.getElementById('card-list-title').textContent = 'CON一覧';
    renderCardListConCategory(body);
  } else {
    const config = CARD_LIST_FLAT_CATEGORIES[cardListView];
    document.getElementById('card-list-title').textContent = config.label;
    renderCardListFlatCategory(cardListView, body);
  }

  const nav = document.getElementById('card-list-nav');
  nav.innerHTML = '';
  for (const entry of CARD_LIST_NAV) {
    const btn = el('button', 'card-list-nav__button', entry.label);
    btn.type = 'button';
    if (entry.key === cardListView) btn.classList.add('card-list-nav__button--active');
    btn.addEventListener('click', () => (entry.key === null ? closeCardListOverlay() : setCardListView(entry.key)));
    nav.appendChild(btn);
  }
}

/** Updates the debug panel: toggle button label, nav button disabled states, current-position readout,
 * and the clickable history list (spec items 3-4 & 10). Hidden entirely while debugMode is off (spec
 * item 14). Called from render() like every other render*() helper, so it always reflects whatever
 * STATE/historyCursor currently are (including right after a jump, since jumpToHistoryIndex ends with
 * its own render(STATE) call). */
function renderDebugPanel(state) {
  const toggleBtn = document.getElementById('debug-mode-toggle');
  toggleBtn.textContent = `デバッグモード: ${debugMode ? 'ON' : 'OFF'}`;
  toggleBtn.classList.toggle('debug-panel__toggle--on', debugMode);
  const controls = document.getElementById('debug-history-controls');
  controls.hidden = !debugMode;
  if (!debugMode) return;

  document.getElementById('debug-turn-back').disabled = historyCursor <= 0;
  document.getElementById('debug-turn-forward').disabled = historyCursor >= turnHistory.length - 1;
  const currentRound = historyCursor >= 0 ? turnHistory[historyCursor].round : null;
  document.getElementById('debug-round-back').disabled = currentRound === null || !turnHistory.some((e) => e.round === currentRound - 1);
  document.getElementById('debug-round-forward').disabled = currentRound === null || !turnHistory.some((e) => e.round === currentRound + 1);

  const positionEl = document.getElementById('debug-history-position');
  if (historyCursor < 0) {
    positionEl.textContent = '(履歴なし)';
  } else {
    const entry = turnHistory[historyCursor];
    const activePlayer = entry.playerId ? state.players.find((p) => p.id === entry.playerId) : null;
    positionEl.textContent = `Round ${entry.round} / Turn ${historyCursor + 1} / Active Player ${activePlayer ? activePlayer.name : '-'}`;
  }

  const listEl = document.getElementById('debug-history-list');
  listEl.innerHTML = '';
  let currentItem = null;
  turnHistory.forEach((entry, i) => {
    const activePlayer = entry.playerId ? state.players.find((p) => p.id === entry.playerId) : null;
    const item = el('button', 'debug-history-list__item', `R${entry.round} / ${activePlayer ? activePlayer.name : '-'} / Turn${i + 1}`);
    item.type = 'button';
    const isCurrent = i === historyCursor;
    item.classList.toggle('debug-history-list__item--current', isCurrent);
    if (isCurrent) currentItem = item;
    item.addEventListener('click', () => jumpToHistoryIndex(i));
    listEl.appendChild(item);
  });
  // Keeps the current entry actually visible once there are enough saves to overflow the list's own
  // max-height/scroll (2026-08-1X, per user report: "デバッグモードのセーブ数が多いと途中から表示され
  // ない" -- the list itself was never truncated, entries just scrolled out of the fixed-height,
  // scroll-but-never-auto-scrolled box as new ones piled up below/after whatever the user last happened
  // to have scrolled to, reading as "stopped showing" once there were enough of them to need scrolling
  // at all). listEl.innerHTML='' above destroys any previous scroll position along with the old nodes,
  // so this must re-establish it every render, not just once.
  //
  // Deliberately NOT currentItem.scrollIntoView() (found via headless testing, 2026-08-1X): that scrolls
  // every scrollable ancestor as needed, including the whole page/document itself since #debug-panel
  // sits at the very bottom of it -- every render (e.g. just switching a player's role up in the header)
  // was yanking the entire viewport down to the debug panel at the page's bottom, shoving #ai-pacing-
  // select and everything else above it off-screen. Comparing/adjusting listEl.scrollTop directly instead
  // touches only this one scroll container, exactly like 'nearest' was meant to (a no-op once the current
  // item is already within listEl's own visible range).
  if (currentItem) {
    const listRect = listEl.getBoundingClientRect();
    const itemRect = currentItem.getBoundingClientRect();
    if (itemRect.top < listRect.top) listEl.scrollTop -= (listRect.top - itemRect.top);
    else if (itemRect.bottom > listRect.bottom) listEl.scrollTop += (itemRect.bottom - listRect.bottom);
  }
}
// Whether the active player has already resolved this turn's die placement (2026-08-01, per user
// feedback: "建築後、ターンエンド前にTAPのフリーアクションが可能です...未使用のTAPアクションが残って
// いる場合TAPアクションをしてから（あるいはせずに）ターンエンドボタンを押してターン終了になります" --
// applies to *every* placement, not just BUILD-triggering ones, e.g. "城以外でも同じ"). Previously
// placeSelectedDie/renderBuildChoiceModal called attemptAdvanceTurn immediately once a placement (or
// its resulting BUILD) resolved, which left no window for free actions/bare TAP abilities to actually
// be usable afterward (their own gating already required "is it currently my turn", but by the time
// they could click anything, the placement's auto-advance had already moved on to the next player).
// Now placement handlers just set this flag; ending the turn is a separate, explicit "ターン終了"
// button click (see renderTurnEndButton) that only appears once this is true. Reset whenever a new
// player's TURN begins (see render()'s
// lastTurnPlayerId transition, the same "new turn started" signal the undo checkpoint uses) and by
// handleUndoClick.
let turnActionTaken = false;
// Set by advanceTurnIfPossible the instant a human's real END_TURN succeeds; consumed and cleared by
// render()'s checkpoint block (2026-08-11, per user report: "AIがダイスを使い切り　人間がまだ複数ダイスを
// 持っているとき　ダイスを置いてターン終了ボタンを押しても　セーブポイントが作られません　そのためターン
// 開始時に戻るを押すと　何手も戻ってしまいます"). Needed because that block's own trigger --
// `next.playerId !== lastTurnPlayerId` -- only fires when the ACTIVE PLAYER changes, which silently
// merges every turn after the first whenever the same player takes several turns in a row with nobody
// else's turn in between (exactly what happens once every other player has run out of dice for the
// round: getNextTurn keeps naming the same one player, so lastTurnPlayerId never stops matching). Without
// this flag those later turns got no checkpoint of their own at all, so "ターン開始時に戻る" jumped back
// to whatever much earlier turn last happened to change lastTurnPlayerId. This flag instead tracks "a
// real END_TURN just happened" directly, independent of who's next -- true "fresh turn" detection rather
// than a same-vs-different-player proxy for it. AI turns don't need to set this: AI's own END_TURN runs
// through simulator.applyInPlace, not advanceTurnIfPossible (see driveOneAiStep's own comment), and the
// only player who ever presses "ターン開始時に戻る" is the human, so only the human path needs to feed it.
let turnJustEnded = false;

// ---------------------------------------------------------------------------
// Card/area facts, derived live from INDEX (2026-07-30: replaces the former hand-transcribed
// CARD_FACTS/QST_FACTS/AREA_FACTS/SHOP_REQ tables now that the real engine + real data/game.json are
// loaded -- every card the engine can produce renders correctly, not just the ~30 IDs that used to be
// manually copied in here).
// ---------------------------------------------------------------------------

/** Fills container (.shop-card__req) with a monument's own DICE threshold (e.g. ">=12") as plain text,
 * 2 lines: "ダイス目" then "{n}以上", the number itself in a large/bold span (.shop-card__req-number)
 * (2026-08-25, per user spec: "⚅⚅から ダイス目 12以上 にすべて変更 数字は大きく濃く" -- replaces the
 * previous die-face-glyph rendering (⚅⚅ for ">=12" etc, 2026-08-16's diceThresholdFaces/dieFace-based
 * version) across every monument, not just the >=12 case the user's own example used). Clears container
 * first so an empty/unrecognized diceString correctly leaves it empty, matching .shop-card__req:empty's
 * hide-when-blank rule. */
function renderDiceThresholdReq(container, diceString) {
  container.innerHTML = '';
  const match = /^>=(\d+)$/.exec(diceString || '');
  if (!match) return;
  container.appendChild(el('div', null, 'ダイス目'));
  const line2 = el('div');
  line2.appendChild(el('span', 'shop-card__req-number', match[1]));
  line2.appendChild(document.createTextNode('以上'));
  container.appendChild(line2);
}

/** {cost, vp, req, effects:[{text,source}], inst} for any A/B/C/CON/JOB/M/RESOURCE face id, read
 * straight from its data/game.json row (ONCE/TAP/PASSIVE/TURNEND columns become effects, in that
 * order; M's DICE column, e.g. ">=12", becomes req the same way the old hand-transcribed table did).
 * Returns {} for an unknown id (mirrors the old CARD_FACTS[faceId] || {} fallback). */
function factsForFaceId(faceId) {
  let row;
  try {
    row = dataLoaderMod.getCardRow(INDEX, faceId);
  } catch (e) {
    return {};
  }
  const effects = [];
  if (row.ONCE) effects.push({ text: row.ONCE, source: 'ONCE' });
  if (row.TAP) effects.push({ text: row.TAP, source: 'TAP' });
  if (row.PASSIVE) effects.push({ text: row.PASSIVE, source: 'PASSIVE' });
  if (row.TURNEND) effects.push({ text: row.TURNEND, source: 'TURNEND' });
  return {
    cost: row.COST || '',
    vp: row.VP || 0,
    req: row.DICE || '',
    effects,
    inst: row.INST || '',
    // '' unless the user has actually filled in a real thematic title (NAME still equal to the card's
    // own ID means "not customized yet", same "===faceId means unset" convention areaOwnershipLabel
    // already used before this -- 2026-08-05, generalized to every card type, not just the A-series
    // ONCE=MAP-assignment shape, per user feedback: "AC系のカード NAMEをカード上部に反映させてくださ
    // い" -- C-series cards want this too, and they don't have that DSL shape at all).
    name: row.NAME && row.NAME !== row.ID ? row.NAME : '',
    // Only CON/RESOURCE rows ever have this (confirmed 2026-07-30, per user feedback -- relevant when
    // choosing initial RESOURCE cards / previewing CON, since START_ORDER determines turn order).
    // 0 is a real, meaningful value (lowest = goes first) so this must stay null rather than falsy
    // when absent -- fillCardFace checks for null explicitly, not truthiness.
    startOrder: row.START_ORDER === '' ? null : row.START_ORDER,
    // CON sheet's own hand-authored アイコン column (2026-08-15, per user request -- see fillCardFace's
    // own doc). '' for every other sheet, which has no such column at all.
    iconText: row['アイコン'] || '',
    // CON's own raw ONCE text (2026-08-16, per user request: "CONカードIDが書かれている部分を消して
    // その場所に得られる初期資源を書いて" -- see fillCardFace's own doc, which passes this through
    // buildActionIcons to reuse the exact same ADD(...)/ADD(wD)-aware icon rendering every other card's
    // ONCE/TAP/PASSIVE already uses, rather than a narrower one-off resource-list parser that would miss
    // shapes like CON001B's ADD(4wD) -- COST-column parsing (renderCostBadges) only ever handles
    // K/A/B/C/Z/VP/BZ, never dice, so that path isn't a fit here).
    once: row.ONCE || '',
  };
}

/** Whether faceId exists in the card data at all (used for the click-to-flip sibling check, replacing
 * the old `CARD_FACTS[sibling]` truthiness check). */
function cardFaceExists(faceId) {
  try {
    dataLoaderMod.getCardRow(INDEX, faceId);
    return true;
  } catch (e) {
    return false;
  }
}

/** QST sheet counterpart of factsForFaceId -- {goal, rewards:[REWARD1,REWARD2,REWARD3], inst}.
 * 2026-08-09: back to 3 separate REWARD columns (rank-based rewards, one distinct tier each -- see
 * src/qst.js's own doc), replacing 2026-08-06's REWARD2-3 shared-field merge. */
function factsForQstFaceId(faceId) {
  let row;
  try {
    row = dataLoaderMod.getQstRow(INDEX, faceId);
  } catch (e) {
    return { goal: '', rewards: [] };
  }
  return { goal: row.GOAL || '', rewards: [row.REWARD1, row.REWARD2, row.REWARD3], inst: row.INST || '' };
}

/** Whether faceId exists in the QST data at all (sibling-flip check, mirrors cardFaceExists). */
function qstFaceExists(faceId) {
  try {
    dataLoaderMod.getQstRow(INDEX, faceId);
    return true;
  } catch (e) {
    return false;
  }
}

/** SHOP sheet's DICE_MIN/DICE_MAX for a shop slot id, formatted the same way the old hand-transcribed
 * SHOP_REQ table was ("目 {min}-{max}", or just "目 {min}" when min===max) -- '' for monument slots
 * (SHOP001-006), which have no DICE_MIN/MAX at all (their req is per-card instead, see factsForFaceId
 * above / buildShopSlotNode below). */
function shopReqForSlotId(slotId) {
  const row = dataLoaderMod.getShopRow(INDEX, slotId);
  if (row.DICE_MIN === '' || row.DICE_MIN === undefined || row.DICE_MIN === null) return '';
  return row.DICE_MIN === row.DICE_MAX ? `目 ${row.DICE_MIN}` : `目 ${row.DICE_MIN}-${row.DICE_MAX}`;
}

/** Board tile layout order (confirmed 2026-07-29/30 -- a display decision, not game data, so this
 * stays a small local constant rather than something derived from INDEX). See renderBoard. */
const MAP_ORDER = ['MAP001', 'MAP002', 'MAP003', 'MAP004', 'MAP005', 'MAP006', 'MAP007', 'MAP008', 'MAP009', 'MAP010'];

/** faceId/areaId/qstId -> INST text, across whichever sheet actually has one (CARD/QST/AREA -- see
 * showCardEnlargeModal). Replaces the old `(CARD_FACTS[id] || QST_FACTS[id] || {}).inst` lookup now that
 * there's no single hardcoded table covering every id. */
function instForId(id) {
  if (/^Q\d/.test(id)) return factsForQstFaceId(id).inst;
  if (/^AREA\d/.test(id)) {
    try {
      return dataLoaderMod.getAreaRow(INDEX, id).INST || '';
    } catch (e) {
      return '';
    }
  }
  return factsForFaceId(id).inst;
}

// ---------------------------------------------------------------------------
// Icon-based action display (confirmed 2026-07-29, more DSL patterns to
// follow). ACTION_ICON_BUILDERS maps a raw DSL string (as it appears in a
// card/area's ONCE/TAP/PASSIVE/TURNEND/ACTION field) to a builder that
// returns an icon-based DOM fragment; buildActionIcons() falls back to null
// (caller shows the raw text) for anything not yet mapped, so unmapped DSL
// never breaks silently.
// ---------------------------------------------------------------------------

function actionDot(resource) {
  const dot = document.createElement('span');
  dot.className = 'action-dot';
  dot.dataset.resource = resource;
  return dot;
}
function actionEmoji(char) {
  return el('span', 'action-emoji', char);
}
function actionArrow() {
  return el('span', 'action-arrow', '→');
}
/** ▶ (2026-07-30, per user feedback): "→" means resource conversion (CHANGE) specifically -- an
 * ON(event, effect) trigger/consequence pair (e.g. ON(BUILD(...),ADD(...))) uses this instead, so the
 * two meanings aren't visually conflated. Styled like .action-arrow (small text glyph, no emoji
 * variation selector) rather than a full-size ▶️ emoji -- the user's own example used the emoji form,
 * but that was too wide to keep JOB004A/007A on one line (confirmed 2026-07-30: card content is only
 * ~100px), so this trades a little visual weight for actually fitting. See actionTriggerDown for the
 * stacked (2-row) equivalent, which doesn't have this space constraint. */
function actionTrigger() {
  return el('span', 'action-arrow', '▶');
}
/** 🔽 (2026-07-30, per user feedback): same meaning as actionTrigger() above, for when the
 * condition/trigger and its consequence are stacked on 2 rows instead of 1 (e.g. when a single row
 * would be too wide for the card) -- kept at full emoji weight since a stacked row isn't as
 * space-constrained. */
function actionTriggerDown() {
  return actionEmoji('🔽');
}
function actionCount(n) {
  return el('span', 'action-count', String(n));
}
function actionSuffix(text) {
  return el('span', 'action-suffix', text);
}
const DIE_FACES = { 1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅' };
/** A die-face glyph (⚀-⚅) instead of a plain digit, for anywhere a die's VALUE is shown (as opposed
 * to a resource count) -- confirmed 2026-07-29, sized larger for visibility. Falls back to a plain
 * digit for anything out of 1-6 (shouldn't happen for a real die value). */
function dieFace(n) {
  const face = DIE_FACES[Number(n)];
  return face ? el('span', 'die-face', face) : actionCount(n);
}
function actionRow(children) {
  const row = el('div', 'action-icons');
  children.forEach((c) => row.appendChild(c));
  return row;
}

const ACTION_ICON_BUILDERS = {
  'CHANGE(K,A,ALL)': () => actionRow([actionDot('K'), actionArrow(), actionDot('A'), actionSuffix('ALL')]),
  'CHANGE(K,B,ALL)': () => actionRow([actionDot('K'), actionArrow(), actionDot('B'), actionSuffix('ALL')]),
  'CHANGE(K,C,ALL)': () => actionRow([actionDot('K'), actionArrow(), actionDot('C'), actionSuffix('ALL')]),
  // CHANGE(K,Z,2)/(K,A,2)/(K,B,2)/(K,C,2) used to live here (the count-argument form) -- removed
  // 2026-08-0X, no longer reachable: C001-3's TAP was changed to the quantity-prefixed CHANGE(2K,2A)
  // form (per user request), which buildChangeQuantityIcon now handles generically.
  // 訓練場 (AREA007, the only user of this exact DSL) -- labelled 追加色ダイス, not 色D (2026-08-11, per
  // user request). Any die gained mid-game is by definition one beyond the starting 3, so this wording
  // matches Q001B's own "追加色ダイス" goal (executor.js's EXTRA_D_PLUS_ABC_COUNT) and reads as "this is
  // how you get one". Deliberately scoped to this entry: ADD(D) elsewhere keeps saying 色D (see
  // buildAddResourceIcon), since those cards are about the die itself, not about growing past the start.
  'CHANGE((A,B,C),D)': () => actionRow([actionDot('A'), actionDot('B'), actionDot('C'), actionArrow(), actionSuffix('追加色ダイス')]),
  // 訓練場LV1 (AREA007B)'s own ACTION -- same 追加色ダイス wording as the entry above, just a single K
  // dot on the pay side instead of an A/B/C group (2026-08-25, per user request: "訓練場LV1のアイコン
  // K→追加色ダイス Kはアイコンに直して" -- previously unhandled, falling through to the raw DSL text
  // "CHANGE(K,D)" fallback).
  'CHANGE(K,D)': () => actionRow([actionDot('K'), actionArrow(), actionSuffix('追加色ダイス')]),
  // CHANGE(4K,VP) used to live here as an exact-match entry -- removed 2026-08-05, no longer reachable
  // (no card/AREA in the current data uses that literal count) and superseded by the general
  // buildChangeToVpIcon below, added per user feedback covering AREA010A/C's own K->VP counts.
  // JOB003's TAP (2026-08-0X, per user request -- previously unmatched by buildSetDiceAnyIcon, which
  // only matches bare SET_DICE_ANY() alone, not this compound with GRANT_PLACE_ANYWHERE chained after
  // it, so JOB003 was showing no icon at all): "ダイス目を変える" reads more directly than reusing
  // buildSetDiceAnyIcon's "🎲自由" wording, since this ability's real effect is the die's *value*
  // changing, not really "free placement" (the GRANT_PLACE_ANYWHERE half isn't called out separately
  // per the user's request -- just this one label for the whole TAP).
  // JOB003/道化 (2026-08-19): SET_DICE_ANY no longer appears anywhere in the data -- both of this old
  // TAP text's exact-match entries removed, replaced by a single WILDCARD_DICE() entry further below
  // (see board.hasWildcardDice's own doc).
  // 2026-08-18, per user request ("道化の能力をTAPではなく何回でも使える能力にしたい") -- JOB003's TAP
  // grew a trailing UNTAP() (see board.useBareTapAbility's own doc: a self-untapping TAP field never
  // actually ends up tapped, so it's usable any number of times per turn, no cost). Same label as the
  // 2026-08-0X, per user request ("⤴️を消してそこに毎タームといれる"): bare UNTAP() only ever appears
  // as a TURNEND effect (confirmed against data/game.json -- JOB004/005/007, all "usable once per turn"
  // reactive/direct TAP abilities), so "毎ターン" (plain text) reads more clearly there than the ⤴️
  // glyph alone did.
  'UNTAP()': () => actionRow([actionSuffix('毎ターン')]),
  // B004A/B202A/B005A (renamed from B005A/B006A/B007A by the 2026-08-24 SHOP201-203 rework's card
  // renumbering; 始まりの兆し/終わりの兆し/革命の兆し, 2026-08-21, per user spec: "⤵〇→🔨 / ⚀"、
  // "⤵〇→🔨 / ⚅"、"⤵〇→🔨U" -- ⤵ is buildEffectRow's own auto TAP-cost prefix, not repeated here; 〇 is
  // the bare K-cost dot, no count shown, since the DSL's own PAY(K) has no explicit number either. The
  // hammer itself is ⚒️, not the user's own literal 🔨 -- per their follow-up, matched to 王宮(AREA008)'s
  // own BUILD() icon (buildBuildIcon's actionEmoji('⚒️')) for visual consistency; 🔨 was only what their
  // PC could render while typing the spec, not the intended glyph. "ダイス目" label text removed per a
  // later follow-up -- the bare dieFace glyph alone (now 1.6x larger, see .action-icons .die-face in
  // style.css) is enough on its own). One-off exact-match entries rather than generalizing buildBuildIcon,
  // same reasoning as before (PAY(...) prefixes aren't a handled shape there -- see board.
  // resolveProgramOrBuild's own doc on why the TAP text isn't just "BUILD(...)" alone). B004A/B202A get a
  // 2nd row for the required die value -- B005A/UPGRADE has no die-value threshold, so it stays a single
  // row ending in "U".
  'PAY(K);BUILD((A,B,C,M),1)': () => {
    const stack = el('div', 'action-icons-stack');
    stack.appendChild(actionRow([actionDot('K'), actionArrow(), actionEmoji('⚒️')]));
    stack.appendChild(actionRow([dieFace(1)]));
    return stack;
  },
  'PAY(K);BUILD((A,B,C,M),6)': () => {
    const stack = el('div', 'action-icons-stack');
    stack.appendChild(actionRow([actionDot('K'), actionArrow(), actionEmoji('⚒️')]));
    stack.appendChild(actionRow([dieFace(6)]));
    return stack;
  },
  'PAY(K);BUILD(U)': () => actionRow([actionDot('K'), actionArrow(), actionEmoji('⚒️'), actionSuffix('U')]),
  // REPLACE_ADD(D,wD) (confirmed 2026-07-29): a passive that swaps "gain your own die" for "gain a
  // white die" instead -- shown as the source resource turning into the replacement.
  'REPLACE_ADD(D,wD)': () => actionRow([actionSuffix('色D'), actionArrow(), actionEmoji('🎲')]),
  // JOB003/道化 (2026-08-19, replacing its old SET_DICE_ANY-based TAP entirely -- see this object's own
  // comment near the removed entries above): all owned dice become ☆, auto-placed by the engine.
  // Icon updated 2026-08-20 per user spec: "☆ダイス" / "（オールマイティ）" on two lines, ☆ at 2x size;
  // parens dropped 2026-08-21 per user follow-up ("（オールマイティ）を オールマイティ に").
  // No leading "⚡🎲" here (an earlier version of this icon had one) -- JOB003's own ONCE=ADD(wD) already
  // renders its own "⚡🎲" row directly above this PASSIVE one (see buildAddWdIcon), so repeating it here
  // just duplicated the same glyph pair twice in a row, per the user's own follow-up report.
  'WILDCARD_DICE()': () => {
    const star = actionEmoji('☆');
    star.classList.add('action-emoji--large');
    const stack = el('div', 'action-icons-stack');
    stack.appendChild(actionRow([star, actionSuffix('ダイス')]));
    stack.appendChild(actionRow([actionSuffix('オールマイティ')]));
    return stack;
  },
};

/** Confirmed 2026-07-29: ⤵️ marks a TAP-column effect (tapping it is the cost to trigger it). */
const TAP_COST_ICON = '⤵️';

/** Raw text between BUILD( and its own matching close paren (tracking nested parens, e.g. the
 * "(A,B,C,M)" category list), or null if actionText has no BUILD(...) at all. Shared by
 * extractBuildCategories/extractBuildValue below so both stay in lockstep on how nesting is tracked. */
function buildInnerText(actionText) {
  const startIdx = actionText.indexOf('BUILD(');
  if (startIdx === -1) return null;
  let i = startIdx + 'BUILD('.length;
  let depth = 1;
  let inner = '';
  while (i < actionText.length && depth > 0) {
    const ch = actionText[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth -= 1; if (depth === 0) break; }
    inner += ch;
    i += 1;
  }
  return inner;
}

/**
 * BUILD is always ⚒️ (confirmed 2026-07-29), with any category letters (A/B/C/M/U) appended --
 * e.g. BUILD() -> ⚒️, BUILD(U) -> ⚒️U, BUILD((A,B,C,M),1) -> ⚒️ABCM. Handled generically (not a
 * per-string table entry) so every BUILD(...) variant gets an icon automatically, including ones
 * not explicitly listed yet.
 */
function extractBuildCategories(actionText) {
  const inner = buildInnerText(actionText);
  if (inner === null) return null;
  return (inner.match(/[ABCMU]/g) || []).join('');
}

/**
 * The numeric buildValue argument -- BUILD(...)'s own last top-level-comma-separated segment, if it's
 * a plain number -- e.g. BUILD((A,B,C,M),1) -> 1, BUILD(M,12) -> 12, BUILD()/BUILD(U) -> null (no such
 * argument). 2026-08-06, per user feedback on B005A/B005B/B006A/B006B's own icons needing the die
 * value(s) required to trigger them ("B005A/B005B...⚀...B006A...⚅...B006B...⚅⚅"). Splits on commas at
 * paren-depth 0 only, so the "(A,B,C,M)" category list's own internal commas don't get mistaken for the
 * separator before this trailing value.
 */
function extractBuildValue(actionText) {
  const inner = buildInnerText(actionText);
  if (inner === null) return null;
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const last = parts[parts.length - 1].trim();
  return /^\d+$/.test(last) ? Number(last) : null;
}

/**
 * BUILD(...);ADD(BZ) (confirmed 2026-07-29): BZ is a discount resource, not a normal resource dot,
 * so it's shown as plain text "軽減Z" on its own line under the BUILD icon rather than a dot. Returns
 * an .action-icons-stack (a column of rows) instead of a single row when this trailing ADD(BZ) is
 * present; buildEffectRow() knows to keep the two rows stacked instead of flattening them together.
 *
 * A general trailing ADD(...) list -- any mix of real resources and/or BZ, e.g. AREA009B's bare
 * "BUILD();ADD(2K)" or AREA009C's "BUILD();ADD(2K,BZ)" (2026-08-05, per user feedback with a worked
 * example: "AREA009C ハンマーアイコン 雷アイコン 2K BZ") -- is handled separately from the bare-BZ case
 * above: real resources render as normal dots (⚡ prefix, same "gain" convention as buildAddResourceIcon
 * elsewhere), and a bare BZ item renders as plain "BZ" text (not "軽減Z" -- that label is specifically
 * for the "this BZ is a discount token generated by a card TAP to spend on a build" framing, but here
 * BZ is just an ordinary reward for placing here, matching the user's own "2K BZ" wording literally).
 */
function buildBuildIcon(actionText) {
  if (!actionText || !actionText.startsWith('BUILD(')) return null;
  const categories = extractBuildCategories(actionText);
  const buildValue = extractBuildValue(actionText);
  const children = [actionEmoji('⚒️')];
  // "ダイス目N" with N large/dark (2026-08-25, per user request: "ABCM1⃣を ダイス目　1に...ABCM4⃣も
  // ダイス目4に...M6⃣6⃣も ダイス目9に...すべて数字は大きく濃く" -- replaces the old category-letters
  // (A/B/C/M) + N white-die-icons display, same .action-count--large class/convention as 運命の導き's
  // own "ダイス目　+n" (CHANGE_DIE_VALUE) icon). This also fixes a real display bug the old version had:
  // its dieCount loop capped each die's shown value at 6, so 移ろいの兆しLV2's buildValue=9 (not a
  // multiple of 6) rendered as "M"+two dice-of-6, visually implying 12 -- a plain number has no such
  // rounding. Category letters are dropped entirely since every card with a buildValue in the current
  // data always has them too (redundant with the number itself once the per-die icons are gone).
  if (buildValue !== null) {
    children.push(actionSuffix('ダイス目　'), el('span', 'action-count action-count--large', String(buildValue)));
  } else if (categories === 'U') {
    // 'U' alone (only 革命の兆し/B005A-B's BUILD(U)/BUILD(U);ADD(BZ) -- confirmed via data/game.json, no
    // other card combines U with A/B/C/M) reads as "LVアップ" instead of the bare letter (2026-08-25, per
    // user request: "革命の兆しのアイコン U と書いてあるところを LVアップ と書いて").
    children.push(actionSuffix('LVアップ'));
  } else if (categories) {
    children.push(actionSuffix(categories));
  }
  const buildRow = actionRow(children);
  if (/;ADD\(BZ\)$/.test(actionText)) {
    const stack = el('div', 'action-icons-stack');
    stack.appendChild(buildRow);
    stack.appendChild(actionRow([actionSuffix('軽減Z')]));
    return stack;
  }
  const addMatch = /;ADD\(([^)]+)\)$/.exec(actionText);
  if (addMatch) {
    const addChildren = [actionEmoji('⚡')];
    for (const item of addMatch[1].split(',').map((s) => s.trim())) {
      if (item === 'BZ') { addChildren.push(actionSuffix('BZ')); continue; }
      const m = /^(\d*)(K|A|B|C|Z)$/.exec(item);
      if (m) addChildren.push(...resourceItemNodes(m[1], m[2]));
    }
    const stack = el('div', 'action-icons-stack');
    stack.appendChild(buildRow);
    stack.appendChild(actionRow(addChildren));
    return stack;
  }
  return buildRow;
}

/** ADD(wD) / ADD(2wD) etc: ⚡ (same "gain" prefix as ADD(K) etc) + one 🎲 per white die granted
 * (corrected 2026-07-29: the ⚡ prefix was missing from the first pass). */
function buildAddWdIcon(actionText) {
  const match = /^ADD\((\d*)wD\)$/.exec(actionText || '');
  if (!match) return null;
  const count = match[1] ? parseInt(match[1], 10) : 1;
  return actionRow([actionEmoji('⚡'), ...Array.from({ length: count }, () => actionEmoji('🎲'))]);
}

/** One resource "item" within an ADD(...) list, e.g. "3K" or "VP" -- returns the DOM node(s) for it
 * (a colored dot + optional count, or plain suffix text for VP/D which have no dot). Shared by
 * buildAddResourceIcon (single item) and buildAddMultiResourceIcon (comma-separated list) below. */
function resourceItemNodes(countStr, resource) {
  if (resource === 'VP') return [actionCount(`${countStr || '1'}VP`)];
  if (resource === 'D') return [actionSuffix(`${countStr || ''}追加色D`)];
  const nodes = [actionDot(resource)];
  if (countStr) nodes.push(actionCount(countStr));
  return nodes;
}

/** Wraps a resource node list into a single "⚡ + resource(s)" row (2026-08-13, per user request:
 * reverts the 2026-07-30 CON-only 2-row stack -- ⚡ alone on top, the resource(s) below -- back to the
 * same combined single-row look every other card type/AREA action display already uses). */
function gainIconRow(resourceNodes) {
  return actionRow([actionEmoji('⚡'), ...resourceNodes]);
}

/**
 * ADD(K) / ADD(3K) / ADD(A) / ADD(2VP) etc: ⚡ + the resource. K/A/B/C/Z show as a colored dot (with
 * a count suffix only when the DSL has an explicit number, e.g. ADD(3K) -> ⚡●3 but ADD(K) -> ⚡●).
 * VP has no dot (confirmed 2026-07-29: VP is always plain text, never an icon/dot) so it's shown as
 * "{count}VP" text instead, e.g. ADD(2VP) -> ⚡2VP (confirmed 2026-07-29).
 */
function buildAddResourceIcon(actionText) {
  const match = /^ADD\((\d*)(K|A|B|C|Z|VP|D)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, countStr, resource] = match;
  return gainIconRow(resourceItemNodes(countStr, resource));
}

/** ADD(A,K) / ADD(2C,4K) / ADD(A,B,C) etc: a bundled multi-resource grant (confirmed in
 * [[project-dice-wp-dsl-spec]]: everything in one ADD(...) list is granted together as one command)
 * -- ⚡ once, then each item's dot/count in sequence (2026-07-30, fixes R010/R011/R012 and
 * CON002A/CON003B/CON004B/CON005B showing no icon at all). Falls back to null (letting the raw-text
 * fallback handle it, where allowed) if any comma-separated part isn't a recognized shape. */
function buildAddMultiResourceIcon(actionText) {
  const match = /^ADD\(([^()]+,[^()]+)\)$/.exec(actionText || '');
  if (!match) return null;
  const parts = match[1].split(',');
  const resourceNodes = [];
  for (const part of parts) {
    const itemMatch = /^(\d*)(K|A|B|C|Z|VP|D)$/.exec(part.trim());
    if (!itemMatch) return null;
    resourceNodes.push(...resourceItemNodes(itemMatch[1], itemMatch[2]));
  }
  return gainIconRow(resourceNodes);
}

/** CHANGE(2K,2A) / CHANGE(K,Z) / CHANGE(2K,4Z) etc: a fixed-quantity conversion with no 3rd
 * (execution-count) argument -- both sides just a plain resource token, optionally with a leading
 * count (2026-08-0X, added when C001-3's TAP was changed from the old CHANGE(K,A,2) count-argument
 * form to this quantity-prefixed form, per user request: "アイコンも変更お願いします"). Deliberately
 * excludes VP on the get side (CHANGE(4K,VP) already has its own exact-match entry in
 * ACTION_ICON_BUILDERS showing bare "VP" text, not "1VP" -- confirmed by the user previously; this
 * generic pattern would otherwise silently override that with a slightly different look) and excludes
 * a 3rd argument entirely (that's CHANGE(K,A,ALL) and the old count-argument form, both handled
 * elsewhere/by their own exact entries). Reuses the same dot+count vocabulary ADD's icons use (see
 * resourceItemNodes) for both sides, rather than the old single-dot-plus-"×N"-suffix look, since a
 * quantity prefix on *both* sides doesn't reduce to a single "how many times" suffix. */
function buildChangeQuantityIcon(actionText) {
  const match = /^CHANGE\((\d*)(K|A|B|C|Z),(\d*)(K|A|B|C|Z)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payCount, payResource, getCount, getResource] = match;
  return actionRow([
    ...resourceItemNodes(payCount, payResource),
    actionArrow(),
    ...resourceItemNodes(getCount, getResource),
  ]);
}

/** CHANGE(nX,(item1,item2,...)) -- pay a single resource, gain a fixed GROUP of resources all at once
 * (2026-08-21, AREA006B/C/歓楽街's new ability: "CHANGE(2K,(A,B,C,Z))" / LV2's "CHANGE(2K,(A,B,C,3Z))" --
 * per command-builder.lowerChange's own gain-list semantics this grants every item in the group
 * unconditionally, not a player choice, so the icon simply lists them all after one arrow). Distinct
 * from buildChangeQuantityIcon above (single resource on both sides) and the AREA007-only exact-match
 * 'CHANGE((A,B,C),D)' entry in ACTION_ICON_BUILDERS (group on the PAY side instead, labelled 追加色ダイス
 * rather than plain resource dots). */
function buildChangeGroupGainIcon(actionText) {
  const match = /^CHANGE\((\d*)(K|A|B|C|Z),\(([A-Z0-9,]+)\)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payCount, payResource, gainGroup] = match;
  const gainNodes = gainGroup.split(',').flatMap((item) => {
    const itemMatch = /^(\d*)(K|A|B|C|Z)$/.exec(item);
    return itemMatch ? resourceItemNodes(itemMatch[1], itemMatch[2]) : [];
  });
  if (gainNodes.length === 0) return null;
  return actionRow([
    ...resourceItemNodes(payCount, payResource),
    actionArrow(),
    ...gainNodes,
  ]);
}

/** CHANGE(X,Y,n) -- the count-argument form (command-builder.js's lowerChange: pay X get Y, up to n
 * times, scaled down to whatever's affordable -- e.g. C001A/002A/003A's TAP="CHANGE(K,A,2)", back to
 * this shape as of the 2026-08-11 A/B/C data edit, superseding the quantity-prefixed
 * "CHANGE(2K,2A)" form buildChangeQuantityIcon above was written for). 2026-08-13, per user report the
 * icon regressed to raw DSL text once the data moved back to this shape: visually identical to a
 * literal CHANGE(nX,nY) conversion -- "pay up to n, gain up to n" -- so shown the exact same
 * "{n}X -> {n}Y" way via the same resourceItemNodes vocabulary, just reading n once instead of twice. */
function buildCappedChangeIcon(actionText) {
  const match = /^CHANGE\((K|A|B|C|Z),(K|A|B|C|Z),(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payResource, getResource, count] = match;
  return actionRow([
    ...resourceItemNodes(count, payResource),
    actionArrow(),
    ...resourceItemNodes(count, getResource),
  ]);
}

/** UNTAP_CHOICE(SELF,n) -- any budget n (2026-08-17, per user request, replacing the old flat "⤴️×3" icon
 * that used to be the only variant; generalized from 3 exact-match table entries into a proper pattern
 * 2026-08-18 once a 4th budget (n=2, C001B/002B/003B) appeared, same "exact-match shape recurring with a
 * new count -> generalize" evolution buildCappedChangeIcon went through above). One arrow plus the budget
 * number, matching the C sheet's own hand-authored アイコン column text verbatim back when that column
 * still existed for this sheet ("⚡⤴" / "⚡⤴3" / "⚡⤴6"). n=1 omits the number (a single arrow already
 * reads as "untap one"), n>=2 appends it as plain text after the arrow. */
function buildUntapChoiceIcon(actionText) {
  const match = /^UNTAP_CHOICE\(SELF,(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, count] = match;
  return actionRow([actionEmoji('⚡'), actionEmoji('⤴️'), ...(count === '1' ? [] : [actionSuffix(count)])]);
}

/** UNTAP_ALL(SELF) -- only 王女(C301A)/聖女LV2(C202B)/王女LV2(C301B)'s own ONCE currently, confirmed via
 * data/game.json -- ⚡ (ONCE "gain" prefix, same convention as buildAddWdIcon etc) + ⤴️⤴️⤴️ (three untap
 * arrows -- "all", as opposed to UNTAP_CHOICE's single arrow + a budget number). Had no icon builder
 * before the text-only version this replaced, so it fell through to buildEffectRow's raw-DSL-text
 * fallback and showed the literal "UNTAP_ALL(SELF)" string on the card (2026-08-25, per user request:
 * "聖女　王女の カードをすべてアンタップする...の効果があるところに ⚡⤴⤴⤴ をいれて"). The trailing
 * "カードをすべてアンタップする" text label was then dropped (2026-08-25 follow-up, per user request:
 * "⚡⤴⤴⤴ をつけたので カードをすべてアンタップする の文言を消して") -- the icon alone is enough now
 * that it's in place. */
function buildUntapAllIcon(actionText) {
  if (actionText !== 'UNTAP_ALL(SELF)') return null;
  return actionRow([actionEmoji('⚡'), actionEmoji('⤴️'), actionEmoji('⤴️'), actionEmoji('⤴️')]);
}

/** CHANGE(nK,mVP) -- K->VP conversions with any counts on either side, e.g. AREA010A's "CHANGE(2K,VP)"
 * or AREA010C's "CHANGE(2K,2VP)" (2026-08-05, per user feedback: "AREA010A B C も 2K → VP のようにお願
 * い"). Generalizes the old ACTION_ICON_BUILDERS['CHANGE(4K,VP)'] exact-match entry (which only covered
 * that one literal count and is no longer reachable by any current data) into a proper pattern. VP still
 * has no dot (per buildAddResourceIcon's own VP convention elsewhere), shown as plain "{n}VP" text with
 * the count omitted when the DSL's own count is implicit 1 -- same "only show a number when the DSL has
 * one" rule used throughout. */
function buildChangeToVpIcon(actionText) {
  const match = /^CHANGE\((\d*)K,(\d*)VP\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payCount, gainCount] = match;
  return actionRow([...resourceItemNodes(payCount, 'K'), actionArrow(), actionSuffix(gainCount ? `${gainCount}VP` : 'VP')]);
}

/** CHANGE(K,VP,n): a capped-repeat K->VP conversion, usable up to n times, e.g. AREA010C/孤児院LV2's
 * "CHANGE(K,VP,5)" (2026-08-26, per user request: "孤児院LV2 能力変えました アイコンを K→1VP （MAX5）に
 * 変えてください"). Distinct from buildCappedChangeIcon's shared "n X -> n Y" shape (K/A/B/C/Z pairs
 * only, no VP) -- VP always shows as plain "1VP" text per-use here rather than scaling the shown count
 * to the usage cap, plus a MAX badge (same convention as buildConvertLimitIcon/buildUpgradeLimitIcon). */
function buildChangeToVpCappedIcon(actionText) {
  const match = /^CHANGE\(K,VP,(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionDot('K'), actionArrow(), actionSuffix('1VP'), actionSuffix(`MAX${match[1]}`)]);
}

/** CHANGE(X,Y,ALL);ADD(nZ) -- e.g. AREA003B's "CHANGE(K,A,ALL);ADD(2B)" (2026-08-05, per user feedback
 * with a worked example: "〇→A ALL （雷のアイコン）2B"). Two-row stack: row1 is the CHANGE(...,ALL) part
 * alone, in the exact same dot->dot+"ALL" shape ACTION_ICON_BUILDERS' own CHANGE(K,A/B/C,ALL) entries
 * already use (kept as a separate, still-reachable exact-match case for when there's no trailing ADD);
 * row2 is the ADD(...) gain with the usual ⚡ "gain" prefix. */
function buildChangeAllThenAddIcon(actionText) {
  const match = /^CHANGE\((K|A|B|C|Z),(K|A|B|C|Z),ALL\);ADD\((\d*)(K|A|B|C|Z)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payResource, gainResource, addCount, addResource] = match;
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow([actionDot(payResource), actionArrow(), actionDot(gainResource), actionSuffix('ALL')]));
  stack.appendChild(actionRow([actionEmoji('⚡'), ...resourceItemNodes(addCount, addResource)]));
  return stack;
}

/** A bare BZ-granting TAP, optionally paired with a MONUMENT_DICE_DISCOUNT(n,THIS_TURN) or
 * MONUMENT_CHANGE_DIE_VALUE(SELF±n), and/or BLOCK_BUILD(category,THIS_TURN) restrictions -- currently
 * only JOB007/宮廷人's own ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(A,THIS_TURN);
 * BLOCK_BUILD(B,THIS_TURN);BLOCK_BUILD(C,THIS_TURN) matches this shape in the current dataset (2026-08-25,
 * per user spec: "⤵１資源軽減 / ダイス目+1 / 🔨ABC不可" -- 毎ターン is a separate row, the existing
 * generic UNTAP() icon for this card's own TURNEND, untouched here).
 *
 * First line: either pay -> {n}BZ (CHANGE form; BZ has no colored dot in this project's vocabulary,
 * unlike buildChangeQuantityIcon's K/A/B/C/Z -- matches every other "{n}BZ"/"軽減{n}Z" label elsewhere,
 * plain text rather than a dot+count) or "{n}資源軽減" (ADD form, matching JOB007's own INST wording
 * "１資源軽減" -- 2026-08-25, replaced the earlier generic "⚡BZ" glyph+suffix once this became JOB007's
 * only user). Next line (only if MONUMENT_DICE_DISCOUNT present -- no card currently uses this, kept for
 * the shape): 🎲-{n}, reusing the same dice glyph every wD-related icon already uses elsewhere. Next line
 * (only if MONUMENT_CHANGE_DIE_VALUE present, 2026-08-25, replacing MONUMENT_DICE_DISCOUNT as JOB007's
 * own mechanic per its 2026-08-24 TAP redesign -- see board.useBareTapAbility's own doc): "ダイス目±n".
 * Final line (only if any BLOCK_BUILD present): for the A+B+C triple-block specifically (JOB007's own
 * case), ⚒️ + "ABC不可" (2026-08-25, per user spec -- reinstates a label here, reversing the 2026-08-21
 * "ABC除くを削除" request that removed it entirely); any other combination keeps the pre-existing
 * "{cats}除く" wording, or "モニュメント除く" for the single-M case (JOB004's own, untouched).
 * **2026-08-04: the block used to be display-only text -- confirmed with the user this needed real
 * enforcement, so it's backed by a genuine rule (BLOCK_BUILD(...,THIS_TURN), see board.getBuildCandidates);
 * this label just reflects that.** Matches generically on shape (a bare CHANGE(nX,nBZ) or ADD(nBZ),
 * optionally followed by one MONUMENT_DICE_DISCOUNT/MONUMENT_CHANGE_DIE_VALUE and/or one or more
 * BLOCK_BUILD(cat,THIS_TURN)), not any one card by name -- the BZ grant alone, with none of the others,
 * still matches and simply skips those rows. */
function buildBzForBuildIcon(actionText) {
  const stmts = (actionText || '').split(';').map((s) => s.trim());
  const changeMatch = /^CHANGE\((\d*)(K|A|B|C|Z),(\d*)BZ\)$/.exec(stmts[0]);
  const addMatch = /^ADD\((\d*)BZ\)$/.exec(stmts[0]);
  if (!changeMatch && !addMatch) return null;
  const tail = stmts.slice(1);
  const discountMatch = tail.find((s) => /^MONUMENT_DICE_DISCOUNT\(\d+,THIS_TURN\)$/.test(s));
  const dieValueMatch = tail.find((s) => /^MONUMENT_CHANGE_DIE_VALUE\(SELF[+-]\d+\)$/.test(s));
  const blockStmts = tail.filter((s) => s !== discountMatch && s !== dieValueMatch);
  const blockMatches = blockStmts.map((s) => /^BLOCK_BUILD\(([ABCMU]),THIS_TURN\)$/.exec(s));
  if (blockMatches.some((m) => !m)) return null; // unrecognized extra statement, don't guess
  const blockedCats = blockMatches.map((m) => m[1]);
  const stack = el('div', 'action-icons-stack');
  if (changeMatch) {
    const [, payCount, payResource, bzCount] = changeMatch;
    stack.appendChild(actionRow([...resourceItemNodes(payCount, payResource), actionArrow(), actionSuffix(`${bzCount}BZ`)]));
  } else {
    stack.appendChild(actionRow([actionSuffix(`${addMatch[1] || 1}資源軽減`)]));
  }
  if (discountMatch) {
    const discountAmount = /^MONUMENT_DICE_DISCOUNT\((\d+),THIS_TURN\)$/.exec(discountMatch)[1];
    stack.appendChild(actionRow([actionEmoji('🎲'), actionSuffix(`-${discountAmount}`)]));
  }
  if (dieValueMatch) {
    const delta = /^MONUMENT_CHANGE_DIE_VALUE\(SELF([+-]\d+)\)$/.exec(dieValueMatch)[1];
    stack.appendChild(actionRow([actionSuffix(`ダイス目${delta}`)]));
  }
  const isAbcBlock = blockedCats.length === 3 && ['A', 'B', 'C'].every((c) => blockedCats.includes(c));
  if (isAbcBlock) {
    stack.appendChild(actionRow([actionEmoji('⚒️'), actionSuffix('ABC不可')]));
  } else if (blockedCats.length > 0) {
    const label = blockedCats.length === 1 && blockedCats[0] === 'M' ? 'モニュメント除く' : `${blockedCats.join('')}除く`;
    stack.appendChild(actionRow([actionSuffix(label)]));
  }
  return stack;
}

/** JOB008's PASSIVE (2026-08-0X, per user request): N stacked IF(TOTAL_EMBLEM_COUNT>=k*step,
 * VP_MODIFIER(vp)) statements at evenly-spaced thresholds, all granting the same VP -- collapsed into
 * one compact "every {step} emblems -> +{vp}VP" icon (EMBLEM {step}個 / 🔽 / {vp}VP) instead of
 * literally showing all N IF rows. Requires 2+ statements (a single IF is buildCardCountVpModifierIcon's
 * territory, a different shape) and a perfectly even step; anything irregular falls through to the
 * text fallback rather than showing a misleading simplified icon. */
function buildEmblemStepVpModifierIcon(actionText) {
  const stmts = (actionText || '').split(';').map((s) => s.trim());
  if (stmts.length < 2) return null;
  const parsed = stmts.map((s) => /^IF\(TOTAL_EMBLEM_COUNT>=(\d+),VP_MODIFIER\((\d+)\)\)$/.exec(s));
  if (parsed.some((m) => !m)) return null;
  const thresholds = parsed.map((m) => Number(m[1]));
  const vps = parsed.map((m) => Number(m[2]));
  const step = thresholds[0];
  if (!vps.every((v) => v === vps[0])) return null;
  if (!thresholds.every((t, i) => t === step * (i + 1))) return null;
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow([actionSuffix(`EMBLEM ${step}個`)]));
  stack.appendChild(actionRow([actionEmoji('🔽')]));
  stack.appendChild(actionRow([actionSuffix(`${vps[0]}VP`)]));
  return stack;
}

/** SET_DIE_VALUE(SELFx|y): player picks one of two fixed values -- shown as the two numbers, no arrow
 * (confirmed 2026-07-29). Matches at the start since it's usually followed by ;GRANT_PLACE_ANYWHERE(...),
 * which isn't shown as an icon. */
function buildSetDieValueIcon(actionText) {
  const match = /^SET_DIE_VALUE\(SELF(\d)\|(\d)\)/.exec(actionText || '');
  if (!match) return null;
  return actionRow([dieFace(match[1]), dieFace(match[2])]);
}

/** CHANGE_DIE_VALUE(SELF±n): player picks either +n or -n -- shown as "±n" (confirmed 2026-07-29). No
 * card in the current data uses this choice form (only the fixed-delta form below, e.g. 運命の導き's own
 * SELF+2/SELF+3) -- kept for whenever a future card does. */
function buildChangeDieValueIcon(actionText) {
  const choiceMatch = /^CHANGE_DIE_VALUE\(SELF±(\d+)\)/.exec(actionText || '');
  if (choiceMatch) return actionRow([actionCount(`±${choiceMatch[1]}`)]);
  // CHANGE_DIE_VALUE(SELF+n)/(SELF-n): a single FIXED delta, no player choice at all (2026-08-25, added
  // alongside 運命の導き/B003A-B's TAP switching to this shape -- see command-builder.js's own
  // lowerChangeDieValue doc). Shown as "ダイス目　+n" with the signed number large/dark (2026-08-25, per
  // user request: "ダイス目　+1と／数字は大きく濃く", confirmed to mean the DSL's own actual delta rather
  // than a literal "+1" -- see .action-count--large in style.css, same "large/dark" convention as
  // .action-suffix--large/.card-note--large elsewhere).
  const fixedMatch = /^CHANGE_DIE_VALUE\(SELF([+-]\d+)\)/.exec(actionText || '');
  if (!fixedMatch) return null;
  return actionRow([actionSuffix('ダイス目　'), el('span', 'action-count action-count--large', fixedMatch[1])]);
}

/** ADD(COUNT(emblem)*wD): the die count is dynamic (however many of that emblem the player owns),
 * so it's shown as 🎲×{emblem character, in its emblem color} instead of a fixed number (confirmed
 * 2026-07-29). */
function buildCountEmblemWdIcon(actionText) {
  const match = /^ADD\(COUNT\(([天地人])\)\*wD\)$/.exec(actionText || '');
  if (!match) return null;
  const emblemSpan = el('span', 'action-emblem', match[1]);
  emblemSpan.dataset.emblem = match[1];
  return actionRow([actionEmoji('🎲'), actionTimes(), emblemSpan]);
}

/** "×" as a connector, styled like the → arrow (small, bold, faint) rather than an emoji. */
function actionTimes() {
  return el('span', 'action-arrow', '×');
}

/** RESOURCE_LIMIT(K,7) etc (a TURNEND-column effect, e.g. CON001A): resource dot + "MAX{n}" badge
 * (confirmed 2026-07-29). */
function buildResourceLimitIcon(actionText) {
  const match = /^RESOURCE_LIMIT\((K|A|B|C|Z),(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, resource, max] = match;
  return actionRow([actionDot(resource), actionSuffix(`MAX${max}`)]);
}

/** VP_MODIFIER(n) on its own (as opposed to wrapped in an IF(...) condition, confirmed 2026-07-29,
 * e.g. CON001B) -- always applies, shown simply as "{n}VP". */
function buildVpModifierIcon(actionText) {
  const match = /^VP_MODIFIER\((-?\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionSuffix(`${match[1]}VP`)]);
}

/** VP_MODIFIER(COUNT(emblem)): a persistent (re-evaluated live, not a one-time snapshot -- confirmed
 * 2026-08-12, see executor.collectVpModifiers) VP bonus equal to however many of that emblem the
 * player currently owns -- shown as {emblem, in its emblem color}×VP, matching
 * buildCountEmblemWdIcon's "🎲×{emblem}" convention for the same COUNT(emblem) dynamic-count idiom. */
function buildCountEmblemVpModifierIcon(actionText) {
  const match = /^VP_MODIFIER\(COUNT\(([天地人])\)\)$/.exec(actionText || '');
  if (!match) return null;
  const emblemSpan = el('span', 'action-emblem', match[1]);
  emblemSpan.dataset.emblem = match[1];
  return actionRow([emblemSpan, actionTimes(), actionSuffix('VP')]);
}

/** VP_MODIFIER(MAX_EMBLEM_COUNT): B301B/栄光の証LV2's own PASSIVE (renamed from B008B by the 2026-08-24
 * SHOP201-203 rework's card renumbering) -- a persistent VP bonus equal to
 * however many of the player's single MOST-held emblem type they currently own (confirmed 2026-08-21,
 * per user spec: "最多エンブレム / × VP", larger and darker than a normal .action-suffix -- see
 * .action-suffix--large in style.css). Stacked 2 rows (label, then ×VP) rather than one wide row, per
 * the user's own line break. */
function buildMaxEmblemVpModifierIcon(actionText) {
  if (actionText !== 'VP_MODIFIER(MAX_EMBLEM_COUNT)') return null;
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow([el('span', 'action-suffix action-suffix--large', '最多エンブレム')]));
  stack.appendChild(actionRow([actionTimes(), el('span', 'action-suffix action-suffix--large', 'VP')]));
  return stack;
}

/** IF(CARD_COUNT<=n,VP_MODIFIER(m)): a scoring penalty/bonus if the player's total card count is at
 * most n -- shown as 🃏<=n on one row, the VP modifier on the row below (confirmed 2026-07-29). */
function buildCardCountVpModifierIcon(actionText) {
  const match = /^IF\(CARD_COUNT<=(\d+),VP_MODIFIER\((-?\d+)\)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, threshold, modifier] = match;
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow([actionEmoji('🃏'), actionSuffix(`<=${threshold}`)]));
  stack.appendChild(actionRow([actionSuffix(`${modifier}VP`)]));
  return stack;
}

/** IF(EMBLEM_SET_COUNT<=3,VP_MODIFIER(m)): a scoring penalty/bonus if the player doesn't have a
 * complete 天/地/人 emblem set -- shown as the 3 emblem characters on one row, "なければ{m}VP" below
 * (confirmed 2026-07-29). Specific to the <=3 threshold (there are only 3 emblem types total, so a
 * different threshold wouldn't map to "show all 3" the same way). */
function buildEmblemSetVpModifierIcon(actionText) {
  const match = /^IF\(EMBLEM_SET_COUNT<=3,VP_MODIFIER\((-?\d+)\)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, modifier] = match;
  const emblemChildren = ['天', '地', '人'].map((e) => {
    const span = el('span', 'action-emblem', e);
    span.dataset.emblem = e;
    return span;
  });
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow(emblemChildren));
  stack.appendChild(actionRow([actionSuffix(`なければ${modifier}VP`)]));
  return stack;
}

/** IF(LEVEL_COUNT(n)OP m,VP_MODIFIER(k)): same shape as buildCardCountVpModifierIcon above but keyed
 * on a specific LEVEL instead of total card count (2026-07-30, added for CON005A -- not necessarily a
 * perfect read at a glance, just enough to infer "LV{n} count vs {m} affects VP", per the user's own
 * bar for these fill-in icons). */
function buildLevelCountVpModifierIcon(actionText) {
  const match = /^IF\(LEVEL_COUNT\((\d+)\)(>=|<=)(\d+),VP_MODIFIER\((-?\d+)\)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, level, op, threshold, modifier] = match;
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow([actionSuffix(`LV${level}`), actionSuffix(`${op}${threshold}`)]));
  stack.appendChild(actionRow([actionSuffix(`${modifier}VP`)]));
  return stack;
}

/** FORCE_CONVERT(from,to,n): a forced TURNEND conversion -- shown as {from dot} -> {to dot} (+ a
 * count suffix if n>1; n=1, the common case, shows no suffix, matching ADD's own "no number for 1"
 * convention elsewhere). Confirmed 2026-07-30, added for 色欲. */
function buildForceConvertIcon(actionText) {
  const match = /^FORCE_CONVERT\((K|A|B|C|Z),(K|A|B|C|Z),(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, from, to, count] = match;
  const children = [actionDot(from)];
  if (count !== '1') children.push(actionCount(count));
  children.push(actionArrow(), actionDot(to));
  return actionRow(children);
}

/** CONVERT_LIMIT(ALL,n): caps how many times an ALL-based CHANGE can fire, game-wide (2026-07-30,
 * added for CON003B) -- 🔄 (the closest thing to a generic "conversion" glyph already in use elsewhere
 * in this file) + a MAX badge, same style as buildResourceLimitIcon's MAX badge above. */
function buildConvertLimitIcon(actionText) {
  const match = /^CONVERT_LIMIT\(ALL,(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionEmoji('🔄'), actionSuffix(`MAX${match[1]}`)]);
}

/** UPGRADE_LIMIT(n): caps how many UPGRADEs (BUILD(U)) a player can do, game-wide (2026-07-30, added
 * for CON004B) -- reuses the ⚒️ BUILD glyph with a "U" suffix (matching buildBuildIcon's own
 * category-letter convention) plus a MAX badge. */
function buildUpgradeLimitIcon(actionText) {
  const match = /^UPGRADE_LIMIT\((\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionEmoji('⚒️'), actionSuffix('U'), actionSuffix(`MAX${match[1]}`)]);
}

/** RESOURCE_TOTAL_LIMIT((res,res,...),n): a TURNEND gate blocking TURNEND until the combined total of
 * the listed resources is <=n (2026-07-30, added for CON005B) -- each resource's dot, then a
 * "合計MAX{n}" ("total max") suffix. */
function buildResourceTotalLimitIcon(actionText) {
  const match = /^RESOURCE_TOTAL_LIMIT\(\(([^)]+)\),(\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  const dots = match[1].split(',').map((r) => actionDot(r.trim()));
  return actionRow([...dots, actionSuffix(`合計MAX${match[2]}`)]);
}

/** ON(PLACE(MAPn),ADD(...)) [;ON(PLACE(MAPm),ADD(...))...]: "placing here grants a resource" passives
 * (2026-07-30, added for JOB002A, whose 2 statements both grant the same resource -- shown once, not
 * per trigger, since repeating an identical "📍→●" twice wouldn't add information). 📍 stands in for
 * "when placed" generically (there's no per-AREA icon vocabulary in this file to be more specific,
 * which is fine per the user's "doesn't need to be perfect" bar for these). */
function buildOnPlaceAddIcon(actionText) {
  const stmts = (actionText || '').split(';').map((s) => s.trim());
  const parsed = stmts.map((s) => /^ON\(PLACE\(MAP\d+\),ADD\((\d*)(K|A|B|C|Z|VP)\)\)$/.exec(s));
  if (parsed.length === 0 || parsed.some((m) => !m)) return null;
  const [, countStr, resource] = parsed[0];
  return actionRow([actionEmoji('📍'), actionTrigger(), ...resourceItemNodes(countStr, resource)]);
}

/** SET_DICE_ANY() (2026-07-30, added for JOB003A): sets one of the player's dice to any value they
 * like -- 🎲 + "自由" ("free[ly chosen]"). */
function buildSetDiceAnyIcon(actionText) {
  if (actionText !== 'SET_DICE_ANY()') return null;
  return actionRow([actionEmoji('🎲'), actionSuffix('自由')]);
}

/** ON(BUILD(...),CHANGE(cost,nBZ)): "building/upgrading lets you pay cost for a BZ discount token"
 * (2026-07-30, added for JOB004A) -- ⚒️ + the pay cost, an arrow, then the same "軽減{n}Z" text
 * buildBuildIcon already uses for a trailing ADD(BZ). Category letters are omitted here (unlike
 * buildBuildIcon) since ON(BUILD(...))'s category list is the trigger condition, not what gets built. */
function buildOnBuildChangeDiscountIcon(actionText) {
  const match = /^ON\(BUILD\([^)]*\),CHANGE\((\d*)(K|A|B|C|Z),(\d*)BZ\)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payCount, payResource, bzCount] = match;
  return actionRow([actionEmoji('⚒️'), ...resourceItemNodes(payCount, payResource), actionTrigger(), actionSuffix(`軽減${bzCount}Z`)]);
}

/** ON(GET(x),CHANGE(a,b)): "getting x lets you convert a to b" (2026-07-30, added for JOB005A) --
 * shown as just the conversion itself (a-dot -> b-dot); the GET(x) trigger isn't repeated in the icon
 * since it's implied by which card/column it's attached to (TAP already gets the ⤵️ prefix from
 * buildEffectRow), matching the "doesn't need to be perfect" bar. */
function buildOnGetChangeIcon(actionText) {
  const match = /^ON\(GET\((?:K|A|B|C|Z|D|wD)\),CHANGE\((\d*)(K|A|B|C|Z),(\d*)(K|A|B|C|Z)\)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, payCount, payResource, gainCount, gainResource] = match;
  return actionRow([...resourceItemNodes(payCount, payResource), actionArrow(), ...resourceItemNodes(gainCount, gainResource)]);
}

/** ON(GET(x),ADD(y)) [;ON(GET(x2),ADD(y2))...]: "getting x grants y" passives with 2+ different
 * trigger/resource pairs (2026-07-30, added for JOB006A -- a single-statement version would collide
 * with buildAddResourceIcon-style patterns, but this project doesn't have one of those yet, so this
 * only handles the 2+ compound case). Each pair gets its own row (trigger icon/dot -> gained
 * resource(s)); D/wD triggers show as 色D/🎲 (matching buildAddResourceIcon/buildAddWdIcon's own
 * conventions) since they're dice, not resource dots. The ADD(...) side can itself be a bundled
 * multi-resource grant (e.g. "ADD(Z,VP)", 2026-08-18, JOB006A's revised PASSIVE: "追加色Dを得たときZと
 * 1VPを得る") -- parsed the same comma-split way buildAddMultiResourceIcon does, rendering every item
 * in sequence on that pair's own row. */
function buildOnGetAddMultiIcon(actionText) {
  const stmts = (actionText || '').split(';').map((s) => s.trim());
  const parsed = stmts.map((s) => /^ON\(GET\((K|A|B|C|Z|D|wD)\),ADD\(([^()]+)\)\)$/.exec(s));
  if (parsed.length < 2 || parsed.some((m) => !m)) return null;
  const stack = el('div', 'action-icons-stack');
  for (const m of parsed) {
    const [, trigger, addContent] = m;
    const gainedNodes = [];
    for (const part of addContent.split(',')) {
      const itemMatch = /^(\d*)(K|A|B|C|Z|VP|D|wD)$/.exec(part.trim());
      if (!itemMatch) return null;
      gainedNodes.push(...resourceItemNodes(itemMatch[1], itemMatch[2]));
    }
    const triggerNode = trigger === 'D' ? actionSuffix('色D') : trigger === 'wD' ? actionEmoji('🎲') : actionDot(trigger);
    stack.appendChild(actionRow([triggerNode, actionTrigger(), ...gainedNodes]));
  }
  return stack;
}

/** ON(BUILD(cats),ADD(nX)) for a plain resource X (K/A/B/C/Z) -- e.g. JOB002/実業家's TAP=
 * "ON(BUILD(),ADD(K))" (2026-08-04, per user feedback: "JOB002 TAP で ON(BUILD(),ADD(K))に変更しました"
 * with an explicit icon spec: "⚒️ ▶️ ⤵️K"). ⚒️ + the trigger categories (same letter-extraction as
 * buildBuildIcon) + ▶, ending in a normal resource-dot. Empty cats (BUILD() with no args, per
 * executor.js's eventArgsMatch: "match any category") shows no category suffix at all.
 *
 * The TAP-cost marker (⤵) sits between ▶ and the resource dot here (2026-08-25, per user spec: "⤵🔨▷〇
 * から 🔨▷⤵〇に変更 並び順は変えてもアイコンはそのままで" -- reorder only, same glyphs), embedded
 * directly in this row instead of relying on buildEffectRow's own auto-prepended TAP prefix (which always
 * lands at the very front) -- see this function's row.dataset.tapPrefixEmbedded, which tells
 * buildEffectRow to skip its own prefix for this one row. JOB002's ON(BUILD(),ADD(K)) is currently the
 * only TAP in the whole dataset matching this shape, so this reorder is effectively scoped to that one
 * card without needing to name it directly. (2026-08-07: this used to exclude BZ, deferring to a sibling
 * buildOnBuildAddBzIcon for ON(BUILD(...),ADD(nBZ)) -- that was JOB007's old shape specifically; JOB007
 * was redesigned to a bare TAP=ADD(BZ);BLOCK_BUILD(...) instead, see buildBzForBuildIcon, so no card uses
 * the ON(BUILD(...),ADD(nBZ)) shape anymore and the sibling function was removed as dead code. This
 * function's own K/A/B/C/Z match already never covered BZ, so it needs no change.) */
function buildOnBuildAddResourceIcon(actionText) {
  const match = /^ON\(BUILD\(([^)]*)\),ADD\((\d*)(K|A|B|C|Z)\)\)$/.exec(actionText || '');
  if (!match) return null;
  const categories = (match[1].match(/[ABCMU]/g) || []).join('');
  const children = [actionEmoji('⚒️')];
  if (categories) children.push(actionSuffix(categories));
  children.push(actionTrigger(), actionEmoji(TAP_COST_ICON), ...resourceItemNodes(match[2], match[3]));
  const row = actionRow(children);
  row.dataset.tapPrefixEmbedded = '1';
  return row;
}

/** MODIFY_CONVERT_VALUE(ANY,ANY,+n): a passive that adds n to every CHANGE's execution count
 * (2026-07-30, added for JOB008A) -- 🔄 (matching buildConvertLimitIcon's own "conversion" glyph) +
 * the signed delta. */
function buildModifyConvertValueIcon(actionText) {
  const match = /^MODIFY_CONVERT_VALUE\(ANY,ANY,([+-]\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionEmoji('🔄'), actionSuffix(match[1])]);
}

/** @returns {HTMLElement|null} an icon row, or null if actionText has no icon mapping yet */
function buildActionIcons(actionText) {
  const buildIcon = buildBuildIcon(actionText);
  if (buildIcon) return buildIcon;
  const addWdIcon = buildAddWdIcon(actionText);
  if (addWdIcon) return addWdIcon;
  const addResourceIcon = buildAddResourceIcon(actionText);
  if (addResourceIcon) return addResourceIcon;
  const addMultiResourceIcon = buildAddMultiResourceIcon(actionText);
  if (addMultiResourceIcon) return addMultiResourceIcon;
  const changeQuantityIcon = buildChangeQuantityIcon(actionText);
  if (changeQuantityIcon) return changeQuantityIcon;
  const changeGroupGainIcon = buildChangeGroupGainIcon(actionText);
  if (changeGroupGainIcon) return changeGroupGainIcon;
  const cappedChangeIcon = buildCappedChangeIcon(actionText);
  if (cappedChangeIcon) return cappedChangeIcon;
  const untapChoiceIcon = buildUntapChoiceIcon(actionText);
  if (untapChoiceIcon) return untapChoiceIcon;
  const untapAllIcon = buildUntapAllIcon(actionText);
  if (untapAllIcon) return untapAllIcon;
  const changeToVpIcon = buildChangeToVpIcon(actionText);
  if (changeToVpIcon) return changeToVpIcon;
  const changeToVpCappedIcon = buildChangeToVpCappedIcon(actionText);
  if (changeToVpCappedIcon) return changeToVpCappedIcon;
  const changeAllThenAddIcon = buildChangeAllThenAddIcon(actionText);
  if (changeAllThenAddIcon) return changeAllThenAddIcon;
  const bzForBuildIcon = buildBzForBuildIcon(actionText);
  if (bzForBuildIcon) return bzForBuildIcon;
  const countEmblemWdIcon = buildCountEmblemWdIcon(actionText);
  if (countEmblemWdIcon) return countEmblemWdIcon;
  const resourceLimitIcon = buildResourceLimitIcon(actionText);
  if (resourceLimitIcon) return resourceLimitIcon;
  const vpModifierIcon = buildVpModifierIcon(actionText);
  if (vpModifierIcon) return vpModifierIcon;
  const countEmblemVpModifierIcon = buildCountEmblemVpModifierIcon(actionText);
  if (countEmblemVpModifierIcon) return countEmblemVpModifierIcon;
  const maxEmblemVpModifierIcon = buildMaxEmblemVpModifierIcon(actionText);
  if (maxEmblemVpModifierIcon) return maxEmblemVpModifierIcon;
  const cardCountVpModifierIcon = buildCardCountVpModifierIcon(actionText);
  if (cardCountVpModifierIcon) return cardCountVpModifierIcon;
  const emblemSetVpModifierIcon = buildEmblemSetVpModifierIcon(actionText);
  if (emblemSetVpModifierIcon) return emblemSetVpModifierIcon;
  const emblemStepVpModifierIcon = buildEmblemStepVpModifierIcon(actionText);
  if (emblemStepVpModifierIcon) return emblemStepVpModifierIcon;
  const levelCountVpModifierIcon = buildLevelCountVpModifierIcon(actionText);
  if (levelCountVpModifierIcon) return levelCountVpModifierIcon;
  const forceConvertIcon = buildForceConvertIcon(actionText);
  if (forceConvertIcon) return forceConvertIcon;
  const convertLimitIcon = buildConvertLimitIcon(actionText);
  if (convertLimitIcon) return convertLimitIcon;
  const upgradeLimitIcon = buildUpgradeLimitIcon(actionText);
  if (upgradeLimitIcon) return upgradeLimitIcon;
  const resourceTotalLimitIcon = buildResourceTotalLimitIcon(actionText);
  if (resourceTotalLimitIcon) return resourceTotalLimitIcon;
  const onPlaceAddIcon = buildOnPlaceAddIcon(actionText);
  if (onPlaceAddIcon) return onPlaceAddIcon;
  const setDiceAnyIcon = buildSetDiceAnyIcon(actionText);
  if (setDiceAnyIcon) return setDiceAnyIcon;
  const onBuildChangeDiscountIcon = buildOnBuildChangeDiscountIcon(actionText);
  if (onBuildChangeDiscountIcon) return onBuildChangeDiscountIcon;
  const onGetChangeIcon = buildOnGetChangeIcon(actionText);
  if (onGetChangeIcon) return onGetChangeIcon;
  const onGetAddMultiIcon = buildOnGetAddMultiIcon(actionText);
  if (onGetAddMultiIcon) return onGetAddMultiIcon;
  const onBuildAddResourceIcon = buildOnBuildAddResourceIcon(actionText);
  if (onBuildAddResourceIcon) return onBuildAddResourceIcon;
  const modifyConvertValueIcon = buildModifyConvertValueIcon(actionText);
  if (modifyConvertValueIcon) return modifyConvertValueIcon;
  const setDieValueIcon = buildSetDieValueIcon(actionText);
  if (setDieValueIcon) return setDieValueIcon;
  const changeDieValueIcon = buildChangeDieValueIcon(actionText);
  if (changeDieValueIcon) return changeDieValueIcon;
  const builder = ACTION_ICON_BUILDERS[actionText];
  return builder ? builder() : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Instructional hint block for onboarding card rows (2026-08-0X, per user request) -- plain lines of
 * text, with an optional trailing line rendered as a prominent, eye-catching callout (see
 * .onboard-hint__line--emphasis). Appended as a flex sibling after a row of onboard-context cards (see
 * renderConFacesRow/renderResourceChoice) so it lands to their right in the shared flex row. */
function buildOnboardHint(lines, emphasizedLine) {
  const hint = el('div', 'onboard-hint');
  for (const line of lines) hint.appendChild(el('div', 'onboard-hint__line', line));
  if (emphasizedLine) hint.appendChild(el('div', 'onboard-hint__line onboard-hint__line--emphasis', emphasizedLine));
  return hint;
}

// JOB003/道化 (2026-08-19, hasWildcardDice): a ☆ die shows a star instead of its real rolled digit --
// confirmed with the user the real value is functionally meaningless once wildcard (never used for
// slot-matching, always substituted to a fixed 1 or 6 for buildValue -- see board.placeWildcardDie's own
// abcBuildValue/monumentBuildValue doc), so display follows suit rather than showing a number that no
// longer means anything in play.
function renderDie(die) {
  const tpl = document.getElementById('tpl-die');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.classList.add(`die--${die.kind === 'WHITE' ? 'WHITE' : die.color}`);
  if (die.wildcard) node.classList.add('die--wildcard');
  // Reverted 2026-07-29: die-face glyphs made the small colored dice harder to read, not easier --
  // back to a plain digit (unlike the board slot requirements / SET_DIE_VALUE icons, which keep the
  // ⚀-⚅ glyphs; this revert is specific to the actual player dice).
  node.querySelector('.die__value').textContent = die.wildcard ? '☆' : (die.value === null || die.value === undefined ? '' : die.value);
  return node;
}

function renderResourceBadge(resource, count) {
  // Confirmed 2026-07-29: the dot's color alone identifies the resource -- no letter label needed.
  const badge = el('span', 'resource-badge');
  badge.dataset.resource = resource;
  badge.title = resource; // still discoverable on hover/for accessibility, just not shown visually
  // VP (2026-08-16, per user report: "VPアイコン資源Cと見分けがつきにくい" -- --resource-vp's gold and
  // --resource-c's yellow read too similarly as a same-size dot) -- no dot at all, just "{count}VP" text,
  // same convention resourceItemNodes already uses for the ADD(...) effect-icon display (VP has never
  // had a dot there, confirmed 2026-07-29: "VPは常にプレーンテキスト").
  if (resource === 'VP') {
    badge.appendChild(document.createTextNode(`${count}VP`));
    return badge;
  }
  const dot = el('span', 'resource-badge__dot');
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(`${count}`));
  return badge;
}

/** Renders costString's resource dots, with the card's own deck color (faceId's leading A/B/C letter)
 * sorted first (2026-08-04, per user feedback: "C系のカードの資源表示の順番 ACではなくCAの順番にして
 * ください"). A/B decks' COST data already lists their own color first (A004A "A,B", B004A "1B,1C"), so
 * this sort is a no-op for them -- C004-008's data lists it second ("1A,1C"), inconsistent with that
 * established convention purely as a data-authoring quirk, not an intentional exception. Sorting by
 * "matches the card's own color" fixes C without a C-only special case. faceId is optional (M/JOB/CON/
 * QST callers pass none, and see no reordering -- they have no "own color" to prioritize anyway). */
function renderCostBadges(container, costString, faceId) {
  if (!costString) return;
  const ownColor = faceId && /^[ABC]/.test(faceId) ? faceId[0] : null;
  const parts = costString.split(',');
  if (ownColor) parts.sort((a, b) => (b.trim().endsWith(ownColor) ? 1 : 0) - (a.trim().endsWith(ownColor) ? 1 : 0));
  for (const part of parts) {
    const match = /^(\d*)([A-Z]+)$/.exec(part.trim());
    if (!match) continue;
    const [, countStr, resource] = match;
    container.appendChild(renderResourceBadge(resource, countStr || 1));
  }
}

function renderShops(state) {
  renderShopGrid(state);
  renderQsts(state);
}

/**
 * Builds one card visual (the same look used in the shop) for faceId. Shared
 * by the shop grids and the owned-cards sidebar (confirmed 2026-07-29: owned
 * cards should look like shop cards, not a plain chip list).
 * @param {string} faceId
 * @param {{tapped?:boolean, req?:string}} [options]
 */
/**
 * Cards whose whole effect is "MAP{n}.CURRENT_AREA=AREA{n}{tier}" (e.g. A001A, A006A) exist purely
 * to claim ownership of that AREA -- confirmed 2026-07-29: show a label instead of the raw card id.
 * **2026-08-05 update, per user feedback ("AC系のカード NAMEをカード上部に反映させてください"):** a
 * customized NAME is now shown at the top of the card instead (see fillCardFace's own
 * q('.shop-card__name') line, and factsForFaceId's `name` field) -- this function now only ever
 * produces the older auto-generated "{tier-A AREA name}の所有" fallback (always the tier-A/"base
 * place" name even when the assignment's actual target is a higher tier, since the place is the same
 * regardless of which tier owning it unlocked), and only for a card whose NAME hasn't been customized
 * yet (still equals its own faceId) -- keeps the effect area from just showing raw DSL text for B/C
 * decks or future A cards before their NAME is filled in, without duplicating an already-customized
 * name in two places on the same card.
 */
function areaOwnershipLabel(faceId, effects) {
  if (!effects || effects.length !== 1) return null;
  const match = /^MAP(\d+)\.CURRENT_AREA=AREA\d+[ABC]?$/.exec(effects[0].text);
  if (!match) return null;
  const row = dataLoaderMod.getCardRow(INDEX, faceId);
  if (row.NAME && row.NAME !== faceId) return null;
  return `${areaName(`AREA${match[1]}A`)}の所有`;
}

/** "{AREA名}LV{n}の支配" (e.g. "城下町LV1の支配", an area-ownership card's own INST text) -- split onto
 * 2 lines with the area name shown a bit bigger than the rest (2026-08-16, per user request: "城下町
 * LV1／　　の支配 という配置にして　城下町の文字をもう少し大きく"). .shop-card__effect is already a
 * column flexbox (see its own doc), so appending 2 separate block-level children is enough to stack
 * them -- no explicit line-break element needed. Falls back to plain unstyled text for anything not
 * matching this exact shape (the auto-generated "{AREA}の所有" fallback text, or any future
 * area-ownership INST that doesn't follow the "...LV{n}の支配" pattern). */
function renderAreaOwnershipEffectText(container, text) {
  const match = /^(.+?)(LV\d+)(の支配)$/.exec(text || '');
  if (!match) {
    container.appendChild(document.createTextNode(text || ''));
    return;
  }
  const [, areaLabel, lv, suffix] = match;
  const line1 = document.createElement('div');
  line1.appendChild(el('span', 'area-ownership-name', areaLabel));
  line1.appendChild(document.createTextNode(lv));
  container.appendChild(line1);
  container.appendChild(el('div', null, `　　${suffix}`));
}

/**
 * One row per effect (confirmed 2026-07-29: a card can have both an ONCE and a TAP effect, e.g.
 * B001A's ADD(wD) + SET_DIE_VALUE(SELF1|2), shown as two stacked rows). Flattens the icon builder's
 * own .action-icons wrapper into this row instead of nesting, so the TAP-cost prefix (if any) and
 * the effect's icons sit in a single flex row together.
 *
 * icons.dataset.tapPrefixEmbedded (2026-08-25, see buildOnBuildAddResourceIcon's own doc): an icon
 * builder can embed the ⤵ TAP-cost marker itself, at a bespoke position other than the very front, by
 * setting this and placing the marker in its own returned row -- skips the auto-prepend below so it
 * isn't duplicated.
 */
/** allowTextFallback=false (JOB/CON, confirmed 2026-07-30): returns null instead of a raw-DSL-text
 * row when no icon mapping exists, so the caller can omit that effect entirely (see fillCardFace). */
function buildEffectRow(effect, allowTextFallback = true) {
  const icons = buildActionIcons(effect.text);
  if (!icons && !allowTextFallback) return null;
  const tapPrefixEmbedded = !!(icons && icons.dataset && icons.dataset.tapPrefixEmbedded);
  // A stack (e.g. BUILD + the ADD(BZ) "軽減Z" line below it) keeps its rows separate instead of
  // being flattened into one -- the TAP-cost prefix only goes on the stack's first row.
  if (icons && icons.classList.contains('action-icons-stack')) {
    const rows = Array.from(icons.children);
    const firstRow = rows.shift();
    if (effect.source === 'TAP' && !tapPrefixEmbedded) firstRow.insertBefore(actionEmoji(TAP_COST_ICON), firstRow.firstChild);
    const wrapper = el('div', 'action-icons-stack');
    wrapper.appendChild(firstRow);
    rows.forEach((r) => wrapper.appendChild(r));
    return wrapper;
  }
  const row = el('div', 'action-icons');
  if (effect.source === 'TAP' && !tapPrefixEmbedded) row.appendChild(actionEmoji(TAP_COST_ICON));
  if (icons) {
    Array.from(icons.childNodes).forEach((child) => row.appendChild(child));
  } else {
    row.appendChild(document.createTextNode(effect.text));
  }
  return row;
}

/** Each A/B/C deck has exactly one fixed EMBLEM for all its cards/tiers (confirmed 2026-07-29 from
 * data/game.json: A=地, B=天, C=人) -- derived from the deck letter rather than hardcoded per card.
 * Monuments differ (each M card has its own individual emblem *counts*, confirmed 2026-07-30: 0-3 of
 * 天/地/人 each, from the M sheet's EMBLEM_A/EMBLEM_B/EMBLEM_C columns using this same A/B/C
 * convention) -- read live off the card's own row (2026-07-30: replaces the old
 * CARD_FACTS[faceId].emblem hand-transcription). Return shape is always a {天?,地?,人?: count} object
 * -- emblemChars() below turns it into an ordered, one-char-per-emblem list for rendering/counting. */
const EMBLEM_BY_DECK = { A: '地', B: '天', C: '人' };
const EMBLEM_ORDER = ['天', '地', '人'];
// 2026-08-21, per user request: M007/中央広場(2,2,2=6 chars -> 3 rows), M008/聖王城(2,2,0=4 chars -> 2
// rows), M009/円形闘技場(2,0,2=4 chars -> 2 rows), M011/聖域(4,0,0=4 chars -> 2 rows), M012/大交易所
// (0,0,4=4 chars -> 2 rows) -- all happen to want exactly "2 per row", so one shared chunk size covers
// all of them. See fillCardFace's own emblem-rendering doc for why 祝福 (the only other multi-emblem
// card in the data) is deliberately left alone -- opted OUT of exactly this wrapping back on 2026-08-18.
// M402/王都建設 (2026-08-25, SHOP201-203 rework's own new monument, EMBLEM 3,3,3=9 chars): per user
// spec "王都建設のエンブレム３行にして　重なってもいい" -- 3 per row (3 rows of 3), explicitly allowed
// to overlap adjacent card content rather than needing extra vertical space reserved for it.
const EMBLEM_ROW_CHUNK_SIZE = { M007: 2, M008: 2, M009: 2, M011: 2, M012: 2, M402: 3 };
function emblemForFaceId(faceId) {
  if (isNormalDeckCard(faceId)) return { [EMBLEM_BY_DECK[faceId[0]]]: 1 };
  // Not restricted to M any more (2026-08-16, per user report: CON006B「祝福」has real EMBLEM_A/B/C
  // data (1,1,1) that wasn't showing up in the player stats panel) -- reads any row's own EMBLEM_A/B/C
  // columns generically, same as src/executor.js's emblemCountsForRow (the real scoring engine) already
  // does for TOTAL_EMBLEM_COUNT/QST goals, so this UI-only copy can't drift from what actually scores.
  let row;
  try {
    row = dataLoaderMod.getCardRow(INDEX, faceId);
  } catch (e) {
    return null;
  }
  const counts = {};
  if (Number(row.EMBLEM_A)) counts['地'] = Number(row.EMBLEM_A);
  if (Number(row.EMBLEM_B)) counts['天'] = Number(row.EMBLEM_B);
  if (Number(row.EMBLEM_C)) counts['人'] = Number(row.EMBLEM_C);
  return Object.keys(counts).length ? counts : null;
}

/** {天:1,地:1} -> ['天','地'], in EMBLEM_ORDER's fixed order (regardless of the object's own key
 * order) and repeating a char count-many times (e.g. {人:2} -> ['人','人']). */
function emblemChars(emblemCounts) {
  const chars = [];
  for (const e of EMBLEM_ORDER) {
    for (let i = 0; i < (emblemCounts[e] || 0); i++) chars.push(e);
  }
  return chars;
}

/** A/B/C decks' LEVEL column tracks the tier suffix letter 1:1 (confirmed 2026-07-29 from
 * data/game.json: tier A -> LEVEL 1, tier B -> LEVEL 2) -- derived from the faceId's own tier suffix
 * rather than hardcoded per card. M/JOB/CON/RESOURCE have no LEVEL at all, so no badge for those
 * (confirmed 2026-07-29: "LVがないものは書かない"). */
const LEVEL_BY_TIER = { A: 1, B: 2, C: 3 };
function levelForFaceId(faceId) {
  if (!isNormalDeckCard(faceId)) return null;
  const tier = faceId.match(/([ABC])$/);
  return tier ? LEVEL_BY_TIER[tier[1]] : null;
}

/**
 * Fills one face's worth of card content (emblem/level/id/cost/effect/vp/req) into root's children.
 * Used for both the card's own front (root = the outer .shop-card, direct children only, since the
 * nested .shop-card__back has its own copies one level deeper) and its sibling-tier back face (root
 * = .shop-card__back itself, whose subtree only has one copy of each so no scoping is needed).
 * @returns {{tall: boolean}} whether this face needs the taller effect-row layout
 */
// The one CON face whose own アイコン text (2026-08-17, per user request: "制約なし　LV１が不要　色D
// MAX3　なども...同じ大きさと濃さに" -- enlarging .card-note to match .action-count, see style.css)
// visibly overflows its card at the enlarged size ("憤怒など　文字数が多く　崩れてしまうものは今のまま
// で") -- confirmed by measuring every CON face's own rendered .card-note against its card's bottom
// edge; 憤怒 (currently CON005B) was the only one that actually overflowed (+9.6px), so it alone keeps
// the smaller/muted .card-note--compact look instead. This is a physical-id literal, same fragility as
// scoring.js's BESPOKE_QST_RANK_CON_FACES/executor.js's PAYMENT_CHOICE_CON_FACE_ID -- if game.xlsx's CON
// sheet ever gets reorganized again (see the 2026-08-17 CON-sheet-reorg incident), re-measure and update
// this to wherever 憤怒 ends up, rather than assuming CON005B forever.
const CARD_NOTE_COMPACT_FACE_ID = 'CON005B';

/** Fills container with iconText, swapping in a real icon for two special characters instead of showing
 * them as plain text: every "✖" becomes its own bigger span (2026-08-17, per user request: "✖の大きさ
 * だけ１.8倍にして" -- 傲慢's own "最多AREA　✖\n　▽\nLVUP　✖" is currently the only CON アイコン text
 * containing it, confirmed via a full sheet scan), and every bare "Z" becomes the actual Z resource dot
 * (2026-08-17 follow-up, per user request: "INSTに書かれているZをアイコンに変えて下さい" -- 色欲's own
 * "Z→K\nターン終了時" is currently the only CON アイコン text containing a bare Z, confirmed the same
 * way). Preserves the string's own \n line breaks via .card-note's white-space:pre-line, same as a plain
 * textContent assignment would -- just split across several text nodes instead of one, plus the icon
 * elements in between. */
function fillCardNoteContent(container, iconText) {
  const parts = iconText.split(/(✖|Z)/);
  for (const part of parts) {
    if (!part) continue;
    if (part === '✖') container.appendChild(el('span', 'card-note__x', '✖'));
    else if (part === 'Z') container.appendChild(actionDot('Z'));
    else container.appendChild(document.createTextNode(part));
  }
}

function fillCardFace(root, faceId, options, directChildrenOnly) {
  const q = (sel) => (directChildrenOnly ? root.querySelector(`:scope > ${sel}`) : root.querySelector(sel));
  const facts = factsForFaceId(faceId);

  // Monuments can carry 0-3 emblems now (confirmed 2026-07-30: game.xlsx's M sheet has separate
  // EMBLEM_A/B/C count columns, e.g. {地:1,天:1}) -- one individually-colored char per emblem, side
  // by side, rather than a single string in one color. A/B/C decks still only ever have a single
  // emblem (EMBLEM_BY_DECK, wrapped to the same {emblem:1} shape by emblemForFaceId).
  const emblem = emblemForFaceId(faceId);
  const emblemEl = q('.shop-card__emblem');
  if (emblem) {
    const chars = emblemChars(emblem);
    // Always one line regardless of count (2026-08-16 for up to 3, widened 2026-08-18 per user request
    // for 祝福 specifically -- "縦に並べると見栄えが悪いので...横にして" -- to every count; see
    // .shop-card__emblem's own doc in style.css) -- EXCEPT 中央広場/聖王城/円形闘技場/聖域/大交易所
    // (2026-08-21, per user request), which now wrap into fixed-size rows instead (see
    // EMBLEM_ROW_CHUNK_SIZE below). 祝福 -- and every other multi-emblem card -- deliberately keeps the
    // single-line behavior unchanged; only these 5 were asked for. NAME/cost/VP/etc no longer shift down
    // to avoid overlapping
    // the emblem badge at all, for ANY monument (2026-08-21, per user follow-up: "すべてのモニュメントの
    // NAMEなどを中央広場と同じ位置にして") -- see .shop-card--monument .shop-card__id's own doc in
    // style.css, which now sits at margin-top:0 (the same position a monument with no emblem at all would
    // use) unconditionally, superseding the old per-card override this used to need.
    const chunkSize = EMBLEM_ROW_CHUNK_SIZE[faceId];
    if (chunkSize) {
      emblemEl.classList.add('shop-card__emblem--multi-row');
      for (let i = 0; i < chars.length; i += chunkSize) {
        const rowEl = el('div', 'shop-card__emblem-row');
        for (const char of chars.slice(i, i + chunkSize)) {
          const charEl = el('span', 'shop-card__emblem-char', char);
          charEl.dataset.emblem = char;
          rowEl.appendChild(charEl);
        }
        emblemEl.appendChild(rowEl);
      }
    } else {
      for (const char of chars) {
        const charEl = el('span', 'shop-card__emblem-char', char);
        charEl.dataset.emblem = char;
        emblemEl.appendChild(charEl);
      }
    }
  }

  // .shop-card__level (the "LV1"/"LV2" badge under the emblem) is no longer populated here (2026-08-25,
  // per user request: "ABCカード NAMEにLV1と入れました そのため 今 エンブレムの下に書かれている LV1
  // LV2を消してください") -- every A/B/C face's own NAME column now already ends in "LV1"/"LV2" itself
  // (e.g. A001A's NAME is "城下町の支配LV1"), so the separate badge became a duplicate. The element and
  // its :empty{display:none} CSS rule stay (levelForFaceId itself is also still used elsewhere, e.g. the
  // built-LV1/LV2-count stat above), so an empty .shop-card__level here just collapses away as normal.

  // CON cards are the one exception (2026-08-16, per user request: "CONカードIDが書かれている部分を
  // 消してその場所に得られる初期資源を書いて") -- the id spot shows the resources its ONCE grants
  // instead, via the same buildActionIcons pipeline every other card's ONCE/TAP/PASSIVE effect already
  // renders through (see .shop-card--con .shop-card__id's badge-compaction CSS for the layout side).
  // Every other deck now prefers its own customized NAME here when it has one, falling back to the raw
  // id otherwise (2026-08-16, per user request: originally JOB/M-only -- see the now-removed top title
  // this replaced -- broadened to every deck once the separate title was removed, so a deck whose NAME
  // isn't customized yet doesn't go from "shown once, up top" to "not shown anywhere").
  const idEl = q('.shop-card__id');
  const onceIcon = faceId.startsWith('CON') ? buildActionIcons(facts.once) : null;
  if (faceId.startsWith('CON')) {
    // NAME + icon + emblem all share this one grid area now (2026-08-17, per user request/mockup:
    // "裏切　⚡🎲🎲 / 　　　　　🎲🎲", "祝福　⚡3VP / 　　　　天地人") -- NAME pinned to column 1/row 1
    // (see .shop-card__name's own CSS), icon wrapping onto its own extra line(s) within column 2 when it
    // doesn't fit one row (4 dice for CON001B), and the emblem (normally the card-wide, absolutely-
    // positioned top-right corner badge every other deck still uses) relocated into column 2/row 2 here,
    // directly under the icon, instead of overlapping the corner. Moved (not cloned) so there's still
    // only one emblemEl in the DOM.
    const nameEl = q('.shop-card__name');
    if (facts.name) nameEl.appendChild(el('span', 'shop-card__name-text', facts.name));
    if (onceIcon) nameEl.appendChild(onceIcon);
    if (emblem) nameEl.appendChild(emblemEl);
  } else if (/^R\d/.test(faceId)) {
    // RESOURCE cards show neither NAME nor ID (2026-08-17, per user request -- see
    // .shop-card--resource's own doc on the buildCardVisual side for the matching border-line removal).
    // idEl is simply left empty; its own :empty{display:none} rule collapses it with no layout gap.
  } else if (facts.name) {
    idEl.textContent = facts.name;
  } else {
    idEl.textContent = faceId;
  }
  // Thematic title above the id, removed 2026-08-16 (per user report: "すべてのカードがNAMEが２回表示
  // されています 青文字のほうのNAMEを削除して") -- every non-CON card's NAME shows once, in the id spot
  // itself (see the else-if branch above and factsForFaceId's own name field), not duplicated up here
  // too. #tpl-shop-card's .shop-card__name node is left unpopulated for those decks -- its own
  // :empty{display:none} rule collapses it with no layout gap. CON alone populates it (see above), now
  // combined with its onceIcon on one row per 2026-08-17's redesign.

  renderCostBadges(q('.shop-card__cost'), facts.cost, faceId);
  q('.shop-card__vp').textContent = facts.vp ? `${facts.vp} VP` : '';
  // Corrected 2026-07-29: a monument's req (e.g. "目 >=12") IS part of that specific card (each
  // monument has its own threshold), unlike normal/special cards' req which is a slot property --
  // so only monuments pass req here; everything else's req lives in the slot caption instead.
  renderDiceThresholdReq(q('.shop-card__req'), options.req);
  q('.shop-card__start-order').textContent = facts.startOrder !== null && facts.startOrder !== undefined ? `先攻順 ${facts.startOrder}` : '';

  let tall = false;
  // A pure MAP-assignment card (see areaOwnershipLabel's own doc) never falls through to the generic
  // icon/raw-text branch below, even once its NAME is customized and areaOwnershipLabel itself starts
  // returning null (2026-08-05 fix: without this check, that null was falling through to the generic
  // branch, which has no icon mapping for "MAP004.CURRENT_AREA=AREA004C" and showed it as raw DSL text
  // in the effect area right underneath the new top-of-card name -- this DSL shape was never meant to
  // be shown as raw text either way).
  const isAreaOwnershipCard = facts.effects && facts.effects.length === 1
    && /^MAP\d+\.CURRENT_AREA=AREA\d+[ABC]?$/.test(facts.effects[0].text);
  if (isAreaOwnershipCard) {
    // Prefer the card's own INST text once filled in (2026-08-05, per user feedback: "A系のカードアイ
    // コンに書いてほしい文言をINSTに書きました" -- e.g. A001A's INST is "城下町LV1の支配", distinguishing
    // it from A001B's "城下町LV2の支配" even though both share the same top-of-card NAME "城下町の支配").
    // Falls back to the auto-generated "{AREA}の所有" (areaOwnershipLabel) for any card whose INST
    // hasn't been filled in yet, same graceful-degradation reasoning as NAME's own fallback.
    const effectText = facts.inst || areaOwnershipLabel(faceId, facts.effects);
    if (options.showEffect && effectText) {
      tall = true;
      renderAreaOwnershipEffectText(q('.shop-card__effect'), effectText);
    }
  } else if (faceId.startsWith('CON')) {
    // CON cards (2026-08-15, per user request: "CONのアイコン表示をCONシートのアイコン欄を参考にして
    // 表示してほしい...アイコン欄に文章で書いてあるものはそのまま文章で...改行もそのままかいて") --
    // shown verbatim from the CON sheet's own hand-authored アイコン column instead of the DSL-icon-
    // lookup system every other card type below uses. That system had no icon builder for several CON
    // abilities (CON003A/CON005B used to each get their own ad-hoc .card-note patch for exactly this
    // gap -- superseded by this single, general mechanism now that the user has written a complete,
    // authoritative summary line for all 12 CON faces instead of patching gaps one at a time).
    // .card-note's white-space:pre-line preserves the column's own \n line breaks as-is.
    // suppressConNote (2026-08-18): 傲慢/CON004A-only, see its own call-site doc in renderPlayerCards.
    if (options.showEffect && facts.iconText && !options.suppressConNote) {
      tall = true;
      const noteClass = faceId === CARD_NOTE_COMPACT_FACE_ID ? 'card-note card-note--compact' : 'card-note';
      const noteEl = el('div', noteClass);
      fillCardNoteContent(noteEl, facts.iconText);
      q('.shop-card__effect').appendChild(noteEl);
    }
  } else if (options.showEffect && facts.name === '革命家') {
    // JOB010/革命家 (2026-08-21, per user spec: "革命の兆しを / 獲得する" in larger, bolder text than the
    // other bespoke JOB notes below -- this ability has no DSL representation at all either (see setup.
    // grantRevolutionaryBonusIfEarned's own doc), same class of exception, but reusing plain .card-note
    // read too small/light for what the user wanted here, hence .card-note--large instead of the base
    // class the other 3 bespoke notes use.
    tall = true;
    const noteEl = el('div', 'card-note card-note--large');
    noteEl.appendChild(document.createTextNode('革命の兆しを\n獲得する'));
    q('.shop-card__effect').appendChild(noteEl);
  } else if (options.showEffect && (facts.name === '開拓者' || facts.name === '吟遊詩人' || facts.name === '地主')) {
    // Bespoke JOB card-notes (開拓者/JOB009 2026-08-17, per user mockup: "無人AREAに色D / ▽ / ランダム
    // ABC"; 吟遊詩人/JOB008 and 地主/JOB011 2026-08-17, per user mockups: "エンブレム３個 / ▽ / Z　1VP"
    // and "LVアップAREA / ▽ / 〇/1VP", both "ABCZはアイコンで表記") -- none of these 3 abilities have any
    // DSL representation at all (see hasPioneerAbility/hasLandlordAbility's own docs in board.js, and
    // turn-flow.grantBardBonusIfEarned's for 吟遊詩人), so each is a one-off hand-built display, the same
    // class of exception CON003A/CON005B used to each get their own ad-hoc .card-note patch for before
    // the general CON アイコン column existed. "▽" is plain text (matching CON004A's own literal "▽" in
    // its card-note text), not actionTriggerDown()'s 🔽 emoji -- 開拓者's own mockup used the plain
    // triangle character specifically, reused here for the other two to stay visually consistent.
    tall = true;
    const noteEl = el('div', 'card-note');
    const iconRow = el('span', 'job-note-icon-row');
    if (facts.name === '開拓者') {
      noteEl.appendChild(document.createTextNode('無人AREAに色D\n▽\n'));
      for (const resource of ['A', 'B', 'C']) iconRow.appendChild(actionDot(resource));
    } else if (facts.name === '吟遊詩人') {
      noteEl.appendChild(document.createTextNode('エンブレム３個\n▽\n'));
      iconRow.appendChild(actionDot('C'));
      iconRow.appendChild(actionCount('1VP'));
    } else {
      noteEl.appendChild(document.createTextNode('LVアップAREA\n▽\n'));
      iconRow.appendChild(actionDot('K'));
      iconRow.appendChild(actionSuffix('/'));
      iconRow.appendChild(actionCount('1VP'));
    }
    noteEl.appendChild(iconRow);
    q('.shop-card__effect').appendChild(noteEl);
  } else if (options.showEffect && facts.effects && facts.effects.length) {
    // allowTextFallback (confirmed 2026-07-30): A/B/C cards fall back to raw DSL text for any
    // pattern buildActionIcons doesn't recognize yet (established 2026-07-29). JOB is new to icon
    // display and doesn't get that fallback -- an unmapped effect is just omitted (blank) rather
    // than showing raw DSL text, per instruction. See [[project-dice-wp-ui-requirements]].
    const allowTextFallback = options.allowTextFallback !== false;
    const rows = facts.effects
      .map((effect) => buildEffectRow(effect, allowTextFallback))
      .filter(Boolean);
    if (rows.length) {
      tall = true;
      const effectEl = q('.shop-card__effect');
      rows.forEach((row) => effectEl.appendChild(row));
    }
  }
  return { tall };
}

/** faceId's sibling tier face, e.g. C003A <-> C003B, CON001A <-> CON001B, Q001A <-> Q001B (confirmed
 * 2026-07-29/30: A/B/C decks only ever have tier A/B, never a tier C variant, per data/game.json;
 * CON and QST have the same A/B pattern, both extended to flip-on-click). null for M/JOB/RESOURCE,
 * which have no sibling face at all. Used by both buildCardVisual (shop-card flip) and
 * buildQstCardVisual (QST's own flip, see [[project-dice-wp-qst-spec]]). */
function siblingFaceId(faceId) {
  if (!isNormalDeckCard(faceId) && !/^CON\d/.test(faceId) && !/^Q\d/.test(faceId)) return null;
  if (faceId.endsWith('A')) return `${faceId.slice(0, -1)}B`;
  if (faceId.endsWith('B')) return `${faceId.slice(0, -1)}A`;
  return null;
}

/** 'A'/'B'/'C'/'M' for a card that gets its own deck-color styling (see .shop-card[data-deck] in
 * style.css, 2026-08-16 -- design confirmed via a mockup comparing background-tint/border-color/both,
 * user picked "背景タイント+枠線カラー併用"), or null for JOB/CON/QST/RESOURCE (no deck color). */
function deckForFaceId(faceId) {
  if (/^[ABC]\d/.test(faceId)) return faceId[0];
  if (/^M\d/.test(faceId)) return 'M';
  return null;
}

function buildCardVisual(faceId, options = {}) {
  const tpl = document.getElementById('tpl-shop-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const deck = deckForFaceId(faceId);
  if (deck) node.dataset.deck = deck;

  const front = fillCardFace(node, faceId, options, true);
  if (options.tapped) node.classList.add('shop-card--tapped');

  // Confirmed 2026-07-29 (revised): clicking a card flips it to reveal its sibling tier face (e.g.
  // C003A -> C003B) when we have data for it; falls back to a plain/blank back otherwise. Reverts
  // when the cursor leaves.
  const backEl = node.querySelector('.shop-card__back');
  const sibling = siblingFaceId(faceId);
  let backTall = false;
  if (sibling && cardFaceExists(sibling)) {
    backEl.classList.add('shop-card__back--face');
    backTall = fillCardFace(backEl, sibling, { showEffect: options.showEffect, allowTextFallback: options.allowTextFallback }, false).tall;
  }
  if (front.tall || backTall) node.classList.add('shop-card--tall');
  // Fixed (not just min-) height for CON cards specifically (2026-08-13, per user request: "CONの
  // カードの縦幅すべて同じ高さにそろえる") -- every CON face has exactly 2 effect rows (see
  // data/game.json's CON sheet), but one of those rows can itself render as a 2-sub-row icon stack
  // (e.g. IF(CARD_COUNT<=6,VP_MODIFIER(-2))) while another card's 2 rows are both single-line, so
  // .shop-card--tall's min-height alone still left real height variance between CON faces. See
  // .shop-card--con in style.css for the actual fixed value.
  if (faceId.startsWith('CON')) node.classList.add('shop-card--con');
  // 導き/兆しカード (B001-007): briefly capped to a fixed 118px height (2026-08-21, accepting content
  // overlap so every tall card shared one height) after enlarging the die-face glyph to 42px made these
  // grow taller than other cards. Reverted (2026-08-22, per user report -- カードリスト made the actual
  // overlap visible: "1VPがはみ出ています...縦幅の設定を以前のものに戻せますか") back to plain
  // .shop-card--tall's own min-height:118px, which lets the box grow to fit its real content instead of
  // overlapping it -- see .shop-card--tall in style.css. No dedicated class needed here any more.
  // 2026-08-21, mirroring .shop-card--con above, added so CON/JOB-specific icon sizing (see
  // .shop-card--job in style.css) can scope to JOB cards even outside .card-group__jobcon (e.g. the
  // job-pool draft view, which has no icon-sizing context of its own otherwise).
  if (faceId.startsWith('JOB')) node.classList.add('shop-card--job');
  // RESOURCE cards show neither NAME nor ID at all (2026-08-17, per user request: "初期資源カードにNAME
  // やIDの表示は不要なので消してください...それに従い横線も不要です") -- see fillCardFace's own idEl
  // branch for the text-suppression side; this class is what lets style.css also drop
  // .shop-card__effect's border-top divider line, which only made sense as a "below the id/cost header"
  // separator and now has nothing above it to separate from.
  if (/^R\d/.test(faceId)) node.classList.add('shop-card--resource');
  // Monuments (2026-08-18, per user report: "中央広場　円形闘技場　エンブレムとNAMEがかぶっています" --
  // a side effect of the emblem badge no longer wrapping to multiple rows, see .shop-card__emblem's own
  // doc) -- pushes NAME/cost/VP down slightly to clear the (now potentially wide) emblem row. See
  // .shop-card--monument in style.css for the actual offset.
  if (/^M\d/.test(faceId)) node.classList.add('shop-card--monument');

  // noInteraction (confirmed 2026-07-30): onboarding selection cards (JOB draft, CON face choice,
  // initial RESOURCE candidates -- see renderJobPool/renderConFacesRow/renderResourceChoice) reuse
  // this same card visual for consistent styling, but "click" there means "pick this card" -- so the
  // caller attaches its own click listener instead of this default one, and these cards get no
  // enlarge-tap affordance at all (a minor, pre-existing gap: their INST also isn't reachable this
  // way, same as when this used to be right-click-only -- not addressed here, out of scope of the
  // touch-parity request that prompted this rewrite).
  //
  // Unified single-tap model (2026-08-0X, replaces the old 3-gesture split of click=flip/right-
  // click=INST/dblclick=TAP -- iPad has no right-click or reliable dblclick, so mouse and touch now
  // share this one gesture): a plain tap anywhere on the card opens the enlarge modal (bigger visual +
  // INST text + a 裏側 button that flips *within* the modal, reusing the same --flipped class this
  // card would have used for its own inline flip). Cards with a directly-usable TAP ability carve out
  // their effect box as a separate, higher-priority tap zone that fires the ability instead -- see
  // attachTapToggle, which attaches to `.shop-card__effect` and calls stopPropagation() so this
  // card-wide listener doesn't also fire underneath it.
  if (!options.noInteraction) {
    const hasSiblingData = sibling && cardFaceExists(sibling);
    node.addEventListener('click', () => {
      const visualNode = buildCardVisual(faceId, {
        showEffect: options.showEffect,
        allowTextFallback: options.allowTextFallback,
        noInteraction: true,
      });
      const siblingVisualNode = hasSiblingData
        ? buildCardVisual(sibling, {
          showEffect: options.showEffect,
          allowTextFallback: options.allowTextFallback,
          noInteraction: true,
        })
        : null;
      showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null, siblingVisualNode);
    });
  }

  return node;
}

/** A006/B004 etc: owned card physicalId starts with A/B/C followed by a digit (JOB/CON/M/R don't). */
function isNormalDeckCard(physicalId) {
  return /^[ABC]\d/.test(physicalId);
}

/** A/B/C/M only -- same scope as the real engine's CARD_COUNT_SHEETS (src/executor.js), i.e. cards
 * actually placed via BUILD/UPGRADE. JOB/CON (drafted/dealt) and RESOURCE (received, not built) are
 * all excluded (confirmed 2026-07-30: "初期資源カード CON JOBは建築数にはいりません") -- used by
 * computePlayerBuildStats below, anywhere "built" cards are counted. */
function isBuiltCardPhysicalId(physicalId) {
  return isNormalDeckCard(physicalId) || physicalId.startsWith('M');
}

// ---------------------------------------------------------------------------
// QST (Quest) cards -- see src/qst.js for the real engine-side implementation. 2026-08-09: rank-based
// rewards replaced the original claim-based design (no more player action at all; see that file's own
// doc), so every mock/preview evaluator that used to live here (mockCardCount/mockEvalMetric) is gone
// -- the UI now calls qst.js's real evalGoalMetric/rankPlayersForQuest directly, same as any other
// real-engine call main.js makes, rather than approximating it.
// ---------------------------------------------------------------------------

/** The title line from a QST card's INST text (a short human-readable label, e.g. "建築数") -- falls
 * back to the raw GOAL DSL text (e.g. "CARD_COUNT(A,B,C)") if INST is missing, so nothing goes blank
 * for data that hasn't been filled in yet. No "目標：" prefix (removed 2026-08-10, per user request). */
function questGoalDisplayText(facts) {
  return facts.inst || facts.goal;
}

/** Plain-text reward summary (e.g. "ADD(3VP)" -> "3VP", "ADD(2K,BZ)" -> "2K+BZ"). Every QST row's
 * REWARD1/2/3 cell is a bare ADD(...), so no need for the full DSL parser here. An implicit count of 1
 * (e.g. "ADD(VP)") is displayed with an explicit "1" (e.g. "1VP") -- the DSL itself omits it by
 * convention, but the user's own worked example for this UI wrote it out ("3位1VP"), so the display
 * spells it out even though the underlying cell doesn't. Falls back to the raw cell text for anything
 * that isn't a bare ADD(...). */
function questRewardValueText(rewardDsl) {
  const match = /^ADD\((.*)\)$/.exec((rewardDsl || '').trim());
  if (!match) return rewardDsl || '';
  return match[1].split(',').map((part) => (/^[A-Z]/.test(part.trim()) ? `1${part.trim()}` : part.trim())).join('+');
}

/** How much VP a REWARD cell actually grants, as a number (questRewardValueText's numeric counterpart --
 * that one formats "ADD(4VP)" for display, this one answers "4"). Parsed through the real DSL pipeline
 * rather than by regex so an unusual reward shape can't silently mis-total; anything that isn't a
 * literal-count VP grant contributes 0. Used by the standings panel's QST projection below. */
function questRewardVpAmount(rewardDsl) {
  if (!rewardDsl) return 0;
  let vp = 0;
  for (const cmd of commandBuilderMod.lowerProgram(dslParserMod.parse(rewardDsl))) {
    if (cmd.type !== 'ADD') continue;
    for (const item of cmd.items) {
      if (item.resource === 'VP' && item.count.kind === 'literal') vp += item.count.value;
    }
  }
  return vp;
}

/** VP this player would collect from QST cards if the game ended right now -- the parenthesised "(+8)"
 * figure in the standings panel (2026-08-11, per user request: "カッコ内はQSTカードのVP").
 *
 * A projection, not a balance: QST rewards are only actually granted at GAME_END
 * (qst.resolveEndGameRewards), so a "current QST VP" reading would sit at 0 for the entire game and tell
 * the player nothing. Recomputed from the live standings each render via the same
 * qst.rankPlayersForQuest every other QST display uses, so it moves as the rankings do -- and once the
 * game really does end, state.qstRewardsGranted holds the settled amount and standingsRows uses that
 * instead (see its own comment), so the number never contradicts what was actually awarded. */
function projectedQstVpForPlayer(state, playerId) {
  let total = 0;
  for (const faceId of Object.keys(state.quests || {})) {
    const entry = qstMod.rankPlayersForQuest(state, INDEX, faceId).find((r) => r.playerId === playerId);
    if (!entry || entry.rank > qstMod.REWARD_FIELDS.length) continue;
    total += questRewardVpAmount(dataLoaderMod.getQstRow(INDEX, faceId)[qstMod.REWARD_FIELDS[entry.rank - 1]]);
  }
  return total;
}

/** playerId's own CON face's VP penalty, live-projected the same way projectedQstVpForPlayer is (a
 * live standings preview, not the settled GAME_END amount) -- the parenthesised "(-4)" figure next to
 * QST in the standings panel (2026-08-17, per user request: "マイナスのVPペナルティがあるCONは順位表示
 * のところでQSTの右隣にそれを表示してほしい"). Reuses scoring.conCardOwnVpEffect, the exact same
 * function GAME_END's real computeFinalScore calls, so this can never drift from what actually gets
 * scored (e.g. CON001B/004B's own QST-rank-based penalties recompute live as rankings shift, same as
 * projectedQstVpForPlayer's own bonus figure does). 0 (hidden, see buildStandingsPanelNode) for a
 * player with no CON chosen yet, or whose CON face has no negative effect of its own. */
function conPenaltyForPlayer(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player.conPhysicalId || !player.conFace) return 0;
  const conFaceId = `${player.conPhysicalId}${player.conFace}`;
  return scoringMod.conCardOwnVpEffect(state, INDEX, playerId, conFaceId);
}

/** Static preview fill for QST's back face (the sibling face -- see siblingFaceId): id + GOAL +
 * plain REWARD1/2/3 value labels. There's no live quest state for a face that was never actually
 * revealed this game, so this is informational only (matches CON/A/B/C's click-to-flip preview, which
 * is likewise just "what's on the other side", not live state). */
function fillQstBackFace(backEl, faceId) {
  const facts = factsForQstFaceId(faceId);
  backEl.querySelector('.qst-card__id').textContent = faceId;
  backEl.querySelector('.qst-card__goal').textContent = facts.goal;
  const rewardsEl = backEl.querySelector('.qst-card__back-rewards');
  ['1位', '2位', '3位'].forEach((label, i) => {
    rewardsEl.appendChild(el('div', 'qst-card__reward', `${label}　${questRewardValueText(facts.rewards[i])}`));
  });
}

/**
 * Builds one QST card's visual: a live, always-current standings preview (2026-08-09, replacing the
 * earlier claim-progress design -- see src/qst.js's own doc for the full redesign). Title line is
 * "目標：{INST}"; below it, one column per reward tier (1位/2位/3位) shows that tier's reward text and
 * the color swatch of whoever currently holds that rank (qstMod.rankPlayersForQuest -- always
 * recomputed fresh from current game state, since there's no per-card claim state left to read). No
 * player interaction beyond the shared tap-to-enlarge -- QST has no player-facing action at all
 * anymore; rewards are granted automatically, once, at GAME_END (qst.resolveEndGameRewards).
 * Distinct DOM shape from buildCardVisual's shop-card (this layout doesn't fit that template), but
 * still reuses showCardEnlargeModal for the tap-to-enlarge description.
 */
function buildQstCardVisual(faceId, state, options = {}) {
  const tpl = document.getElementById('tpl-qst-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const facts = factsForQstFaceId(faceId);

  node.querySelector(':scope > .qst-card__goal-line').textContent = questGoalDisplayText(facts);

  // showLiveRanking (2026-08-22, per user report on the テストゲーム開始 QST picker/カードリストの
  // QST一覧: "最多エンブレムやエンブレム総数で１のキャラがいて持っているのが分かってしまう") -- defaults
  // true (every REAL in-game QST display: the standings panel, the enlarge modal) but both picker/
  // browser contexts pass this false explicitly. Deliberately kept separate from showRankHeaders below,
  // which only controls the "1位　4VP" text label (already false in those same 2 contexts, for an
  // unrelated reason -- a shared legend elsewhere already says it once) -- conflating the two would have
  // wrongly hidden the real standings panel's own values/swatches too whenever ITS showRankHeaders
  // happens to be false (sharedRewards, see renderQsts). showLiveRanking instead governs the actual
  // per-player VALUE and the colored ownership swatches below, which read the CURRENT live game's real
  // state regardless of showRankHeaders -- exactly what leaked an in-progress/not-yet-started game's
  // real card ownership in a context meant to be a neutral picker/reference, not a leaderboard.
  const showLiveRanking = options.showLiveRanking !== false;
  const ranking = qstMod.rankPlayersForQuest(state, INDEX, faceId);
  const colEls = node.querySelectorAll(':scope > .qst-card__ranks > .qst-card__rank-col');
  colEls.forEach((colEl, i) => {
    const rank = i + 1;
    const holders = ranking.filter((r) => r.rank === rank);
    // GOALメトリクスの現在値 (2026-08-10, per user request: "1位 4VP...の上にそれぞれの建築数を数字で
    // 書く 例 8 7 5") -- every holder of a given rank shares the same value (that's what ties them),
    // so just read the first one; blank when nobody currently sits at this rank at all (only possible
    // when 4+ players are tied at a higher rank, same "no swatches" case .qst-card__rank-players
    // already handles) or when showLiveRanking is off.
    colEl.querySelector('.qst-card__rank-value').textContent = showLiveRanking && holders.length ? holders[0].value : '';
    // "1位　4VP" per column: dropped from the in-panel cards (2026-08-10, per user request "３つも書く
    // 意味ありませんでした" -- the shared legend at the bottom of the panel says it once, and the rank
    // bands behind each column are what tie a column to its rank). Still drawn when there's no legend to
    // lean on: the enlarge modal shows one card alone, and a mixed-reward data set can't be summarised by
    // a single legend at all (see renderQsts). Removed rather than left empty so it doesn't leave a gap.
    const headerEl = colEl.querySelector('.qst-card__rank-header');
    if (options.showRankHeaders) headerEl.textContent = `${rank}位　${questRewardValueText(facts.rewards[i])}`;
    else headerEl.remove();
    const playersEl = colEl.querySelector('.qst-card__rank-players');
    playersEl.innerHTML = '';
    if (showLiveRanking) {
      for (const entry of holders) {
        const rankedPlayer = state.players.find((p) => p.id === entry.playerId);
        const swatch = el('span', 'qst-card__rank-player');
        swatch.dataset.color = rankedPlayer.color;
        swatch.title = rankedPlayer.name;
        playersEl.appendChild(swatch);
      }
    }
  });

  // Sibling-face preview (Q001A <-> Q001B) baked into the back element, same mechanism as every
  // other card type -- see siblingFaceId/fillQstBackFace. Falls back to a plain blank back when
  // there's no data for the sibling yet. Flipping to see it is done from inside the enlarge modal
  // (toggling qst-card--flipped there), not via a click on the inline card itself -- see below.
  const backEl = node.querySelector(':scope > .qst-card__back');
  const sibling = siblingFaceId(faceId);
  const hasSiblingData = sibling && qstFaceExists(sibling);
  if (hasSiblingData) {
    backEl.classList.add('qst-card__back--face');
    fillQstBackFace(backEl, sibling);
  }

  // Unified single-tap model, same as every other card type: a tap anywhere opens the enlarge modal
  // (bigger visual + INST + a 裏側 flip button). No other interaction to wire -- QST is pure display.
  if (!options.noInteraction) {
    node.addEventListener('click', () => {
      // showRankHeaders: the modal shows this one card outside the panel, with neither the shared
      // legend nor the rank bands to say which column is which -- so it prints "1位　4VP" itself.
      const visualNode = buildQstCardVisual(faceId, state, { noInteraction: true, showRankHeaders: true });
      const siblingVisualNode = hasSiblingData
        ? buildQstCardVisual(sibling, state, { noInteraction: true, showRankHeaders: true })
        : null;
      showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null, siblingVisualNode);
    });
  }

  return node;
}

/** The one reward set every revealed QST card shares, as display strings (e.g. ['4VP','2VP','1VP']), or
 * null if they don't all agree. Data-driven rather than hardcoded (2026-08-10): today every QST row's
 * REWARD1/2/3 really is the same 4VP/2VP/1VP, which is exactly why the user asked to stop repeating it on
 * all three cards -- but if a future card ever differs, one shared legend would be actively misleading, so
 * that case returns null and each card prints its own per-rank headers again instead (see renderQsts). */
function sharedQuestRewardTexts(faceIds) {
  if (faceIds.length === 0) return null;
  const perCard = faceIds.map((faceId) => factsForQstFaceId(faceId).rewards.map(questRewardValueText));
  const first = perCard[0];
  const allAgree = perCard.every((texts) => texts.every((text, i) => text === first[i]));
  return allAgree ? first : null;
}

/** Fills the shared "1位 4VP / 2位 2VP / 3位 1VP" legend under the QST panel, or hides it outright when
 * the revealed cards don't share one reward set (see sharedQuestRewardTexts). */
function renderQstLegend(sharedRewards) {
  const legend = document.getElementById('qst-legend');
  legend.hidden = !sharedRewards;
  if (!sharedRewards) return;
  legend.querySelectorAll('.qst-legend__cell').forEach((cell, i) => {
    cell.textContent = `${i + 1}位　${sharedRewards[i]}`;
  });
}

function renderQsts(state) {
  const container = document.getElementById('qst-slots');
  container.innerHTML = '';
  const faceIds = Object.keys(state.quests);
  // Either the legend says the rewards once for all 3 cards, or (mixed data) each card says its own --
  // never both, and never neither.
  const sharedRewards = sharedQuestRewardTexts(faceIds);
  for (const faceId of faceIds) {
    container.appendChild(buildQstCardVisual(faceId, state, { showRankHeaders: !sharedRewards }));
  }
  renderQstLegend(sharedRewards);
}

/**
 * The dice-value requirement (e.g. "目 1-6") is not part of a card's effect (confirmed 2026-07-29:
 * it's a property of the shop slot, not the card), so it's rendered outside the card box entirely,
 * in a caption below it -- see tpl-shop-slot. showReqCaption (true for M/NORMAL, false for SPECIAL)
 * controls whether shopReqForSlotId's caption is shown at all -- factsForFaceId's own .req still
 * covers monuments (their req travels with the card, not a fixed per-slot lookup). See renderShopGrid
 * for why SPECIAL passes false (SHOP201-203 sit directly under a NORMAL column with the identical
 * requirement already shown there).
 *
 * locked (2026-08-24, SHOP201-203 rework, default false): true when this card is visible but not yet
 * purchasable this round (board.specialShopMinRound > state.round) -- adds shop-slot--locked, which
 * style.css renders as a red X overlay, so it reads as "coming soon", not just an ordinary unaffordable
 * candidate. Only ever passed true by renderShopGrid's SPECIAL loop -- M/NORMAL never gate on round.
 * When true, also fills the same .shop-slot__req caption slot with "2Rから"/"3Rから"/"4Rから" (2026-08-25,
 * per user spec: "赤✖がついているカードの下に　2Rから　3Rから　4Rから　と書いて") -- takes priority over
 * showReqCaption, which is always false for SPECIAL anyway (see this doc's own paragraph above), so
 * there's no real conflict between the two captions in practice.
 *
 * discardWarning (2026-08-25, default false, only ever passed true by renderShopGrid's SPECIAL loop):
 * once a non-monument SHOP201-203 card is actually purchasable (locked is false), fills the same caption
 * slot with "4R捨札に" instead -- a warning that board.forceSpecialShopMonumentsAtRound4 discards it once
 * round 4 begins. Never combined with the locked caption above (confirmed with the user: "２行には　なら
 * ないはず", one caption line only) -- the caller is responsible for only ever passing discardWarning true
 * when locked is false, and monuments (which never get discarded) never get it at all.
 */
function buildShopSlotNode(slotId, faceId, showReqCaption, locked, discardWarning) {
  const slotTpl = document.getElementById('tpl-shop-slot');
  const slotNode = slotTpl.content.firstElementChild.cloneNode(true);
  if (locked) slotNode.classList.add('shop-slot--locked');
  const reqCaption = () => {
    if (locked) return `${boardMod.specialShopMinRound(faceId)}Rから`;
    if (discardWarning) return '4R捨札に';
    return showReqCaption ? shopReqForSlotId(slotId) : '';
  };
  if (!faceId) {
    slotNode.querySelector('.shop-slot__req').textContent = showReqCaption ? shopReqForSlotId(slotId) : '';
    const emptyTpl = document.getElementById('tpl-shop-card-empty');
    slotNode.querySelector('.shop-slot__card').appendChild(emptyTpl.content.firstElementChild.cloneNode(true));
    return slotNode;
  }
  const facts = factsForFaceId(faceId);
  // showEffect: true is safe for every shop card, incl. monuments -- buildCardVisual only grows
  // the card and shows an effect row when it actually has one (monuments have none).
  if (facts.req) {
    // Monuments: req is intrinsic to this specific card, shown inside the card box, not the slot
    // caption (corrected 2026-07-29).
    slotNode.querySelector('.shop-slot__card').appendChild(buildCardVisual(faceId, { req: facts.req, showEffect: true }));
  } else {
    slotNode.querySelector('.shop-slot__card').appendChild(buildCardVisual(faceId, { showEffect: true }));
  }
  slotNode.querySelector('.shop-slot__req').textContent = reqCaption();
  return slotNode;
}

// SHOP001-006 (monuments), SHOP101-106 (normal), and SHOP201-203 (special) all share one 6-column
// grid now (confirmed 2026-07-30, revised from separate rows): row1=monuments, row2=normal cards
// (both auto-placed, 6 items fill 6 columns exactly, no explicit placement needed), row3=special --
// each SHOP201-203 sits directly under whichever SHOP101-106 slot has the SAME dice range, so those
// get an explicit grid-column/grid-row and the remaining row-3 cells stay empty.
//
// Derived from the SHOP sheet rather than hardcoded (2026-08-11): the pairing IS "same dice range", so
// reading it from the data keeps the layout correct by construction. This started as a literal
// {SHOP201:1, SHOP202:3, SHOP203:5} map, which silently encoded the old 目1-6/1-4/1-2 ranges -- when the
// user changed SHOP202/203 to 目1-5/1-4 ("SHOPの位置を左にずらして", i.e. columns 1/2/3 now), that map
// would have had to be hand-edited in lockstep or the special row would have pointed at the wrong
// columns. Returns null if a special slot's range matches no normal slot at all, which renderShopGrid
// falls back on rather than dropping the cell.
function specialSlotGridColumn(state, slotId) {
  const special = dataLoaderMod.getShopRow(INDEX, slotId);
  const normalSlotIds = Object.keys(state.shops.NORMAL.slots); // insertion order == grid order
  const matchIndex = normalSlotIds.findIndex((normalSlotId) => {
    const normal = dataLoaderMod.getShopRow(INDEX, normalSlotId);
    return normal.DICE_MIN === special.DICE_MIN && normal.DICE_MAX === special.DICE_MAX;
  });
  return matchIndex >= 0 ? matchIndex + 1 : null; // grid-column is 1-based
}

function renderShopGrid(state) {
  const container = document.getElementById('shop-combined-slots');
  container.innerHTML = '';
  for (const [slotId, faceId] of Object.entries(state.shops.M.slots)) {
    container.appendChild(buildShopSlotNode(slotId, faceId, true));
  }
  for (const [slotId, faceId] of Object.entries(state.shops.NORMAL.slots)) {
    container.appendChild(buildShopSlotNode(slotId, faceId, true));
  }
  const specialColumns = [];
  Object.entries(state.shops.SPECIAL.slots).forEach(([slotId, faceId], i) => {
    const locked = !!faceId && boardMod.specialShopMinRound(faceId) > state.round;
    // 2026-08-25, per user spec: "それ以外には　4R捨札に　を表記" -- see buildShopSlotNode's own doc.
    const discardWarning = !locked && !!faceId && boardMod.specialShopMinRound(faceId) < 4;
    const node = buildShopSlotNode(slotId, faceId, false, locked, discardWarning); // no req caption -- see buildShopSlotNode
    // Falls back to left-to-right order if the dice ranges don't line up, so a data change can never
    // make a special slot vanish -- it just sits somewhere less meaningful until the data is fixed.
    node.style.gridColumn = String(specialSlotGridColumn(state, slotId) || (i + 1));
    node.style.gridRow = '3';
    specialColumns.push(Number(node.style.gridColumn));
    container.appendChild(node);
  });

  // Standings panel fills whatever's left of row 3 (2026-08-11, per user request: "空いたスペースに順位表
  // を作りたい") -- the special cards moved to columns 1-3 when their dice ranges changed, leaving 4-6
  // free. Spanned from one past the rightmost special cell to the grid's end rather than a literal
  // "4 / -1", so it keeps filling exactly the leftover space if those cards ever shift again (same
  // reasoning as specialSlotGridColumn itself). Skipped entirely before round 1 actually starts, when
  // every score is 0 and there's no turnOrder to break the ties with, so the table would be noise.
  if (state.round >= 1) {
    const firstFreeColumn = (specialColumns.length ? Math.max(...specialColumns) : 0) + 1;
    const panel = buildStandingsPanelNode(state);
    panel.style.gridColumn = `${firstFreeColumn} / -1`;
    panel.style.gridRow = '3';
    container.appendChild(panel);
  }
}

/** Live standings, ordered exactly the way the game's own final scoring orders players: current score
 * descending, ties broken by position in the CURRENT round's turnOrder (2026-08-11, per user: "現在のVP
 * で表示　同じときは今のラウンドのスタプレ順" -- which is also the real tie-break rule from
 * [[project-dice-wp-flow-spec]], so scoring.rankPlayers already does precisely this and is reused rather
 * than re-sorted here). Tied players still get distinct sequential places (1位/2位, not "both 1位"),
 * matching the user's own worked example of two players on 3VP.
 *
 * The `vp` field deliberately EXCLUDES QST rewards so it never double-counts the parenthesised qstVp
 * beside it. During play that's automatic (QST VP isn't granted until GAME_END, so computeFinalScore
 * can't include it yet); once the game ends, resolveEndGameRewards has folded the real award into
 * player.resources.VP, so it's subtracted back out here -- the same split tools/ai_data_report.js uses
 * for its own QST-excluded averages.
 *
 * `conPenalty` (2026-08-17, see conPenaltyForPlayer's own doc) is purely informational, shown next to
 * qstVp -- unlike vp/qstVp it's never added or subtracted here, since computeFinalScore (and therefore
 * `vp` above) already has it baked in via conCardVpAdjustment/collectVpModifiers; this field only exists
 * so the panel can surface it as its own separate figure.
 * @returns {{playerId, name, color, place, vp, qstVp, conPenalty}[]}
 */
function standingsRows(state) {
  const granted = state.qstRewardsGranted || {};
  return scoringMod.rankPlayers(state, INDEX).map((entry, i) => {
    const player = state.players.find((p) => p.id === entry.playerId);
    const grantedQstVp = granted[entry.playerId] || 0;
    return {
      playerId: entry.playerId,
      name: player.name,
      color: player.color,
      place: i + 1,
      vp: entry.score - grantedQstVp,
      qstVp: state.phase === 'GAME_END' ? grantedQstVp : projectedQstVpForPlayer(state, entry.playerId),
      conPenalty: conPenaltyForPlayer(state, entry.playerId),
    };
  });
}

/** The standings panel: one fixed quarter per player, 2x2 (per user: "空いたスペースを4分割して表示",
 * and "4分割は　中の内容で分割位置をかえない" -- the quarters are equal fr units with their text clipped
 * rather than content-sized, so a longer name or a 2-digit score can never move the dividing lines). */
function buildStandingsPanelNode(state) {
  const panel = el('div', 'standings-panel');
  // Round indicator (2026-08-13, per user request: standings panel gets its own "ラウンド {n}/4" line)
  // so the round is visible right next to the ranking without having to look elsewhere -- the
  // player-cards header's own #round-indicator this originally matched was removed 2026-08-21, per user
  // request, leaving this as the only ラウンド display left. Spans both columns, sitting above the 2x2
  // player cells (see the matching grid-template-rows change in style.css).
  panel.appendChild(el('div', 'standings-panel__round', `ラウンド ${state.round}/4`));
  for (const row of standingsRows(state)) {
    const cell = el('div', 'standings-panel__cell');
    cell.appendChild(el('span', 'standings-panel__place', `${row.place}位`));
    const swatch = el('span', 'standings-panel__swatch');
    swatch.dataset.color = row.color;
    cell.appendChild(swatch);
    cell.appendChild(el('span', 'standings-panel__name', row.name));
    cell.appendChild(el('span', 'standings-panel__vp', `${row.vp}VP`));
    // Parenthesised QST projection -- see projectedQstVpForPlayer. Rendered even at 0 so the four cells
    // stay identical in shape (a cell that sometimes drops a element is exactly what would shift the
    // fixed quarters' contents around).
    cell.appendChild(el('span', 'standings-panel__qst', `（+${row.qstVp}）`));
    // CON penalty, right next to QST (2026-08-17, per user request: "マイナスのVPペナルティがあるCONは
    // 順位表示のところでQSTの右隣にそれを表示してほしい") -- unlike qstVp above, only shown for a player
    // who actually has one (conPenalty!==0), since most players never do; the fixed-quarter concern that
    // keeps qstVp always rendered doesn't apply here the same way -- this cell's own contents are a plain
    // flex row that clips its own name (see .standings-panel__cell's own CSS), not something the outer
    // panel's quarter tracks depend on the exact element count of.
    if (row.conPenalty !== 0) {
      cell.appendChild(el('span', 'standings-panel__con-penalty', `（${row.conPenalty}）`));
    }
    panel.appendChild(cell);
  }
  return panel;
}

function colorForPlayer(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  return player ? player.color : null;
}

/**
 * AREA sheet's NAME column, looked up by whichever face is currently active (confirmed 2026-07-29:
 * the tile shows the *current* AREA's name, not the MAP id -- so this must track tier flips, not
 * just the map's starting tier). Reads the AREA sheet's own NAME column directly (2026-08-06, fixing a
 * bug: this used to be hardcoded to areaId itself, a leftover from when every AREA row's NAME was still
 * a placeholder equal to its own ID -- so once the user started filling in real flavor names, e.g.
 * AREA001A="大農園" or renaming AREA008 from "城" to "王宮", this kept showing the raw ID/old name
 * instead of picking the change up).
 */
function areaName(areaId) {
  return dataLoaderMod.getAreaRow(INDEX, areaId).NAME;
}

/**
 * Next round's start-player order, per the confirmed algorithm (project_dice_wp_flow_spec.md): each
 * player's *last* castle placement (highest seq) determines recency, most-recent-first; a player who
 * never placed on the castle keeps their relative position from the current turnOrder, appended after
 * everyone who did place. Dice placed via GRANT_PLACE_ANYWHERE (countsForTurnOrder: false) don't count.
 */
function computeNextCastleTurnOrder(state) {
  const lastSeqByPlayer = new Map();
  for (const stack of state.maps.MAP008.slots) {
    for (const occ of stack) {
      if (occ.countsForTurnOrder === false) continue;
      const prev = lastSeqByPlayer.get(occ.playerId);
      if (prev === undefined || occ.seq > prev) lastSeqByPlayer.set(occ.playerId, occ.seq);
    }
  }
  const placed = [...lastSeqByPlayer.entries()].sort((a, b) => b[1] - a[1]).map(([playerId]) => playerId);
  const unplaced = state.turnOrder.filter((id) => !lastSeqByPlayer.has(id));
  return [...placed, ...unplaced];
}

function fillTurnOrderRow(rowEl, label, playerIds, state) {
  rowEl.appendChild(el('span', 'map-tile__turnorder-label', label));
  for (const playerId of playerIds) {
    const dot = el('span', 'player-panel__swatch player-panel__swatch--tiny');
    dot.dataset.color = colorForPlayer(state, playerId);
    dot.title = state.players.find((p) => p.id === playerId).name;
    rowEl.appendChild(dot);
  }
}

function renderBoard(state, next) {
  const board = document.getElementById('board');
  board.innerHTML = '';
  // Fee collection is a free action too (2026-07-30, real engine wiring pass 5) -- same
  // hasFinishedOnboarding-gated "real turn" eligibility as dice placement/other free actions, not
  // just "whoever state.currentPlayerIndex happens to point at" (which could still be mid-onboarding).
  const activePlayer = next ? state.players.find((p) => p.id === next.playerId) : null;
  // !isAiPlayer (2026-08-03): an AI player's turn is driven entirely by driveOneAiStep, never by
  // clicks -- this must stay null while it's their turn so the human can't collect their fee for them.
  const realTurnPlayerId = activePlayer && hasFinishedOnboarding(activePlayer) && !isAiPlayer(activePlayer.id) ? activePlayer.id : null;

  // Which SLOTs to light up for the currently selected die(s) (2026-08-0X, per user feedback: "配置可能
  // SLOTが光るようにして欲しい") -- "valid" here means both the basic slot rules AND the resulting AREA
  // action would actually do something (see board.previewPlaceDice/previewPlaceDiceGroup, which reuse
  // the real placeDice/placeDiceGroup on a throwaway clone so this can never drift from what clicking
  // would really do). Single die -> per-slot preview across every tile; 2+ dice -> the castle/AREA009
  // group-placement preview (the only two tiles a multi-select can ever target), which also reports
  // exactly which slots the auto-assignment would land on.
  const highlightOwner = selectedDieIds.length > 0
    ? state.players.find((p) => p.dice.some((d) => d.id === selectedDieIds[0]))
    : null;
  // JOB003/道化 (2026-08-19): a single selected ☆ die never uses the per-slot preview loop below --
  // board.placeWildcardDie auto-assigns its own slot, so there's nothing for the player to click among
  // (see attemptPlaceSelectedWildcardDie's own doc for the whole-tile click wiring this drives).
  const highlightOwnerIsWildcard = highlightOwner ? boardMod.hasWildcardDice(state, INDEX, highlightOwner.id) : false;

  // Two independent rows (see .board-row in style.css) so the castle tile can be wider than the
  // other bottom-row tiles without pushing anything into an orphan third row.
  const rows = [MAP_ORDER.slice(0, 5), MAP_ORDER.slice(5, 10)];
  for (const rowMapIds of rows) {
    const rowEl = el('div', 'board-row');
    for (const mapId of rowMapIds) {
      const mapState = state.maps[mapId];
      const areaRow = dataLoaderMod.getAreaRow(INDEX, mapState.currentAreaId);
      const isCastle = mapId === boardMod.CASTLE_MAP_ID;
      const slots = boardMod.getSlotRequirements(areaRow);
      const action = areaRow.ACTION;

      let highlightedSlots = null;
      const wildcardSingleSelection = highlightOwnerIsWildcard && selectedDieIds.length === 1;
      if (wildcardSingleSelection) {
        const context = { playerId: highlightOwner.id, colorPreference: {} };
        const preview = boardMod.previewPlaceWildcardDie(state, INDEX, context, selectedDieIds[0], mapId);
        if (preview.ok) highlightedSlots = new Set([preview.slotIndex]);
      } else if (highlightOwner && selectedDieIds.length === 1) {
        highlightedSlots = new Set();
        for (let i = 0; i < slots.length; i++) {
          const context = { playerId: highlightOwner.id, colorPreference: {} };
          if (boardMod.previewPlaceDice(state, INDEX, context, selectedDieIds[0], mapId, i)) highlightedSlots.add(i);
        }
      } else if (highlightOwner && selectedDieIds.length > 1
        && (mapId === boardMod.CASTLE_MAP_ID || mapId === boardMod.AREA009_MAP_ID)) {
        const preview = boardMod.previewPlaceDiceGroup(state, INDEX, { playerId: highlightOwner.id }, selectedDieIds, mapId);
        if (preview.ok) highlightedSlots = new Set(preview.touchedSlots);
      }
      const tpl = document.getElementById('tpl-map-tile');
      const node = tpl.content.firstElementChild.cloneNode(true);
      if (isCastle) node.classList.add('map-tile--castle');
      node.querySelector('.map-tile__id').textContent = areaName(mapState.currentAreaId);

      const tier = mapState.currentAreaId.match(/([ABC])$/);
      if (tier) {
        // Confirmed 2026-07-29: the whole tile's background follows the tier too -- see
        // .map-tile[data-tier] in style.css. The "tier A"/"tier B" text badge that used to sit in the
        // header was removed (2026-08-0X, per user request) in favor of the usage-fee display below,
        // which now lives in that same spot. The tint itself now follows the owner's own player color
        // (2026-08-06, per user feedback: "AREA001Bの背景色所有者のカラーに変える...背景色所有者がいる
        // AREA全てに適用") instead of a fixed pink regardless of who owns it -- see data-owner-color below.
        node.dataset.tier = tier[1];
        const ownerColor = mapState.feeOwnerId ? colorForPlayer(state, mapState.feeOwnerId) : null;
        if (ownerColor) node.dataset.ownerColor = ownerColor;
      }

      const slotsEl = node.querySelector('.map-tile__slots');
      // 6-slot AREAs (王宮/元老院) lay out as a fixed 3x2 grid instead of flex-wrap (2026-08-06, per
      // user feedback: "AREAのSLOTもう少し大きく1.5倍くらいでSLOT6個は2行に分ける") -- flex-wrap's wrap
      // point depends on tile width, which no longer reliably lands on 3+3 now that slots are bigger.
      if (slots.length === 6) slotsEl.classList.add('map-tile__slots--grid3');
      slots.forEach((requirement, i) => {
        const occupants = (mapState.slots[i] || []);
        const slotEl = el('div', 'slot');
        if (occupants.length > 0) {
          // A slot never holds more than 1 real occupant (2026-08-21, per user request, replacing the
          // earlier "stacking" model): GRANT_PLACE_ANYWHERE/JOB003's ☆ forced-fallback joining an already-
          // occupied slot now EVICTS whoever was there instead of stacking onto them (see board.js's
          // evictSlotOccupants) -- so occupants[occupants.length-1] (equivalently occupants[0], there's
          // only ever the one) is simply the slot's current occupant, full stop. This used to special-
          // case 王宮 to keep showing the *original* die under the old stacking model (2026-08-06); that
          // distinction no longer applies now that "joining" always means "replacing".
          slotEl.classList.add('slot--filled');
          const stack = el('div', 'slot__stack');
          const topOccupant = occupants[occupants.length - 1];
          // Look up the real die (2026-08-0X bug fix, per user report: "wDをSLOTにおいた後おいたダイス
          // が色Dになっています") -- this used to hardcode kind:'COLOR', so a placed white die (wD) was
          // drawn tinted in the player's own color instead of white. occupants only store
          // {playerId,dieId,value,...}, not kind, so it has to be looked back up from the owning
          // player's own dice (dice aren't removed from player.dice on placement, only placedMapId is set).
          const occupantOwner = state.players.find((p) => p.id === topOccupant.playerId);
          const occupantDie = occupantOwner && occupantOwner.dice.find((d) => d.id === topOccupant.dieId);
          stack.appendChild(renderDie({
            kind: occupantDie ? occupantDie.kind : 'COLOR',
            value: topOccupant.value,
            color: colorForPlayer(state, topOccupant.playerId),
            wildcard: !!topOccupant.isWildcard,
          }));
          slotEl.appendChild(stack);
        } else if (typeof requirement === 'number') {
          slotEl.appendChild(dieFace(requirement));
        } else {
          slotEl.textContent = requirement; // 'ANY'
        }
        // Click to attempt placing the currently-selected die(s) here (2026-07-30, real engine wiring
        // pass 2) -- see renderPlayers' die click handler (the other half) and placeSelectedDie.
        // Legality (value match / already occupied / duplicate value in this AREA / etc.) is decided
        // entirely by board.placeDice itself, not re-validated here -- clicking an ultimately-illegal
        // slot just surfaces that reason via placementMessage instead of silently doing nothing.
        // 2+ selected dice on the castle/AREA009 (2026-08-02) is a *group* placement instead --
        // see attemptPlaceSelectedDie's own branch. A single selected ☆ die (2026-08-19) never gets its
        // own per-slot click at all -- the whole tile is clickable instead (see the tile-level listener
        // below), since board.placeWildcardDie auto-assigns the slot; individual .slot elements just
        // show the highlighted preview.
        if (selectedDieIds.length > 0 && !wildcardSingleSelection) {
          slotEl.classList.add('slot--selectable');
          slotEl.addEventListener('click', () => attemptPlaceSelectedDie(state, mapId, i));
        }
        // Genuinely placeable right now (see highlightedSlots above) -- a stronger glow than the plain
        // "you can try clicking here" .slot--selectable affordance every slot gets while any die is
        // selected, regardless of whether it would actually work.
        if (highlightedSlots && highlightedSlots.has(i)) slotEl.classList.add('slot--highlight');
        // 変化ハイライト (2026-08-16) -- a die landed here since the viewing human's last turn ended.
        // Separate class/color from .slot--highlight just above (that one means "you could place here
        // right now"; this one means "something already happened here").
        if (changeHighlightDiff && changeHighlightDiff.slotKeys.has(`${mapId}|${i}`)) slotEl.classList.add('change-highlight');
        slotsEl.appendChild(slotEl);
      });

      // Castle-only: next round's recomputed turn order below the slots (see computeNextCastleTurnOrder
      // -- it reacts to whatever's currently placed on the castle). The current round's own turn order
      // ("現在" + its 4 player icons) used to show above the slots too -- removed 2026-08-21 per user
      // request; .map-tile__turnorder--current is left unpopulated (and therefore collapsed via
      // .map-tile__turnorder:empty, same as it already was on every non-castle tile) rather than
      // deleted from the template, so nothing else needs to change.
      if (isCastle) {
        fillTurnOrderRow(node.querySelector('.map-tile__turnorder--next'), '次', computeNextCastleTurnOrder(state), state);
      }

      const actionEl = node.querySelector('.map-tile__action');
      const icons = buildActionIcons(action);
      if (icons) {
        actionEl.appendChild(icons);
      } else {
        actionEl.textContent = action;
      }

      // 孤児院LV2(AREA010C) average VP-per-use display (2026-08-26, per user request: "孤児院LV2は獲得
      // したVPを表示できるようにできますか" -> "後者の平均" -- the per-placement conversion count,
      // averaged over every successful use so far this game, not a lifetime running total). mapState.
      // changeVpUses/changeVpTotal are updated in board.placeDice -- see its own doc there.
      if (areaRow.ID === 'AREA010C' && mapState.changeVpUses > 0) {
        const avg = (mapState.changeVpTotal / mapState.changeVpUses).toFixed(1);
        actionEl.appendChild(actionRow([actionSuffix(`平均${avg}VP`)]));
      }

      // Usage-fee display (2026-08-0X, moved into the header, replacing the old "tier A"/"tier B" text
      // badge -- per user request). Two lines: the flat per-tier rate (tier B = 1K, tier C = 2K, per
      // [[project-dice-wp-flow-spec]] -- tier A has no usage fee at all, so no rate line) and the
      // currently-accumulated amount, which -- unlike the old fee badge -- is now always shown, even at
      // "0 K", rather than only appearing once something has actually accumulated. Castle (no tier at
      // all) never has a fee concept, so its fee element is removed entirely rather than left empty.
      // Confirmed 2026-07-29 (carried over from the old badge): colored with the owner's player color,
      // and the owner can tap it to collect (a free action, executor.collectUsageFee) -- restricted to
      // whoever's real TURN it currently is (see realTurnPlayerId above), matching the other free
      // actions. Single-tap, not double-tap (2026-08-04, per user feedback: "使用料回収のフリーアクショ
      // ンのシングルクリック（タップ）で回収できるようにしてください" -- brings this in line with the
      // rest of the app's tap-gesture unification, this was the one interaction still left on dblclick).
      const feeEl = node.querySelector('.map-tile__fee');
      if (!tier) {
        feeEl.remove();
      } else {
        const feeRate = tier[1] === 'B' ? 1 : tier[1] === 'C' ? 2 : 0;
        feeEl.querySelector('.map-tile__fee-rate').textContent = feeRate > 0 ? `使用料${feeRate}K` : '';
        feeEl.querySelector('.map-tile__fee-amount').textContent = `${mapState.accumulatedFee} K`;
        if (mapState.accumulatedFee > 0 && mapState.feeOwnerId) {
          feeEl.dataset.color = colorForPlayer(state, mapState.feeOwnerId);
          if (mapState.feeOwnerId === realTurnPlayerId) {
            feeEl.classList.add('map-tile__fee--collectible');
            feeEl.addEventListener('click', () => {
              const result = executorMod.collectUsageFee(state, INDEX, { playerId: mapState.feeOwnerId }, mapId);
              placementMessage = result.success ? '' : `使用料を回収できません（${result.reason}）`;
              render(STATE);
            });
          }
        }
      }

      // JOB003/道化 (2026-08-19): a single selected ☆ die makes the whole tile clickable (including over
      // a .slot, since there's no per-slot click wired for this case -- see the slot-loop's own comment
      // above) -- clicking anywhere on the tile except the fee badge attempts board.placeWildcardDie at
      // this mapId, matching "the player picks the AREA, the engine picks the slot" (per user spec).
      if (wildcardSingleSelection) {
        node.classList.add('map-tile--wildcard-target');
        node.addEventListener('click', (e) => {
          if (e.target.closest('.map-tile__fee')) return;
          attemptPlaceSelectedWildcardDie(state, mapId);
        });
        rowEl.appendChild(node);
        continue;
      }

      // Tapping the tile opens the AREA enlarge modal (2026-08-0X, replaces right-click; 2026-08-05,
      // now shows tile-shaped previews of this tier plus every remaining higher tier instead of just
      // INST text -- see showAreaEnlargeModal). Excludes .slot clicks (dice placement) and
      // .map-tile__fee (usage-fee collection, its own click handler above) -- both bubble up from a
      // child element of this same tile and would otherwise also pop this modal open underneath them.
      node.addEventListener('click', (e) => {
        if (e.target.closest('.slot, .map-tile__fee')) return;
        showAreaEnlargeModal(mapState.currentAreaId);
      });

      rowEl.appendChild(node);
    }
    board.appendChild(rowEl);
  }
}

/** Colors (subset of A/B/C) that mapId's *current* AREA ACTION would actually pay -- e.g. AREA007's
 * CHANGE((A,B,C),D) ("ABC→色D", confirmed 2026-07-31 as the case [[project-dice-wp-dsl-spec]]'s Z
 * substitution rule needs to cover beyond plain BUILD/UPGRADE costs). Used only to decide whether
 * attemptPlaceSelectedDie needs to pause for 色欲's payment-choice prompt before placing. */
function areaColorPayResources(mapId) {
  const areaRow = dataLoaderMod.getAreaRow(INDEX, STATE.maps[mapId].currentAreaId);
  if (!areaRow.ACTION) return [];
  const colors = new Set();
  for (const cmd of commandBuilderMod.lowerProgram(dslParserMod.parse(areaRow.ACTION))) {
    if (cmd.type !== 'CHANGE') continue;
    for (const item of cmd.pay) {
      if (item.resource === 'A' || item.resource === 'B' || item.resource === 'C') colors.add(item.resource);
    }
  }
  return [...colors];
}

/** Entry point for a SLOT click (2026-07-31): if placing here would pay A/B/C (BUILD/UPGRADE
 * candidates are the far more common case, but the AREA's own ACTION can also pay colored resources
 * directly -- see areaColorPayResources) and the player has both 色欲 and some Z on hand, pauses
 * for the "real or Z" choice (see renderPlacementChoiceModal) instead of placing immediately. The
 * BUILD/UPGRADE side of this same choice happens later, in renderBuildChoicePaymentControls, once a
 * candidate is on offer -- this only covers the AREA-ACTION-pays-directly case. Otherwise places
 * immediately with the default (real-first, Z-fallback) split, same as every player without the
 * ability. */
function attemptPlaceSelectedDie(state, mapId, slotIndex) {
  // 2+ selected dice on the castle/AREA009 (2026-08-02, per user feedback) is a monument-only *group*
  // placement instead of a normal single-die one -- see placeSelectedDiceGroup/board.placeDiceGroup.
  // Which exact slot cell was clicked doesn't matter for a group (board.placeDiceGroup auto-assigns one
  // per distinct value), so every slot on these two tiles funnels into the same call.
  if (selectedDieIds.length > 1 && (mapId === boardMod.CASTLE_MAP_ID || mapId === boardMod.AREA009_MAP_ID)) {
    placeSelectedDiceGroup(state, mapId);
    return;
  }
  // Otherwise: a normal single-die placement using whichever die was selected *last* (confirmed
  // 2026-08-02: if 2+ dice are selected but the player places on some OTHER area, only the most
  // recently selected one actually gets placed here -- the rest just fall back to unselected/in-hand).
  const dieId = selectedDieIds[selectedDieIds.length - 1];
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieId));
  if (executorMod.hasPaymentChoiceAbility(state, player.id) && (player.resources.Z || 0) > 0) {
    const colors = areaColorPayResources(mapId);
    if (colors.length > 0) {
      pendingPlacementChoice = { mapId, slotIndex, colors, colorPreference: {}, dieId };
      render(STATE);
      return;
    }
  }
  placeSelectedDie(state, dieId, mapId, slotIndex, {});
}

/** Entry point for a whole-TILE click when a single ☆ wildcard die is selected (2026-08-19, JOB003/道化
 * -- see renderBoard's own doc on why there's no per-slot click for this case at all). Mirrors
 * attemptPlaceSelectedDie's single-die branch exactly (same 色欲 payment-choice pause), just without a
 * slotIndex -- board.placeWildcardDie auto-assigns the slot itself. */
function attemptPlaceSelectedWildcardDie(state, mapId) {
  const dieId = selectedDieIds[selectedDieIds.length - 1];
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieId));
  if (executorMod.hasPaymentChoiceAbility(state, player.id) && (player.resources.Z || 0) > 0) {
    const colors = areaColorPayResources(mapId);
    if (colors.length > 0) {
      pendingPlacementChoice = { mapId, wildcard: true, colors, colorPreference: {}, dieId };
      render(STATE);
      return;
    }
  }
  placeSelectedWildcardDie(state, dieId, mapId, {});
}

/** Shared result-handling for a successful call into board.placeDice/placeDiceGroup (2026-08-02,
 * factored out of placeSelectedDie so placeSelectedDiceGroup's group result can reuse the exact same
 * logic instead of drifting from it). If the AREA's ACTION turns out to be a BUILD (e.g. the castle),
 * the die/dice are already placed but the resulting pendingBuild is left for the player to choose from
 * (see renderBuildChoiceModal/board.completeAreaBuild). */
function applyPlaceDiceResult(result, playerId) {
  if (!result.success) {
    // Placement itself was illegal (value mismatch / slot occupied / no legal slot for the whole
    // group / etc.) -- see board.placeDice/placeDiceGroup.
    placementMessage = `配置できません（${result.reason}）`;
    return;
  }
  if (result.actionResult && result.actionResult.pendingBuild) {
    placementMessage = '';
    pendingBuildChoice = { source: 'AREA', playerId, ...result.actionResult.pendingBuild };
    buildColorPreference = {};
    pendingBzOutcomeChoice = null;
    return;
  }
  // Either the AREA action fully resolved, or it failed with no candidate build to fall back on
  // (NO_BUILDABLE_CARD) or some other reason (e.g. AREA007's CHANGE((A,B,C),D) failing with
  // INSUFFICIENT_RESOURCES) -- either way there's nothing left to wait on. Per
  // [[project-dice-wp-flow-spec]]: "1ターン＝ダイス1個の配置", so this player won't place another die
  // this turn -- but the turn itself doesn't end yet (2026-08-01 -- see turnActionTaken's own comment):
  // they may still have free actions/bare TAP abilities to use before explicitly ending via the "ターン
  // 終了" button. The message text distinguishes the two failure shapes (fixed 2026-08-02: previously
  // every non-BUILD failure was mislabeled "建築できるカードがありません", which made no sense for e.g.
  // AREA007's plain resource-payment failure).
  if (result.actionResult && result.actionResult.success === false) {
    placementMessage = result.actionResult.reason === 'NO_BUILDABLE_CARD'
      ? `建築できるカードがありません（${result.actionResult.reason}）`
      : `効果を解決できません（${result.actionResult.reason}）`;
  } else {
    placementMessage = '';
  }
  turnActionTaken = true;
}

/** Attempts to place dieId onto (mapId, slotIndex) via the real board.placeDice (2026-07-30, real
 * engine wiring pass 2). Legality is entirely board.placeDice's call -- see renderBoard's slot click
 * handler for why nothing is re-validated here. colorPreference: see executor.resolvePayment -- only
 * ever non-empty via attemptPlaceSelectedDie's pre-placement choice above. Always clears the *entire*
 * selection (2026-08-02), not just dieId -- placing consumes this turn's one main action regardless of
 * how many dice happened to be selected, so any others just fall back to unselected/in-hand (confirmed
 * 2026-08-02, see attemptPlaceSelectedDie's own comment). */
function placeSelectedDie(state, dieId, mapId, slotIndex, colorPreference) {
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieId));
  // JOB007/宮廷人 tap-first offer (2026-08-22) -- checked before the wD-overflow confirm below, since
  // accepting it can change what monument candidates this same placement offers (MONUMENT_DICE_
  // DISCOUNT). See pendingJob007TapPrompt's own doc.
  withJob007TapPrompt(
    state, player.id, dieId,
    (clone) => boardMod.placeDice(clone, INDEX, { playerId: player.id, colorPreference }, dieId, mapId, slotIndex),
    () => placeSelectedDieAfterJob007Check(state, player, dieId, mapId, slotIndex, colorPreference),
  );
}

function placeSelectedDieAfterJob007Check(state, player, dieId, mapId, slotIndex, colorPreference) {
  // wD-overflow confirm (2026-08-19, per user request) -- checked BEFORE any real mutation, so a
  // declined confirm leaves selectedDieIds/turnActionTaken/dicePlacementCheckpoint untouched, same as if
  // the click never happened. See pendingWhiteOverflowConfirm's own doc.
  if (wouldCauseWhiteOverflow(state, (clone) => boardMod.placeDice(clone, INDEX, { playerId: player.id, colorPreference }, dieId, mapId, slotIndex))) {
    pendingWhiteOverflowConfirm = { onConfirm: () => placeSelectedDieCommit(state, player, dieId, mapId, slotIndex, colorPreference) };
    render(STATE);
    return;
  }
  placeSelectedDieCommit(state, player, dieId, mapId, slotIndex, colorPreference);
}

function placeSelectedDieCommit(state, player, dieId, mapId, slotIndex, colorPreference) {
  const preSnapshot = gameStateMod.cloneState(state);
  const preTurnActionTaken = turnActionTaken;
  const result = boardMod.placeDice(state, INDEX, { playerId: player.id, colorPreference }, dieId, mapId, slotIndex);
  selectedDieIds = [];
  if (result.success) dicePlacementCheckpoint = { state: preSnapshot, turnActionTaken: preTurnActionTaken };
  applyPlaceDiceResult(result, player.id);
  render(STATE);
}

/** Wildcard counterpart of placeSelectedDie/placeSelectedDieCommit (2026-08-19, JOB003/道化) -- same
 * wD-overflow-confirm pattern, checkpoint bookkeeping, and result handling, just via
 * board.placeWildcardDie (no slotIndex) instead of board.placeDice. */
function placeSelectedWildcardDie(state, dieId, mapId, colorPreference) {
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieId));
  // JOB007/宮廷人 tap-first offer -- see placeSelectedDie's own doc for the pattern.
  withJob007TapPrompt(
    state, player.id, dieId,
    (clone) => boardMod.placeWildcardDie(clone, INDEX, { playerId: player.id, colorPreference }, dieId, mapId),
    () => placeSelectedWildcardDieAfterJob007Check(state, player, dieId, mapId, colorPreference),
  );
}

function placeSelectedWildcardDieAfterJob007Check(state, player, dieId, mapId, colorPreference) {
  if (wouldCauseWhiteOverflow(state, (clone) => boardMod.placeWildcardDie(clone, INDEX, { playerId: player.id, colorPreference }, dieId, mapId))) {
    pendingWhiteOverflowConfirm = { onConfirm: () => placeSelectedWildcardDieCommit(state, player, dieId, mapId, colorPreference) };
    render(STATE);
    return;
  }
  placeSelectedWildcardDieCommit(state, player, dieId, mapId, colorPreference);
}

function placeSelectedWildcardDieCommit(state, player, dieId, mapId, colorPreference) {
  const preSnapshot = gameStateMod.cloneState(state);
  const preTurnActionTaken = turnActionTaken;
  const result = boardMod.placeWildcardDie(state, INDEX, { playerId: player.id, colorPreference }, dieId, mapId);
  selectedDieIds = [];
  if (result.success) dicePlacementCheckpoint = { state: preSnapshot, turnActionTaken: preTurnActionTaken };
  applyPlaceDiceResult(result, player.id);
  render(STATE);
}

/** The castle/AREA009 "2+ selected dice" branch of attemptPlaceSelectedDie (2026-08-02, per user
 * feedback -- see board.placeDiceGroup's own doc for the underlying rules: mixed values allowed, each
 * needs its own slot except same-value dice which share one, monument-only candidates). Always clears
 * the whole selection up front, same as placeSelectedDie -- whether the group placement succeeds or
 * not, this turn's one main action is spent either way. */
function placeSelectedDiceGroup(state, mapId) {
  const dieIds = selectedDieIds;
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieIds[0]));
  // JOB007/宮廷人 tap-first offer -- see placeSelectedDie's own doc for the pattern. Especially relevant
  // here: placeDiceGroup is monument-only (castle/元老院), so this is exactly where
  // MONUMENT_DICE_DISCOUNT can turn an otherwise-unreachable monument into a real candidate.
  withJob007TapPrompt(
    state, player.id, dieIds[0],
    (clone) => boardMod.placeDiceGroup(clone, INDEX, { playerId: player.id }, dieIds, mapId),
    () => placeSelectedDiceGroupAfterJob007Check(state, player, dieIds, mapId),
  );
}

function placeSelectedDiceGroupAfterJob007Check(state, player, dieIds, mapId) {
  // wD-overflow confirm -- see placeSelectedDie's own doc for the pattern.
  if (wouldCauseWhiteOverflow(state, (clone) => boardMod.placeDiceGroup(clone, INDEX, { playerId: player.id }, dieIds, mapId))) {
    pendingWhiteOverflowConfirm = { onConfirm: () => placeSelectedDiceGroupCommit(state, player, dieIds, mapId) };
    render(STATE);
    return;
  }
  placeSelectedDiceGroupCommit(state, player, dieIds, mapId);
}

function placeSelectedDiceGroupCommit(state, player, dieIds, mapId) {
  selectedDieIds = [];
  const preSnapshot = gameStateMod.cloneState(state);
  const preTurnActionTaken = turnActionTaken;
  const result = boardMod.placeDiceGroup(state, INDEX, { playerId: player.id }, dieIds, mapId);
  if (result.success) dicePlacementCheckpoint = { state: preSnapshot, turnActionTaken: preTurnActionTaken };
  applyPlaceDiceResult(result, player.id);
  render(STATE);
}

/**
 * Whatever RESOURCE_LIMIT/FORCE_CONVERT TURNEND rules ending playerId's turn *right now* would
 * actually trigger (2026-08-01, per user feedback: the data's WARNING/"はい・いいえ" text was always
 * auto-confirmed as "はい" -- see attemptAdvanceTurn, the gate this feeds). Each owned card's TURNEND
 * is checked the same way executor.applyTurnEnd itself would apply it, just without mutating anything
 * yet. REPLACE_ADD (CON002A) has the same WARNING pattern but is NOT covered here -- it fires the
 * moment a would-be ADD(D) is about to run (mid-action, not at TURNEND). The only card ONCE that grants
 * a bare D is CON006A's (2026-08-15, was CON001B's before that card's own ONCE changed); since each
 * player has exactly one CON card, no player can ever own both CON006A and CON002A at once. AREA007's
 * CHANGE((A,B,C),D) also grants D, but is unconditionally blocked as a placement candidate for a
 * REPLACE_ADD(D,...) owner (board.wouldAreaActionHaveEffect's COLOR_DIE_REPLACED check, 2026-08-16) --
 * so REPLACE_ADD's WARNING stays structurally unreachable with the current data either way, and isn't
 * wired up (would need a real trigger point to test against).
 * @returns {{physicalId:string, warningText:string, kind:'RESOURCE_LIMIT'|'FORCE_CONVERT'}[]}
 */
function turnEndWarnings(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const warnings = [];
  for (const physicalId of player.ownedCardPhysicalIds) {
    const cardState = state.cards[physicalId];
    if (!cardState) continue;
    const row = dataLoaderMod.getCardRow(INDEX, cardState.currentFaceId);
    if (!row.TURNEND) continue;
    for (const cmd of commandBuilderMod.lowerProgram(dslParserMod.parse(row.TURNEND))) {
      if (cmd.type === 'RESOURCE_LIMIT') {
        // A pending usage fee is paid out of K BEFORE this limit check actually runs at TURNEND (see
        // executor.applyTurnEnd's own comment, 2026-08-11) -- so this preview must subtract it too
        // (2026-08-12, per user report: 8K with a K-MAX7 limit and a 2K pending fee owed showed this
        // warning even though paying the fee first drops K to 6, under the limit, so nothing would
        // actually get auto-discarded). Only when the fee is actually affordable, matching
        // applyTurnEnd's own precondition (canEndTurn already guarantees that before it ever runs) --
        // an unpayable fee blocks TURNEND entirely via a separate USAGE_FEE gate instead, so this
        // warning becomes moot in that case regardless of what it shows here.
        let amount = player.resources[cmd.resource] || 0;
        if (cmd.resource === 'K' && player.pendingFee && amount >= player.pendingFee.amount) {
          amount -= player.pendingFee.amount;
        }
        if (amount > cmd.limit) warnings.push({ physicalId, warningText: row.WARNING, kind: 'RESOURCE_LIMIT' });
      } else if (cmd.type === 'FORCE_CONVERT' && (player.resources[cmd.from] || 0) > 0) {
        warnings.push({ physicalId, warningText: row.WARNING, kind: 'FORCE_CONVERT' });
      }
    }
  }
  return warnings;
}

/** Entry point for ending a turn (2026-08-01) -- placeSelectedDie/renderBuildChoiceModal/the free-
 * action retry all call this instead of advanceTurnIfPossible directly now. If ending right now would
 * trigger a RESOURCE_LIMIT/FORCE_CONVERT WARNING, pauses for confirmation (see
 * renderTurnEndWarningModal) instead of ending immediately -- "いいえ" leaves the turn as-is (matches
 * the data's own "TURNENDを取り消す" NOTE), "はい" runs the real advanceTurnIfPossible. */
function attemptAdvanceTurn(state, playerId) {
  const warnings = turnEndWarnings(state, playerId);
  if (warnings.length > 0) {
    pendingTurnEndWarning = { playerId, warnings };
    return;
  }
  advanceTurnIfPossible(state, playerId);
}

/** Ends playerId's turn and advances to the next player (2026-07-30, real engine wiring pass 4) --
 * see placeSelectedDie/renderBuildChoiceModal, the two places a turn can actually finish. If blocked
 * (RESOURCE_TOTAL_LIMIT), leaves the turn as-is with a message -- resolving that requires a free
 * action, which isn't wired yet (a future pass), so the player is simply stuck until then. On
 * success, also advances the round (endRound + startRound, unless the game just ended) if that was
 * the last unplaced die this round. Only ever called after attemptAdvanceTurn's own WARNING gate (or
 * directly, once already confirmed) -- see renderTurnEndWarningModal's confirm handler. */
function advanceTurnIfPossible(state, playerId) {
  const result = turnFlowMod.endTurn(state, INDEX, playerId);
  if (!result.success) {
    // result.violations mixes RESOURCE_TOTAL_LIMIT entries (executor.canEndTurn) with at most one
    // USAGE_FEE entry (2026-08-04, see PlayerState.pendingFee) and, since 2026-08-20, at most one
    // UNTAP_CHOICE entry (see executor.canEndTurn's own doc) -- message picks whichever is actually
    // blocking, favoring the fee (rarer, more specific) since a player who owes a fee wants to be told
    // that, not a generic "resources over the limit" line that doesn't mention K at all. In practice the
    // turn-end button is already hidden while UNTAP_CHOICE is pending (see actingHumanPlayerId), so this
    // branch is defense-in-depth rather than something a player normally sees.
    const feeViolation = result.violations.find((v) => v.type === 'USAGE_FEE');
    const untapChoiceViolation = result.violations.find((v) => v.type === 'UNTAP_CHOICE');
    placementMessage = feeViolation
      ? `ターンを終了できません（使用料${feeViolation.amount}Kを支払えません。フリーアクションで資源を増やしてください）`
      : untapChoiceViolation
        ? 'ターンを終了できません（アンタップするカードを選んでください）'
        : 'ターンを終了できません（資源の合計が上限を超えています。フリーアクションで資源を減らしてください）';
    pendingTurnEndPlayerId = playerId;
    return;
  }
  pendingTurnEndPlayerId = null;
  // Reset turnActionTaken here, synchronously with the real END_TURN, not just via render()'s bottom
  // "transition block" (2026-08-09 regression fix, per user report: "1Rの2ターン目にダイスを置けなくなる
  // "). That transition block only clears turnActionTaken once next.playerId's hasFinishedOnboarding is
  // true -- during round 1, the very next player is mid-ONBOARDING, so it stays true. The very next
  // render() call still sees the stale turnActionTaken===true (leftover from playerId's own turn) and,
  // since 5ea2c81 dropped the state.turnOrder[state.currentPlayerIndex] cross-check that used to catch
  // this, render()'s "keep the mid-turn player visible" override wrongly re-targets playerId again even
  // though their turn genuinely just ended -- and since lastTurnPlayerId still equals playerId too, the
  // transition block's own `next.playerId !== lastTurnPlayerId` guard never fires either, permanently
  // freezing the game on playerId. This is the one choke point every real human END_TURN passes through
  // (see this function's own doc), so clearing the flag right here is sufficient and unconditional --
  // no dependency on what the next player still needs to finish onboarding-wise.
  turnActionTaken = false;
  // Same choke-point argument as turnActionTaken just above, for the checkpoint side of the same bug
  // class -- see turnJustEnded's own doc (2026-08-11, per user report). render()'s transition block
  // consumes and clears this.
  turnJustEnded = true;
  // Change-highlight baseline (2026-08-16, see changeHighlightBaseline's own doc): this choke point is
  // also "the board as the human left it" -- the one moment guaranteed to run before any AI gets a
  // chance to move. !isAiPlayer is defensive (this function is only ever reached via the human's own
  // ターン終了 click today) rather than load-bearing.
  if (!isAiPlayer(playerId)) changeHighlightBaseline = structuredClone(state);
  if (turnFlowMod.isRoundOver(state)) {
    turnFlowMod.endRound(state, INDEX);
    if (state.phase !== 'GAME_END') turnFlowMod.startRound(state);
  }
}

/** Fills/shows #build-choice-overlay from pendingBuildChoice (2026-07-30, real engine wiring pass 3
 * -- BUILD/UPGRADE candidate selection, see placeSelectedDie above for how this gets populated).
 * Each candidate is shown as a clickable card (BUILD_NEW's own faceId, or UPGRADE's resulting
 * toFaceId with a small label so it's clear this is an upgrade, not a fresh build) -- clicking commits
 * via board.completeAreaBuild, which also runs anything that followed BUILD(...) in that AREA's
 * ACTION field (pendingBuildChoice.remainingCommands). There's no cancel/decline affordance -- once a
 * BUILD area is triggered with >=1 legal candidate, choosing one is mandatory (matches the physical
 * game: you can't back out of a die placement that already resolved), same as the real engine offers
 * no "skip" path here either. */

/** Colors (subset of A/B/C) a candidate's payment actually needs -- BUILD_NEW pays faceId's own COST,
 * UPGRADE pays fromFaceId's (see board.js's resolveUpgrade: "支払えなければ実行不可" against the
 * *original* tier's COST, confirmed identical to the tier-B row's). */
function candidateColorResources(candidate) {
  const costFaceId = candidate.type === 'UPGRADE' ? candidate.fromFaceId : candidate.faceId;
  const row = dataLoaderMod.getCardRow(INDEX, costFaceId);
  return commandBuilderMod.lowerCostList(row.COST)
    .map((item) => item.resource)
    .filter((resource) => resource === 'A' || resource === 'B' || resource === 'C');
}

/** Every distinct affordable way to auto-spend BZ on candidate's COST, per executor.enumerateBzOutcomes
 * (2026-08-04 -- replaces the old manual per-resource stepper; BZ itself is always maxed out
 * automatically now, this only ever enumerates *which real resource* ends up spent when that's a real
 * fork). Works for UPGRADE too (2026-08-06, per user feedback) -- costFaceId mirrors
 * candidateColorResources' own BUILD_NEW-vs-UPGRADE split (UPGRADE pays fromFaceId's COST, the original
 * tier's, per board.resolveUpgrade). */
function bzOutcomesForCandidate(candidate, playerId) {
  const costFaceId = candidate.type === 'UPGRADE' ? candidate.fromFaceId : candidate.faceId;
  const row = dataLoaderMod.getCardRow(INDEX, costFaceId);
  const items = commandBuilderMod.lowerCostList(row.COST);
  const player = STATE.players.find((p) => p.id === playerId);
  const bzAvailable = player.resources.BZ || 0;
  return executorMod.enumerateBzOutcomes(STATE, playerId, items, bzAvailable, buildColorPreference);
}

/** Whether playerId can currently pay candidate's COST (real + Z + auto-maxed BZ combined). Used to
 * filter the BUILD/UPGRADE candidate list down to only what's actually buildable right now (2026-07-31,
 * per user feedback: "建築時、ダイス目の合っているものだけカードを表示になっていますが、今建築できる
 * もの（ダイス目+資源）だけ表示してください" -- board.getBuildCandidates itself stays unfiltered/
 * dice-only, since other callers (AREA/QST/bare-TAP pendingBuild detection, and their own
 * NO_BUILDABLE_CARD check) rely on the *rule*-eligible list; this is purely a display-layer filter on
 * top of that). BUILD_NEW and UPGRADE share the same BZ-aware path (2026-08-06) since bzOutcomesForCandidate
 * now handles both. */
function candidateAffordable(candidate, playerId) {
  return bzOutcomesForCandidate(candidate, playerId).length > 0;
}

/** 色欲's "real or Z" payment-preference toggle (2026-07-31, see [[project-dice-wp-dsl-spec]]'s
 * Z-substitution rule and executor.hasPaymentChoiceAbility) -- one toggle per colored resource used by
 * *any* candidate currently on offer (buildColorPreference is shared across candidates: it's a
 * per-resource-type preference, not per-candidate, since only one candidate ever actually gets built).
 * Hidden entirely for players without the ability, or with no Z on hand to substitute at all. */
function renderBuildChoicePaymentControls() {
  const container = document.getElementById('build-choice-payment');
  container.innerHTML = '';
  const playerId = pendingBuildChoice.playerId;
  const player = STATE.players.find((p) => p.id === playerId);
  if (!executorMod.hasPaymentChoiceAbility(STATE, playerId) || (player.resources.Z || 0) <= 0) return;
  const colors = new Set();
  for (const candidate of pendingBuildChoice.candidates.filter((c) => candidateAffordable(c, playerId))) {
    for (const resource of candidateColorResources(candidate)) colors.add(resource);
  }
  if (colors.size === 0) return;
  container.appendChild(el('span', 'build-choice-payment__label', '色欲: 支払いに使う資源を選択'));
  for (const resource of ['A', 'B', 'C']) {
    if (!colors.has(resource)) continue;
    const group = el('div', 'build-choice-payment__group');
    group.appendChild(el('span', 'build-choice-payment__resource', resource));
    const current = buildColorPreference[resource] === 'Z' ? 'Z' : 'AUTO';
    const realBtn = el('button', 'build-choice-payment__option', `資源${resource}優先`);
    const zBtn = el('button', 'build-choice-payment__option', '資源Z優先');
    realBtn.type = 'button';
    zBtn.type = 'button';
    realBtn.classList.toggle('build-choice-payment__option--active', current === 'AUTO');
    zBtn.classList.toggle('build-choice-payment__option--active', current === 'Z');
    realBtn.addEventListener('click', () => { buildColorPreference[resource] = 'AUTO'; renderBuildChoicePaymentControls(); });
    zBtn.addEventListener('click', () => { buildColorPreference[resource] = 'Z'; renderBuildChoicePaymentControls(); });
    group.appendChild(realBtn);
    group.appendChild(zBtn);
    container.appendChild(group);
  }
}

/** Ambiguous-BZ-outcome chooser (2026-08-04, per user feedback: "デフォルトでBZを使って建築するように
 * して" -- replaces the old manual per-resource stepper entirely). Only ever rendered once a BUILD_NEW
 * or UPGRADE candidate has already been clicked and executor.enumerateBzOutcomes found 2+ distinct
 * affordable ways to spend the (always-maxed) BZ discount -- e.g. cost 2A+1B with 2 BZ held and the
 * player holding both a real A and a real B (see enumerateBzOutcomes's own doc for the general rule this
 * implements).
 * Nothing has been committed yet, so "戻る" just clears pendingBzOutcomeChoice back to the candidate
 * list. Each option button shows the real resource(s) that specific outcome would actually spend
 * (resource-dot badges, same visual language as the rest of the app) and commits on click. */
function renderBzOutcomeChoice() {
  const container = document.getElementById('build-choice-bz');
  container.innerHTML = '';
  if (!pendingBzOutcomeChoice) return;
  const { candidate, outcomes } = pendingBzOutcomeChoice;
  container.appendChild(el('span', 'build-choice-payment__label', 'どちらの資源で支払いますか？'));
  for (const outcome of outcomes) {
    const btn = el('button', 'build-choice-payment__option');
    btn.type = 'button';
    for (const item of outcome.resolvedItems) {
      if (item.resource === 'BZ') continue; // BZ is spent in every outcome alike -- not the differentiator
      btn.appendChild(renderResourceBadge(item.resource, item.count));
    }
    btn.addEventListener('click', () => commitBuildCandidate(candidate, outcome.bzDiscount));
    container.appendChild(btn);
  }
  const backBtn = el('button', 'build-choice-payment__option', '戻る');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => { pendingBzOutcomeChoice = null; render(STATE); });
  container.appendChild(backBtn);
}

/** Untapped bare-IMMEDIATE-kind cards (see bareTapKind) whose TAP program grants BZ -- e.g. JOB004A's
 * CHANGE(3K,2BZ) (corrected 2026-08-03, per user feedback: "建築しようとしたときに3KをAAに変えて建築
 * できるようにしたい" -- previously an ON(BUILD(...),...) reaction that fired too late to help pay for
 * the build that triggered it). Detected generically by DSL shape, not hardcoded to JOB004A by name --
 * any future card shaped like this (a bare CHANGE whose gain includes BZ) gets the same treatment. */
function bzGrantingBareTapCards(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const results = [];
  for (const physicalId of player.ownedCardPhysicalIds) {
    const cardState = state.cards[physicalId];
    if (!cardState || cardState.tapped) continue;
    const kind = bareTapKind(cardState.currentFaceId);
    if (!kind || kind.kind !== 'IMMEDIATE') continue;
    const row = dataLoaderMod.getCardRow(INDEX, cardState.currentFaceId);
    const commands = commandBuilderMod.lowerProgram(dslParserMod.parse(row.TAP));
    const grantsBz = commands.some((c) => c.type === 'CHANGE' && c.gain.some((g) => g.resource === 'BZ'));
    if (grantsBz) results.push({ physicalId, faceId: cardState.currentFaceId });
  }
  return results;
}

/** 「建築が発生したときにすぐに発動」プロンプト (2026-08-03, per user feedback: "建築が発生した
 * ときにすぐに発動 Y/Nでハイを押すと3K→2BZその後建築対象を選べるようになる") -- shown at the top of
 * the build-choice modal, before the candidate list, whenever bzGrantingBareTapCards finds something
 * usable, so the player can convert (e.g. 3K->2BZ) right at the moment a build becomes possible and
 * have that BZ immediately available for the candidate list's own BZ-discount stepper below, instead of
 * needing to have proactively tapped it beforehand. Purely optional (a single "使う" button, not a
 * blocking Y/N dialog) -- not using it just leaves the candidate list as-is. */
function renderBuildChoiceBzTapPrompt() {
  const container = document.getElementById('build-choice-bz-tap-prompt');
  container.innerHTML = '';
  if (!pendingBuildChoice) return;
  for (const { physicalId, faceId } of bzGrantingBareTapCards(STATE, pendingBuildChoice.playerId)) {
    const row = el('div', 'build-choice-bz-tap-prompt__row');
    row.appendChild(el('span', 'build-choice-bz-tap-prompt__label', `${faceId}のTAPアクションを使いますか？`));
    const btn = el('button', 'build-choice-bz-tap-prompt__button', '使う');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      boardMod.useBareTapAbility(STATE, INDEX, { playerId: pendingBuildChoice.playerId }, physicalId);
      render(STATE);
    });
    row.appendChild(btn);
    container.appendChild(row);
  }
}

/** Commits a BUILD_NEW/UPGRADE candidate once its bzDiscount is settled -- either auto-picked
 * (bzOutcomesForCandidate found exactly one affordable outcome) or player-picked via
 * renderBzOutcomeChoice. Shared by both paths in the click handler below since everything past that
 * point (QST vs AREA/TAP commit, success/failure bookkeeping) is identical either way.
 *
 * wD-overflow confirm (2026-08-19, per user request) wraps this: predicted BEFORE any real mutation
 * (including the TAP-source tapped=true flip commitBuildCandidateReal does first) via a clone running
 * the same completeAreaBuild call this would -- see pendingWhiteOverflowConfirm's own doc. A built/
 * upgraded card's own ONCE (e.g. B004A's ADD(2wD)) is exactly the kind of grant this catches. */
function commitBuildCandidate(candidate, bzDiscount) {
  const playerId = pendingBuildChoice.playerId;
  const context = { playerId, colorPreference: buildColorPreference, bzDiscount };
  if (wouldCauseWhiteOverflow(STATE, (clone) => boardMod.completeAreaBuild(clone, INDEX, context, candidate, pendingBuildChoice.remainingCommands))) {
    pendingWhiteOverflowConfirm = { onConfirm: () => commitBuildCandidateReal(candidate, bzDiscount) };
    render(STATE);
    return;
  }
  commitBuildCandidateReal(candidate, bzDiscount);
}

function commitBuildCandidateReal(candidate, bzDiscount) {
  const playerId = pendingBuildChoice.playerId;
  const context = { playerId, colorPreference: buildColorPreference, bzDiscount };
  const source = pendingBuildChoice.source;
  // Tap the TAP-source card BEFORE resolving the build, not after (2026-08-09 fix, per user report on
  // what were then B006A/C008A -- renamed to B202A/C301A by the 2026-08-24 SHOP201-203 rework's card
  // renumbering: "B006AをTAPしてその効果でC008Aを建築したときB006Aがアンタップしない"). The built card's
  // own ONCE -- e.g. C301A's UNTAP_ALL(SELF) (briefly UNTAP_CHOICE(SELF,3) 2026-08-15 through 2026-08-24,
  // see command-builder.js's own UNTAP_CHOICE doc) -- runs *inside* completeAreaBuild/completeQuestClaim
  // below, so tapping this card only afterward (the old order) meant that effect could never actually
  // reach it: the TAP source stayed permanently tapped even though the untap effect should have caught
  // it right back.
  // resolveBuildNew/resolveUpgrade both check affordability and fail atomically *before* any state
  // mutation (see board.js's own code), so it's safe to speculatively tap first and simply revert if the
  // build then fails -- nothing else needs undoing, and the TAP is correctly left unspent for a retry.
  if (source === 'TAP') STATE.cards[pendingBuildChoice.physicalId].tapped = true;
  // A card's own bare TAP=BUILD(...) (see attachTapToggle/bareTapKind) reuses this same modal but
  // never advances the turn -- it's free-action-timed, not a die placement (only an AREA-triggered
  // BUILD, from an actual die placement, ends the turn). (2026-08-09: QST no longer has any
  // player-facing action at all, so this modal is now only ever reached via TAP or AREA -- see
  // src/qst.js's own doc.)
  const result = boardMod.completeAreaBuild(STATE, INDEX, context, candidate, pendingBuildChoice.remainingCommands);
  // Only close the modal on success -- e.g. INSUFFICIENT_RESOURCES (can't afford this candidate's
  // COST) must NOT silently dismiss the choice, since the die/build trigger already happened and
  // is not undoable from here; the player needs to try an affordable candidate instead.
  if (result.success) {
    pendingBuildChoice = null;
    pendingBzOutcomeChoice = null;
    placementMessage = '';
    // Auto/manual choice for the card that was just built/upgraded, if it has a reactive TAP
    // ability (see pendingAutoModeChoice's own comment).
    const newFaceId = candidate.type === 'UPGRADE' ? candidate.toFaceId : candidate.faceId;
    if (reactiveTapKind(newFaceId)) {
      const newPhysicalId = candidate.type === 'UPGRADE' ? candidate.physicalId : result.buildResult.physicalId;
      pendingAutoModeChoice = { physicalId: newPhysicalId, playerId };
    }
    if (source === 'AREA') turnActionTaken = true; // this placement's die is spent, but the turn itself waits for the "ターン終了" button (2026-08-01)
  } else {
    // Payment somehow failed even after bzOutcomesForCandidate said it would succeed (stale state
    // between render and click) -- drop back to the plain candidate list rather than leaving the
    // player stuck looking at a chooser for a payment that just failed.
    if (source === 'TAP') STATE.cards[pendingBuildChoice.physicalId].tapped = false; // build never actually happened -- the TAP wasn't spent
    pendingBzOutcomeChoice = null;
    placementMessage = `建築できません（${result.reason}）`;
  }
  render(STATE);
}

function renderBuildChoiceModal() {
  const overlay = document.getElementById('build-choice-overlay');
  if (!pendingBuildChoice) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  // Ambiguous-BZ-outcome step (2026-08-04): a candidate was already clicked and there's more than one
  // distinct affordable way to spend BZ on it -- show only the chooser (plus a preview of the candidate
  // being built) and hold off on re-rendering the full candidate list/other controls until it's
  // resolved, so the player can't accidentally click a *different* candidate mid-choice.
  if (pendingBzOutcomeChoice) {
    document.getElementById('build-choice-bz-tap-prompt').innerHTML = '';
    document.getElementById('build-choice-payment').innerHTML = '';
    renderBzOutcomeChoice();
    const list = document.getElementById('build-choice-list');
    list.innerHTML = '';
    const { candidate } = pendingBzOutcomeChoice;
    const faceId = candidate.type === 'UPGRADE' ? candidate.toFaceId : candidate.faceId;
    const cardNode = buildCardVisual(faceId, { showEffect: true, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
    cell.appendChild(cardNode);
    list.appendChild(cell);
    return;
  }
  renderBuildChoiceBzTapPrompt();
  renderBuildChoicePaymentControls();
  document.getElementById('build-choice-bz').innerHTML = '';
  const list = document.getElementById('build-choice-list');
  list.innerHTML = '';
  // CON004A's BLOCK_UPGRADE_UNLESS_QST_RANK (2026-08-15, per user request): shown whenever it's actively
  // suppressing every UPGRADE candidate this player would otherwise see here, regardless of whether
  // other (A/B/C/M) candidates are still on offer alongside it -- without this, an UPGRADE a player
  // expects to see would just silently be missing from the list with no explanation.
  if (boardMod.isUpgradeBlockedByQstRank(STATE, INDEX, pendingBuildChoice.playerId)) {
    list.appendChild(el('div', 'build-choice-warning', '自分よりAREA数が多いプレイヤーがいるためLVUPできません'));
  }
  const affordableCandidates = pendingBuildChoice.candidates.filter((c) => candidateAffordable(c, pendingBuildChoice.playerId));
  if (affordableCandidates.length === 0) {
    list.appendChild(el('div', 'build-choice-empty', '今支払える資源では建築できるカードがありません'));
  }
  function buildCandidateCell(candidate) {
    const faceId = candidate.type === 'UPGRADE' ? candidate.toFaceId : candidate.faceId;
    const cardNode = buildCardVisual(faceId, { showEffect: true, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const wrapper = el('div', 'build-choice-item');
    if (candidate.type === 'UPGRADE') wrapper.appendChild(el('div', 'build-choice-label', 'LVアップ'));
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall owned-card-cell--selectable' : 'owned-card-cell owned-card-cell--selectable');
    cell.appendChild(cardNode);
    cell.addEventListener('click', () => {
      const outcomes = bzOutcomesForCandidate(candidate, pendingBuildChoice.playerId);
      if (outcomes.length > 1) {
        pendingBzOutcomeChoice = { candidate, outcomes };
        render(STATE);
        return;
      }
      commitBuildCandidate(candidate, outcomes.length === 1 ? outcomes[0].bzDiscount : {});
    });
    wrapper.appendChild(cell);
    return wrapper;
  }
  // 建築とLVアップを上下2セクションに分ける (2026-08-16, per user request: "建築は建築 LVアップはLVアップで
  // 上下に分ける" -- previously both types were mixed into one flat wrapping row, distinguished only by
  // the small per-card "LVアップ" label).
  const newBuildCandidates = affordableCandidates.filter((c) => c.type !== 'UPGRADE');
  const upgradeCandidates = affordableCandidates.filter((c) => c.type === 'UPGRADE');
  if (newBuildCandidates.length > 0) {
    list.appendChild(el('div', 'build-choice-section-header', '建築'));
    const group = el('div', 'build-choice-group');
    for (const candidate of newBuildCandidates) group.appendChild(buildCandidateCell(candidate));
    list.appendChild(group);
  }
  if (upgradeCandidates.length > 0) {
    const upgradeHeaderClass = newBuildCandidates.length > 0
      ? 'build-choice-section-header build-choice-section-header--divider'
      : 'build-choice-section-header';
    list.appendChild(el('div', upgradeHeaderClass, 'LVアップ'));
    const group = el('div', 'build-choice-group');
    for (const candidate of upgradeCandidates) group.appendChild(buildCandidateCell(candidate));
    list.appendChild(group);
  }
}

/** 色欲's payment-choice prompt for an AREA that pays A/B/C directly (see
 * attemptPlaceSelectedDie/areaColorPayResources) -- unlike renderBuildChoicePaymentControls (which
 * only ever adjusts a payment that's already been decided to happen), this pauses the placement
 * itself, so it needs its own confirm/cancel, wired once in the DOMContentLoaded handler below. */
function renderPlacementChoiceModal() {
  const overlay = document.getElementById('placement-choice-overlay');
  if (!pendingPlacementChoice) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const body = document.getElementById('placement-choice-body');
  body.innerHTML = '';
  for (const resource of pendingPlacementChoice.colors) {
    const group = el('div', 'build-choice-payment__group');
    group.appendChild(el('span', 'build-choice-payment__resource', resource));
    const current = pendingPlacementChoice.colorPreference[resource] === 'Z' ? 'Z' : 'AUTO';
    const realBtn = el('button', 'build-choice-payment__option', `資源${resource}優先`);
    const zBtn = el('button', 'build-choice-payment__option', '資源Z優先');
    realBtn.type = 'button';
    zBtn.type = 'button';
    realBtn.classList.toggle('build-choice-payment__option--active', current === 'AUTO');
    zBtn.classList.toggle('build-choice-payment__option--active', current === 'Z');
    realBtn.addEventListener('click', () => { pendingPlacementChoice.colorPreference[resource] = 'AUTO'; render(STATE); });
    zBtn.addEventListener('click', () => { pendingPlacementChoice.colorPreference[resource] = 'Z'; render(STATE); });
    group.appendChild(realBtn);
    group.appendChild(zBtn);
    body.appendChild(group);
  }
}

// Kinds that support targeting one of the player's own eligible cards instead of a real die (2026-08-25,
// per user request: "カードのダイス目も変えられるようにしたい") -- SET_DICE_ANY is excluded on purpose:
// no real card uses it any more (JOB003 switched to WILDCARD_DICE), and the user's own spec for this
// feature only ever listed the SET_DIE_VALUE(1|2)/SET_DIE_VALUE(5|6)/CHANGE_DIE_VALUE(±1)/
// MONUMENT_CHANGE_DIE_VALUE(+2) family.
const CARD_TARGETABLE_TAP_KINDS = new Set(['SET_DIE_VALUE', 'CHANGE_DIE_VALUE', 'MONUMENT_CHANGE_DIE_VALUE']);

/** Die (or, 2026-08-25, card) + value choice for a bare TAP ability (SET_DICE_ANY/SET_DIE_VALUE/
 * CHANGE_DIE_VALUE/MONUMENT_CHANGE_DIE_VALUE, see attachTapToggle/bareTapKind) -- board.useBareTapAbility
 * needs chosenDieId (or chosenCardPhysicalId) plus chosenValue (SET_*) or chosenDelta
 * (CHANGE_DIE_VALUE) supplied *before* it runs the TAP field (the whole field is one atomic program, so
 * there's no mid-run prompt); MONUMENT_CHANGE_DIE_VALUE needs neither -- its delta is a single fixed
 * number baked into the DSL, so #tap-choice-values stays empty for that kind. Picking a die clears any
 * card pick and vice versa (mutually exclusive targets, same underlying `context.chosenDieId` XOR
 * `chosenCardPhysicalId` the engine expects). #tap-choice-cards only lists the player's own untapped
 * cards whose own TAP resolves to a literal-N BUILD (executor.cardOwnFixedBuildValue's own doc) -- a
 * tapped one has no near-term use for the override before it's cleared at TURNEND, and CARD_TARGETABLE_
 * TAP_KINDS gates which bareTap kinds even offer this option at all. Confirm is disabled until a target
 * is picked (and a value too, for the kinds that need one). Cancelable -- nothing committed yet. */
function renderTapChoiceModal() {
  const overlay = document.getElementById('tap-choice-overlay');
  if (!pendingTapChoice) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const { playerId, dieId, cardPhysicalId, value, bareTap } = pendingTapChoice;
  const player = STATE.players.find((p) => p.id === playerId);

  const diceEl = document.getElementById('tap-choice-dice');
  diceEl.innerHTML = '';
  for (const die of player.dice.filter((d) => d.placedMapId === null)) {
    const dieNode = renderDie({ ...die, color: player.color });
    dieNode.classList.add('die--selectable');
    dieNode.classList.toggle('die--selected', die.id === dieId);
    dieNode.addEventListener('click', () => { pendingTapChoice.dieId = die.id; pendingTapChoice.cardPhysicalId = null; render(STATE); });
    diceEl.appendChild(dieNode);
  }

  const cardsEl = document.getElementById('tap-choice-cards');
  cardsEl.innerHTML = '';
  if (CARD_TARGETABLE_TAP_KINDS.has(bareTap.kind)) {
    const eligiblePhysicalIds = player.ownedCardPhysicalIds.filter((physicalId) => {
      const inst = STATE.cards[physicalId];
      return !inst.tapped && executorMod.cardOwnFixedBuildValue(INDEX, inst.currentFaceId) !== null;
    });
    for (const physicalId of eligiblePhysicalIds) {
      const inst = STATE.cards[physicalId];
      const cell = el('div', 'owned-card-cell owned-card-cell--tall owned-card-cell--selectable');
      cell.classList.toggle('owned-card-cell--selected', physicalId === cardPhysicalId);
      cell.appendChild(buildCardVisual(inst.currentFaceId, { showEffect: true, noInteraction: true }));
      cell.addEventListener('click', () => { pendingTapChoice.cardPhysicalId = physicalId; pendingTapChoice.dieId = null; render(STATE); });
      cardsEl.appendChild(cell);
    }
  }

  const valuesEl = document.getElementById('tap-choice-values');
  valuesEl.innerHTML = '';
  if (bareTap.kind !== 'MONUMENT_CHANGE_DIE_VALUE') {
    const valueOptions = bareTap.kind === 'SET_DICE_ANY' ? [1, 2, 3, 4, 5, 6] : bareTap.choices;
    for (const option of valueOptions) {
      const label = bareTap.kind === 'CHANGE_DIE_VALUE' ? (option > 0 ? `+${option}` : `${option}`) : `${option}`;
      const btn = el('button', 'build-choice-payment__option', label);
      btn.type = 'button';
      btn.classList.toggle('build-choice-payment__option--active', option === value);
      btn.addEventListener('click', () => { pendingTapChoice.value = option; render(STATE); });
      valuesEl.appendChild(btn);
    }
  }

  const hasTarget = dieId !== null || cardPhysicalId !== null;
  const needsValue = bareTap.kind !== 'MONUMENT_CHANGE_DIE_VALUE';
  document.getElementById('tap-choice-confirm').disabled = !hasTarget || (needsValue && value === null);
}

/** Auto/manual mode choice for a card's reactive TAP ability, right after it's acquired (see
 * pendingAutoModeChoice's own comment). Not blocking -- the data's own AUTO-column default already
 * applies on its own, this is purely optional and dismissable. Flipping either button applies
 * immediately (executor.setCardAutoMode) and keeps the modal open so they can flip back and forth
 * before dismissing. */
function renderAutoModeChoiceModal() {
  const overlay = document.getElementById('auto-mode-choice-overlay');
  if (!pendingAutoModeChoice) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const { physicalId, playerId } = pendingAutoModeChoice;
  const cardState = STATE.cards[physicalId];
  const isAuto = executorMod.isCardAutoMode(STATE, INDEX, playerId, physicalId);

  const preview = document.getElementById('auto-mode-choice-card');
  preview.innerHTML = '';
  preview.appendChild(buildCardVisual(cardState.currentFaceId, { showEffect: true, noInteraction: true }));

  const autoBtn = document.getElementById('auto-mode-choice-auto');
  const manualBtn = document.getElementById('auto-mode-choice-manual');
  autoBtn.classList.toggle('build-choice-payment__option--active', isAuto);
  manualBtn.classList.toggle('build-choice-payment__option--active', !isAuto);
  autoBtn.onclick = () => { executorMod.setCardAutoMode(STATE, playerId, physicalId, true); render(STATE); };
  manualBtn.onclick = () => { executorMod.setCardAutoMode(STATE, playerId, physicalId, false); render(STATE); };
}

/** RESOURCE_LIMIT/FORCE_CONVERT's "はい/いいえ" confirmation before actually ending a turn (2026-08-01,
 * see turnEndWarnings/attemptAdvanceTurn -- previously always auto-confirmed as "はい"). Shows each
 * applicable card's own WARNING text verbatim (data-driven, no hardcoded copy here). Wired once in the
 * DOMContentLoaded handler below. */
function renderTurnEndWarningModal() {
  const overlay = document.getElementById('turn-end-warning-overlay');
  if (!pendingTurnEndWarning) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const body = document.getElementById('turn-end-warning-body');
  body.innerHTML = '';
  for (const warning of pendingTurnEndWarning.warnings) {
    body.appendChild(el('p', 'turn-end-warning__text', warning.warningText));
  }
}

/** Whoever currently has full, click-driven control of their own TURN: onboarding finished (JOB *and*
 * CON both chosen, per [[project-dice-wp-flow-spec]]'s JOB->CON->初期資源受取->第1ターン order -- see
 * hasFinishedOnboarding for why next.type==='TURN' alone isn't sufficient) and not AI-driven (their
 * turn is driven entirely by driveOneAiStep, never by clicks). Shared by renderPlayers (per-die/per-
 * card action gating) and the header's round-pass button (2026-08-02) so the two can't drift apart. */
function actingHumanPlayerId(state, next) {
  if (!next) return null;
  const activePlayer = state.players.find((p) => p.id === next.playerId);
  if (!activePlayer || !hasFinishedOnboarding(activePlayer) || isAiPlayer(next.playerId)) return null;
  // UNTAP_CHOICE (2026-08-20 bug fix, per user report: "農夫を獲得した時アンタップするカードを選ばなくても
  // 進めてしまう...他の操作（ダイス配置など）ができてしまう") -- nothing gated pending choices at all
  // (canEndTurn only ever checked RESOURCE_TOTAL_LIMIT/pendingFee), so a player could freely place dice/
  // use free actions/end their turn while renderUntapChoice's own panel sat there unresolved. Blocking
  // here (the one chokepoint every one of those actions is already gated through, see canPlaceDiceFor's
  // callers) forces the choice to be resolved first, same as an unpayable usage fee already does.
  if (state.pendingChoices.some((c) => c.playerId === next.playerId && c.kind === 'UNTAP_CHOICE')) return null;
  return next.playerId;
}

/** True if some *proper* (non-empty, not-the-whole-set) subset of `values` already sums to >=cap --
 * i.e. `values` contains at least one redundant/unnecessary element for reaching cap (2026-08-06, per
 * user feedback on the castle/AREA009 monument dice-selection UI: "組み合わせで合計が12以上になる組み
 * 合わせは選べない...1，6，6の順番で選んでもダメ"). Brute-forces every subset via bitmask -- values.length
 * is always small (a player never holds more than a handful of unplaced dice at once), so this is cheap.
 * Used to reject a die pick that would make the selection non-minimal, regardless of pick order. */
function hasQualifyingProperSubset(values, cap) {
  const n = values.length;
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += values[i];
    if (sum >= cap) return true;
  }
  return false;
}

function renderPlayers(state, next) {
  const container = document.getElementById('players');
  container.innerHTML = '';
  const activePlayerId = next ? next.playerId : null;
  const canPlaceDiceFor = actingHumanPlayerId(state, next);
  // Fixed seat order for the whole round (2026-08-06, supersedes the 2026-08-05 "rotates to whoever's
  // turn it is" scheme -- per user feedback, the resource-area position should lock in as soon as this
  // round's turnOrder is decided (setup.computeStartOrder, called before JOB selection even starts) and
  // stay put until the next round's turnOrder is computed (turn-flow.endRound). roundOrderedPlayers
  // below reads state.turnOrder directly instead of rotating it -- see its own comment for why that's
  // already exactly "decided once per round, unchanged until the round boundary" with no extra state.
  roundOrderedPlayers(state).forEach((player) => {
    const tpl = document.getElementById('tpl-player-panel');
    const node = tpl.content.firstElementChild.cloneNode(true);
    if (player.id === activePlayerId) node.classList.add('player-panel--active');

    node.querySelector('.player-panel__swatch').dataset.color = player.color;
    node.querySelector('.player-panel__name').textContent = player.name;
    // Live running score (2026-08-04, per user feedback: "プレイ中もカードVP込みの合計得点をリアルタイ
    // ム表示するように") -- previously this header badge showed only player.resources.VP, the raw "VP
    // as a resource" pool that ADD(VP) grants into (only C301A's TAP does this in the current data --
    // was B008B's ONCE at the time of this fix, before both the 2026-08-24 SHOP201-203 card renumbering
    // and B301B's own later PASSIVE=VP_MODIFIER(MAX_EMBLEM_COUNT) rework moved it off ADD(VP) entirely),
    // NOT
    // a monument/card's own printed VP column (only tallied at GAME_END via scoring.computeFinalScore).
    // A player who'd just built a 5-VP monument saw this badge stuck at "0 VP" the whole game, which read
    // as broken even though it was working as originally scoped. computeFinalScore already sums exactly
    // what GAME_END shows (owned cards' printed VP + resources.VP + active VP_MODIFIERs) and is state-only
    // (no side effects), so it's safe to call every render, not just at GAME_END.
    node.querySelector('.player-panel__score').textContent = `${scoringMod.computeFinalScore(state, INDEX, player.id)} 点`;

    const resourcesEl = node.querySelector('.player-panel__resources');
    // VP itself still shows as an ordinary resource badge (2026-08-04) now that the header badge above
    // shows the combined score instead of the raw resource -- otherwise a player who actually held VP as
    // a resource (via C301A's TAP, see this function's own comment above) would have no way to see that
    // raw count anymore.
    for (const resource of ['K', 'A', 'B', 'C', 'Z', 'BZ', 'VP']) {
      const count = player.resources[resource] || 0;
      if (count > 0) resourcesEl.appendChild(renderResourceBadge(resource, count));
    }

    // Split into two rows -- color dice and wD (confirmed 2026-07-30) -- rather than one mixed row.
    const colorDiceEl = node.querySelector('.player-panel__dice-row--color');
    const whiteDiceEl = node.querySelector('.player-panel__dice-row--white');
    // JOB003/道化 (2026-08-19): checked once per player, applies to every one of their dice (COLOR and
    // WHITE alike) uniformly -- see board.hasWildcardDice's own doc.
    const playerIsWildcard = boardMod.hasWildcardDice(state, INDEX, player.id);
    for (const die of player.dice) {
      if (die.placedMapId) continue; // dice on the board are shown on the board, not in-hand
      const rowEl = die.kind === 'WHITE' ? whiteDiceEl : colorDiceEl;
      const dieNode = renderDie({ ...die, color: player.color, wildcard: playerIsWildcard });
      // Passed (2026-08-03, see board.passDie) -- stays visible in hand so it's clear where it went,
      // but not selectable again until next round's reset.
      if (die.passed) dieNode.classList.add('die--passed');
      // 1手ずつペースの事前ハイライト (2026-08-16) -- see pumpAiDelayed's own doc: this specific die is
      // what the AI is about to place, shown during the existing pre-placement wait.
      if (aiPreHighlightMove && aiPreHighlightMove.playerId === player.id && aiPreHighlightMove.dieId === die.id) {
        dieNode.classList.add('change-highlight--pending');
      }
      // Click to select a die for placement (2026-07-30, real engine wiring pass 2) -- see
      // placeSelectedDie/renderBoard's slot click handler, the other half of this interaction.
      // !turnActionTaken (2026-08-02 bug fix, per user report: "ダイスをおいた後もう一回ダイスを置こう
      // とすると置けてしまいます") -- "1ターン=ダイス1個の配置" per [[project-dice-wp-flow-spec]], but
      // this gate was missing entirely: once turnActionTaken became true (2026-08-01's "don't auto-end
      // the turn" change), a *different* remaining die was still shown as die--selectable with a click
      // listener, letting the player select and place a second die before ever clicking "ターン終了".
      if (player.id === canPlaceDiceFor && !die.passed && !turnActionTaken) {
        dieNode.classList.add('die--selectable');
        if (selectedDieIds.includes(die.id)) dieNode.classList.add('die--selected');
        // Multi-select toggle (2026-08-02, per user feedback: "1個目のダイスをクリック 2個目のダイスを
        // クリック...モニュメントを建築することは出来ます") -- clicking a die toggles its membership in
        // selectedDieIds rather than replacing a single value. Mixed values are allowed (the castle/
        // AREA009 group-placement path, see placeSelectedDiceGroup, doesn't require doubles), capped at
        // 12 (the highest monument threshold). **No redundant dice** (2026-08-06, per user feedback,
        // replacing the old plain "running sum < 12" cap): a die can't be added if doing so would leave
        // some *other* subset of the resulting selection already summing to >=12 on its own -- e.g.
        // selecting 1,6,6 must be blocked the moment the 2nd 6 goes in (6+6 alone already reaches 12,
        // making the 1 dead weight), and this has to hold regardless of pick order (confirmed: "1，6，6
        // の順番で選んでもダメ"), not just "was the running total already >=12 before this click". See
        // hasQualifyingProperSubset's own doc.
        dieNode.addEventListener('click', () => {
          const idx = selectedDieIds.indexOf(die.id);
          if (idx !== -1) {
            selectedDieIds.splice(idx, 1);
          } else if (selectedDieIds.length === 0 || playerIsWildcard) {
            // ☆ dice are solo-only (2026-08-20, per user request: "道化の☆ダイスは1個でしか使えない
            // （ダイス目7以上は獲得できない）" -- board.placeDiceGroup now refuses outright for a
            // wildcard-owning player, see that function's own doc). Clicking a different die while one is
            // already selected REPLACES the selection instead of adding to it, so the UI never lets this
            // player build toward a 2-die group placement that would only fail at commit time.
            selectedDieIds = [die.id];
          } else {
            // Never reached for a wildcard player (the branch above always replaces instead, so
            // selectedDieIds can never exceed length 1 for them) -- real dice values only.
            const prospectiveValues = [...selectedDieIds, die.id].map((id) => player.dice.find((d) => d.id === id).value);
            if (!hasQualifyingProperSubset(prospectiveValues, 12)) selectedDieIds.push(die.id);
          }
          render(STATE);
        });
      }
      rowEl.appendChild(dieNode);
    }

    renderFreeActionButtons(node.querySelector('.player-panel__free-actions'), state, player, player.id === canPlaceDiceFor);
    renderTapReactions(node.querySelector('.player-panel__tap-reactions'), state, player.id);
    renderUntapChoice(node.querySelector('.player-panel__untap-choice'), state, player.id);
    renderTurnEndButton(node.querySelector('.player-panel__turn-end'), state, player, player.id === canPlaceDiceFor);

    container.appendChild(node);
  });
}

/** Pending manual-mode TAP reactions (2026-07-30, real engine wiring pass 6): whenever a GET event
 * fires (e.g. from a die placement's ADD effect, or a free action's own gain), executor.
 * emitAndResolve auto-resolves any auto-mode card's ON(GET(...),...) TAP reaction but queues a
 * TAP_REACTION_AVAILABLE pendingChoice for each manual-mode one instead (see executor.js's own doc
 * comment) -- this renders those, one row per choice, for whichever player they belong to (always the
 * player who just triggered the GET, regardless of whose real TURN it currently is -- these aren't
 * gated by canAct the way free actions are). The card's own TAP effect is looked up fresh via
 * factsForFaceId/buildCardVisual (reusing the exact same icon rendering as everywhere else) rather
 * than trying to re-derive display text from choice.context.effect (an already-lowered Command, not
 * raw DSL). "使う" commits via executor.resolveTapReaction; "見送る" just declines. Neither one is done
 * automatically by resolveTapReaction itself -- it doesn't remove the pendingChoice (confirmed via its
 * own source), so this splices it out of state.pendingChoices manually either way. */
function renderTapReactions(container, state, playerId) {
  container.innerHTML = '';
  // An AI player's own reactions are resolved by driveOneAiStep as part of its normal Move selection
  // (2026-08-03) -- shouldn't normally still be pending by the time this paints (esp. in 'instant'
  // mode), but during 'delayed'/'manual' pacing there's a real window where one is; skip rendering
  // entirely rather than showing the human clickable buttons for another player's decision.
  if (isAiPlayer(playerId)) return;
  const choices = state.pendingChoices.filter((c) => c.playerId === playerId && c.kind === 'TAP_REACTION_AVAILABLE');
  for (const choice of choices) {
    const { physicalId } = choice.context;
    const cardState = state.cards[physicalId];
    if (!cardState) continue; // shouldn't happen, but don't crash the render if it does
    const row = el('div', 'tap-reaction-row');
    const cardNode = buildCardVisual(cardState.currentFaceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cardCell = el('div', tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
    cardCell.appendChild(cardNode);
    row.appendChild(cardCell);

    const buttons = el('div', 'tap-reaction-buttons');
    const useBtn = el('button', 'tap-reaction-button tap-reaction-button--use', '使う');
    useBtn.type = 'button';
    useBtn.addEventListener('click', () => {
      executorMod.resolveTapReaction(state, INDEX, { playerId }, physicalId, choice.context.effect);
      state.pendingChoices = state.pendingChoices.filter((c) => c.id !== choice.id);
      render(STATE);
    });
    const skipBtn = el('button', 'tap-reaction-button tap-reaction-button--skip', '見送る');
    skipBtn.type = 'button';
    skipBtn.addEventListener('click', () => {
      state.pendingChoices = state.pendingChoices.filter((c) => c.id !== choice.id);
      render(STATE);
    });
    buttons.appendChild(useBtn);
    buttons.appendChild(skipBtn);
    row.appendChild(buttons);
    container.appendChild(row);
  }
}

/** Pending UNTAP_CHOICE pick (2026-08-15; reworked 2026-08-17 into a weighted budget, see
 * executor.untapChoiceWeight's own doc -- 兆しカード costs 2 of the budget (lowered from 3 on
 * 2026-08-21), everything else costs 1). Only ever shown when the player's tapped cards' combined
 * weight exceeds the budget
 * (otherwise already auto-resolved with no choice at all, so there's nothing to render here in that
 * case). AI-controlled players resolve this via driveOneAiStepInner instead (random pick), never by
 * clicks -- nothing to show here for them.
 *
 * 2026-08-18 UI rework, per user feedback the old "tap to enlarge -> tap 選ぶ in the modal -> repeat ->
 * tap a separate confirm button" flow was too many steps ("使いにくい"): tapping a card now toggles its
 * selection directly (color change via the existing .owned-card-cell--selected outline, same class the
 * old flow already used) with no enlarge modal at all -- the grid already renders full effect text
 * (showEffect:true), so there's nothing the modal added here. Once no further candidate can be added
 * within the remaining weighted budget (confirmPending below -- this can trigger with budget left over,
 * e.g. only a 兆しカード-weight candidate remains and it no longer fits, matching the user's own example),
 * every card locks (no more individual toggling) and an explicit "これでいいですか？" はい/いいえ prompt
 * appears in its place: はい commits the current selection (executor.resolveUntapChoice, same as
 * before), いいえ clears the selection back to empty so the player can start over. Below that trigger,
 * a lighter-weight "この内容で決定する" button is still offered whenever at least one card is selected --
 * preserving the pre-existing 2026-08-17 rule that the player may voluntarily spend less than the full
 * budget without maxing it out first.
 */
function renderUntapChoice(container, state, playerId) {
  container.innerHTML = '';
  if (isAiPlayer(playerId)) return;
  const choice = state.pendingChoices.find((c) => c.playerId === playerId && c.kind === 'UNTAP_CHOICE');
  if (!choice) return;
  if (!choice.context.selected) choice.context.selected = [];
  const selected = choice.context.selected;
  const weights = choice.context.weights;
  const selectedWeight = selected.reduce((sum, id) => sum + weights[id], 0);
  const anySelectable = choice.context.candidates.some(
    (id) => !selected.includes(id) && selectedWeight + weights[id] <= choice.context.count,
  );
  const confirmPending = selected.length > 0 && !anySelectable;
  container.appendChild(el('div', 'onboard-hint__line', `アンタップするカードを選んでください（使用予算 ${selectedWeight}/${choice.context.count}）`));
  for (const physicalId of choice.context.candidates) {
    const cardState = state.cards[physicalId];
    if (!cardState) continue;
    const isSelected = selected.includes(physicalId);
    const canToggle = !confirmPending && (isSelected || selectedWeight + weights[physicalId] <= choice.context.count);
    const cardNode = buildCardVisual(cardState.currentFaceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
    if (canToggle) cell.classList.add('owned-card-cell--selectable');
    if (isSelected) cell.classList.add('owned-card-cell--selected');
    cell.appendChild(cardNode);
    if (canToggle) {
      cell.addEventListener('click', () => {
        choice.context.selected = isSelected ? selected.filter((id) => id !== physicalId) : [...selected, physicalId];
        render(STATE);
      });
    }
    container.appendChild(cell);
  }
  if (confirmPending) {
    container.appendChild(el('div', 'onboard-hint__line', `これでいいですか？（使用予算 ${selectedWeight}/${choice.context.count}）`));
    // はい2倍サイズ (2026-08-22, per user report: "小さくて押しにくい") -- .untap-choice-yes scopes the
    // enlargement to just this button, since .build-choice-payment__option is shared with several
    // unrelated payment-option contexts elsewhere that shouldn't grow along with it. Also gets
    // .build-choice-payment__option--active (the same accent-highlight modifier already used for "this
    // option is the one in effect" elsewhere) whenever the full budget was actually used -- per user
    // request "所定の枚数を選んだら色が変わるように" -- so stopping short because nothing else fits
    // still reads as neutral/plain, while hitting the budget exactly reads as a clear "ready" affirmation.
    const yesBtn = el('button', 'build-choice-payment__option untap-choice-yes', 'はい');
    if (selectedWeight === choice.context.count) yesBtn.classList.add('build-choice-payment__option--active');
    yesBtn.type = 'button';
    yesBtn.onclick = () => { executorMod.resolveUntapChoice(state, playerId, selected); render(STATE); };
    container.appendChild(yesBtn);
    const noBtn = el('button', 'build-choice-payment__option', 'いいえ（選び直す）');
    noBtn.type = 'button';
    noBtn.onclick = () => { choice.context.selected = []; render(STATE); };
    container.appendChild(noBtn);
  } else if (selected.length > 0) {
    const confirmBtn = el('button', 'build-choice-payment__option', `この内容でアンタップする（${selectedWeight}/${choice.context.count}）`);
    confirmBtn.type = 'button';
    confirmBtn.onclick = () => { executorMod.resolveUntapChoice(state, playerId, selected); render(STATE); };
    container.appendChild(confirmBtn);
  }
}

/** A/B/C/Z->K (2026-07-30, real engine wiring pass 5; corrected 2026-08-02) -- confirmed via
 * [[project-dice-wp-dsl-spec]]: usable anytime during the player's own turn, with NO usage limit at
 * all ("回数制限ありません") -- same as usage-fee collection since 2026-08-06 (see executor.collectUsageFee),
 * though that one lives on the map tile itself, not this button row. Only rendered for the player whose
 * real TURN it currently is (canAct); unaffordable actions are still shown -- clicking one you can't
 * pay for just surfaces INSUFFICIENT_RESOURCES via placementMessage, same pattern as dice
 * placement/BUILD selection elsewhere in this file, rather than being pre-validated away.
 * (2026-08-07: wD->2K, formerly a 5th button here, was abolished per user request -- see
 * game-state.js's FREE_ACTION_IDS for the engine-side removal.) */
const FREE_ACTION_LABELS = { A_K: 'A→K', B_K: 'B→K', C_K: 'C→K', Z_K: 'Z→K' };
function renderFreeActionButtons(container, state, player, canAct) {
  container.innerHTML = '';
  if (!canAct) return;
  for (const freeActionId of ['A_K', 'B_K', 'C_K', 'Z_K']) {
    const btn = el('button', 'free-action-button', FREE_ACTION_LABELS[freeActionId]);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const result = executorMod.tryFreeAction(state, INDEX, player.id, freeActionId);
      if (result.success) {
        placementMessage = '';
        // Retries a turn-end this same free action may have just unblocked (see
        // pendingTurnEndPlayerId's own comment) -- e.g. converting Z->K after RESOURCE_TOTAL_LIMIT
        // blocked ending this player's turn.
        if (pendingTurnEndPlayerId === player.id) attemptAdvanceTurn(state, player.id);
      } else {
        placementMessage = `フリーアクションを実行できません（${result.reason}）`;
      }
      render(STATE);
    });
    container.appendChild(btn);
  }
}

/** "ターン終了" button (2026-08-01, per user feedback -- see turnActionTaken's own comment): only
 * shown once this player has resolved this turn's die placement (turnActionTaken), so they get a
 * window to use free actions/bare TAP abilities first. Clicking it runs the same WARNING-gated
 * attemptAdvanceTurn free actions' retry already uses. */
function renderTurnEndButton(container, state, player, canAct) {
  container.innerHTML = '';
  if (!canAct || !turnActionTaken) return;
  const btn = el('button', 'free-action-button turn-end-button', 'ターン終了');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    attemptAdvanceTurn(state, player.id);
    render(STATE);
  });
  container.appendChild(btn);
}

/** Right sidebar: every player's owned cards, grouped by player (confirmed 2026-07-29). */
/**
 * Player groups ordered starting from whoever's turn it currently is, then following turnOrder around
 * (confirmed 2026-07-29) -- re-sorts every render, so it reshuffles as the turn changes. Before round
 * 1 actually starts (state.round===0, still picking RESOURCE cards -- see maybeStartRound1) there's no
 * turnOrder yet and no single "active" player, so this just returns state.players in creation order.
 */
function turnOrderedPlayers(state, activePlayerId) {
  if (!activePlayerId || !state.turnOrder.length) return state.players;
  const n = state.turnOrder.length;
  const startIdx = state.turnOrder.indexOf(activePlayerId);
  const orderedIds = Array.from({ length: n }, (_, i) => state.turnOrder[(startIdx + i) % n]);
  return orderedIds.map((id) => state.players.find((p) => p.id === id));
}

/**
 * Player resource-area order (renderPlayers only, 2026-08-06): state.turnOrder's own order, un-rotated.
 * Unlike turnOrderedPlayers (which re-sorts to whoever's turn it is right now, every render), this stays
 * put all round -- and it can, for free: state.turnOrder itself is only ever (re)computed once per round
 * (setup.computeStartOrder for round 1, before JOB selection even starts; turn-flow.computeNextRoundTurnOrder
 * at each subsequent round's start) and is never touched mid-round. So reading it directly, instead of
 * rotating it to the active player like turnOrderedPlayers does, already gives exactly the requested
 * behavior with no separate snapshot to keep in sync (and nothing extra for debug-history jumps to restore).
 * Same pre-round-1 fallback as turnOrderedPlayers (no turnOrder yet -> creation order).
 */
function roundOrderedPlayers(state) {
  if (!state.turnOrder.length) return state.players;
  return state.turnOrder.map((id) => state.players.find((p) => p.id === id));
}

/** Whether player has finished round-1 onboarding (JOB drafted AND CON face chosen). Needed because
 * turn-flow.getNextTurn's 'TURN' vs 'ONBOARDING_NEEDED' only checks jobCardId (see its own source) --
 * it already reports 'TURN' once JOB is drafted, even before CON is chosen. Used both to gate dice
 * placement (renderPlayers) and to decide whether the whole card-group gets the "手番" background
 * highlight (renderPlayerCards) -- confirmed 2026-07-30, per user feedback: during JOB/CON selection,
 * only the specific job-pool/CON-row highlight (.onboard-panel--active) should show, not the whole
 * group, since highlighting both is redundant. */
function hasFinishedOnboarding(player) {
  return player.jobCardId !== null && player.ownedCardPhysicalIds.some((id) => id.startsWith('CON'));
}

/**
 * Classifies faceId's TAP field for the *direct*-use dblclick gesture below (2026-07-31) -- null if
 * there's nothing to directly use: no TAP field at all, or every top-level statement is ON(...) (a
 * purely event-triggered reaction, e.g. JOB005A's ON(GET(K),CHANGE(K,Z)) -- that's exclusively offered
 * via the TAP_REACTION_AVAILABLE pendingChoice rows/renderTapReactions, never this dblclick). SET_DICE_ANY/
 * SET_DIE_VALUE/CHANGE_DIE_VALUE only ever appear as the *first* statement in the current dataset, so only
 * that needs checking for those 3 kinds. BUILD used to be first-only too, but JOB010's "PAY(2K);BUILD(U)"
 * (2026-08-17) has a flat cost ahead of it -- see board.resolveProgramOrBuild's own doc -- so this checks
 * for BUILD anywhere in the field, not just commands[0] (a no-op change for every other card, where BUILD
 * when present has always been first).
 */
function bareTapKind(faceId) {
  let row;
  try { row = dataLoaderMod.getCardRow(INDEX, faceId); } catch (e) { return null; }
  if (!row.TAP) return null;
  const commands = commandBuilderMod.lowerProgram(dslParserMod.parse(row.TAP));
  if (commands.every((c) => c.type === 'ON')) return null;
  const first = commands[0];
  if (first.type === 'SET_DICE_ANY') return { kind: 'SET_DICE_ANY' };
  if (first.type === 'SET_DIE_VALUE') return { kind: 'SET_DIE_VALUE', choices: first.choices };
  if (first.type === 'CHANGE_DIE_VALUE') return { kind: 'CHANGE_DIE_VALUE', choices: first.choices };
  // MONUMENT_CHANGE_DIE_VALUE(SELF+2) (2026-08-24, JOB007/宮廷人's revised TAP) -- same die-choice
  // modal as CHANGE_DIE_VALUE, but the delta is a single fixed number baked in at DSL-lowering time
  // (cmd.delta), never a player-picked one of several choices, so renderTapChoiceModal skips the value
  // picker for this kind entirely. Searched ANYWHERE in the field, not just commands[0] (2026-08-25 fix,
  // per user report: "宮廷人を使おうとしてTAPしようとするとカードを使用できませんと出ます" -- JOB007's
  // own TAP is "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(...)", so first.type was 'ADD',
  // this branch never matched, and it fell all the way through to IMMEDIATE -- calling useBareTapAbility
  // directly with no chosenDieId ever gathered, which the die-value-change command then had nothing to
  // act on. ADD(BZ) is an unconditional grant with no choice of its own, same "flat leading effect ahead
  // of the real interactive command" shape BUILD's own check just above already handles for JOB010.
  const monumentChangeDieValue = commands.find((c) => c.type === 'MONUMENT_CHANGE_DIE_VALUE');
  if (monumentChangeDieValue) return { kind: 'MONUMENT_CHANGE_DIE_VALUE' };
  if (commands.some((c) => c.type === 'BUILD')) return { kind: 'BUILD' };
  return { kind: 'IMMEDIATE' };
}

// 実業家/酒場の主人 (2026-08-17, per user request: "実業家と酒場の主人はオート マニュアルの選択なしで
// オートのみにします"; 酒場の主人/JOB005 renamed to 権力者 2026-08-25, matched below by its current
// NAME) -- both are currently the only 2 cards in the whole dataset with a fully ON(...)-
// wrapped TAP (confirmed via a full sheet scan), so reactiveTapKind below only ever fires the auto/
// manual choice modal for these two today; excluded here so it never fires for them at all, always
// resolving to their AUTO-column default ("A" for both) via executor.isCardAutoMode's own fallback --
// no override is ever set for them, so there's nothing else to change. Matched by NAME rather than
// faceId (JOB002/JOB005 today) so a future JOB-sheet reorg can't silently break this the way CON's own
// physical-id reorg did (see feedback memory on that incident).
const AUTO_ONLY_JOB_NAMES = new Set(['実業家', '権力者']);

/** Whether faceId's TAP field is purely ON(...)-wrapped -- a reactive ability with an auto/manual
 * setting worth choosing (see executor.isCardAutoMode/setCardAutoMode), the opposite case from
 * bareTapKind. false for no TAP field, or a bare (direct-use) one instead -- those have no auto/manual
 * concept at all (the player just uses them or doesn't, there's no "does this auto-fire" question).
 * Also false for AUTO_ONLY_JOB_NAMES (see its own doc) even though their TAP does qualify. */
function reactiveTapKind(faceId) {
  let row;
  try { row = dataLoaderMod.getCardRow(INDEX, faceId); } catch (e) { return false; }
  if (AUTO_ONLY_JOB_NAMES.has(row.NAME)) return false;
  if (!row.TAP) return false;
  const commands = commandBuilderMod.lowerProgram(dslParserMod.parse(row.TAP));
  return commands.length > 0 && commands.every((c) => c.type === 'ON');
}

/**
 * Tapping a card's own *effect box* (the lower "⤵️..." zone, below the divider line -- see
 * .shop-card__effect) uses its direct TAP ability via board.useBareTapAbility, instead of opening
 * the card's enlarge modal like tapping the rest of the card does (2026-08-0X: previously this was a
 * whole-card dblclick, replaced for touch parity -- iPad has no reliable dblclick, and splitting the
 * card into an "upper = info, lower = use it" zone per user's own proposal reads naturally on a
 * touchscreen without needing a second gesture at all). stopPropagation() keeps the card-wide
 * click-to-enlarge listener (see buildCardVisual) from also firing underneath this one. Restricted to
 * the active player's own cards, only once they've actually finished onboarding (canAct -- same gate
 * as renderFreeActionButtons, since a bare TAP ability is usable "any time during your own turn"
 * exactly like a free action), and only cards with something to directly use (bareTapKind non-null;
 * ON(...)-only TAP fields get no listener at all here -- see renderTapReactions for those, unaffected
 * by this change). SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE need a die+value choice first (see
 * renderTapChoiceModal); BUILD needs the same candidate-selection modal AREA/QST BUILDs use
 * (source:'TAP', see renderBuildChoiceModal); everything else runs immediately on tap.
 */
function attachTapToggle(cardNode, cardState, faceId, canAct, physicalId) {
  if (!canAct) return;
  const bareTap = bareTapKind(faceId);
  if (!bareTap) return;
  const effectEl = cardNode.querySelector(':scope > .shop-card__effect');
  if (!effectEl) return;
  effectEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cardState.tapped) return;
    // No longer blocked while a usage fee is owed (2026-08-10 -- see board.useBareTapAbility's own doc
    // on why that gate was removed there; mirrored here since this used to pre-empt it before the picker
    // modal even opened).
    if (bareTap.kind === 'IMMEDIATE') {
      const result = boardMod.useBareTapAbility(STATE, INDEX, { playerId: cardState.ownerId }, physicalId);
      placementMessage = result.success ? '' : `カードを使用できません（${result.reason}）`;
    } else if (bareTap.kind === 'BUILD') {
      const result = boardMod.useBareTapAbility(STATE, INDEX, { playerId: cardState.ownerId }, physicalId);
      if (result.success && result.pendingBuild) {
        pendingBuildChoice = { source: 'TAP', playerId: cardState.ownerId, ...result.pendingBuild };
        buildColorPreference = {};
        pendingBzOutcomeChoice = null;
        placementMessage = '';
      } else if (
        // 傲慢/CON004A (2026-08-21, per user report: 革命の兆しLV2のBUILD(U)がNO_BUILDABLE_CARDという
        // 生の理由コードだけを表示していて分かりにくかった -- die-placement's own build-choice-modal
        // already shows a friendly warning for this (isUpgradeBlockedByQstRank, see its own doc), but
        // this direct-TAP path never checked it at all. categories.includes('U') scopes this to TAP
        // fields that actually requested an upgrade (e.g. not B005A/B006A's BUILD((A,B,C,M),n)), so a
        // genuinely-unrelated NO_BUILDABLE_CARD (no affordable A/B/C/M candidate) still shows the plain
        // message.
        result.reason === 'NO_BUILDABLE_CARD' && result.categories && result.categories.includes('U')
        && boardMod.isUpgradeBlockedByQstRank(STATE, INDEX, cardState.ownerId)
      ) {
        placementMessage = '傲慢の効果でLVアップできません';
      } else {
        placementMessage = `カードを使用できません（${result.reason}）`;
      }
    } else {
      pendingTapChoice = { physicalId, playerId: cardState.ownerId, bareTap, dieId: null, cardPhysicalId: null, value: null };
    }
    render(STATE);
  });
}

/**
 * Wires a *noInteraction* card built for a "pick one of these" context (JOB draft pool / CON face
 * choice / initial RESOURCE choice) so tapping it opens the enlarge modal, with pickAction (see
 * showCardEnlargeModal) wired in when this particular card is actually choosable right now (null
 * otherwise -- e.g. a read-only CON preview shown before the player's actual turn to choose, which
 * still opens the modal to read the card, just without a pick button in it). 2026-08-0X, replacing
 * these contexts' old "click the cell = pick" gesture: that plain tap is now "open the enlarge modal
 * (see pickAction's own doc)", and the actual commit happens via the modal's pick button instead --
 * per the user's own original proposal for this ("シングルクリックで大きく表示...もう一度カードをタッ
 * プで本選択"). cardNode itself must be built with noInteraction:true by the caller (so buildCardVisual
 * doesn't *also* attach its own generic enlarge-on-tap listener underneath this one).
 */
function attachPickableEnlarge(cardNode, faceId, pickAction) {
  cardNode.addEventListener('click', () => {
    const sibling = siblingFaceId(faceId);
    const hasSiblingData = sibling && cardFaceExists(sibling);
    const visualNode = buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const siblingVisualNode = hasSiblingData
      ? buildCardVisual(sibling, { showEffect: true, allowTextFallback: false, noInteraction: true })
      : null;
    showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null, siblingVisualNode, pickAction);
  });
}

/** Built-card breakdown for the card-group header stats row (confirmed 2026-07-30): total built
 * (A/B/C + M -- JOB/CON/RESOURCE are all owned but never "built" via BUILD, so excluded, same
 * CARD_COUNT scope as the engine's own DSL semantics, see [[project-dice-wp-dsl-spec]] and
 * isBuiltCardPhysicalId), LV1/LV2 sub-counts (A/B/C only -- monuments have no LEVEL), monument count,
 * and EMBLEM_COUNT-style totals across EVERY owned card (2026-08-16: not scoped to "built" like the
 * others above -- a CON face can carry its own EMBLEM_A/B/C too, e.g. CON006B「祝福」's 1,1,1, and the
 * real engine's own TOTAL_EMBLEM_COUNT/QST goal scoring never excluded those either). */
function computePlayerBuildStats(player, state) {
  let built = 0, lv1 = 0, lv2 = 0, monuments = 0;
  const emblemCounts = { 天: 0, 地: 0, 人: 0 };
  for (const physicalId of player.ownedCardPhysicalIds) {
    const cardState = state.cards[physicalId];
    if (!cardState) continue;
    const faceId = cardState.currentFaceId;
    // Emblems count from every owned card, regardless of isBuiltCardPhysicalId (2026-08-16, per user
    // report: CON006B「祝福」's own EMBLEM_A/B/C(1,1,1) wasn't showing up here even though it's a real
    // owned card -- the actual scoring engine (executor.emblemCountsForRow, TOTAL_EMBLEM_COUNT/QST
    // goals) never restricted this to "built" cards either, only this UI stat did). A monument/CON card
    // can carry 0-3 emblems, each type possibly repeated (see emblemForFaceId) -- every one counts
    // separately, same as if the card had that many individual emblems.
    const emblem = emblemForFaceId(faceId);
    if (emblem) {
      for (const char of emblemChars(emblem)) {
        if (char in emblemCounts) emblemCounts[char]++;
      }
    }
    if (!isBuiltCardPhysicalId(physicalId)) continue;
    built++;
    if (isNormalDeckCard(physicalId)) {
      const level = levelForFaceId(faceId);
      if (level === 1) lv1++;
      else if (level === 2) lv2++;
    } else if (physicalId.startsWith('M')) {
      monuments++;
    }
  }
  return { built, lv1, lv2, monuments, emblemCounts };
}

/** Extra stats shown alongside the defaults only when a currently-revealed QST card's GOAL actually
 * needs one -- 建築数/LV1/LV2/天/地/人 already cover CARD_COUNT/LEVEL_COUNT/EMBLEM_COUNT(x)/
 * EMBLEM_SET_COUNT implicitly (a QST needing those doesn't need a new stat), so metrics already in
 * that set are skipped here; everything else gets a stat labeled with that QST card's own INST text.
 * 2026-08-09: computed via qst.js's real evalGoalMetric directly (no more mock re-implementation --
 * see this section's own header comment), so this can never drift from what the QST cards themselves
 * display or from what actually gets granted at GAME_END. */
const QST_EXTRA_STAT_SKIP_METRICS = new Set(['CARD_COUNT', 'LEVEL_COUNT', 'EMBLEM_COUNT', 'COUNT', 'EMBLEM_SET_COUNT']);
function computeQstExtraStats(state, player) {
  const extras = [];
  const seenGoals = new Set();
  for (const faceId of Object.keys(state.quests)) {
    const facts = factsForQstFaceId(faceId);
    const goalText = facts.goal;
    if (!goalText || seenGoals.has(goalText)) continue;
    seenGoals.add(goalText);
    const m = /^([A-Z_]+)/.exec(goalText);
    if (m && QST_EXTRA_STAT_SKIP_METRICS.has(m[1])) continue;
    try {
      extras.push({ label: facts.inst || goalText, value: qstMod.evalGoalMetric(state, INDEX, player.id, goalText) });
    } catch (e) { /* unparseable/unknown metric -- skip rather than crash the whole player panel */ }
  }
  return extras;
}

/** Renders computePlayerBuildStats' result as label/value pairs, plus any QST-driven extra stats
 * (see computeQstExtraStats) appended after them; a stat with count 0 is omitted entirely (same
 * "only show if > 0" convention as the resource badges) rather than printing "0". */
function renderPlayerStats(container, stats, extraStats) {
  container.innerHTML = '';
  const addStat = (label, value) => {
    if (!value) return;
    const stat = el('span', 'card-group__stat');
    stat.appendChild(el('span', 'card-group__stat-label', label));
    stat.appendChild(el('span', 'card-group__stat-value', String(value)));
    container.appendChild(stat);
  };
  addStat('建築数', stats.built);
  addStat('LV1', stats.lv1);
  addStat('LV2', stats.lv2);
  addStat('モニュメント', stats.monuments);
  addStat('天', stats.emblemCounts.天);
  addStat('地', stats.emblemCounts.地);
  addStat('人', stats.emblemCounts.人);
  for (const { label, value } of extraStats) addStat(label, value);
}

/** JOBカードプール (2026-07-30, per user feedback): revealed right after the SHOP is set up (state.
 * jobPool, via setup.dealJobPool -- already populated from createInitialState, so this is visible from
 * round 0 onward, same as the shop itself), and shown as its own persistent shared area between the
 * "所持カード" header and the player groups -- not tucked inside any one player's card list, since it
 * really is shared board state (one player drafting a card removes it from everyone else's options
 * too). Always shows however many of the original 6 remain, shrinking by 1 per draft. Only clickable
 * once it's actually someone's turn to draft (turn-flow.getNextTurn reports ONBOARDING_NEEDED, i.e.
 * round 1 has started and that player has no jobCardId yet) -- otherwise purely informational (e.g.
 * during round 0's RESOURCE selection, or once every player has already drafted).
 *
 * Auto-hides once round 1's first-turn-order player has started their 2nd real TURN (2026-08-04, per
 * user feedback: "えらばれなかったJOBは1番手の２ターン目から片付けてください") -- by then drafting is
 * long over (every player drafts during their round-1 ONBOARDING_NEEDED step, well before anyone's 2nd
 * TURN), so whatever's left in state.jobPool is permanently undrafted leftovers, not something anyone's
 * still deciding among. Leaving `container` empty is enough to hide it -- see .job-pool:empty in
 * style.css -- so this just skips the populate loop below rather than needing a separate visibility
 * toggle. See round1FirstPlayerTurnStartCount's own comment for how the count is tracked. */
function renderJobPool(state, next) {
  const container = document.getElementById('job-pool');
  container.innerHTML = '';
  if (round1FirstPlayerTurnStartCount >= 2) return;
  // !isAiPlayer (2026-08-03): an AI player's JOB draft is decided by driveOneAiStep, never by clicks.
  const draftingPlayerId = next && next.type === 'ONBOARDING_NEEDED' && !isAiPlayer(next.playerId) ? next.playerId : null;
  // Highlight the panel while it's actually someone's turn to draft from it (2026-07-30, per user
  // feedback: "今やるべきことの背景色を変えて"). #job-pool is a persistent element reused across
  // renders (unlike the per-player onboard-* containers, which are freshly cloned each render), so
  // this must be explicitly toggled off too, not just added.
  container.classList.toggle('onboard-panel--active', !!draftingPlayerId);
  for (const faceId of state.jobPool) {
    const cardNode = buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
    cell.appendChild(cardNode);
    // 2026-08-0X, per user feedback (JOB cards weren't tappable to enlarge at all): tapping the card
    // now always opens the enlarge modal; drafting it happens via the modal's pick button instead of
    // a plain tap on the cell -- see attachPickableEnlarge's own doc.
    if (draftingPlayerId) cell.classList.add('owned-card-cell--selectable');
    attachPickableEnlarge(cardNode, faceId, draftingPlayerId ? {
      label: 'このJOBを選ぶ',
      onPick: () => {
        const commit = () => {
          setupMod.chooseJob(state, INDEX, draftingPlayerId, faceId);
          // Auto/manual choice for the drafted JOB, if it has a reactive TAP ability (2026-07-31, per
          // user feedback -- see pendingAutoModeChoice's own comment).
          if (reactiveTapKind(faceId)) {
            pendingAutoModeChoice = { physicalId: gameStateMod.splitCardId(faceId).physicalId, playerId: draftingPlayerId };
          }
          render(STATE);
        };
        // wD-overflow confirm (2026-08-19, per user request) -- a JOB's own ONCE (e.g. JOB003/道化's
        // ADD(wD)) can trip this just like a shop-card build's ONCE can, if this player is already at
        // their wD cap (or already owns CON005B/憤怒's WHITE_DICE_CAP(0)) by the time they draft it.
        if (wouldCauseWhiteOverflow(state, (clone) => setupMod.chooseJob(clone, INDEX, draftingPlayerId, faceId))) {
          pendingWhiteOverflowConfirm = { onConfirm: commit };
          render(STATE);
          return;
        }
        commit();
      },
    } : null);
    container.appendChild(cell);
  }
}

/** JOB010/革命家's PICK_JOB_REPLACEMENT (2026-08-21, see setup.grantRevolutionaryBonusIfEarned/
 * resolveJobReplacementChoice's own docs): only ever pending for at most one human player at a time
 * (JOB010 can only be drafted once per game -- see setup.js's own doc), so this is a single full-screen
 * overlay (#job-replacement-choice-overlay, same "card-inst-overlay" shape as build-choice-overlay,
 * white-overflow-confirm-overlay, etc.) rather than a per-player panel like renderJobPool/renderConChoice
 * -- its z-index blocks every other click, including the CON-choice screen underneath, which would
 * otherwise let the player pick their CON face before this JOB decision is even final (turn-flow.
 * getNextTurn/hasFinishedOnboarding only ever check player.jobCardId, which is already non-null --
 * JOB010's own faceId -- the moment this choice is created). AI players never see this: driveOneAiStep's
 * ONBOARDING branch resolves it synchronously right after chooseJob, before this ever renders. */
function renderJobReplacementChoice(state) {
  const overlay = document.getElementById('job-replacement-choice-overlay');
  const choice = state.pendingChoices.find((c) => c.kind === 'PICK_JOB_REPLACEMENT' && !isAiPlayer(c.playerId));
  if (!choice) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const list = document.getElementById('job-replacement-choice-list');
  list.innerHTML = '';
  // .build-choice-group (reused, not a new class): flex-wrap row, centered, matching how
  // renderBuildChoiceModal lays out its own multi-candidate list.
  const group = el('div', 'build-choice-group');
  list.appendChild(group);
  for (const faceId of choice.context.candidates) {
    const cardNode = buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall owned-card-cell--selectable' : 'owned-card-cell owned-card-cell--selectable');
    cell.appendChild(cardNode);
    attachPickableEnlarge(cardNode, faceId, {
      label: 'このJOBを選ぶ',
      onPick: () => {
        const commit = () => {
          setupMod.resolveJobReplacementChoice(state, INDEX, choice.playerId, faceId);
          render(STATE);
        };
        // wD-overflow confirm (same reasoning as renderJobPool's own onPick, 2026-08-19) -- the newly
        // picked JOB's own ONCE can grant wD (e.g. if JOB003/道化 itself is one of the 3 candidates)
        // just as easily as a normal draft's ONCE can.
        if (wouldCauseWhiteOverflow(state, (clone) => setupMod.resolveJobReplacementChoice(clone, INDEX, choice.playerId, faceId))) {
          pendingWhiteOverflowConfirm = { onConfirm: commit };
          render(STATE);
          return;
        }
        commit();
      },
    });
    group.appendChild(cell);
  }
}

/** Both of player's CON faces side by side (2026-07-30, layout confirmed, see
 * [[project-dice-wp-ui-requirements]]) -- shared by renderConPreview (read-only, shown during
 * pre-round-1 RESOURCE selection) and renderConChoice (interactive, shown during round-1 onboarding).
 * onPick is null for the read-only preview, or a callback(face) to commit a choice. */
function renderConFacesRow(container, player, onPick) {
  if (!player.conPhysicalId) return;
  // Highlight only the real interactive choice, not the read-only pre-round-1 preview (2026-07-30,
  // per user feedback) -- container here is always a freshly-cloned template node (see
  // renderPlayerCards), so a plain add (no toggle-off) is enough, unlike renderJobPool's #job-pool.
  if (onPick) container.classList.add('onboard-panel--active');
  for (const face of ['A', 'B']) {
    const faceId = `${player.conPhysicalId}${face}`;
    const cardNode = buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cellClass = tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell';
    const cell = el('div', onPick ? `${cellClass} owned-card-cell--selectable` : cellClass);
    cell.appendChild(cardNode);
    // 2026-08-0X, per user feedback (CON cards weren't tappable to enlarge at all, in either the
    // read-only preview or the real choice): tapping the card now always opens the enlarge modal;
    // committing the choice happens via the modal's pick button -- see attachPickableEnlarge's own doc.
    attachPickableEnlarge(cardNode, faceId, onPick ? { label: `この面（${face}面）を選ぶ`, onPick: () => onPick(face) } : null);
    // 道化(JOB003)所有時、憤怒(CON005B)面への相性注意 (2026-08-19, per user request) -- purely
    // informational, not blocking: 道化のONCE=ADD(wD)はJOB選択時に既に使用済みなので実害はないが、
    // 憤怒のWHITE_DICE_CAP(0)を選ぶと以降道化と組み合わせる旨味がなくなることを知らせる。NAME一致で判定
    // （物理IDの将来的な再編に強くするため、他の同種チェックと同じ方針 -- board.hasPioneerAbility等参照）。
    // Text updated 2026-08-20, per user request: the wD overflow no longer becomes K -- it's simply lost
    // now (see executor.grantOneDie's own doc).
    if (dataLoaderMod.getCardRow(INDEX, faceId).NAME === '憤怒' && player.jobCardId
      && dataLoaderMod.getCardRow(INDEX, player.jobCardId).NAME === '道化') {
      cell.appendChild(el('div', 'onboard-hint__line onboard-hint__line--emphasis', '道化との相性が悪いカードです（wDが常に失われます）'));
    }
    container.appendChild(cell);
  }
  // Explanatory hint to the right of the two CON faces (2026-08-0X, per user request) -- shown in both
  // the read-only pre-round-1 preview and the real round-1 choice, since the instructions are relevant
  // either way (a player sees this row well before they can actually click it). The "tap the card for
  // details" line is deliberately called out as its own emphasized line -- see .onboard-hint__line--
  // emphasis -- since the enlarge-tap gesture it's pointing at (see showCardEnlargeModal) is otherwise
  // not discoverable at all on a card a player hasn't picked yet.
  container.appendChild(buildOnboardHint(
    [
      'JOB選択後　CONカードの表面か裏面を選んでください',
      'CONカードは制約カードです。表面より裏面のほうが獲得資源が大きい代わりに制約が厳しくなります',
    ],
    '詳しくはカードをタップ（クリック）してください',
  ));
}

/** Read-only CON preview (2026-07-30, per the user's feedback: "初期資源カードを2枚選ぶときCONが
 * わからないと困るので表裏両方表示してください") -- shown alongside renderResourceChoice, pre-round-1,
 * so a player can factor their CON card's effects into which 2 RESOURCE cards they keep, even though
 * the actual CON face choice doesn't happen until their round-1 onboarding turn (renderConChoice
 * below). Not clickable -- see renderPlayerCards, which only calls this one during state.round===0
 * and only renderConChoice (the real commit) once round 1 starts. */
function renderConPreview(container, player) {
  renderConFacesRow(container, player, null);
}

/** Round-1 onboarding's CON表裏選択 (2026-07-30, real engine wiring pass -- layout confirmed
 * 2026-07-30, see [[project-dice-wp-ui-requirements]]): shown only for whichever player
 * turn-flow.getNextTurn currently reports as ONBOARDING_NEEDED, once they've drafted a JOB but haven't
 * picked a CON face yet. Both faces are shown side by side at once (not a single flip-to-reveal card)
 * so they can be compared before choosing -- same visual as renderConPreview above, which the player
 * already saw once during RESOURCE selection, just not clickable there. Clicking one here commits
 * immediately via setup.chooseConFace, then runs setup.receiveInitialResources right away too
 * (confirmed 2026-07-30: per [[project-dice-wp-flow-spec]] steps 9-12, "初期資源受取" is the
 * onboarding step right after CON face choice -- it's not a separate player decision, just running the
 * already-chosen RESOURCE cards' ONCE effects, so there's no separate UI for it beyond this).
 *
 * While the player is still drafting their JOB (jobCardId not set yet), this instead falls back to the
 * same read-only preview renderConPreview shows during RESOURCE selection (2026-08-02, per user
 * feedback: "JOB選択のときはまだCONカードと初期資源カードを表示して欲しい") -- their CON card was
 * already dealt at setup (see setup.dealConCards), just not yet flipped to a face, so there's no reason
 * to hide it while they're picking a JOB. Same read-only fallback for an AI-controlled player (2026-08-03)
 * -- their CON face is picked by driveOneAiStep, never by clicks, but there's no reason to hide it from
 * the human while it's still pending (e.g. mid-'delayed'/'manual' pacing). */
function renderConChoice(container, state, player) {
  // Checked first, before the AI/human branch below (2026-08-18 fix, per user report: "2Rの途中でAIが
  // 急にCONの表裏を選ぶ画面になり" -- this player's own real TURN makes isSelf true in *every* round, not
  // just round-1 onboarding, since this function's only caller doesn't distinguish the two; the AI branch
  // used to unconditionally fall through to renderConPreview with no "already chosen" check at all, so an
  // AI player's already-resolved CON choice kept re-showing this "please choose" hint on every one of
  // their turns for the rest of the game. Once a CON face is actually owned, nothing renders here again,
  // for AI and human alike -- matching the human branch's own pre-existing guard, just applied earlier).
  if (player.ownedCardPhysicalIds.some((id) => id.startsWith('CON'))) return;
  if (!player.jobCardId || isAiPlayer(player.id)) { renderConPreview(container, player); return; }
  renderConFacesRow(container, player, (face) => {
    setupMod.chooseConFace(state, INDEX, player.id, face);
    setupMod.receiveInitialResources(state, INDEX, player.id);
    render(STATE);
  });
}

/** Read-only preview of the 2 RESOURCE cards this player already picked (2026-08-02, per user
 * feedback -- see renderConChoice's own comment for the same request applied to CON): shown for the
 * whole rest of round-1 onboarding (JOB draft through CON face choice), not just pre-round-1's
 * renderResourceChoice moment, since the player might still want to see which 2 they kept while
 * choosing their JOB/CON. Disappears once onboarding actually finishes (hasFinishedOnboarding) --
 * RESOURCE cards are deliberately not shown in the ongoing "所持カード" list at all once onboarding is
 * done (confirmed 2026-07-31: no TAP/PASSIVE/TURNEND/VP of their own once their ONCE has run), so this
 * is strictly an onboarding-only convenience, not a change to that later behavior. */
function renderPickedResourcePreview(container, player) {
  container.innerHTML = '';
  const resourceIds = player.ownedCardPhysicalIds.filter((id) => id.startsWith('R'));
  if (resourceIds.length === 0) return;
  for (const physicalId of resourceIds) {
    const cardNode = buildCardVisual(physicalId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
    cell.appendChild(cardNode);
    container.appendChild(cell);
  }
}

/** Pre-round-1 setup's 初期資源カード選択 (2026-07-30, real engine wiring pass -- layout confirmed
 * 2026-07-30, see [[project-dice-wp-ui-requirements]]): per [[project-dice-wp-flow-spec]] steps 5-6,
 * this is NOT part of round-1 onboarding (steps 9-12) -- every player picks 2 of their 4 dealt
 * RESOURCE candidates up front, in any order, before round 1 (and turn order itself) is even
 * determined. The engine itself still lets any pending player resolve in any order (no turnOrder to
 * gate by yet) -- but the CALLER only ever invokes this for state's currentResourceChooserId (2026-08-21,
 * per user report: a shared-screen/hotseat game with 2+ humans used to show every still-pending player's
 * own CON/candidates at once, leaking what's meant to stay private between them), so only one player's
 * picker is ever actually on screen at a time, in state.players' own fixed order. Clicking a 2nd candidate commits
 * immediately via setup.chooseResourceCards, then calls maybeStartRound1 (once every player has
 * committed, that computes start order and starts round 1 for real). `choice.context.selected` is a
 * mock-only scratch field (the real engine's PendingChoice.context has no such field -- see
 * setup.chooseResourceCards, which takes both chosen ids in one call); it only tracks the
 * click-to-toggle highlight before the 2nd pick locks the choice in, and disappears along with the
 * whole pendingChoice entry once chooseResourceCards splices it out. */
function renderResourceChoice(container, state, player) {
  // AI-controlled players' RESOURCE choice is decided by driveOneAiStep, never by clicks (2026-08-03)
  // -- nothing to show here; it resolves on its own, usually before the human even sees a render with
  // it still pending (only 'delayed'/'manual' pacing could show a brief gap).
  if (isAiPlayer(player.id)) return;
  const choice = state.pendingChoices.find((c) => c.playerId === player.id && c.kind === 'SELECT_RESOURCE_CARDS');
  if (!choice) return;
  // Highlight this player's own panel only (2026-07-30, per user feedback) -- container is a
  // freshly-cloned template node per player per render (see renderPlayerCards), so each player's
  // highlight is naturally independent even though several can be mid-choice at once.
  container.classList.add('onboard-panel--active');
  if (!choice.context.selected) choice.context.selected = [];
  const selected = choice.context.selected;
  // requiredCount (2026-08-15, debug-setup feature): normally 2 (4 candidates), but a debug-setup game
  // where P1 preselected exactly 1 RESOURCE card only needs 1 more, from 3 candidates -- see
  // setup.grantOneResourceCardAndDealRest and chooseResourceCards' own context.count doc.
  const requiredCount = choice.context.count || 2;
  for (const faceId of choice.context.candidates) {
    const cardNode = buildCardVisual(faceId, { showEffect: true, allowTextFallback: false, noInteraction: true });
    const isSelected = selected.includes(faceId);
    const tall = cardNode.classList.contains('shop-card--tall');
    const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall owned-card-cell--selectable' : 'owned-card-cell owned-card-cell--selectable');
    if (isSelected) cell.classList.add('owned-card-cell--selected');
    cell.appendChild(cardNode);
    // 2026-08-0X, per user feedback (these cards weren't tappable to enlarge at all): tapping the card
    // now always opens the enlarge modal; toggling this candidate in/out of the 2-picked set happens
    // via the modal's pick button instead of a plain tap on the cell -- see attachPickableEnlarge's own
    // doc. The button is skipped (pickAction: null) once 2 are already picked and this isn't one of
    // them -- nothing to do with a 3rd candidate until one of the first 2 is deselected.
    const canToggle = isSelected || selected.length < requiredCount;
    attachPickableEnlarge(cardNode, faceId, canToggle ? {
      label: isSelected ? '選択を解除する' : '選ぶ',
      onPick: () => {
        if (isSelected) {
          choice.context.selected = selected.filter((id) => id !== faceId);
        } else {
          selected.push(faceId);
          if (selected.length === requiredCount) {
            setupMod.chooseResourceCards(state, player.id, selected);
            maybeStartRound1(state);
          }
        }
        render(STATE);
      },
    } : null);
    container.appendChild(cell);
  }
  // Explanatory hint to the right of the 4 candidates (2026-08-0X, per user request) -- explains both
  // this choice itself and what happens right after it (turn order / JOB draft), since a first-time
  // player lands here with zero context on what a "先着順" number even refers to.
  container.appendChild(buildOnboardHint([
    `← 初期資源カード${choice.context.candidates.length}枚のうちから${requiredCount}枚を選んでください`,
    '先着順の数字の合計が少ないプレイヤーからJOBを選択しゲームが始まります',
  ]));
}

/** Which player's CON preview + RESOURCE candidate picker should actually be visible during round 0
 * (2026-08-21, per user report: with 2+ human players sharing one screen, a player still waiting their
 * turn could already see every other still-choosing player's own CON card and candidates, which are
 * meant to be private -- "２人目以降が初期資源を選ぼうとするとほかのプレイヤーのCONや初期資源が見えて
 * しまいます"). Round 0 has no turnOrder yet (computeStartOrder itself depends on the RESOURCE choices
 * still being made), so this just walks state.players in their fixed creation order (P1,P2,P3,P4) and
 * returns the first one who still has a pending SELECT_RESOURCE_CARDS choice -- everyone before them
 * has already finished (and, per the existing renderConPreview/renderResourceChoice gating, is already
 * invisible here too, confirmed with the user), and everyone after them simply isn't rendered at all
 * until it's their turn. AI players are never skipped specially -- they resolve near-instantly via the
 * AI pump regardless of pacing mode, so their slot in this order clears on its own with nothing for a
 * human to see. Returns null once nobody has a pending choice left (nothing to show either way). */
function currentResourceChooserId(state) {
  const player = state.players.find((p) => state.pendingChoices.some((c) => c.playerId === p.id && c.kind === 'SELECT_RESOURCE_CARDS'));
  return player ? player.id : null;
}

/** Once every player has committed their 2 RESOURCE cards (no SELECT_RESOURCE_CARDS pendingChoice
 * left), computes start order and starts round 1 for real (setup.js steps 7-8, per
 * [[project-dice-wp-flow-spec]]) -- see renderResourceChoice above, the only caller. No-op if round 1
 * has already started (state.round>0) or someone still hasn't chosen. */
function maybeStartRound1(state) {
  if (state.round > 0) return;
  if (state.pendingChoices.some((c) => c.kind === 'SELECT_RESOURCE_CARDS')) return;
  setupMod.computeStartOrder(state, INDEX);
  turnFlowMod.startRound(state);
}

function renderPlayerCards(state, next) {
  const activePlayerId = next ? next.playerId : null;
  const container = document.getElementById('player-cards-groups');
  container.innerHTML = '';
  // Computed once per render, outside the loop (2026-08-21, see currentResourceChooserId's own doc) --
  // only meaningful while state.round === 0, but cheap to compute either way.
  const activeResourceChooserId = currentResourceChooserId(state);
  for (const player of turnOrderedPlayers(state, activePlayerId)) {
    const isSelf = player.id === activePlayerId;
    // Bare (direct) TAP abilities are usable "any time during your own turn", same gate as
    // renderFreeActionButtons' canAct -- see attachTapToggle. !isAiPlayer (2026-08-03): an AI player's
    // bare TAP usage is decided by driveOneAiStep (as a BARE_TAP Move), never by clicks. Pending
    // UNTAP_CHOICE (2026-08-20, same fix/reasoning as actingHumanPlayerId's own doc) blocks this too --
    // "other operations" includes bare TAP, not just dice placement.
    const canUseTap = isSelf && hasFinishedOnboarding(player) && !isAiPlayer(player.id)
      && !state.pendingChoices.some((c) => c.playerId === player.id && c.kind === 'UNTAP_CHOICE');
    const tpl = document.getElementById('tpl-card-group');
    const node = tpl.content.firstElementChild.cloneNode(true);
    // Whole-group highlight only for the player's real TURN (dice placement), not during JOB/CON
    // selection (confirmed 2026-07-30, per user feedback) -- the more specific job-pool/CON-row
    // highlight (.onboard-panel--active) already covers those moments on its own.
    if (isSelf && hasFinishedOnboarding(player)) node.classList.add('card-group--active');
    node.querySelector('.card-group__swatch').dataset.color = player.color;
    node.querySelector('.card-group__name').textContent = player.name;
    // Confirmed 2026-07-30: the header's separate "手番 {name}" chip was removed -- this group is
    // always sorted turn-order-first (turnOrderedPlayers), so "手番" here on the top player's own
    // name row says the same thing in place.
    node.querySelector('.card-group__turn').textContent = isSelf ? '手番' : '';
    const buildStats = computePlayerBuildStats(player, state);
    renderPlayerStats(node.querySelector('.card-group__stats'), buildStats, computeQstExtraStats(state, player));

    // JOB and CON are always exactly 1 each (confirmed 2026-07-29) -- shown as their own fixed
    // side-by-side pair, separate from the variable-length list of built/kept cards below.
    // CON is always shown before JOB (confirmed 2026-07-29: CON is dealt at setup, JOB is drafted
    // later) -- ordered explicitly here rather than relying on ownedCardPhysicalIds' order.
    const jobConEl = node.querySelector('.card-group__jobcon');
    const listEl = node.querySelector('.card-group__list');
    const conId = player.ownedCardPhysicalIds.find((id) => id.startsWith('CON'));
    const jobId = player.ownedCardPhysicalIds.find((id) => id.startsWith('JOB'));
    for (const physicalId of [conId, jobId]) {
      if (!physicalId) continue;
      const cardState = state.cards[physicalId];
      if (!cardState) continue;
      // 傲慢/CON004A's own card-note ("最多AREA✖/LVアップ✖", 2026-08-18, per user request) is suppressed
      // here -- on this player's own OWNED-card view only, not the CON pool/preview/choice screens where
      // it isn't owned yet -- while there's nothing it could actually be warning about: either the
      // player has no upgrade-eligible card at all yet (e.g. right at game start), or they're already
      // rank 1 in Q004A so the block wouldn't apply anyway. Both conditions must hold to show it (see
      // board.hasAnyUpgradeEligibleCard's own doc for why getBuildCandidates alone can't tell these
      // apart from being blocked).
      const suppressConNote = physicalId === conId
        && dataLoaderMod.getCardRow(INDEX, cardState.currentFaceId).NAME === '傲慢'
        && !(boardMod.isUpgradeBlockedByQstRank(state, INDEX, player.id) && boardMod.hasAnyUpgradeEligibleCard(state, INDEX, player.id));
      // showEffect+allowTextFallback:false (confirmed 2026-07-30): JOB/CON now show effect icons
      // like A/B/C, but unmapped DSL stays blank instead of raw text (see buildEffectRow). Cell size
      // reacts to whether the card actually ended up tall (i.e. has anything to show), rather than
      // being fixed non-tall like before.
      const cardNode = buildCardVisual(cardState.currentFaceId, {
        tapped: cardState.tapped, showEffect: true, allowTextFallback: false, suppressConNote,
      });
      const cell = el('div', cardNode.classList.contains('shop-card--tall') ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
      // 変化ハイライト (2026-08-16) -- this JOB/CON was drafted since the viewing human's last turn ended.
      if (changeHighlightDiff && changeHighlightDiff.cardKeys.has(`${player.id}|${physicalId}`)) cell.classList.add('change-highlight');
      attachTapToggle(cardNode, cardState, cardState.currentFaceId, canUseTap, physicalId);
      cell.appendChild(cardNode);
      jobConEl.appendChild(cell);
    }
    // Round-1 onboarding panels (2026-07-30, real engine wiring pass): CON is gated to whichever one
    // player turn-flow.getNextTurn currently reports (isSelf); JOB is its own persistent shared panel
    // now (see renderJobPool, called once from render() rather than per player-group); RESOURCE choice
    // is gated only by "still pending" since it happens pre-round-1 for everyone at once -- see each
    // function's own comment above for why.
    if (isSelf) {
      renderConChoice(node.querySelector('.card-group__onboard-con'), state, player);
    }
    if (state.round === 0 && player.id === activeResourceChooserId) {
      // CON preview (2026-07-30, per user feedback) + the RESOURCE candidate picker itself -- both
      // scoped to just the one player currently up (2026-08-21, per user report: other still-waiting
      // players' own CON/candidates used to be visible here too, at the same time, which are meant to
      // stay private in a shared-screen/hotseat setting -- see currentResourceChooserId's own doc).
      // Whoever already finished stays invisible too, same as before (renderResourceChoice's own "no
      // pending choice, nothing to show" return covers that automatically).
      renderConPreview(node.querySelector('.card-group__onboard-con'), player);
      renderResourceChoice(node.querySelector('.card-group__onboard-resources'), state, player);
    } else if (isSelf && !hasFinishedOnboarding(player)) {
      // Round 1's JOB draft / CON face choice (2026-08-02, per user feedback): keep showing the 2
      // already-picked RESOURCE cards read-only, same container renderResourceChoice used pre-round-1
      // -- see renderPickedResourcePreview's own comment.
      renderPickedResourcePreview(node.querySelector('.card-group__onboard-resources'), player);
    }
    for (const physicalId of player.ownedCardPhysicalIds) {
      // JOB/CON get their own dedicated slot above. RESOURCE cards (2026-07-31, per user feedback)
      // are never shown here at all once picked -- their only effect is the ONCE that already ran at
      // receiveInitialResources (no TAP/PASSIVE/TURNEND/VP of their own, confirmed in the data), so
      // there's nothing left to look at or interact with; they stay in ownedCardPhysicalIds/state.cards
      // internally (e.g. computeStartOrder already used them at setup) but are simply not rendered.
      if (physicalId.startsWith('JOB') || physicalId.startsWith('CON') || physicalId.startsWith('R')) continue;
      const cardState = state.cards[physicalId];
      if (!cardState) continue;
      const tall = isNormalDeckCard(physicalId); // A/B/C decks: taller, with effect text (confirmed)
      const cell = el('div', tall ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
      // 変化ハイライト (2026-08-16) -- this card was built/acquired since the viewing human's last turn ended.
      if (changeHighlightDiff && changeHighlightDiff.cardKeys.has(`${player.id}|${physicalId}`)) cell.classList.add('change-highlight');
      const cardNode = buildCardVisual(cardState.currentFaceId, { tapped: cardState.tapped, showEffect: tall });
      attachTapToggle(cardNode, cardState, cardState.currentFaceId, canUseTap, physicalId);
      cell.appendChild(cardNode);
      listEl.appendChild(cell);
    }

    container.appendChild(node);
  }
}

/** GAME_END screen (2026-07-31): state.phase becomes 'GAME_END' inside turn-flow's endRound once
 * round 4 ends (see advanceTurnIfPossible) -- board.js/executor.js keep working normally after that
 * (nothing gates on phase elsewhere), so this is purely an overlay on top of the final board state,
 * not a hard stop. scoring.rankPlayers does the actual VP tally (card VP + resources.VP +
 * VP_MODIFIER); this only renders it, winner-first, with the top row highlighted. */
function renderGameEndOverlay(state) {
  const overlay = document.getElementById('game-end-overlay');
  if (state.phase !== 'GAME_END') {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const list = document.getElementById('game-end-list');
  list.innerHTML = '';
  scoringMod.rankPlayers(state, INDEX).forEach((entry, i) => {
    const player = state.players.find((p) => p.id === entry.playerId);
    const row = el('div', i === 0 ? 'game-end-row game-end-row--winner' : 'game-end-row');
    row.appendChild(el('span', 'game-end-rank', `${i + 1}位`));
    const swatch = el('span', 'player-panel__swatch');
    swatch.dataset.color = player.color;
    row.appendChild(swatch);
    row.appendChild(el('span', 'game-end-name', player.name));
    row.appendChild(el('span', 'game-end-score', `${entry.score} VP`));
    list.appendChild(row);
  });
  document.getElementById('game-end-replay-button').disabled = replayHistory.length === 0;
}

// Human seats already registered into the ranking THIS game (2026-08-16) -- a fresh page load (the
// only way this app ever starts a new game, see autoScrollToBottomOnStart's own doc) gives a fresh
// empty Set automatically, so this never needs an explicit reset.
const registeredRankingPlayerIds = new Set();

const ROLE_LABELS = new Map(PLAYER_ROLE_OPTIONS);

/** @returns {string} a card face's own NAME column, falling back to the raw id if it has none (mirrors
 * the `row.NAME && row.NAME !== row.ID ? row.NAME : ''` fallback pattern used elsewhere, e.g. line ~1058). */
function rankingCardDisplayName(faceId) {
  if (!faceId) return '—';
  const row = dataLoaderMod.getCardRow(INDEX, faceId);
  return row.NAME && row.NAME !== faceId ? row.NAME : faceId;
}

/** Every HUMAN seat's ranking-eligible result at GAME_END (2026-08-16, per user: "人間対AIで歴代の得点を
 * 最高得点順に並べる" -- AI seats never appear here). Reuses scoringMod.rankPlayers/state.qstRewardsGranted
 * the exact same way standingsRows already does (see its own doc, ~line 2497) so 素点/QST得点 here can
 * never drift from what the live standings/GAME_END screen itself shows. */
function rankingCandidatesForGameEnd(state) {
  if (state.phase !== 'GAME_END') return [];
  const granted = state.qstRewardsGranted || {};
  return scoringMod.rankPlayers(state, INDEX)
    .filter((entry) => !isAiPlayer(entry.playerId))
    .map((entry) => {
      const player = state.players.find((p) => p.id === entry.playerId);
      const qstScore = granted[entry.playerId] || 0;
      return {
        playerId: entry.playerId,
        defaultName: player.name,
        playerColor: player.color,
        totalScore: entry.score,
        qstScore,
        rawScore: entry.score - qstScore,
        conFaceId: player.conPhysicalId && player.conFace ? `${player.conPhysicalId}${player.conFace}` : null,
        jobCardId: player.jobCardId || null,
        opponents: state.players.filter((p) => p.id !== entry.playerId)
          .map((p) => ROLE_LABELS.get(playerRoles.get(p.id)) || playerRoles.get(p.id)),
      };
    });
}

/** Name-entry + register row for each HUMAN seat not yet saved into the ranking this game (2026-08-16,
 * per user: name is "ランキングをとったプレイヤーが入力" -- typed by the player themselves, not
 * auto-filled). This is the app's first real `<input>` element (see index.html's own comment on
 * #ranking-overlay) -- everywhere else in the UI is click-only. */
function renderRankingRegisterList(state) {
  const container = document.getElementById('ranking-register-list');
  container.innerHTML = '';
  for (const c of rankingCandidatesForGameEnd(state)) {
    if (registeredRankingPlayerIds.has(c.playerId)) continue;
    const row = el('div', 'ranking-register-row');
    const swatch = el('span', 'player-panel__swatch');
    swatch.dataset.color = c.playerColor;
    row.appendChild(swatch);
    row.appendChild(el('span', 'ranking-register-row__score', `総合 ${c.totalScore}VP（素点${c.rawScore} + QST${c.qstScore}）`));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ranking-name-input';
    input.placeholder = c.defaultName;
    input.maxLength = 20;
    row.appendChild(input);
    const registerButton = el('button', 'undo-button', '登録');
    registerButton.type = 'button';
    registerButton.addEventListener('click', () => {
      registerButton.disabled = true;
      const name = input.value.trim() || c.defaultName;
      RankingStorage.save({
        name,
        rawScore: c.rawScore,
        qstScore: c.qstScore,
        totalScore: c.totalScore,
        conFaceId: c.conFaceId,
        jobCardId: c.jobCardId,
        opponents: c.opponents,
        playerColor: c.playerColor,
      }, replayHistory).then(() => {
        registeredRankingPlayerIds.add(c.playerId);
        renderRankingOverlay(STATE);
      });
    });
    row.appendChild(registerButton);
    container.appendChild(row);
  }
}

/** All-time top-20 list (2026-08-16) -- see ranking.js's RankingStorage.list (already sorted
 * totalScore descending, capped at 20 by save()). */
function renderRankingList() {
  const list = document.getElementById('ranking-list');
  list.innerHTML = '';
  const entries = RankingStorage.list();
  if (entries.length === 0) {
    list.appendChild(el('div', 'ranking-empty', 'まだ登録がありません'));
    return;
  }
  entries.forEach((entry, i) => {
    const row = el('div', i === 0 ? 'ranking-row ranking-row--top' : 'ranking-row');
    row.appendChild(el('span', 'ranking-row__rank', `${i + 1}位`));
    const swatch = el('span', 'player-panel__swatch');
    swatch.dataset.color = entry.playerColor;
    row.appendChild(swatch);
    row.appendChild(el('span', 'ranking-row__name', entry.name));
    row.appendChild(el('span', 'ranking-row__score', `総合 ${entry.totalScore}VP（素点${entry.rawScore} + QST${entry.qstScore}）`));
    row.appendChild(el('span', 'ranking-row__con', `CON: ${rankingCardDisplayName(entry.conFaceId)}`));
    row.appendChild(el('span', 'ranking-row__job', `JOB: ${rankingCardDisplayName(entry.jobCardId)}`));
    row.appendChild(el('span', 'ranking-row__opponents', entry.opponents.join('　')));
    const replayButton = el('button', 'undo-button', entry.hasReplay ? '▶ 再生' : '再生不可');
    replayButton.type = 'button';
    replayButton.disabled = !entry.hasReplay;
    replayButton.addEventListener('click', () => {
      replayButton.disabled = true;
      RankingStorage.loadReplay(entry.id).then((history) => {
        if (history && history.length) enterReplayMode(history);
        else replayButton.disabled = false;
      });
    });
    row.appendChild(replayButton);
    list.appendChild(row);
  });
}

function renderRankingOverlay(state) {
  renderRankingRegisterList(state);
  renderRankingList();
}

function openRankingOverlay() {
  document.getElementById('ranking-overlay').hidden = false;
  renderRankingOverlay(STATE);
}

function closeRankingOverlay() {
  document.getElementById('ranking-overlay').hidden = true;
}

/** ランキングリセット (2026-08-16, per user request: "データが一新されたのでランキングを一度リセット
 * してください" -- old ranking entries were saved before this session's various physical-id/card
 * changes, e.g. the CON sheet reorg, so their card ids no longer mean the same thing under the current
 * data.json; loadReplay-ing one of those shows garbled/wrong card info -- see renderReplayFrame's own
 * try/catch for the defensive side of the same root cause). Irreversible on this device (no server
 * backup), hence the confirm().
 *
 * Password gate added 2026-08-18 (per user request: "誰でも出来てしまうと困るので") -- this is a plain
 * client-side check, not real security -- it only stops a casual/accidental tap by someone else using
 * the same device, not a determined attacker. Matches what was actually asked for; a real access-control
 * layer isn't feasible for a build-step-free, server-free static page anyway.
 *
 * Password hashed, not stored in plaintext (2026-08-25, per user request: "ランキング用のパスワード暗号
 * 化できますか"): only RANKING_RESET_PASSWORD_HASH (its SHA-256, via the browser's built-in
 * crypto.subtle -- no new dependency, and confirmed working under file:// too, not just https) lives in
 * this file's source, so a casual glance at it no longer reveals the actual password. Doesn't raise the
 * bar against anyone willing to open devtools -- they can still brute-force a weak password from its hash
 * offline, or just skip this whole function and call RankingStorage.clearAll() directly -- same
 * "casual-tap prevention only" threat model as before, just closing the "read it straight off the
 * source" gap specifically. */
const RANKING_RESET_PASSWORD_HASH = 'f0f17d1b4817e88655064873f54b6d46d4bc071fcd2c6ee1cd04d7586852a2b5';
async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function handleRankingResetClick() {
  const entered = window.prompt('ランキングをリセットするにはパスワードを入力してください。');
  if (entered === null) return; // canceled
  if ((await sha256Hex(entered)) !== RANKING_RESET_PASSWORD_HASH) {
    window.alert('パスワードが違います。');
    return;
  }
  if (!window.confirm('歴代ランキングと保存されているリプレイをすべて削除します。よろしいですか？')) return;
  RankingStorage.clearAll().then(() => renderRankingList());
}

function render(state) {
  // Replay mode takes over the whole screen with its own render path -- see this file's "Move-by-move
  // game replay" section for why that's a separate function rather than a branch further down (render()
  // itself is full of live-play-only side effects -- AI pumping, checkpoint recording, turn bookkeeping
  // -- none of which make sense, or are even safe, against a frozen historical snapshot).
  if (replayMode) { renderReplayFrame(); return; }
  document.getElementById('app').classList.remove('replay-locked');
  // 変化ハイライトのクリア (2026-08-16, see changeHighlightDiff's own doc): nothing in this app ever
  // calls render() on its own (no polling/interval) -- every call is caused by a human doing something,
  // or by the AI pump's own timer. changeHighlightPainted marks "this diff has already been shown once";
  // if that's still true when render() runs again, something happened since, so it's time to clear it.
  if (changeHighlightDiff && changeHighlightPainted) changeHighlightDiff = null;
  changeHighlightPainted = false;
  // Records this render's starting state as one replay entry before anything else runs (2026-08-1X) --
  // see recordReplaySnapshotIfChanged's own doc. Every human action handler mutates STATE then calls
  // render(STATE), so by the time control reaches here `state` already reflects that one move; the
  // dedup against the previous entry is what keeps a pure UI-only re-render (nothing in STATE actually
  // changed) from adding a spurious one. Must run BEFORE pumpAiInstant below, or a human's own move would
  // never get its own entry -- it'd only show up bundled together with whatever AI moves follow it.
  recordReplaySnapshotIfChanged(state);

  // Plays out every AI-controlled player's backlog before painting anything (2026-08-03) -- 'instant'
  // resolves it all synchronously right here so the rest of render() sees the post-AI state already;
  // 'delayed' just arms a timer (see pumpAiDelayed's own doc) and lets this render paint the
  // pre-that-step state, same as any other render call. 'manual' does nothing here at all -- see the
  // "次のAI行動へ" button. Must run before `next` is computed below, since AI turns change whose turn
  // it is.
  if (aiPacingMode === 'instant') pumpAiInstant(state);
  else if (aiPacingMode === 'delayed') pumpAiDelayed();

  // turn-flow.getNextTurn needs a real turnOrder, which only exists once maybeStartRound1 has run
  // (round>0) -- before that, nobody is "the active player" yet (see renderResourceChoice/
  // turnOrderedPlayers/renderPlayers, which all treat next===null as "no one highlighted").
  let next = state.round >= 1 ? turnFlowMod.getNextTurn(state) : null;
  // Keep the still-mid-turn player as "next" even once they run out of dice to place (2026-08-06, per
  // user report: "ラウンド最後のダイスを置くと即次のプレイヤーのターンになりTAPアクションを使うタイミ
  // ングがありません"; broadened 2026-08-09, per follow-up report: "ラウンド最後のダイスを置くと　その
  // 瞬間強制的にラウンド終了してしまいます" + "AIがダイスを使い切ると人間がターンエンドできなくなりま
  // す"). getNextTurn's own skip-ahead ("does this player have any unplaced die left?") is exactly
  // right for finding who a *just-ended* turn should pass to -- but it has no way to tell that apart
  // from "the player who's STILL mid-turn just placed their own final die and hasn't clicked ターン終了
  // yet" (both look identical from raw state alone: isRoundOver()/getNextTurn() only look at whether
  // every die is placed-or-passed, never at whether anyone has actually clicked/decided to end their
  // turn). turnActionTaken tracks exactly "lastTurnPlayerId's placement this turn is done, awaiting an
  // explicit end" -- since it's ONLY ever set true while it's genuinely lastTurnPlayerId's own open turn
  // (reset to false the instant any *different* player's turn starts, see the transition block below),
  // turnActionTaken===true is already sufficient on its own to know lastTurnPlayerId is still open;
  // pendingBuildChoice.playerId is equally self-sufficient (only the player who legitimately just placed
  // a die -- the modal is what's currently blocking everyone else -- can have one open at all).
  //
  // 2026-08-09 fix: this used to ALSO require state.turnOrder[state.currentPlayerIndex] to match before
  // trusting either of those -- but currentPlayerIndex is only a rotating "next slot to check" cursor
  // (turnFlow.endTurn advances it by exactly one slot, to whoever ended their turn's immediate
  // successor), NOT "whoever is currently mid-turn": once players' per-round die counts diverge (e.g. one
  // player picked up an extra wD mid-round -- common), the *last* player to act in a round is routinely
  // found via getNextTurn's skip-ahead from a currentPlayerIndex that's still sitting on someone else
  // entirely who'd already used up their own dice earlier. In that case the old currentPlayerIndex check
  // wrongly failed to match, so the override never fired, next stayed ROUND_OVER, and the transition
  // block below (its `else` branch) wiped lastTurnPlayerId to null outright -- destroying the very
  // tracking this override exists to use, and reproducing both symptoms above (round force-ends, and/or
  // the real mid-turn player's ターン終了 button never reappears since lastTurnPlayerId no longer points
  // at them). Dropping the currentPlayerIndex cross-check entirely removes that failure mode.
  //
  // 2026-08-10: the logic itself moved to openTurnPlayerId (see its own doc) so hasAiWorkPending/
  // driveOneAiStep can consult the exact same answer -- those two used to ask raw getNextTurn directly
  // and therefore drove an AI turn straight over the top of a still-open human one, which this display-
  // only correction could never prevent on its own.
  const stillMidTurnPlayerId = openTurnPlayerId();
  if (stillMidTurnPlayerId && (!next || next.playerId !== stillMidTurnPlayerId)) {
    next = { type: 'TURN', playerId: stillMidTurnPlayerId, playerIndex: state.turnOrder.indexOf(stillMidTurnPlayerId) };
  }
  // Auto-records an undo checkpoint at the start of each player's TURN (2026-07-30, per user
  // feedback: development/tuning phase, so undo should always get back to "start of this turn"
  // regardless of whether anything rolled a die -- see handleUndoClick, which re-arms this same
  // checkpoint after every use so it stays available for the whole turn, not just once). Gated on
  // hasFinishedOnboarding, not just next.type==='TURN' -- getNextTurn already reports 'TURN' as soon
  // as JOB is drafted, before CON is chosen (same quirk documented on hasFinishedOnboarding/
  // canPlaceDiceFor), so checking next.type alone would checkpoint too early (before CON's ONCE/
  // receiveInitialResources have run) and undo would strand the player mid-onboarding. Guarded by
  // lastTurnPlayerId so this only fires once per turn, not on every re-render while mid-turn -- OR by
  // turnJustEnded (2026-08-11, per user report -- see its own doc), which catches the case
  // lastTurnPlayerId can't: the same player taking several turns in a row with nobody else's turn in
  // between (once every other player is out of dice for the round), where next.playerId never actually
  // changes across those later turns.
  const activePlayer = next ? state.players.find((p) => p.id === next.playerId) : null;
  if (activePlayer && hasFinishedOnboarding(activePlayer)) {
    noteActiveTurnPlayerForJobPool(state, next.playerId, turnJustEnded);
    if (next.playerId !== lastTurnPlayerId || turnJustEnded) {
      undoMod.recordCheckpoint(state);
      // 変化ハイライトの計算 (2026-08-16): 人間のターンが始まる、まさにこの瞬間だけ、直前の人間ターン
      // 終了時に取ったbaseline(changeHighlightBaseline)と今のstateを比較する。AIのターンが始まる瞬間は
      // ここを素通りする(baselineは消費されず残ったまま)ので、複数のAIが連続で動いても、次に人間の番が
      // 来たときに全部まとめて光る。
      if (!isAiPlayer(next.playerId) && changeHighlightBaseline) {
        changeHighlightDiff = computeChangeDiff(changeHighlightBaseline, state);
        changeHighlightPainted = true;
        changeHighlightBaseline = null;
      }
      lastTurnPlayerId = next.playerId;
      turnActionTaken = false; // a fresh turn started -- see turnActionTaken's own comment
      turnJustEnded = false;
      dicePlacementCheckpoint = null; // a new turn started -- any prior placement is out of scope now
    }
  } else {
    lastTurnPlayerId = null;
  }
  renderShops(state);
  renderBoard(state, next);
  renderPlayers(state, next);
  renderJobPool(state, next);
  renderJobReplacementChoice(state);
  renderPlayerCards(state, next);
  // Drains GameState.whiteOverflowEvents into whatever placementMessage this render's own action
  // already produced (2026-08-11, per user request) -- appended, not replacing, so a placement that
  // both fails/succeeds AND happens to overflow a white die (e.g. a CHANGE granting several wD at once,
  // one of which overflows) still shows both. Reuses placementMessage's own display slot/lifecycle
  // rather than a separate one: it already persists across unrelated re-renders (nothing here clears it
  // early) and naturally gets replaced the next time any action sets a new message -- exactly the
  // "shown until something else happens" behaviour this warning wants, for free.
  if (state.whiteOverflowEvents.length > 0) {
    placementMessage = placementMessage ? `${placementMessage}　${WHITE_OVERFLOW_WARNING_TEXT}` : WHITE_OVERFLOW_WARNING_TEXT;
    state.whiteOverflowEvents = [];
  }
  document.getElementById('board-message').textContent = placementMessage;
  renderBuildChoiceModal();
  renderPlacementChoiceModal();
  renderTapChoiceModal();
  renderAutoModeChoiceModal();
  renderTurnEndWarningModal();
  renderUndoButtons(state);
  renderRoundPassButton(state, next);
  renderRoundPassConfirmModal();
  renderWhiteOverflowConfirmModal();
  renderJob007TapPromptModal();
  renderPlayerRoleControl(state);
  renderAiPacingControl(state);
  renderGameEndOverlay(state);
  renderDebugPanel(state);
  renderDebugSetupOverlay();
  renderCardListOverlay();
  // Hides #replay-controls again once back on the normal live path (found via headless testing,
  // 2026-08-1X: renderReplayControls is otherwise only ever called from renderReplayFrame, so exiting
  // replay via exitReplayMode -- which just flips replayMode off and calls this render(state) -- left
  // the control bar's `hidden` attribute exactly as replay last set it, showing it stacked right on top
  // of the game-end overlay it's supposed to have been replaced by).
  renderReplayControls();
}

/** Reverts to the start of the current player's turn (2026-07-30, per user feedback -- see the
 * checkpoint-recording comment in render() above). Clears the UI-only scratch state undo() itself
 * doesn't know about (selectedDieIds/pendingBuildChoice/placementMessage aren't part of GameState), then
 * immediately re-records a fresh checkpoint from the just-restored state so the button stays usable
 * for the rest of the turn instead of being a true one-shot (undo.js's own single-snapshot design
 * would otherwise clear undoCheckpoint after one use -- see src/undo.js's undo()). */
function handleUndoClick() {
  const result = undoMod.undo(STATE);
  if (!result.success) return;
  selectedDieIds = [];
  pendingBuildChoice = null;
  pendingPlacementChoice = null;
  pendingTapChoice = null;
  pendingAutoModeChoice = null;
  pendingTurnEndPlayerId = null;
  pendingTurnEndWarning = null;
  pendingRoundPassConfirm = null;
  pendingWhiteOverflowConfirm = null;
  pendingJob007TapPrompt = null;
  turnActionTaken = false;
  placementMessage = '';
  dicePlacementCheckpoint = null; // stale now -- this already reverted past whatever it pointed at
  undoMod.recordCheckpoint(STATE);
  render(STATE);
}

/** Undoes just the most recent die placement (2026-08-10, per user request -- see
 * dicePlacementCheckpoint's own doc for why this is scoped narrower than handleUndoClick). No-op if
 * nothing is armed (button is disabled in that case anyway, but guard here too since both buttons share
 * this handler). Clears the same UI-only scratch state handleUndoClick does, restores turnActionTaken
 * from the snapshot pair rather than always forcing it to false (placing this die is what set it true;
 * canceling that placement puts it back to whatever it was right before), and does NOT re-record
 * undoMod's own turn-start checkpoint -- that one still points further back (start of turn), which
 * remains exactly correct after this narrower rollback. Single-shot: the checkpoint is consumed here,
 * not re-armed, until the player places a die again. */
function handleDiceCancelClick() {
  if (!dicePlacementCheckpoint) return;
  undoMod.restoreSnapshot(STATE, dicePlacementCheckpoint.state);
  turnActionTaken = dicePlacementCheckpoint.turnActionTaken;
  dicePlacementCheckpoint = null;
  selectedDieIds = [];
  pendingBuildChoice = null;
  pendingPlacementChoice = null;
  pendingTapChoice = null;
  pendingAutoModeChoice = null;
  placementMessage = '';
  render(STATE);
}

/** Enables/disables both undo buttons (the persistent one in the sidebar header, and the duplicate
 * inside #build-choice-overlay so it's reachable even while that modal covers the screen -- confirmed
 * 2026-07-30, per user feedback: "城にダイスをおいて建築を選ぶ画面でも戻れるように") based on whether
 * there's actually a checkpoint to revert to. Also drives the dice-cancel buttons' own enabled state the
 * same way, off dicePlacementCheckpoint instead of state.undoCheckpoint (2026-08-10). */
function renderUndoButtons(state) {
  const disabled = !state.undoCheckpoint;
  for (const id of ['undo-button', 'undo-button-build']) {
    document.getElementById(id).disabled = disabled;
  }
  const diceCancelDisabled = !dicePlacementCheckpoint;
  for (const id of ['dice-cancel-button', 'dice-cancel-button-build']) {
    document.getElementById(id).disabled = diceCancelDisabled;
  }
}

/** "ラウンドパス" header button (2026-08-02, per user feedback: pinned above player-role-control,
 * always in the DOM -- see index.html's own comment). Enabled only for the player whose TURN it
 * actually is right now (same actingHumanPlayerId gate as die selection/free actions) AND who still
 * has at least one die left to place-or-pass this round -- nothing to do otherwise. Stashes playerId
 * on the button itself (dataset) rather than a module-level variable, since nothing else needs it
 * between render() calls the way e.g. pendingBuildChoice does. */
function renderRoundPassButton(state, next) {
  const btn = document.getElementById('round-pass-button');
  const playerId = actingHumanPlayerId(state, next);
  const player = playerId ? state.players.find((p) => p.id === playerId) : null;
  const hasDiceLeftThisRound = !!player && player.dice.some((d) => d.placedMapId === null && !d.passed);
  btn.disabled = !hasDiceLeftThisRound;
  btn.dataset.playerId = hasDiceLeftThisRound ? playerId : '';
}

function handleRoundPassClick() {
  const playerId = document.getElementById('round-pass-button').dataset.playerId;
  if (!playerId) return; // disabled button shouldn't fire, but guard anyway
  pendingRoundPassConfirm = { playerId };
  render(STATE);
}

function renderRoundPassConfirmModal() {
  document.getElementById('round-pass-confirm-overlay').hidden = !pendingRoundPassConfirm;
}

/** Passes every remaining unplaced-and-unpassed die this player is holding in one shot (2026-08-02,
 * per user feedback: repeatedly selecting-then-passing each die individually was tedious with several
 * dice left; the individual per-die "このダイスをパス" button this once mirrored was removed 2026-08-16,
 * per user request, now that this round-pass covers the same need) -- loops board.passDie once per
 * die, then runs the same WARNING-gated attemptAdvanceTurn end-of-turn flow a manual "ターン終了" would.
 * Safe to run that
 * end-of-turn check just once for the whole batch rather than once per die: passing a die changes no
 * player resource, so RESOURCE_LIMIT/FORCE_CONVERT's own trigger conditions can't differ between the
 * dice in the loop. Once every die is marked passed, turn-flow.getNextTurn's own "skip players with
 * nothing left to place or pass" rule (see isRoundOver/getNextTurn) keeps this player out of the rest
 * of the round without any extra bookkeeping here. */
function handleRoundPassConfirmed(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  for (const die of player.dice.filter((d) => d.placedMapId === null && !d.passed)) {
    boardMod.passDie(state, INDEX, { playerId }, die.id);
  }
  selectedDieIds = [];
  placementMessage = '';
  turnActionTaken = true;
  attemptAdvanceTurn(state, playerId);
}

/** 人間/AI LV1/AI LV2/AI LV3切り替え (2026-08-03, per user feedback: "4人のプレイヤー人間 AIをそれぞれ
 * 選べるようにしてほしい", then "先程のAIをLV1 新しく作ったAIをLV2として...選べるようにしてください",
 * then 2026-08-09 "AI LV３を作りたい") -- one 4-state toggle per player seat (色スウォッチ+名前+人間/AI
 * LV1/AI LV2/AI LV3ボタン), reusing
 * turnOrderedPlayers' own iteration order isn't needed here since this doesn't depend on whose turn it
 * is -- always shows all 4 players in state.players' fixed creation order. Toggling calls render(STATE)
 * immediately; since isAiPlayer/aiPlayerFor are consulted fresh on every render (nothing caches "is
 * this player AI, and which level" beyond the playerRoles Map itself), a mid-game switch just changes
 * who/which AIPlayer the very next render()'s AI pump uses -- no special transition handling needed. */
function renderPlayerRoleControl(state) {
  const container = document.getElementById('player-role-control');
  container.innerHTML = '';
  for (const player of state.players) {
    const row = el('div', 'player-role-control__row');

    const nameLine = el('div', 'player-role-control__name-line');
    const swatch = el('span', 'player-role-control__swatch');
    swatch.dataset.color = player.color;
    nameLine.appendChild(swatch);
    nameLine.appendChild(el('span', 'player-role-control__name', player.name));
    row.appendChild(nameLine);

    const optionsLine = el('div', 'player-role-control__options-line');
    const currentRole = playerRoles.get(player.id);
    for (const [role, label] of PLAYER_ROLE_OPTIONS) {
      const btn = el('button', 'player-role-control__option', label);
      btn.type = 'button';
      btn.classList.toggle('player-role-control__option--active', currentRole === role);
      btn.addEventListener('click', () => {
        // 2026-08-21, per user request: switching a player from AI to HUMAN mid-resource-selection
        // (round 0) undoes whatever the AI already auto-picked for them (setup.redealResourceCandidates
        // is itself a no-op once round 1 has actually started) -- otherwise the human silently inherits
        // the AI's already-made pick with no real choice at all, since resource-choice resolution can
        // fire within seconds of page load under this player's *default* AI role, well before anyone
        // gets a chance to click these buttons.
        const previousRole = playerRoles.get(player.id);
        playerRoles.set(player.id, role);
        if (role === 'HUMAN' && previousRole !== 'HUMAN') setupMod.redealResourceCandidates(STATE, INDEX, player.id);
        render(STATE);
      });
      optionsLine.appendChild(btn);
    }
    row.appendChild(optionsLine);

    container.appendChild(row);
  }
}

/** AI進行モードのセレクトと「次のAI行動へ」ボタン (2026-08-03, per user feedback: "上記3をえらべる
 * ように"). The button only appears in 'manual' mode, and only while hasAiWorkPending -- clicking it
 * runs exactly one driveOneAiStep. Switching away from 'delayed' mid-flight cancels any in-flight timer
 * (see pumpAiDelayed) so a stray callback never keeps pumping under the old mode's semantics. */
function renderAiPacingControl(state) {
  document.getElementById('ai-pacing-select').value = aiPacingMode;
  const manualBtn = document.getElementById('ai-manual-step-button');
  const showManualBtn = aiPacingMode === 'manual' && hasAiWorkPending(state);
  manualBtn.hidden = !showManualBtn;
}

// "◯" is this project's own placeholder for K in hand-written INST text (matches K's white-circle
// dot elsewhere) -- confirmed 2026-07-30, generalized from an initial Z-only request.
const INST_RESOURCE_ALIAS = { '◯': 'K' };

/** Renders an INST description into container, replacing every "資源{letters}" run (e.g. "資源Z",
 * "資源A,B,C", "資源◯") with the literal word plus one small colored .action-dot per resource --
 * reuses the same dots/colors as the DSL action-icon rendering (buildActionIcons) rather than
 * introducing a second resource-color system. Confirmed 2026-07-30. */
function renderInstBody(container, text) {
  container.innerHTML = '';
  if (!text) {
    container.textContent = '(説明は未設定です)';
    return;
  }
  const pattern = /資源((?:[ABCKZ◯],?)+)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    container.appendChild(document.createTextNode('資源'));
    for (const letter of match[1].split(',')) {
      container.appendChild(actionDot(INST_RESOURCE_ALIAS[letter] || letter));
    }
    lastIndex = pattern.lastIndex;
  }
  container.appendChild(document.createTextNode(text.slice(lastIndex)));
}

// How much bigger than real size the enlarge modal's card/QST visual renders (2026-08-0X: bumped
// another x1.5 per user feedback "拡大表示　もう少し大きく　1.5倍", from the original 2x/1.5x this
// replaced -- see showCardEnlargeModal). QST has no intrinsic width of its own (see CSS), so
// QST_PRE_SCALE_WIDTH sets it explicitly and ENLARGE_SCALE_QST is tuned against that pre-scale width
// so the *final* on-screen size stays within .card-inst-modal--wide's ~404px content area.
// QST_PRE_SCALE_WIDTH bumped 170->250 (2026-08-06, found via headless screenshot): the new GOAL text
// (a full "目標：..." sentence, not a short DSL string -- see questGoalDisplayText) was wrapping one
// character per line at 170px pre-scale once split across .qst-card's 2 columns, since the rewards
// column's own fixed (mark-based) width left goal only ~40-50px to work with. ENLARGE_SCALE_QST lowered
// from 2.25->1.5 to compensate, keeping 250*1.5=375px comfortably inside the modal's budget.
const ENLARGE_SCALE = 3;
const ENLARGE_SCALE_QST = 1.5;
const QST_PRE_SCALE_WIDTH = 250;

/**
 * Enlarge popup for a card/AREA/QST tile -- unifies what used to be three separate mouse-only
 * gestures (single-click flip, right-click INST, dblclick TAP) into one tap target that works the
 * same on touch and mouse (2026-08-0X, per user request: iPad has no right-click/dblclick
 * equivalent). Static markup in index.html (#card-inst-overlay), not re-rendered by render() -- just
 * shown/hidden and its content swapped.
 *
 * visualNode is a *fresh, noInteraction* card/QST visual (built by the caller so this function stays
 * agnostic of buildCardVisual vs buildQstCardVisual). null for AREA tiles, which have no "back" and no
 * card-shaped visual, just INST text. sibling is the id of the other tier face (null if there's no real
 * sibling-face data), and siblingVisualNode is that face's own independently-built visual (same shape as
 * visualNode, built the same way by the caller) -- both faces are shown side by side at once (2026-08-25,
 * per user request: "カードをタップして拡大した時 表裏両方表示するようにしてほしい"; "拡大の大きさは今
 * のままで" -- each stays at its normal ENLARGE_SCALE/ENLARGE_SCALE_QST, the modal widens to fit both
 * instead of either shrinking). Replaces the old single-visualNode-with-a-flip-button design (toggling
 * visualNode's own baked-in `.shop-card__back`/`.qst-card__back` overlay via a --flipped class) --
 * siblingVisualNode is a wholly separate, independently-built visual instead, laid out in a
 * .card-enlarge-row exactly like showAreaEnlargeModal's own multi-tile row.
 *
 * pickAction (2026-08-0X, per user feedback -- CON/JOB/RESOURCE choice cards previously had no
 * enlarge affordance at all, since a plain tap on them was already spoken for by "pick this card";
 * see attachPickableEnlarge, the new home for that tap) is optional: `{label, onPick}`. When present,
 * a prominent button is shown that runs onPick() and closes the modal -- the actual "commit this
 * choice" gesture now lives here instead of on the card/cell itself, matching the user's own original
 * proposal for this: tap to see it enlarged, tap again (here) to actually pick it.
 */
function showCardEnlargeModal(faceId, visualNode, sibling, siblingVisualNode, pickAction) {
  const overlay = document.getElementById('card-inst-overlay');
  const modal = overlay.querySelector('.card-inst-modal');
  const visualContainer = overlay.querySelector('.card-inst-modal__visual');
  const flipBtn = overlay.querySelector('.card-inst-modal__flip-button');
  const pickBtn = overlay.querySelector('.card-inst-modal__pick-button');

  // Must come before measuring visualNode's size below -- getBoundingClientRect() on a subtree of a
  // still-hidden (display:none) overlay always reports 0x0, since the browser never lays out
  // display:none content.
  overlay.hidden = false;

  visualContainer.innerHTML = '';
  visualContainer.style.width = '';
  visualContainer.style.height = '';
  const isQst = !!visualNode && visualNode.classList.contains('qst-card');
  modal.classList.toggle('card-inst-modal--wide', !!visualNode && !siblingVisualNode);
  modal.classList.toggle('card-inst-modal--dual', !!siblingVisualNode);
  // The overlay/modal DOM is shared and reused across calls, so leftover modifiers from a previous
  // showAreaEnlargeModal/showCardListTermModal call must be cleared here too, or they'd stick around on
  // every later card modal.
  modal.classList.remove('card-inst-modal--area-wide', 'card-inst-modal--term');

  if (visualNode) {
    // transform:scale() only changes how a node PAINTS -- it reserves no extra LAYOUT space, so two
    // scaled siblings placed a mere ~10px apart in *layout* terms (each face's own tiny natural width)
    // would visually overlap once each independently balloons to 3x/1.5x that width. Each face gets its
    // own "slot" wrapper explicitly sized to its POST-scale dimensions (mirroring what visualContainer
    // alone used to do for the old single-visual design) so the flex row lays out correctly; the scaled
    // node then exactly fills its slot corner-to-corner via transform-origin:top left (found via
    // headless-browser screenshot: the original single-visual design's transform-origin:top center only
    // ever worked because there was no sibling slot for it to need to align flush against).
    const row = el('div', 'card-enlarge-row');
    visualContainer.appendChild(row);
    const frontSlot = el('div', 'card-enlarge-row__slot');
    row.appendChild(frontSlot);
    frontSlot.appendChild(visualNode);
    let backSlot = null;
    if (siblingVisualNode) {
      backSlot = el('div', 'card-enlarge-row__slot');
      row.appendChild(backSlot);
      backSlot.appendChild(siblingVisualNode);
    }
    if (isQst) {
      visualNode.style.width = `${QST_PRE_SCALE_WIDTH}px`;
      if (siblingVisualNode) siblingVisualNode.style.width = `${QST_PRE_SCALE_WIDTH}px`;
    }
    const scale = isQst ? ENLARGE_SCALE_QST : ENLARGE_SCALE;
    // Measured (both faces' natural, pre-transform rects) before either is transformed -- getBoundingClientRect
    // only reports real sizes for nodes already attached to the live document (overlay.hidden=false above
    // put visualContainer itself there), and measuring face A before face B has joined the row risks a
    // stale reading if adding B reflows A (row is a flex container).
    const frontRect = visualNode.getBoundingClientRect();
    const backRect = siblingVisualNode ? siblingVisualNode.getBoundingClientRect() : null;
    visualNode.style.transform = `scale(${scale})`;
    visualNode.style.transformOrigin = 'top left';
    frontSlot.style.width = `${frontRect.width * scale}px`;
    frontSlot.style.height = `${frontRect.height * scale}px`;
    let totalWidth = frontRect.width * scale;
    let maxHeight = frontRect.height * scale;
    if (backRect) {
      siblingVisualNode.style.transform = `scale(${scale})`;
      siblingVisualNode.style.transformOrigin = 'top left';
      backSlot.style.width = `${backRect.width * scale}px`;
      backSlot.style.height = `${backRect.height * scale}px`;
      totalWidth += backRect.width * scale + 10; // .card-enlarge-row's own gap
      maxHeight = Math.max(maxHeight, backRect.height * scale);
    }
    // visualContainer itself still needs this too, same reason the old single-visual design set it.
    visualContainer.style.width = `${totalWidth}px`;
    visualContainer.style.height = `${maxHeight}px`;
  }

  // Both faces' INST shown at once now, each under its own id label (2026-08-25, replacing the old
  // single shownId()/flip-button toggle -- see this function's own top-of-file doc).
  const body = overlay.querySelector('.card-inst-modal__body');
  body.innerHTML = '';
  overlay.querySelector('.card-inst-modal__title').textContent = faceId;
  if (siblingVisualNode) {
    for (const id of [faceId, sibling]) {
      body.appendChild(el('div', 'card-inst-modal__face-label', id));
      const section = el('div');
      renderInstBody(section, instForId(id));
      body.appendChild(section);
    }
  } else {
    renderInstBody(body, instForId(faceId));
  }
  flipBtn.hidden = true;
  pickBtn.hidden = !pickAction;
  if (pickAction) {
    pickBtn.textContent = pickAction.label;
    pickBtn.onclick = () => {
      hideCardEnlargeModal();
      pickAction.onPick();
    };
  }
}

function hideCardEnlargeModal() {
  document.getElementById('card-inst-overlay').hidden = true;
}

/** Whether areaId exists in the AREA sheet at all (mirrors cardFaceExists' own try/catch pattern). */
function areaFaceExists(areaId) {
  try {
    dataLoaderMod.getAreaRow(INDEX, areaId);
    return true;
  } catch (e) {
    return false;
  }
}

/** areaId plus every remaining higher tier that actually exists in the data, in order (2026-08-05, per
 * user feedback: "AREA001Aなど AREA001B AREA001Cというようにレベルアップ後があるカード拡大時に右側に
 * レベルアップ後のカードの拡大画像を表示してください" -- tapping AREA001A shows [A,B,C], tapping
 * AREA001B shows [B,C], tapping AREA001C shows just [C]). AREAs with no tier concept at all (AREA007/
 * AREA008, bare ids with no trailing A/B/C) just return themselves -- there's no "higher tier" to chain
 * to. Not every tiered AREA group actually goes up to C in the data, so each candidate is checked with
 * areaFaceExists rather than assuming A/B/C always all three exist. */
function areaTierChain(areaId) {
  const match = /^(AREA\d+)([ABC])$/.exec(areaId);
  if (!match) return [areaId];
  const [, base, tier] = match;
  const tiers = ['A', 'B', 'C'];
  const chain = [];
  for (let i = tiers.indexOf(tier); i < tiers.length; i++) {
    const candidateId = base + tiers[i];
    if (areaFaceExists(candidateId)) chain.push(candidateId);
  }
  return chain;
}

/** Static, non-interactive preview of areaId's tile appearance (2026-08-05, added for the AREA
 * enlarge-modal tier chain above) -- unlike renderBoard's real tiles, there's no live map to read
 * occupants/accumulated-fee/turn-order from for a *hypothetical* tier that may not even be the AREA's
 * current one, so this only ever shows what's intrinsic to the AREA row itself: name, slot
 * requirements (all empty, no dice), the ACTION icon, and the flat fee rate (no accumulated amount --
 * there's nothing real to accumulate for a tier that isn't actually in play). */
function buildAreaTilePreviewNode(areaId) {
  const areaRow = dataLoaderMod.getAreaRow(INDEX, areaId);
  const tpl = document.getElementById('tpl-map-tile');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.classList.add('map-tile--preview');
  node.querySelector('.map-tile__id').textContent = areaName(areaId);

  const tier = areaId.match(/([ABC])$/);
  if (tier) node.dataset.tier = tier[1];

  const slotsEl = node.querySelector('.map-tile__slots');
  for (const requirement of boardMod.getSlotRequirements(areaRow)) {
    const slotEl = el('div', 'slot');
    if (typeof requirement === 'number') slotEl.appendChild(dieFace(requirement));
    else slotEl.textContent = requirement; // 'ANY' / 'EX' / 'NONE' (getSlotRequirements already trims NONE)
    slotsEl.appendChild(slotEl);
  }

  const actionEl = node.querySelector('.map-tile__action');
  const icons = buildActionIcons(areaRow.ACTION);
  if (icons) actionEl.appendChild(icons);
  else actionEl.textContent = areaRow.ACTION;

  const feeEl = node.querySelector('.map-tile__fee');
  if (!tier) {
    feeEl.remove();
  } else {
    const feeRate = tier[1] === 'B' ? 1 : tier[1] === 'C' ? 2 : 0;
    feeEl.querySelector('.map-tile__fee-rate').textContent = feeRate > 0 ? `使用料${feeRate}K` : '';
    feeEl.querySelector('.map-tile__fee-amount').remove();
  }
  return node;
}

/** AREA tap-to-enlarge (2026-08-05, replaces the old plain-INST-text-only modal for AREA tiles -- see
 * this function's own doc above on the tier chain). Reuses the same overlay chrome as
 * showCardEnlargeModal (title/INST body/close button) but not its single-visualNode transform-scale
 * mechanism (built for one card at a time) -- multiple tile previews are laid out side by side directly
 * at a fixed enlarged CSS size instead (see .area-enlarge-row in style.css). Title/INST always describe
 * the tapped tier specifically (not the chain's first entry, which is the same thing unless a card's
 * own tier differs from what's currently on the board -- not possible today, but keeps this correct if
 * that ever changes). No flip/pick button -- neither concept applies here. */
function showAreaEnlargeModal(areaId) {
  const overlay = document.getElementById('card-inst-overlay');
  const modal = overlay.querySelector('.card-inst-modal');
  const visualContainer = overlay.querySelector('.card-inst-modal__visual');
  const flipBtn = overlay.querySelector('.card-inst-modal__flip-button');
  const pickBtn = overlay.querySelector('.card-inst-modal__pick-button');

  overlay.hidden = false;
  // Wider than the card/QST modal (2026-08-05, per user feedback: "拡大画像３枚だと狭いんでスクロールが
  // いらないように 表示範囲広げれますか") -- .card-inst-modal--wide's 440px only just barely overflowed
  // with 3 tiles, forcing .area-enlarge-row's scroll fallback to kick in even on comfortably wide
  // screens; --area-wide's own 500px gives enough headroom that 3 tiles fit without it. Removes --wide
  // too, in case a previous showCardEnlargeModal/showCardListTermModal call left it (or --term) on
  // this same shared modal element.
  modal.classList.remove('card-inst-modal--wide', 'card-inst-modal--term');
  modal.classList.add('card-inst-modal--area-wide');
  flipBtn.hidden = true;
  pickBtn.hidden = true;

  visualContainer.innerHTML = '';
  visualContainer.style.width = '';
  visualContainer.style.height = '';
  const row = el('div', 'area-enlarge-row');
  for (const id of areaTierChain(areaId)) {
    row.appendChild(buildAreaTilePreviewNode(id));
  }
  visualContainer.appendChild(row);

  overlay.querySelector('.card-inst-modal__title').textContent = areaName(areaId);
  renderInstBody(overlay.querySelector('.card-inst-modal__body'), instForId(areaId));
}

/** Slowly auto-scrolls from the top to the very bottom of the page once, right after the initial
 * render (2026-08-0X, per user request: "ゲーム開始時初期画面からゆっくり一番下までスクロール"). Acts
 * as a quick guided tour of the board on load, and conveniently ends at the bottom, where the first
 * thing a new game actually needs from the player -- the RESOURCE card choice, see renderResourceChoice
 * -- lives (in the 所持カード sidebar). Deliberately not a CSS `scroll-behavior:smooth` (its duration is
 * browser-controlled and typically much faster than "ゆっくり" asks for) -- a manual rAF loop with a
 * fixed, generous duration gives control over the pacing. Only ever called once, from DOMContentLoaded
 * (not from render(), which re-runs on every state change) -- a page reload is the only way this app
 * ever "starts" a game, so DOMContentLoaded already means "game start" here. */
function autoScrollToBottomOnStart() {
  const startY = window.scrollY;
  const endY = document.documentElement.scrollHeight - window.innerHeight;
  if (endY <= startY) return; // page doesn't even overflow -- nothing to scroll
  const durationMs = 3000;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
    window.scrollTo(0, startY + (endY - startY) * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

document.addEventListener('DOMContentLoaded', () => {
  seedDebugHistoryIfNeeded();
  render(STATE);
  autoScrollToBottomOnStart();

  // Clicking anywhere that isn't a die or a slot clears the current dice selection (2026-08-02, per
  // user feedback: "ダイス以外のところをクリックすれば解除"). Capture phase (true) so this runs
  // *before* the specific die/slot click handler underneath it (which may re-render and replace the
  // whole DOM subtree) -- checking e.target.closest() against the live, pre-render DOM is what makes
  // this reliable, rather than trying to inspect a possibly-detached node after the fact. A die/slot
  // click itself is correctly left alone here (closest() finds the match) -- its own listener handles
  // selecting/placing normally.
  document.addEventListener('click', (e) => {
    if (selectedDieIds.length === 0) return;
    if (e.target.closest('.die, .slot')) return;
    selectedDieIds = [];
    render(STATE);
  }, true);

  const overlay = document.getElementById('card-inst-overlay');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideCardEnlargeModal(); // backdrop click only, not the box itself
  });
  overlay.querySelector('.card-inst-modal__close').addEventListener('click', hideCardEnlargeModal);

  document.getElementById('undo-button').addEventListener('click', handleUndoClick);
  document.getElementById('undo-button-build').addEventListener('click', handleUndoClick);
  document.getElementById('dice-cancel-button').addEventListener('click', handleDiceCancelClick);
  document.getElementById('dice-cancel-button-build').addEventListener('click', handleDiceCancelClick);

  document.getElementById('game-end-replay-button').addEventListener('click', () => enterReplayMode());
  document.getElementById('replay-back').addEventListener('click', handleReplayBack);
  document.getElementById('replay-forward').addEventListener('click', handleReplayForward);
  for (let round = 1; round <= 4; round++) {
    document.getElementById(`replay-round-${round}`).addEventListener('click', () => jumpToReplayRound(round));
  }
  document.getElementById('replay-exit').addEventListener('click', exitReplayMode);

  document.getElementById('game-end-ranking-button').addEventListener('click', openRankingOverlay);
  document.getElementById('ranking-close-button').addEventListener('click', closeRankingOverlay);
  document.getElementById('ranking-reset-button').addEventListener('click', handleRankingResetClick);
  const rankingOverlayEl = document.getElementById('ranking-overlay');
  rankingOverlayEl.addEventListener('click', (e) => {
    if (e.target === rankingOverlayEl) closeRankingOverlay(); // backdrop click only, matching #card-inst-overlay
  });

  document.getElementById('debug-mode-toggle').addEventListener('click', toggleDebugMode);
  document.getElementById('debug-turn-back').addEventListener('click', handleDebugTurnBack);
  document.getElementById('debug-turn-forward').addEventListener('click', handleDebugTurnForward);
  document.getElementById('debug-round-back').addEventListener('click', handleDebugRoundBack);
  document.getElementById('debug-round-forward').addEventListener('click', handleDebugRoundForward);

  document.getElementById('debug-setup-start-button').addEventListener('click', openDebugSetupFlow);
  document.getElementById('debug-setup-end-button').addEventListener('click', advanceDebugSetupFlow);
  document.getElementById('debug-setup-cancel-button').addEventListener('click', cancelDebugSetupFlow);

  document.getElementById('card-list-open-button').addEventListener('click', openCardListOverlay);

  document.getElementById('round-pass-button').addEventListener('click', handleRoundPassClick);
  document.getElementById('round-pass-confirm-no').addEventListener('click', () => {
    pendingRoundPassConfirm = null;
    render(STATE);
  });
  document.getElementById('round-pass-confirm-yes').addEventListener('click', () => {
    const { playerId } = pendingRoundPassConfirm;
    pendingRoundPassConfirm = null;
    handleRoundPassConfirmed(STATE, playerId);
    render(STATE);
  });

  document.getElementById('white-overflow-confirm-no').addEventListener('click', () => {
    pendingWhiteOverflowConfirm = null;
    render(STATE);
  });
  document.getElementById('white-overflow-confirm-yes').addEventListener('click', () => {
    const { onConfirm } = pendingWhiteOverflowConfirm;
    pendingWhiteOverflowConfirm = null;
    onConfirm();
  });

  // 「いいえ」はTAPせずそのまま元のダイス配置を続行する -- pendingJob007TapPrompt自身の doc の通り、
  // これは警告(キャンセル可)ではなく任意の"先にTAPしますか"提案なので。
  document.getElementById('job007-tap-prompt-no').addEventListener('click', () => {
    const { onProceed } = pendingJob007TapPrompt;
    pendingJob007TapPrompt = null;
    onProceed();
  });
  document.getElementById('job007-tap-prompt-yes').addEventListener('click', () => {
    const { playerId, dieId, onProceed } = pendingJob007TapPrompt;
    pendingJob007TapPrompt = null;
    boardMod.useBareTapAbility(STATE, INDEX, { playerId, chosenDieId: dieId }, 'JOB007');
    onProceed();
  });

  document.getElementById('ai-pacing-select').addEventListener('change', (e) => {
    if (aiPumpTimer !== null) { clearTimeout(aiPumpTimer); aiPumpTimer = null; }
    aiPacingMode = e.target.value;
    render(STATE);
  });
  document.getElementById('ai-manual-step-button').addEventListener('click', () => {
    driveOneAiStep(STATE);
    render(STATE);
  });

  document.getElementById('placement-choice-cancel').addEventListener('click', () => {
    pendingPlacementChoice = null;
    render(STATE);
  });
  document.getElementById('placement-choice-confirm').addEventListener('click', () => {
    const { dieId, mapId, slotIndex, colorPreference, wildcard } = pendingPlacementChoice;
    pendingPlacementChoice = null;
    // JOB003/道化 (2026-08-19) -- see attemptPlaceSelectedWildcardDie's own doc.
    if (wildcard) {
      placeSelectedWildcardDie(STATE, dieId, mapId, colorPreference);
    } else {
      placeSelectedDie(STATE, dieId, mapId, slotIndex, colorPreference);
    }
  });

  document.getElementById('tap-choice-cancel').addEventListener('click', () => {
    pendingTapChoice = null;
    render(STATE);
  });
  document.getElementById('tap-choice-confirm').addEventListener('click', () => {
    const { physicalId, playerId, bareTap, dieId, cardPhysicalId, value } = pendingTapChoice;
    pendingTapChoice = null;
    const context = { playerId };
    // 2026-08-25: cardPhysicalId (targeting one of the player's own eligible cards) and dieId (a real
    // die) are mutually exclusive -- see renderTapChoiceModal's own doc.
    if (cardPhysicalId !== null) context.chosenCardPhysicalId = cardPhysicalId;
    else context.chosenDieId = dieId;
    if (bareTap.kind === 'CHANGE_DIE_VALUE') context.chosenDelta = value;
    else if (bareTap.kind !== 'MONUMENT_CHANGE_DIE_VALUE') context.chosenValue = value;
    const result = boardMod.useBareTapAbility(STATE, INDEX, context, physicalId);
    placementMessage = result.success ? '' : `カードを使用できません（${result.reason}）`;
    render(STATE);
  });

  document.getElementById('auto-mode-choice-close').addEventListener('click', () => {
    pendingAutoModeChoice = null;
    render(STATE);
  });

  document.getElementById('turn-end-warning-no').addEventListener('click', () => {
    pendingTurnEndWarning = null;
    render(STATE);
  });
  document.getElementById('turn-end-warning-yes').addEventListener('click', () => {
    const { playerId } = pendingTurnEndWarning;
    pendingTurnEndWarning = null;
    advanceTurnIfPossible(STATE, playerId);
    render(STATE);
  });
});
