/**
 * Compares a human's actual in-game decisions (from a main.js-exported replay JSON -- see main.js's own
 * "Move-by-move game replay" section, downloadReplayAsJson/#replay-download-button) against what an AI
 * level (src/ai/levels.js) would have picked at the exact same decision points (2026-09-06, per user
 * request: "人間のリプレイを見てAIの判断とどこが違うか分析することはできる？").
 *
 * The replay is just an array of GameState snapshots (one per real mutation), with no Move object
 * recorded alongside -- so for every point where turnFlow.getNextTurn says it's playerId's own TURN,
 * this reconstructs which Move was actually taken by generating every legal candidate (under BOTH
 * hasPlacedDieThisTurn values, since that flag isn't itself part of GameState -- see move-generator.js's
 * own context param) and applying each to a clone until one produces the NEXT snapshot exactly
 * (JSON-stringify equality, same convention this project's own tests already use for GameState
 * comparison). A transition that matches no candidate (e.g. several real actions collapsed into one
 * recorded snapshot) is silently skipped and counted, rather than guessed at.
 *
 * For every reconstructed decision, scores every candidate the same way AIPlayer.selectMove's own 1-ply
 * pass does (see ai-player.js's own doc) to rank where the human's actual move landed, and separately
 * calls the real aiPlayer.selectMove(...) (full lookahead/rollout included, e.g. LV4's own round-4 deep
 * search) to report what the AI would have *finally* done. The 1-ply score gap between the human's move
 * and the ranked-#1 candidate is the main "how much did this decision cost, by this eval-table's own
 * judgment" number -- 0 exactly when the human's move already was the top-ranked one.
 *
 * Onboarding (JOB/CON/RESOURCE picks) is NOT covered -- those aren't MoveGenerator Moves at all, and
 * smart-onboarding.js's own picks depend on tie-broken randomness; left as a possible follow-up rather
 * than guessed at here.
 *
 * Usage: node tools/analyze_human_replay.js <replayJsonPath> [playerId=P1] [aiLevel=LV4] [topN=15]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex, getAreaRow, getCardRow } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const { getLevel } = require('../src/ai/levels');
const { Evaluator } = require('../src/ai/evaluator');
const { MoveGenerator } = require('../src/ai/move-generator');
const { Simulator, applyInPlace } = require('../src/ai/simulator');
const { AIPlayer } = require('../src/ai/ai-player');
const turnFlow = require('../src/turn-flow');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');

function dieDesc(state, dieId) {
  for (const player of state.players) {
    const die = player.dice.find((d) => d.id === dieId);
    if (die) return `${die.kind}${die.wildcard ? '/☆' : ''}=${die.value}`;
  }
  return dieId;
}

function areaName(index, mapId, state) {
  const map = state.maps[mapId];
  if (!map) return mapId;
  try { return `${mapId}:${getAreaRow(index, map.currentAreaId).NAME || map.currentAreaId}`; } catch (e) { return mapId; }
}

function describeMove(state, index, move) {
  switch (move.type) {
    case 'PLACE_DIE':
    case 'PLACE_WILDCARD_DIE': {
      const slot = move.slotIndex !== undefined ? ` slot=${move.slotIndex}` : '';
      const build = move.buildCandidateIndex !== undefined ? ` buildCandidateIndex=${move.buildCandidateIndex}` : '';
      return `${move.type} die(${dieDesc(state, move.dieId)}) -> ${areaName(index, move.mapId, state)}${slot}${build}`;
    }
    case 'PLACE_DICE_GROUP': {
      const dice = move.dieIds.map((id) => dieDesc(state, id)).join(' + ');
      const build = move.buildCandidateIndex !== undefined ? ` buildCandidateIndex=${move.buildCandidateIndex}` : '';
      return `PLACE_DICE_GROUP dice(${dice}) -> ${areaName(index, move.mapId, state)}${build}`;
    }
    case 'PASS_DIE':
      return `PASS_DIE die(${dieDesc(state, move.dieId)})`;
    case 'BARE_TAP': {
      let name = move.physicalId;
      try { name = getCardRow(index, state.cards[move.physicalId].currentFaceId).NAME; } catch (e) { /* ignore */ }
      const build = move.buildCandidateIndex !== undefined ? ` buildCandidateIndex=${move.buildCandidateIndex}` : '';
      return `BARE_TAP ${move.physicalId}:${name}${build}`;
    }
    case 'END_TURN':
      return 'END_TURN';
    default:
      return `${move.type} ${JSON.stringify(move)}`;
  }
}

/** Every legal move for playerId at `state` under both possible hasPlacedDieThisTurn values, tagged with
 * which context produced it (a move can appear under both, e.g. END_TURN never does but BARE_TAP might --
 * kept as separate tagged entries rather than deduped, since the caller needs to know which context to
 * re-score/re-select under once a match is found). */
function candidatesForBothContexts(moveGenerator, state, index, playerId) {
  const out = [];
  for (const hasPlacedDieThisTurn of [false, true]) {
    for (const move of moveGenerator.generateMoves(state, index, playerId, { hasPlacedDieThisTurn })) {
      out.push({ move, hasPlacedDieThisTurn });
    }
  }
  return out;
}

function main() {
  const [replayPathArg, playerIdArg, aiLevelArg, topNArg] = process.argv.slice(2);
  if (!replayPathArg) {
    console.error('Usage: node tools/analyze_human_replay.js <replayJsonPath> [playerId=P1] [aiLevel=LV4] [topN=15]');
    process.exit(1);
  }
  const playerId = playerIdArg || 'P1';
  const levelName = aiLevelArg || 'LV4';
  const topN = topNArg ? Number(topNArg) : 15;

  const replay = JSON.parse(fs.readFileSync(replayPathArg, 'utf8'));
  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);
  const level = getLevel(levelName);
  const evaluator = new Evaluator(index, evalTable, level.evaluatorOptions);
  const moveGenerator = new MoveGenerator(level.moveGeneratorOptions);
  const simulator = new Simulator();
  const aiPlayer = new AIPlayer(index, moveGenerator, evaluator, simulator, level.aiOptions);

  const decisions = [];
  let reconstructed = 0;
  let skipped = 0;

  for (let i = 0; i < replay.length - 1; i++) {
    const state = replay[i];
    const nextState = replay[i + 1];
    if (state.phase === 'GAME_END') break;
    let next;
    try { next = turnFlow.getNextTurn(state); } catch (e) { continue; }
    if (next.type !== 'TURN' || next.playerId !== playerId) continue;

    const candidates = candidatesForBothContexts(moveGenerator, state, index, playerId);
    const nextStateJson = JSON.stringify(nextState);
    let matched = null;
    for (const candidate of candidates) {
      const clone = structuredClone(state);
      let result;
      try { result = applyInPlace(clone, index, candidate.move); } catch (e) { continue; }
      if (!result.success) continue;
      if (JSON.stringify(clone) === nextStateJson) { matched = candidate; break; }
    }
    if (!matched) { skipped++; continue; }
    reconstructed++;

    // 1-ply ranking of every candidate under the SAME context the matched move actually used -- mirrors
    // AIPlayer.selectMove's own first pass (see this file's own doc).
    const sameContextCandidates = candidates.filter((c) => c.hasPlacedDieThisTurn === matched.hasPlacedDieThisTurn);
    const scored = [];
    for (const candidate of sameContextCandidates) {
      const clone = structuredClone(state);
      const result = applyInPlace(clone, index, candidate.move);
      if (!result.success) continue;
      scored.push({ move: candidate.move, score: evaluator.score(clone, playerId) });
    }
    scored.sort((a, b) => b.score - a.score);
    const humanEntry = scored.find((s) => JSON.stringify(s.move) === JSON.stringify(matched.move));
    const humanScore = humanEntry ? humanEntry.score : null;
    // Competition ranking (2026-09-06 fix -- ties share the same rank, e.g. 3 moves tied for the best
    // score are all rank 1): a plain post-sort array index instead undercounted "matches" whenever the
    // human's move was tied for #1 but happened to land after another equally-scored candidate in
    // MoveGenerator's own generation order -- a meaningless tie-break artifact, not a real disagreement.
    const humanRank = humanScore === null ? null : 1 + scored.filter((s) => s.score > humanScore).length;
    const top = scored[0];

    let aiFinalMove = null;
    try { aiFinalMove = aiPlayer.selectMove(structuredClone(state), playerId, { hasPlacedDieThisTurn: matched.hasPlacedDieThisTurn }); } catch (e) { /* ignore */ }
    const aiFinalMatchesHuman = aiFinalMove && JSON.stringify(aiFinalMove) === JSON.stringify(matched.move);

    decisions.push({
      round: state.round,
      humanMove: matched.move,
      humanMoveDesc: describeMove(state, index, matched.move),
      humanScore,
      humanRank,
      candidateCount: scored.length,
      topMove: top ? top.move : null,
      topMoveDesc: top ? describeMove(state, index, top.move) : null,
      topScore: top ? top.score : null,
      gap: top && humanScore !== null ? top.score - humanScore : null,
      aiFinalMoveDesc: aiFinalMove ? describeMove(state, index, aiFinalMove) : null,
      aiFinalMatchesHuman,
    });
  }

  console.log(`Reconstructed ${reconstructed} of ${reconstructed + skipped} ${playerId} TURN decisions (${skipped} skipped -- no exact-match candidate found).`);
  const matchCount = decisions.filter((d) => d.humanRank === 1).length;
  console.log(`Human's move was the AI's own #1-ranked (1-ply) choice in ${matchCount}/${decisions.length} decisions (${((matchCount / decisions.length) * 100).toFixed(0)}%).`);
  const gaps = decisions.map((d) => d.gap || 0).sort((a, b) => a - b);
  const totalGap = gaps.reduce((sum, g) => sum + g, 0);
  const median = gaps.length % 2 === 1 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  // By construction the human's own move is always one of the ranked candidates, so the AI's #1 pick can
  // never score LOWER than it -- gap is always >= 0, exactly 0 only when they picked the identical move.
  // Total/mean is dominated by round 4's own much larger VP-weight scale (VP alone is worth 1000+ points
  // there vs 1 in round 1), so median and a per-round breakdown matter more than the raw total.
  console.log(`AI's #1 pick never scored lower than the human's actual move (by construction); it scored HIGHER in ${gaps.filter((g) => g > 0).length}/${decisions.length} decisions, tied (0 gap) in ${gaps.filter((g) => g === 0).length}.`);
  console.log(`Score gap when AI's pick was higher -- total: ${totalGap.toFixed(1)}, mean: ${(totalGap / gaps.length).toFixed(1)}, median: ${median.toFixed(1)} (round 4's own much larger VP-weight scale dominates the total/mean -- see per-round breakdown below).`);
  for (const round of [1, 2, 3, 4]) {
    const roundDecisions = decisions.filter((d) => d.round === round);
    if (roundDecisions.length === 0) continue;
    const roundGaps = roundDecisions.map((d) => d.gap || 0);
    const roundMatch = roundDecisions.filter((d) => d.humanRank === 1).length;
    console.log(`  Round ${round}: ${roundDecisions.length} decisions, human matched AI's #1 in ${roundMatch} (${((roundMatch / roundDecisions.length) * 100).toFixed(0)}%), mean gap=${(roundGaps.reduce((a, b) => a + b, 0) / roundGaps.length).toFixed(1)}`);
  }
  const finalMatchCount = decisions.filter((d) => d.aiFinalMatchesHuman).length;
  console.log(`Human's move matched the AI's FINAL pick (incl. lookahead/rollout) in ${finalMatchCount}/${decisions.length} decisions.`);

  const sorted = decisions.slice().sort((a, b) => (b.gap || 0) - (a.gap || 0));
  console.log(`\nTop ${topN} biggest disagreements (by 1-ply score gap):`);
  sorted.slice(0, topN).forEach((d, i) => {
    console.log(`\n#${i + 1} round=${d.round} gap=${d.gap === null ? 'n/a' : d.gap.toFixed(1)} (human rank ${d.humanRank}/${d.candidateCount})`);
    console.log(`  human chose: ${d.humanMoveDesc} (score=${d.humanScore === null ? 'n/a' : d.humanScore.toFixed(1)})`);
    console.log(`  AI's #1 pick: ${d.topMoveDesc} (score=${d.topScore === null ? 'n/a' : d.topScore.toFixed(1)})`);
    console.log(`  AI's actual final pick (with lookahead): ${d.aiFinalMoveDesc}${d.aiFinalMatchesHuman ? ' (matches human)' : ''}`);
  });
}

main();
