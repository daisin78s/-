/**
 * バグ報告掲示板の報告に「対応済み」を書く (2026-11-15, per user「対応したら対応済みとクロードコードさんが書いて」)。
 * Firestoreの bugReports/{id} に resolved:true / resolvedNote / resolvedAt だけを書き足す(ほかの欄は変えない)。
 * Firestoreのルールで、この3つの欄だけの更新を許している必要がある(bugReportsの allow update)。
 *
 *   node tools/mark_bug_resolved.js list                 … 報告の一覧(id・日付・対応済みか・内容)
 *   node tools/mark_bug_resolved.js <id> "<メモ>"         … 対応済みにする(メモ例: "Ver.1.913で直しました")
 */
const BASE = 'https://firestore.googleapis.com/v1/projects/dice-wp/databases/(default)/documents';

async function list() {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'bugReports' }], orderBy: [{ field: { fieldPath: 'detectedAt' }, direction: 'DESCENDING' }], limit: 60 } }),
  });
  const rows = await res.json();
  for (const r of rows) {
    if (!r.document) continue;
    const f = Object.fromEntries(Object.entries(r.document.fields).map(([k, v]) => [k, Object.values(v)[0]]));
    const id = r.document.name.split('/').pop();
    console.log([id, String(f.detectedAt || '').slice(0, 16), f.resolved ? '対応済み' : '未対応', f.appVersion || '', (f.text || f.reason || '').replace(/\n/g, ' ').slice(0, 80)].join(' | '));
  }
}

async function mark(id, note) {
  const fields = { resolved: { booleanValue: true }, resolvedNote: { stringValue: note || '' }, resolvedAt: { stringValue: new Date().toISOString() } };
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  // currentDocument.exists=true: 無いidに新しく作ってしまわないように。
  const res = await fetch(`${BASE}/bugReports/${encodeURIComponent(id)}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) { console.error('失敗', res.status, await res.text()); process.exit(1); }
  console.log('対応済みにしました', id, note || '');
}

const [cmd, note] = process.argv.slice(2);
if (!cmd || cmd === 'list') list(); else mark(cmd, note);
