/**
 * アンカー挑戦戦 (2026-10-27, per user request: "そろそろ 進化AIのアンカーを変更しようかと思う" -> 提案
 * 「試合数の多い上位の個体から候補を選び、今のアンカーと200試合ずつ対戦させ、はっきり勝った個体があれば新しい
 * アンカーにする」に "この方式でお願い" + "ついでに ALLxALLも" (= カード相性表にもこの対戦を数える)).
 *
 * GAの各個体は1世代4試合しかせず、エリートも成績を引き継がず毎世代やり直すため、gen_XXXX.jsonの1世代の
 * avgRankはほぼ運。そこで同じゲノムが残った世代をまとめて数え(--from-gen以降)、合計試合数がminGames以上の
 * ものからavgRank上位を候補にし、候補1体 + 今のアンカー(エクセルの評価値、buildEvalTable)3体の4人戦を
 * 盤面(seed)ごとに4席ローテーションで打たせる(ga_train.jsと同じ打ち方: --ai-levelのAI、ga_worker.js)。
 * 候補の平均順位が2.5より小さいほどアンカーより強い。盤面は全候補で共通(運の差を揃える)。
 *
 * 1試合ごとに<outDir>/games.jsonlへ追記し、途中で止めても再実行すれば続きから(終わった試合は飛ばす)。
 * 全試合をカード相性表(tools/card_pair_stats.js)にも数える(--no-pair-statsで無効)。
 *
 * Usage: node tools/ga_anchor_challenge.js <gaDir> <outDir> [--candidates=8] [--boards=50] [--min-games=16]
 *        [--from-gen=2892] [--ai-level=LV5] [--no-pair-stats]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { loadGameData } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');
const cardPairStats = require('./card_pair_stats');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ga_worker.js');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  if (positional.length < 2) {
    console.error('Usage: node tools/ga_anchor_challenge.js <gaDir> <outDir> [--candidates=8] [--boards=50] [--min-games=16] [--from-gen=2892] [--ai-level=LV5] [--no-pair-stats]');
    process.exit(1);
  }
  return {
    gaDir: path.resolve(positional[0]),
    outDir: path.resolve(positional[1]),
    candidateCount: Number(flag('candidates', 8)),
    boards: Number(flag('boards', 50)),
    minGames: Number(flag('min-games', 16)),
    fromGen: Number(flag('from-gen', 2892)),
    aiLevel: flag('ai-level', 'LV5'),
    pairStats: !argv.includes('--no-pair-stats'),
  };
}

const hashOf = (genome) => crypto.createHash('md5').update(JSON.stringify(genome)).digest('hex');

/** 同じゲノムが残った世代をまとめて数え、試合数minGames以上・avgRank上位をcount体。アンカー(どの世代にもいる)は除く。 */
function pickCandidates(gaDir, fromGen, minGames, count) {
  const files = fs.readdirSync(gaDir).filter((f) => /^gen_\d+\.json$/.test(f))
    .map((f) => [Number(f.match(/\d+/)[0]), f]).filter(([g]) => g >= fromGen).sort((a, b) => a[0] - b[0]);
  const byHash = new Map();
  for (const [gen, f] of files) {
    const { population } = JSON.parse(fs.readFileSync(path.join(gaDir, f), 'utf8'));
    for (const ind of population) {
      const h = hashOf(ind.genome);
      let e = byHash.get(h);
      if (!e) { e = { hash: h, firstGen: gen, lastGen: gen, gens: 0, games: 0, rankSum: 0, genome: ind.genome }; byHash.set(h, e); }
      e.lastGen = gen; e.gens++; e.games += ind.gamesPlayed; e.rankSum += ind.avgRank * ind.gamesPlayed;
    }
  }
  const all = [...byHash.values()];
  const anchorHash = all.slice().sort((a, b) => b.gens - a.gens)[0].hash;
  return all.filter((e) => e.hash !== anchorHash && e.games >= minGames)
    .map((e) => ({ ...e, gaAvgRank: e.rankSum / e.games }))
    .sort((a, b) => a.gaAvgRank - b.gaAvgRank)
    .slice(0, count);
}

/** 今のデータに無いIDは今の評価値で埋める(ga_train.jsのloadResumePopulationと同じ)。 */
function backfill(genome, realTable) {
  const out = {};
  for (const round of [1, 2, 3, 4]) {
    out[round] = {};
    for (const id of Object.keys(realTable[round])) {
      out[round][id] = genome[round] && genome[round][id] !== undefined ? genome[round][id] : (realTable[round][id] || 0);
    }
  }
  return out;
}

function summarize(candidates, doneGames) {
  return candidates.map((c, ci) => {
    const games = doneGames.filter((g) => g.candidateIndex === ci);
    const n = games.length;
    const rankSum = games.reduce((s, g) => s + g.candidateRank, 0);
    const rankSqSum = games.reduce((s, g) => s + g.candidateRank * g.candidateRank, 0);
    const avgRank = n ? rankSum / n : null;
    const sd = n > 1 ? Math.sqrt((rankSqSum - n * avgRank * avgRank) / (n - 1)) : null;
    return {
      name: c.name, hash: c.hash, gaGames: c.games, gaAvgRank: c.gaAvgRank, gens: `${c.firstGen}-${c.lastGen}`,
      games: n, avgRank, stdErr: sd !== null ? sd / Math.sqrt(n) : null,
      winRate: n ? games.filter((g) => g.candidateRank === 1).length / n : null,
      avgScore: n ? games.reduce((s, g) => s + g.candidateScore, 0) / n : null,
      anchorAvgScore: n ? games.reduce((s, g) => s + g.anchorAvgScore, 0) / n : null,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });
  const raw = loadGameData(DATA_PATH);
  const realTable = buildEvalTable(raw);

  const candidatesPath = path.join(args.outDir, 'candidates.json');
  let candidates;
  if (fs.existsSync(candidatesPath)) {
    candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    console.log(`候補: ${candidatesPath} から再開 (${candidates.length}体)`);
  } else {
    console.log(`候補を選んでいます (${args.gaDir}, 世代${args.fromGen}以降, 試合数${args.minGames}以上)...`);
    candidates = pickCandidates(args.gaDir, args.fromGen, args.minGames, args.candidateCount)
      .map((c, i) => ({ name: `候補${i + 1}`, hash: c.hash, firstGen: c.firstGen, lastGen: c.lastGen, games: c.games, gaAvgRank: c.gaAvgRank, genome: c.genome }));
    fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 1));
  }
  for (const c of candidates) console.log(`  ${c.name} ${c.hash.slice(0, 8)} 世代${c.firstGen}-${c.lastGen} GAでの成績 ${c.games}試合 平均${c.gaAvgRank.toFixed(2)}位`);

  const jobs = [];
  candidates.forEach((c, ci) => {
    const genome = backfill(c.genome, realTable);
    for (let b = 0; b < args.boards; b++) {
      const seed = `anchor-challenge-board${b}`;
      for (let rotation = 0; rotation < 4; rotation++) {
        const genomes = [realTable, realTable, realTable, realTable];
        genomes[rotation] = genome;
        jobs.push({ key: `${ci}-${b}-${rotation}`, candidateIndex: ci, candidateSeat: rotation, genomes, seed, aiLevel: args.aiLevel });
      }
    }
  });

  const gamesPath = path.join(args.outDir, 'games.jsonl');
  const doneGames = fs.existsSync(gamesPath)
    ? fs.readFileSync(gamesPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const doneKeys = new Set(doneGames.map((g) => g.key));
  const pending = jobs.filter((j) => !doneKeys.has(j.key));
  console.log(`全${jobs.length}試合 (候補${candidates.length}体 x 盤面${args.boards} x 4席), 終わっている${doneGames.length}試合, 残り${pending.length}試合, ${WORKER_COUNT}スレッド, AI ${args.aiLevel}`);

  const pairStats = args.pairStats ? cardPairStats.load(raw).stats : null;
  const summaryPath = path.join(args.outDir, 'summary.json');
  const writeSummary = () => fs.writeFileSync(summaryPath, JSON.stringify({ updatedAt: new Date().toISOString(), totalGames: jobs.length, doneGames: doneGames.length, results: summarize(candidates, doneGames) }, null, 1));

  const t0 = Date.now();
  let next = 0;
  let finishedThisRun = 0;
  const pool = Array.from({ length: Math.min(WORKER_COUNT, pending.length) }, () => new Worker(WORKER_SCRIPT));
  await new Promise((resolve, reject) => {
    if (pending.length === 0) { resolve(); return; }
    const assign = (worker) => {
      if (next >= pending.length) return;
      const idx = next++;
      const j = pending[idx];
      worker.postMessage({ jobId: idx, genomes: j.genomes, seed: j.seed, aiLevel: j.aiLevel });
    };
    for (const worker of pool) {
      worker.on('message', (msg) => {
        const j = pending[msg.jobId];
        const candidatePid = `P${j.candidateSeat + 1}`;
        const anchorPids = ['P1', 'P2', 'P3', 'P4'].filter((p) => p !== candidatePid);
        const game = {
          key: j.key, candidateIndex: j.candidateIndex, seed: j.seed, candidateSeat: j.candidateSeat,
          candidateRank: msg.rankByPlayerId[candidatePid], candidateScore: msg.scoreByPlayerId[candidatePid],
          anchorAvgScore: anchorPids.reduce((s, p) => s + msg.scoreByPlayerId[p], 0) / 3,
          rankByPlayerId: msg.rankByPlayerId, scoreByPlayerId: msg.scoreByPlayerId,
        };
        fs.appendFileSync(gamesPath, `${JSON.stringify(game)}\n`);
        doneGames.push(game);
        if (pairStats) cardPairStats.addGame(pairStats, msg.holdingsByPlayerId, msg.rankByPlayerId);
        finishedThisRun++;
        if (finishedThisRun % WORKER_COUNT === 0 || finishedThisRun === pending.length) {
          writeSummary();
          if (pairStats) cardPairStats.save(pairStats);
          const min = (Date.now() - t0) / 60000;
          const etaMin = (min / finishedThisRun) * (pending.length - finishedThisRun);
          console.log(`${doneGames.length}/${jobs.length}試合 (${min.toFixed(1)}分経過, 残り約${etaMin.toFixed(0)}分)`);
        }
        if (finishedThisRun === pending.length) resolve();
        else assign(worker);
      });
      worker.on('error', reject);
      assign(worker);
    }
  });
  for (const worker of pool) worker.terminate();

  writeSummary();
  if (pairStats) cardPairStats.save(pairStats);
  console.log('\n結果 (候補1体 + アンカー3体。平均順位が2.5より小さいほどアンカーより強い。±は標準誤差):');
  for (const r of summarize(candidates, doneGames).sort((a, b) => a.avgRank - b.avgRank)) {
    console.log(`  ${r.name} ${r.hash.slice(0, 8)}: ${r.games}試合 平均${r.avgRank.toFixed(3)}位 ±${r.stdErr.toFixed(3)} 勝率${(r.winRate * 100).toFixed(1)}% 平均点${r.avgScore.toFixed(1)} (アンカー${r.anchorAvgScore.toFixed(1)})`);
  }
  console.log(`-> ${summaryPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
