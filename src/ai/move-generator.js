(function () {
'use strict';

/**
 * MoveGenerator: enumerates every legal Move for playerId in the *current* state. Never mutates state
 * -- candidate placements/bare-TAP choices are legality-checked via throwaway clones (cloneState),
 * exactly the same "engine is the single source of truth for legality" principle main.js's UI follows
 * (nothing here re-implements board.placeDice's own rules).
 *
 * Move shapes (a plain discriminated union, matching what simulator.js's applyInPlace expects):
 *   { type:'PLACE_DIE', playerId, dieId, mapId, slotIndex, buildCandidateIndex? }
 *   { type:'PLACE_WILDCARD_DIE', playerId, dieId, mapId, slotIndex?, buildCandidateIndex? }
 *   { type:'PLACE_DICE_GROUP', playerId, dieIds:[id,id] or [id,id,id], mapId, buildCandidateIndex? }
 *   { type:'PASS_DIE', playerId, dieId, allDice? }  (allDice:true = ラウンドパス、残りのダイスを全部パス)
 *   { type:'BARE_TAP', playerId, physicalId, chosenDieId?, chosenValue?, chosenDelta?, buildCandidateIndex? }
 *   { type:'FREE_ACTION', playerId, freeActionId }
 *   { type:'COLLECT_FEE', playerId, mapId }
 *   { type:'TAP_REACTION', playerId, choiceId, use }
 *   { type:'END_TURN', playerId }
 *
 * (2026-08-09: CLAIM_QUEST removed -- QST no longer has any player-facing action at all, see
 * src/qst.js's own doc. Rewards are granted automatically at GAME_END based on final ranking.)
 *
 * context.hasPlacedDieThisTurn (supplied by AIPlayer, which tracks it the same way main.js's UI-only
 * turnActionTaken flag does -- GameState has no such field, since a "turn" isn't its own state, just
 * turn-flow.getNextTurn's rotation) gates which categories apply: PLACE_DIE/PASS_DIE only appear while
 * false (fulfilling the mandatory once-per-turn placement-or-pass decision, see board.passDie's own
 * doc); END_TURN only appears once true (matches main.js's 2026-08-01 "建築後、ターンエンド前にTAPの
 * フリーアクションが可能です" fix -- ending a turn is a separate, explicit choice, not automatic).
 * Everything else (free actions/bare TAP/TAP reactions) is available either way, same as the real UI's
 * own gating.
 *
 * Simplification confirmed for this first pass (see simulator.js's matching note): PLACE_DIE/BARE_TAP
 * candidates never vary bzDiscount -- payment always resolves with the engine's own default (real first,
 * Z fallback, or Z-first automatically for a 色欲 owner -- see executor.resolvePayment's own doc).
 *
 * PLACE_WILDCARD_DIE (2026-08-19, JOB003/hasWildcardDice): #placeDieMoves enumerates die x mapId only,
 * no slotIndex loop, for a wildcard-owning player -- board.placeWildcardDie auto-assigns the slot itself
 * (see its own doc), so there is nothing for MoveGenerator to search over per-slot the way PLACE_DIE
 * does. EXCEPTION (2026-08-28, see board.wildcardExAnyChoice's own doc): when the player's own empty EX
 * slot and an empty non-EX slot are both available at mapId, that IS a genuine choice with no single
 * "correct" auto-pick, so #wildcardPlaceDieMoves offers BOTH as separate Moves (each carrying its own
 * slotIndex) instead of the usual single slotIndex-less Move.
 *
 * PLACE_DICE_GROUP (2026-08-21, per user request "AIがダイスを２個使ってモニュメントを獲得できるように
 * してほしい"): #placeDiceGroupMoves enumerates 2-die pairs, and (2026-10-15, see its own doc for why)
 * 3-die triples too, at 王宮/元老院 only -- the only 2 maps board.placeDiceGroup supports -- skipping any
 * combo whose sum a smaller combo could already reach (pairs: sum >6; triples: sum >12). No multi-turn
 * "hold a die back hoping for a better combo" strategy -- this only offers moves that are legal *right
 * now*, same greedy-per-turn scope as every other Move here.
 */

const { getAreaRow, getCardRow } = require('../data-loader');
const { parse } = require('../dsl-parser');
const { lowerProgram } = require('../command-builder');
// AIの読みの中のコピーは、カードを変わった物だけ写す(game-state.jsのcloneStateCow参照)。
const { cloneStateCow: cloneState, writableCard } = require('../game-state');
const board = require('../board');
const executor = require('../executor');
const { applyInPlace, rememberPlacedDryRun } = require('./simulator');
const { compareDicePriority } = require('./die-priority');

/** The 12 C-tier faces (both LV1/LV2 tiers of 貴族/司教/金貸し/農場主/聖女/王女) whose TAP is a pure
 * ADD(...) resource grant with no cost at all -- see MoveGenerator#forcedPureGainCTap's own doc on why
 * these specifically (and not 代官/修道士/商人's CHANGE(K,...)-shaped taps) are safe to force
 * unconditionally. */
const PURE_GAIN_C_FACES = new Set([
  'C004A', 'C004B', 'C005A', 'C005B', 'C006A', 'C006B',
  'C201A', 'C201B', 'C202A', 'C202B', 'C301A', 'C301B',
]);

/** Mirrors main.js's bareTapKind (2026-07-31) -- duplicated rather than shared because main.js is a
 * browser-only classic script, not a requireable CommonJS module like the rest of src/. Keep the two
 * in sync if either changes. null = no TAP field, or purely ON(...)-wrapped (reactive-only, handled as
 * a TAP_REACTION choice instead, never generated as a BARE_TAP move here). BUILD is checked anywhere in
 * the field, not just commands[0] (2026-08-17, see main.js's own bareTapKind doc -- JOB010's
 * "PAY(2K);BUILD(U)" has a flat cost ahead of it; a no-op change for every other card). */
function bareTapKind(index, faceId) {
  let row;
  try { row = getCardRow(index, faceId); } catch (e) { return null; }
  if (!row.TAP) return null;
  const commands = lowerProgram(parse(row.TAP));
  if (commands.every((c) => c.type === 'ON')) return null;
  const first = commands[0];
  if (first.type === 'SET_DICE_ANY') return { kind: 'SET_DICE_ANY' };
  if (first.type === 'SET_DIE_VALUE') return { kind: 'SET_DIE_VALUE', choices: first.choices };
  if (first.type === 'CHANGE_DIE_VALUE') return { kind: 'CHANGE_DIE_VALUE', choices: first.choices };
  // SET_WILDCARD(SELF,THIS_TURN) (B001B, 2026-10-19): needs a die choice same as SET_DIE_VALUE/
  // CHANGE_DIE_VALUE just above, but no value/delta dimension at all -- its own #bareTapMoves branch
  // handles it separately rather than reusing the `choices`-iterating one those share.
  if (first.type === 'SET_WILDCARD') return { kind: 'SET_WILDCARD' };
  // MONUMENT_CHANGE_DIE_VALUE(SELF+2) (2026-08-24, JOB007/宮廷人's revised TAP) -- same die-choice
  // requirement as CHANGE_DIE_VALUE, but the delta is a single fixed number baked in at DSL-lowering
  // time (cmd.delta), never a player-picked one of several choices, so no `choices` value here.
  // Searched ANYWHERE in the field, not just commands[0] (mirrors main.js's own bareTapKind, fixed
  // there 2026-08-25 per user report: "宮廷人を使おうとしてTAPしようとするとカードを使用できません
  // と出ます" -- JOB007's own TAP is "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(...)", so
  // first.type was 'ADD', this branch never matched there either. This copy was never brought in sync
  // with that fix -- see this function's own top-of-file doc on the two needing to stay in sync -- so
  // the AI could never actually use JOB007's TAP at all (2026-08-25, per user report: "宮廷人 AIの使用
  // 回数が0です"): #bareTapMoves/forcedBzConversionMove both called useBareTapAbility with no
  // chosenDieId, which the die-value-change command then had nothing to act on and always failed.
  // ADD(BZ) is an unconditional grant with no choice of its own, same "flat leading effect ahead of the
  // real interactive command" shape BUILD's own check just below already handles for JOB010.
  const monumentChangeDieValue = commands.find((c) => c.type === 'MONUMENT_CHANGE_DIE_VALUE');
  if (monumentChangeDieValue) return { kind: 'MONUMENT_CHANGE_DIE_VALUE' };
  if (commands.some((c) => c.type === 'BUILD')) return { kind: 'BUILD' };
  return { kind: 'IMMEDIATE' };
}

/** 建築候補の識別キー: 新規獲得ならそのカードの面ID、LVアップなら"U:"+LVアップ後の面ID。皇帝宮殿/元老院の
 * どちらで取れる手かを比べるため(#applyCastleSenatePreference参照)。 */
function buildCandidateKey(candidate) {
  if (!candidate) return null;
  return candidate.type === 'UPGRADE' ? `U:${candidate.toFaceId}` : candidate.faceId;
}

/** K the player must keep for a pending usage fee (0 when none, or when the fee is in A/B/C -- 2026-11-09:
 * those aren't covered by K and just cost -1VP per missing unit). */
function pendingKFee(player) {
  return player.pendingFee && (player.pendingFee.resource || 'K') === 'K' ? player.pendingFee.amount : 0;
}

const DIE_ONLY_TAP_KINDS = new Set(['SET_DICE_ANY', 'SET_DIE_VALUE', 'CHANGE_DIE_VALUE', 'SET_WILDCARD']);

/** コスト("12K"・"3A,B"など)に資源resが入っているか (使用料のきまり用、2026-11-23)。 */
function costMentionsResource(cost, res) {
  return cost.split(/[,/]/).some((part) => part.trim().replace(/^[0-9]+/, '') === res);
}
/** エリアのACTIONに、資源resを払うCHANGE(例: CHANGE(K,A,ALL)・CHANGE(2K,3Z))があるか (使用料のきまり用、2026-11-23)。 */
function changePaysResource(action, res) {
  for (const m of action.matchAll(/CHANGE[(]([^;]*)/g)) {
    const first = m[1].startsWith('(') ? m[1].slice(1, m[1].indexOf(')')) : m[1].split(',')[0];
    if (first.split(',').some((part) => part.trim().replace(/^[0-9]+/, '') === res)) return true;
  }
  return false;
}

/** mustUseChangedDie (AI LV3・ナビだけ、2026-11-24, per user「ダイス目変換をしたときは その目を 必ず使うにするのはどう」→
 * 「おねがい」): この手番に目を変えたダイス(valueChangedThisTurn、置かないと手番の終わりに元に戻る)がまだ置かれていなければ、
 * ダイスを置く手はそのダイスを使うもの(まとめて置く時はその中に入っているもの)だけにする。そのダイスをどこにも置けない時は
 * 今までどおり全部(止まらないように)。置く手以外(タップ・フリーアクションなど)はそのまま。人のプレイ(ゲームのルール)は変えない。 */
// PASS_DIE には allDice:true(ラウンドパス、残りのダイスを全部パス)もある(#placeDieMoves参照、2026-11-25)。
const DIE_PLACING_MOVE_TYPES = new Set(['PLACE_DIE', 'PLACE_WILDCARD_DIE', 'PLACE_DICE_GROUP', 'PASS_DIE']);
// 宮廷人(JOB010)をこのターンに使った時は当てはめない (per user「宮廷人以外」-- 宮廷人のタップはBZ+1もあり、目+5を使わなくても
// 損ではないため)。宮廷人は毎ターン使えるので、タップ済み = このターンに使った。
function keepChangedDiePlacements(moves, player, state) {
  const courtier = state.cards && state.cards.JOB010;
  if (courtier && courtier.ownerId === player.id && courtier.tapped) return moves;
  // ☆にしたダイス(基礎学問LV2、isWildcardThisTurn)も同じ (2026-11-24, per user「☆にしたダイスを置かなかったときも…はい」)。
  const changed = new Set(player.dice.filter((d) => (d.valueChangedThisTurn || d.isWildcardThisTurn) && d.placedMapId === null && !d.passed).map((d) => d.id));
  if (changed.size === 0) return moves;
  const usesChanged = (m) => (m.dieIds ? m.dieIds.some((id) => changed.has(id)) : changed.has(m.dieId));
  const placements = moves.filter((m) => DIE_PLACING_MOVE_TYPES.has(m.type));
  if (!placements.some((m) => m.type !== 'PASS_DIE' && usesChanged(m))) return moves;
  return moves.filter((m) => !DIE_PLACING_MOVE_TYPES.has(m.type) || (m.type !== 'PASS_DIE' && usesChanged(m)));
}

class MoveGenerator {
  /**
   * @param {{avoidMapIdFromRound?: {mapId: string, round: number}}} [policy] - optional strategy knob
   *   (2026-08-09, originally added for "AI LV3"). Default {} (no restriction at all) -- every AI level
   *   currently uses a MoveGenerator built with no policy, so behavior is byte-for-byte unchanged unless
   *   a level is explicitly given one of its own (construct a separate MoveGenerator instance with this
   *   set, as main.js's aiMoveGeneratorLv3 used to for LV3).
   *   avoidMapIdFromRound (2026-08-10, per user request: "AILV3について R3からAREA007にダイスを置かない
   *   ようにかえたい"; removed from LV3 2026-08-28 per user request "3Rから訓練場を避けるは削除してくださ
   *   い" -- the mechanism itself is kept here, unused by any level for now, since it's generic and may
   *   be reused later): once state.round reaches .round, #placeDieMoves stops offering ANY placement
   *   (any slot, any die) on .mapId at all -- not a preference the Evaluator weighs, an outright removal
   *   from the candidate list (a die left with no other legal slot still falls back to PASS_DIE, same
   *   escape hatch as always -- this can't deadlock the AI).
   *   (2026-08-10: this policy previously also had a monumentFocusFromRound field -- an AI that stopped
   *   buying new A/B/C cards from a given round on and banked toward monuments instead, meant to stop
   *   LV1/LV2 from routinely ending games with large unspent resource piles. Removed per user request
   *   once QST's rank-based rewards rework made the round 3/4 build restriction unnecessary.)
   *   preferCastleOverSenate (2026-08-28, "AI LV4", default false, per user spec: "王宮 元老院 どちらに
   *   も置けるときは 王宮優先", exception confirmed the same day: "開拓者を例外にして" -- "空いている方を
   *   優先"; scoped to rounds 1-2 only, per a same-day follow-up: "元老院と王宮どちらも置けるときに王宮に
   *   するというのは 1-2R限定の話です" -- from round 3 on this policy is a complete no-op and both areas
   *   stay full, independent candidates): 王宮(CASTLE_MAP_ID/MAP008) and 元老院(AREA009_MAP_ID/MAP009) are
   *   functionally identical (both ANY-slot BUILD() areas), so offering both as separate candidates every
   *   turn is pure redundant
   *   search for computation-reduction purposes (see this class's own die-priority.js sibling for the
   *   same motivation). When both currently have at least one legal placement move this call, all 元老院
   *   moves are dropped in favor of 王宮 -- UNLESS playerId holds 開拓者 (JOB009, board.hasPioneerAbility),
   *   whose bonus only fires on an AREA with zero dice placed on it yet (board.isMapEmptyOfDice): a
   *   開拓者 owner instead keeps only whichever of the two is CURRENTLY empty (dropping the other), since
   *   that is a genuine value difference between them for this player specifically; a tie (both empty or
   *   both already occupied, so neither/either equally triggers or fails to trigger the bonus) falls back
   *   to the plain 王宮 preference. Applied as a post-filter over the whole move list (mapId is absent on
   *   every non-placement move type, e.g. FREE_ACTION/END_TURN, so those are always left untouched).
   */
  constructor(policy) {
    this.policy = policy || {};
  }

  /** See preferCastleOverSenate's own constructor doc for the full rule. No-op (returns moves unchanged)
   * whenever the policy isn't set, state.round > 2, or 王宮/元老院 aren't BOTH currently offering a legal
   * move. */
  #applyCastleSenatePreference(state, index, playerId, moves) {
    if (!this.policy.preferCastleOverSenate || state.round > 2) return moves;
    const CASTLE = board.CASTLE_MAP_ID;
    const SENATE = board.AREA009_MAP_ID;
    if (!moves.some((m) => m.mapId === CASTLE) || !moves.some((m) => m.mapId === SENATE)) return moves;
    let dropMapId = SENATE;
    if (board.hasPioneerAbility(state, index, playerId)) {
      const castleEmpty = board.isMapEmptyOfDice(state.maps[CASTLE]);
      const senateEmpty = board.isMapEmptyOfDice(state.maps[SENATE]);
      if (senateEmpty && !castleEmpty) dropMapId = CASTLE;
      // else: castle-only-empty, or a tie (both/neither empty) -- dropMapId stays SENATE (plain
      // preference, see this method's own doc).
    }
    // 優先しない側でしか取れないカードの手は残す (2026-10-23, per user request: "皇帝宮殿で獲得可能なカードは
    // 元老院でとることを考えなくてもいいが 元老院でしか取れないカードはちゃんと候補に残してほしい") -- 以前は
    // 優先しない側(通常は元老院)の手をすべて捨てていたため、皇帝宮殿では取れないが元老院なら取れるカードが
    // AIの候補から消えていた。捨てるのは「優先する側でも同じカード(buildCandidateKey)が取れる手」と、建築を
    // 伴わない手(置くだけ)だけ。
    const keptKeys = new Set(moves.filter((m) => m.mapId !== dropMapId && m.buildCandidateKey).map((m) => m.buildCandidateKey));
    return moves.filter((m) => m.mapId !== dropMapId || (m.buildCandidateKey && !keptKeys.has(m.buildCandidateKey)));
  }

  /** True once state.round has reached the policy's avoidMapIdFromRound.round threshold for this exact
   * mapId -- no-op (always false) when the policy isn't set. */
  #isMapIdAvoided(state, mapId) {
    const avoid = this.policy.avoidMapIdFromRound;
    return !!avoid && mapId === avoid.mapId && state.round >= avoid.round;
  }

  /** 方針 noOrphanageEarly: R1・R2は孤児院(AREA010A/B)に置く手を候補に入れない (2026-11-25, per user「孤児院は 1R 2R
   * では 候補に入れない」「1R 2R に 孤児院に行くのは 効率が悪い」)。そのダイスを置ける所が孤児院しか無い時はパスになる
   * (「孤児院に置かなくても 解決」)。 */
  /** どの資源でも払える支払い(孤児院のCHANGE(ANY,VP,n)・パンとサーカスの手番の終わり)で、払い方の違う手も足す
   * (2026-11-25, per user「どんな資源でも払えるように」「人間もAIも選べるように」)。〇から先(自動と同じ、元の手) と 〇を残してほかから先(anyPayment付きの手)。 */
  #withAnyPaymentVariants(state, index, playerId, player, moves) {
    const out = [];
    let turnEndCap = null;
    for (const m of moves) {
      out.push(m);
      let need = 0;
      if (m.type === 'PLACE_DIE' && m.mapId && !m.buildCandidateKey) {
        need = executor.anyPayNeedOfText(getAreaRow(index, state.maps[m.mapId].currentAreaId).ACTION, player.resources);
      } else if (m.type === 'END_TURN') {
        if (turnEndCap === null) {
          turnEndCap = 0;
          for (const physicalId of player.ownedCardPhysicalIds) {
            const card = state.cards[physicalId];
            if (card) turnEndCap = Math.max(turnEndCap, executor.anyPayNeedOfText(getCardRow(index, card.currentFaceId).TURNEND, player.resources));
          }
        }
        need = turnEndCap;
      }
      if (!need) continue;
      const options = executor.anyPaymentOptions(player.resources, need, executor.anyPayPrimary(state, index, playerId));
      for (const option of options.slice(1)) out.push({ ...m, anyPayment: option });
    }
    return out;
  }

  /** 研究LV2(B005B、BUILD(U);ADD(2BZ))がアンタップで今LVを上げられるカード(払える物)の、LVアップ先の面のid。 (2026-11-25, per user「レベルを上げるとき研究LV2があったらダイス置くより研究LV2を使うの優先にするのはどう それから研究LV2をもっていて あとでLVUPしても先にしてもいっしょなら先にする 理由 分岐が減り計算が早くなる 支配系のLVを先にあげることによって使用料が増える」→「はい」)
   * 研究が無い・タップ済み・上げられる物が無い時は空。研究のタップの手(BARE_TAP、buildCandidateIndex付き)も返す。 */
  researchUpgrades(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    const out = { faces: new Set(), moves: [] };
    if (!player) return out;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const card = state.cards[physicalId];
      if (!card || card.tapped || card.currentFaceId !== 'B005B') continue;
      const probe = cloneState(state);
      const result = board.useBareTapAbility(probe, index, { playerId }, physicalId);
      if (!result.success || !result.pendingBuild) continue;
      result.pendingBuild.candidates.forEach((c, buildCandidateIndex) => {
        if (c.type !== 'UPGRADE') return;
        const move = { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex, buildCandidateKey: buildCandidateKey(c) };
        try {
          if (!applyInPlace(cloneState(state), index, move).success) return;
        } catch (e) { return; }
        out.faces.add(c.toFaceId);
        out.moves.push(move);
      });
    }
    return out;
  }

  /** 研究LV2で上げられるカードを、ダイスを置いてLVアップする手は出さない(研究ならダイスを使わず軽減も付く) (2026-11-25, per user「レベルを上げるとき研究LV2があったらダイス置くより研究LV2を使うの優先にするのはどう それから研究LV2をもっていて あとでLVUPしても先にしてもいっしょなら先にする 理由 分岐が減り計算が早くなる 支配系のLVを先にあげることによって使用料が増える」→「はい」)。 */
  #withoutDieUpgradesResearchCanDo(state, index, playerId, moves) {
    if (!moves.some((m) => typeof m.buildCandidateKey === 'string' && m.buildCandidateKey.startsWith('U:') && m.type !== 'BARE_TAP')) return moves;
    const { faces } = this.researchUpgrades(state, index, playerId);
    if (faces.size === 0) return moves;
    return moves.filter((m) => !(m.type !== 'BARE_TAP' && typeof m.buildCandidateKey === 'string' && m.buildCandidateKey.startsWith('U:') && faces.has(m.buildCandidateKey.slice(2))));
  }

  #isOrphanageHeldBack(state, mapId) {
    return !!this.policy.noOrphanageEarly && state.round <= 2 && /^AREA010/.test(state.maps[mapId].currentAreaId || '');
  }

  /** @returns {Object[]} every legal Move for playerId right now. */
  generateMoves(state, index, playerId, context) {
    let moves = [];
    this.#placeOutcomes = null; // 前の呼び出しの物は使わない(同じ盤面のオブジェクトでも中身が変わっていることがある)
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return moves;

    if (!context.hasPlacedDieThisTurn) {
      const singleMoves = this.#placeDieMoves(state, index, playerId, player);
      moves.push(...singleMoves);
      // 同じモニュメントをもっと少ないダイスで建てられるなら、それより多く使う手は出さない (2026-11-15, per user
      // 「「6を1個」で建てられたのに「5と5」を使った…これは絶対に直して」-- 1個で足りるのに2個、2個で足りるのに3個。
      // ダイスを余分に使うだけで得が無い)。
      const groupMoves = this.#placeDiceGroupMoves(state, index, playerId, player);
      const isMonumentMove = (m) => typeof m.buildCandidateKey === 'string' && /^M/.test(m.buildCandidateKey);
      const fewestDice = new Map();
      for (const m of [...singleMoves, ...groupMoves]) {
        if (!isMonumentMove(m)) continue;
        const count = m.dieIds ? m.dieIds.length : 1;
        if (!fewestDice.has(m.buildCandidateKey) || count < fewestDice.get(m.buildCandidateKey)) fewestDice.set(m.buildCandidateKey, count);
      }
      moves.push(...groupMoves.filter((m) => !isMonumentMove(m) || m.dieIds.length <= fewestDice.get(m.buildCandidateKey)));
      moves = this.#applyCastleSenatePreference(state, index, playerId, moves);
    }
    // Only offered while actually needed to unblock a RESOURCE_TOTAL_LIMIT-blocked turn end (2026-08-03,
    // per user feedback: "AIが無駄にA→K B→K C→K Z→K wD→2Kをやっています この行動には意味がないため
    // AIは上記のフリーアクションを基本的にはやらないようにしてください"). A simple linear-weighted
    // Evaluator has no notion of "do I actually need K right now" -- any conversion whose target weighs
    // even marginally more than its source (e.g. round-independent K=3 vs A=5 usually loses) reads as
    // "an improvement" and gets taken, even though it just trades a typed resource for K with no real
    // plan for it. Restricting generation to the one case where it's genuinely necessary (not "usually
    // good") keeps the resource-limit-unblock behavior that was specifically fixed earlier (CON005B
    // could otherwise deadlock the AI) without the otherwise-constant pointless conversions. (2026-08-07:
    // wD->2K, one of the free actions this comment originally listed, was abolished per user request --
    // see game-state.js's FREE_ACTION_IDS.)
    // 心配 (CON006A)を持っていて〇が0個の時も交換を選べるようにする (2026-11-05, per user「AIは心配を持っているとき
    // a→Kで-1VPされないことを理解していますか」→「1(評価値で比べる) 心配を持っているときのみ」): ターン終了時の-1VPを
    // 避けるかどうかは、END_TURN(-1VP込み)と交換後の状態を評価値で比べて決める。
    // 巫女(JOB002、ターン終了時〇が4以下なら〇を得る)を持っていれば、心配の判定の前に〇が1個増えるので交換は要らない
    // (2026-11-26, per user のナビのバグ報告「巫女があるのにA→Kを推奨してくる」。turn-flow.jsでapplyTurnEndの後にapplyWorryPenalty)。
    const ownsFace = (faceId) => player.ownedCardPhysicalIds.some((id) => state.cards[id] && state.cards[id].currentFaceId === faceId);
    const worryNeedsK = (player.resources.K || 0) === 0 && ownsFace('CON006A') && !ownsFace('JOB002');
    if (worryNeedsK || executor.canEndTurn(state, index, playerId).violations.length > 0) {
      moves.push(...this.#freeActionMoves(state, index, playerId, player));
    }
    // 使用料の回収 (2026-11-23, per user「暴食持っていなければ使用料はすぐにとる / 暴食持っていれば食料の使用料は必要に
    // なるまで絶対取らない(ローマ市街などにダイスを置く直前にとる)」):
    //  - その資源に上限(暴食のRESOURCE_LIMITなど)が無い: 候補に入れる。「すぐ取る」はAIの必ずやる手として
    //    (forcedImmediateFeeMove、AIPlayerの#checkForcedMoves)。ここで回収の手だけを返すと、この一覧を使う
    //    ショップの「今すぐ取れる」表示(main.jsのcomputeShopAcquirableMoveCache)が消えてしまうため。
    //  - 上限がある: まだダイスを置いていない手番で、その資源を使う置き方(CHANGEで払うエリア・その資源が要る建築)が
    //    ある時だけ候補にする(取ってすぐ使う)。ゲーム最後の手番は取ってよい(残しても意味がないため)。
    const feeMoves = this.#feeCollectionMoves(state, playerId);
    if (feeMoves.length > 0) {
      const limits = executor.activeResourceLimits(state, index, playerId);
      const unplacedCount = player.dice.filter((d) => d.placedMapId === null && !d.passed).length;
      const lastTurnOfGame = state.round >= 4 && (context.hasPlacedDieThisTurn ? unplacedCount === 0 : unplacedCount <= 1);
      const usesResource = (res) => moves.some((m) => {
        if (!m.mapId) return false;
        if (m.buildCandidateKey) {
          const faceId = m.buildCandidateKey.startsWith('U:') ? m.buildCandidateKey.slice(2) : m.buildCandidateKey;
          try { if (costMentionsResource(String(getCardRow(index, faceId).COST || ''), res)) return true; } catch (e) { /* ignore */ }
        }
        const action = String(getAreaRow(index, state.maps[m.mapId].currentAreaId).ACTION || '');
        return changePaysResource(action, res);
      });
      const immediate = [];
      for (const m of feeMoves) {
        const res = state.maps[m.mapId].accumulatedFeeResource || 'K';
        if (limits[res] === undefined) immediate.push(m);
        else if (lastTurnOfGame || (!context.hasPlacedDieThisTurn && usesResource(res))) moves.push(m);
      }
      moves.push(...immediate);
    }
    const bareTaps = this.#bareTapMoves(state, index, playerId, player, context);
    moves.push(...bareTaps);
    this.#placeOutcomes = null;
    if (!context.hasPlacedDieThisTurn) moves.push(...this.#tapThenPlaceMoves(state, index, playerId, player, bareTaps));
    this.#placeOutcomes = null;
    moves = this.#withAnyPaymentVariants(state, index, playerId, player, moves);
    moves = this.#withoutDieUpgradesResearchCanDo(state, index, playerId, moves);
    moves.push(...this.#tapReactionMoves(state, playerId));
    if (context.hasPlacedDieThisTurn && executor.canEndTurn(state, index, playerId).ok) {
      moves.push({ type: 'END_TURN', playerId });
    }
    if (this.policy.deferConversionTaps && context.hasPlacedDieThisTurn && !context.noDeferConversion) {
      moves = this.#withoutDeferrableConversionTaps(state, index, playerId, player, context, moves);
    }
    moves = this.#withPreConvertedTaps(state, index, player, moves);
    return this.policy.mustUseChangedDie && !context.hasPlacedDieThisTurn ? keepChangedDiePlacements(moves, player, state) : moves;
  }

  /** 目を変えるカード(基礎学問・高等学問・幾何学・宮廷人)をタップしてから置く手を、1つの手として足す (2026-11-26 Ver.1.1747,
   * per user「基礎学問 高等学問を持っていたら AIはそのスロットに置けるようになる(置いた結果タップする)という風に考える」
   * 「基本的に一番いらない目(場に多い目)に使う」「宮廷人も+5して置けるところが増えるならそれでいい」)。先読みの中では1手ずつ
   * その場の点で選ぶので、タップだけの手は点が上がらず「タップしてから訓練場に置く」を打てなかった。move.preTapを
   * simulator.applyInPlaceが先にタップする。目を変えるのは、まだ置いていないダイスのうち一番いらないダイス
   * (die-priority.jsの決まり: 場に多く残っている目 → R1・R2は大きい目/R3・R4は小さい目 → 色ダイス)の1個だけ。
   * タップの手(#bareTapMoves)が出ている(=目を変えると新しい置き方ができる)時だけ作る。 */
  #tapThenPlaceMoves(state, index, playerId, player, bareTaps) {
    const dieTaps = bareTaps.filter((m) => m.type === 'BARE_TAP' && m.chosenDieId && m.buildCandidateIndex === undefined && !m.skipDieChange);
    if (dieTaps.length === 0) return [];
    const unplaced = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    if (unplaced.length === 0) return [];
    const cmp = compareDicePriority(state, state.round || 1);
    const spare = unplaced.map((d) => ({ dieId: d.id })).sort(cmp)[0].dieId;
    const out = [];
    for (const tap of dieTaps) {
      if (tap.chosenDieId !== spare) continue;
      const tapped = cloneState(state);
      const preTap = { physicalId: tap.physicalId, chosenDieId: tap.chosenDieId };
      if (tap.chosenValue !== undefined) preTap.chosenValue = tap.chosenValue;
      if (tap.chosenDelta !== undefined) preTap.chosenDelta = tap.chosenDelta;
      const r = applyInPlace(tapped, index, { type: 'BARE_TAP', playerId, ...preTap });
      if (!r.success) continue;
      const tappedPlayer = tapped.players.find((p) => p.id === playerId);
      for (const m of this.#placeDieMoves(tapped, index, playerId, tappedPlayer)) {
        if (m.type !== 'PLACE_DIE' || m.dieId !== spare) continue;
        out.push({ ...m, preTap });
      }
      this.#placeOutcomes = null;
    }
    return out;
  }

  /** 〇を人脈に上限まで変えるタップ(総督・学者・商人のLV2、CHANGE(K,Z,n))で〇が上限より少ない時、「赤〇・青〇・黄〇を〇に
   * 変えて(フリーアクション)からタップする」手も足す(move.preConvert、simulator.applyInPlaceが先に変換する) (2026-11-26,
   * per user「K6 A1 のとき 総督LV2で すべてZにできることを理解していますか」→「B」+「A2 B2 K3 のときに すべてCにするのは困る」
   * 「R1は AB<Cなので」)。変換だけして使わないことが無いように、変換とタップを1つの手にする。人脈に変えるLV2だけ
   * (色の資源どうしの入れ替えになるLV1は出さない)。足りない分を、多く持っている色の資源から。 */
  #withPreConvertedTaps(state, index, player, moves) {
    const out = [];
    for (const m of moves) {
      out.push(m);
      if (m.type !== 'BARE_TAP' || m.chosenDieId || m.buildCandidateIndex !== undefined) continue;
      const card = state.cards[m.physicalId];
      if (!card) continue;
      let row;
      try { row = getCardRow(index, card.currentFaceId); } catch (e) { continue; }
      const t = /^CHANGE\((\d*)K,\d*Z,(\d+)\)$/.exec(String(row.TAP || '').trim());
      if (!t) continue;
      const shortfall = (t[1] ? Number(t[1]) : 1) * Number(t[2]) - (player.resources.K || 0);
      if (shortfall <= 0) continue;
      const colored = { A: player.resources.A || 0, B: player.resources.B || 0, C: player.resources.C || 0 };
      const amount = Math.min(shortfall, colored.A + colored.B + colored.C);
      if (amount <= 0) continue;
      const plan = executor.defaultAnyPayment({ ...colored, K: 0, Z: 0 }, amount);
      if (plan) out.push({ ...m, preConvert: plan });
    }
    return out;
  }

  /** deferConversionTaps (AI LV3・ナビだけ、2026-11-24, per user のナビのバグ報告「推奨の手が総督をすぐ使うになっている
   * ここで使う意味はなく次のターンに回した方がいい」→ 案に「OK」): 持っている分だけ替えるタップ(総督CHANGE(K,A,7)・
   * 学者CHANGE(K,B,7)など、CHANGEのcapped/all)は、ダイスを置いた後は次のどれかの時だけ候補にする。
   *  1. このラウンドの最後の手番(置いていないダイスが無い) -- 使わないとタップが無駄になる
   *  2. 替える元の資源がもう上限(7など)以上ある -- 待っても多くは替えられない
   *  3. 替えると、この手番で取れるカード(建てる手)が増える
   *  4. 替える元の資源に上限(暴食など)がある -- ターン終了で減る
   * ダイスを置く前は今までどおり(AIPlayerの#betterToPlaceBeforeConversionTapが先に置くかと比べる)。 */
  #withoutDeferrableConversionTaps(state, index, playerId, player, context, moves) {
    const hasDiceLeft = player.dice.some((d) => d.placedMapId === null && !d.passed);
    if (!hasDiceLeft) return moves;
    let limits = null;
    let buildKeysNow = null;
    return moves.filter((m) => {
      if (m.type !== 'BARE_TAP') return true;
      const card = state.cards[m.physicalId];
      let commands;
      try { commands = lowerProgram(parse(getCardRow(index, card.currentFaceId).TAP || '')); } catch (e) { return true; }
      if (!commands.length || !commands.every((c) => c.type === 'CHANGE' && c.times && (c.times.kind === 'capped' || c.times.kind === 'all'))) return true;
      for (const c of commands) {
        const pay = c.pay && c.pay[0];
        if (!pay || !pay.count || pay.count.kind !== 'literal') continue;
        const have = player.resources[pay.resource] || 0;
        if (c.times.kind === 'capped' && have >= c.times.value * pay.count.value) return true; // 2
        if (!limits) limits = executor.activeResourceLimits(state, index, playerId);
        if (limits[pay.resource] !== undefined) return true; // 4
      }
      // 3: 替えた後に、今は無い建てる手が出てくるか
      if (!buildKeysNow) buildKeysNow = new Set(moves.filter((x) => x.buildCandidateKey).map((x) => x.buildCandidateKey));
      const clone = cloneState(state);
      const r = applyInPlace(clone, index, m);
      if (!r || !r.success) return false;
      const after = this.generateMoves(clone, index, playerId, { ...context, noDeferConversion: true });
      return after.some((x) => x.buildCandidateKey && !buildKeysNow.has(x.buildCandidateKey));
    });
  }

  // #placeDieMovesで試しに置いた結果(ダイスごとの行ける所)。#bareTapMovesの「目を変える前に行ける所」に使い回す
  // (2026-11-25, per user「まだありそうですか」→「すべておねがい」-- #dieReachableOutcomesで同じ置き方をもう一度
  // 試していた)。同じ盤面(state)の時だけ使う。
  #placeOutcomes = null; // { state, byDie: Map(dieId -> Set) }

  #placeDieMoves(state, index, playerId, player) {
    const moves = [];
    const outcomesByDie = new Map();
    this.#placeOutcomes = { state, byDie: outcomesByDie };
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed);
    const diceWithAPlacement = new Set();
    const predictionCache = new Map(); // board.placeDiceのcontext.predictionCache参照(同じ盤面からの確かめを使い回す)
    for (const die of unplacedDice) {
      // JOB003/道化 (2026-08-19) or B001B's SET_WILDCARD (2026-10-19, per-die): a wildcard die never uses
      // placeDice's own slotIndex-based path -- see #wildcardPlaceDieMoves' own doc. Checked per-die
      // (not hoisted above the loop) so a B001B-flagged die among otherwise-normal dice only diverts
      // itself, not every other die this same player still places normally.
      const dieIsWildcard = board.isDieWildcard(state, index, playerId, die);
      for (const mapId of Object.keys(state.maps)) {
        if (this.#isMapIdAvoided(state, mapId)) continue;
        if (this.#isOrphanageHeldBack(state, mapId)) continue;
        if (dieIsWildcard) {
          if (this.#wildcardPlaceDieMoves(state, index, playerId, die, mapId, moves)) diceWithAPlacement.add(die.id);
          continue;
        }
        const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
        const slotCount = board.getSlotRequirements(areaRow).length;
        if (!outcomesByDie.has(die.id)) outcomesByDie.set(die.id, new Set());
        const outcomes = outcomesByDie.get(die.id);
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          if (board.placeDiceQuickReject(state, index, { playerId }, die.id, mapId, slotIndex)) continue; // 確実に置けないマスはコピーせずに飛ばす
          const clone = cloneState(state);
          const result = board.placeDice(clone, index, { playerId, predictionCache }, die.id, mapId, slotIndex);
          if (!result.success) continue;
          // 建てるカードの候補があるのに1枚も払えない所には置かない(人もできない) (2026-11-25, per user「皇帝宮殿（何も取らない）できるの」→「できない手は 候補に入れない」-- 画面では、建てるカードの候補がある時は必ずどれかを建てる(✖は置いたのを取り消すだけ)。払えるカードが1枚も無い時も、人は取り消すしかない)。
          const pendingBuildHere = result.actionResult && result.actionResult.pendingBuild;
          if (pendingBuildHere && !pendingBuildHere.candidates.some((c) => board.isCandidateAffordable(clone, index, playerId, c))) continue;
          diceWithAPlacement.add(die.id);
          if (result.actionResult && result.actionResult.pendingBuild) {
            for (const candidate of result.actionResult.pendingBuild.candidates) outcomes.add(`${mapId}|${slotIndex}|${candidate.faceId || candidate.toFaceId}`);
          } else {
            outcomes.add(`${mapId}|${slotIndex}|NONE`);
          }
          // 試しに置いた盤面(clone)を、点数をつける時に使い回す(simulator.jsのrememberPlacedDryRun参照)。
          const remember = (move, shared) => { rememberPlacedDryRun(move, state, clone, result, shared); return move; };
          if (result.actionResult && result.actionResult.pendingBuild) {
            const candidates = result.actionResult.pendingBuild.candidates;
            for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
              moves.push(remember({ type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex, buildCandidateIndex, buildCandidateKey: buildCandidateKey(candidates[buildCandidateIndex]) }, true));
            }
            // 「置くだけで建てない」手は出さない (2026-11-25, per user「皇帝宮殿（何も取らない）できるの」→「できない手は 候補に入れない」-- 画面では、建てるカードの候補がある時は必ずどれかを建てる(✖は置いたのを取り消すだけ)。払えるカードが1枚も無い時も、人は取り消すしかない)。2026-07-31の「払えるカードが無くて手が0になる」は、上で
            // 払えるカードが無い所には置かない(diceWithAPlacementに入れない=どこにも置けなければPASS_DIEが出る)ことで防ぐ。
            // A BUILD trigger with 0 candidates (NO_BUILDABLE_CARD) still placed the die legally --
            // that's just placeDice's success:true/actionResult.success:false case below, already
            // covered since result.actionResult.pendingBuild would be absent then.
          } else {
            moves.push(remember({ type: 'PLACE_DIE', playerId, dieId: die.id, mapId, slotIndex }, false));
          }
        }
      }
    }
    // PASS_DIE only offered for a die with ZERO legal placements anywhere (2026-08-03, per user
    // feedback: "AIは基本的にパスをしないように出来ませんか" -- same "only when actually necessary"
    // pattern already applied to free actions). Passing is meant as a deadlock escape hatch (a die with
    // no legal slot would otherwise force the AI to face the same still-unplaceable die every cycle,
    // matching the human-facing pass button's own purpose), not a normal candidate the Evaluator gets to
    // weigh against a real placement -- doing that unconditionally is exactly what caused the AI to
    // default to passing almost every turn (found 2026-08-03: 13 passes vs 1 placement in one round,
    // even after correcting a passed die's score -- see evaluator.js's own comment on that fix).
    for (const die of unplacedDice) {
      if (!diceWithAPlacement.has(die.id)) moves.push({ type: 'PASS_DIE', playerId, dieId: die.id });
    }
    // ラウンドパス(残りのダイスを全部パス、画面のラウンドパスボタンと同じ)も候補にする (2026-11-25, per user「AIラウンドパスはできないの」「ラウンドパスが AIもできるようになれば」「孤児院に置かなくても 解決」「ラウンドパスのほうが まし」)。
    // パスしたダイスはラウンドの終わりに1個3Kになる(評価もその値、evaluator.js参照)ので、置いても3Kより得をしない時に選ばれる。
    // R4は置ける所があればラウンドパスしない (2026-11-26 Ver.1.1744, per user「R4は ラウンドパスしない (何もできないとき除く)」)。
    // ゲームの最後なので〇3を取っておく理由がない。
    if (unplacedDice.length > 0 && ((state.round || 1) < 4 || diceWithAPlacement.size === 0)) moves.push({ type: 'PASS_DIE', playerId, dieId: unplacedDice[0].id, allDice: true });
    return moves;
  }

  /** #placeDieMoves' wildcard branch (JOB003/道化, 2026-08-19): board.placeWildcardDie auto-assigns the
   * slot itself, so this only tries die x mapId, never a slotIndex loop -- mirrors the non-wildcard
   * PLACE_DIE branch's pendingBuild/candidate handling exactly, just emitting PLACE_WILDCARD_DIE instead
   * (no slotIndex field at all, since the caller never chose one).
   * EX-vs-ANY choice (2026-08-28, see board.wildcardExAnyChoice's own doc and this file's own top-of-file
   * doc): when that returns non-null, tries BOTH slot indices (each dry-run via a fresh clone, same as
   * every other candidate here) and offers whichever succeed as separate Moves, each carrying its own
   * slotIndex -- letting the Evaluator actually choose, rather than silently defaulting to whichever slot
   * the AREA's own SLOT1-6 order happens to list first. Returns true iff this mapId yielded at least one
   * legal placement, so the caller can track diceWithAPlacement for the PASS_DIE fallback the same way. */
  #wildcardPlaceDieMoves(state, index, playerId, die, mapId, moves) {
    const exAnyChoice = board.wildcardExAnyChoice(state, index, { playerId }, mapId);
    const slotOptions = exAnyChoice ? [exAnyChoice.exSlotIndex, exAnyChoice.otherSlotIndex] : [undefined];
    let placedAny = false;
    for (const slotIndex of slotOptions) {
      const clone = cloneState(state);
      const result = board.placeWildcardDie(clone, index, { playerId }, die.id, mapId, slotIndex);
      if (!result.success) continue;
      const pendingBuildHere = result.actionResult && result.actionResult.pendingBuild;
      if (pendingBuildHere && !pendingBuildHere.candidates.some((c) => board.isCandidateAffordable(clone, index, playerId, c))) continue; // #placeDieMoves参照
      placedAny = true;
      const moveBase = { type: 'PLACE_WILDCARD_DIE', playerId, dieId: die.id, mapId, ...(slotIndex !== undefined ? { slotIndex } : {}) };
      if (result.actionResult && result.actionResult.pendingBuild) {
        const candidates = result.actionResult.pendingBuild.candidates;
        for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
          moves.push({ ...moveBase, buildCandidateIndex, buildCandidateKey: buildCandidateKey(candidates[buildCandidateIndex]) });
        }
      } else {
        moves.push({ ...moveBase });
      }
    }
    return placedAny;
  }

  /** PLACE_DICE_GROUP (2026-08-21, per user request -- see board.placeDiceGroup's own doc): AI-side
   * enumeration of multi-die monument-building placements at 王宮(CASTLE_MAP_ID)/元老院(AREA009_MAP_ID),
   * the only 2 maps board.placeDiceGroup supports.
   *
   * Pairs (sum > 6, since a single die already reaches <=6 via #placeDieMoves) plus, as of 2026-10-15,
   * triples (sum > 12, since a pair already reaches up to 12 via the loop just above) -- per user
   * request, after discovering board.placeDiceGroup itself (and main.js's own human-facing selection UI,
   * whose doc comment already says "2+ selected dice") never actually capped group size at 2 -- only
   * this AI move generator had singled out pairs-only, a 2026-08-21 implementation choice that simply
   * never grew past its own original "let the AI place 2 dice together" request, leaving the AI unable
   * to reach M402/天空の塔's DICE>=13 at all without a die-boosting ability (max pair = 12, one short).
   * Capped at triples, not arbitrary N: 13 is the single highest DICE threshold across every monument in
   * the current data (data/game.json's own M sheet), and 3 dice already reach up to 18, so a 4th die
   * could never help any monument that exists today -- and would only add combinatorial cost for no
   * benefit. Triples are deliberately never tried for a sum a pair already covers (<=12), same "don't
   * spend more dice than needed" filter the pair loop already applies relative to a single die -- this
   * keeps the added cost bounded to just the specific 13-18 range pairs can't reach, not every possible
   * triple (addressing the user's own concern about this growing the search space needlessly).
   *
   * A 道化 (JOB003, hasWildcardDice) player can never use this path at all (see board.placeDiceGroup's
   * own WILDCARD_GROUP_NOT_ALLOWED refusal), so this returns early for them rather than wasting dry-run
   * clones that would always fail. A B001B-flagged die (SET_WILDCARD, per-die, 2026-10-19) gets the same
   * refusal but only for itself -- excluded from unplacedDice below rather than bailing the whole player,
   * so their other, still-normal dice can still group-place together. */
  #placeDiceGroupMoves(state, index, playerId, player) {
    const moves = [];
    if (board.hasWildcardDice(state, index, playerId)) return moves;
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed && !d.isWildcardThisTurn);
    for (let i = 0; i < unplacedDice.length; i++) {
      for (let j = i + 1; j < unplacedDice.length; j++) {
        const dieA = unplacedDice[i];
        const dieB = unplacedDice[j];
        if (dieA.value + dieB.value <= 6) continue;
        this.#tryDiceGroupCombo(state, index, playerId, [dieA, dieB], moves);
      }
    }
    for (let i = 0; i < unplacedDice.length; i++) {
      for (let j = i + 1; j < unplacedDice.length; j++) {
        for (let k = j + 1; k < unplacedDice.length; k++) {
          const dieA = unplacedDice[i];
          const dieB = unplacedDice[j];
          const dieC = unplacedDice[k];
          if (dieA.value + dieB.value + dieC.value <= 12) continue;
          this.#tryDiceGroupCombo(state, index, playerId, [dieA, dieB, dieC], moves);
        }
      }
    }
    return moves;
  }

  /** Shared dry-run/candidate-enumeration body for #placeDiceGroupMoves's pair and triple loops
   * (factored out 2026-10-15 when triples were added, to avoid duplicating this between them) -- tries
   * `dice` (2 or 3 Die objects) as one PLACE_DICE_GROUP at each of the 2 maps board.placeDiceGroup
   * supports, pushing one Move per affordability-unfiltered build candidate (plus the unresolved-build
   * fallback), same as #placeDieMoves' own pendingBuild/buildCandidateIndex handling -- byte-for-byte
   * the same logic the old inline pair-only version had, just reusable for either group size now. */
  #tryDiceGroupCombo(state, index, playerId, dice, moves) {
    const dieIds = dice.map((d) => d.id);
    for (const mapId of [board.CASTLE_MAP_ID, board.AREA009_MAP_ID]) {
      const clone = cloneState(state);
      const result = board.placeDiceGroup(clone, index, { playerId }, dieIds, mapId);
      if (!result.success) continue;
      if (result.actionResult && result.actionResult.pendingBuild) {
        const candidates = result.actionResult.pendingBuild.candidates;
        for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
          moves.push({ type: 'PLACE_DICE_GROUP', playerId, dieIds, mapId, buildCandidateIndex, buildCandidateKey: buildCandidateKey(candidates[buildCandidateIndex]) });
        }
        // 「置くだけで建てない」手は出さない(#placeDieMoves参照、2026-11-25)。
      } else {
        moves.push({ type: 'PLACE_DICE_GROUP', playerId, dieIds, mapId });
      }
    }
  }

  #freeActionMoves(state, index, playerId, player) {
    const moves = [];
    for (const freeActionId of ['A_K', 'B_K', 'C_K', 'Z_K']) {
      if (player.freeActionTaps[freeActionId]) continue;
      const clone = cloneState(state);
      const result = executor.tryFreeAction(clone, index, playerId, freeActionId);
      if (result.success) moves.push({ type: 'FREE_ACTION', playerId, freeActionId });
    }
    return moves;
  }

  /** 上限(暴食など)の無い資源の使用料があれば、それを取る手(AIは何より先に取る -- generateMovesの使用料の説明参照)。
   * 選択待ちがある時は取らない。 */
  forcedImmediateFeeMove(state, index, playerId) {
    if ((state.pendingChoices || []).some((c) => c.playerId === playerId)) return null;
    const fees = this.#feeCollectionMoves(state, playerId);
    if (fees.length === 0) return null;
    const limits = executor.activeResourceLimits(state, index, playerId);
    return fees.find((m) => limits[state.maps[m.mapId].accumulatedFeeResource || 'K'] === undefined) || null;
  }

  #feeCollectionMoves(state, playerId) {
    const moves = [];
    for (const [mapId, mapState] of Object.entries(state.maps)) {
      if (mapState.feeOwnerId === playerId && mapState.accumulatedFee > 0) {
        moves.push({ type: 'COLLECT_FEE', playerId, mapId });
      }
    }
    return moves;
  }

  #bareTapMoves(state, index, playerId, player, context) {
    const moves = [];
    const beforeOutcomesByDie = new Map();
    const afterOutcomesByDie = new Map();
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      const bareTap = bareTapKind(index, cardState.currentFaceId);
      if (!bareTap) continue;
      // ダイスの目を変える/オールマイティにするだけのタップ(基礎学問・高等学問・幾何学)は、この手番でもうダイスを
      // 置いた後は使わない (2026-11-23, per user「ダイスを置いた後に基礎学問や高等学問を使おうとする 意味がないので
      // 使わないように」) -- 置かなかったダイスの目はターン終了で元に戻る(executor.jsのvalueChangedThisTurn)ので、
      // 1ラウンド1回のタップを無駄にするだけ。宮廷人(MONUMENT_CHANGE_DIE_VALUE)は1資源軽減も付くので対象外。
      if (context && context.hasPlacedDieThisTurn && DIE_ONLY_TAP_KINDS.has(bareTap.kind)) continue;
      const unplacedDice = player.dice.filter((d) => d.placedMapId === null);
      if (bareTap.kind === 'IMMEDIATE') {
        const clone = cloneState(state);
        const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
        if (!result.success) continue;
        // Skip a genuine no-op (2026-08-31, per user report: watching a replay, an AI player tapped
        // C003A/商人LV1's CHANGE(K,C,3) at 0K -- board.useBareTapAbility still returns success:true for a
        // 0-times CHANGE (see executor.runChange's own "times <= 0" doc), so without this check
        // MoveGenerator would keep offering a completely inert tap that ties the Evaluator's score with
        // "do nothing" and can win that tie purely by generation order. Compares the WHOLE player object
        // (not just the CHANGE's own resources) so a tap with a genuine non-resource side effect --
        // GRANT_PLACE_ANYWHERE, a die-value set, etc. -- is never mistaken for a no-op.
        const beforePlayer = state.players.find((p) => p.id === playerId);
        const afterPlayer = clone.players.find((p) => p.id === playerId);
        if (JSON.stringify(beforePlayer) === JSON.stringify(afterPlayer)) continue;
        // A BZ-conversion tap (e.g. JOB004A's "CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)") is never
        // offered as a normal scored candidate unless a build outlet actually exists for the BZ it
        // would generate (2026-08-06, per user feedback: "AIは建築しないときはJOB004をTAPしない
        // （できない）"). forcedBzConversionMove already *forces* this exact tap whenever an outlet
        // DOES exist (see its own doc) -- that short-circuits AIPlayer.selectMove before
        // generateMoves is even reached for that top-level decision, so this branch only matters
        // when no outlet exists there *or* when generateMoves is called directly for a simulated
        // lookahead node (Simulator's deeper search isn't gated by the top-level short-circuit).
        // Either way: closes the loophole where the Evaluator could still pick this tap as a normal
        // candidate purely because its flat per-unit BZ weight doesn't know BZ evaporates unused at
        // TURNEND (see evaluator.js's own resource-weight loop) -- confirmed via
        // tools/ai_batch_run.js that this was dragging down JOB004's measured average score.
        if (bzConversionTap(index, cardState.currentFaceId) && !this.#hasAffordableBuildOutlet(clone, index, playerId, context)) continue;
        moves.push({ type: 'BARE_TAP', playerId, physicalId });
      } else if (bareTap.kind === 'BUILD') {
        const clone = cloneState(state);
        const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
        if (result.success && result.pendingBuild) {
          // Unlike #placeDieMoves, no "leave the build unresolved" fallback here: board.useBareTapAbility
          // returns pendingBuild *before* paying anything or tapping the card (see its own doc), so
          // declining every candidate would be a true no-op -- same state in, same state out. Offering
          // it as a Move let AIPlayer's first-max-wins tie-break pick it forever (found 2026-08-02:
          // ai-batch-5 looped on B006A's BUILD-kind TAP indefinitely, since a no-op move ties every
          // other move's score and this one sorted before END_TURN).
          for (let buildCandidateIndex = 0; buildCandidateIndex < result.pendingBuild.candidates.length; buildCandidateIndex++) {
            // buildCandidateKey: R4の読み切りの「同じ点ならカードを早く取る(LVアップも)」が研究などのタップも数えるように (2026-11-25)
            moves.push({ type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex, buildCandidateKey: buildCandidateKey(result.pendingBuild.candidates[buildCandidateIndex]) });
          }
        }
      } else if (bareTap.kind === 'MONUMENT_CHANGE_DIE_VALUE') {
        // Needs a die but no value/delta (the delta is a single fixed number baked in at DSL-lowering
        // time -- see bareTapKind's own doc). Same bzConversionTap gating as the IMMEDIATE branch above
        // (JOB007's own TAP grants BZ, same shape) -- forcedBzConversionMove already forces this whenever
        // a build outlet exists; this branch only matters when one doesn't (or for a simulated lookahead
        // node the top-level short-circuit doesn't gate).
        const isBz = bzConversionTap(index, cardState.currentFaceId);
        for (const die of unplacedDice) {
          const tapContext = { playerId, chosenDieId: die.id };
          const clone = cloneState(state);
          const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
          if (!result.success) continue;
          if (isBz && !this.#hasAffordableBuildOutlet(clone, index, playerId, context)) continue;
          moves.push({ type: 'BARE_TAP', playerId, physicalId, chosenDieId: die.id });
        }
        // skipDieChange (2026-09-06, per user request: "+3したい対象がないとき +3しなくても軽減能力だけ
        // でも使えるようにして ダイスやカードの候補に+3しないを加える"): always offered alongside the
        // per-die candidates above, not just as a fallback when unplacedDice is empty -- the rest of the
        // TAP program (ADD(BZ), BLOCK_BUILD) is worth using on its own even when a die exists but isn't
        // worth spending on +3. See executor.runMonumentChangeDieValue's own doc for the skip itself.
        {
          const tapContext = { playerId, skipDieChange: true };
          const clone = cloneState(state);
          const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
          if (result.success && !(isBz && !this.#hasAffordableBuildOutlet(clone, index, playerId, context))) {
            moves.push({ type: 'BARE_TAP', playerId, physicalId, skipDieChange: true });
          }
        }
      } else if (bareTap.kind === 'SET_WILDCARD') {
        // B001B's SET_WILDCARD(SELF,THIS_TURN) (2026-10-19): just a die choice, no value dimension at all
        // (unlike SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE just below, which all iterate bareTap.choices
        // -- bareTap.choices is undefined here, so falling through to that shared branch would throw).
        // Offered for every unplaced die unconditionally rather than trying to reuse #dieReachableOutcomes'
        // "only if it's a genuinely new outcome" filter (that helper assumes board.placeDice, which a
        // wildcarded die never goes through -- see the hasWildcardDice branch's own doc just below): making
        // a die wildcard always meaningfully changes what it can reach, so there's no no-op case to skip.
        for (const die of unplacedDice) {
          const tapContext = { playerId, chosenDieId: die.id };
          const clone = cloneState(state);
          const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
          if (!result.success) continue;
          moves.push({ type: 'BARE_TAP', playerId, physicalId, chosenDieId: die.id });
        }
      } else if (board.hasWildcardDice(state, index, playerId)) {
        // 道化(JOB003)'s own ☆ dice ignore VALUE_MISMATCH entirely and their buildValue is category-fixed
        // (1 for A/B/C, 6 for monument -- see board.placeWildcardDie's own doc), never dependent on the
        // die's own .value at all -- so a SET_DICE_ANY/SET_DIE_VALUE/CHANGE_DIE_VALUE tap can NEVER change
        // what a ☆-owning player can reach with any die, for any value. #dieReachableOutcomes below
        // assumes board.placeDice (the non-wildcard path), which doesn't reflect ☆'s real placement rules
        // -- rather than adapting it for a case that's provably always a no-op anyway, this player is
        // simply never offered these taps at all (2026-08-28, part of the same gating this whole branch
        // exists for -- see the other branch's own doc).
      } else {
        // SET_DICE_ANY / SET_DIE_VALUE / CHANGE_DIE_VALUE -- needs a die + a value/delta up front
        // (the whole TAP field runs as one atomic program, see board.useBareTapAbility's own doc).
        // Only offered once it lets THIS SPECIFIC die reach a genuinely NEW outcome (mapId/slotIndex/
        // resulting card) it couldn't already reach at its original value (2026-08-28, per user spec:
        // "置かないダイスにダイス変換を使わない 結果がだいたい同じときは（同じSLOTにおけて同じカードが
        // 獲得できるとき、残すダイスが違ってもOK）ダイス変換を使わない" -- refining the earlier
        // #hasAffordableBuildOutlet gate, which only checked "is there an outlet ANYWHERE on the board",
        // not whether THIS die specifically ends up used for it, or whether the outlet was reachable
        // without converting at all. A die whose value changes this turn but never gets PLACED that same
        // turn silently reverts at TURNEND (see executor.js's own valueChangedThisTurn revert), so either
        // gap left the once-per-round tap burnable for nothing.
        const values = bareTap.kind === 'SET_DICE_ANY' ? [1, 2, 3, 4, 5, 6] : bareTap.choices;
        for (const die of unplacedDice) {
          // 同じ目・同じ状態のダイスなら行ける所も同じなので、1回調べた結果を使い回す (2026-11-23、速くするため)。
          const beforeKey = `${die.kind}|${die.value}|${die.placeAnywhereThisTurn}|${die.isWildcardThisTurn}|${die.passed}`;
          if (!beforeOutcomesByDie.has(beforeKey)) {
            const known = this.#placeOutcomes && this.#placeOutcomes.state === state ? this.#placeOutcomes.byDie.get(die.id) : null;
            beforeOutcomesByDie.set(beforeKey, known || this.#dieReachableOutcomes(state, index, playerId, die.id));
          }
          const outcomesBefore = beforeOutcomesByDie.get(beforeKey);
          for (const value of values) {
            const tapContext = { playerId, chosenDieId: die.id };
            if (bareTap.kind === 'CHANGE_DIE_VALUE') tapContext.chosenDelta = value;
            else tapContext.chosenValue = value;
            const clone = cloneState(state);
            const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
            if (!result.success) continue;
            const changed = clone.players.find((p) => p.id === playerId).dice.find((d) => d.id === die.id);
            const afterKey = `${physicalId}|${changed.kind}|${changed.value}|${changed.placeAnywhereThisTurn}|${changed.isWildcardThisTurn}`;
            if (!afterOutcomesByDie.has(afterKey)) afterOutcomesByDie.set(afterKey, this.#dieReachableOutcomes(clone, index, playerId, die.id));
            const outcomesAfter = afterOutcomesByDie.get(afterKey);
            const hasNewOutcome = [...outcomesAfter].some((o) => !outcomesBefore.has(o));
            if (!hasNewOutcome) continue;
            moves.push({
              type: 'BARE_TAP', playerId, physicalId, chosenDieId: die.id,
              ...(bareTap.kind === 'CHANGE_DIE_VALUE' ? { chosenDelta: value } : { chosenValue: value }),
            });
          }
        }
      }
    }
    return moves;
  }

  #tapReactionMoves(state, playerId) {
    const moves = [];
    for (const choice of state.pendingChoices) {
      if (choice.playerId !== playerId || choice.kind !== 'TAP_REACTION_AVAILABLE') continue;
      moves.push({ type: 'TAP_REACTION', playerId, choiceId: choice.id, use: true });
      moves.push({ type: 'TAP_REACTION', playerId, choiceId: choice.id, use: false });
    }
    return moves;
  }

  /** Forces one step of the deterministic ABC->Z conversion plan (board.planFeeConversion, see its own
   * doc for the exact order/rationale) whenever an unpaid usage fee (player.pendingFee) exceeds current
   * K (2026-08-31, per user spec: "順番は機械的にABCの多い順 一緒ならABCの順 ABCが足りなければZ それでも
   * 足りなければ-1VP...AIがそれを理解したうえでこの順を選ぶのならそれでいい"). Returns just the FIRST
   * conversion the plan calls for, as a single FREE_ACTION move -- same one-step-per-call idiom as every
   * other forced move here (e.g. forcedTrainingGroundKPrepMove's own free-action branch): the next
   * selectMove/#greedyMove call re-derives the plan fresh against the now-updated resources and forces
   * the next step, naturally converging until either K covers the fee or the plan comes back empty
   * (nothing left in A/B/C/Z to convert) -- at which point this returns null and the pre-existing TURNEND
   * "missing K -> -1VP" rule (executor.applyTurnEnd, now actually reachable thanks to canEndTurn's
   * matching 2026-08-31 fix excluding K itself from its own USAGE_FEE gate) settles the remainder. */
  /** 色欲+権力者のAIは、本物のAを全部Kに変える(フリーアクションA→K)(2026-11-02, ユーザー指示「AIは自動で」
   * 「人間は手動で」)。権力者のAの支払いは 〇→Z〇→赤〇 (色欲あり, executor.resolvePayment) なので、Kが無いと
   * 本物のAを持っていてもZが先に減る。Kは赤〇の支払いにもKの支払いにも最初に使われるのでAをKにしても払える物は
   * 変わらず、ゲーム終了時の強欲/宝物庫は applyPowerBrokerGameEndTopUp がKをAに戻して補う。1回に1個ずつ
   * (ほかの forced move と同じ1手ずつの形)、Aが0になるまで続く。 */
  forcedLustPowerBrokerAKMove(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || !((player.resources.A || 0) > 0)) return null;
    if (!executor.hasPaymentChoiceAbility(state, playerId) || !executor.hasPowerBrokerAbility(state, index, playerId)) return null;
    if (player.freeActionTaps && player.freeActionTaps.A_K) return null;
    return { type: 'FREE_ACTION', playerId, freeActionId: 'A_K' };
  }

  forcedFeeConversionMove(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || !player.pendingFee || (player.pendingFee.resource || 'K') !== 'K') return null; // 〇以外の使用料は変換で払えない(足りなければ-1VP)
    const shortfall = player.pendingFee.amount - (player.resources.K || 0);
    if (shortfall <= 0) return null;
    const plan = board.planFeeConversion(player.resources, shortfall);
    if (plan.length === 0) return null;
    return { type: 'FREE_ACTION', playerId, freeActionId: `${plan[0].resource}_K` };
  }

  /** Forces an unconditional TAP whenever the player owns an untapped instance of a pure-resource-gain
   * C-tier card (2026-08-31, per user request, following a replay review where the AI's greedy 1-ply
   * rollout kept passing over 貴族/C004's ADD(A,K) -- ranked outside the beam purely because its own
   * immediate score looked unremarkable, even though tapping it was a free, no-downside prerequisite for
   * a much better build a few moves later): 貴族/司教/金貸し/農場主/聖女/王女, both LV1 and LV2
   * (PURE_GAIN_C_FACES) -- deliberately excludes 代官/修道士/商人 (C001-C003, both tiers), whose
   * CHANGE(K,...)-shaped taps spend real K that some other action this same turn/round might still need;
   * forcing those unconditionally could do real harm, unlike this group's plain ADD(...) grants, which are
   * never worse and often better done as soon as possible (more resources available for whatever this
   * player decides next, this same turn). One unconditional rule covers both triggers the user asked for
   * ("獲得した時" and "ラウンド初め") -- a freshly-built card is untapped by construction, and the
   * universal round-start untap makes every one of these untapped again every round, so both moments
   * naturally satisfy the same "owned and untapped" check with no separate logic needed.
   *
   * No-op guard: some of these can legitimately have zero effect right now (e.g. ADD(wD) at
   * player.whiteDiceCap) -- compares the whole player object before/after, same technique #bareTapMoves'
   * own IMMEDIATE-branch no-op fix uses, so this never forces a tap that would burn the card for nothing. */
  forcedPureGainCTap(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    // 農場主(LV1のADD(3K)もLV2のADD(6K)も)は、Kに上限がある時(暴食のRESOURCE_LIMIT(K,7)など)は必ずはタップしない (2026-11-24, per user
    // 「使用料と同じにする：暴食のときは、Kが必要になった(建てる・払う)ときにだけタップし、それ以外は普通の候補として点数で
    // 比べる 農場主」、LV1も同じに: 「農場主は考えるように」) -- 普通のタップの候補として点数で比べる(点数は上限を超えたKが
    // ターン終了で減ることも入れて見る)。
    const kLimited = executor.activeResourceLimits(state, index, playerId).K !== undefined;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped || !PURE_GAIN_C_FACES.has(cardState.currentFaceId)) continue;
      if (kLimited && (cardState.currentFaceId === 'C201A' || cardState.currentFaceId === 'C201B')) continue;
      const clone = cloneState(state);
      const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
      if (!result.success) continue;
      const beforePlayer = state.players.find((p) => p.id === playerId);
      const afterPlayer = clone.players.find((p) => p.id === playerId);
      if (JSON.stringify(beforePlayer) === JSON.stringify(afterPlayer)) continue;
      return { type: 'BARE_TAP', playerId, physicalId };
    }
    return null;
  }

  /** Finds playerId's forced BZ-conversion bare TAP (e.g. JOB004A's "CHANGE(3K,2BZ)"), if one is
   * currently legal AND would actually get spent on a build before this turn ends, and returns it as a
   * ready-to-apply Move -- or null if none applies. Unlike every other move category above, this is NOT
   * offered as a candidate for AIPlayer to weigh against alternatives: AIPlayer.selectMove calls this
   * FIRST and short-circuits straight to it when non-null, skipping generateMoves/Evaluator entirely for
   * that decision (2026-08-04, per user feedback: "JOB004の効果は使えるときは必ず使う"). Two reasons this
   * needed to be unconditional (within its now-gated scope) rather than left as a normal scored
   * candidate: (1) a simple 1-ply Evaluator can't see that converting K into BZ pays off later via an
   * otherwise-unaffordable build (that's the whole point of BZ), so leaving it to compete on score alone
   * was undervaluing it; (2) making it a forced pre-step (not a MoveGenerator candidate) costs nothing
   * extra in the search -- if anything it *shrinks* the branching factor by one move whenever it applies,
   * rather than growing it.
   *
   * `context` (2026-08-0X, per user feedback: "BZはターン終了時に無くなります...AIもBZを作る→無くなる
   * ということをしないようにしてください"): BZ used to be safe to bank ahead of time since it never
   * expired, but now it's lost the moment this turn ends (see executor.applyTurnEnd), so blindly forcing
   * this conversion whenever legal -- regardless of whether anything this turn could actually spend it --
   * would just as often waste it as use it (e.g. a turn where the die already went on a non-BUILD AREA
   * and no BUILD-kind bare TAP is available). Gated on there being at least one build-resolving move
   * (PLACE_DIE/BARE_TAP carrying a buildCandidateIndex) reachable in the state *after* this
   * conversion -- if none exists, this returns null and falls through to the normal scored candidates
   * instead (the plain CHANGE(3K,2BZ) is still offered there via #bareTapMoves' IMMEDIATE case; the
   * Evaluator's raw resource weights should reject it on their own when there's truly nothing to spend it
   * on, without needing another special case here). See bzConversionTap for the detection rule and
   * simulator.js's own doc for the unrelated "always use *already-held* BZ on a BUILD's payment" half of
   * this feature, which needed no change -- BZ still can't outlive the turn it's spent in either way.
   *
   * **Corrected 2026-08-04** (per user feedback: "JOB004のAIの平均点が低すぎます 3K→2BZ 使えていますか？"
   * -- investigation found this was firing far more than intended): "reachable" here used to mean only
   * "some buildCandidateIndex-carrying move exists", but #placeDieMoves/#bareTapMoves deliberately don't
   * affordability-filter their buildCandidateIndex candidates (see #placeDieMoves' own doc -- that's
   * left to Simulator, since getBuildCandidates only checks dice/category eligibility). That made this
   * force JOB004's conversion any time *any* build was dice-reachable at all, whether or not the
   * resulting build could actually be paid for -- confirmed via tests/ai-move-generator.smoke.js's own
   * existing case, which asserted a forced fire with a player holding 0 A/B/C resources (nothing to
   * build with regardless of BZ). Burning 3K and BLOCK_BUILD(M,THIS_TURN) for a build that then fails
   * outright is a pure loss with no offsetting upside -- exactly the kind of AI misplay that would drag
   * down JOB004's measured average score in tools/ai_data_report.js. Now actually simulates each
   * candidate via applyInPlace (the same payment pipeline, incl. maxBzDiscount, the real move commits
   * with later) and only forces the conversion if at least one of them would actually succeed.
   *
   * dieCandidates (2026-08-25, fixing the same bareTapKind gap described in that function's own doc --
   * JOB007's own "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+1);BLOCK_BUILD(...)" is a bzConversionTap shape
   * that ALSO needs a chosenDieId; the single `{playerId}`-only attempt below always failed for it with
   * no die ever supplied, so this force could never fire (per user report: "宮廷人 AIの使用回数が0です")):
   * tries every unplaced die in turn for a MONUMENT_CHANGE_DIE_VALUE-shaped tap, `[null]` (a single
   * no-choice attempt, unchanged) for every other bzConversionTap shape.
   *
   * chooseDieTap (2026-10-29, per user request "AIが宮廷人を正しく使えるように" + "2Rいこうで 同じモニュメント
   * を選ぶなら小さい目から使う" + "資源軽減があるので建てられるときは使った方がいいに決まっている"): optional.
   * When given, a MONUMENT_CHANGE_DIE_VALUE-shaped tap (宮廷人) no longer takes the FIRST die that yields a
   * build outlet -- every working die choice (plus skipDieChange) is collected as
   * {move, clone(after the tap)} and chooseDieTap(state, candidates) picks one (AIPlayer#chooseCourtierTap:
   * best resulting build, smaller die for the same build from round 2). Whether to tap at all is unchanged
   * (still forced whenever a build outlet exists). Without it, the old first-match behavior stays. */
  forcedBzConversionMove(state, index, playerId, context, chooseDieTap) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      if (!bzConversionTap(index, cardState.currentFaceId)) continue;
      const needsDieChoice = bareTapKind(index, cardState.currentFaceId).kind === 'MONUMENT_CHANGE_DIE_VALUE';
      // skipDieChange (2026-09-06, per user request -- see executor.runMonumentChangeDieValue's own doc):
      // tried last, after every real die, so a genuinely useful die-value bump is still preferred over
      // skipping it outright -- but this force should still fire (for the sake of ADD(BZ) alone) when no
      // die is worth it or none exists at all, rather than never firing for this card the way it used to.
      const dieCandidates = needsDieChoice ? [...player.dice.filter((d) => d.placedMapId === null), null] : [null];
      const working = [];
      for (const die of dieCandidates) {
        const tapContext = die ? { playerId, chosenDieId: die.id } : needsDieChoice ? { playerId, skipDieChange: true } : { playerId };
        const clone = cloneState(state);
        const result = board.useBareTapAbility(clone, index, tapContext, physicalId);
        if (!result.success) continue;
        if (this.#hasAffordableBuildOutlet(clone, index, playerId, context)) {
          const move = { type: 'BARE_TAP', playerId, physicalId, ...(die ? { chosenDieId: die.id } : needsDieChoice ? { skipDieChange: true } : {}) };
          if (!(needsDieChoice && chooseDieTap)) return move;
          working.push({ move, clone });
        }
      }
      if (working.length > 0) return chooseDieTap(state, working) || working[0].move;
    }
    return null;
  }

  /** 料理人/JOB004 (2026-08-28, per user request/experiment: "料理人は3K以上あれば基本的に毎ターン使うでどう
   * でしょうか これで逆に弱くなるようなら戻します" -- prompted by a report that AI LV4 passed up a
   * 料理人→終わりの兆しLV2→鐘楼 combo because the immediate score of converting 3K->2Z alone doesn't reflect
   * the build it can enable 1-2 moves later, so a beam/rollout search can prune it before ever discovering
   * that value): forces CHANGE(3K,2Z) unconditionally whenever the player owns an untapped JOB004 with
   * >=3K, with NO build-outlet check -- deliberately simpler than forcedBzConversionMove's own gating.
   * JOB004's TAP no longer grants BZ at all (a 2026-08-24 data edit changed it to grant plain Z instead),
   * so bzConversionTap/forcedBzConversionMove don't recognize this card's current shape any more -- this
   * is a separate, JOB004-specific mechanism rather than broadening that BZ-specific one, since the
   * intended policy genuinely differs (always force here, vs. only-when-useful there). JOB004's own
   * TURNEND=UNTAP() means this can fire again every single turn, not just once per round -- revert this
   * (per the user's own framing) if it turns out to make JOB004 weaker in practice.
   *
   * Usage-fee guard (2026-08-30, per user bug report: a live game froze after leveling up 元老院LV2 with
   * 4K, this firing and spending 3K down to 1K, leaving the AREA009 usage fee unpayable -- "3Kあったら
   * 必ず使う→手数料をひいて3K余るなら使う"): now also requires that 3K would still be left over AFTER
   * paying whatever pending usage fee this player owes (player.pendingFee.amount) -- a strategic choice to
   * avoid an easily-avoidable VP loss (see executor.canEndTurn's own USAGE_FEE VP-escape doc: an unpayable
   * fee is no longer a hard deadlock, just -1VP per missing K), not a hard block (2026-09-14: the
   * player.lockedK reservation this used to also check was removed -- see board.js's
   * chargeUsageFeeIfOwed's own doc -- so this is now just the plain pendingFee amount). */
  forcedJob004ConversionMove(state, index, playerId) {
    // Cost is 4K, not 3 (2026-10-11 found via a real stuck-game regression: 料理人's own TAP cost grew
    // 3K->4K earlier this session, CHANGE(3K,2Z)->CHANGE(4K,(A,B,C)), but this affordability pre-check
    // was never updated to match -- a player with exactly 3K passed this stale "< 3" gate as
    // "affordable", so the forced move got selected every turn, failed to actually apply (truly needs
    // 4K), and the AI got stuck re-selecting the same doomed forced move forever, never reaching
    // END_TURN). See forcedJob004ConversionMove's own doc for the rest of this gate's reasoning.
    // 2026-10-27: the K cost is now read from JOB011's own TAP text (CHANGE(4K,(A,B,C)) -> CHANGE(3K,2Z), per
    // user's game.xlsx edit "料理人変更しました") instead of a hardcoded number, so a future cost edit can't
    // leave this gate stale again.
    const costMatch = /^CHANGE\((\d*)K,/.exec(getCardRow(index, 'JOB011').TAP || '');
    if (!costMatch) return null;
    const costK = costMatch[1] ? Number(costMatch[1]) : 1;
    const player = state.players.find((p) => p.id === playerId);
    if (!player || (player.resources.K || 0) < costK) return null;
    const reservedK = pendingKFee(player);
    if ((player.resources.K || 0) - costK < reservedK) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped || cardState.currentFaceId !== 'JOB011') continue; // 料理人 (2026-10-13 A/B-revert renamed the id to JOB011; function name kept as-is)
      return { type: 'BARE_TAP', playerId, physicalId };
    }
    return null;
  }

  /** 終わりの兆しLV2/B202B (2026-08-28, per user request: "終わりの兆しLV2は獲得できるカードがあれば
   * すぐ使うようにしてください 使用対象が複数の時はダイス目高いほうを優先で" -- "ダイス目" here means the
   * MONUMENT's own DICE threshold (e.g. ">=12" vs ">=11"), not a real placed die -- B202B's own
   * TAP="BUILD(M,12)" has a fixed buildValue, no die involved at all): forces the tap unconditionally
   * whenever at least one monument candidate is genuinely affordable, picking whichever affordable
   * candidate has the HIGHEST DICE threshold when more than one qualifies -- a higher-threshold monument
   * is harder to reach via an ordinary die (solo max 6, PLACE_DICE_GROUP max 12) or other cards, so this
   * spends B202B's fixed-12 reach on whichever one benefits most from it, not just the first one found.
   * Unlike #bareTapMoves' own BUILD branch (which offers every reachable candidate as a separate scored
   * Move, dice/category-eligible but not affordability-filtered -- see getBuildCandidates' own doc), this
   * actually simulates each one via applyInPlace to find which are real options, same as
   * #hasAffordableBuildOutlet's own approach.
   *
   * Usage-fee guard (2026-08-30, per user request, extending the same class of guard already added to
   * forcedJob004ConversionMove/forcedTrainingGroundMove): a candidate that would leave an already-pending
   * usage fee unaffordable is skipped, same as those two. Unlike those two (a flat K cost), a monument's
   * COST can be any mix of A/B/C/K, so this checks the *resulting* player's post-build resources against
   * board.canAffordFee (K + every free-action-convertible resource) rather than a precomputed K amount. */
  forcedEndSignLv2Move(state, index, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped || cardState.currentFaceId !== 'B202B') continue;
      const clone = cloneState(state);
      const result = board.useBareTapAbility(clone, index, { playerId }, physicalId);
      if (!result.success || !result.pendingBuild) continue;
      let bestIndex = null;
      let bestThreshold = -Infinity;
      for (let i = 0; i < result.pendingBuild.candidates.length; i++) {
        const move = { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex: i };
        const tryClone = cloneState(state);
        if (!applyInPlace(tryClone, index, move).success) continue;
        const afterPlayer = tryClone.players.find((p) => p.id === playerId);
        if (pendingKFee(afterPlayer) && !board.canAffordFee(afterPlayer, pendingKFee(afterPlayer))) continue;
        const candidate = result.pendingBuild.candidates[i];
        const faceId = candidate.faceId || candidate.toFaceId;
        const match = /^>=(\d+)$/.exec(getCardRow(index, faceId).DICE || '');
        const threshold = match ? Number(match[1]) : -Infinity;
        if (threshold > bestThreshold) {
          bestThreshold = threshold;
          bestIndex = i;
        }
      }
      if (bestIndex !== null) return { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex: bestIndex };
    }
    return null;
  }

  /** How much K MAP007's own current face spends per die placed there, via its CHANGE(nK,D) ACTION --
   * 0 for AREA007A/C (CHANGE((A,B,C),D)/ADD(D), no K involved). Shared by forcedTrainingGroundMove's own
   * pendingFee guard and forcedTrainingGroundKPrepMove's "do I even have enough yet" check --
   * factored out (2026-08-30) so both stay correct together as this amount keeps changing (2026-08-25
   * "訓練場LV1　能力変えました" added CHANGE(K,D); 2026-08-30 "訓練場すこしかえました" raised it to
   * CHANGE(2K,D)). */
  /** 訓練場がKの要る段階(LV1、CHANGE(nK,D))の時、タップ(研究など、BUILD(U)のタップ)で訓練場の支配をLV1→LV2に上げられる
   * なら、その手。訓練場の支配LV2を取ると訓練場がLV2(ADD(D)、Kが要らない)になるので、K作り(A/B/C→K)やKを払って置くより
   * 先にLVを上げる (2026-11-25, per user のナビのバグ報告「B→Kを推奨しているのなぜ」→「先にやる意味はない さらに 研究で LVあげるから意味がない」)。上げられなければnull。 */
  #trainingGroundUpgradeTap(state, index, playerId) {
    if (this.#trainingGroundKCost(index, state) === 0) return null;
    const player = state.players.find((p) => p.id === playerId);
    if (!player || !player.ownedCardPhysicalIds.some((id) => state.cards[id] && state.cards[id].currentFaceId === 'A202A')) return null;
    for (const physicalId of player.ownedCardPhysicalIds) {
      const cardState = state.cards[physicalId];
      if (!cardState || cardState.tapped) continue;
      const tap = bareTapKind(index, cardState.currentFaceId);
      if (!tap || tap.kind !== 'BUILD') continue;
      const probe = cloneState(state);
      const result = board.useBareTapAbility(probe, index, { playerId }, physicalId);
      if (!result.success || !result.pendingBuild) continue;
      const candidates = result.pendingBuild.candidates;
      for (let buildCandidateIndex = 0; buildCandidateIndex < candidates.length; buildCandidateIndex++) {
        const c = candidates[buildCandidateIndex];
        if (c.type !== 'UPGRADE' || c.fromFaceId !== 'A202A') continue;
        const move = { type: 'BARE_TAP', playerId, physicalId, buildCandidateIndex, buildCandidateKey: buildCandidateKey(c) };
        try {
          if (applyInPlace(cloneState(state), index, move).success) return move;
        } catch (e) { /* 払えない */ }
      }
    }
    return null;
  }

  #trainingGroundKCost(index, state) {
    const areaRow = getAreaRow(index, state.maps.MAP007.currentAreaId);
    const match = /^CHANGE\((\d*)K,D\)$/.exec(areaRow.ACTION || '');
    return match ? Number(match[1] || 1) : 0;
  }

  /** 訓練場の支配/A202A・A202B (2026-08-28, per user request: "訓練場の支配も獲得したら必ずすぐに訓練場に
   * ダイスを置いて追加色ダイスを獲得するようにしてほしい"; scoped to "新しい色ダイスが得られる時だけ強制"
   * per follow-up confirmation): forces a PLACE_DIE at 訓練場(MAP007) whenever the player owns either
   * face AND some unplaced die's placement there would genuinely raise their own COLOR-dice count (not
   * just "the placement succeeds" -- a placement that succeeds without a net gain, e.g. once already at
   * whatever cap applies, is left alone so the player's own turn choice/normal search still picks whatever
   * else looks best). Mirrors board.js's own AREA007-tier CHANGE((A,B,C),D)/CHANGE(K,D)/ADD(D) shapes by
   * just diffing color-dice count before/after a real dry-run placement, rather than re-deriving each
   * tier's own resource math here. Only offered while this player hasn't already placed a die this turn
   * (context.hasPlacedDieThisTurn), same PLACE_DIE-family gating as everywhere else. Skipped entirely for
   * a wildcard-owning (道化/JOB003) player -- their dice all need board.placeWildcardDie instead of
   * board.placeDice below (see #placeDieMoves' own dieIsWildcard branch); this rare combination (owning
   * BOTH JOB003 and A202A/B) is left to the normal search rather than adding a second placement path here.
   *
   * Usage-fee guard (2026-08-30, per user request: "使用料を認識して払えるように", same class of bug as
   * forcedJob004ConversionMove's own matching guard): building/owning 訓練場 makes this player its own
   * feeOwnerId (see executor.runSetCurrentArea), so placing on their own copy never incurs a NEW fee here
   * -- but if some OTHER fee is already pending from earlier this same turn, spending this AREA's own K
   * cost on top of it is a strategic choice to avoid (see executor.canEndTurn's own USAGE_FEE VP-escape
   * doc: an unpayable fee is no longer a hard deadlock, just -1VP per missing K) -- checked explicitly
   * here since this is a FORCED move, not something the normal search would otherwise weigh against
   * itself (2026-09-14: the player.lockedK reservation this used to also check was removed -- see
   * board.js's chargeUsageFeeIfOwed's own doc -- so this is now just the plain pendingFee amount). */
  forcedTrainingGroundMove(state, index, playerId, context) {
    if (context.hasPlacedDieThisTurn) return null;
    const player = state.players.find((p) => p.id === playerId);
    if (!player || board.hasWildcardDice(state, index, playerId)) return null;
    const ownsControl = player.ownedCardPhysicalIds.some((physicalId) => {
      const cardState = state.cards[physicalId];
      return cardState && (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B');
    });
    if (!ownsControl) return null;
    const upgradeFirst = this.#trainingGroundUpgradeTap(state, index, playerId); // Kを払って置くより先にLVを上げる
    if (upgradeFirst) return upgradeFirst;
    const kCost = this.#trainingGroundKCost(index, state);
    const reservedK = pendingKFee(player);
    if (kCost > 0 && (player.resources.K || 0) - kCost < reservedK) return null;
    const beforeColorCount = player.dice.filter((d) => d.kind === 'COLOR').length;
    // Excludes a B001B-flagged die too (per-die SET_WILDCARD, 2026-10-19) -- same reasoning as the
    // player-wide hasWildcardDice bail just above, just scoped to this one die instead of the whole
    // player (board.placeDice below doesn't apply to it; board.placeWildcardDie would, but that's not
    // this heuristic's concern -- see this function's own top doc).
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed && !d.isWildcardThisTurn);
    const areaRow = getAreaRow(index, state.maps.MAP007.currentAreaId);
    const slotCount = board.getSlotRequirements(areaRow).length;
    for (const die of unplacedDice) {
      for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
        const clone = cloneState(state);
        const result = board.placeDice(clone, index, { playerId }, die.id, 'MAP007', slotIndex);
        if (!result.success) continue;
        const afterPlayer = clone.players.find((p) => p.id === playerId);
        const afterColorCount = afterPlayer.dice.filter((d) => d.kind === 'COLOR').length;
        if (afterColorCount > beforeColorCount) {
          return { type: 'PLACE_DIE', playerId, dieId: die.id, mapId: 'MAP007', slotIndex };
        }
      }
    }
    return null;
  }

  /** 訓練場の支配所有時、Kが無ければ先にKを用意する (2026-08-30, per user request: "ただしKがなくてダイス
   * が２個以上残っているなら小麦畑か農園のKが多く獲得できる方にいってその次に訓練場　ダイスが最後の一こ
   * なら　ABCのいずれかをKに変えて訓練場に行く"): forcedTrainingGroundMove above only ever succeeds once
   * the player actually has enough K on hand to spend on 訓練場's own CHANGE(nK,D) -- with too little K it
   * dry-run-fails every slot and returns null, silently falling through to whatever the normal search
   * picks instead. This fills that gap: with 2+ dice left, force a placement at whichever of 小麦畑
   * (MAP001)/農園(MAP002) currently yields more K (comparing their own live ACTION field, not a hardcoded
   * LEVEL, since either could be independently upgraded); with exactly 1 die left, spend a free action
   * converting whichever of A/B/C the player holds the most of into K (2026-08-30, per user confirmation
   * on ties/multiple) -- free actions don't consume the die or set hasPlacedDieThisTurn, so the very next
   * selectMove/#greedyMove call this same turn re-checks forcedTrainingGroundMove, which will now succeed
   * and place the last die at 訓練場. K-needed comes from #trainingGroundKCost (0 for AREA007C's ADD(D),
   * which needs no K at all) rather than being hardcoded here, since the exact amount has already changed
   * twice (2026-08-25 "訓練場LV1　能力変えました" added CHANGE(K,D); 2026-08-30 "訓練場すこしかえました"
   * raised it to CHANGE(2K,D)) and could again. */
  forcedTrainingGroundKPrepMove(state, index, playerId, context) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || board.hasWildcardDice(state, index, playerId)) return null;
    const ownsControl = player.ownedCardPhysicalIds.some((physicalId) => {
      const cardState = state.cards[physicalId];
      return cardState && (cardState.currentFaceId === 'A202A' || cardState.currentFaceId === 'A202B');
    });
    if (!ownsControl) return null;
    const kNeeded = this.#trainingGroundKCost(index, state);
    if (kNeeded === 0 || (player.resources.K || 0) >= kNeeded) return null;
    if (!context.hasPlacedDieThisTurn) {
      const upgradeFirst = this.#trainingGroundUpgradeTap(state, index, playerId); // K作りより先にLVを上げる
      if (upgradeFirst) return upgradeFirst;
    }
    // Excludes a B001B-flagged die too -- same reasoning as forcedTrainingGroundMove's own matching doc.
    const unplacedDice = player.dice.filter((d) => d.placedMapId === null && !d.passed && !d.isWildcardThisTurn);
    if (unplacedDice.length === 0) return null;
    if (unplacedDice.length >= 2) {
      if (context.hasPlacedDieThisTurn) return null;
      let best = null;
      for (const mapId of ['MAP001', 'MAP002']) {
        const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
        const match = /^ADD\((\d+)K\)$/.exec(areaRow.ACTION || '');
        if (!match) continue;
        const yieldK = Number(match[1]);
        if (!best || yieldK > best.yieldK) best = { mapId, yieldK };
      }
      if (!best) return null;
      const areaRow = getAreaRow(index, state.maps[best.mapId].currentAreaId);
      const slotCount = board.getSlotRequirements(areaRow).length;
      for (const die of unplacedDice) {
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          const clone = cloneState(state);
          if (board.placeDice(clone, index, { playerId }, die.id, best.mapId, slotIndex).success) {
            return { type: 'PLACE_DIE', playerId, dieId: die.id, mapId: best.mapId, slotIndex };
          }
        }
      }
      return null;
    }
    // この手番にもうダイスを置いた後は、次に訓練場へ置けるのは次の手番なので、今Kを作らない (2026-11-25, per user のナビの
    // バグ報告「B→Kを推奨しているのなぜ」-- 訓練場でもらった新しい色ダイスを「最後の1個」と見て、置いた後にまたA/B→Kをしていた)。
    if (context.hasPlacedDieThisTurn) return null;
    const candidates = ['A', 'B', 'C'].filter((r) => (player.resources[r] || 0) > 0);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => player.resources[b] - player.resources[a]);
    return { type: 'FREE_ACTION', playerId, freeActionId: `${candidates[0]}_K` };
  }

  /** Whether some build-resolving move (PLACE_DIE/BARE_TAP carrying a buildCandidateIndex)
   * in clone would actually succeed if applied right now -- shared by forcedBzConversionMove (deciding
   * whether to force a BZ-conversion tap) and #bareTapMoves' IMMEDIATE branch (deciding whether to even
   * offer one as a normal candidate when it isn't forced -- see that branch's own comment). */
  #hasAffordableBuildOutlet(clone, index, playerId, context) {
    const buildMoves = this.generateMoves(clone, index, playerId, context)
      .filter((m) => m.buildCandidateIndex !== undefined);
    return buildMoves.some((m) => applyInPlace(cloneState(clone), index, m).success);
  }

  /** Every (mapId, slotIndex, outcome) dieId could legally, effectively reach right now in `state` --
   * outcome is the built/upgraded faceId for a BUILD-resolving placement, or 'NONE' for a plain
   * AREA-effect resolution. Used by #bareTapMoves' die-value-change gating (2026-08-28, per user spec:
   * "置かないダイスにダイス変換を使わない 結果がだいたい同じときは...ダイス変換を使わない") to compare
   * one die's reach before vs after a value-change TAP -- keyed by the actual resulting card rather than
   * a candidate array INDEX, since indices from two different dry-run calls aren't comparable (the whole
   * point here is diffing this die's reach across two different states). Mirrors #placeDieMoves' own
   * per-slot dry-run loop, scoped to one die. Never called for a wildcard-owning player (see the call
   * site's own comment on why that case is skipped entirely instead). */
  #dieReachableOutcomes(state, index, playerId, dieId) {
    const outcomes = new Set();
    const predictionCache = new Map(); // board.placeDiceのcontext.predictionCache参照
    for (const mapId of Object.keys(state.maps)) {
      if (this.#isMapIdAvoided(state, mapId)) continue;
      if (this.#isOrphanageHeldBack(state, mapId)) continue;
      const areaRow = getAreaRow(index, state.maps[mapId].currentAreaId);
      const slotCount = board.getSlotRequirements(areaRow).length;
      for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
        if (board.placeDiceQuickReject(state, index, { playerId }, dieId, mapId, slotIndex)) continue;
        const clone = cloneState(state);
        const result = board.placeDice(clone, index, { playerId, predictionCache }, dieId, mapId, slotIndex);
        if (!result.success) continue;
        // #placeDieMovesと同じく、払えるカードが1枚も無い所は行ける所に入れない(2026-11-25)。
        const pendingBuildHere = result.actionResult && result.actionResult.pendingBuild;
        if (pendingBuildHere && !pendingBuildHere.candidates.some((c) => board.isCandidateAffordable(clone, index, playerId, c))) continue;
        if (result.actionResult && result.actionResult.pendingBuild) {
          for (const candidate of result.actionResult.pendingBuild.candidates) {
            outcomes.add(`${mapId}|${slotIndex}|${candidate.faceId || candidate.toFaceId}`);
          }
        } else {
          outcomes.add(`${mapId}|${slotIndex}|NONE`);
        }
      }
    }
    return outcomes;
  }
}

/** A bare (direct, non-ON-wrapped) TAP ability built from a CHANGE(...) or ADD(...) command that grants
 * BZ -- e.g. JOB007's "ADD(BZ);MONUMENT_CHANGE_DIE_VALUE(SELF+2);BLOCK_BUILD(A,THIS_TURN);BLOCK_BUILD(B,
 * THIS_TURN);BLOCK_BUILD(C,THIS_TURN)" (2026-08-07: generalized from CHANGE-only to also cover ADD,
 * since JOB007 grants BZ for free rather than converting another resource into it -- JOB004 used to be
 * the CHANGE-based example, "CHANGE(3K,2BZ);BLOCK_BUILD(M,THIS_TURN)", until its own TAP dropped BZ
 * entirely on 2026-08-24 in favor of CHANGE(3K,2Z); no card grants BZ via CHANGE any more today, but the
 * CHANGE branch below is kept since bzConversionTap is meant to recognize this *shape*, not one specific
 * card. The BLOCK_BUILD half is a side-effect restriction, not a second thing this ability "does", so it
 * doesn't disqualify the shape; MONUMENT_DICE_DISCOUNT was added to the same allowed-side-effects set
 * 2026-08-18 when JOB007's TAP grew that clause, and MONUMENT_CHANGE_DIE_VALUE joined it 2026-08-24 when
 * that same clause was replaced with a fixed dice-value change instead of a discount).
 * Returns the lowered CHANGE/ADD command, or null if faceId has no TAP field, no BZ grant is there, or
 * the field has some other statement besides CHANGE/ADD/BLOCK_BUILD/MONUMENT_DICE_DISCOUNT/
 * MONUMENT_CHANGE_DIE_VALUE. See MoveGenerator#forcedBzConversionMove's own doc for why this is treated
 * as forced rather than a normal candidate. Deliberately not scoped to any one card: any future card
 * with the same shape (a bare BZ grant, optionally paired with one of those side effects) gets the same
 * forced treatment automatically. */
function bzConversionTap(index, faceId) {
  let row;
  try { row = getCardRow(index, faceId); } catch (e) { return null; }
  if (!row.TAP) return null;
  const commands = lowerProgram(parse(row.TAP));
  const bzCmd = commands.find((c) => (c.type === 'CHANGE' && c.gain.some((g) => g.resource === 'BZ'))
    || (c.type === 'ADD' && c.items.some((i) => i.resource === 'BZ')));
  if (!bzCmd) return null;
  const SIDE_EFFECT_TYPES = new Set(['BLOCK_BUILD', 'MONUMENT_DICE_DISCOUNT', 'MONUMENT_CHANGE_DIE_VALUE']);
  const onlyBzGrantAndSideEffects = commands.every((c) => c === bzCmd || SIDE_EFFECT_TYPES.has(c.type));
  return onlyBzGrantAndSideEffects ? bzCmd : null;
}

module.exports = { MoveGenerator, bareTapKind, bzConversionTap };

})();
