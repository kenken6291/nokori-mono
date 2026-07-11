/**
 * nokori-mono 用 サーバーレスプロキシ（Cloudflare Workers）
 * ------------------------------------------------------------
 * 目的: APIキーをフロントエンド(GitHub Pages)に一切置かず、
 *       Worker側の「シークレット(環境変数)」として保管して中継する。
 *
 * フロント →(食材名だけ送る)→ この Worker →(キー付きで)→ LLM API
 *
 * デプロイ手順は README.md 参照。
 * シークレット登録:  npx wrangler secret put ANTHROPIC_API_KEY
 * （キーはコードにもGitにも一切書かない）
 */

// 自分のサイトだけ許可する（CORS許可リスト）
const ALLOWED_ORIGINS = [
  "https://kenken6291.github.io",
  // ローカル開発用（不要なら削除）
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

// 1食材名の最大長・最大個数（変な入力でAPIを浪費されないための入力検証）
const MAX_ITEMS = 3;
const MAX_LEN = 20;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = makeCorsHeaders(origin);

    // CORS プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, corsHeaders);
    }

    // 許可していない Origin からのブラウザアクセスは拒否
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "origin not allowed" }, 403, corsHeaders);
    }

    // ---- 入力検証 ----
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400, corsHeaders);
    }
    const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
    const cleaned = ingredients
      .filter((s) => typeof s === "string")
      .map((s) => s.trim().slice(0, MAX_LEN))
      .filter(Boolean)
      .slice(0, MAX_ITEMS);

    if (cleaned.length === 0) {
      return json({ error: "ingredients required" }, 400, corsHeaders);
    }

    // ---- ここで初めてAPIキーを使う（env はWorker内にしか存在しない）----
    const prompt = [
      `次の食材だけ（＋家庭にある基本調味料）で作れる日本の家庭料理を2つ提案してください。`,
      `食材: ${cleaned.join("、")}`,
      `必ず次のJSONだけを返してください。前置きやコードブロックは不要です。`,
      `{"recipes":[{"name":"料理名","desc":"60字以内の作り方の要点"}]}`,
    ].join("\n");

    try {
      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY, // ★シークレットから注入
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", // 低コスト・高速なモデルで十分
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!apiRes.ok) {
        return json({ error: "upstream error" }, 502, corsHeaders);
      }

      const data = await apiRes.json();
      const text = (data.content || [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");

      // モデルの出力からJSONを安全に取り出す
      let recipes = [];
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
        if (Array.isArray(parsed.recipes)) {
          recipes = parsed.recipes
            .slice(0, 3)
            .map((r) => ({
              name: String(r.name || "").slice(0, 40),
              desc: String(r.desc || "").slice(0, 120),
            }));
        }
      } catch {
        /* パース失敗時は空配列のまま返す */
      }

      return json({ recipes }, 200, corsHeaders);
    } catch (e) {
      return json({ error: "proxy failure" }, 500, corsHeaders);
    }
  },
};

function makeCorsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
