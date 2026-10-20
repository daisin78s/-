/** 「AIルール相談」(ルールAI)チャット機能のフロントエンド (2026-10-20)。main.jsとは完全に独立 --
 * GameState/DSL/ゲーム本体のロジックには一切触れず、純粋にチャットUIの表示とCloudflare Workerへの
 * 質問送信だけを担当する。Plain classic <script>, same convention as ranking.js -- browser-only, not
 * run under Node tests.
 *
 * 唯一の依存先はWORKER_URL(Cloudflare Workerの中継URL)。Gemini APIキーはこのファイルにも
 * どこにも書かれない -- Worker側(workers/ai-rules-relay/)がSecretsとして保持する。
 *
 * WORKER_URLはworkers/ai-rules-relay/README.mdの手順でデプロイした後、実際のURLに書き換えること。
 * 空のままだと、チャットは「まだ準備中です」という案内だけ表示する(エラーにはしない)。
 */
window.AiRulesChat = (function () {
  'use strict';

  const WORKER_URL = 'https://ai-rules-relay.aged-hat-0d63.workers.dev';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendMessage(logEl, role, text) {
    const row = el('div', `ai-rules-chat-message ai-rules-chat-message--${role}`);
    row.appendChild(el('div', 'ai-rules-chat-message__bubble', text));
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
    return row;
  }

  async function sendQuestion(question) {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error || `HTTP ${res.status}`;
      throw new Error(reason);
    }
    return data.answer || '(回答が空でした)';
  }

  function errorMessageFor(err) {
    const reason = String(err && err.message || err);
    if (reason === 'MINUTE_LIMIT') return '少し間隔を空けてから、もう一度質問してください。';
    if (reason === 'DAILY_LIMIT') return '本日の質問回数の上限に達しました。また明日お試しください。';
    return 'うまく回答できませんでした。しばらくしてからもう一度お試しください。';
  }

  function init() {
    const openButton = document.getElementById('ai-rules-chat-open-button');
    const closeButton = document.getElementById('ai-rules-chat-close-button');
    const overlay = document.getElementById('ai-rules-chat-overlay');
    const form = document.getElementById('ai-rules-chat-form');
    const input = document.getElementById('ai-rules-chat-input');
    const sendButton = document.getElementById('ai-rules-chat-send-button');
    const logEl = document.getElementById('ai-rules-chat-log');
    if (!openButton || !overlay || !form || !input || !logEl) return; // このページにチャットUIが無い場合は何もしない

    let greeted = false;

    openButton.addEventListener('click', () => {
      overlay.hidden = false;
      if (!greeted) {
        greeted = true;
        appendMessage(logEl, 'assistant', 'こんにちは。ダイスWPのルールやカードについて質問してください。');
      }
      input.focus();
    });
    closeButton.addEventListener('click', () => {
      overlay.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question) return;

      if (!WORKER_URL) {
        appendMessage(logEl, 'user', question);
        appendMessage(logEl, 'assistant', 'この機能は現在準備中です。');
        input.value = '';
        return;
      }

      appendMessage(logEl, 'user', question);
      input.value = '';
      input.disabled = true;
      sendButton.disabled = true;
      const pendingRow = appendMessage(logEl, 'assistant', '考え中...');

      try {
        const answer = await sendQuestion(question);
        pendingRow.querySelector('.ai-rules-chat-message__bubble').textContent = answer;
      } catch (err) {
        pendingRow.querySelector('.ai-rules-chat-message__bubble').textContent = errorMessageFor(err);
      } finally {
        input.disabled = false;
        sendButton.disabled = false;
        input.focus();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init };
})();
