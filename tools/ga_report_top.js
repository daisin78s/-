/**
 * Reports the top N genomes from a tools/ga_train.js training run: for each, prints its full evaluated
 * eval-table (the "パラメーター" the user asked for) plus a fresh multi-game breakdown of 平均得点(素点,
 * QST抜き)/QST平均得点/合計(得点) -- 2026-08-27, per user request: "上位10のパラメーターと10戦の平均得点
 * 素点 クエスト 合計がしりたい". Re-plays fresh games rather than reusing the training run's own recorded
 * avgScore/avgRank, both because that number never separated QST from the rest, and because re-measuring
 * gives an independent check free of any single generation's small-sample noise.
 *
 * Games are seated by repeatedly shuffling the top-N pool into groups of 4 (same methodology
 * tools/ga_train.js's own evaluatePopulationFitness uses) until every genome has played at least
 * gamesPerGenome games -- gamesPerGenome=10 by default, matching the user's own "10戦".
 *
 * Usage: node tools/ga_report_top.js <trainingRunDir> [topN] [gamesPerGenome] [outputJsonPath] [generation]
 *   trainingRunDir: the tools/ga_train.js output directory (e.g. output/ga_train_run1).
 *   generation: which gen_XXXX.json to read (e.g. 50) -- defaults to the highest-numbered one present,
 *   i.e. whatever the run has completed so far (2026-08-27, added for the user's own "50世代ごとに上位10
 *   の出力" checkpoint requests -- lets this be run mid-training against gen_0050.json specifically,
 *   without racing a still-running trainer that's already moved on to writing gen_0051+).
 *   outputJsonPath: where to write the structured report (default output/ga_report_top.json) --
 *   tools/ga_report_write_xlsx.py reads this to build the actual .xlsx report (per user request, an
 *   Excel workbook rather than a raw console parameter dump -- see that script's own doc).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { Evaluator } = require('../src/ai/evaluator');
const { playGameForFitness } = require('../src/ai/game-runner');
const { buildResourceSynergyTable } = require('../src/ai/resource-card-synergy');
const { buildConJobSynergyTable } = require('../src/ai/con-job-synergy');
const { pickResourceCards } = require('../src/ai/smart-onboarding');
const rng = require('../src/rng');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dan'];

function findLatestGenerationFile(runDir) {
  const files = fs.readdirSync(runDir).filter((f) => /^gen_\d{4}\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error(`No gen_XXXX.json files found in ${runDir}`);
  return path.join(runDir, files[files.length - 1]);
}

function findGenerationFile(runDir, generation) {
  const filePath = path.join(runDir, `gen_${String(generation).padStart(4, '0')}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`${filePath} does not exist yet`);
  return filePath;
}

function main() {
  const runDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const topN = process.argv[3] ? Number(process.argv[3]) : 10;
  const gamesPerGenome = process.argv[4] ? Number(process.argv[4]) : 10;
  const outputJsonPath = process.argv[5] ? path.resolve(process.argv[5]) : path.join(PROJECT_ROOT, 'output', 'ga_report_top.json');
  const generationArg = process.argv[6] ? Number(process.argv[6]) : null;
  if (!runDir) {
    console.error('Usage: node tools/ga_report_top.js <trainingRunDir> [topN] [gamesPerGenome] [outputJsonPath] [generation]');
    process.exit(1);
  }

  const genFile = generationArg ? findGenerationFile(runDir, generationArg) : findLatestGenerationFile(runDir);
  const { generation, population } = JSON.parse(fs.readFileSync(genFile, 'utf8'));
  const top = population.slice(0, topN); // gen_XXXX.json's population is already sorted best-first
  console.log(`Loaded generation ${generation} from ${genFile}; re-measuring top ${top.length} genomes over >=${gamesPerGenome} games each.\n`);

  const raw = loadGameData(DATA_PATH);
  const index = buildDataIndex(raw);
  const evaluators = top.map((entry) => new Evaluator(index, entry.genome));

  // "AI LV4" smart onboarding (2026-08-27/28) -- re-measures under the same resource-card/JOB/CON
  // selection LV4 actually trains and plays with, not a random one.
  const synergyTable3 = buildResourceSynergyTable(raw);
  const synergyTable2 = buildConJobSynergyTable(raw);
  const resourceCardPicker = (candidateIds, state, idx, player) => pickResourceCards(candidateIds, state, idx, synergyTable3, player.conPhysicalId);

  const scoreSums = new Array(top.length).fill(0);
  const qstScoreSums = new Array(top.length).fill(0);
  const gamesPlayed = new Array(top.length).fill(0);

  const runRng = rng.createRng(`ga-report-${Date.now()}`);
  let gameCount = 0;
  while (Math.min(...gamesPlayed) < gamesPerGenome) {
    const order = rng.shuffle(runRng, top.map((_, i) => i));
    for (let g = 0; g + 4 <= order.length; g += 4) {
      const seatIndices = order.slice(g, g + 4);
      const evaluatorByPlayerId = {};
      seatIndices.forEach((idx, seat) => { evaluatorByPlayerId[`P${seat + 1}`] = evaluators[idx]; });
      const seed = `ga-report-${gameCount}`;
      gameCount++;
      const { scoreByPlayerId, qstScoreByPlayerId } = playGameForFitness(seed, PLAYER_NAMES, index, evaluatorByPlayerId, undefined, resourceCardPicker, synergyTable2);
      seatIndices.forEach((idx, seat) => {
        const playerId = `P${seat + 1}`;
        scoreSums[idx] += scoreByPlayerId[playerId];
        qstScoreSums[idx] += qstScoreByPlayerId[playerId] || 0;
        gamesPlayed[idx]++;
      });
    }
  }

  console.log(`(${gameCount} games played in total)\n`);
  const results = top.map((entry, i) => {
    const avgTotal = scoreSums[i] / gamesPlayed[i];
    const avgQst = qstScoreSums[i] / gamesPlayed[i];
    const avgRaw = avgTotal - avgQst;
    console.log(`#${i + 1}  合計=${avgTotal.toFixed(2)}  素点=${avgRaw.toFixed(2)}  クエスト=${avgQst.toFixed(2)}  (training avgRank=${entry.avgRank.toFixed(2)}, games=${gamesPlayed[i]})`);
    return {
      rank: i + 1,
      trainingAvgRank: entry.avgRank,
      trainingAvgScore: entry.avgScore,
      avgTotal,
      avgRaw,
      avgQst,
      gamesPlayed: gamesPlayed[i],
      genome: entry.genome,
    };
  });

  fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
  fs.writeFileSync(outputJsonPath, JSON.stringify({ sourceGeneration: generation, sourceFile: genFile, results }, null, 2));
  console.log(`\nWrote ${outputJsonPath}`);
}

main();
