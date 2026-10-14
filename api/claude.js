// Vercel Serverless Function：ブラウザからのリクエストを Anthropic API に中継する。
// APIキーはこのサーバー側(環境変数 ANTHROPIC_API_KEY)にだけ置き、ブラウザには出さない。
// 環境変数 APP_PASSCODE を設定すると、合言葉を知っている人だけがAIを使える（URLが漏れてもAPI代を守る）。
const MAX_TOKENS_CAP = 8000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }
  // 貼り付け時に紛れた前後の空白・改行・引用符は取り除く
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    res.status(500).json({ error: { type: "server_key", message: "サーバーに ANTHROPIC_API_KEY が設定されていません（Vercelの Environment Variables で設定してください）" } });
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
  // AIの回答を待つ間、数秒おきに空白を送り続ける（社内プロキシ等が「無通信の接続」を途中で切るのを防ぐ）。
  // 先頭の空白は JSON として無害。HTTPステータスは送信開始時に確定するため、AI側の結果は本文の _status で返す。
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");
  res.write(" ");
  const beat = setInterval(() => { try { res.write(" "); } catch (e) {} }, 5000);
  const finish = (obj) => { clearInterval(beat); res.end(JSON.stringify(obj)); };
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
    // APIキーが無効（401/403）は、合言葉の誤り（401）と区別できるよう server_key として返す
    if (r.status === 401 || r.status === 403) {
      finish({ _status: 500, error: { type: "server_key", message: "Anthropic APIキーが無効です（Vercel の ANTHROPIC_API_KEY を確認してください）", detail: text.slice(0, 300) } });
      return;
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { error: { message: text.slice(0, 300) } }; }
    if (r.status !== 200) data._status = r.status;
    finish(data);
  } catch (e) {
    finish({ _status: 502, error: { message: "中継に失敗しました：" + String(e) } });
  }
}
