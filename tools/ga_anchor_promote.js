/**
 * アンカー挑戦戦の自動化 (2026-10-28, per user request: 進化AIの改良案「1. アンカーとの勝負を自動で行う」 +
 * 回答「500世代ごと」「上位3体×200試合」「ゲームのAIまで自動で替える」).
 *
 * 進化AIの見張り役(デスクトップの進化AI\output\ga_train_lv5_20260917\run_ga_keepalive.ps1)が、500世代ごとに
 * これを1回呼ぶ。やること:
 *  1. tools/ga_anchor_challenge.js で、直近500世代の上位3体(試合数16以上)を今のアンカー(ゲームのLV3の評価値 =
 *     game.xlsxの評価値シート)とそれぞれ200試合(盤面50 x 4席)戦わせる。途中で止まっても、もう一度呼べば続きから。
 *  2. 「はっきり強い」候補 = 平均順位 + 2 x 標準誤差 < 2.5 (偶然でそう見える確率は約2%)。いなければ記録だけ。
 *  3. いれば、その評価値をゲームに入れる: game.xlsxの評価値シートを書き換え(apply_evolved_genome.py)→
 *     xlsx_to_json.py → テスト → 版を1つ上げてコミット・プッシュ → 進化AIフォルダのgame.jsonも更新(次の世代
 *     からのアンカーが新しい評価値になる)。
 *
 * 安全のため、次の場合はゲームに入れずに記録だけ残す(元に戻してから):
 *  - game.json / game.data.js / index.html に、まだコミットしていない変更がある
 *  - game.xlsx に、まだゲームに反映していない編集がある(書き換える前にxlsx_to_jsonすると game.json が変わる)
 *  - 書き換えた後の game.json で、評価値以外のシートが変わった
 *  - テストが1つでも失敗した
 *  - game.xlsx が開かれていて保存できない等、途中で何か失敗した
 * game.xlsx は書き換える前に data/game.xlsx.backup-before-anchor-<世代> へコピーする。
 *
 * 結果は <gaDir>/anchor_challenge_<世代>/result.json と <gaDir>/anchor_cycle.log に残し、終わったら同じフォルダに
 * done を置く(見張り役はこれを見て、同じ世代で2回やらない)。
 *
 * Usage: node tools/ga_anchor_promote.js <gaDir> <checkpointGen> [--game-dir=<ゲームのフォルダ>] [--interval=500]
 *        [--candidates=3] [--boards=50] [--no-push]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { loadGameData } = require('../src/data-loader');
const { buildEvalTable } = require('../src/ai/eval-table');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const opt = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  if (positional.length < 2) {
    console.error('Usage: node tools/ga_anchor_promote.js <gaDir> <checkpointGen> [--game-dir=...] [--interval=500] [--candidates=3] [--boards=50] [--no-push]');
    process.exit(1);
  }
  return {
    gaDir: path.resolve(positional[0]),
    gen: Number(positional[1]),
    gameDir: path.resolve(opt('game-dir', PROJECT_ROOT)),
    interval: Number(opt('interval', 500)),
    candidates: Number(opt('candidates', 3)),
    boards: Number(opt('boards', 50)),
    push: !argv.includes('--no-push'),
  };
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.join(args.gaDir, `anchor_challenge_${args.gen}`);
const cycleLog = path.join(args.gaDir, 'anchor_cycle.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] 世代${args.gen}: ${msg}`;
  console.log(line);
  fs.appendFileSync(cycleLog, line + '\n');
}

function finish(result) {
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ gen: args.gen, at: new Date().toISOString(), ...result }, null, 1));
  fs.writeFileSync(path.join(outDir, 'done'), '');
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: args.gameDir, encoding: 'utf8' });
}

function python(script, ...scriptArgs) {
  return execFileSync('python', [path.join(args.gameDir, 'tools', script), ...scriptArgs], { cwd: args.gameDir, encoding: 'utf8', stdio: 'pipe' });
}

// --- 1. 挑戦戦 ---
fs.mkdirSync(outDir, { recursive: true });
log(`アンカー挑戦戦を始めます (世代${args.gen - args.interval + 1}以降の上位${args.candidates}体 x ${args.boards * 4}試合)`);
const challenge = spawnSync('node', [
  path.join(PROJECT_ROOT, 'tools', 'ga_anchor_challenge.js'), args.gaDir, outDir,
  `--candidates=${args.candidates}`, `--boards=${args.boards}`, '--min-games=16',
  `--from-gen=${args.gen - args.interval + 1}`, '--ai-level=LV3',
], { cwd: PROJECT_ROOT, stdio: 'inherit' });
if (challenge.status !== 0) {
  log(`挑戦戦が途中で止まりました (終了コード ${challenge.status})。次に呼ばれた時に続きから行います。`);
  process.exit(1);
}

// --- 2. 判定 ---
const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
const results = summary.results.map((r) => ({ ...r, upper: r.avgRank + 2 * r.stdErr }));
for (const r of results) log(`  ${r.name}: 平均${r.avgRank.toFixed(3)}位 ±${r.stdErr.toFixed(3)} (${r.games}試合, 勝率${(r.winRate * 100).toFixed(1)}%, 平均${r.avgScore.toFixed(1)}点 / アンカー${r.anchorAvgScore.toFixed(1)}点)`);
const winner = results
  .filter((r) => r.games >= args.boards * 4 && r.upper < 2.5)
  .sort((a, b) => a.avgRank - b.avgRank)[0];
if (!winner) {
  log('はっきり強い候補はいませんでした。アンカーはそのままです。');
  finish({ promoted: false, results });
  process.exit(0);
}
log(`${winner.name} がはっきり強い (平均${winner.avgRank.toFixed(3)}位、2x標準誤差を足しても${winner.upper.toFixed(3)}位 < 2.5)。ゲームのAIに入れます。`);

// --- 3. ゲームに入れる ---
const relFiles = ['data/game.json', 'data/game.data.js', 'index.html'];
const xlsxPath = path.join(args.gameDir, 'data', 'game.xlsx');
const xlsxBackup = path.join(args.gameDir, 'data', `game.xlsx.backup-before-anchor-${args.gen}`);
let xlsxTouched = false;

function restore(reason) {
  try {
    if (xlsxTouched) { fs.copyFileSync(xlsxBackup, xlsxPath); fs.unlinkSync(xlsxBackup); }
  } catch (e) { log(`game.xlsxを戻せませんでした: ${e.message} (バックアップ: ${xlsxBackup})`); }
  try { git('checkout', '--', ...relFiles); } catch (e) { log(`game.json等を戻せませんでした: ${e.message}`); }
  log(`ゲームには入れませんでした: ${reason}`);
  finish({ promoted: false, skippedReason: reason, winner: winner.name, results });
  process.exit(0);
}

const dirty = git('status', '--porcelain', '--', ...relFiles).trim();
if (dirty) {
  log(`ゲームには入れませんでした: コミットしていない変更があります (${dirty.replace(/\n/g, ', ')})`);
  finish({ promoted: false, skippedReason: 'uncommitted changes', winner: winner.name, results });
  process.exit(0);
}

try {
  // game.xlsx に未反映の編集が無いか: 書き換える前に変換して、game.json が今のままか確かめる。
  python('xlsx_to_json.py');
  if (git('status', '--porcelain', '--', 'data/game.json').trim()) restore('game.xlsx にまだゲームに反映していない編集があります');

  const raw = loadGameData(path.join(args.gameDir, 'data', 'game.json'));
  const realTable = buildEvalTable(raw);
  const candidates = JSON.parse(fs.readFileSync(path.join(outDir, 'candidates.json'), 'utf8'));
  const genome = candidates.find((c) => c.name === winner.name).genome;
  const full = { 1: {}, 2: {}, 3: {}, 4: {} };
  for (const round of [1, 2, 3, 4]) {
    for (const id of Object.keys(realTable[round])) full[round][id] = genome[round] && genome[round][id] !== undefined ? genome[round][id] : realTable[round][id];
  }
  const genomePath = path.join(outDir, 'promoted_genome.json');
  fs.writeFileSync(genomePath, JSON.stringify({ generation: args.gen, avgRank: winner.avgRank, name: winner.name, hash: winner.hash, genome: full }, null, 1));

  const before = JSON.parse(fs.readFileSync(path.join(args.gameDir, 'data', 'game.json'), 'utf8'));
  fs.copyFileSync(xlsxPath, xlsxBackup);
  xlsxTouched = true;
  python('apply_evolved_genome.py', genomePath, xlsxPath);
  python('xlsx_to_json.py');
  const after = JSON.parse(fs.readFileSync(path.join(args.gameDir, 'data', 'game.json'), 'utf8'));
  const changedSheets = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changedSheets.some((k) => k !== '評価値')) restore(`評価値以外も変わりました: ${changedSheets.join(', ')}`);
  if (!changedSheets.includes('評価値')) restore('評価値が変わりませんでした');

  // テスト (run_all_tests.batと同じ: tests/*.smoke.js 全部 + validate_dsl)
  const testFiles = fs.readdirSync(path.join(args.gameDir, 'tests')).filter((f) => f.endsWith('.smoke.js')).sort();
  for (const f of testFiles) {
    const t = spawnSync('node', [path.join('tests', f)], { cwd: args.gameDir, encoding: 'utf8' });
    if (t.status !== 0) restore(`テスト ${f} が失敗しました: ${(t.stdout || '').split('\n').filter((l) => /FAIL|failed/.test(l)).slice(0, 3).join(' / ')}`);
  }
  const v = spawnSync('node', [path.join('tools', 'validate_dsl.js')], { cwd: args.gameDir, encoding: 'utf8' });
  if (v.status !== 0) restore('validate_dsl が失敗しました');

  // 版を1つ上げる (index.htmlの "Ver.1.xxx" と ?v=1.xxx を全部)
  const indexPath = path.join(args.gameDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const m = html.match(/id="copyright-notice">[^<]*Ver\.(\d+)\.(\d{3})/); // 画面に出ている版(コメント中の例ではなく)
  if (!m) restore('index.html に版番号が見つかりません');
  const oldVer = `${m[1]}.${m[2]}`;
  const newVer = `${m[1]}.${String(Number(m[2]) + 1).padStart(3, '0')}`;
  fs.writeFileSync(indexPath, html.split(oldVer).join(newVer));

  const message = `進化AIのアンカー挑戦戦(世代${args.gen})で勝った評価値をゲームのAIに反映: ${winner.name} 平均${winner.avgRank.toFixed(3)}位±${winner.stdErr.toFixed(3)} (${winner.games}試合, 平均${winner.avgScore.toFixed(1)}点 / 旧アンカー${winner.anchorAvgScore.toFixed(1)}点)(Ver.${newVer})\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  git('commit', '-m', message, '--', ...relFiles);
  let pushed = false;
  if (args.push) {
    try { git('push', 'origin', 'main'); pushed = true; } catch (e) { log(`プッシュに失敗しました (コミットは済み、次に手でプッシュしてください): ${e.message}`); }
  }
  // 次の世代からのアンカー(進化AIフォルダのgame.json)も新しい評価値に。
  const localJson = path.join(PROJECT_ROOT, 'data', 'game.json');
  if (path.resolve(localJson) !== path.resolve(path.join(args.gameDir, 'data', 'game.json'))) fs.copyFileSync(path.join(args.gameDir, 'data', 'game.json'), localJson);

  log(`ゲームのAIに入れました: Ver.${newVer}${pushed ? '、プッシュ済み' : '(プッシュはしていません)'}。game.xlsxの前の状態: ${xlsxBackup}`);
  finish({ promoted: true, version: newVer, pushed, winner: winner.name, results, xlsxBackup });
} catch (e) {
  restore(`途中で失敗しました: ${e.message}`);
}
