/**
 * nokori-mono バックエンド（Google Apps Script）
 * ------------------------------------------------------------
 * Cloudflare Worker(worker.js) の代替。Gemini API 連携 ＋ 会員認証を提供する。
 * データストアはGoogleスプレッドシート（Excel不使用）。用途ごとに独立したファイルを使う。
 *
 * ▼ 認証フローの概要
 * 1. register    : email/nickname/fullName/規約同意 を受け取り、仮パスワードを発行してメール送信
 * 2. login       : email+password を検証。次に必要なステップ(step)を返す
 *                    - "changePassword" … 初回 or パスワード再発行直後は必須
 *                    - "agreeTerms"     … 規約バージョンが更新されている場合
 *                    - "done"           … セッショントークンを発行
 * 3. setNewPassword / agreeTerms : login が返した短命の ticket を使ってステップを完了し、
 *                                   最終的にセッショントークン(session)を発行
 * 4. suggest/vision/feedback/updateNickname/logout は session 必須
 * 5. forgotPassword : メールアドレスを受け取り、存在有無に関わらず同じ応答を返す（列挙攻撃対策）。
 *                      実在すれば仮パスワードを再発行してメール送信し、mustChangePasswordをtrueに戻す
 *
 * ▼ 会員間レシピ共有・材料費機能の概要
 * - postCommunityRecipe : レシピ投稿（タイトル・食材タグ・説明・作り方・写真任意）。写真はGoogleドライブの
 *   専用フォルダ(PHOTOS_FOLDER_ID。未設定なら初回実行時に自動作成)に保存し、シートにはfileIdのみ保存する。
 * - communityrecipes(GET) : 投稿一覧（新着順、status=hiddenは除外）。写真はphotoUrl(GAS自身のaction=photo)で参照
 * - photo(GET)     : session必須。fileIdをCommunityRecipesシートから検証したうえでBlobを直接返す
 *                     （Driveの共有リンクを公開しないためのプロキシ。詳細はSETUP_GUIDE.md）
 * - togglelike / commentrecipe / reportrecipe : いいね・コメント・通報。通報は運営者がシートを見て手動対応
 * - addpurchase / updatepurchase / deletepurchase / mypurchases : 材料費の記録（食材名・価格・数量(個数/グラム)・
 *   写真任意）の追加・編集・削除（本人のみ、ソフトデリート）。mypurchasesは今週の合計・食材ごとの内訳・
 *   1個あたり/100gあたりの単価・全会員の平均価格（相場）を返す。写真はCommunityRecipesと同じ仕組み
 *   （action=photo, type=purchase）で本人のみ閲覧できる
 *
 * ▼ 初回セットアップ（詳細は ../SETUP_GUIDE.md）
 * スクリプト プロパティに以下を設定:
 *   GEMINI_API_KEY, SHEET_ID_INGREDIENTS, SHEET_ID_RECIPES, SHEET_ID_FEATURED,
 *   SHEET_ID_LOGS, SHEET_ID_FEEDBACK, SHEET_ID_USERS,
 *   SHEET_ID_COMMUNITY_RECIPES, SHEET_ID_RECIPE_LIKES, SHEET_ID_RECIPE_COMMENTS,
 *   SHEET_ID_RECIPE_REPORTS, SHEET_ID_PURCHASES, SESSION_SECRET,
 *   APP_TOKEN(任意), MAX_DAILY_CALLS(任意), TERMS_VERSION(任意,既定2026-07-12),
 *   PHOTOS_FOLDER_ID(任意。未設定なら自動作成してこのプロパティに保存される)
 * SESSION_SECRETは generateSessionSecretSuggestion() を一度実行し、実行ログの値を貼り付ける。
 * 設定後 checkSetup() を実行して全シートに接続できるか確認する。
 *
 * ▼ CORSについて
 * Apps Script のウェブアプリはプリフライト(OPTIONS)に正式対応していないため、
 * フロント側は POST の Content-Type を text/plain にして送る（doPost側でJSON.parseする）。
 *
 * ▼ セキュリティ上の既知の制約（詳細はSETUP_GUIDE.md）
 * - パスワードは salt付きSHA-256をN回ストレッチした簡易KDF（bcrypt/Argon2/正式なPBKDF2ではない）
 * - GASはOrigin/IPを確実に検証できないため、IPベースのレート制限はできない
 *   （アカウント単位のロックアウトとトークン検証で補っている）
 * - セッションはローカルストレージに保存するトークン方式（Cookie不使用のためCSRFの主要な攻撃経路は無い）
 * - 写真配信(action=photo)はsessionをクエリ文字列で渡す方式（既存のGET APIと同じ設計）。
 *   URLがブラウザ履歴等に残ると第三者に見られ得るため、機密性の高い写真の投稿は推奨しない旨をUIで案内する
 */

// ==========================================================
// エントリーポイント
// ==========================================================
function doGet(e) {
  try {
    const action = (e.parameter.action || "").toLowerCase();
    let result;
    switch (action) {
      case "health":
        result = { ok: true, time: new Date().toISOString() };
        break;
      case "whoami": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? { ok: true, profile: { email: auth.email, nickname: auth.nickname } } : { error: auth.error };
        break;
      }
      case "ingredients": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? { ingredients: getIngredients() } : { error: auth.error };
        break;
      }
      case "recipes": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? { recipes: getRecipes() } : { error: auth.error };
        break;
      }
      case "featured": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? { featured: getFeatured() } : { error: auth.error };
        break;
      }
      case "communityrecipes": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? handleListCommunityRecipes(auth, e.parameter) : { error: auth.error };
        break;
      }
      case "recipecomments": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? handleListComments(auth, e.parameter) : { error: auth.error };
        break;
      }
      case "mypurchases": {
        const auth = requireSession({ session: e.parameter.session });
        result = auth.ok ? handleMyPurchases(auth) : { error: auth.error };
        break;
      }
      case "photo":
        // 画像はJSONではなくBlobを直接返す特殊ケース（下のreturnで抜ける）
        return handlePhoto(e.parameter);
      default:
        result = { error: "unknown action" };
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  try {
    const raw = e.postData && e.postData.contents ? e.postData.contents : "{}";
    const body = JSON.parse(raw);
    const action = (body.action || "").toLowerCase();

    if (!checkAppToken(body.token)) {
      return jsonOutput({ error: "unauthorized" });
    }

    let result;
    switch (action) {
      case "register":
        result = handleRegister(body);
        break;
      case "login":
        result = handleLogin(body);
        break;
      case "setnewpassword":
        result = handleSetNewPassword(body);
        break;
      case "forgotpassword":
        result = handleForgotPassword(body);
        break;
      case "agreeterms":
        result = handleAgreeTerms(body);
        break;
      case "updatenickname":
        result = handleUpdateNickname(body);
        break;
      case "logout":
        result = handleLogout(body);
        break;
      case "suggest":
        result = handleSuggest(body);
        break;
      case "vision":
        result = handleVision(body);
        break;
      case "feedback":
        result = handleFeedback(body);
        break;
      case "postcommunityrecipe":
        result = handlePostCommunityRecipe(body);
        break;
      case "togglelike":
        result = handleToggleLike(body);
        break;
      case "commentrecipe":
        result = handleCommentRecipe(body);
        break;
      case "reportrecipe":
        result = handleReportRecipe(body);
        break;
      case "addpurchase":
        result = handleAddPurchase(body);
        break;
      case "updatecommunityrecipe":
        result = handleUpdateCommunityRecipe(body);
        break;
      case "deletecommunityrecipe":
        result = handleDeleteCommunityRecipe(body);
        break;
      case "updatepurchase":
        result = handleUpdatePurchase(body);
        break;
      case "deletepurchase":
        result = handleDeletePurchase(body);
        break;
      default:
        result = { error: "unknown action" };
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: String((err && err.message) || err) });
  }
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================================
// 共有トークン・日次上限（軽い防御。詳細はファイル先頭コメント参照）
// ==========================================================
function checkAppToken(token) {
  const expected = PropertiesService.getScriptProperties().getProperty("APP_TOKEN");
  if (!expected) return true; // トークン未設定なら無効化（開発中は許容）
  return token === expected;
}

function checkAndIncrementQuota(counterKey, maxPerDay) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const key = counterKey + ":" + today;
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const current = Number(props.getProperty(key) || "0");
    if (current >= maxPerDay) return false;
    props.setProperty(key, String(current + 1));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function getMaxDailyCalls() {
  const v = PropertiesService.getScriptProperties().getProperty("MAX_DAILY_CALLS");
  return v ? Number(v) : 300;
}

function getMaxDailyRegistrations() {
  const v = PropertiesService.getScriptProperties().getProperty("MAX_DAILY_REGISTRATIONS");
  return v ? Number(v) : 50;
}

// ==========================================================
// パスワードハッシュ・トークン関連（暗号ユーティリティ）
// ==========================================================
const DEFAULT_ITERATIONS = 10000;

function getPbkdfIterations() {
  const v = PropertiesService.getScriptProperties().getProperty("PBKDF_ITERATIONS");
  return v ? Number(v) : DEFAULT_ITERATIONS;
}

function makeSalt() {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(Utilities.getUuid() + "-" + Utilities.getUuid()).getBytes());
}

// salt付きSHA-256をiterations回ストレッチする簡易KDF（bcrypt/Argon2/正式なPBKDF2の代替として使用）
function hashPassword(password, saltB64, iterations) {
  iterations = iterations || DEFAULT_ITERATIONS;
  const material = saltB64 + "$" + password;
  const materialBytes = Utilities.newBlob(material).getBytes();
  let digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, materialBytes);
  for (let i = 1; i < iterations; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest.concat(materialBytes));
  }
  return Utilities.base64EncodeWebSafe(digest);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function generateTempPassword(len) {
  const raw = (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  return raw.slice(0, len || 12);
}

function signToken(payloadObj, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.assign({}, payloadObj, { iat: now, exp: now + ttlSeconds });
  const payloadB64 = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sigBytes = Utilities.computeHmacSha256Signature(payloadB64, getSessionSecret());
  const sigB64 = Utilities.base64EncodeWebSafe(sigBytes);
  return payloadB64 + "." + sigB64;
}

function verifyToken(token) {
  if (typeof token !== "string" || token.lastIndexOf(".") === -1) return null;
  const idx = token.lastIndexOf(".");
  const payloadB64 = token.slice(0, idx);
  const sigB64 = token.slice(idx + 1);
  const expectedSigB64 = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getSessionSecret()));
  if (!timingSafeEqual(sigB64, expectedSigB64)) return null;
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString());
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function getSessionSecret() {
  const v = PropertiesService.getScriptProperties().getProperty("SESSION_SECRET");
  if (!v) throw new Error("SESSION_SECRET is not set in Script Properties");
  return v;
}

// 管理者がSESSION_SECRETを準備するための補助関数。一度だけ実行し、実行ログの値をスクリプトプロパティに貼り付ける。
function generateSessionSecretSuggestion() {
  const s = Utilities.base64EncodeWebSafe(
    Utilities.newBlob(Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).getBytes()
  );
  Logger.log(s);
  return s;
}

function getTermsVersion() {
  return PropertiesService.getScriptProperties().getProperty("TERMS_VERSION") || "2026-07-12";
}

function getSessionTtlSeconds() {
  const days = PropertiesService.getScriptProperties().getProperty("SESSION_TTL_DAYS");
  return (days ? Number(days) : 7) * 24 * 60 * 60;
}

// ==========================================================
// メール送信
// ==========================================================
function sendMail(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: subject, body: body });
}

function buildTempPasswordEmailBody(nickname, tempPassword, kind) {
  const greeting = nickname ? nickname + " 様" : "ご利用者様";
  const intro = kind === "reset"
    ? "パスワード再発行のお手続きを受け付けました。"
    : "nokori-mono へのご登録ありがとうございます。";
  return [
    greeting,
    "",
    intro,
    "以下の仮パスワードでログインし、ログイン後に画面の案内に従って新しいパスワードを設定してください。",
    "",
    "仮パスワード: " + tempPassword,
    "ログインページ: https://kenken6291.github.io/nokori-mono/",
    "",
    "このメールに心当たりがない場合は、お手数ですが本メールを破棄してください。",
    "（本メールへの返信には対応しておりません。無償のボランティア運営のためご了承ください）",
    "",
    "nokori-mono運営",
  ].join("\n");
}

// ==========================================================
// 入力検証
// ==========================================================
const MAX_ITEMS = 3;
const MAX_EXCLUDE = 10;
const MAX_LEN = 20;

function sanitizeList(list, maxItems, maxLen) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === "string")
    .map((s) => s.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePasswordStrength(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "password_too_short";
  if (pw.length > 100) return "password_too_long";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "password_too_weak";
  return null;
}

// ==========================================================
// スプレッドシート操作（用途ごとに独立したGoogleスプレッドシート）
// ==========================================================
const SHEET_KEYS = [
  "INGREDIENTS", "RECIPES", "FEATURED", "LOGS", "FEEDBACK", "USERS",
  "COMMUNITY_RECIPES", "RECIPE_LIKES", "RECIPE_COMMENTS", "RECIPE_REPORTS", "PURCHASES",
];

function openSheetByKey(key) {
  const id = PropertiesService.getScriptProperties().getProperty("SHEET_ID_" + key);
  if (!id) throw new Error("SHEET_ID_" + key + " is not set in Script Properties");
  return SpreadsheetApp.openById(id).getSheets()[0];
}

// 一度だけ実行して、全スプレッドシートに正しくアクセスできるか確認するための関数
function checkSetup() {
  SHEET_KEYS.forEach((key) => {
    try {
      const sh = openSheetByKey(key);
      Logger.log(key + ": OK (" + sh.getParent().getName() + " / " + sh.getLastRow() + "行)");
    } catch (err) {
      Logger.log(key + ": NG - " + err.message);
    }
  });
  try {
    getSessionSecret();
    Logger.log("SESSION_SECRET: OK");
  } catch (err) {
    Logger.log("SESSION_SECRET: NG - " + err.message);
  }
}

function sheetToObjects(key) {
  const sh = openSheetByKey(key);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const headers = values[0].map((h) => String(h).trim());
  return values.slice(1)
    .filter((row) => row.some((c) => String(c).trim() !== ""))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = row[i]));
      return obj;
    });
}

function appendLog(key, row) {
  try {
    const sh = openSheetByKey(key);
    if (sh) sh.appendRow(row);
  } catch (err) {
    // ログ失敗はユーザー応答をブロックしない
  }
}

// ---------- Usersシート専用ヘルパー ----------
function getUsersSheet() {
  return openSheetByKey("USERS");
}

function findUserByEmail(email) {
  const sh = getUsersSheet();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0].map((h) => String(h).trim());
  const emailCol = headers.indexOf("email");
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][emailCol] || "").toLowerCase() === email.toLowerCase()) {
      const data = {};
      headers.forEach((h, c) => (data[h] = values[i][c]));
      return { rowIndex: i + 1, headers, data };
    }
  }
  return null;
}

function appendUserRow(headers, obj) {
  const sh = getUsersSheet();
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ""));
  sh.appendRow(row);
}

function updateUserRow(rowIndex, headers, updates) {
  const sh = getUsersSheet();
  Object.keys(updates).forEach((key) => {
    const col = headers.indexOf(key);
    if (col >= 0) sh.getRange(rowIndex, col + 1).setValue(updates[key]);
  });
}

function isLocked(user) {
  const lockedUntil = user.data.lockedUntil;
  if (!lockedUntil) return false;
  const t = new Date(lockedUntil);
  return !isNaN(t) && t > new Date();
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function registerFailedAttempt(user) {
  const attempts = (Number(user.data.failedAttempts) || 0) + 1;
  const updates = { failedAttempts: attempts, updatedAt: new Date().toISOString() };
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    updates.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
  }
  updateUserRow(user.rowIndex, user.headers, updates);
}

function clearFailedAttempts(user) {
  updateUserRow(user.rowIndex, user.headers, { failedAttempts: 0, lockedUntil: "", updatedAt: new Date().toISOString() });
}

function publicProfile(data) {
  return { email: data.email, nickname: data.nickname };
}

function issueSession(user) {
  return signToken(
    { email: user.data.email, tv: Number(user.data.tokenVersion) || 1, scope: "session" },
    getSessionTtlSeconds()
  );
}

// リクエストボディの session を検証する。全ての会員限定APIの入口で使う。
function requireSession(body) {
  const payload = verifyToken(body && body.session);
  if (!payload || payload.scope !== "session") return { ok: false, error: "unauthorized" };
  const user = findUserByEmail(payload.email);
  if (!user) return { ok: false, error: "unauthorized" };
  const currentTv = Number(user.data.tokenVersion) || 1;
  if (Number(payload.tv) !== currentTv) return { ok: false, error: "session_expired" };
  if (user.data.status && user.data.status !== "active") return { ok: false, error: "account_disabled" };
  return { ok: true, email: user.data.email, nickname: user.data.nickname, user };
}

// ==========================================================
// action=register / login / setNewPassword / forgotPassword / agreeTerms / updateNickname / logout
// ==========================================================
function handleRegister(body) {
  const email = normalizeEmail(body.email);
  const nickname = String(body.nickname || "").trim().slice(0, 20);
  const fullName = String(body.fullName || "").trim().slice(0, 60);

  if (!isValidEmail(email)) return { error: "invalid_email" };
  if (!nickname) return { error: "nickname_required" };
  if (!fullName) return { error: "fullName_required" };
  if (!body.agreeTerms) return { error: "agree_terms_required" };

  if (!checkAndIncrementQuota("register", getMaxDailyRegistrations())) {
    return { error: "quota_exceeded" };
  }

  if (findUserByEmail(email)) return { error: "already_registered" };

  const tempPassword = generateTempPassword(12);
  const salt = makeSalt();
  const iterations = getPbkdfIterations();
  const hash = hashPassword(tempPassword, salt, iterations);
  const now = new Date().toISOString();

  const sh = getUsersSheet();
  const headers = sh.getDataRange().getValues()[0].map((h) => String(h).trim());
  appendUserRow(headers, {
    email: email,
    passwordHash: hash,
    salt: salt,
    iterations: iterations,
    nickname: nickname,
    fullName: fullName,
    mustChangePassword: true,
    tokenVersion: 1,
    agreedTermsVersion: getTermsVersion(),
    agreedTermsAt: now,
    failedAttempts: 0,
    lockedUntil: "",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  try {
    sendMail(email, "【nokori-mono】仮パスワードのお知らせ", buildTempPasswordEmailBody(nickname, tempPassword, "register"));
  } catch (err) {
    // アカウントは作成済み。メール失敗時は forgotPassword で再発行できる旨をフロントに伝える
    return { error: "mail_failed" };
  }
  return { ok: true };
}

function handleLogin(body) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || !password) return { error: "invalid_credentials" };

  const user = findUserByEmail(email);
  if (!user) return { error: "invalid_credentials" }; // メール未登録でも同じエラーにして列挙を防ぐ

  if (isLocked(user)) return { error: "account_locked" };
  if (user.data.status && user.data.status !== "active") return { error: "account_disabled" };

  const computed = hashPassword(password, user.data.salt, Number(user.data.iterations) || DEFAULT_ITERATIONS);
  if (!timingSafeEqual(computed, user.data.passwordHash)) {
    registerFailedAttempt(user);
    return { error: "invalid_credentials" };
  }

  clearFailedAttempts(user);

  const mustChange = user.data.mustChangePassword === true || String(user.data.mustChangePassword).toUpperCase() === "TRUE";
  if (mustChange) {
    return { ok: true, step: "changePassword", ticket: signToken({ email: email, scope: "changePassword" }, 15 * 60) };
  }

  const needsTerms = String(user.data.agreedTermsVersion || "") !== getTermsVersion();
  if (needsTerms) {
    return { ok: true, step: "agreeTerms", ticket: signToken({ email: email, scope: "agreeTerms" }, 15 * 60) };
  }

  return { ok: true, step: "done", session: issueSession(user), profile: publicProfile(user.data) };
}

function handleSetNewPassword(body) {
  const ticket = verifyToken(body.ticket);
  if (!ticket || ticket.scope !== "changePassword") return { error: "invalid_or_expired_ticket" };

  const passErr = validatePasswordStrength(String(body.newPassword || ""));
  if (passErr) return { error: passErr };

  const user = findUserByEmail(ticket.email);
  if (!user) return { error: "invalid_credentials" };

  const salt = makeSalt();
  const iterations = getPbkdfIterations();
  const hash = hashPassword(String(body.newPassword), salt, iterations);
  updateUserRow(user.rowIndex, user.headers, {
    passwordHash: hash,
    salt: salt,
    iterations: iterations,
    mustChangePassword: false,
    tokenVersion: (Number(user.data.tokenVersion) || 1) + 1, // 既存セッションを無効化
    updatedAt: new Date().toISOString(),
  });

  const refreshed = findUserByEmail(ticket.email);
  const needsTerms = String(refreshed.data.agreedTermsVersion || "") !== getTermsVersion();
  if (needsTerms) {
    return { ok: true, step: "agreeTerms", ticket: signToken({ email: ticket.email, scope: "agreeTerms" }, 15 * 60) };
  }
  return { ok: true, step: "done", session: issueSession(refreshed), profile: publicProfile(refreshed.data) };
}

function handleForgotPassword(body) {
  const email = normalizeEmail(body.email);
  if (isValidEmail(email) && checkAndIncrementQuota("forgotPassword:" + email, 5)) {
    const user = findUserByEmail(email);
    if (user && (!user.data.status || user.data.status === "active")) {
      const tempPassword = generateTempPassword(12);
      const salt = makeSalt();
      const iterations = getPbkdfIterations();
      const hash = hashPassword(tempPassword, salt, iterations);
      updateUserRow(user.rowIndex, user.headers, {
        passwordHash: hash,
        salt: salt,
        iterations: iterations,
        mustChangePassword: true,
        tokenVersion: (Number(user.data.tokenVersion) || 1) + 1,
        failedAttempts: 0,
        lockedUntil: "",
        updatedAt: new Date().toISOString(),
      });
      try {
        sendMail(email, "【nokori-mono】パスワード再発行のお知らせ", buildTempPasswordEmailBody(user.data.nickname, tempPassword, "reset"));
      } catch (err) {
        // 失敗しても下の汎用レスポンスを返す（登録有無を推測させないため）
      }
    }
  }
  // 登録の有無に関わらず常に同じレスポンス（メールアドレス列挙対策）
  return { ok: true };
}

function handleAgreeTerms(body) {
  const ticket = verifyToken(body.ticket);
  if (!ticket || ticket.scope !== "agreeTerms") return { error: "invalid_or_expired_ticket" };
  if (!body.agree) return { error: "agree_required" };

  const user = findUserByEmail(ticket.email);
  if (!user) return { error: "invalid_credentials" };

  updateUserRow(user.rowIndex, user.headers, {
    agreedTermsVersion: getTermsVersion(),
    agreedTermsAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const refreshed = findUserByEmail(ticket.email);
  return { ok: true, step: "done", session: issueSession(refreshed), profile: publicProfile(refreshed.data) };
}

function handleUpdateNickname(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const nickname = String(body.nickname || "").trim().slice(0, 20);
  if (!nickname) return { error: "nickname_required" };

  updateUserRow(auth.user.rowIndex, auth.user.headers, { nickname: nickname, updatedAt: new Date().toISOString() });
  return { ok: true, nickname: nickname };
}

function handleLogout(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };
  // tokenVersionを進めて、発行済みの全セッションを無効化する（他端末からも強制ログアウト）
  updateUserRow(auth.user.rowIndex, auth.user.headers, {
    tokenVersion: (Number(auth.user.data.tokenVersion) || 1) + 1,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}

// ==========================================================
// 会員向けデータ取得（Ingredients / Recipes / Featured）
// ==========================================================
function getIngredients() {
  return sheetToObjects("INGREDIENTS").map((r) => ({
    category: String(r.category || "other"),
    id: String(r.id || ""),
    name: String(r.name || ""),
    emoji: String(r.emoji || "🍽️"),
  })).filter((r) => r.id && r.name);
}

function getRecipes() {
  return sheetToObjects("RECIPES").map((r) => ({
    name: String(r.name || ""),
    needs: String(r.needs || "").split(";").map((s) => s.trim()).filter(Boolean),
    desc: String(r.desc || ""),
    time_min: r.time_min ? Number(r.time_min) : null,
    calories: r.calories ? Number(r.calories) : null,
  })).filter((r) => r.name && r.needs.length);
}

function getFeatured() {
  const rows = sheetToObjects("FEATURED");
  if (!rows.length) return [];
  const today = new Date();
  const parsed = rows
    .map((r) => ({ ...r, _d: new Date(r.week_start) }))
    .filter((r) => !isNaN(r._d) && r._d <= today)
    .sort((a, b) => b._d - a._d);
  if (!parsed.length) return [];
  const latestWeek = Utilities.formatDate(parsed[0]._d, "Asia/Tokyo", "yyyy-MM-dd");
  return parsed
    .filter((r) => Utilities.formatDate(r._d, "Asia/Tokyo", "yyyy-MM-dd") === latestWeek)
    .map((r) => ({ ingredient_id: String(r.ingredient_id || ""), note: String(r.note || "") }));
}

// ==========================================================
// Gemini呼び出し
// ==========================================================
function callGemini(payload, model) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set in Script Properties");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    (model || "gemini-2.0-flash") + ":generateContent?key=" + apiKey;
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("Gemini API error " + res.getResponseCode() + ": " + res.getContentText().slice(0, 300));
  }
  const data = JSON.parse(res.getContentText());
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || "").join("");
}

const RECIPE_SCHEMA = {
  type: "OBJECT",
  properties: {
    recipes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          desc: { type: "STRING" },
          time_min: { type: "INTEGER" },
          calories: { type: "INTEGER" },
        },
        required: ["name", "desc"],
      },
    },
  },
  required: ["recipes"],
};

const VISION_SCHEMA = {
  type: "OBJECT",
  properties: {
    ingredients: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["ingredients"],
};

// ---------- action=suggest（通常提案／あと1品モード）※要ログイン ----------
function handleSuggest(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const ingredients = sanitizeList(body.ingredients, MAX_ITEMS, MAX_LEN);
  const exclude = sanitizeList(body.exclude, MAX_EXCLUDE, MAX_LEN);
  const mode = body.mode === "addOne" ? "addOne" : "normal";
  const lang = body.lang === "en" ? "en" : "ja";

  if (ingredients.length === 0) return { error: "ingredients required" };

  const cacheKey = ["suggest", mode, lang, ingredients.slice().sort().join(","), exclude.slice().sort().join(",")].join("|");
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) {
    appendLog("LOGS", [new Date().toISOString(), auth.email, auth.nickname, JSON.stringify(ingredients), mode, lang]);
    return JSON.parse(cached);
  }

  if (!checkAndIncrementQuota("suggest", getMaxDailyCalls())) {
    return { error: "quota_exceeded" };
  }

  const prompt = buildSuggestPrompt(ingredients, mode, lang, exclude);
  const text = callGemini({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RECIPE_SCHEMA,
      temperature: 0.6,
    },
  });

  let recipes = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.recipes)) {
      recipes = parsed.recipes.slice(0, 3).map((r) => ({
        name: String(r.name || "").slice(0, 40),
        desc: String(r.desc || "").slice(0, 140),
        time_min: Number.isFinite(r.time_min) ? r.time_min : null,
        calories: Number.isFinite(r.calories) ? r.calories : null,
      }));
    }
  } catch (err) {
    // パース失敗時は空配列
  }

  const result = { recipes };
  CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), 6 * 60 * 60); // 6時間キャッシュ
  appendLog("LOGS", [new Date().toISOString(), auth.email, auth.nickname, JSON.stringify(ingredients), mode, lang]);
  return result;
}

function buildSuggestPrompt(ingredients, mode, lang, exclude) {
  const sep = lang === "en" ? ", " : "、";
  const list = ingredients.join(sep);
  const exclList = exclude.length ? exclude.join(sep) : (lang === "en" ? "none" : "なし");

  if (mode === "addOne") {
    return lang === "en"
      ? `The user has these ingredients at home: ${list}. Excluded ingredients: ${exclList}. Suggest 2 popular home-cooked dishes that need only ONE additional common ingredient to buy. Mention the missing ingredient at the start of "desc". Respond only with the given JSON schema, in English.`
      : `次の食材が家にあります: ${list}。除外食材: ${exclList}。「あと1品買い足せば作れる」定番の家庭料理を2つ提案してください。買い足すべき食材名をdescの冒頭に明記してください。必ず指定のJSONスキーマのみで、日本語で回答してください。`;
  }
  return lang === "en"
    ? `Using only these ingredients (plus basic pantry seasonings): ${list}. Excluded ingredients: ${exclList}. Suggest 2 popular home-cooked dishes with approximate cooking time (minutes) and calories. Respond only with the given JSON schema, in English.`
    : `次の食材だけ（＋家庭にある基本調味料）で作れる日本の家庭料理を2つ提案してください。食材: ${list}。除外食材: ${exclList}。おおよその調理時間(分)とカロリーも添えてください。必ず指定のJSONスキーマのみで、日本語で回答してください。`;
}

// ---------- action=vision（冷蔵庫写真から食材認識）※要ログイン ----------
function handleVision(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const imageBase64 = String(body.imageBase64 || "");
  const mimeType = String(body.mimeType || "image/jpeg");
  if (!imageBase64) return { error: "imageBase64 required" };
  if (imageBase64.length > 6 * 1024 * 1024) return { error: "image too large" };

  if (!checkAndIncrementQuota("vision", Math.min(getMaxDailyCalls(), 100))) {
    return { error: "quota_exceeded" };
  }

  const knownNames = getIngredients().map((i) => i.name);
  const prompt = `この画像は冷蔵庫や食材の写真です。写っている食材名を日本語の一般的な名称で最大8個、重複なく挙げてください。` +
    (knownNames.length ? `可能ならこの一覧の表記に合わせてください: ${knownNames.join("、")}。` : "") +
    `必ず指定のJSONスキーマのみで回答してください。`;

  const text = callGemini({
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: VISION_SCHEMA,
      temperature: 0.2,
    },
  });

  let raw = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.ingredients)) raw = parsed.ingredients.map((s) => String(s).slice(0, 20)).slice(0, 8);
  } catch (err) {
    // noop
  }

  const master = getIngredients();
  const matched = [];
  raw.forEach((name) => {
    const hit = master.find((m) => m.name === name || name.indexOf(m.name) >= 0 || m.name.indexOf(name) >= 0);
    if (hit && matched.indexOf(hit.id) === -1) matched.push(hit.id);
  });

  return { raw, matched };
}

// ---------- action=feedback ※要ログイン ----------
function handleFeedback(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const rating = Math.max(1, Math.min(5, Number(body.rating) || 0));
  const comment = String(body.comment || "").slice(0, 300);
  const ingredients = sanitizeList(body.ingredients, MAX_ITEMS, MAX_LEN);
  appendLog("FEEDBACK", [new Date().toISOString(), auth.email, auth.nickname, rating, comment, JSON.stringify(ingredients)]);
  return { ok: true };
}

// ==========================================================
// 汎用シート行ヘルパー（id列を持つシート向け。CommunityRecipes等で使用）
// ==========================================================
function findRowById(key, idValue, idColumnName) {
  idColumnName = idColumnName || "id";
  const sh = openSheetByKey(key);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0].map((h) => String(h).trim());
  const idCol = headers.indexOf(idColumnName);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(idValue)) {
      const data = {};
      headers.forEach((h, c) => (data[h] = values[i][c]));
      return { rowIndex: i + 1, headers, data };
    }
  }
  return null;
}

function updateRowByIndex(key, rowIndex, headers, updates) {
  const sh = openSheetByKey(key);
  Object.keys(updates).forEach((k) => {
    const col = headers.indexOf(k);
    if (col >= 0) sh.getRange(rowIndex, col + 1).setValue(updates[k]);
  });
}

// ==========================================================
// 会員間レシピ共有機能（投稿・いいね・コメント・通報）※すべて要ログイン
// ==========================================================
const MAX_RECIPE_TITLE_LEN = 60;
const MAX_RECIPE_TEXT_LEN = 800;
const MAX_RECIPE_INGREDIENTS = 10;
const MAX_COMMENT_LEN = 300;
const MAX_REPORT_REASON_LEN = 300;

// 写真の保存先（Googleドライブの専用フォルダ）。未設定なら初回実行時に自動作成し、
// 作成したフォルダIDをスクリプトプロパティに保存する（手動セットアップ不要）。
function getPhotosFolderId() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty("PHOTOS_FOLDER_ID");
  if (existing) {
    try {
      DriveApp.getFolderById(existing);
      return existing;
    } catch (err) {
      // フォルダが見つからない場合は作り直す
    }
  }
  const folder = DriveApp.createFolder("nokori-mono-photos");
  props.setProperty("PHOTOS_FOLDER_ID", folder.getId());
  return folder.getId();
}

// 送信されたBase64画像を検証してDriveに保存し、fileIdを返す。photoBase64が空なら何もしない。
// ファイルサイズの縮小はフロント側(js/community.js)でCanvasにより行われる前提。ここでは安全網として
// サイズ・MIMEタイプの上限のみ検証する。
const MAX_PHOTO_BASE64_LEN = 4 * 1024 * 1024; // 概ね3MB程度の画像に相当（Base64は元データの約1.37倍）
const ALLOWED_PHOTO_MIME = ["image/jpeg", "image/png", "image/webp"];

function savePhotoIfProvided(photoBase64, mimeType) {
  if (!photoBase64) return "";
  if (typeof photoBase64 !== "string" || photoBase64.length > MAX_PHOTO_BASE64_LEN) {
    throw new Error("photo_too_large");
  }
  const mt = String(mimeType || "image/jpeg");
  if (ALLOWED_PHOTO_MIME.indexOf(mt) === -1) {
    throw new Error("invalid_photo_type");
  }
  let bytes;
  try {
    bytes = Utilities.base64Decode(photoBase64);
  } catch (err) {
    throw new Error("invalid_photo_data");
  }
  const blob = Utilities.newBlob(bytes, mt, "dish.jpg");
  const folder = DriveApp.getFolderById(getPhotosFolderId());
  const file = folder.createFile(blob);
  return file.getId();
}

// ---------- action=postCommunityRecipe ----------
function handlePostCommunityRecipe(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const title = String(body.title || "").trim().slice(0, MAX_RECIPE_TITLE_LEN);
  const description = String(body.description || "").trim().slice(0, MAX_RECIPE_TEXT_LEN);
  const steps = String(body.steps || "").trim().slice(0, MAX_RECIPE_TEXT_LEN);
  const ingredients = sanitizeList(body.ingredients, MAX_RECIPE_INGREDIENTS, MAX_LEN);

  if (!title) return { error: "title_required" };
  if (!description && !steps) return { error: "description_required" };

  if (!checkAndIncrementQuota("postRecipe:" + auth.email, 20)) {
    return { error: "quota_exceeded" };
  }

  let photoFileId = "";
  try {
    photoFileId = savePhotoIfProvided(body.photoBase64, body.mimeType);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }

  const now = new Date().toISOString();
  const id = Utilities.getUuid();
  const sh = openSheetByKey("COMMUNITY_RECIPES");
  const headers = sh.getDataRange().getValues()[0].map((h) => String(h).trim());
  const rowMap = {
    id: id,
    email: auth.email,
    nickname: auth.nickname,
    title: title,
    ingredients: ingredients.join(";"),
    description: description,
    steps: steps,
    photoFileId: photoFileId,
    likeCount: 0,
    commentCount: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  sh.appendRow(headers.map((h) => (rowMap[h] !== undefined ? rowMap[h] : "")));
  return { ok: true, id: id };
}

// ---------- action=updateCommunityRecipe（本人の投稿のみ編集可）----------
function handleUpdateCommunityRecipe(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const recipeId = String(body.recipeId || "");
  if (!recipeId) return { error: "recipeId required" };

  const recipe = findRowById("COMMUNITY_RECIPES", recipeId);
  const st = recipe ? String(recipe.data.status || "active") : "";
  if (!recipe || st === "hidden" || st === "deleted") return { error: "not_found" };
  if (String(recipe.data.email || "").toLowerCase() !== auth.email.toLowerCase()) return { error: "forbidden" };

  const title = String(body.title || "").trim().slice(0, MAX_RECIPE_TITLE_LEN);
  const description = String(body.description || "").trim().slice(0, MAX_RECIPE_TEXT_LEN);
  const steps = String(body.steps || "").trim().slice(0, MAX_RECIPE_TEXT_LEN);
  const ingredients = sanitizeList(body.ingredients, MAX_RECIPE_INGREDIENTS, MAX_LEN);

  if (!title) return { error: "title_required" };
  if (!description && !steps) return { error: "description_required" };

  const updates = {
    title: title,
    ingredients: ingredients.join(";"),
    description: description,
    steps: steps,
    updatedAt: new Date().toISOString(),
  };

  // 写真の差し替え（任意。photoBase64が送られてきた場合のみ）
  if (body.photoBase64) {
    let newPhotoId;
    try {
      newPhotoId = savePhotoIfProvided(body.photoBase64, body.mimeType);
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
    const oldFileId = String(recipe.data.photoFileId || "");
    if (oldFileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (err2) { /* 旧写真の削除失敗は無視 */ }
    }
    updates.photoFileId = newPhotoId;
  } else if (body.removePhoto) {
    const oldFileId = String(recipe.data.photoFileId || "");
    if (oldFileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (err2) { /* 無視 */ }
    }
    updates.photoFileId = "";
  }

  updateRowByIndex("COMMUNITY_RECIPES", recipe.rowIndex, recipe.headers, updates);
  return { ok: true };
}

// ---------- action=deleteCommunityRecipe（本人の投稿のみ削除可。ソフトデリート）----------
function handleDeleteCommunityRecipe(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const recipeId = String(body.recipeId || "");
  if (!recipeId) return { error: "recipeId required" };

  const recipe = findRowById("COMMUNITY_RECIPES", recipeId);
  if (!recipe) return { error: "not_found" };
  if (String(recipe.data.email || "").toLowerCase() !== auth.email.toLowerCase()) return { error: "forbidden" };

  updateRowByIndex("COMMUNITY_RECIPES", recipe.rowIndex, recipe.headers, {
    status: "deleted",
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}

// ---------- action=communityRecipes（GET）----------
function handleListCommunityRecipes(auth, params) {
  const ingredientFilter = params && params.ingredient ? String(params.ingredient) : "";
  const limit = Math.min(Number((params && params.limit) || 30) || 30, 100);

  const rows = sheetToObjects("COMMUNITY_RECIPES").filter((r) => {
    const st = String(r.status || "active");
    return st !== "hidden" && st !== "deleted";
  });
  const likedSet = getLikedRecipeIdsForUser(auth.email);

  let list = rows.map((r) => ({
    id: String(r.id),
    nickname: String(r.nickname || ""),
    title: String(r.title || ""),
    ingredients: String(r.ingredients || "").split(";").map((s) => s.trim()).filter(Boolean),
    description: String(r.description || ""),
    steps: String(r.steps || ""),
    hasPhoto: !!String(r.photoFileId || ""),
    likeCount: Number(r.likeCount) || 0,
    commentCount: Number(r.commentCount) || 0,
    liked: likedSet.indexOf(String(r.id)) !== -1,
    isMine: String(r.email || "").toLowerCase() === auth.email.toLowerCase(),
    createdAt: String(r.createdAt || ""),
  }));

  if (ingredientFilter) {
    list = list.filter((r) => r.ingredients.indexOf(ingredientFilter) !== -1);
  }

  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { recipes: list.slice(0, limit) };
}

function getLikedRecipeIdsForUser(email) {
  const rows = sheetToObjects("RECIPE_LIKES");
  const ids = [];
  rows.forEach((r) => {
    if (String(r.email || "").toLowerCase() === email.toLowerCase()) ids.push(String(r.recipeId));
  });
  return ids;
}

// ---------- action=toggleLike ----------
function handleToggleLike(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const recipeId = String(body.recipeId || "");
  if (!recipeId) return { error: "recipeId required" };

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const recipe = findRowById("COMMUNITY_RECIPES", recipeId);
    if (!recipe || recipe.data.status === "hidden") return { error: "not_found" };

    const likesSheet = openSheetByKey("RECIPE_LIKES");
    const values = likesSheet.getDataRange().getValues();
    const headers = values.length ? values[0].map((h) => String(h).trim()) : ["recipeId", "email", "createdAt"];
    const recipeCol = headers.indexOf("recipeId");
    const emailCol = headers.indexOf("email");
    let existingRow = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][recipeCol]) === recipeId && String(values[i][emailCol]).toLowerCase() === auth.email.toLowerCase()) {
        existingRow = i + 1;
        break;
      }
    }

    let liked, delta;
    if (existingRow > 0) {
      likesSheet.deleteRow(existingRow);
      liked = false;
      delta = -1;
    } else {
      likesSheet.appendRow([recipeId, auth.email, new Date().toISOString()]);
      liked = true;
      delta = 1;
    }

    const newCount = Math.max(0, (Number(recipe.data.likeCount) || 0) + delta);
    updateRowByIndex("COMMUNITY_RECIPES", recipe.rowIndex, recipe.headers, {
      likeCount: newCount,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, liked: liked, likeCount: newCount };
  } finally {
    lock.releaseLock();
  }
}

// ---------- action=commentRecipe / recipeComments(GET) ----------
function handleCommentRecipe(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const recipeId = String(body.recipeId || "");
  const comment = String(body.comment || "").trim().slice(0, MAX_COMMENT_LEN);
  if (!recipeId) return { error: "recipeId required" };
  if (!comment) return { error: "comment_required" };

  const recipe = findRowById("COMMUNITY_RECIPES", recipeId);
  if (!recipe || recipe.data.status === "hidden") return { error: "not_found" };

  if (!checkAndIncrementQuota("comment:" + auth.email, 100)) {
    return { error: "quota_exceeded" };
  }

  const id = Utilities.getUuid();
  const now = new Date().toISOString();
  appendLog("RECIPE_COMMENTS", [id, recipeId, auth.email, auth.nickname, comment, now]);

  updateRowByIndex("COMMUNITY_RECIPES", recipe.rowIndex, recipe.headers, {
    commentCount: (Number(recipe.data.commentCount) || 0) + 1,
    updatedAt: now,
  });

  return { ok: true, id: id, createdAt: now };
}

function handleListComments(auth, params) {
  const recipeId = String((params && params.recipeId) || "");
  if (!recipeId) return { error: "recipeId required" };
  const rows = sheetToObjects("RECIPE_COMMENTS")
    .filter((r) => String(r.recipeId) === recipeId)
    .map((r) => ({
      nickname: String(r.nickname || ""),
      comment: String(r.comment || ""),
      createdAt: String(r.createdAt || ""),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return { comments: rows };
}

// ---------- action=reportRecipe ----------
function handleReportRecipe(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const recipeId = String(body.recipeId || "");
  const reason = String(body.reason || "").trim().slice(0, MAX_REPORT_REASON_LEN);
  if (!recipeId) return { error: "recipeId required" };

  const recipe = findRowById("COMMUNITY_RECIPES", recipeId);
  if (!recipe) return { error: "not_found" };

  if (!checkAndIncrementQuota("report:" + auth.email, 20)) {
    return { error: "quota_exceeded" };
  }

  const id = Utilities.getUuid();
  const now = new Date().toISOString();
  appendLog("RECIPE_REPORTS", [id, recipeId, auth.email, reason, now, "open"]);
  return { ok: true };
}

// ---------- action=photo（GET。Base64エンコードしたJSONとして返す）----------
// Driveの共有リンクを一切公開しないためのプロキシ。session検証を通過した会員だけが取得できる。
// 注: Apps ScriptのdoGetはBlobを直接返すとランタイムによって「サポートされている戻り値の型ではない」
// というエラーになることがあるため、確実に動作するJSON(Base64)方式に統一している。
// フロント側(js/auth.js の getPhotoDataUri)がこれを data:URI に変換して <img> に設定する。
// type=recipe（既定）: CommunityRecipesの写真。全会員が閲覧可（削除以外）。
// type=purchase      : Purchasesの写真（材料費の記録に添付したレシート等）。本人のみ閲覧可（家計情報のため）。
function handlePhoto(params) {
  const auth = requireSession({ session: params.session });
  if (!auth.ok) return jsonOutput({ error: auth.error });

  const type = String(params.type || "recipe");
  const id = String(params.id || params.recipeId || "");
  if (!id) return jsonOutput({ error: "id required" });

  let fileId = "";
  if (type === "purchase") {
    const purchase = findRowById("PURCHASES", id);
    if (!purchase || String(purchase.data.status || "active") === "deleted") return jsonOutput({ error: "not_found" });
    if (String(purchase.data.email || "").toLowerCase() !== auth.email.toLowerCase()) return jsonOutput({ error: "forbidden" });
    fileId = String(purchase.data.photoFileId || "");
  } else {
    const recipe = findRowById("COMMUNITY_RECIPES", id);
    if (!recipe || recipe.data.status === "hidden") return jsonOutput({ error: "not_found" });
    fileId = String(recipe.data.photoFileId || "");
  }
  if (!fileId) return jsonOutput({ error: "no_photo" });

  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    return jsonOutput({
      ok: true,
      mimeType: blob.getContentType() || "image/jpeg",
      photoBase64: Utilities.base64Encode(blob.getBytes()),
    });
  } catch (err) {
    return jsonOutput({ error: "not_found" });
  }
}

// ==========================================================
// 材料費（購入記録・週間集計・みんなの相場）※すべて要ログイン
// ==========================================================
const MAX_INGREDIENT_NAME_LEN = 30;

// 数量の単位を検証する。"count"（個数）または "gram"（グラム）のみ許可。未指定なら単価計算をスキップする。
function validateQuantity(unit, quantity) {
  if (unit !== "count" && unit !== "gram") return "";
  if (!Number.isFinite(quantity) || quantity <= 0) return "invalid_quantity";
  if (unit === "count" && quantity > 9999) return "invalid_quantity";
  if (unit === "gram" && quantity > 100000) return "invalid_quantity";
  return null;
}

// ---------- action=addPurchase ----------
function handleAddPurchase(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const ingredientId = String(body.ingredientId || "").trim().slice(0, MAX_LEN);
  const ingredientName = String(body.ingredientName || "").trim().slice(0, MAX_INGREDIENT_NAME_LEN);
  const price = Number(body.price);
  const unit = body.unit === "count" || body.unit === "gram" ? body.unit : "";
  const quantity = Number(body.quantity);

  if (!ingredientName && !ingredientId) return { error: "ingredient_required" };
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { error: "invalid_price" };
  if (unit) {
    const qErr = validateQuantity(unit, quantity);
    if (qErr) return { error: qErr };
  }

  if (!checkAndIncrementQuota("purchase:" + auth.email, 100)) {
    return { error: "quota_exceeded" };
  }

  let photoFileId = "";
  try {
    photoFileId = savePhotoIfProvided(body.photoBase64, body.mimeType);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }

  let purchasedAt = new Date();
  if (body.purchasedAt) {
    const d = new Date(body.purchasedAt);
    if (!isNaN(d)) purchasedAt = d;
  }

  const id = Utilities.getUuid();
  const now = new Date().toISOString();
  const sh = openSheetByKey("PURCHASES");
  const headers = sh.getDataRange().getValues()[0].map((h) => String(h).trim());
  const rowMap = {
    id: id,
    email: auth.email,
    nickname: auth.nickname,
    ingredientId: ingredientId,
    ingredientName: ingredientName || ingredientId,
    price: Math.round(price),
    quantity: unit ? quantity : "",
    unit: unit,
    photoFileId: photoFileId,
    status: "active",
    purchasedAt: purchasedAt.toISOString(),
    updatedAt: now,
  };
  sh.appendRow(headers.map((h) => (rowMap[h] !== undefined ? rowMap[h] : "")));

  return { ok: true, id: id };
}

// ---------- action=updatePurchase（本人の記録のみ編集可）----------
function handleUpdatePurchase(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const purchaseId = String(body.purchaseId || "");
  if (!purchaseId) return { error: "purchaseId required" };

  const purchase = findRowById("PURCHASES", purchaseId);
  const st = purchase ? String(purchase.data.status || "active") : "";
  if (!purchase || st === "deleted") return { error: "not_found" };
  if (String(purchase.data.email || "").toLowerCase() !== auth.email.toLowerCase()) return { error: "forbidden" };

  const ingredientId = String(body.ingredientId || "").trim().slice(0, MAX_LEN);
  const ingredientName = String(body.ingredientName || "").trim().slice(0, MAX_INGREDIENT_NAME_LEN);
  const price = Number(body.price);
  const unit = body.unit === "count" || body.unit === "gram" ? body.unit : "";
  const quantity = Number(body.quantity);

  if (!ingredientName && !ingredientId) return { error: "ingredient_required" };
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { error: "invalid_price" };
  if (unit) {
    const qErr = validateQuantity(unit, quantity);
    if (qErr) return { error: qErr };
  }

  const updates = {
    ingredientId: ingredientId,
    ingredientName: ingredientName || ingredientId,
    price: Math.round(price),
    quantity: unit ? quantity : "",
    unit: unit,
    updatedAt: new Date().toISOString(),
  };

  if (body.purchasedAt) {
    const d = new Date(body.purchasedAt);
    if (!isNaN(d)) updates.purchasedAt = d.toISOString();
  }

  // 写真の差し替え（任意。photoBase64が送られてきた場合のみ）
  if (body.photoBase64) {
    let newPhotoId;
    try {
      newPhotoId = savePhotoIfProvided(body.photoBase64, body.mimeType);
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
    const oldFileId = String(purchase.data.photoFileId || "");
    if (oldFileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (err2) { /* 旧写真の削除失敗は無視 */ }
    }
    updates.photoFileId = newPhotoId;
  } else if (body.removePhoto) {
    const oldFileId = String(purchase.data.photoFileId || "");
    if (oldFileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (err2) { /* 無視 */ }
    }
    updates.photoFileId = "";
  }

  updateRowByIndex("PURCHASES", purchase.rowIndex, purchase.headers, updates);
  return { ok: true };
}

// ---------- action=deletePurchase（本人の記録のみ削除可。ソフトデリート）----------
function handleDeletePurchase(body) {
  const auth = requireSession(body);
  if (!auth.ok) return { error: auth.error };

  const purchaseId = String(body.purchaseId || "");
  if (!purchaseId) return { error: "purchaseId required" };

  const purchase = findRowById("PURCHASES", purchaseId);
  if (!purchase) return { error: "not_found" };
  if (String(purchase.data.email || "").toLowerCase() !== auth.email.toLowerCase()) return { error: "forbidden" };

  const oldFileId = String(purchase.data.photoFileId || "");
  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (err2) { /* 無視 */ }
  }

  updateRowByIndex("PURCHASES", purchase.rowIndex, purchase.headers, {
    status: "deleted",
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}

// 週の開始（月曜0時）を返す
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=日,1=月,...6=土
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------- action=myPurchases（GET）----------
// 自分の今週の合計・材料ごとの内訳・直近購入履歴、および全会員の直近90日の平均価格（みんなの相場）を返す
// 価格・数量・単位から単価を計算する。単位が個数なら1個あたり、グラムなら100gあたりの価格を返す。
// 単位未設定（従来データ含む）ならnullを返す。
function computeUnitPrice(price, quantity, unit) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (unit === "count") return price / quantity;
  if (unit === "gram") return (price / quantity) * 100;
  return null;
}

function handleMyPurchases(auth) {
  const all = sheetToObjects("PURCHASES").filter((r) => String(r.status || "active") !== "deleted");
  const weekStart = getWeekStart(new Date());

  const mine = all.filter((r) => String(r.email || "").toLowerCase() === auth.email.toLowerCase());
  const mineThisWeek = mine.filter((r) => {
    const d = new Date(r.purchasedAt);
    return !isNaN(d) && d >= weekStart;
  });

  const weekTotal = mineThisWeek.reduce((sum, r) => sum + (Number(r.price) || 0), 0);

  const byIngredientMap = {};
  mineThisWeek.forEach((r) => {
    const key = String(r.ingredientName || r.ingredientId || "その他");
    if (!byIngredientMap[key]) byIngredientMap[key] = { ingredientName: key, total: 0, count: 0 };
    byIngredientMap[key].total += Number(r.price) || 0;
    byIngredientMap[key].count += 1;
  });
  const byIngredient = Object.keys(byIngredientMap)
    .map((k) => byIngredientMap[k])
    .sort((a, b) => b.total - a.total);

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const communityMap = {};
  all.forEach((r) => {
    const d = new Date(r.purchasedAt);
    if (isNaN(d) || d < ninetyDaysAgo) return;
    const key = String(r.ingredientName || r.ingredientId || "その他");
    if (!communityMap[key]) communityMap[key] = { ingredientName: key, total: 0, count: 0 };
    communityMap[key].total += Number(r.price) || 0;
    communityMap[key].count += 1;
  });
  const communityAverage = Object.keys(communityMap)
    .map((k) => {
      const v = communityMap[k];
      return { ingredientName: v.ingredientName, avgPrice: Math.round(v.total / v.count), sampleCount: v.count };
    })
    .sort((a, b) => b.sampleCount - a.sampleCount);

  const recent = mine
    .slice()
    .sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1))
    .slice(0, 20)
    .map((r) => {
      const price = Number(r.price) || 0;
      const quantityRaw = r.quantity;
      const quantity = quantityRaw !== "" && quantityRaw != null && Number.isFinite(Number(quantityRaw)) ? Number(quantityRaw) : null;
      const unit = String(r.unit || "");
      return {
        id: String(r.id || ""),
        ingredientName: String(r.ingredientName || r.ingredientId || ""),
        price: price,
        quantity: quantity,
        unit: unit,
        unitPrice: computeUnitPrice(price, quantity, unit),
        hasPhoto: !!String(r.photoFileId || ""),
        purchasedAt: String(r.purchasedAt || ""),
      };
    });

  return {
    weekStart: Utilities.formatDate(weekStart, "Asia/Tokyo", "yyyy-MM-dd"),
    weekTotal: weekTotal,
    byIngredient: byIngredient,
    communityAverage: communityAverage,
    recent: recent,
  };
}
