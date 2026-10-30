/**
 * 評価値ALLの自動更新 (2026-10-30, per user request: "ALLｘALLをgameエクセルに 自動更新" + "500ごとに更新" +
 * 確認は "不要"). tools/ga_hillclimb.js が500試合ごとに呼ぶ(手で呼んでもよい)。
 *
 *  1. カード相性のデータ(tools/card_pair_stats.js の card_pair_stats.json)から、game.xlsx の評価値ALLシートと、
 *     評価値_JOB / 評価値_CON の右の確認用の表を書き直す(tools/write_eval_all_sheet.py)。
 *  2. xlsx_to_json.py → テスト → 版を1つ上げてコミット・プッシュ(ga_anchor_promote.js と同じ手順)。
 *  3. 進化AIフォルダ(このスクリプトがあるフォルダ)の game.json も新しくする -- 呼んだ ga_hillclimb.js が、
 *     次の試合から新しい評価値ALLを使う。
 *
 * やめる(何も変えない)のは、ga_anchor_promote.js と同じ場合:
 *  - ゲームのフォルダの game.json / game.data.js / index.html にコミットしていない変更がある
 *  - game.xlsx に、まだゲームに反映していない編集がある
 *  - 書き換えた後の game.json で、評価値ALL以外のシートが変わった
 *  - テストが失敗した / game.xlsx が開かれていて保存できない等、途中で何か失敗した
 * game.xlsx は書き換える前に data/game.xlsx.backup-before-eval-all へコピーする(毎回上書き、直前の1つだけ)。
 * 評価値ALLが前と同じなら、コミットもプッシュもしない。
 *
 * 最後の行に結果をJSONで出す: {"updated":true,"version":"1.376",...} / {"updated":false,"skippedReason":...}
 *
 * Usage: node tools/eval_all_update.js [--game-dir=<ゲームのフォルダ>] [--stats=<card_pair_stats.json>] [--no-push]
 *        [--seed-fixed]   (--seed-fixed: 最初の1回だけ。評価値_JOB/評価値_CON の -100以下のマスとD行を固定値として移す)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const cardPairStats = require('./card_pair_stats');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opt = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  return {
    gameDir: path.resolve(opt('game-dir', PROJECT_ROOT)),
    stats: path.resolve(opt('stats', cardPairStats.STATS_PATH)),
    push: !argv.includes('--no-push'),
    seedFixed: argv.includes('--seed-fixed'),
  };
}

const args = parseArgs(process.argv.slice(2));
const relFiles = ['data/game.json', 'data/game.data.js', 'index.html'];
const xlsxPath = path.join(args.gameDir, 'data', 'game.xlsx');
const xlsxBackup = path.join(args.gameDir, 'data', 'game.xlsx.backup-before-eval-all');
const gameJsonPath = path.join(args.gameDir, 'data', 'game.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] 評価値ALL: ${msg}`);
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: args.gameDir, encoding: 'utf8' });
}

function python(script, ...scriptArgs) {
  return execFileSync('python', [path.join(args.gameDir, 'tools', script), ...scriptArgs], { cwd: args.gameDir, encoding: 'utf8', stdio: 'pipe' });
}

function finish(result) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

let xlsxTouched = false;
function restore(reason) {
  try {
    if (xlsxTouched) fs.copyFileSync(xlsxBackup, xlsxPath);
  } catch (e) { log(`game.xlsxを戻せませんでした: ${e.message} (バックアップ: ${xlsxBackup})`); }
  try { git('checkout', '--', ...relFiles); } catch (e) { log(`game.json等を戻せませんでした: ${e.message}`); }
  log(`更新しませんでした: ${reason}`);
  finish({ updated: false, skippedReason: reason });
}

const dirty = git('status', '--porcelain', '--', ...relFiles).trim();
if (dirty) {
  log(`更新しませんでした: コミットしていない変更があります (${dirty.replace(/\n/g, ', ')})`);
  finish({ updated: false, skippedReason: 'uncommitted changes' });
}
if (!fs.existsSync(args.stats)) finish({ updated: false, skippedReason: `カード相性のデータがありません: ${args.stats}` });

try {
  // game.xlsx に未反映の編集が無いか: 書き換える前に変換して、game.json が今のままか確かめる。
  python('xlsx_to_json.py');
  if (git('status', '--porcelain', '--', 'data/game.json').trim()) restore('game.xlsx にまだゲームに反映していない編集があります');

  const before = JSON.parse(fs.readFileSync(gameJsonPath, 'utf8'));
  fs.copyFileSync(xlsxPath, xlsxBackup);
  xlsxTouched = true;
  const written = JSON.parse(python('write_eval_all_sheet.py', args.stats, gameJsonPath, xlsxPath, ...(args.seedFixed ? ['--seed-fixed'] : [])).trim().split('\n').pop());
  python('xlsx_to_json.py');
  const after = JSON.parse(fs.readFileSync(gameJsonPath, 'utf8'));
  const changedSheets = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changedSheets.some((k) => k !== '評価値ALL')) restore(`評価値ALL以外も変わりました: ${changedSheets.join(', ')}`);
  if (!changedSheets.includes('評価値ALL')) {
    // 確認用の表だけ書き直した game.xlsx はそのまま残す(game.xlsx はgitに入っていない)
    log(`評価値ALLは前と同じでした (${written.games}試合分)`);
    finish({ updated: false, skippedReason: 'no change', ...written });
  }

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

  const message = `評価値ALLをカード相性のデータ(${written.games}試合分)から自動更新: データから${written.evalAllCells}マス、固定${written.fixedCells}組(Ver.${newVer})\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  git('commit', '-m', message, '--', ...relFiles);
  let pushed = false;
  if (args.push) {
    try { git('push', 'origin', 'main'); pushed = true; } catch (e) { log(`プッシュに失敗しました (コミットは済み、次に手でプッシュしてください): ${e.message}`); }
  }
  // 進化AIフォルダの game.json も新しい評価値ALLに。
  const localJson = path.join(PROJECT_ROOT, 'data', 'game.json');
  if (path.resolve(localJson) !== path.resolve(gameJsonPath)) fs.copyFileSync(gameJsonPath, localJson);

  log(`更新しました: Ver.${newVer}${pushed ? '、プッシュ済み' : '(プッシュはしていません)'} (${written.games}試合分、データから${written.evalAllCells}マス)`);
  finish({ updated: true, version: newVer, pushed, ...written });
} catch (e) {
  restore(`途中で失敗しました: ${e.message}`);
}
