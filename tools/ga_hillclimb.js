/**
 * 進化AI「挑戦者 対 チャンピオン」方式 (2026-10-30, per user request: "今の進化AIのルールを把握して一番いいと
 * 思うやり方を考えて" -> 提案(下記) に "おねがい"). tools/ga_train.js(20体の集団・1体1世代4試合)の代わり。
 *
 * ga_train.js の問題(2026-10-29に調べた): 1試合の順位は±1.1位ぶれるので4試合では±0.55位、評価値の良し悪しの
 * 差(0.1位くらい)は測れずほぼくじ引き / 仲間内で勝ってもアンカーに勝てる保証が無い(集団の平均はアンカーより弱
 * かった: アンカーは1584試合で平均2.34位) / 1回に約40個の数字を同時に変えるので良い変更が悪い変更に埋もれる /
 * ルールが変わっても古い成績を引き継ぐ。
 *
 * やり方:
 *  - チャンピオン = 今の評価値(最初はゲームのLV3の評価値 = game.xlsxの評価値シート)。
 *  - 挑戦者 = チャンピオンの数字を少しだけ変えたもの(1〜3項目、各項目は1ラウンドだけか全ラウンド、±15〜50%)。
 *  - 挑戦者1体 + チャンピオン3体の4人戦を、同じ盤面で4席ローテーション(運の差をそろえる、アンカー挑戦戦と同じ)。
 *    16試合(盤面4 x 4席)ずつ打ち、そのたびに判定:
 *      16試合で平均2.60位より悪い / 32試合で2.55位より悪い / 48試合以降で2.50位より悪い -> 打ち切り(不採用)
 *      240試合まで残ったら、平均 + 標準誤差 < 2.5 なら採用(新しいチャンピオン)、そうでなければ不採用
 *    (正規近似の試算: 本当は同じ強さの挑戦者は平均約86試合で終わり採用9%、0.1位強い挑戦者は採用44%、
 *     0.1位弱い挑戦者は採用0.4%)。同時に4体を並べて打つ(16コアを埋めるため)。誰かが採用されたら、ほかの
 *    挑戦者は古いチャンピオンから作ったものなので捨てて、新しいチャンピオンから作り直す。
 *  - ゲームに入れる関門: 採用が3回たまるたびに、チャンピオンをゲームの今の評価値と400試合(盤面100 x 4席)戦わせ、
 *    平均順位 + 2 x 標準誤差 < 2.5 ならゲームに入れる(tools/ga_anchor_promote.js をそのまま使う -- テスト・
 *    版上げ・コミット・プッシュ、安全のための見送り条件も今までと同じ)。入らなくてもチャンピオンはそのまま続ける。
 *  - ルールが変わった時: ゲームの評価値以外のデータ(game.jsonの評価値シート以外)かsrc/のプログラムが前回と違えば、
 *    途中の挑戦者の成績を全部捨てて測り直す。ゲームの評価値そのものが変わっていたら(手で直した・関門で入った)、
 *    チャンピオンもゲームの評価値にする。
 *
 * 途中で止めても続きから(<outDir>/state.json に、チャンピオンと途中の挑戦者の成績を16試合ごとに保存)。
 * 記録: <outDir>/challengers.csv(挑戦者1体ごとに1行)、accepted.jsonl(採用した変更)、hillclimb.log。
 * 全試合をカード相性表(tools/card_pair_stats.js)にも数える(--no-pair-statsで無効)。LV1/LV2を分けた表(カード相性LV別.xlsx、
 * 2026-10-30)にも並行して数える -- こちらはまだ評価値ALLには使わない。
 *
 * Usage: node tools/ga_hillclimb.js <outDir> [--ai-level=LV3] [--game-dir=<ゲームのフォルダ>] [--parallel=4]
 *        [--gate-every=3] [--gate-boards=100] [--no-gate] [--no-push] [--no-pair-stats] [--eval-all-every=500]
 *        [--no-ai-data] [--ai-data-every=100]
 *
 * 評価値ALLの自動更新 (2026-10-30, per user request "500ごとに更新"): 通算試合数が eval-all-every の倍数を
 * 越えるたびに、カード相性のデータを保存して tools/eval_all_update.js を裏で動かす(game.xlsx の評価値ALLを
 * 書き直してゲームに入れてプッシュ、このフォルダの game.json も更新)。終わったら各スレッドに game.json を
 * 読み直させるので、次の試合から新しい評価値ALLで打つ。評価値ALLはルールの指紋(rulesHash)に入れない --
 * 挑戦者もチャンピオンも同じ評価値ALLで打つので、変わっても成績を捨てる必要は無い。
 * (--no-pair-stats の時は相性のデータが増えないので、自動更新もしない。0で無効。)
 *
 * AIDATA (2026-10-30, per user request "進化AIを進めると 自動で生成"): 全試合を AI対戦と同じ CONJOB/ABCM/HighScores
 * にも数え(tools/ga_ai_data.js)、ai-data-every 試合ごとにゲームのフォルダの AIDATA進化AI-日付-N.xlsx に書く。
 * カードのデータ・プログラム・AIレベルが変わると新しいファイルに移る(評価値の変更では移らない)。--no-ai-data で無効。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, execFile } = require('child_process');
const { Worker } = require('worker_threads');
const { loadGameData, buildDataIndex } = require('../src/data-loader');
const { buildEvalTable, isStructurallyBlankRound } = require('../src/ai/eval-table');
const rng = require('../src/rng');
const cardPairStats = require('./card_pair_stats');
const gaAiData = require('./ga_ai_data');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'game.json');
const WORKER_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ga_worker.js');
const WORKER_COUNT = Math.max(1, os.cpus().length - 2);

const BATCH_BOARDS = 4; // 1回の判定までの盤面数(x 4席 = 16試合)
const MAX_GAMES = 240;
const RANK_SD = 1.1; // 1試合の順位のばらつき(標準誤差の計算用、試合数が少ない時のぶれを避けて固定値)
const SMALL_VALUE_THRESHOLD = 10; // これより小さい数字は倍率ではなく ±SMALL_VALUE_STEP だけ動かす(0から抜け出せるように)
const SMALL_VALUE_STEP = 5;

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const opt = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  if (positional.length < 1) {
    console.error('Usage: node tools/ga_hillclimb.js <outDir> [--ai-level=LV3] [--game-dir=...] [--parallel=4] [--gate-every=3] [--gate-boards=100] [--no-gate] [--no-push] [--no-pair-stats]');
    process.exit(1);
  }
  return {
    outDir: path.resolve(positional[0]),
    aiLevel: opt('ai-level', 'LV3'),
    gameDir: path.resolve(opt('game-dir', PROJECT_ROOT)),
    parallel: Number(opt('parallel', 4)),
    gateEvery: Number(opt('gate-every', 3)),
    gateBoards: Number(opt('gate-boards', 100)),
    gate: !argv.includes('--no-gate'),
    push: !argv.includes('--no-push'),
    pairStats: !argv.includes('--no-pair-stats'),
    evalAllEvery: Number(opt('eval-all-every', 500)),
    aiData: !argv.includes('--no-ai-data'),
    aiDataEvery: Number(opt('ai-data-every', 100)),
  };
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.outDir, { recursive: true });
const statePath = path.join(args.outDir, 'state.json');
const logPath = path.join(args.outDir, 'hillclimb.log');
const csvPath = path.join(args.outDir, 'challengers.csv');
const acceptedPath = path.join(args.outDir, 'accepted.jsonl');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** ルールの指紋: game.json の評価値シート以外 + src/ の全プログラム。 */
function rulesHash(raw) {
  const rest = { ...raw };
  delete rest['評価値'];
  delete rest['評価値ALL']; // 自動更新される -- 上の説明を参照
  const parts = [JSON.stringify(rest)];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) parts.push(name, fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(PROJECT_ROOT, 'src'));
  return md5(parts.join('\n'));
}

/** 今のデータに無いIDは今の評価値で埋め、今のデータに無いIDは捨てる(ga_anchor_challenge.jsのbackfillと同じ)。 */
function backfill(genome, realTable) {
  const out = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const id of Object.keys(realTable[round])) {
      out[round][id] = genome[round] && genome[round][id] !== undefined ? genome[round][id] : (realTable[round][id] || 0);
    }
  }
  return out;
}

/** チャンピオンを少しだけ変えた挑戦者。1〜3項目、各項目は1ラウンドだけ(半分の確率)か動かせる全ラウンド。 */
function makeChallenger(champion, id, seed) {
  const r = rng.createRng(seed);
  const genome = JSON.parse(JSON.stringify(champion));
  const ids = Object.keys(champion[1]).filter((key) => [1, 2, 3, 4].some((round) => !isStructurallyBlankRound(key, round)));
  const count = 1 + Math.floor(rng.next(r) * 3);
  const changes = [];
  const picked = new Set();
  while (picked.size < Math.min(count, ids.length)) {
    const key = ids[Math.floor(rng.next(r) * ids.length)];
    if (picked.has(key)) continue;
    picked.add(key);
    const rounds = [1, 2, 3, 4].filter((round) => !isStructurallyBlankRound(key, round));
    const target = rng.next(r) < 0.5 ? [rounds[Math.floor(rng.next(r) * rounds.length)]] : rounds;
    const sign = rng.next(r) < 0.5 ? -1 : 1;
    const factor = 1 + sign * (0.15 + rng.next(r) * 0.35);
    for (const round of target) {
      const before = genome[round][key];
      const after = Math.abs(before) < SMALL_VALUE_THRESHOLD
        ? before + (rng.next(r) * 2 - 1) * SMALL_VALUE_STEP
        : before * factor;
      genome[round][key] = Math.round(after * 1000) / 1000;
      changes.push(`${key} ${round}R ${+before.toFixed(3)}→${genome[round][key]}`);
    }
  }
  return { id, seed, genome, changes, games: [] };
}

function stats(c) {
  const n = c.games.length;
  const avg = n ? c.games.reduce((s, g) => s + g.rank, 0) / n : null;
  return { n, avg, se: n ? RANK_SD / Math.sqrt(n) : null };
}

/** 16試合ごとの判定: 'reject' / 'accept' / null(続ける)。 */
function judge(c) {
  const { n, avg, se } = stats(c);
  if (n <= 16 && avg > 2.6) return 'reject';
  if (n <= 32 && avg > 2.55) return 'reject';
  if (n >= 48 && avg > 2.5) return 'reject';
  if (n >= MAX_GAMES) return avg + se < 2.5 ? 'accept' : 'reject';
  return null;
}

function loadState(raw) {
  const gameTable = buildEvalTable(raw);
  const tableHash = md5(JSON.stringify(gameTable));
  const ruleHash = rulesHash(raw);
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  if (!state) {
    log('はじめて動かします。チャンピオン = ゲームの今の評価値。');
    state = { champion: gameTable, championFrom: 'game', gameTableHash: tableHash, rulesHash: ruleHash, nextId: 1, acceptsSinceGate: 0, gateNo: 0, challengers: [], totalGames: 0 };
  } else if (state.gameTableHash !== tableHash) {
    log('ゲームの評価値が変わっていました(手で直した・関門で入った)。チャンピオンをゲームの評価値にして、途中の挑戦者は捨てます。');
    Object.assign(state, { champion: gameTable, championFrom: 'game', gameTableHash: tableHash, rulesHash: ruleHash, acceptsSinceGate: 0, challengers: [] });
  } else if (state.rulesHash !== ruleHash) {
    log('ルール(カードのデータかプログラム)が変わっていました。途中の挑戦者の成績を捨てて測り直します(チャンピオンはそのまま)。');
    Object.assign(state, { rulesHash: ruleHash, challengers: [] });
  }
  state.champion = backfill(state.champion, gameTable);
  state.challengers = state.challengers.map((c) => ({ ...c, genome: backfill(c.genome, gameTable) }));
  return state;
}

function saveState(state) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

function writeCsvRow(c, result) {
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, '﻿id,終わった時刻,結果,試合数,平均順位,勝率,平均点,チャンピオン平均点,変更\n');
  const { n, avg } = stats(c);
  const wins = c.games.filter((g) => g.rank === 1).length;
  const score = n ? c.games.reduce((s, g) => s + g.score, 0) / n : 0;
  const champScore = n ? c.games.reduce((s, g) => s + g.championScore, 0) / n : 0;
  const label = { accept: '採用', reject: '不採用' }[result] || result;
  fs.appendFileSync(csvPath, `${c.id},${new Date().toISOString()},${label},${n},${avg.toFixed(3)},${(wins / n * 100).toFixed(1)}%,${score.toFixed(1)},${champScore.toFixed(1)},"${c.changes.join(' / ')}"\n`);
}

/** ゲームに入れる関門(ga_anchor_promote.jsを、候補をこちらで決めた形で呼ぶ)。true = ゲームに入った。 */
function runGate(state) {
  state.gateNo++;
  const gateDir = path.join(args.outDir, `anchor_challenge_${state.gateNo}`);
  fs.mkdirSync(gateDir, { recursive: true });
  const genome = state.champion;
  fs.writeFileSync(path.join(gateDir, 'candidates.json'), JSON.stringify([{
    name: `チャンピオン(関門${state.gateNo})`, hash: md5(JSON.stringify(genome)), firstGen: state.gateNo, lastGen: state.gateNo,
    games: 0, gaAvgRank: 0, genome,
  }], null, 1));
  saveState(state);
  log(`関門${state.gateNo}: チャンピオンをゲームの今の評価値と${args.gateBoards * 4}試合戦わせます。`);
  const promoteArgs = [path.join(PROJECT_ROOT, 'tools', 'ga_anchor_promote.js'), args.outDir, String(state.gateNo),
    `--game-dir=${args.gameDir}`, '--candidates=1', `--boards=${args.gateBoards}`];
  if (!args.push) promoteArgs.push('--no-push');
  const r = spawnSync('node', promoteArgs, { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    state.gateNo--; // 途中で止まった -- 次に動かした時に同じ関門の続きから(candidates.json/games.jsonlが残る)
    saveState(state);
    throw new Error(`関門の途中で止まりました (終了コード ${r.status})`);
  }
  const result = JSON.parse(fs.readFileSync(path.join(gateDir, 'result.json'), 'utf8'));
  log(`関門${state.gateNo}: ${result.promoted ? `ゲームに入りました (Ver.${result.version})` : `ゲームには入りませんでした${result.skippedReason ? ` (${result.skippedReason})` : ''}`}`);
  state.acceptsSinceGate = 0;
  saveState(state);
  return !!result.promoted;
}

/** 挑戦者を並べて打つ。採用が gateEvery 回たまったら(関門ありの時)戻る。 */
async function climb(state, raw) {
  const pairStats = args.pairStats ? cardPairStats.load(raw).stats : null;
  const pairStatsLv = args.pairStats ? cardPairStats.load(raw, true).stats : null;
  const aiData = args.aiData ? gaAiData.open(raw, buildDataIndex(raw), args.aiLevel, log) : null;
  const pool = Array.from({ length: WORKER_COUNT }, () => new Worker(WORKER_SCRIPT));
  const idle = [...pool];
  const queue = []; // { challengerId, batch, board, rotation, seed, genomes }
  const pendingBatch = new Map(); // challengerId -> { batch, left, games: [] }
  let jobSeq = 0;
  const inFlight = new Map(); // jobSeq -> job
  let stopRequested = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let gamesSinceSave = 0;

  const enqueueBatch = (c) => {
    const batch = Math.floor(c.games.length / (BATCH_BOARDS * 4));
    pendingBatch.set(c.id, { batch, left: BATCH_BOARDS * 4, games: [] });
    for (let b = 0; b < BATCH_BOARDS; b++) {
      const seed = `hc-${c.seed}-batch${batch}-board${b}`;
      for (let rotation = 0; rotation < 4; rotation++) {
        const genomes = [state.champion, state.champion, state.champion, state.champion];
        genomes[rotation] = c.genome;
        queue.push({ challengerId: c.id, rotation, seed, genomes });
      }
    }
  };
  const newChallenger = () => {
    const id = state.nextId++;
    const c = makeChallenger(state.champion, id, `${md5(JSON.stringify(state.champion)).slice(0, 8)}-${id}`);
    state.challengers.push(c);
    enqueueBatch(c);
  };
  const dispatch = () => {
    while (idle.length && queue.length && !stopRequested) {
      const worker = idle.pop();
      const job = queue.shift();
      const seq = jobSeq++;
      inFlight.set(seq, job);
      worker.postMessage({ jobId: seq, genomes: job.genomes, seed: job.seed, aiLevel: args.aiLevel, aiData: !!aiData });
    }
    if (stopRequested && inFlight.size === 0) resolveDone();
  };

  const onBatchDone = (c, games) => {
    c.games.push(...games);
    const verdict = judge(c);
    const { n, avg } = stats(c);
    if (!verdict) { enqueueBatch(c); return; }
    writeCsvRow(c, verdict);
    state.challengers = state.challengers.filter((x) => x.id !== c.id);
    if (verdict === 'accept') {
      log(`挑戦者${c.id}を採用 (${n}試合 平均${avg.toFixed(3)}位): ${c.changes.join(' / ')}`);
      fs.appendFileSync(acceptedPath, JSON.stringify({ at: new Date().toISOString(), id: c.id, games: n, avgRank: avg, changes: c.changes }) + '\n');
      state.champion = c.genome;
      state.championFrom = `challenger${c.id}`;
      state.acceptsSinceGate++;
      // ほかの挑戦者は古いチャンピオンから作ったもの -- 捨てる(打っている途中の試合の結果も使わない)
      for (const other of state.challengers) writeCsvRow(other, '入れ替えで中止');
      state.challengers = [];
      pendingBatch.clear();
      queue.length = 0;
      if (args.gate && state.acceptsSinceGate >= args.gateEvery) { stopRequested = true; return; }
    }
    while (state.challengers.length < args.parallel) newChallenger();
  };

  let evalAllRunning = false;
  const startEvalAllUpdate = () => {
    if (evalAllRunning) return;
    evalAllRunning = true;
    cardPairStats.save(pairStats);
    log(`通算${state.totalGames}試合: 評価値ALLを更新します`);
    const updateArgs = [path.join(PROJECT_ROOT, 'tools', 'eval_all_update.js'), `--game-dir=${args.gameDir}`, `--stats=${cardPairStats.STATS_PATH}`];
    if (!args.push) updateArgs.push('--no-push');
    execFile('node', updateArgs, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      evalAllRunning = false;
      let result = null;
      try { result = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (e) { result = null; }
      if (!result) { log(`評価値ALLの更新が途中で止まりました: ${err ? err.message : '結果がありません'}`); return; }
      if (!result.updated) { log(`評価値ALLは更新しませんでした (${result.skippedReason})`); return; }
      log(`評価値ALLを更新しました (Ver.${result.version}${result.pushed ? '、プッシュ済み' : ''}、${result.games}試合分、データから${result.evalAllCells}マス)。次の試合から使います。`);
      for (const worker of pool) worker.postMessage({ reloadData: true });
    });
  };

  for (const worker of pool) {
    worker.on('error', (e) => rejectDone(e));
    worker.on('message', (msg) => {
      const job = inFlight.get(msg.jobId);
      inFlight.delete(msg.jobId);
      idle.push(worker);
      if (pairStats) cardPairStats.addGame(pairStats, msg.holdingsByPlayerId, msg.rankByPlayerId);
      if (pairStatsLv && msg.holdingsByLevelByPlayerId) cardPairStats.addGame(pairStatsLv, msg.holdingsByLevelByPlayerId, msg.rankByPlayerId);
      if (aiData && msg.aiData) {
        aiData.addPart(msg.aiData);
        if (args.aiDataEvery > 0 && aiData.gamesRun % args.aiDataEvery === 0) { aiData.save(); aiData.writeXlsx(); }
      }
      state.totalGames++;
      if (pairStats && args.evalAllEvery > 0 && state.totalGames % args.evalAllEvery === 0) startEvalAllUpdate();
      const c = state.challengers.find((x) => x.id === job.challengerId);
      const pb = pendingBatch.get(job.challengerId);
      if (c && pb) {
        const pid = `P${job.rotation + 1}`;
        const others = ['P1', 'P2', 'P3', 'P4'].filter((p) => p !== pid);
        pb.games.push({ rank: msg.rankByPlayerId[pid], score: msg.scoreByPlayerId[pid], championScore: others.reduce((s, p) => s + msg.scoreByPlayerId[p], 0) / 3 });
        pb.left--;
        if (pb.left === 0) {
          pendingBatch.delete(c.id);
          onBatchDone(c, pb.games);
          saveState(state);
          if (pairStats) cardPairStats.save(pairStats);
          if (pairStatsLv) cardPairStats.save(pairStatsLv);
          if (aiData) aiData.save();
        }
      }
      if (++gamesSinceSave % 50 === 0) {
        const active = state.challengers.map((x) => { const s = stats(x); return `#${x.id}:${s.n}試合${s.n ? ` ${s.avg.toFixed(2)}位` : ''}`; }).join(' ');
        log(`通算${state.totalGames}試合 / 採用${state.acceptsSinceGate}(関門まで${args.gateEvery}) / 挑戦中 ${active}`);
      }
      dispatch();
    });
  }

  // 前回の途中の挑戦者(成績は16試合単位で保存済み)を続きから、足りない分は新しく作る
  for (const c of state.challengers) enqueueBatch(c);
  while (state.challengers.length < args.parallel) newChallenger();
  dispatch();
  try {
    await done;
  } finally {
    for (const worker of pool) worker.terminate();
    saveState(state);
    if (pairStats) cardPairStats.save(pairStats);
    if (pairStatsLv) cardPairStats.save(pairStatsLv);
    if (aiData) { aiData.save(); aiData.writeXlsx(); }
  }
}

async function main() {
  log(`開始 (AI ${args.aiLevel}, ${WORKER_COUNT}スレッド, 同時に${args.parallel}体, 関門: ${args.gate ? `採用${args.gateEvery}回ごとに${args.gateBoards * 4}試合` : 'なし'})`);
  for (;;) {
    const raw = loadGameData(DATA_PATH);
    const state = loadState(raw);
    saveState(state);
    // 前回、関門の途中で止まっていたら続きから
    if (args.gate && state.acceptsSinceGate >= args.gateEvery) { runGate(state); continue; }
    await climb(state, raw);
    if (args.gate && state.acceptsSinceGate >= args.gateEvery) runGate(state);
  }
}

main().catch((e) => { log(`止まりました: ${e && e.stack ? e.stack : e}`); process.exit(1); });
