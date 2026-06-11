# nokori-mono 🥬🥚🥩

冷蔵庫の残り物食材を **3つ選ぶだけ** で、定番料理のレシピを提案するWebアプリ。
HTML/CSS/JavaScript 一体型の1ファイル構成で、ビルド不要・ブラウザだけで動きます。

## 使い方

1. `index.html` をブラウザで開く（スマホ推奨）
2. カテゴリー（肉類／野菜類／その他）から食材を最大3つタップ
3. 画面下の「まな板」に食材が並んだら「この3つで検索」
4. マッチした定番レシピ（料理名・材料・手順・イラスト）が表示されます

## 機能

- 食材21品目 × 定番レシピ25品の静的データベース（外部通信なし）
- 最大3つの選択制御（3つ選ぶと他のボタンが非活性化、選択済みはタップで解除）
- 一致数によるレシピのスコアリングと上位提案
- 全レシピにSVGイラスト（フライパン・丼・鍋など7種＋料理ごとの配色）
- スマホ最適化レスポンシブ、`prefers-reduced-motion` 対応

## GitHubへの公開

```bash
git init
git add index.html README.md .gitignore
git commit -m "feat: nokori-mono 初版（静的レシピ提案）"
git remote add origin git@github.com:<your-name>/nokori-mono.git
git push -u origin main
```

GitHub Pages（Settings → Pages → main ブランチ）でそのまま公開できます。

---

## 🔐 将来、生成AI API（Claude / Gemini 等）と連携する場合

**現状のアプリはAPIキーを一切使いません**が、レシピをAIで動的生成したい場合は
以下の構成を守ってください。

### 大原則

> **フロントエンドのJSにAPIキーを書いた時点で、全世界に公開されたのと同じ**です。
> `.env` を使っても、Vite等でフロントにバンドルされる変数（`VITE_*` など）は
> ビルド後のJSに埋め込まれるため**安全ではありません**。
> APIキーは必ず**サーバー側（サーバーレス関数）**にのみ置きます。

### 推奨構成：サーバーレス関数を中継（プロキシ）にする

```
ブラウザ → /api/recipe（自分のサーバーレス関数）→ Anthropic/Gemini API
                ↑ APIキーはここ（環境変数）にだけ存在
```

#### 1. `.gitignore`（本リポジトリに同梱済み）

```gitignore
.env
.env.*
!.env.example
```

#### 2. `.env`（ローカル専用・コミット禁止）

```env
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

コミット用には値を空にした `.env.example` を置き、チームには
「`.env.example` をコピーして `.env` を作る」運用を周知します。

#### 3. サーバーレス関数の例（Vercel: `api/recipe.js`）

```js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { ingredients } = req.body; // 例: ["豚肉","キャベツ","玉ねぎ"]

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY, // ← 環境変数からのみ読む
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `次の食材で作れる定番料理を1品、JSONで提案して: ${ingredients.join("、")}`,
      }],
    }),
  });
  const data = await r.json();
  res.status(200).json(data);
}
```

本番のキーは Vercel / Netlify / Cloudflare の **ダッシュボードの環境変数** に登録します
（`.env` はローカル開発専用）。

#### 4. フロントエンドからは自分のAPIだけを叩く

```js
const res = await fetch("/api/recipe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ingredients: ["豚肉", "キャベツ", "玉ねぎ"] }),
});
```

### 万一キーをコミットしてしまったら

1. **即座にキーを無効化・再発行**（履歴の削除より先に！）
2. `git filter-repo` 等で履歴から除去
3. GitHubの **Secret scanning / Push protection** を有効化して再発防止

## ライセンス

MIT
