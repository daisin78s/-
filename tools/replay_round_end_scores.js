/**
 * For each replay JSON, computes every player's AI-LV4-eval-table-based "評価点" at the END of each
 * round (1-4) -- 2026-09-12, per user request: "評価店ベースで何点あるか計算してくれませんか 評価店は
 * AILV4のgameのものを使う 例 1R終了時 3K 1A 追加ダイス2なら 3*3=9 1*5=5 2*50=100 など".
 *
 * "Round N end" snapshot = the LAST replay entry with state.round===N (round is a plain integer field
 * that steps 1->2->3->4, no separate ROUND_END phase marker exists in GameState -- see turn-flow.js).
 *
 * The TOTAL for each player is the real, unmodified `Evaluator.score()` (game.xlsx's own live table,
 * AI LV4's own real policy: {qstAware, conBuildAware, monumentIncentiveAware}, see main.js's own
 * aiEvaluatorLv4) -- authoritative, matches exactly what the real in-game AI LV4 would see. Alongside
 * that total, this also breaks out the "basic" resource/dice terms score() itself computes early on
 * (K/A/B/C/VP counts x their round weight, unplaced/passed color dice, unplaced white dice) as separate
 * line items, matching the user's own example's shape; every remaining contribution (owned card face
 * values, con-build/monument/QST synergy bonuses -- score()'s own later, harder-to-decompose terms) is
 * reported as a single lump "その他(カード/シナジー等)" line so every row's own numbers still sum to
 * exactly the authoritative total instead of silently mismatching it.
 *
 * Usage: node tools/replay_round_end_scores.js <outputJsonPath> <replayJsonPath>=<label>[:isHuman]... [...]
 *   label identifies the replay in the output (e.g. "リプレイ1"); isHuman (optional, comma-separated
 *   playerId, e.g. "P1") marks which seat is the human -- purely a display flag, doesn't affect scoring.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable, evalValue } = require('../src/ai/eval-table');
const { Evaluator } = require('../src/ai/evaluator');
const executor = require('../src/executor');

const DATA_PATH = path.join(__dirname, '..', 'data', 'game.json');

function parseArgs() {
  const [outputPath, ...specs] = process.argv.slice(2);
  if (!outputPath || specs.length === 0) {
    console.error('Usage: node tools/replay_round_end_scores.js <outputJsonPath> <replayJsonPath>=<label>[:humanPlayerId] [...]');
    process.exit(1);
  }
  const replays = specs.map((spec) => {
    const eq = spec.lastIndexOf('=');
    const replayPath = spec.slice(0, eq);
    const rest = spec.slice(eq + 1);
    const colon = rest.indexOf(':');
    return colon === -1
      ? { replayPath, label: rest, humanPlayerId: null }
      : { replayPath, label: rest.slice(0, colon), humanPlayerId: rest.slice(colon + 1) };
  });
  return { outputPath: path.resolve(outputPath), replays };
}

/** Reproduces Evaluator.score()'s own "basic" resource/dice terms (lines 169-191 of evaluator.js) as
 * separate {label, count, weight, contribution} line items, for display purposes only -- the real
 * total is always computed separately via the real Evaluator, never reconstructed by summing these. */
function basicBreakdown(state, index, player, evalTable, round) {
  const v = (id) => evalValue(evalTable, round, id);
  const resourceLimits = executor.activeResourceLimits(state, index, player.id);
  const items = [];
  for (const resource of ['K', 'A', 'B', 'C']) {
    const have = player.resources[resource] || 0;
    const limit = resourceLimits[resource];
    const count = limit !== undefined ? Math.min(have, limit) : have;
    if (count !== 0) items.push({ label: resource, count, weight: v(resource), contribution: count * v(resource) });
  }
  const vp = player.resources.VP || 0;
  if (vp !== 0) items.push({ label: 'VP', count: vp, weight: v('VP'), contribution: vp * v('VP') });

  const unplacedColor = player.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null && !d.passed).length;
  const passedColor = player.dice.filter((d) => d.kind === 'COLOR' && d.placedMapId === null && d.passed).length;
  const unplacedWhite = player.dice.filter((d) => d.kind === 'WHITE' && d.placedMapId === null).length;
  if (unplacedColor !== 0) items.push({ label: '未使用色ダイス(D)', count: unplacedColor, weight: v('D'), contribution: unplacedColor * v('D') });
  if (passedColor !== 0) items.push({ label: 'パス済み色ダイス(K換算x3)', count: passedColor, weight: v('K') * 3, contribution: passedColor * v('K') * 3 });
  if (unplacedWhite !== 0) items.push({ label: '未使用白ダイス(wD)', count: unplacedWhite, weight: v('wD'), contribution: unplacedWhite * v('wD') });

  return items;
}

function main() {
  const { outputPath, replays } = parseArgs();
  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evalTable = buildEvalTable(raw);
  const evaluator = new Evaluator(index, evalTable, { qstAware: true, conBuildAware: true, monumentIncentiveAware: true });

  const output = [];
  for (const { replayPath, label, humanPlayerId } of replays) {
    const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    const humanIds = humanPlayerId ? humanPlayerId.split(',') : [];
    const rounds = [];
    for (let round = 1; round <= 4; round++) {
      let snapshot = null;
      for (const state of replay) { if (state.round === round) snapshot = state; }
      if (!snapshot) continue;
      const players = snapshot.players.map((player) => {
        const items = basicBreakdown(snapshot, index, player, evalTable, round);
        const basicSum = items.reduce((s, it) => s + it.contribution, 0);
        const total = evaluator.score(snapshot, player.id);
        items.push({ label: 'その他(カード/シナジー等)', count: null, weight: null, contribution: total - basicSum });
        return { playerId: player.id, name: player.name, isHuman: humanIds.includes(player.id), items, total };
      });
      rounds.push({ round, players });
    }
    console.log(`${label} (${path.basename(replayPath)}): ${rounds.length} round(s) extracted`);
    output.push({ label, replayPath, rounds });
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
