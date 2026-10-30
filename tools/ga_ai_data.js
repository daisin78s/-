/**
 * 進化AIの試合から AIDATA (CONJOB / ABCM / HighScores、AI対戦の tools/run_ai_battle.js と同じ表) を作る
 * (2026-10-30, per user request: "進化AIを進めると 自動で生成" + "新しいファイル" + "設定や 能力 評価値が変わると
 * 新しいファイルに移行" -> 評価値については "評価値では変えなくていいよ").
 *
 *  - tools/ga_worker.js が1試合ずつ集計(tools/ai_data_aggregate.js)して送り、tools/ga_hillclimb.js が addPart で足す。
 *  - 集計は <STATS_ROOT>/output/ai_data_ga.json に保存(止めても続きから)。STATS_ROOT はカード相性と同じ
 *    (CARD_PAIR_STATS_ROOT = ゲームのフォルダ、tools/card_pair_stats.js 参照)。
 *  - エクセルは <STATS_ROOT>/AIDATA進化AI-YYYYMMDD-N.xlsx。<STATS_ROOT>/AI.DATA.xlsx を写して作り、
 *    tools/ai_data_write.py で書く(AI対戦と同じ)。
 *  - 新しいファイルに移るのは、指紋(fingerprint)が変わった時: カードのデータ(評価値で始まるシートは除く)、
 *    src/ のプログラム、AIレベル。評価値・評価値ALL・評価値_JOB 等の変更や、チャンピオンの交代では移らない。
 *    前のファイルはそのまま残る。
 *
 * 進化AIの試合は 挑戦者1人 対 チャンピオン3人 -- AI対戦(4人とも同じAI)とは打ち手が少しずつ違うことに注意。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createAggregate } = require('./ai_data_aggregate');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATS_ROOT = process.env.CARD_PAIR_STATS_ROOT ? path.resolve(process.env.CARD_PAIR_STATS_ROOT) : PROJECT_ROOT;
const STATE_PATH = path.join(STATS_ROOT, 'output', 'ai_data_ga.json');
const REPORT_PATH = path.join(STATS_ROOT, 'output', 'ai_data_ga_report.json');
const TEMPLATE_PATH = path.join(STATS_ROOT, 'AI.DATA.xlsx');
const WRITE_SCRIPT = path.join(PROJECT_ROOT, 'tools', 'ai_data_write.py');
const HIGH_SCORE_THRESHOLD = 40; // AI対戦の既定値と同じ (tools/run_ai_battle.js)

function fingerprint(raw, aiLevel) {
  const rest = {};
  for (const [sheet, rows] of Object.entries(raw)) if (!sheet.startsWith('評価値')) rest[sheet] = rows;
  const hash = crypto.createHash('md5').update(JSON.stringify(rest)).update(String(aiLevel));
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) hash.update(name).update(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(PROJECT_ROOT, 'src'));
  return hash.digest('hex');
}

function nextXlsxName() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (let n = 1; ; n++) {
    const name = `AIDATA進化AI-${date}-${n}.xlsx`;
    if (!fs.existsSync(path.join(STATS_ROOT, name))) return name;
  }
}

/** 続きを読む(指紋が同じ時)か、新しいファイルで始める。log は ga_hillclimb.js の log。 */
function open(raw, index, aiLevel, log) {
  const fp = fingerprint(raw, aiLevel);
  let saved = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null;
  if (saved && saved.fingerprint !== fp) {
    log(`AIDATA: カードのデータ・プログラム・AIレベルのどれかが変わったので、${saved.xlsxName} (${saved.gamesRun}試合) はそのまま残して、新しいファイルに集計します`);
    saved = null;
  }
  if (!saved) saved = { fingerprint: fp, aiLevel, xlsxName: nextXlsxName(), startedAt: new Date().toISOString(), gamesRun: 0, aggregate: null };
  const aggregate = createAggregate(index, HIGH_SCORE_THRESHOLD, saved.aggregate);
  const xlsxPath = path.join(STATS_ROOT, saved.xlsxName);
  log(`AIDATA: ${saved.xlsxName} に集計します (これまで${saved.gamesRun}試合)`);

  return {
    xlsxPath,
    get gamesRun() { return saved.gamesRun; },
    addPart(part) {
      aggregate.merge(part);
      saved.gamesRun++;
    },
    save() {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      saved.aggregate = aggregate.toJSON();
      const tmp = `${STATE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(saved));
      fs.renameSync(tmp, STATE_PATH);
    },
    /** エクセルに書く。開いていて保存できない等の失敗は、次の回にまた書くので log だけ。 */
    writeXlsx() {
      if (saved.gamesRun === 0) return;
      try {
        if (!fs.existsSync(xlsxPath)) fs.copyFileSync(TEMPLATE_PATH, xlsxPath);
        fs.writeFileSync(REPORT_PATH, JSON.stringify(aggregate.report(saved.gamesRun, `進化AI ${aiLevel}`)));
        execFileSync('python', [WRITE_SCRIPT, REPORT_PATH, xlsxPath], { stdio: 'pipe', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      } catch (e) {
        log(`AIDATA: ${saved.xlsxName} に書けませんでした(次の回にまた書きます): ${String(e.message).split('\n')[0]}`);
      }
    },
  };
}

module.exports = { open, fingerprint, HIGH_SCORE_THRESHOLD, STATE_PATH };
