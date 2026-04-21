# LINEボット問い合わせシステム 全体仕組み

## 概要 

LINEで受信したメッセージを会話履歴として保存し、電話番号が検出された際に確認カードを表示。ユーザーの承認後、Gmail経由で指定のメールアドレスに会話履歴を送信するシステムです。

---

## システム構成

### アーキテクチャ

```
LINE Messaging API (Webhook)
    ↓
Google Cloud Run (Node.js/TypeScript)
    ↓
Gmail SMTP (Nodemailer経由)
    ↓
受信メールアドレス（複数可）
```

### 技術スタック

- **言語**: TypeScript (Node.js 20)
- **フレームワーク**: Express.js
- **ホスティング**: Google Cloud Run (asia-northeast1)
- **LINE SDK**: @line/bot-sdk v7.8.0
- **メール送信**: Nodemailer (Gmail SMTP)
- **コンテナ**: Docker

---

## 処理フロー詳細

### 1. メッセージ受信フロー

```
ユーザーがLINEでメッセージ送信
    ↓
LINE Platform → Webhook送信 (POST /webhook)
    ↓
Cloud Run: index.ts で受信
    ↓
署名検証 (LINE Channel Secret)
    ↓
handleEvent() 関数で処理振り分け
```

### 2. メッセージ処理の分岐ロジック

#### (A) 承認待ち状態での応答

```javascript
if (pendingApprovals.has(userId)) {
  if (text === "はい、大丈夫です") {
    → handleApproval() でメール送信
  } else if (text === "いいえ、結構です") {
    → handleRejection() で辞退処理
  }
}
```

#### (B) 通常メッセージ処理

```javascript
1. メッセージを messageHistory に保存
   - userId をキーにした Map 構造
   - { text: string, timestamp: string }[] の配列

2. 電話番号検出チェック
   - extractAndValidatePhoneNumber() で検証

3. 検証結果による分岐:
   ✓ 有効な電話番号 → showConfirmation()
   ✗ 無効な形式 → handleInvalidPhoneNumber()
   - なし → 履歴保存のみ
```

---

## 電話番号検証ロジック

### 検証ステップ

#### 1. 電話番号パターン抽出

```typescript
const phoneMatch = text.match(/0[0-9-０-９]+/);
```

- 「0」で始まる数字列（全角・半角対応）を検出

#### 2. 全角→半角変換

```typescript
const normalized = phoneMatch[0].replace(/[０-９]/g, (s) =>
  String.fromCharCode(s.charCodeAt(0) - 0xfee0)
);
```

#### 3. 不正文字チェック

```typescript
const hasInvalidChars = /[^0-9-]/.test(normalized);
```

- 数字とハイフン以外が含まれていたら無効

#### 4. 桁数・形式検証

```typescript
function isValidPhoneNumber(number: string): boolean {
  const digitsOnly = number.replace(/-/g, "");

  // 11桁の携帯番号 (070/080/090)
  if (digitsOnly.match(/^0[789]0/) && digitsOnly.length === 11) {
    return true;
  }

  // 10桁の固定電話
  if (digitsOnly.length === 10) {
    return true;
  }

  return false;
}
```

### 検証例

| 入力                     | 結果   | 理由                   |
| ------------------------ | ------ | ---------------------- |
| `070-1234-5678`          | ✓ 有効 | 11桁携帯、ハイフン付き |
| `09012345678`            | ✓ 有効 | 11桁携帯、ハイフンなし |
| `03-1234-5678`           | ✓ 有効 | 10桁固定電話           |
| `０９０１２３４５６７８` | ✓ 有効 | 全角→半角変換後に有効  |
| `090-1234-567`           | ✗ 無効 | 桁数不足               |
| `090123412345`           | ✗ 無効 | 桁数超過               |
| `090123asa45`            | ✗ 無効 | 不正文字混入           |

---

## 確認カード表示（Flex Message）

### showConfirmation() 処理

```typescript
async function showConfirmation(userId: string) {
  // 1. pendingApprovals に登録
  pendingApprovals.set(userId, {
    text: "電話確認待ち",
    timestamp: new Date().toISOString(),
  });

  // 2. カードタイプメッセージ送信
  await lineClient.pushMessage(userId, {
    type: "flex",
    altText: "お電話の確認",
    contents: {
      type: "bubble",
      hero: {
        /* ヘッダー画像 */
      },
      body: {
        contents: [
          { text: "専門スタッフからご連絡" },
          { text: "最短当日または翌営業日、専門スタッフから..." },
          {
            // ボタンエリア
            contents: [
              { action: { text: "はい、大丈夫です" } },
              { action: { text: "いいえ、結構です" } },
            ],
          },
        ],
      },
    },
  });
}
```

### カードの構造

- **ヘッダー画像**: LINE公式の画像URL
- **タイトル**: 「専門スタッフからご連絡」（xxlサイズ、左寄せ）
- **説明文**: 「最短当日または翌営業日...」
- **ボタン**:
  - 「はい、大丈夫です」→ メール送信
  - 「いいえ、結構です」→ 辞退メッセージ表示

---

## 承認・辞退処理

### 承認時（handleApproval）

```typescript
async function handleApproval(userId: string) {
  // 1. メール送信
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.MAIL_TO, // カンマ区切り複数可
    subject: "LINE問い合わせ【フレッツ光でグッドライフ】flets_line",
    text: formatMailBody(userId), // 会話履歴を整形
  });

  // 2. LINE返信
  await lineClient.pushMessage(userId, {
    type: "text",
    text: "ありがとうございます。\n専門スタッフよりご連絡させていただきます。\nしばらくお待ちください。",
  });

  // 3. 履歴クリア
  messageHistory.delete(userId);
  pendingApprovals.delete(userId);
}
```

### 辞退時（handleRejection）

```typescript
async function handleRejection(userId: string) {
  // 1. 辞退メッセージ送信
  await lineClient.pushMessage(userId, {
    type: "text",
    text: "承知いたしました！気になる点がありましたら、いつでもお気軽にお問合せください",
  });

  // 2. 1秒後に再度確認カード表示
  setTimeout(async () => {
    await showConfirmation(userId);
  }, 1000);

  // 3. pending状態解除
  pendingApprovals.delete(userId);
}
```

**注意**: 辞退後も `messageHistory` は保持され、再度確認カードが表示されます。

---

## メール送信フォーマット

### formatMailBody() の出力

```
[ID] : U5495f4f39340b5e454c5537f3f4240b3
[Message] : こんにちは

[ID] : U5495f4f39340b5e454c5537f3f4240b3
[Message] : フレッツ光について教えてください

[ID] : U5495f4f39340b5e454c5537f3f4240b3
[Message] : 電話番号は090-1234-5678です
```

- 各メッセージごとに `[ID]` と `[Message]` を出力
- メッセージ間は空行で区切り

### メール設定

- **件名**: `LINE問い合わせ【フレッツ光でグッドライフ】flets_line`（固定）
- **送信元**: `GMAIL_USER`（koushin1022apple@gmail.com）
- **送信先**: `MAIL_TO`（複数可、カンマ区切り）
  - koushin1022apple@gmail.com
  - qsu3he-00001-flets@hdpeach.htdb.jp

---

## データ構造

### messageHistory (Map)

```typescript
Map<
  string, // userId (例: "U5495f4f39340b5e454c5537f3f4240b3")
  Array<{
    text: string; // メッセージ本文
    timestamp: string; // ISO形式のタイムスタンプ
  }>
>;
```

- インメモリ保存（Cloud Run再起動でクリア）
- ユーザーごとに会話履歴を配列で保持

### pendingApprovals (Map)

```typescript
Map<
  string, // userId
  {
    text: string; // "電話確認待ち"（固定）
    timestamp: string; // 確認カード表示時刻
  }
>;
```

- 電話番号検出後、承認/辞退待ちユーザーを記録
- 承認またはメール送信後に削除

---

## 環境変数設定

### env.yaml（Cloud Run用）

```yaml
LINE_CHANNEL_SECRET: "ed91b15eef813cdd89975403fe1d9891"
LINE_ACCESS_TOKEN: "QQiREsgYEy5LSLKwXQQBBNHGk7y2gOopTgIhKzHUbxJjfQchcQgww9DDaOLV65XBS6ovS7OKGZertmhkLSyiD5pqOQM1X95Ved25gOlaQDQLIDiu4ibuC375adQ1foI1sz9NafUPKeu4hAhP10WzbwdB04t89/1O/w1cDnyilFU="
GMAIL_USER: "koushin1022apple@gmail.com"
GMAIL_APP_PASSWORD: "ncsw pdct wawq jfit"
MAIL_TO: "koushin1022apple@gmail.com,qsu3he-00001-flets@hdpeach.htdb.jp"
```

### .env（ローカル開発用）

- 同じ内容を `.env` ファイルにも記載
- `dotenv/config` で自動読み込み

---

## デプロイ手順

### 1. ローカルビルドテスト

```bash
npm run build  # TypeScriptコンパイル
npm run dev    # ローカル実行（tsx使用）
```

### 2. Cloud Runへデプロイ

```bash
# 方法A: ソースから直接デプロイ（env.yaml使用）
gcloud run deploy aga-line --source .  --region=asia-northeast1  --platform=managed  --allow-unauthenticated   --env-vars-file env.yaml

# # 方法B: Dockerイメージからデプロイ
# gcloud builds submit --tag gcr.io/AGA-LINE-473106/AGA-LINE
# gcloud run deploy AGA-LINE \
#   --image gcr.io/AGA-LINE-473106/AGA-LINE \
#   --region=asia-northeast1 \
#   --platform=managed \
#   --allow-unauthenticated
# ```

### 3. デプロイ後の確認

```bash
# リビジョン一覧確認
gcloud run revisions list --service=AGA-LINE --region=asia-northeast1

# 環境変数確認
gcloud run revisions describe AGA-LINE-00004-rz8 \
  --region=asia-northeast1 \
  --format="yaml(spec.containers[0].env)"

# ログ確認
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=AGA-LINE" \
  --limit 50 \
  --format="table(timestamp,severity,textPayload,jsonPayload.message)"
```

### 4. LINE Webhook URL設定

```
https://AGA-LINE-786155938077.asia-northeast1.run.app/webhook
```

LINE Developersコンソール → Messaging API設定 → Webhook URLに設定

---

## トラブルシューティング

### よくあるエラー

#### 1. SignatureValidationFailed

```
原因: LINE Channel Secretが一致していない
解決: env.yaml と LINE Developersコンソールの値を照合
```

#### 2. no channel access token

```
原因: LINE_ACCESS_TOKEN環境変数が未設定
解決: env.yaml に正しいトークンを設定して再デプロイ
```

#### 3. メールが送信されない

```
原因:
- GMAIL_APP_PASSWORD が間違っている
- Gmailの2段階認証が無効
- アプリパスワードが生成されていない

解決:
1. Googleアカウント → セキュリティ → 2段階認証を有効化
2. アプリパスワードを生成（16文字）
3. env.yaml に設定して再デプロイ
```

#### 4. TypeScriptコンパイルエラー

```
Dockerfile内で tsc が見つからない場合:
- npm install（devDependencies含む）を先に実行
- npx tsc でコンパイル
- npm ci --only=production で本番依存のみ再インストール
```

### ログ確認方法

```bash
# リアルタイムログ（tail機能は廃止）
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=AGA-LINE" \
  --limit 100 \
  --format="table(timestamp,severity,textPayload)"

# 特定エラーのみ抽出
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=AGA-LINE AND severity>=ERROR" \
  --limit 50
```

---

## セキュリティ考慮事項

### 1. 環境変数の管理

- **禁止**: `.env` や `env.yaml` を Git にコミット
- **推奨**: `.gitignore` に追加済み
- **本番**: Cloud RunのSecret Managerと統合も検討

### 2. Webhook署名検証

```typescript
// @line/bot-sdk の middleware が自動検証
app.post("/webhook", middleware(config), async (req, res) => {
  // 署名が不正な場合は 401 で自動リジェクト
});
```

### 3. メールアドレスのバリデーション

- `MAIL_TO` はカンマ区切りで複数指定可
- Nodemailer が不正なアドレスをエラー処理

### 4. Cloud Runの権限

```bash
# 未認証アクセスを許可（LINE Webhookのため必須）
--allow-unauthenticated

# 特定IPのみ許可する場合は Cloud Armor と組み合わせ
```

---

## 将来的な拡張案

### 1. データ永続化

- **現状**: インメモリ（再起動でクリア）
- **改善案**: Firestore / Cloud SQL で会話履歴を永続保存

### 2. キュー化

- **現状**: Webhook受信時に同期でメール送信
- **改善案**: Cloud Pub/Sub でメール送信をキュー化
  ```
  Webhook → Pub/Sub → Cloud Functions → Gmail送信
  ```

### 3. 管理画面

- **現状**: ログはCloud Loggingで確認
- **改善案**:
  - 会話履歴の閲覧UI
  - メール送信履歴の管理
  - ユーザーブロック機能

### 4. 多言語対応

- i18n ライブラリ導入
- 確認メッセージの言語切替

### 5. リッチメニュー連携

- LINE公式アカウントのリッチメニューから
- 「電話希望」ボタンを直接押せる仕組み

---

## ファイル構成

```
LINErep/
├── src/
│   └── index.ts              # メインアプリケーション
├── dist/                     # TypeScriptコンパイル後（gitignore）
├── node_modules/             # 依存パッケージ（gitignore）
├── package.json              # プロジェクト定義
├── tsconfig.json             # TypeScript設定
├── Dockerfile                # Cloud Run用コンテナ定義
├── .dockerignore             # Docker除外設定
├── cloudbuild.yaml           # Cloud Build設定（現在未使用）
├── .env                      # ローカル環境変数（gitignore）
├── env.yaml                  # Cloud Run環境変数（gitignore）
├── DEPLOY.md                 # デプロイ手順書
└── SYSTEM_OVERVIEW.md        # 本ドキュメント
```

---

## サポート情報

### プロジェクト情報

- **Google Cloud Project ID**: `AGA-LINE-473106`
- **Cloud Runサービス名**: `AGA-LINE`
- **リージョン**: `asia-northeast1` (東京)
- **サービスURL**: https://AGA-LINE-786155938077.asia-northeast1.run.app

### LINE公式アカウント

- **Channel Secret**: env.yaml参照
- **Access Token**: env.yaml参照

### Gmail送信設定

- **送信アドレス**: koushin1022apple@gmail.com
- **認証方式**: アプリパスワード（2段階認証必須）

---

## 変更履歴

| 日付       | 変更内容                                           |
| ---------- | -------------------------------------------------- |
| 2025-09-24 | 初期デプロイ（AGA-LINE-00001）                 |
| 2025-09-24 | メール送信機能追加（AGA-LINE-00002）           |
| 2025-10-08 | 電話番号検証・確認カード実装（AGA-LINE-00003） |
| 2025-10-08 | 環境変数修正・本番運用開始（AGA-LINE-00004）   |

---

**最終更新**: 2025年12月16日
**管理者**: web.kaiseki123@gmail.com
