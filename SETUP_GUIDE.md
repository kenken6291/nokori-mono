# nokori-mono セットアップガイド（GAS + GitHub + Gemini構成）

このガイドは、README.md の20の改善案 ＋ 会員認証機能（会員登録・仮パスワード・ログイン・
パスワード再発行・ニックネーム変更・利用規約同意）をすべて実装したコード一式を、
実際に動かすための手順書です。コードはすべて用意済みです。あなたが行うのは「アカウント連携」の部分だけです。

対象ファイル:
- `index.html` … フロント（GitHub Pages）。認証画面＋本編（食材で探す／みんなのレシピ／材料費の3タブ）を統合したシェル
- `js/auth.js` … 会員登録・ログイン・パスワード再発行・ニックネーム変更・ログアウトのロジック
- `js/app.js` … レシピ提案の本編ロジック（ログイン後に初期化される）＋タブ切り替え制御
- `js/community.js` … 会員間レシピ共有（投稿・いいね・コメント・通報・写真の自動縮小アップロード）
- `js/costs.js` … 材料費の記録・今週の合計・食材ごとの内訳・みんなの相場の表示
- `legal/terms.html` … 利用規約・免責事項（ログイン画面・登録画面から参照。単体ページとしても閲覧可）
- `manifest.json` / `service-worker.js` / `icons/` … PWA化
- `assets/ogp.png` … SNSシェア用画像
- `gas/Code.gs` / `gas/appsscript.json` … バックエンド（Google Apps Script）。認証API含む
- `data/*.csv` … 食材・レシピ・週替わりおすすめのマスタデータ（スプレッドシートに取り込む）
- `.github/workflows/validate-data.yml` / `scripts/validate_data.py` … データ検証CI
- `worker.js` … 旧Cloudflare Worker版（GAS移行後は不要。参考として残置）

---

## STEP 1. Gemini APIキーを取得する（5分）

1. https://aistudio.google.com/apikey にアクセスしGoogleアカウントでログイン
2. 「Create API key」でキーを発行し、控えておく（このキーはGASのシークレットにのみ入れる。コード・Gitには絶対に書かない）

## STEP 2. データ用Googleスプレッドシート（作成済み）

Excelではなく、Googleドライブ上に**5つの独立したGoogleスプレッドシート**として作成済みです
（1ブック内のタブ分割ではなく、用途ごとに別ファイルにしています）。
フォルダ: https://drive.google.com/drive/folders/1MTYdNqezBb58mPvI41Q5LKvmt7Z3ySuW

| シート | 用途 | ID | リンク |
|---|---|---|---|
| Ingredients | 食材マスタ（category, id, name, emoji） | `1D2ZZMevoOUMPCPmdb1K2vHaSMyrcfnF1gFkSeig1wdk` | https://docs.google.com/spreadsheets/d/1D2ZZMevoOUMPCPmdb1K2vHaSMyrcfnF1gFkSeig1wdk/edit |
| Recipes | レシピ辞書（name, needs, desc, time_min, calories） | `1qMdm0ro_4aB0-QfUfIJI9YXoOMvAY8E5QzMwm8BzpXw` | https://docs.google.com/spreadsheets/d/1qMdm0ro_4aB0-QfUfIJI9YXoOMvAY8E5QzMwm8BzpXw/edit |
| Featured | 週替わりおすすめ（week_start, ingredient_id, note） | `1OM0Puyv4f-0Yy2VxY1rV6_TgpOotjrsWVUk295pjqy0` | https://docs.google.com/spreadsheets/d/1OM0Puyv4f-0Yy2VxY1rV6_TgpOotjrsWVUk295pjqy0/edit |
| Logs | 検索ログ（自動記録・手入力不要。email/nickname付き） | `1GcEczfOI0-8Q1V1mkO3qkTHoRHnYCJu1KG30Q8waYaw` | https://docs.google.com/spreadsheets/d/1GcEczfOI0-8Q1V1mkO3qkTHoRHnYCJu1KG30Q8waYaw/edit |
| Feedback | フィードバック（自動記録・手入力不要。email/nickname付き） | `1vj11U92TXzv8iR7KfePyX2UWto8llu2jDIy2U2Gscl4` | https://docs.google.com/spreadsheets/d/1vj11U92TXzv8iR7KfePyX2UWto8llu2jDIy2U2Gscl4/edit |
| Users | 会員情報（email, パスワードハッシュ, ニックネーム, 氏名等） | `1m13uInRPJtVhm4yRa481oXZRuTTS8qS04RENzvjok54` | https://docs.google.com/spreadsheets/d/1m13uInRPJtVhm4yRa481oXZRuTTS8qS04RENzvjok54/edit |

Ingredients/Recipes/Featuredには`data/*.csv`と同じ内容が既に入っています。
レシピや食材を追加・変更したいときは、このGoogleスプレッドシートを直接編集してください（コード変更・再デプロイ不要）。
`data/*.csv` はGit管理用のバックアップ／GitHub Actions検証用として repo 側に残しています。

> **重要**: `Users`シートには氏名・パスワードハッシュ等の個人情報が入ります。**このスプレッドシートは絶対に「リンクを知っている全員」等で共有しないでください**（既定では運営者のGoogleアカウントのみアクセス可能です）。

> **後片付け**: 動作確認中に作成した以下の重複・旧ファイルが同フォルダに残っています。内容は最新版と重複しているため、Google Driveから手動で削除してください（本ガイドの操作からは削除できませんでした）。
> - 「Ingredients (fixed encoding test)」（文字化け確認用の重複ファイル）
> - 旧「Logs」（ID: `1l-ATG7w_639HYgbhnz0pu-VQOVTKHd6WOSReU1VQegE` / email/nickname列が無い旧版。上表のLogsとは別物です）
> - 旧「Feedback」（ID: `1T07zbAP-SnHpy_q1q4_t4AxLj8dwFWcVE8jnLdEJ7YE` / email/nickname列が無い旧版。上表のFeedbackとは別物です）

## STEP 2-B. 会員間レシピ共有・材料費用スプレッドシート（作成済み）

同じフォルダに、会員間レシピ共有・材料費機能用のスプレッドシートを追加で作成済みです。

| シート | 用途 | ID |
|---|---|---|
| CommunityRecipes | 投稿されたレシピ本体（タイトル・食材タグ・説明・作り方・写真fileId・いいね数等） | `1I0LcxDBJeLqdquPes2GcvCoZf4OQ9tiw5Qrrmh-PyUY` |
| RecipeLikes | いいねの記録（recipeId, email） | `1h1GK_zt8hbSVZUR2fHoc7RGeBnlHPGoqG7gjpRtKkxY` |
| RecipeComments | コメント（recipeId, email, nickname, comment） | `1avWFB-wZvr8X4ogr39J7ukQDjDs_tWHkiwgm3_7WNio` |
| RecipeReports | 通報（recipeId, reporterEmail, reason, status） | `1tl3WR_nsUufMW2TOO7PodQtucqAAq8WHiWr1pIMxj0w` |
| Purchases | 材料費の購入記録（email, ingredientName, price, purchasedAt 他） | `1sD-XMbowTdyOG0FLb_WcCZS34CIk-QN0xYbSVPzcddM` |

投稿写真はスプレッドシートには保存されません。Googleドライブの専用フォルダ（`nokori-mono-photos`）に保存され、
このフォルダはGASの初回実行時に自動作成されます（手動セットアップ不要。詳細はSTEP3のPHOTOS_FOLDER_IDの説明を参照）。

> **重要: 既存の `Purchases` シートに列を追加してください（材料費の写真・編集削除・単価表示機能のため）**
> 以前から `Purchases` シートをお使いの場合、1行目のヘッダーに以下の列が無ければ追加してください
> （列の順番は自由です。無いまま使うとエラーにはなりませんが、新機能の該当部分だけ空扱いになります）。
> - `quantity` … 数量（個数またはグラム数）
> - `unit` … 単位（`count`=個数 / `gram`=グラム。未入力なら単価は表示されません）
> - `photoFileId` … レシート等の写真のGoogleドライブファイルID（コードが自動で書き込みます）
> - `status` … `active`（既定）/ `deleted`（削除された記録。コードが自動で書き込みます）
> - `updatedAt` … 最終更新日時（コードが自動で書き込みます）
>
> 最終的なヘッダー行の例: `id, email, nickname, ingredientId, ingredientName, price, quantity, unit, photoFileId, status, purchasedAt, updatedAt`
> 新規に `Purchases` シートを作る場合は、最初からこのヘッダー行で作成してください。

> **通報への対応方法**: 通報があった場合、運営者は `RecipeReports` シートで内容を確認し、該当の
> `CommunityRecipes` シートの行の `status` 列を `hidden` に書き換えることで、そのレシピを会員から見えなくできます
> （API削除機能は用意していないため、シートの直接編集で対応します）。

## STEP 3. Apps Scriptプロジェクトを作成する（5分）

1. https://script.google.com/ で「新しいプロジェクト」を作成
2. デフォルトの `Code.gs` の中身をすべて削除し、このリポジトリの `gas/Code.gs` の内容を貼り付け
3. 左メニューの歯車アイコン→「全般設定」で `appsscript.json` をマニフェストエディタに表示する設定にし、
   `gas/appsscript.json` の内容で置き換える（省略しても動作しますが、Webアプリの既定アクセス設定に反映されます）
4. まず SESSION_SECRET を準備する: エディタ上部の関数選択で `generateSessionSecretSuggestion` を選び「実行」。
   初回は権限確認画面が出るので許可し（自分のGoogleアカウントのスクリプトなので安全）、
   実行ログ（表示 → ログ、または Ctrl+Enter）に出力されたランダム文字列をコピーする
5. 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」で以下を追加
   （SHEET_ID_*はSTEP2の表のIDをそのままコピー&ペースト）:

   | プロパティ名 | 値 |
   |---|---|
   | `GEMINI_API_KEY` | STEP1で取得したキー |
   | `SHEET_ID_INGREDIENTS` | `1D2ZZMevoOUMPCPmdb1K2vHaSMyrcfnF1gFkSeig1wdk` |
   | `SHEET_ID_RECIPES` | `1qMdm0ro_4aB0-QfUfIJI9YXoOMvAY8E5QzMwm8BzpXw` |
   | `SHEET_ID_FEATURED` | `1OM0Puyv4f-0Yy2VxY1rV6_TgpOotjrsWVUk295pjqy0` |
   | `SHEET_ID_LOGS` | `1GcEczfOI0-8Q1V1mkO3qkTHoRHnYCJu1KG30Q8waYaw` |
   | `SHEET_ID_FEEDBACK` | `1vj11U92TXzv8iR7KfePyX2UWto8llu2jDIy2U2Gscl4` |
   | `SHEET_ID_USERS` | `1m13uInRPJtVhm4yRa481oXZRuTTS8qS04RENzvjok54` |
   | `SHEET_ID_COMMUNITY_RECIPES` | `1I0LcxDBJeLqdquPes2GcvCoZf4OQ9tiw5Qrrmh-PyUY` |
   | `SHEET_ID_RECIPE_LIKES` | `1h1GK_zt8hbSVZUR2fHoc7RGeBnlHPGoqG7gjpRtKkxY` |
   | `SHEET_ID_RECIPE_COMMENTS` | `1avWFB-wZvr8X4ogr39J7ukQDjDs_tWHkiwgm3_7WNio` |
   | `SHEET_ID_RECIPE_REPORTS` | `1tl3WR_nsUufMW2TOO7PodQtucqAAq8WHiWr1pIMxj0w` |
   | `SHEET_ID_PURCHASES` | `1sD-XMbowTdyOG0FLb_WcCZS34CIk-QN0xYbSVPzcddM` |
   | `SESSION_SECRET` | 手順4でコピーしたランダム文字列（**絶対に他人と共有しない**） |
   | `TERMS_VERSION` | 任意。既定値は `2026-07-12`。規約を改定したら日付を変更すると、全会員に次回ログイン時の再同意を求められる |
   | `APP_TOKEN` | 任意の適当な文字列（例: `nokori-2026-xyz`）。設定すると簡易的な不正呼び出し対策になる |
   | `MAX_DAILY_CALLS` | 任意。1日のGemini呼び出し上限（未設定なら300） |
   | `MAX_DAILY_REGISTRATIONS` | 任意。1日の新規登録上限（未設定なら50） |
   | `SESSION_TTL_DAYS` | 任意。ログイン状態を保持する日数（未設定なら7） |
   | `PBKDF_ITERATIONS` | 任意。パスワードハッシュのストレッチ回数（未設定なら10000） |
   | `PHOTOS_FOLDER_ID` | 設定不要。レシピ写真の保存先Googleドライブフォルダは初回アップロード時にGASが自動作成し、このプロパティに自動保存されます |

6. エディタ上部の関数選択で `checkSetup` を選び「実行」。実行時に「このアプリはGoogleで確認されていません」
   という警告が出た場合は「詳細」→「(プロジェクト名)に移動」で許可する（自分専用のスクリプトのため安全）。
   → 実行ログに11シート分＋SESSION_SECRETの「OK」と表示されれば設定完了です
7. 会員登録・パスワード再発行では `MailApp` でメールを送信します。初回はメール送信の権限確認が追加で
   表示される場合があるため、後述のSTEP6で実際に会員登録を1回試し、権限確認が出たら許可してください。
   同様に、レシピ投稿で写真を初めてアップロードした際も `DriveApp` の権限確認が表示される場合があります
   （nokori-mono-photosフォルダの自動作成のため）。表示されたら許可してください。

## STEP 4. Webアプリとしてデプロイする（3分）

1. 右上「デプロイ」→「新しいデプロイ」
2. 種類の選択で歯車アイコン→「ウェブアプリ」を選択
3. 「実行するユーザー」: 自分　「アクセスできるユーザー」: 全員
4. 「デプロイ」→ 発行された URL（`https://script.google.com/macros/s/xxxxx/exec`）を控える
5. 動作確認: ブラウザでそのURLの末尾に `?action=health` を付けて開き、
   `{"ok":true,...}` が返ればOK。`?action=ingredients` で食材一覧が返ることも確認する

> コードを変更した場合は「新しいデプロイ」ではなく「デプロイを管理」→鉛筆アイコン→
> バージョン「新バージョン」で更新する（URLが変わらない）

## STEP 5. js/auth.js にエンドポイントを設定する（1分）

`js/auth.js` の冒頭付近にある以下2行を書き換える（index.htmlではない点に注意）:

```js
const GAS_ENDPOINT = "https://script.google.com/macros/s/あなたのID/exec";
const APP_TOKEN = "STEP3で設定したAPP_TOKENと同じ値（設定していなければ空文字のまま）";
```

## STEP 6. GitHub Pagesにデプロイし、動作確認する

1. このフォルダの内容をGitHubリポジトリ（`nokori-mono`）にコミット・プッシュ
2. リポジトリの Settings → Pages で公開ブランチを設定（すでに公開済みなら変更不要）
3. `https://kenken6291.github.io/nokori-mono/` にアクセスし、以下を順に確認する:
   - 会員登録画面から自分のメールアドレスで登録 → 仮パスワードのメールが届く
     （初回はGAS側でメール送信の権限確認が表示される場合があります。その場合は許可してから再度お試しください）
   - 仮パスワードでログイン → 新しいパスワードの設定を求められる → 設定
   - 利用規約・免責事項への同意画面が表示される → 同意して続ける
   - レシピ提案・写真認識・フィードバック送信・ニックネーム変更・ログアウト・
     「パスワードを忘れた場合」の再発行が、それぞれ動作することを確認する
   - 「みんなのレシピ」タブでレシピを投稿（写真付き・写真なし両方）→ 投稿一覧に表示される →
     いいね・コメント・通報がそれぞれ動作することを確認する
   - 「材料費」タブで買い物を1件記録 → 今週の合計・食材ごとの内訳・みんなの相場に反映されることを確認する

> **メール送信数の上限**: `MailApp`は個人のGmailアカウントの場合1日あたり約100通までという制限があります
> （Google Workspaceアカウントではより多く送信できます）。登録者数が増えて上限に近づく場合は、
> `MAX_DAILY_REGISTRATIONS`を調整するか、Google Workspaceアカウントでのデプロイをご検討ください。

## STEP 7. （任意）GitHub Actionsの確認

`data/*.csv` を編集してプッシュすると `.github/workflows/validate-data.yml` が自動実行され、
スキーマ崩れ（存在しないidの参照、必須列の欠落など）を検知します。追加設定は不要です。

---

## 実装した20項目の対応表

| # | 内容 | 実装場所 |
|---|---|---|
| 1 | GASをGemini用プロキシに | `gas/Code.gs` doGet/doPost |
| 2 | Gemini構造化出力(JSONスキーマ) | `gas/Code.gs` RECIPE_SCHEMA/VISION_SCHEMA |
| 3 | CacheServiceでキャッシュ | `gas/Code.gs` handleSuggest内 |
| 4 | タイムアウト時のフォールバック | `index.html` loadRemoteData/search のtry-catch |
| 5 | レシピをGoogleスプレッドシート管理 | Recipesシート（作成済み）、`getRecipes()` |
| 6 | 食材マスタをGoogleスプレッドシート管理 | Ingredientsシート（作成済み）、`getIngredients()` |
| 7 | 食材組み合わせのロギング | `gas/Code.gs` appendLog("LOGS", ...) → Logsシート |
| 8 | 週替わりおすすめ食材 | Featuredシート（作成済み）、フロントのPRバッジ表示 |
| 9 | フィードバック収集 | `index.html` フィードバックUI → `gas/Code.gs` handleFeedback |
| 10 | 「あと1品」提案 | `index.html` モード切替 → `gas/Code.gs` buildSuggestPrompt(mode="addOne") |
| 11 | 写真から食材認識(Gemini Vision) | `index.html` カメラボタン → `gas/Code.gs` handleVision |
| 12 | 調理時間・カロリー表示 | `gas/Code.gs` RECIPE_SCHEMA、`index.html` バッジ表示 |
| 13 | アレルギー・除外食材フィルタ | `index.html` 除外食材トグルUI |
| 14 | 多言語対応 | `index.html` I18N辞書・言語切替ボタン |
| 15 | 選択の記憶 | `index.html` localStorage(`nokori-mono:lastBoard`) |
| 16 | PWA化 | `manifest.json`, `service-worker.js`, `icons/` |
| 17 | 結果への自動スクロール | `index.html` search()内 scrollIntoView |
| 18 | OGP設定 | `index.html` head内metaタグ、`assets/ogp.png` |
| 19 | レシピバッジ表示 | `index.html` recipeCardHtml() |
| 20 | GitHub Actionsでデータ検証 | `.github/workflows/validate-data.yml`, `scripts/validate_data.py` |

---

## 追加実装: 会員認証機能

| 機能 | 実装場所 |
|---|---|
| 会員登録（メール・ニックネーム・氏名） | `js/auth.js` registerフォーム → `gas/Code.gs` handleRegister |
| 仮パスワードの発行・メール送信 | `gas/Code.gs` generateTempPassword / sendMail |
| 初回ログイン時のパスワード変更強制 | `gas/Code.gs` mustChangePassword フラグ、`handleSetNewPassword` |
| ログインID=メールアドレス | `gas/Code.gs` findUserByEmail（Usersシートのemail列） |
| ニックネーム表示・変更 | `index.html` ヘッダーの account-box、`gas/Code.gs` handleUpdateNickname |
| パスワード表示/非表示切替 | `js/auth.js` wireTogglePassword、各パスワード欄の「表示」ボタン |
| パスワード再発行（メールアドレス指定） | `js/auth.js` forgotForm → `gas/Code.gs` handleForgotPassword |
| ログイン時の規約・免責事項同意確認 | `gas/Code.gs` agreedTermsVersion比較、`js/auth.js` agreeTerms画面 |
| 無償・ボランティア運営／トラブルは当事者間解決の明記 | `legal/terms.html` |

---

## 追加実装: 会員間レシピ共有・材料費機能

| 機能 | 実装場所 |
|---|---|
| レシピ投稿（タイトル・食材タグ・説明・作り方） | `js/community.js` recipeForm → `gas/Code.gs` handlePostCommunityRecipe |
| 写真の自動縮小・アップロード | `js/community.js` resizePhoto（Canvasで最大1280px・JPEG圧縮）→ `gas/Code.gs` savePhotoIfProvided（Googleドライブ保存） |
| 写真の非公開配信 | `gas/Code.gs` action=photo（Driveの共有リンクを公開せず、session検証済みの会員にだけBlobを返すプロキシ） |
| いいね | `js/community.js` like-btn → `gas/Code.gs` handleToggleLike（RecipeLikesシート） |
| コメント | `js/community.js` comment-form → `gas/Code.gs` handleCommentRecipe / handleListComments |
| 通報 | `js/community.js` report-btn → `gas/Code.gs` handleReportRecipe（RecipeReportsシートに記録、運営者が手動確認） |
| 材料費の記録（今週の合計・食材ごとの内訳・数量/単価・写真・編集削除） | `js/costs.js` purchaseForm → `gas/Code.gs` handleAddPurchase / handleUpdatePurchase / handleDeletePurchase / handleMyPurchases |
| みんなの相場（全会員の直近90日の平均購入価格） | `gas/Code.gs` handleMyPurchases内 communityAverage |

---

## 既知の制約・注意点

- **GASのCORS制約**: Apps ScriptのWebアプリはプリフライト(OPTIONS)に正式対応していないため、
  フロント側は `Content-Type: text/plain` でPOSTを送信している（`doPost`側で`JSON.parse`する設計。`js/auth.js`の`gasPost`参照）。
- **パスワードハッシュ**: salt付きSHA-256をN回ストレッチした簡易KDF（bcrypt/Argon2/正式なPBKDF2ではない）。
- **IPベースのレート制限は不可**: GASはOrigin/IPを確実に検証できないため、アカウント単位のロックアウト（連続失敗5回で15分ロック）とトークン検証で補っている。
- **セッション方式**: ローカルストレージに保存するトークン文字列（Cookie不使用のため、古典的なCSRFの主要な攻撃経路が存在しない構成）。
- **写真配信の注意**: `action=photo`はsessionをクエリ文字列で渡す方式（既存のGET APIと同じ設計）。URLがブラウザ履歴等に残ると第三者に見られ得るため、機密性の高い写真の投稿は推奨しない旨をUIで案内している。材料費の写真（レシート等）は本人のみ閲覧可、みんなのレシピの写真は全会員が閲覧可という違いがある。
- **無償・ボランティア運営**: 本アプリは無償のボランティア運営であり、利用者間のトラブルは当事者間で解決する旨、投稿されたレシピ・写真の権利関係、価格情報（材料費機能）はあくまで参考値であり正確性を保証しない旨を、`legal/terms.html`の利用規約・免責事項に明記している。規約バージョンを更新すると、全会員に次回ログイン時の再同意を求める。
