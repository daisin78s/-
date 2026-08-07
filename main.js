/**
 * UI layer, wired to the real game engine (src/*.js, loaded via index.html's window.__modules
 * registry -- see that file's comments). `STATE` is a real GameState built once via setup.js's setup
 * pipeline (see createInitialState()) and mutated in place by the same setup.js/turn-flow.js/board.js/
 * executor.js/qst.js functions the engine's own tests use -- this file only renders `STATE` to the DOM
 * and translates clicks into those engine calls, no game logic of its own (beyond a few read-only
 * display helpers like mockEvalMetric, explicitly still local -- see their own doc comments for why).
 *
 * As of 2026-07-30, everything is wired to the real engine end-to-end: round-1 onboarding, dice
 * placement, BUILD/UPGRADE candidate selection, TAP reactions, free actions, TURNEND/round-end, and
 * QST reward claiming (including BUILD-type rewards, via the same candidate-selection modal AREA
 * builds use).
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

function createInitialState() {
  const state = gameStateMod.createEmptyGameState(randomSeed());
  setupMod.createPlayers(state, ['Alice', 'Bob', 'Carol', 'Dan']);
  setupMod.prepareMaps(state, INDEX);
  setupMod.prepareShops(state, INDEX);
  setupMod.rollInitialColorDice(state);
  setupMod.dealConCards(state);
  setupMod.dealResourceCandidates(state, INDEX);
  setupMod.dealJobPool(state);
  qstMod.setupQuests(state);
  return state;
}

const STATE = createInitialState();

// ---------------------------------------------------------------------------
// AI players (2026-08-03, per user feedback: "プレイヤー1は人間 プレイヤー2 3 4はAIの対戦を実装して
// 欲しい", generalized same day: "4人のプレイヤー人間 AIをそれぞれ選べるようにしてほしい", then split
// into 2 strengths once AIPlayer grew a lookahead option: "先程のAIをLV1 新しく作ったAIをLV2として
// ...選べるようにしてください"). Each player seat holds one of 3 roles in playerRoles -- 'HUMAN',
// 'AI_LV1' (the original pure-1-ply-greedy AIPlayer, lookaheadExtraTurns:0 -- fast, no multi-turn
// planning), or 'AI_LV2' (lookaheadExtraTurns:1, see ai-player.js's own doc for what that buys and
// costs: a real game now takes on the order of a minute instead of ~10s). Both AI levels share the same
// stateless MoveGenerator/Evaluator/Simulator instances (only the AIPlayer wrapper differs), same as
// game-runner.js's own pattern for AI-vs-AI batch games. Defaults to P1-human, everyone else AI_LV2
// (matching AIPlayer's own default before this split existed); renderPlayerRoleControl lets the human
// change any seat's role at any time, including mid-game -- this is purely a UI-driving concern (which
// player's turn gets a click-through vs an automatic driveOneAiStep), not part of GameState itself, so
// there's nothing structurally stopping a mid-game switch.
// ---------------------------------------------------------------------------

const playerRoles = new Map([['P1', 'HUMAN'], ['P2', 'AI_LV2'], ['P3', 'AI_LV2'], ['P4', 'AI_LV2']]);
function isAiPlayer(playerId) { return playerRoles.get(playerId) !== 'HUMAN'; }

const aiEvalTable = evalTableMod.buildEvalTable(INDEX.raw);
const aiEvaluator = new evaluatorMod.Evaluator(INDEX, aiEvalTable);
const aiMoveGenerator = new moveGeneratorMod.MoveGenerator();
const aiSimulator = new simulatorMod.Simulator();
const aiPlayerLv1 = new aiPlayerMod.AIPlayer(INDEX, aiMoveGenerator, aiEvaluator, aiSimulator, { lookaheadExtraTurns: 0 });
const aiPlayerLv2 = new aiPlayerMod.AIPlayer(INDEX, aiMoveGenerator, aiEvaluator, aiSimulator, { lookaheadExtraTurns: 1 });
/** Which AIPlayer instance drives playerId's own TURN moves -- see playerRoles' own comment. */
function aiPlayerFor(playerId) { return playerRoles.get(playerId) === 'AI_LV1' ? aiPlayerLv1 : aiPlayerLv2; }

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
  if (state.round === 0) return false; // still waiting on the human's own resource choice
  if (state.phase === 'GAME_END') return false;
  const next = turnFlowMod.getNextTurn(state);
  // ROUND_OVER should never actually be observed here in practice -- whoever's own endTurn call makes
  // isRoundOver(state) true already cascades into endRound/startRound itself -- but if it somehow is,
  // report "work pending" so pumpAiDelayed's timer still resolves it via driveOneAiStep's own defensive
  // ROUND_OVER branch, rather than silently stalling forever (next.playerId is undefined here, so this
  // must be checked before isAiPlayer(next.playerId), which is true for undefined and would otherwise
  // give the right answer for the wrong reason).
  if (next.type === 'ROUND_OVER') return true;
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
function driveOneAiStep(state) {
  // The real block -- see hasAiWorkPending's matching guard for the full story. pumpAiInstant's while
  // loop calls this directly (not hasAiWorkPending) each iteration, so the guard has to live here too,
  // not just in hasAiWorkPending, or 'instant' mode would still blow straight through the human's still-
  // open BUILD/UPGRADE choice modal.
  if (pendingBuildChoice) return false;
  const resourceChoice = state.pendingChoices.find((c) => c.kind === 'SELECT_RESOURCE_CARDS' && isAiPlayer(c.playerId));
  if (resourceChoice) {
    // Random, not simulate-and-score (2026-08-03, per user feedback: "初期資源、CON、JOBは現状は完全
    // ランダムでお願いします そのうち評価値を入れます" -- see src/ai/game-runner.js's matching fix and
    // its own doc for why: RESOURCE/CON/JOB have no real eval-table values yet).
    const pair = rngMod.shuffle(state.rng, resourceChoice.context.candidates).slice(0, 2);
    setupMod.chooseResourceCards(state, resourceChoice.playerId, pair);
    maybeStartRound1(state);
    return true;
  }

  if (state.round === 0) return false;
  // Found 2026-08-03 (all-AI game): without this, a finished game's every round-4 die stays "placed",
  // so isRoundOver(state) (and therefore getNextTurn) keeps reporting ROUND_OVER forever after
  // GAME_END, and the ROUND_OVER branch below has no way to tell "just ended" from "already over" --
  // it kept calling endRound/startRound every single call, eventually only stopped by
  // pumpAiInstant's MAX_STEPS safety valve, which is real (non-trivial) work repeated 20000 times.
  // Previously unreachable because there was always at least one human player to naturally stop the
  // pump before/at GAME_END.
  if (state.phase === 'GAME_END') return false;
  const next = turnFlowMod.getNextTurn(state);
  // Defensive fallback (not expected to fire in practice, same as src/ai/game-runner.js's playGame own
  // ROUND_OVER branch): whoever's own endTurn call makes isRoundOver(state) true already cascades into
  // endRound/startRound itself, both below and in advanceTurnIfPossible for the human. next.playerId is
  // undefined for ROUND_OVER, and isAiPlayer(undefined) is true (playerRoles.get(undefined) is
  // undefined, not 'HUMAN'), so this must be handled before the isAiPlayer(next.playerId) check below or it crashes
  // trying to look up a player by an undefined id.
  if (next.type === 'ROUND_OVER') {
    turnFlowMod.endRound(state, INDEX);
    if (state.phase !== 'GAME_END') turnFlowMod.startRound(state);
    return true;
  }
  if (!isAiPlayer(next.playerId)) return false;
  const player = state.players.find((p) => p.id === next.playerId);

  // turn-flow.getNextTurn reports 'TURN' as soon as JOB is drafted, even before CON is chosen (same
  // quirk main.js's own hasFinishedOnboarding works around everywhere else -- see its doc) -- so
  // onboarding isn't gated on next.type==='ONBOARDING_NEEDED' alone, it's "not finished yet" by
  // whichever type getNextTurn happens to report. Found 2026-08-03: without this, an AI player who'd
  // drafted JOB but not yet chosen CON fell into the TURN branch below and got stuck (selectMove trying
  // to place a die for a player who hasn't received their initial resources yet).
  if (next.type === 'ONBOARDING_NEEDED' || !hasFinishedOnboarding(player)) {
    if (!player.jobCardId) {
      // Random, not simulate-and-score (2026-08-03, per user feedback -- see the resource-choice
      // branch above, and src/ai/game-runner.js's matching fix and its own doc for why).
      const jobFaceId = state.jobPool[Math.floor(rngMod.next(state.rng) * state.jobPool.length)];
      setupMod.chooseJob(state, INDEX, next.playerId, jobFaceId);
      // No auto/manual-mode prompt for AI (unlike the human path, e.g. renderJobPool's click handler)
      // -- pendingAutoModeChoice is a human-UI convenience only; MoveGenerator's own move generation
      // already accounts for whichever mode (auto/manual) is actually active, see its own doc.
    } else {
      const face = rngMod.next(state.rng) < 0.5 ? 'A' : 'B';
      setupMod.chooseConFace(state, INDEX, next.playerId, face);
      setupMod.receiveInitialResources(state, INDEX, next.playerId);
    }
    return true;
  }

  // next.type === 'TURN' && hasFinishedOnboarding(player), i.e. a genuine real turn. See
  // aiOpenTurnPlayerId's own comment for why this can't just reuse turnActionTaken directly.
  // noteActiveTurnPlayerForJobPool here (not just render()'s copy) so a turn-start is caught even when
  // pumpAiInstant blows straight through this AI's whole turn without render() ever pausing on it --
  // see lastNotedActiveTurnPlayerId's own comment.
  noteActiveTurnPlayerForJobPool(state, next.playerId);
  const hasPlacedDieThisTurn = next.playerId === aiOpenTurnPlayerId ? aiOpenTurnHasPlacedDie : false;
  const move = aiPlayerFor(next.playerId).selectMove(state, next.playerId, { hasPlacedDieThisTurn });
  if (!move) return false; // defensive -- canEndTurn should always eventually free this up
  const result = simulatorMod.applyInPlace(state, INDEX, move);
  if (move.type === 'END_TURN' && result.success) {
    aiOpenTurnPlayerId = null;
  } else {
    aiOpenTurnPlayerId = next.playerId;
    aiOpenTurnHasPlacedDie = hasPlacedDieThisTurn || ((move.type === 'PLACE_DIE' || move.type === 'PASS_DIE') && result.success);
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
 * while a step is already scheduled) never stack up duplicate timers. */
function pumpAiDelayed() {
  if (aiPumpTimer !== null) return;
  aiPumpTimer = setTimeout(() => {
    aiPumpTimer = null;
    if (!hasAiWorkPending(STATE)) return;
    driveOneAiStep(STATE);
    render(STATE);
  }, AI_STEP_DELAY_MS);
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
// {A:'AUTO'|'Z', B:..., C:...} -- CON002B's "real or Z" payment choice for whichever BUILD/UPGRADE
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
// { mapId, slotIndex, colors, colorPreference } | null -- CON002B's payment choice for an AREA whose
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
 * with the same playerId no-ops), from both driveOneAiStep (AI path) and render() (human path). See
 * lastNotedActiveTurnPlayerId's own comment for why two call sites are needed. */
function noteActiveTurnPlayerForJobPool(state, playerId) {
  if (playerId === lastNotedActiveTurnPlayerId) return;
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
  turnHistory.forEach((entry, i) => {
    const activePlayer = entry.playerId ? state.players.find((p) => p.id === entry.playerId) : null;
    const item = el('button', 'debug-history-list__item', `R${entry.round} / ${activePlayer ? activePlayer.name : '-'} / Turn${i + 1}`);
    item.type = 'button';
    item.classList.toggle('debug-history-list__item--current', i === historyCursor);
    item.addEventListener('click', () => jumpToHistoryIndex(i));
    listEl.appendChild(item);
  });
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

// ---------------------------------------------------------------------------
// Card/area facts, derived live from INDEX (2026-07-30: replaces the former hand-transcribed
// CARD_FACTS/QST_FACTS/AREA_FACTS/SHOP_REQ tables now that the real engine + real data/game.json are
// loaded -- every card the engine can produce renders correctly, not just the ~30 IDs that used to be
// manually copied in here).
// ---------------------------------------------------------------------------

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
    req: row.DICE ? `目 ${row.DICE}` : '',
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

/** QST sheet counterpart of factsForFaceId -- {goal, rewards:[REWARD1,REWARD2-3,REWARD2-3], inst}.
 * REWARD2-3 (2026-08-06's REWARD2/REWARD3 merge) fills both the [1] and [2] slots, matching
 * qst.js's own REWARD_FIELDS layout. */
function factsForQstFaceId(faceId) {
  let row;
  try {
    row = dataLoaderMod.getQstRow(INDEX, faceId);
  } catch (e) {
    return { goal: '', rewards: [] };
  }
  return { goal: row.GOAL || '', rewards: [row.REWARD1, row['REWARD2-3'], row['REWARD2-3']], inst: row.INST || '' };
}

/** Plain-text reward summary for QST's 3-line REWARD block (2026-08-06, per user feedback: "1位
 * 2K"/"2〜3位 K" style, replacing the ◯/● claim marks added earlier the same day -- confirmed via
 * AskUserQuestion: value text only, no marks). Every QST row's REWARD1/REWARD2-3 cell is a bare
 * ADD(...), so no need for the full DSL parser here -- e.g. "ADD(2K)" -> "2K", "ADD(2K,BZ)" ->
 * "2K+BZ". Falls back to the raw cell text for anything that isn't a bare ADD(...). */
function questRewardValueText(rewardDsl) {
  const match = /^ADD\((.*)\)$/.exec((rewardDsl || '').trim());
  return match ? match[1].replace(/,/g, '+') : (rewardDsl || '');
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
  'CHANGE((A,B,C),D)': () => actionRow([actionDot('A'), actionDot('B'), actionDot('C'), actionArrow(), actionSuffix('色D')]),
  // CHANGE(4K,VP) used to live here as an exact-match entry -- removed 2026-08-05, no longer reachable
  // (no card/AREA in the current data uses that literal count) and superseded by the general
  // buildChangeToVpIcon below, added per user feedback covering AREA010A/C's own K->VP counts.
  // JOB003's TAP (2026-08-0X, per user request -- previously unmatched by buildSetDiceAnyIcon, which
  // only matches bare SET_DICE_ANY() alone, not this compound with GRANT_PLACE_ANYWHERE chained after
  // it, so JOB003 was showing no icon at all): "ダイス目を変える" reads more directly than reusing
  // buildSetDiceAnyIcon's "🎲自由" wording, since this ability's real effect is the die's *value*
  // changing, not really "free placement" (the GRANT_PLACE_ANYWHERE half isn't called out separately
  // per the user's request -- just this one label for the whole TAP).
  'SET_DICE_ANY();GRANT_PLACE_ANYWHERE(THIS_DICE,THIS_TURN)': () => actionRow([actionSuffix('ダイス目を変える')]),
  // 2026-08-0X, per user request ("⤴️を消してそこに毎タームといれる"): bare UNTAP() only ever appears
  // as a TURNEND effect (confirmed against data/game.json -- JOB004/005/007, all "usable once per turn"
  // reactive/direct TAP abilities), so "毎ターン" (plain text) reads more clearly there than the ⤴️
  // glyph alone did. UNTAP_ALL(SELF) is a different DSL shape (an ONCE effect on C-tier-B cards, not a
  // per-turn reset) and keeps its own ⤴️×3 icon below, unaffected.
  'UNTAP()': () => actionRow([actionSuffix('毎ターン')]),
  'UNTAP_ALL(SELF)': () => actionRow([actionEmoji('⚡'), actionEmoji('⤴️'), actionEmoji('⤴️'), actionEmoji('⤴️')]),
  // REPLACE_ADD(D,wD) (confirmed 2026-07-29): a passive that swaps "gain your own die" for "gain a
  // white die" instead -- shown as the source resource turning into the replacement.
  'REPLACE_ADD(D,wD)': () => actionRow([actionSuffix('色D'), actionArrow(), actionEmoji('🎲')]),
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
  if (categories) children.push(actionSuffix(categories));
  if (buildValue !== null) {
    // die-face glyph(s) for the buildValue itself (2026-08-06) -- values above 6 (only BUILD(M,12)
    // today) can't come from one die, so this shows however many max-value (6) dice it'd take to
    // reach it (12 -> ⚅⚅), which happens to be exact for every buildValue in the current data (all are
    // either <=6 or an exact multiple of 6).
    const dieCount = Math.max(1, Math.ceil(buildValue / 6));
    for (let i = 0; i < dieCount; i++) children.push(dieFace(Math.min(buildValue, 6)));
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
  if (resource === 'D') return [actionSuffix(`${countStr || ''}色D`)];
  const nodes = [actionDot(resource)];
  if (countStr) nodes.push(actionCount(countStr));
  return nodes;
}

/** Wraps a "⚡ + resource node(s)" row into a 2-row stack (⚡ alone on top, the resource node(s) on
 * their own row below) when stacked is true -- confirmed 2026-07-30, per user feedback ("CONカードの
 * 効果をアイコンで上に、その下にもらえる資源というふうにして"), used for CON cards' effect display
 * (see fillCardFace). Plain single-row otherwise (every other card type, and AREA action displays). */
function gainIconRow(resourceNodes, stacked) {
  if (!stacked) return actionRow([actionEmoji('⚡'), ...resourceNodes]);
  const stack = el('div', 'action-icons-stack');
  stack.appendChild(actionRow([actionEmoji('⚡')]));
  stack.appendChild(actionRow(resourceNodes));
  return stack;
}

/**
 * ADD(K) / ADD(3K) / ADD(A) / ADD(2VP) etc: ⚡ + the resource. K/A/B/C/Z show as a colored dot (with
 * a count suffix only when the DSL has an explicit number, e.g. ADD(3K) -> ⚡●3 but ADD(K) -> ⚡●).
 * VP has no dot (confirmed 2026-07-29: VP is always plain text, never an icon/dot) so it's shown as
 * "{count}VP" text instead, e.g. ADD(2VP) -> ⚡2VP (confirmed 2026-07-29).
 */
function buildAddResourceIcon(actionText, stacked) {
  const match = /^ADD\((\d*)(K|A|B|C|Z|VP|D)\)$/.exec(actionText || '');
  if (!match) return null;
  const [, countStr, resource] = match;
  return gainIconRow(resourceItemNodes(countStr, resource), stacked);
}

/** ADD(A,K) / ADD(2C,4K) / ADD(A,B,C) etc: a bundled multi-resource grant (confirmed in
 * [[project-dice-wp-dsl-spec]]: everything in one ADD(...) list is granted together as one command)
 * -- ⚡ once, then each item's dot/count in sequence (2026-07-30, fixes R010/R011/R012 and
 * CON002A/CON003B/CON004B/CON005B showing no icon at all). Falls back to null (letting the raw-text
 * fallback handle it, where allowed) if any comma-separated part isn't a recognized shape. */
function buildAddMultiResourceIcon(actionText, stacked) {
  const match = /^ADD\(([^()]+,[^()]+)\)$/.exec(actionText || '');
  if (!match) return null;
  const parts = match[1].split(',');
  const resourceNodes = [];
  for (const part of parts) {
    const itemMatch = /^(\d*)(K|A|B|C|Z|VP|D)$/.exec(part.trim());
    if (!itemMatch) return null;
    resourceNodes.push(...resourceItemNodes(itemMatch[1], itemMatch[2]));
  }
  return gainIconRow(resourceNodes, stacked);
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

/** A bare BZ-granting TAP, optionally paired with BLOCK_BUILD(category,THIS_TURN) restrictions -- e.g.
 * JOB004's CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN) (2026-08-0X, per user request) or JOB007's ADD(BZ);
 * BLOCK_BUILD(A,THIS_TURN);BLOCK_BUILD(B,THIS_TURN);BLOCK_BUILD(C,THIS_TURN) (2026-08-07, replacing
 * JOB007's old ON(BUILD(U,M),ADD(BZ)) reaction -- see buildOnBuildAddResourceIcon's own doc and
 * [[project-dice-wp]] for why: reacting *after* an UPGRADE/Monument build meant the BZ always arrived too
 * late to help pay for the build that triggered it, and evaporated unspent at TURNEND. Now a bare TAP
 * the player fires *before* an UPGRADE/Monument build, so the BZ is actually usable). First line: either
 * pay -> {n}BZ (CHANGE form; BZ has no colored dot in this project's vocabulary, unlike
 * buildChangeQuantityIcon's K/A/B/C/Z -- matches every other "{n}BZ"/"軽減{n}Z" label elsewhere, plain
 * text rather than a dot+count) or ⚡BZ (ADD form, ⚡ prefix matching buildAddResourceIcon's "just gain
 * this, no cost" convention). Second line (only if any BLOCK_BUILD present): the blocked categories'
 * letters + "除く", except the single-M case which keeps the pre-existing "モニュメント除く" wording
 * users have already seen. **2026-08-04: the block used to be display-only text -- confirmed with the
 * user this needed real enforcement, so it's backed by a genuine rule (BLOCK_BUILD(...,THIS_TURN), see
 * board.getBuildCandidates); this label just reflects that.** Matches generically on shape (a bare
 * CHANGE(nX,nBZ) or ADD(nBZ), optionally followed by one or more BLOCK_BUILD(cat,THIS_TURN)), not any one
 * card by name -- the BZ grant alone, with no BLOCK_BUILD at all, still matches and simply skips the
 * second row. */
function buildBzForBuildIcon(actionText) {
  const stmts = (actionText || '').split(';').map((s) => s.trim());
  const changeMatch = /^CHANGE\((\d*)(K|A|B|C|Z),(\d*)BZ\)$/.exec(stmts[0]);
  const addMatch = /^ADD\((\d*)BZ\)$/.exec(stmts[0]);
  if (!changeMatch && !addMatch) return null;
  const blockMatches = stmts.slice(1).map((s) => /^BLOCK_BUILD\(([ABCMU]),THIS_TURN\)$/.exec(s));
  if (blockMatches.some((m) => !m)) return null; // unrecognized extra statement, don't guess
  const blockedCats = blockMatches.map((m) => m[1]);
  const stack = el('div', 'action-icons-stack');
  if (changeMatch) {
    const [, payCount, payResource, bzCount] = changeMatch;
    stack.appendChild(actionRow([...resourceItemNodes(payCount, payResource), actionArrow(), actionSuffix(`${bzCount}BZ`)]));
  } else {
    stack.appendChild(actionRow([actionEmoji('⚡'), actionSuffix(`${addMatch[1]}BZ`)]));
  }
  if (blockedCats.length > 0) {
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

/** CHANGE_DIE_VALUE(SELF±n): player adjusts the die by +-n -- shown as "±n" (confirmed 2026-07-29). */
function buildChangeDieValueIcon(actionText) {
  const match = /^CHANGE_DIE_VALUE\(SELF±(\d+)\)/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionCount(`±${match[1]}`)]);
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
 * convention elsewhere). Confirmed 2026-07-30, added for CON002B. */
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
 * resource); D/wD triggers show as 色D/🎲 (matching buildAddResourceIcon/buildAddWdIcon's own
 * conventions) since they're dice, not resource dots. */
function buildOnGetAddMultiIcon(actionText) {
  const stmts = (actionText || '').split(';').map((s) => s.trim());
  const parsed = stmts.map((s) => /^ON\(GET\((K|A|B|C|Z|D|wD)\),ADD\((\d*)(K|A|B|C|Z|D|wD)\)\)$/.exec(s));
  if (parsed.length < 2 || parsed.some((m) => !m)) return null;
  const stack = el('div', 'action-icons-stack');
  for (const m of parsed) {
    const [, trigger, count, gained] = m;
    const triggerNode = trigger === 'D' ? actionSuffix('色D') : trigger === 'wD' ? actionEmoji('🎲') : actionDot(trigger);
    stack.appendChild(actionRow([triggerNode, actionTrigger(), ...resourceItemNodes(count, gained)]));
  }
  return stack;
}

/** ON(BUILD(cats),ADD(nX)) for a plain resource X (K/A/B/C/Z) -- e.g. JOB002's TAP=
 * "ON(BUILD(),ADD(K))" (2026-08-04, per user feedback: "JOB002 TAP で ON(BUILD(),ADD(K))に変更しました"
 * with an explicit icon spec: "⚒️ ▶️ ⤵️K"). ⚒️ + the trigger categories (same letter-extraction as
 * buildBuildIcon) + ▶, ending in a normal resource-dot. Empty cats (BUILD() with no args, per
 * executor.js's eventArgsMatch: "match any category") shows no category suffix at all. The user's own
 * "⤵️K" is the ⚒️▶️-then-dot row shown here PLUS the ⤵️ TAP-source prefix buildEffectRow already prepends
 * automatically (not duplicated here). (2026-08-07: this used to exclude BZ, deferring to a sibling
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
  children.push(actionTrigger(), ...resourceItemNodes(match[2], match[3]));
  return actionRow(children);
}

/** MODIFY_CONVERT_VALUE(ANY,ANY,+n): a passive that adds n to every CHANGE's execution count
 * (2026-07-30, added for JOB008A) -- 🔄 (matching buildConvertLimitIcon's own "conversion" glyph) +
 * the signed delta. */
function buildModifyConvertValueIcon(actionText) {
  const match = /^MODIFY_CONVERT_VALUE\(ANY,ANY,([+-]\d+)\)$/.exec(actionText || '');
  if (!match) return null;
  return actionRow([actionEmoji('🔄'), actionSuffix(match[1])]);
}

/** @param {boolean} [stacked] - CON cards only (confirmed 2026-07-30, see gainIconRow): splits a
 * resource-granting ADD(...) icon into ⚡ on its own row, the resource(s) below it, instead of one
 * combined row. Has no effect on any other icon pattern (BUILD, dice-value, VP modifiers, etc.).
 * @returns {HTMLElement|null} an icon row, or null if actionText has no icon mapping yet */
function buildActionIcons(actionText, stacked) {
  const buildIcon = buildBuildIcon(actionText);
  if (buildIcon) return buildIcon;
  const addWdIcon = buildAddWdIcon(actionText);
  if (addWdIcon) return addWdIcon;
  const addResourceIcon = buildAddResourceIcon(actionText, stacked);
  if (addResourceIcon) return addResourceIcon;
  const addMultiResourceIcon = buildAddMultiResourceIcon(actionText, stacked);
  if (addMultiResourceIcon) return addMultiResourceIcon;
  const changeQuantityIcon = buildChangeQuantityIcon(actionText);
  if (changeQuantityIcon) return changeQuantityIcon;
  const changeToVpIcon = buildChangeToVpIcon(actionText);
  if (changeToVpIcon) return changeToVpIcon;
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

function renderDie(die) {
  const tpl = document.getElementById('tpl-die');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.classList.add(`die--${die.kind === 'WHITE' ? 'WHITE' : die.color}`);
  // Reverted 2026-07-29: die-face glyphs made the small colored dice harder to read, not easier --
  // back to a plain digit (unlike the board slot requirements / SET_DIE_VALUE icons, which keep the
  // ⚀-⚅ glyphs; this revert is specific to the actual player dice).
  node.querySelector('.die__value').textContent = die.value === null || die.value === undefined ? '' : die.value;
  return node;
}

function renderResourceBadge(resource, count) {
  // Confirmed 2026-07-29: the dot's color alone identifies the resource -- no letter label needed.
  const badge = el('span', 'resource-badge');
  badge.dataset.resource = resource;
  badge.title = resource; // still discoverable on hover/for accessibility, just not shown visually
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

function renderHeader(state) {
  document.getElementById('round-num').textContent = state.round;
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

/**
 * One row per effect (confirmed 2026-07-29: a card can have both an ONCE and a TAP effect, e.g.
 * B001A's ADD(wD) + SET_DIE_VALUE(SELF2|3), shown as two stacked rows). Flattens the icon builder's
 * own .action-icons wrapper into this row instead of nesting, so the TAP-cost prefix (if any) and
 * the effect's icons sit in a single flex row together.
 */
/** allowTextFallback=false (JOB/CON, confirmed 2026-07-30): returns null instead of a raw-DSL-text
 * row when no icon mapping exists, so the caller can omit that effect entirely (see fillCardFace).
 * stackGainIcon (CON only, confirmed 2026-07-30): see buildActionIcons/gainIconRow. */
function buildEffectRow(effect, allowTextFallback = true, stackGainIcon = false) {
  const icons = buildActionIcons(effect.text, stackGainIcon);
  if (!icons && !allowTextFallback) return null;
  // A stack (e.g. BUILD + the ADD(BZ) "軽減Z" line below it) keeps its rows separate instead of
  // being flattened into one -- the TAP-cost prefix only goes on the stack's first row.
  if (icons && icons.classList.contains('action-icons-stack')) {
    const rows = Array.from(icons.children);
    const firstRow = rows.shift();
    if (effect.source === 'TAP') firstRow.insertBefore(actionEmoji(TAP_COST_ICON), firstRow.firstChild);
    const wrapper = el('div', 'action-icons-stack');
    wrapper.appendChild(firstRow);
    rows.forEach((r) => wrapper.appendChild(r));
    return wrapper;
  }
  const row = el('div', 'action-icons');
  if (effect.source === 'TAP') row.appendChild(actionEmoji(TAP_COST_ICON));
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
function emblemForFaceId(faceId) {
  if (isNormalDeckCard(faceId)) return { [EMBLEM_BY_DECK[faceId[0]]]: 1 };
  if (!/^M\d/.test(faceId)) return null;
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
    for (const char of emblemChars(emblem)) {
      const charEl = el('span', 'shop-card__emblem-char', char);
      charEl.dataset.emblem = char;
      emblemEl.appendChild(charEl);
    }
  }

  const level = levelForFaceId(faceId);
  if (level) q('.shop-card__level').textContent = `LV${level}`;

  // Corrected 2026-07-29: the card id always stays in the id spot -- the ownership label goes in
  // the effect area instead (it *is* this card's effect, not a replacement for its identity).
  q('.shop-card__id').textContent = faceId;
  // Thematic title, at the top of the card, above the id (2026-08-05, per user feedback: "AC系のカード
  // NAMEをカード上部に反映させてください"). Empty (and :empty{display:none}-hidden) for any card whose
  // NAME hasn't been customized yet -- see factsForFaceId's own doc.
  q('.shop-card__name').textContent = facts.name;

  renderCostBadges(q('.shop-card__cost'), facts.cost, faceId);
  q('.shop-card__vp').textContent = facts.vp ? `${facts.vp} VP` : '';
  // Corrected 2026-07-29: a monument's req (e.g. "目 >=12") IS part of that specific card (each
  // monument has its own threshold), unlike normal/special cards' req which is a slot property --
  // so only monuments pass req here; everything else's req lives in the slot caption instead.
  q('.shop-card__req').textContent = options.req || '';
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
      q('.shop-card__effect').appendChild(document.createTextNode(effectText));
    }
  } else if (options.showEffect && facts.effects && facts.effects.length) {
    // allowTextFallback (confirmed 2026-07-30): A/B/C cards fall back to raw DSL text for any
    // pattern buildActionIcons doesn't recognize yet (established 2026-07-29). JOB/CON are new to
    // icon display and don't get that fallback -- an unmapped effect is just omitted (blank) rather
    // than showing raw DSL text, per instruction. See [[project-dice-wp-ui-requirements]].
    const allowTextFallback = options.allowTextFallback !== false;
    // stackGainIcon (confirmed 2026-07-30, per user feedback: "CONカードの効果をアイコンで上に、その
    // 下にもらえる資源というふうにして") -- CON cards only; every other card type keeps the combined
    // single-row "⚡ + resource" display (see gainIconRow).
    const stackGainIcon = /^CON\d/.test(faceId);
    const rows = facts.effects
      .map((effect) => buildEffectRow(effect, allowTextFallback, stackGainIcon))
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

function buildCardVisual(faceId, options = {}) {
  const tpl = document.getElementById('tpl-shop-card');
  const node = tpl.content.firstElementChild.cloneNode(true);

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
      showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null);
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
 * computePlayerBuildStats/mockCostTotal/mockCardCount below, anywhere "built" cards are counted or
 * summed. */
function isBuiltCardPhysicalId(physicalId) {
  return isNormalDeckCard(physicalId) || physicalId.startsWith('M');
}

// ---------------------------------------------------------------------------
// QST (Quest) cards (confirmed 2026-07-30, see [[project-dice-wp-ui-requirements]] and src/qst.js
// for the real engine-side implementation -- claiming is wired to qst.js's claimQuestReward, see the
// dblclick handler in buildQstCardVisual below).
// ---------------------------------------------------------------------------

/** Cards counted for a mock "CARD_COUNT" / "CARD_COUNT(sheet)" GOAL check -- same A/B/C/M scope as
 * the real engine's CARD_COUNT_SHEETS (see isBuiltCardPhysicalId). sheet=null/undefined = no filter
 * (bare CARD_COUNT). Deliberately a small parallel implementation (like computeNextCastleTurnOrder
 * above), not the real DSL parser -- good enough for the mock's demo GOAL text, not a general
 * evaluator. */
function mockCardCount(state, playerId, sheet) {
  const player = state.players.find((p) => p.id === playerId);
  return player.ownedCardPhysicalIds.filter((physicalId) => {
    if (!isBuiltCardPhysicalId(physicalId)) return false;
    return !sheet || physicalId.startsWith(sheet);
  }).length;
}

/** Mock counterpart of executor.js's evalMetric -- covers every metric currently used by a real GOAL
 * cell (confirmed 2026-07-30), reusing computePlayerBuildStats' already-aggregated emblemCounts/lv1/
 * lv2 where possible rather than re-scanning owned cards per metric. Returns null for an unknown
 * metric name (goalMet then treats the GOAL as never met, same as missing/blank GOAL text). */
function mockEvalMetric(state, playerId, metricName, arg) {
  const player = state.players.find((p) => p.id === playerId);
  const buildStats = computePlayerBuildStats(player, state);
  switch (metricName) {
    case 'CARD_COUNT': return mockCardCount(state, playerId, arg);
    case 'LEVEL_COUNT': return arg === '1' ? buildStats.lv1 : arg === '2' ? buildStats.lv2 : 0;
    case 'EMBLEM_COUNT':
    case 'COUNT': return buildStats.emblemCounts[arg] || 0;
    case 'EMBLEM_SET_COUNT': return Math.min(buildStats.emblemCounts.天, buildStats.emblemCounts.地, buildStats.emblemCounts.人);
    case 'MAX_EMBLEM_COUNT': return Math.max(buildStats.emblemCounts.天, buildStats.emblemCounts.地, buildStats.emblemCounts.人);
    case 'TOTAL_EMBLEM_COUNT': return buildStats.emblemCounts.天 + buildStats.emblemCounts.地 + buildStats.emblemCounts.人;
    case 'COST_TOTAL': return mockCostTotal(state, player);
    case 'RESOURCE': return player.resources[arg] || 0;
    default: return null;
  }
}

/** Which claim slot (0/1/2, matching qst.js's REWARD_FIELDS index -- claimCount at the time of
 * claiming) belongs to which visual row (2026-08-06, per user feedback on the REWARD2/REWARD3 merge:
 * "REWARD1 ←次に...は消す　①◯　②③2◯のように表記" -- slot 0 (REWARD1) gets its own row+mark, slots 1
 * and 2 (both drawing from the shared REWARD2-3 field) sit in one row with 2 independent marks, since
 * each is still claimed by a different player at a possibly different time even though the reward
 * text is identical). */
const QST_REWARD_RANK_LABELS = ['1位', '2〜3位'];

/** The "目標：..." line from a QST card's INST text, in place of GOAL's raw DSL (e.g. "CARD_COUNT>=7")
 * -- 2026-08-06, per user feedback: "とりあえず今回はINSTに書かれていることを流用して" (reusing the
 * human-readable line already written at the top of INST, rather than inventing a new icon per GOAL
 * metric). Falls back to the raw DSL text if INST is missing/doesn't start with this convention, so
 * nothing goes blank for data that hasn't adopted it. */
function questGoalDisplayText(facts) {
  const firstLine = (facts.inst || '').split('\n')[0];
  return firstLine.startsWith('目標') ? firstLine : facts.goal;
}

/** Splits questGoalDisplayText's "目標：{item}　{qty}" line into the item/qty pair for the QST card's
 * 3-line GOAL block (2026-08-06, per user feedback: "目標／建築数／6枚" 3-line layout) -- split at the
 * LAST run of whitespace, which is where every real GOAL line's trailing quantity sits (e.g. "建築数
 * 　7枚" -> item "建築数", qty "7枚"). A line with no whitespace at all (shouldn't happen in practice)
 * just becomes the item with a blank qty line. */
function questGoalLines(facts) {
  const text = questGoalDisplayText(facts);
  const body = text.startsWith('目標') ? text.replace(/^目標[：:]/, '') : text;
  const match = /^(.*?)[ 　]+(\S+)$/.exec(body.trim());
  return match ? { item: match[1], qty: match[2] } : { item: body.trim(), qty: '' };
}

/** Plain-text reward summary for QST's 3-line REWARD block (2026-08-06, per user feedback: "1位
 * 2K"/"2〜3位 K" style, replacing the ◯/● claim marks added earlier the same day -- confirmed via
 * AskUserQuestion: value text only, no marks). Every QST row's REWARD1/REWARD2-3 cell is a bare
 * ADD(...), so no need for the full DSL parser here -- e.g. "ADD(2K)" -> "2K", "ADD(2K,BZ)" ->
 * "2K+BZ". Falls back to the raw cell text for anything that isn't a bare ADD(...). */
function questRewardValueText(rewardDsl) {
  const match = /^ADD\((.*)\)$/.exec((rewardDsl || '').trim());
  return match ? match[1].replace(/,/g, '+') : (rewardDsl || '');
}

/** One REWARD line: a rank label plus its plain-text reward value (2026-08-06, replacing the old
 * ①/②③ ◯/● claim-mark rows -- per user feedback's "1位　2K" / "2〜3位　K" 3-line format). rewardDsl is
 * facts.rewards[0] (REWARD1) for '1位' or facts.rewards[1] (the shared REWARD2-3) for '2〜3位'. */
function buildQstRewardLine(label, rewardDsl) {
  return el('div', 'qst-card__reward-line', `${label}　${questRewardValueText(rewardDsl)}`);
}

/** Static preview fill for QST's back face (the sibling face -- see siblingFaceId): id + GOAL +
 * plain REWARD1/REWARD2-3 labels, no claim status. There's no live quest state for a face that was
 * never actually revealed this game, so this is informational only (matches CON/A/B/C's click-to-flip
 * preview, which is likewise just "what's on the other side", not live state). Kept as the fuller
 * REWARDn-label form (unlike the front face's ①/②③ marks below) since there's no claim progress to
 * mark here anyway. */
function fillQstBackFace(backEl, faceId) {
  const facts = factsForQstFaceId(faceId);
  backEl.querySelector('.qst-card__id').textContent = faceId;
  backEl.querySelector('.qst-card__goal').textContent = facts.goal;
  const rewardsEl = backEl.querySelector('.qst-card__back-rewards');
  rewardsEl.appendChild(el('div', 'qst-card__reward', 'REWARD1'));
  rewardsEl.appendChild(el('div', 'qst-card__reward', 'REWARD2-3'));
}

/** Builds one QST card's visual: a 3-line GOAL block ("目標" / item / qty) and a 3-line REWARD block
 * ("報酬" / "1位 {value}" / "2〜3位 {value}") plus the COMPLETE badge (2026-08-06, per user feedback:
 * "目標／建築数／6枚" and "報酬／1位　2K／2〜3位　1K" 3-line layouts, replacing the single-line GOAL text
 * and the ①/②③ ◯/● claim-mark rows from earlier the same day -- confirmed via AskUserQuestion that the
 * landscape goal|rewards column layout stays, just each column's *content* becomes 3 stacked lines, and
 * that REWARD shows plain value text with no claim marks). See questGoalLines/buildQstRewardLine.
 * Distinct DOM shape from buildCardVisual's shop-card (this layout doesn't fit that template), but
 * still reuses showCardEnlargeModal for the tap-to-enlarge description. */
function buildQstCardVisual(faceId, quest, state, options = {}) {
  const tpl = document.getElementById('tpl-qst-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const facts = factsForQstFaceId(faceId);
  const complete = quest.claimCount >= facts.rewards.length;

  // Glows/blinks once GOAL is achieved and actually claimable right now (2026-08-06, per user
  // feedback: "GOAL達成している状態の時光って点滅するようにする") -- reuses the real engine's
  // canClaim (not the UI's own mockEvalMetric preview stuff above) so this can never drift from
  // whether tapping the ①/②③ marks below would really succeed. Evaluated for whoever's actually up
  // (matches the reward click handler's own activePlayer, since claiming is a free action gated to
  // the active player) -- no glow while it's an AI's turn or nobody's onboarded yet, same as that
  // handler's own no-op guard.
  const next = turnFlowMod.getNextTurn(state, INDEX);
  const activePlayer = next ? state.players.find((p) => p.id === next.playerId) : null;
  const claimable = !!activePlayer && hasFinishedOnboarding(activePlayer)
    && qstMod.canClaim(state, INDEX, activePlayer.id, faceId).ok;

  const goalEl = node.querySelector(':scope > .qst-card__row > .qst-card__goal');
  const goalLines = questGoalLines(facts);
  goalEl.appendChild(el('div', 'qst-card__goal-header', '目標'));
  goalEl.appendChild(el('div', 'qst-card__goal-item', goalLines.item));
  goalEl.appendChild(el('div', 'qst-card__goal-qty', goalLines.qty));
  node.classList.toggle('qst-card--complete', complete);
  node.classList.toggle('qst-card--claimable', claimable);

  const rewardsEl = node.querySelector(':scope > .qst-card__rewards');
  rewardsEl.appendChild(el('div', 'qst-card__reward-header', '報酬'));
  rewardsEl.appendChild(buildQstRewardLine(QST_REWARD_RANK_LABELS[0], facts.rewards[0]));
  rewardsEl.appendChild(buildQstRewardLine(QST_REWARD_RANK_LABELS[1], facts.rewards[1]));

  // Sibling-face preview (Q001A <-> Q001B) baked into the back element, same mechanism as every
  // other card type -- see siblingFaceId/fillQstBackFace. Falls back to a plain blank back when
  // there's no data for the sibling yet. Flipping to see it is now done from inside the enlarge
  // modal (toggling qst-card--flipped there), not via a click on the inline card itself -- see below.
  const backEl = node.querySelector(':scope > .qst-card__back');
  const sibling = siblingFaceId(faceId);
  const hasSiblingData = sibling && qstFaceExists(sibling);
  if (hasSiblingData) {
    backEl.classList.add('qst-card__back--face');
    fillQstBackFace(backEl, sibling);
  }

  // Unified single-tap model (2026-08-0X, replaces click=flip/right-click=INST/dblclick=claim --
  // same rationale as buildCardVisual's rewrite: iPad has no right-click or reliable dblclick). A tap
  // anywhere on the card opens the enlarge modal (bigger visual + INST + a 裏側 flip button). The
  // REWARD1-3 checklist carves out its own higher-priority tap zone that claims the next reward
  // instead, mirroring how a card's TAP effect box works in attachTapToggle -- stopPropagation() keeps
  // this card-wide listener from also firing underneath it.
  if (!options.noInteraction) {
    node.addEventListener('click', () => {
      const visualNode = buildQstCardVisual(faceId, quest, state, { noInteraction: true });
      showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null);
    });

    // Claims the next reward as a free action, if GOAL is met (confirmed 2026-07-30). No TAP/UNTAP
    // state -- claimedPlayers/qstRewardCount already make this a use-once action per (player, card),
    // so unlike the 6 tap-based free actions there's nothing to reset each round. Always claims
    // against the real (front) face -- there's no live quest state for a sibling never actually
    // revealed this game. Routed through qst.js's real engine (canClaim/claimQuestReward), same as
    // every other real-turn action -- see renderBuildChoiceModal for the BUILD-reward half of this (a
    // QST reward can itself be BUILD(...)).
    rewardsEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = turnFlowMod.getNextTurn(STATE, INDEX);
      const activePlayer = next ? state.players.find((p) => p.id === next.playerId) : null;
      if (!activePlayer || !hasFinishedOnboarding(activePlayer)) return; // matches other free-action gating
      if (pendingBuildChoice) return; // a BUILD choice is already pending -- resolve that first
      const result = qstMod.claimQuestReward(STATE, INDEX, { playerId: activePlayer.id }, faceId);
      if (result.success && result.pendingBuild) {
        pendingBuildChoice = { source: 'QST', playerId: activePlayer.id, ...result.pendingBuild };
        buildColorPreference = {};
        pendingBzOutcomeChoice = null;
      }
      // Any other failure (GOAL_NOT_MET/COMPLETE/ALREADY_CLAIMED/PLAYER_LIMIT_REACHED/NO_BUILDABLE_CARD)
      // is a silent no-op, same as the ineligibility checks this replaced.
      render(STATE);
    });
  }

  return node;
}

function renderQsts(state) {
  const container = document.getElementById('qst-slots');
  container.innerHTML = '';
  for (const [faceId, quest] of Object.entries(state.quests)) {
    container.appendChild(buildQstCardVisual(faceId, quest, state));
  }
}

/**
 * The dice-value requirement (e.g. "目 1-6") is not part of a card's effect (confirmed 2026-07-29:
 * it's a property of the shop slot, not the card), so it's rendered outside the card box entirely,
 * in a caption below it -- see tpl-shop-slot. showReqCaption (true for M/NORMAL, false for SPECIAL)
 * controls whether shopReqForSlotId's caption is shown at all -- factsForFaceId's own .req still
 * covers monuments (their req travels with the card, not a fixed per-slot lookup). See renderShopGrid
 * for why SPECIAL passes false (SHOP201-203 sit directly under a NORMAL column with the identical
 * requirement already shown there).
 */
function buildShopSlotNode(slotId, faceId, showReqCaption) {
  const slotTpl = document.getElementById('tpl-shop-slot');
  const slotNode = slotTpl.content.firstElementChild.cloneNode(true);
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
    slotNode.querySelector('.shop-slot__req').textContent = showReqCaption ? shopReqForSlotId(slotId) : '';
    slotNode.querySelector('.shop-slot__card').appendChild(buildCardVisual(faceId, { showEffect: true }));
  }
  return slotNode;
}

// SHOP001-006 (monuments), SHOP101-106 (normal), and SHOP201-203 (special) all share one 6-column
// grid now (confirmed 2026-07-30, revised from separate rows): row1=monuments, row2=normal cards
// (both auto-placed, 6 items fill 6 columns exactly, no explicit placement needed), row3=special --
// SHOP201/202/203 sit directly under SHOP101/103/105 (same DICE_MIN/MAX pair -- SHOP101/SHOP201 are
// both "目1-6", SHOP103/SHOP202 both "目1-4", SHOP105/SHOP203 both "目1-2", see data/game.json's
// SHOP sheet), so those 3 get an explicit grid-column/grid-row; the other 3 cells in row3 stay empty.
const SPECIAL_SLOT_GRID_COLUMN = { SHOP201: 1, SHOP202: 3, SHOP203: 5 };

function renderShopGrid(state) {
  const container = document.getElementById('shop-combined-slots');
  container.innerHTML = '';
  for (const [slotId, faceId] of Object.entries(state.shops.M.slots)) {
    container.appendChild(buildShopSlotNode(slotId, faceId, true));
  }
  for (const [slotId, faceId] of Object.entries(state.shops.NORMAL.slots)) {
    container.appendChild(buildShopSlotNode(slotId, faceId, true));
  }
  for (const [slotId, faceId] of Object.entries(state.shops.SPECIAL.slots)) {
    const node = buildShopSlotNode(slotId, faceId, false); // no req caption -- see buildShopSlotNode
    node.style.gridColumn = String(SPECIAL_SLOT_GRID_COLUMN[slotId]);
    node.style.gridRow = '3';
    container.appendChild(node);
  }
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
      if (highlightOwner && selectedDieIds.length === 1) {
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
          // A slot can hold more than one die -- now only ever via GRANT_PLACE_ANYWHERE joining an
          // already-occupied slot (2026-08-06: the castle/AREA009's own same-value auto-stacking is
          // abolished, see board.js's slotAcceptsValue). Which one displays depends on the AREA
          // (2026-08-06, per user feedback): everywhere except 王宮 shows the newest (matches the
          // pre-existing 2026-07-30 "just show the topmost, no offset" convention), but at 王宮
          // specifically the display stays on the *original* die -- newly GRANT_PLACE_ANYWHERE'd dice
          // join underneath without disturbing what's shown (confirmed: they don't count toward next
          // round's turn order either, board.js's countsForTurnOrder). occupants[0] is always that
          // original die at 王宮, since (per the same rule) nothing can join an occupied slot there
          // without GRANT_PLACE_ANYWHERE in the first place.
          slotEl.classList.add('slot--filled');
          const stack = el('div', 'slot__stack');
          const topOccupant = isCastle ? occupants[0] : occupants[occupants.length - 1];
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
        // see attemptPlaceSelectedDie's own branch.
        if (selectedDieIds.length > 0) {
          slotEl.classList.add('slot--selectable');
          slotEl.addEventListener('click', () => attemptPlaceSelectedDie(state, mapId, i));
        }
        // Genuinely placeable right now (see highlightedSlots above) -- a stronger glow than the plain
        // "you can try clicking here" .slot--selectable affordance every slot gets while any die is
        // selected, regardless of whether it would actually work.
        if (highlightedSlots && highlightedSlots.has(i)) slotEl.classList.add('slot--highlight');
        slotsEl.appendChild(slotEl);
      });

      // Castle-only: current round's turn order above the slots, recomputed next-round order below
      // (see computeNextCastleTurnOrder -- it reacts to whatever's currently placed on the castle).
      if (isCastle) {
        fillTurnOrderRow(node.querySelector('.map-tile__turnorder--current'), '現在', state.turnOrder, state);
        fillTurnOrderRow(node.querySelector('.map-tile__turnorder--next'), '次', computeNextCastleTurnOrder(state), state);
      }

      const actionEl = node.querySelector('.map-tile__action');
      const icons = buildActionIcons(action);
      if (icons) {
        actionEl.appendChild(icons);
      } else {
        actionEl.textContent = action;
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
 * attemptPlaceSelectedDie needs to pause for CON002B's payment-choice prompt before placing. */
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
 * directly -- see areaColorPayResources) and the player has both CON002B and some Z on hand, pauses
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
  const result = boardMod.placeDice(state, INDEX, { playerId: player.id, colorPreference }, dieId, mapId, slotIndex);
  selectedDieIds = [];
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
  selectedDieIds = [];
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieIds[0]));
  const result = boardMod.placeDiceGroup(state, INDEX, { playerId: player.id }, dieIds, mapId);
  applyPlaceDiceResult(result, player.id);
  render(STATE);
}

/** Declines to place the currently-selected die at all this round (2026-08-03, per user feedback:
 * "色ダイスを置けない時、または起きたくない時ラウンドをパスする手段がありません") -- see
 * board.passDie's own doc for what this actually does to the die (excluded from turn-flow's "still
 * needs an action" checks, but still gets endRound's unused-color-die 3K same as a genuinely-unplaced
 * one). Mirrors placeSelectedDie's own turnActionTaken handling exactly (fulfils the same
 * once-per-turn placement-or-pass obligation). */
function passSelectedDie(state) {
  const dieId = selectedDieIds[0];
  const player = state.players.find((p) => p.dice.some((d) => d.id === dieId));
  const result = boardMod.passDie(state, INDEX, { playerId: player.id }, dieId);
  selectedDieIds = [];
  if (!result.success) {
    placementMessage = `パスできません（${result.reason}）`;
  } else {
    placementMessage = '';
    turnActionTaken = true;
  }
  render(STATE);
}

/** "パス" button (2026-08-03) -- shown only once EXACTLY one die is selected (mirrors the "select a
 * die, then either click a slot or pass" flow; 2026-08-02: passing doesn't make sense for a multi-die
 * monument selection, so this hides once a 2nd die joins it), and only for the player whose real TURN
 * it currently is (canAct, same gate as renderFreeActionButtons). */
function renderPassDieButton(container, state, player, canAct) {
  container.innerHTML = '';
  if (!canAct || selectedDieIds.length !== 1) return;
  if (!player.dice.some((d) => d.id === selectedDieIds[0])) return;
  const btn = el('button', 'pass-die-button', 'このダイスをパス');
  btn.type = 'button';
  btn.addEventListener('click', () => passSelectedDie(state));
  container.appendChild(btn);
}

/**
 * Whatever RESOURCE_LIMIT/FORCE_CONVERT TURNEND rules ending playerId's turn *right now* would
 * actually trigger (2026-08-01, per user feedback: the data's WARNING/"はい・いいえ" text was always
 * auto-confirmed as "はい" -- see attemptAdvanceTurn, the gate this feeds). Each owned card's TURNEND
 * is checked the same way executor.applyTurnEnd itself would apply it, just without mutating anything
 * yet. REPLACE_ADD (CON002A) has the same WARNING pattern but is NOT covered here -- it fires the
 * moment a would-be ADD(D) is about to run (mid-action, not at TURNEND), and the only DSL cell in the
 * whole dataset that grants a bare D is CON001B's ONCE=ADD(D); since each player has exactly one CON
 * card, no player can ever own both CON001B and CON002A at once, so REPLACE_ADD's WARNING is
 * structurally unreachable with the current data and isn't wired up (would need a real trigger point
 * to test against).
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
      if (cmd.type === 'RESOURCE_LIMIT' && (player.resources[cmd.resource] || 0) > cmd.limit) {
        warnings.push({ physicalId, warningText: row.WARNING, kind: 'RESOURCE_LIMIT' });
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
    // USAGE_FEE entry (2026-08-04, see PlayerState.pendingFee) -- message picks whichever is actually
    // blocking, favoring the fee (rarer, more specific) since a player who owes a fee wants to be told
    // that, not a generic "resources over the limit" line that doesn't mention K at all.
    const feeViolation = result.violations.find((v) => v.type === 'USAGE_FEE');
    placementMessage = feeViolation
      ? `ターンを終了できません（使用料${feeViolation.amount}Kを支払えません。フリーアクションで資源を増やしてください）`
      : 'ターンを終了できません（資源の合計が上限を超えています。フリーアクションで資源を減らしてください）';
    pendingTurnEndPlayerId = playerId;
    return;
  }
  pendingTurnEndPlayerId = null;
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

/** CON002B's "real or Z" payment-preference toggle (2026-07-31, see [[project-dice-wp-dsl-spec]]'s
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
  container.appendChild(el('span', 'build-choice-payment__label', 'CON002B: 支払いに使う資源を選択'));
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
 * point (QST vs AREA/TAP commit, success/failure bookkeeping) is identical either way. */
function commitBuildCandidate(candidate, bzDiscount) {
  const playerId = pendingBuildChoice.playerId;
  const context = { playerId, colorPreference: buildColorPreference, bzDiscount };
  // QST rewards and a card's own bare TAP=BUILD(...) (see attachTapToggle/bareTapKind) both reuse
  // this same modal but commit via qst.completeQuestClaim / a plain completeAreaBuild + manual
  // tap respectively, and never advance the turn -- both are free-action-timed, not a die
  // placement (only an AREA-triggered BUILD, from an actual die placement, ends the turn).
  const result = pendingBuildChoice.source === 'QST'
    ? qstMod.completeQuestClaim(STATE, INDEX, context, pendingBuildChoice, candidate)
    : boardMod.completeAreaBuild(STATE, INDEX, context, candidate, pendingBuildChoice.remainingCommands);
  // Only close the modal on success -- e.g. INSUFFICIENT_RESOURCES (can't afford this candidate's
  // COST) must NOT silently dismiss the choice, since the die/build trigger already happened and
  // is not undoable from here; the player needs to try an affordable candidate instead.
  if (result.success) {
    const source = pendingBuildChoice.source;
    if (source === 'TAP') STATE.cards[pendingBuildChoice.physicalId].tapped = true;
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
  const affordableCandidates = pendingBuildChoice.candidates.filter((c) => candidateAffordable(c, pendingBuildChoice.playerId));
  if (affordableCandidates.length === 0) {
    list.appendChild(el('div', 'build-choice-empty', '今支払える資源では建築できるカードがありません'));
  }
  for (const candidate of affordableCandidates) {
    const faceId = candidate.type === 'UPGRADE' ? candidate.toFaceId : candidate.faceId;
    const cardNode = buildCardVisual(faceId, { showEffect: true, noInteraction: true });
    const tall = cardNode.classList.contains('shop-card--tall');
    const wrapper = el('div', 'build-choice-item');
    if (candidate.type === 'UPGRADE') wrapper.appendChild(el('div', 'build-choice-label', 'アップグレード'));
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
    list.appendChild(wrapper);
  }
}

/** CON002B's payment-choice prompt for an AREA that pays A/B/C directly (see
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

/** Die+value choice for a bare TAP ability (SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE, see
 * attachTapToggle/bareTapKind) -- board.useBareTapAbility needs chosenDieId plus chosenValue (SET_*)
 * or chosenDelta (CHANGE_DIE_VALUE) supplied *before* it runs the TAP field (the whole field is one
 * atomic program, so there's no mid-run prompt). Confirm is disabled until both a die and a value are
 * picked. Cancelable -- nothing committed yet. */
function renderTapChoiceModal() {
  const overlay = document.getElementById('tap-choice-overlay');
  if (!pendingTapChoice) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const { playerId, dieId, value, bareTap } = pendingTapChoice;
  const player = STATE.players.find((p) => p.id === playerId);

  const diceEl = document.getElementById('tap-choice-dice');
  diceEl.innerHTML = '';
  for (const die of player.dice.filter((d) => d.placedMapId === null)) {
    const dieNode = renderDie({ ...die, color: player.color });
    dieNode.classList.add('die--selectable');
    dieNode.classList.toggle('die--selected', die.id === dieId);
    dieNode.addEventListener('click', () => { pendingTapChoice.dieId = die.id; render(STATE); });
    diceEl.appendChild(dieNode);
  }

  const valuesEl = document.getElementById('tap-choice-values');
  valuesEl.innerHTML = '';
  const valueOptions = bareTap.kind === 'SET_DICE_ANY' ? [1, 2, 3, 4, 5, 6] : bareTap.choices;
  for (const option of valueOptions) {
    const label = bareTap.kind === 'CHANGE_DIE_VALUE' ? (option > 0 ? `+${option}` : `${option}`) : `${option}`;
    const btn = el('button', 'build-choice-payment__option', label);
    btn.type = 'button';
    btn.classList.toggle('build-choice-payment__option--active', option === value);
    btn.addEventListener('click', () => { pendingTapChoice.value = option; render(STATE); });
    valuesEl.appendChild(btn);
  }

  document.getElementById('tap-choice-confirm').disabled = dieId === null || value === null;
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
    // as a resource" pool that ADD(VP) grants into (only B008B's ONCE does this in the current data), NOT
    // a monument/card's own printed VP column (only tallied at GAME_END via scoring.computeFinalScore).
    // A player who'd just built a 5-VP monument saw this badge stuck at "0 VP" the whole game, which read
    // as broken even though it was working as originally scoped. computeFinalScore already sums exactly
    // what GAME_END shows (owned cards' printed VP + resources.VP + active VP_MODIFIERs) and is state-only
    // (no side effects), so it's safe to call every render, not just at GAME_END.
    node.querySelector('.player-panel__score').textContent = `${scoringMod.computeFinalScore(state, INDEX, player.id)} 点`;

    const resourcesEl = node.querySelector('.player-panel__resources');
    // VP itself still shows as an ordinary resource badge (2026-08-04) now that the header badge above
    // shows the combined score instead of the raw resource -- otherwise a player who actually held VP as
    // a resource (via B008B) would have no way to see that raw count anymore.
    for (const resource of ['K', 'A', 'B', 'C', 'Z', 'BZ', 'VP']) {
      const count = player.resources[resource] || 0;
      if (count > 0) resourcesEl.appendChild(renderResourceBadge(resource, count));
    }

    // Split into two rows -- color dice and wD (confirmed 2026-07-30) -- rather than one mixed row.
    const colorDiceEl = node.querySelector('.player-panel__dice-row--color');
    const whiteDiceEl = node.querySelector('.player-panel__dice-row--white');
    for (const die of player.dice) {
      if (die.placedMapId) continue; // dice on the board are shown on the board, not in-hand
      const rowEl = die.kind === 'WHITE' ? whiteDiceEl : colorDiceEl;
      const dieNode = renderDie({ ...die, color: player.color });
      // Passed (2026-08-03, see board.passDie) -- stays visible in hand so it's clear where it went,
      // but not selectable again until next round's reset.
      if (die.passed) dieNode.classList.add('die--passed');
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
          } else if (selectedDieIds.length === 0) {
            selectedDieIds.push(die.id);
          } else {
            const prospectiveValues = [...selectedDieIds, die.id].map((id) => player.dice.find((d) => d.id === id).value);
            if (!hasQualifyingProperSubset(prospectiveValues, 12)) selectedDieIds.push(die.id);
          }
          render(STATE);
        });
      }
      rowEl.appendChild(dieNode);
    }

    renderPassDieButton(node.querySelector('.player-panel__pass-die'), state, player, player.id === canPlaceDiceFor);
    renderFreeActionButtons(node.querySelector('.player-panel__free-actions'), state, player, player.id === canPlaceDiceFor);
    renderTapReactions(node.querySelector('.player-panel__tap-reactions'), state, player.id);
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

/** A/B/C/Z->K and wD->2K (2026-07-30, real engine wiring pass 5; corrected 2026-08-02) -- confirmed via
 * [[project-dice-wp-dsl-spec]]: usable anytime during the player's own turn, with NO usage limit at
 * all ("回数制限ありません") -- same as usage-fee collection since 2026-08-06 (see executor.collectUsageFee),
 * though that one lives on the map tile itself, not this button row. Only rendered for the player whose
 * real TURN it currently is (canAct); unaffordable actions are still shown -- clicking one you can't
 * pay for just surfaces INSUFFICIENT_RESOURCES via placementMessage, same pattern as dice
 * placement/BUILD selection elsewhere in this file, rather than being pre-validated away. */
const FREE_ACTION_LABELS = { A_K: 'A→K', B_K: 'B→K', C_K: 'C→K', Z_K: 'Z→K', wD_K: '🎲→2K' };
function renderFreeActionButtons(container, state, player, canAct) {
  container.innerHTML = '';
  if (!canAct) return;
  for (const freeActionId of ['A_K', 'B_K', 'C_K', 'Z_K', 'wD_K']) {
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
 * via the TAP_REACTION_AVAILABLE pendingChoice rows/renderTapReactions, never this dblclick). Real
 * data currently only ever has a die-selecting command (SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE)
 * or a bare BUILD as the *first* statement, never mixed with something else first, so only the first
 * statement's type needs checking to pick the right UI path in attachTapToggle.
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
  if (first.type === 'BUILD') return { kind: 'BUILD' };
  return { kind: 'IMMEDIATE' };
}

/** Whether faceId's TAP field is purely ON(...)-wrapped -- a reactive ability with an auto/manual
 * setting worth choosing (see executor.isCardAutoMode/setCardAutoMode), the opposite case from
 * bareTapKind. false for no TAP field, or a bare (direct-use) one instead -- those have no auto/manual
 * concept at all (the player just uses them or doesn't, there's no "does this auto-fire" question). */
function reactiveTapKind(faceId) {
  let row;
  try { row = dataLoaderMod.getCardRow(INDEX, faceId); } catch (e) { return false; }
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
    // Blocked while a usage fee is owed (2026-08-05, see board.useBareTapAbility's own doc on the
    // softlock this prevents) -- checked here too (not just left to useBareTapAbility's own rejection
    // once confirmed) so the SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE kind's die/value picker modal
    // doesn't even open for something that's just going to fail anyway.
    const owner = STATE.players.find((p) => p.id === cardState.ownerId);
    if (owner && owner.pendingFee) {
      placementMessage = 'カードを使用できません（PENDING_FEE）';
      render(STATE);
      return;
    }
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
      } else {
        placementMessage = `カードを使用できません（${result.reason}）`;
      }
    } else {
      pendingTapChoice = { physicalId, playerId: cardState.ownerId, bareTap, dieId: null, value: null };
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
    showCardEnlargeModal(faceId, visualNode, hasSiblingData ? sibling : null, pickAction);
  });
}

/** Built-card breakdown for the card-group header stats row (confirmed 2026-07-30): total built
 * (A/B/C + M -- JOB/CON/RESOURCE are all owned but never "built" via BUILD, so excluded, same
 * CARD_COUNT scope as the engine's own DSL semantics, see [[project-dice-wp-dsl-spec]] and
 * isBuiltCardPhysicalId), LV1/LV2 sub-counts (A/B/C only -- monuments have no LEVEL), monument count,
 * and EMBLEM_COUNT-style totals across both A/B/C (deck-level emblem) and monuments (each has its own
 * individual emblem). */
function computePlayerBuildStats(player, state) {
  let built = 0, lv1 = 0, lv2 = 0, monuments = 0;
  const emblemCounts = { 天: 0, 地: 0, 人: 0 };
  for (const physicalId of player.ownedCardPhysicalIds) {
    if (!isBuiltCardPhysicalId(physicalId)) continue;
    const cardState = state.cards[physicalId];
    if (!cardState) continue;
    const faceId = cardState.currentFaceId;
    built++;
    if (isNormalDeckCard(physicalId)) {
      const level = levelForFaceId(faceId);
      if (level === 1) lv1++;
      else if (level === 2) lv2++;
    } else if (physicalId.startsWith('M')) {
      monuments++;
    }
    // A monument can carry 0-3 emblems, each type possibly repeated (confirmed 2026-07-30, see
    // emblemForFaceId) -- every one counts separately, same as if the card had that many individual
    // emblems (matches the engine's own EMBLEM_COUNT, see src/executor.js's emblemCountsForRow).
    const emblem = emblemForFaceId(faceId);
    if (emblem) {
      for (const char of emblemChars(emblem)) {
        if (char in emblemCounts) emblemCounts[char]++;
      }
    }
  }
  return { built, lv1, lv2, monuments, emblemCounts };
}

/** Sum of every owned *built* card's printed COST, across resource types (mock counterpart of
 * executor.js's COST_TOTAL metric, confirmed 2026-07-30 -- "今建築されているカードの資源合計"; the
 * real engine doesn't need an explicit isBuiltCardPhysicalId filter here since JOB/CON/RESOURCE rows
 * always have a blank COST anyway, but this mirrors it explicitly for clarity). Reuses the same
 * cost-string parsing as renderCostBadges for consistency. */
function mockCostTotal(state, player) {
  let total = 0;
  for (const physicalId of player.ownedCardPhysicalIds) {
    if (!isBuiltCardPhysicalId(physicalId)) continue;
    const cardState = state.cards[physicalId];
    if (!cardState) continue;
    const costString = factsForFaceId(cardState.currentFaceId).cost || '';
    for (const part of costString.split(',')) {
      const match = /^(\d*)([A-Z]+)$/.exec(part.trim());
      if (match) total += match[1] ? Number(match[1]) : 1;
    }
  }
  return total;
}

/** Extra stats shown alongside the defaults only when a currently-revealed QST card's GOAL actually
 * references that metric (confirmed 2026-07-30) -- 建築数/LV1/LV2/天/地/人 already cover CARD_COUNT/
 * LEVEL_COUNT/EMBLEM_COUNT/EMBLEM_SET_COUNT implicitly (a QST needing those doesn't need a new stat),
 * so only the 3 metrics with no existing on-screen equivalent get one here. Mirrors the engine's own
 * MAX_EMBLEM_COUNT/TOTAL_EMBLEM_COUNT/COST_TOTAL metrics (src/executor.js), computed here from the
 * same buildStats.emblemCounts computePlayerBuildStats already produces. */
const QST_EXTRA_STAT_DEFS = {
  MAX_EMBLEM_COUNT: { label: '最大EMBLEM数', compute: (state, player, buildStats) => Math.max(buildStats.emblemCounts.天, buildStats.emblemCounts.地, buildStats.emblemCounts.人) },
  TOTAL_EMBLEM_COUNT: { label: 'EMBLEM合計', compute: (state, player, buildStats) => buildStats.emblemCounts.天 + buildStats.emblemCounts.地 + buildStats.emblemCounts.人 },
  COST_TOTAL: { label: '資源合計', compute: (state, player) => mockCostTotal(state, player) },
};

/** The leading metric name of every currently-revealed QST card's GOAL text (e.g. "CARD_COUNT" out
 * of "CARD_COUNT>=7") -- same bare-comparison shape confirmed for real GOAL data, see
 * [[project-dice-wp-qst-spec]]. Cards with no GOAL yet or no data contribute nothing. */
function activeQstMetricNames(state) {
  const names = new Set();
  for (const faceId of Object.keys(state.quests)) {
    const goal = factsForQstFaceId(faceId).goal || '';
    const m = /^([A-Z_]+)/.exec(goal);
    if (m) names.add(m[1]);
  }
  return names;
}

function computeQstExtraStats(state, player, buildStats) {
  const active = activeQstMetricNames(state);
  const extras = [];
  for (const [metricName, def] of Object.entries(QST_EXTRA_STAT_DEFS)) {
    if (active.has(metricName)) extras.push({ label: def.label, value: def.compute(state, player, buildStats) });
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
        setupMod.chooseJob(state, INDEX, draftingPlayerId, faceId);
        // Auto/manual choice for the drafted JOB, if it has a reactive TAP ability (2026-07-31, per
        // user feedback -- see pendingAutoModeChoice's own comment).
        if (reactiveTapKind(faceId)) {
          pendingAutoModeChoice = { physicalId: gameStateMod.splitCardId(faceId).physicalId, playerId: draftingPlayerId };
        }
        render(STATE);
      },
    } : null);
    container.appendChild(cell);
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
  if (!player.jobCardId || isAiPlayer(player.id)) { renderConPreview(container, player); return; }
  if (player.ownedCardPhysicalIds.some((id) => id.startsWith('CON'))) return;
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
 * determined. So unlike renderJobChoice/renderConChoice above, this is shown for ANY player who still
 * has a pending SELECT_RESOURCE_CARDS choice while state.round is still 0, regardless of
 * turn-flow.getNextTurn (there's no turn order yet to gate by). Clicking a 2nd candidate commits
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
    const canToggle = isSelected || selected.length < 2;
    attachPickableEnlarge(cardNode, faceId, canToggle ? {
      label: isSelected ? '選択を解除する' : '選ぶ',
      onPick: () => {
        if (isSelected) {
          choice.context.selected = selected.filter((id) => id !== faceId);
        } else {
          selected.push(faceId);
          if (selected.length === 2) {
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
    '← 初期資源カード4枚のうちから2枚を選んでください',
    '先着順の数字の合計が少ないプレイヤーからJOBを選択しゲームが始まります',
  ]));
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
  for (const player of turnOrderedPlayers(state, activePlayerId)) {
    const isSelf = player.id === activePlayerId;
    // Bare (direct) TAP abilities are usable "any time during your own turn", same gate as
    // renderFreeActionButtons' canAct -- see attachTapToggle. !isAiPlayer (2026-08-03): an AI player's
    // bare TAP usage is decided by driveOneAiStep (as a BARE_TAP Move), never by clicks.
    const canUseTap = isSelf && hasFinishedOnboarding(player) && !isAiPlayer(player.id);
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
    renderPlayerStats(node.querySelector('.card-group__stats'), buildStats, computeQstExtraStats(state, player, buildStats));

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
      // showEffect+allowTextFallback:false (confirmed 2026-07-30): JOB/CON now show effect icons
      // like A/B/C, but unmapped DSL stays blank instead of raw text (see buildEffectRow). Cell size
      // reacts to whether the card actually ended up tall (i.e. has anything to show), rather than
      // being fixed non-tall like before.
      const cardNode = buildCardVisual(cardState.currentFaceId, {
        tapped: cardState.tapped, showEffect: true, allowTextFallback: false,
      });
      const cell = el('div', cardNode.classList.contains('shop-card--tall') ? 'owned-card-cell owned-card-cell--tall' : 'owned-card-cell');
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
    if (state.round === 0) {
      // CON preview (2026-07-30, per user feedback): shown only while this player's own RESOURCE
      // choice is still pending, same lifetime as the RESOURCE row itself below -- see
      // renderConPreview's comment for why.
      const stillChoosingResources = state.pendingChoices.some((c) => c.playerId === player.id && c.kind === 'SELECT_RESOURCE_CARDS');
      if (stillChoosingResources) renderConPreview(node.querySelector('.card-group__onboard-con'), player);
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
}

function render(state) {
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
  // ングがありません"). getNextTurn's own skip-ahead ("does this player have any unplaced die left?")
  // is exactly right for finding who a *just-ended* turn should pass to (state.currentPlayerIndex just
  // advanced by turnFlow.endTurn, and may now point at someone with nothing left at all) -- but it has
  // no way to tell that apart from "the player who's STILL mid-turn just placed their own last die and
  // hasn't clicked ターン終了 yet", since both look identical from state alone (currentPlayerIndex
  // unchanged, that player now has 0 unplaced dice). turnActionTaken already tracks "this turn's
  // placement is done, awaiting an explicit end" -- checking it against lastTurnPlayerId (only updated
  // by a REAL turn transition, below) distinguishes the two: if the literal state.turnOrder[
  // currentPlayerIndex] is still the player lastTurnPlayerId already noted as active, nothing has
  // actually ended their turn yet, so raw getNextTurn's skip-ahead here is premature and gets
  // overridden back to them. Once they really do end their turn (turnFlow.endTurn moves
  // currentPlayerIndex for real), that index's player no longer matches lastTurnPlayerId and this
  // no-ops, letting the normal "fresh turn started" transition below fire as usual.
  //
  // pendingBuildChoice needs the SAME override for a narrower reason (2026-08-06 follow-up, per user
  // report: "他のプレイヤーが未使用のダイスを持っていない時に自分がまだ未使用のダイスを持っている時
  // ターン終了ボタンが押せません" -- traced to a placement that triggers the build-choice modal, e.g. at
  // 王宮/AREA009): a die's placedMapId is set (so isRoundOver can already flip true if this was this
  // player's own last die and everyone else was already done) *before* applyPlaceDiceResult even gets a
  // chance to set turnActionTaken -- it deliberately returns early without touching that flag whenever
  // the placement produced a pendingBuild, leaving turnActionTaken false until the player actually picks
  // a candidate (commitBuildCandidate sets it then). Without this second clause, that gap left raw
  // next as ROUND_OVER on the very next render, which the transition logic below reads as "nobody's
  // turn" and wipes lastTurnPlayerId to null -- so by the time the candidate IS picked and
  // turnActionTaken finally goes true, the *first* clause above no longer matches (lastTurnPlayerId is
  // already null) and the turn-end button never reappears. Checking pendingBuildChoice.playerId
  // directly sidesteps lastTurnPlayerId entirely: only the player who legitimately just placed a die
  // can have one open (the modal is what's currently blocking everyone else from acting at all), so no
  // extra equality guard is needed here the way turnActionTaken's own (global, not per-player) flag needs one.
  if (state.turnOrder.length) {
    const currentIndexPlayerId = state.turnOrder[state.currentPlayerIndex];
    const stillMidTurn = (turnActionTaken && currentIndexPlayerId === lastTurnPlayerId)
      || (pendingBuildChoice && pendingBuildChoice.playerId === currentIndexPlayerId);
    if (stillMidTurn && (!next || next.playerId !== currentIndexPlayerId)) {
      next = { type: 'TURN', playerId: currentIndexPlayerId, playerIndex: state.currentPlayerIndex };
    }
  }
  // Auto-records an undo checkpoint at the start of each player's TURN (2026-07-30, per user
  // feedback: development/tuning phase, so undo should always get back to "start of this turn"
  // regardless of whether anything rolled a die -- see handleUndoClick, which re-arms this same
  // checkpoint after every use so it stays available for the whole turn, not just once). Gated on
  // hasFinishedOnboarding, not just next.type==='TURN' -- getNextTurn already reports 'TURN' as soon
  // as JOB is drafted, before CON is chosen (same quirk documented on hasFinishedOnboarding/
  // canPlaceDiceFor), so checking next.type alone would checkpoint too early (before CON's ONCE/
  // receiveInitialResources have run) and undo would strand the player mid-onboarding. Guarded by
  // lastTurnPlayerId so this only fires once per turn, not on every re-render while mid-turn.
  const activePlayer = next ? state.players.find((p) => p.id === next.playerId) : null;
  if (activePlayer && hasFinishedOnboarding(activePlayer)) {
    noteActiveTurnPlayerForJobPool(state, next.playerId);
    if (next.playerId !== lastTurnPlayerId) {
      undoMod.recordCheckpoint(state);
      lastTurnPlayerId = next.playerId;
      turnActionTaken = false; // a fresh turn started -- see turnActionTaken's own comment
    }
  } else {
    lastTurnPlayerId = null;
  }
  renderHeader(state);
  renderShops(state);
  renderBoard(state, next);
  renderPlayers(state, next);
  renderJobPool(state, next);
  renderPlayerCards(state, next);
  document.getElementById('board-message').textContent = placementMessage;
  renderBuildChoiceModal();
  renderPlacementChoiceModal();
  renderTapChoiceModal();
  renderAutoModeChoiceModal();
  renderTurnEndWarningModal();
  renderUndoButtons(state);
  renderRoundPassButton(state, next);
  renderRoundPassConfirmModal();
  renderPlayerRoleControl(state);
  renderAiPacingControl(state);
  renderGameEndOverlay(state);
  renderDebugPanel(state);
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
  turnActionTaken = false;
  placementMessage = '';
  undoMod.recordCheckpoint(STATE);
  render(STATE);
}

/** Enables/disables both undo buttons (the persistent one in the sidebar header, and the duplicate
 * inside #build-choice-overlay so it's reachable even while that modal covers the screen -- confirmed
 * 2026-07-30, per user feedback: "城にダイスをおいて建築を選ぶ画面でも戻れるように") based on whether
 * there's actually a checkpoint to revert to. */
function renderUndoButtons(state) {
  const disabled = !state.undoCheckpoint;
  for (const id of ['undo-button', 'undo-button-build']) {
    document.getElementById(id).disabled = disabled;
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
 * dice left) -- loops board.passDie exactly the way passSelectedDie calls it once, then runs the same
 * WARNING-gated attemptAdvanceTurn end-of-turn flow a manual pass+"ターン終了" would. Safe to run that
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

/** 人間/AI LV1/AI LV2切り替え (2026-08-03, per user feedback: "4人のプレイヤー人間 AIをそれぞれ選べる
 * ようにしてほしい", then "先程のAIをLV1 新しく作ったAIをLV2として...選べるようにしてください") --
 * one 3-state toggle per player seat (色スウォッチ+名前+人間/AI LV1/AI LV2ボタン), reusing
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
    for (const [role, label] of [['HUMAN', '人間'], ['AI_LV1', 'AI LV1'], ['AI_LV2', 'AI LV2']]) {
      const btn = el('button', 'player-role-control__option', label);
      btn.type = 'button';
      btn.classList.toggle('player-role-control__option--active', currentRole === role);
      btn.addEventListener('click', () => { playerRoles.set(player.id, role); render(STATE); });
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
 * agnostic of buildCardVisual vs buildQstCardVisual) that already has its own baked-in front+back --
 * see buildCardVisual's `.shop-card__back` / buildQstCardVisual's `.qst-card__back`. null for AREA
 * tiles, which have no "back" and no card-shaped visual, just INST text. sibling is the *id* to show
 * when flipped (null if there's no real sibling-face data, in which case the flip button stays
 * hidden) -- the flip button just toggles visualNode's existing --flipped class, reusing the same
 * absolute-overlay mechanism the inline shop-card/qst-card used to use for its own click-to-flip.
 *
 * pickAction (2026-08-0X, per user feedback -- CON/JOB/RESOURCE choice cards previously had no
 * enlarge affordance at all, since a plain tap on them was already spoken for by "pick this card";
 * see attachPickableEnlarge, the new home for that tap) is optional: `{label, onPick}`. When present,
 * a prominent button is shown that runs onPick() and closes the modal -- the actual "commit this
 * choice" gesture now lives here instead of on the card/cell itself, matching the user's own original
 * proposal for this: tap to see it enlarged, tap again (here) to actually pick it.
 */
function showCardEnlargeModal(faceId, visualNode, sibling, pickAction) {
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
  modal.classList.toggle('card-inst-modal--wide', !!visualNode);
  // The overlay/modal DOM is shared and reused across calls, so a leftover --area-wide from a previous
  // showAreaEnlargeModal call must be cleared here too, or it'd stick around on every later card modal.
  modal.classList.remove('card-inst-modal--area-wide');

  if (visualNode) {
    if (isQst) visualNode.style.width = `${QST_PRE_SCALE_WIDTH}px`;
    visualContainer.appendChild(visualNode);
    const rect = visualNode.getBoundingClientRect();
    const scale = isQst ? ENLARGE_SCALE_QST : ENLARGE_SCALE;
    visualNode.style.transform = `scale(${scale})`;
    visualNode.style.transformOrigin = 'top center';
    // transform doesn't participate in layout sizing -- without this the scaled visual would just
    // spill outside its own box instead of the modal growing to fit it.
    visualContainer.style.width = `${rect.width * scale}px`;
    visualContainer.style.height = `${rect.height * scale}px`;
  }

  const flippedClass = isQst ? 'qst-card--flipped' : 'shop-card--flipped';
  function shownId() {
    return (visualNode && visualNode.classList.contains(flippedClass)) ? sibling : faceId;
  }
  function refreshText() {
    const shown = shownId();
    overlay.querySelector('.card-inst-modal__title').textContent = shown;
    renderInstBody(overlay.querySelector('.card-inst-modal__body'), instForId(shown));
  }
  flipBtn.hidden = !sibling;
  flipBtn.textContent = '裏側';
  flipBtn.onclick = () => {
    visualNode.classList.toggle(flippedClass);
    flipBtn.textContent = visualNode.classList.contains(flippedClass) ? '表側' : '裏側';
    refreshText();
  };
  pickBtn.hidden = !pickAction;
  if (pickAction) {
    pickBtn.textContent = pickAction.label;
    pickBtn.onclick = () => {
      hideCardEnlargeModal();
      pickAction.onPick();
    };
  }
  refreshText();
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
  // too, in case a previous showCardEnlargeModal call left it on this same shared modal element.
  modal.classList.remove('card-inst-modal--wide');
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

  document.getElementById('debug-mode-toggle').addEventListener('click', toggleDebugMode);
  document.getElementById('debug-turn-back').addEventListener('click', handleDebugTurnBack);
  document.getElementById('debug-turn-forward').addEventListener('click', handleDebugTurnForward);
  document.getElementById('debug-round-back').addEventListener('click', handleDebugRoundBack);
  document.getElementById('debug-round-forward').addEventListener('click', handleDebugRoundForward);

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
    const { dieId, mapId, slotIndex, colorPreference } = pendingPlacementChoice;
    pendingPlacementChoice = null;
    placeSelectedDie(STATE, dieId, mapId, slotIndex, colorPreference);
  });

  document.getElementById('tap-choice-cancel').addEventListener('click', () => {
    pendingTapChoice = null;
    render(STATE);
  });
  document.getElementById('tap-choice-confirm').addEventListener('click', () => {
    const { physicalId, playerId, bareTap, dieId, value } = pendingTapChoice;
    pendingTapChoice = null;
    const context = { playerId, chosenDieId: dieId };
    if (bareTap.kind === 'CHANGE_DIE_VALUE') context.chosenDelta = value;
    else context.chosenValue = value;
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
