# ai-rules-relay (Cloudflare Worker)

「AIルール相談」機能の中継サーバー。ブラウザ(`ai-rules-chat.js`)からの質問を受け取り、
Gemini APIキー(秘密情報)を使ってGoogle Gemini APIを呼び、回答を返すだけの役割。
APIキーはこのWorkerの外には一切出ない。

## 初回セットアップ(ユーザー側の作業)

### 1. Node.js / wranglerの準備

```
npm install -g wrangler
wrangler login
```

ブラウザが開き、Cloudflareアカウントでログインを求められる(未アカウントなら無料で作成)。

### 2. KV namespace(レート制限用カウンターの保存場所)を作成

```
cd workers/ai-rules-relay
wrangler kv namespace create ai-rules-relay-ratelimit
```

表示される `id = "...."` をコピーし、`wrangler.toml` の

```
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

の `id` の値を実際のIDに置き換える。

### 3. Gemini APIキーを取得

https://aistudio.google.com/ にアクセスし、APIキーを発行する。
(無料枠の条件は変更されることがあるので、利用開始前に公式サイトで確認すること。)

### 4. APIキーをWorker Secretsに登録(コードやGitには一切書かない)

```
wrangler secret put GEMINI_API_KEY
```

プロンプトが出たら、取得したAPIキーを貼り付ける。

### 5. デプロイ

```
wrangler deploy
```

成功すると `https://ai-rules-relay.<あなたのサブドメイン>.workers.dev` のようなURLが表示される。
このURLを`ai-rules-chat.js`の`WORKER_URL`定数に設定する(main.js側の変更として、別途コミットする)。

## 設定値の調整

`wrangler.toml`の`[vars]`セクションで以下を調整できる(再デプロイが必要):

- `MINUTE_LIMIT_PER_IP` / `DAILY_LIMIT_PER_IP`: 1人(IP)あたりの質問回数上限
- `MONTHLY_BUDGET_REQUESTS`: 全員合計の月間リクエスト数上限。これを超えると、Geminiを呼ばずに
  固定の案内文を返す(課金の暴走を防ぐ最終防波堤)。
- `GEMINI_MODEL`: 使うGeminiモデル名。精度や料金を見て変更可能(キー管理はSecretsのまま変わらない)。

## 更新時の再デプロイ

`src/index.js`を変更した場合、`wrangler deploy`を再実行するだけでよい(KV/Secretsはそのまま残る)。
`data/ai-reference.json`/`data/dsl-command-spec.json`はGitHub Pages側から都度フェッチする設計なので、
それらを更新した場合はWorker側の再デプロイは不要(通常のgit push -> GitHub Pages反映を待つだけでよい)。
