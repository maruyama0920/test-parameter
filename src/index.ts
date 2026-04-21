import "dotenv/config";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import type { MiddlewareConfig, WebhookEvent } from "@line/bot-sdk";
import nodemailer from "nodemailer";

// 設定
const config: MiddlewareConfig & { channelAccessToken: string } = {
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
  channelAccessToken: process.env.LINE_ACCESS_TOKEN!,
};

// クライアントの初期化
const lineClient = new Client(config);
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

type HistoryEntry = {
  text: string;
  timestamp: string;
  kind: "message" | "follow-parameter";
};

// メッセージ履歴の管理（会話履歴 + 友だち追加時パラメーター）
const messageHistory = new Map<string, HistoryEntry[]>();
const pendingApprovals = new Map<string, { text: string; timestamp: string }>();

function ensureHistory(userId: string): HistoryEntry[] {
  if (!messageHistory.has(userId)) {
    messageHistory.set(userId, []);
  }
  return messageHistory.get(userId)!;
}

function extractFollowParameter(event: WebhookEvent): string | undefined {
  const rawEvent = event as any;

  // 友だち追加時パラメーターは利用経路ごとに格納位置が異なる可能性があるため、
  // よく使われる候補を順番に探索する。
  const candidates = [
    rawEvent?.follow?.referral?.ref,
    rawEvent?.follow?.parameter,
    rawEvent?.follow?.params?.parameter,
    rawEvent?.follow?.referral?.parameter,
    rawEvent?.follow?.referrer?.parameter,
    rawEvent?.parameter,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

// 電話番号検出用の正規表現（基本的な形式）
function isValidPhoneNumber(number: string): boolean {
  // ハイフンを除去して純粋な数字列にする
  const digitsOnly = number.replace(/-/g, "");

  // 先頭が0で始まることを確認
  if (!digitsOnly.startsWith("0")) return false;

  // 携帯電話（090/080/070で始まる11桁）
  if (digitsOnly.match(/^0[789]0/) && digitsOnly.length === 11) return true;

  // 固定電話（0で始まる10桁）
  if (digitsOnly.length === 10) return true;

  return false;
}

// 電話番号らしき文字列の検出用（半角数字のみ）
const POSSIBLE_PHONE_PATTERN = /[0-9]{6,}/;

// 電話番号を抽出して検証する関数
function extractAndValidatePhoneNumber(text: string): {
  isValid: boolean;
  number?: string;
  hasInvalidChars?: boolean;
} {
  // 電話番号らしき文字列を探す
  const phoneMatch = text.match(/0[0-9-０-９]+/);
  if (!phoneMatch) return { isValid: false };

  // 全角数字を半角に変換
  const normalized = phoneMatch[0].replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0)
  );

  // 無効な文字（数字とハイフン以外）のチェック
  const hasInvalidChars = /[^0-9-]/.test(normalized);
  if (hasInvalidChars) {
    return {
      isValid: false,
      hasInvalidChars: true,
    };
  }

  // 数字のみ抽出
  const number = normalized.replace(/-/g, "");

  // 電話番号の形式チェック
  const isValid = isValidPhoneNumber(number);

  return {
    isValid,
    number,
    hasInvalidChars: false,
  };
}

// Expressサーバーの設定
const app = express();
app.get("/", (_req, res) => res.send("LINE PoC (receive-only) running"));

// Webhookエンドポイント
app.post("/webhook", middleware(config), async (req: any, res) => {
  console.log("Webhookイベントを受信:", JSON.stringify(req.body, null, 2));
  const events: WebhookEvent[] = req.body.events || [];
  for (const event of events) {
    await handleEvent(event);
  }
  res.status(200).end();
});

// メッセージ処理
async function handleEvent(event: WebhookEvent) {
  console.log("イベント処理開始:", JSON.stringify(event, null, 2));

  if (!event.source?.userId) {
    console.log("userIdがないイベントをスキップ");
    return;
  }
  const userId = event.source.userId;

  if (event.type === "follow") {
    const timestamp = new Date(event.timestamp).toISOString();
    const followParameter = extractFollowParameter(event);

    if (followParameter) {
      ensureHistory(userId).push({
        text: followParameter,
        timestamp,
        kind: "follow-parameter",
      });
      console.log("友だち追加パラメーターを保存:", {
        userId,
        followParameter,
        timestamp,
      });
    } else {
      console.log("友だち追加イベント（パラメーターなし）:", { userId, timestamp });
    }
    return;
  }

  if (event.type !== "message" || event.message.type !== "text") {
    console.log("テキストメッセージ以外のイベントをスキップ");
    return;
  }

  const text = event.message.text;
  const timestamp = new Date(event.timestamp).toISOString();

  console.log("メッセージを受信:", { userId, text, timestamp });

  // メッセージを履歴に追加
  ensureHistory(userId).push({ text, timestamp, kind: "message" });

  // 承認応答の処理
  if (text === "はい、大丈夫です") {
    console.log("承認応答を受信:", { userId });
    await handleApproval(userId);
  }
  // 承認拒否の処理
  else if (text === "いいえ、結構です") {
    console.log("承認拒否を受信:", { userId });
    await handleRejection(userId);
  }
  // 電話番号の処理
  else {
    const { isValid, number, hasInvalidChars } =
      extractAndValidatePhoneNumber(text);
    if (isValid && number) {
      console.log("有効な電話番号を検出:", { userId, number });
      await showConfirmation(userId);
    } else if (hasInvalidChars) {
      console.log("無効な電話番号フォーマットを検出:", {
        userId,
        text,
        hasInvalidChars,
      });
      await handleInvalidPhoneNumber(userId);
    } else {
      console.log("通常のメッセージを受信:", { userId, text });
    }
  }
}

// 承認時の処理
async function handleApproval(userId: string) {
  console.log("承認処理を開始:", { userId });
  const pendingData = pendingApprovals.get(userId);
  if (!pendingData) {
    console.log("承認待ちデータが見つかりません:", { userId });
    return;
  }

  try {
    // メール送信
    const toAddresses = process.env.MAIL_TO?.split(",")
      .map((email) => email.trim())
      .filter((email) => email.length > 0)
      .join(",");

    console.log("メール送信を試行:", {
      from: process.env.GMAIL_USER,
      to: toAddresses,
      userId,
      messageHistory: messageHistory.get(userId),
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: toAddresses,
      subject: "LINE問い合わせ【AGAクリニック比較サイト】aga_line",
      text: formatMailBody(userId),
    });

    console.log("メール送信成功");

    // LINEで返信
    await lineClient.pushMessage(userId, {
      type: "text",
      text: "ありがとうございます。\n専門スタッフよりご連絡させていただきます。\nしばらくお待ちください。\nご連絡させていただく番号は0120-546-093です。\nご不在の場合は、折り返しお電話いただけましたら専門スタッフが対応いたします。",
    });

    // クリーンアップ
    messageHistory.delete(userId);
    pendingApprovals.delete(userId);
  } catch (error) {
    console.error("エラー発生:", error);
  }
}

// 確認メッセージの表示
async function showConfirmation(userId: string) {
  console.log("確認メッセージを表示:", { userId });

  // 承認待ちリストに追加
  const timestamp = new Date().toISOString();
  pendingApprovals.set(userId, { text: "電話確認待ち", timestamp });

  // Flexメッセージで確認メッセージを送信
  await lineClient.pushMessage(userId, {
    type: "flex",
    altText: "お電話の確認",
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: "https://card-type-message.line-scdn.net/card-type-message-image-2025/615pknlz/1758084766925-ZVJy1VTRpibNyrARw3Ru45O9F30zTqUwhWEO6uM8q0J8yMWuHB",
        size: "full",
        aspectRatio: "1.51:1",
        aspectMode: "cover",
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "xl",
        contents: [
          {
            type: "text",
            text: "専門スタッフからご連絡",
            weight: "bold",
            size: "xl",
            align: "start",
          },
          {
            type: "text",
            text: "最短当日または翌営業日、専門スタッフからご連絡してもよろしいでしょうか？",
            wrap: true,
            align: "start",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            margin: "xxl",
            contents: [
              {
                type: "box",
                layout: "vertical",
                action: {
                  type: "message",
                  label: "はい、大丈夫です",
                  text: "はい、大丈夫です",
                },
                contents: [
                  {
                    type: "text",
                    text: "はい、大丈夫です",
                    color: "#4488ff",
                    align: "center",
                  },
                ],
                paddingAll: "md",
              },
              {
                type: "box",
                layout: "vertical",
                action: {
                  type: "message",
                  label: "いいえ、結構です",
                  text: "いいえ、結構です",
                },
                contents: [
                  {
                    type: "text",
                    text: "いいえ、結構です",
                    color: "#4488ff",
                    align: "center",
                  },
                ],
                paddingAll: "md",
              },
            ],
          },
        ],
        paddingAll: "xl",
      },
    },
  });
}

// 承認拒否時の処理
async function handleRejection(userId: string) {
  // まずメッセージを送信
  await lineClient.pushMessage(userId, {
    type: "text",
    text: "承知いたしました！気になる点がありましたら、いつでもお気軽にお問合せください",
  });

  // 少し待ってから確認カードを再表示
  setTimeout(async () => {
    await showConfirmation(userId);
  }, 1000); // 1秒後に表示

  pendingApprovals.delete(userId);
}

// メール本文のフォーマット
function formatMailBody(userId: string): string {
  const history = messageHistory.get(userId);
  if (!history) return "";

  return `[ID] : ${userId}\n\n=== メッセージ履歴 ===\n${history
    .map((entry) => {
      if (entry.kind === "follow-parameter") {
        return `[${entry.timestamp}] [友だち追加パラメーター]\n${entry.text}\n`;
      }
      return `[${entry.timestamp}]\n${entry.text}\n`;
    })
    .join("\n")}`;
}

// 無効な電話番号の処理
async function handleInvalidPhoneNumber(userId: string) {
  await lineClient.pushMessage(userId, {
    type: "text",
    text: "申し訳ありません。電話番号の形式が正しくないようです。\n\n以下のような形式で電話番号を入力してください：\n・携帯電話の場合：090-1234-5678\n・固定電話の場合：03-1234-5678",
  });
}

// フォーマットガイドの表示
async function handleFormatGuide(userId: string) {
  await lineClient.pushMessage(userId, {
    type: "text",
    text: "以下の形式で入力してください：\n\n【お名前】山田太郎\n【電話番号】090-1234-5678",
  });
}

// サーバー起動
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Listening http://localhost:${port}`));
