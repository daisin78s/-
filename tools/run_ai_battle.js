/**
 * Self-service AI-vs-AI battle runner (2026-08-04, per user feedback: "クロードコードに頼まなくてもAI
 * 対戦ができるようにしてください 入力欄は対戦数〇〇とスタートです") -- an interactive console prompt
 * (対戦数 + AIレベル + 高得点ログの閾値), no Claude Code involved. Reuses tools/ai_data_report.js exactly
 * as-is (same game loop, same every-10-games checkpointing, same HighScores-sheet logging) rather than
 * duplicating any of that logic; this script's own job is just: prompt, pick an output filename, and
 * hand off.
 *
 * Writes into a FRESH copy of AI.DATA.xlsx named "AIDATA<YYYYMMDD>-<n>.xlsx" in the project root (n
 * auto-increments past any existing file with the same date) -- the real AI.DATA.xlsx itself is never
 * opened or modified by this script. Starting from a copy (not a blank workbook) means the new file
 * keeps the same CONJOB/ABCM sheet layout/headers/formatting as AI.DATA.xlsx, per the user's own
 * "完全一致でなくても判断できればOK" (doesn't need to match exactly, just needs to be readable) --
 * copying the existing template is actually the simplest way to satisfy that, not a compromise.
 *
 * "0: レベル混合" (2026-08-10, per user request: "LV1 2 3をランダムで入れる対戦ができるようにしたい") is
 * a completely different mode, handed off to tools/ai_level_comparison.js instead -- no AI.DATA.xlsx
 * template copy (that report shape doesn't apply), just an "LVCOMPARE<YYYYMMDD>-<n>.json" summary file
 * (same auto-incrementing convention, see nextDatedFilePath).
 *
 * Double-click run_ai_battle.bat in the project root to launch this (it just runs `node
 * tools/run_ai_battle.js` and pauses on exit so the console window doesn't vanish).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const AI_DATA_TEMPLATE = path.join(PROJECT_ROOT, 'AI.DATA.xlsx');
const AI_DATA_REPORT_SCRIPT = path.join(__dirname, 'ai_data_report.js');
const AI_LEVEL_COMPARISON_SCRIPT = path.join(__dirname, 'ai_level_comparison.js');

/** Reads one answer line via rl's own async-iterator interface rather than rl.question() -- found
 * (2026-08-04) that question()'s ephemeral per-call listener can silently miss the answer to a SECOND
 * sequential question when stdin is a non-TTY pipe (reproduced directly; a real double-clicked .bat's
 * console is a TTY so this wouldn't normally bite there either way, but the iterator form is robust to
 * both and costs nothing extra). lineIterator must be the SAME iterator across every ask() call in one
 * session (see main()), not a fresh one each time. */
async function ask(lineIterator, question) {
  process.stdout.write(question);
  const { value, done } = await lineIterator.next();
  return done ? '' : value;
}

/** "AIDATA20260804-1.xlsx", "-2" etc. -- increments past whatever already exists today so a second run
 * on the same day never overwrites an earlier one. */
function nextDatedFilePath(prefix, extension) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  let n = 1;
  let candidate;
  do {
    candidate = path.join(PROJECT_ROOT, `${prefix}${dateStr}-${n}.${extension}`);
    n++;
  } while (fs.existsSync(candidate));
  return candidate;
}

async function main() {
  if (!fs.existsSync(AI_DATA_TEMPLATE)) {
    console.error(`AI.DATA.xlsx が見つかりません（${AI_DATA_TEMPLATE}）。このファイルをテンプレートとして複製するため必要です。`);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lineIterator = rl[Symbol.asyncIterator]();

  let n;
  while (true) {
    const answer = await ask(lineIterator, '対戦数を入力してください: ');
    n = Number(answer.trim());
    if (Number.isInteger(n) && n >= 1) break;
    console.log('1以上の整数を入力してください。');
  }

  let aiLevel;
  while (true) {
    const answer = (await ask(lineIterator, 'AIレベルを選んでください（0: レベル混合(比較用) / 1: LV1 速い / 2: LV2 先読みあり・遅い / 3: LV3 先読み+QST対応・遅い / 4: LV4 LV3+ダイス優先度+スマートオンボーディング・遅い）: ')).trim();
    if (answer === '0') { aiLevel = 'MIX'; break; }
    if (answer === '1') { aiLevel = 'LV1'; break; }
    if (answer === '2') { aiLevel = 'LV2'; break; }
    if (answer === '3') { aiLevel = 'LV3'; break; }
    if (answer === '4') { aiLevel = 'LV4'; break; }
    console.log('0 か 1 か 2 か 3 か 4 を入力してください。');
  }

  // "0: レベル混合" (2026-08-10, per user request: "LV1 2 3をランダムで入れる対戦ができるようにしたい"):
  // a completely different report shape (per-level score comparison, not the CONJOB/ABCM grid) via
  // tools/ai_level_comparison.js -- no AI.DATA.xlsx template copy, no HighScores threshold question
  // (that concept doesn't apply here), just N and an output path.
  if (aiLevel === 'MIX') {
    rl.close();
    const jsonPath = nextDatedFilePath('LVCOMPARE', 'json');
    console.log('');
    console.log(`${n}戦（レベル混合）を開始します。4人それぞれ独立にランダムでAIレベルが割り当てられます。結果は ${path.basename(jsonPath)} に保存されます。`);
    console.log('途中で止めたい場合はこのウィンドウを閉じてください。');
    console.log('');
    const result = spawnSync(process.execPath, [AI_LEVEL_COMPARISON_SCRIPT, String(n), jsonPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('');
      console.error('途中でエラーが発生しました。上のログを確認してください。');
      process.exitCode = result.status || 1;
      return;
    }
    console.log('');
    console.log(`完了しました: ${jsonPath}`);
    return;
  }

  // High-score logging threshold (2026-08-04, per user feedback: "記録するゲームの得点を記入してください
  // 20 以上（デフォルト値は20変更できるように）"; raised to 30, 2026-08-18) -- blank input keeps the
  // suggested default (30) rather than forcing the user to retype it every run.
  let highScoreThreshold;
  while (true) {
    const answer = (await ask(lineIterator, '記録するゲームの得点を入力してください（未入力で既定値30）: ')).trim();
    if (answer === '') { highScoreThreshold = 30; break; }
    const num = Number(answer);
    if (Number.isFinite(num)) { highScoreThreshold = num; break; }
    console.log('数値を入力するか、何も入力せず既定値30を使ってください。');
  }

  rl.close();

  const xlsxPath = nextDatedFilePath('AIDATA', 'xlsx');
  fs.copyFileSync(AI_DATA_TEMPLATE, xlsxPath);
  const jsonPath = xlsxPath.replace(/\.xlsx$/, '.json');

  console.log('');
  console.log(`${n}戦（${aiLevel}）を開始します。結果は ${path.basename(xlsxPath)} に10戦ごと自動保存されます（得点${highScoreThreshold}以上が出たゲームはHighScoresシートにも記録されます）。`);
  console.log('途中で止めたい場合はこのウィンドウを閉じてください（それまでの分は保存済みのファイルに残ります）。');
  console.log('');

  const result = spawnSync(
    process.execPath,
    [AI_DATA_REPORT_SCRIPT, String(n), jsonPath, aiLevel, xlsxPath, String(highScoreThreshold)],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    console.error('');
    console.error('途中でエラーが発生しました。上のログを確認してください。');
    process.exitCode = result.status || 1;
    return;
  }

  console.log('');
  console.log(`完了しました: ${xlsxPath}`);
}

main();
