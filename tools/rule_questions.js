/**
 * ルールQ&A掲示板 (2026-11-16, per user「AIルール相談で確認できませんと出たとき Q&A掲示板を作ってそこに報告し
 * 週に一度確認してルールを書き込み 次質問があったときにこたえれるようにしたい」)。
 * ルールAIが「確認できません」と答えた質問は、ゲーム(ai-rules-chat.js)が Firestore の ruleQuestions に自動で送る。
 * 週1回(日曜のバグ報告の確認と一緒に):
 *   1. node tools/rule_questions.js list        … 質問の一覧(id・日付・回答済みか・質問・AIの答え)
 *   2. 答えを今のプログラム/データで調べ、ユーザーのOKをもらってから game.xlsx の「ルール」シートに足す
 *      → python tools/xlsx_to_json.py → node tools/build_ai_reference_data.js → push (ルールAIが次から答えられる)
 *   3. node tools/rule_questions.js <id> "<答え>" … 掲示板に答えを書く(answered/answer/answeredAt だけ)
 * Firestoreのルールで ruleQuestions の作成・読み取りと、その3つの欄だけの更新を許している必要がある。
 */
const BASE = 'https://firestore.googleapis.com/v1/projects/dice-wp/databases/(default)/documents';

async function list() {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'ruleQuestions' }], orderBy: [{ field: { fieldPath: 'askedAt' }, direction: 'DESCENDING' }], limit: 100 } }),
  });
  const rows = await res.json();
  if (!res.ok) { console.error('失敗', res.status, JSON.stringify(rows)); process.exit(1); }
  for (const r of rows) {
    if (!r.document) continue;
    const f = Object.fromEntries(Object.entries(r.document.fields).map(([k, v]) => [k, Object.values(v)[0]]));
    const id = r.document.name.split('/').pop();
    const oneLine = (t) => String(t || '').replace(/\n/g, ' ');
    console.log([id, String(f.askedAt || '').slice(0, 16), f.answered ? '回答済み' : '未回答', f.appVersion || '', f.asker || ''].join(' | '));
    console.log(`  Q. ${oneLine(f.question)}`);
    console.log(`  AI: ${oneLine(f.aiAnswer).slice(0, 200)}`);
    if (f.answered) console.log(`  A. ${oneLine(f.answer)}`);
  }
}

async function answer(id, text) {
  if (!text) { console.error('答えを書いてください'); process.exit(1); }
  const fields = { answered: { booleanValue: true }, answer: { stringValue: text }, answeredAt: { stringValue: new Date().toISOString() } };
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  // currentDocument.exists=true: 無いidに新しく作ってしまわないように。
  const res = await fetch(`${BASE}/ruleQuestions/${encodeURIComponent(id)}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) { console.error('失敗', res.status, await res.text()); process.exit(1); }
  console.log('答えを書きました', id);
}

const [cmd, text] = process.argv.slice(2);
if (!cmd || cmd === 'list') list(); else answer(cmd, text);
