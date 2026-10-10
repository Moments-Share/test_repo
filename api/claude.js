// Vercel Serverless Function：ブラウザからのリクエストを Anthropic API に中継する。
// APIキーはこのサーバー側(環境変数 ANTHROPIC_API_KEY)にだけ置き、ブラウザには出さない。
// 環境変数 APP_PASSCODE を設定すると、合言葉を知っている人だけがAIを使える（URLが漏れてもAPI代を守る）。
const MAX_TOKENS_CAP = 8000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: "サーバーに ANTHROPIC_API_KEY が設定されていません（Vercelの Environment Variables で設定してください）" } });
    return;
  }
  const passcode = process.env.APP_PASSCODE;
  if (passcode && req.headers["x-app-passcode"] !== passcode) {
    res.status(401).json({ error: { type: "passcode", message: "合言葉が違います" } });
    return;
  }
  // req.body は Vercel が JSON を自動パース（文字列で来た場合の保険も入れる）
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const payload = {
    // モデルはサーバー側で固定（ブラウザから高価なモデルに差し替えられないように）
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    max_tokens: Math.min(Number(body.max_tokens) || 1500, MAX_TOKENS_CAP),
    system: body.system,
    messages: body.messages || [],
  };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    res.status(r.status).setHeader("content-type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: { message: "中継に失敗しました：" + String(e) } });
  }
}
