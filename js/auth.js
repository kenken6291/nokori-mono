/**
 * nokori-mono 認証モジュール
 * ------------------------------------------------------------
 * ログイン/会員登録/パスワード再発行/初回パスワード変更/規約同意/ニックネーム変更/ログアウトを扱う。
 * app.js（本編のレシピ機能）は、ここが発行する window.NokoriAuth 経由でのみ
 * GASバックエンドと通信する（session付きのAPI呼び出しをラップしているため）。
 *
 * セッションはCookieではなくlocalStorageのトークン文字列として保持する。
 * （Cookie不使用のため、古典的なCSRFの主要な攻撃経路が存在しない構成）
 */
(function () {
  "use strict";

  // STEP5: GASデプロイ後にこの2行を書き換える（SETUP_GUIDE.md参照）
  const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbyazjd-VAu45MOqJz66HRgg6G9Rii2a4UC2Hk6toaf_yKfRfRAVVg9FhZuLUR8oaTR1/exec"; // 例: "https://script.google.com/macros/s/AKfycb.../exec"
  const APP_TOKEN = "nokori-2026-xyz";

  const SESSION_KEY = "nokori-mono:session";
  const PROFILE_KEY = "nokori-mono:profile";

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------
  // セッション保存
  // ---------------------------------------------------------
  function getSession() { return localStorage.getItem(SESSION_KEY) || ""; }
  function setSession(token) { if (token) localStorage.setItem(SESSION_KEY, token); }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PROFILE_KEY);
  }
  function getProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null"); } catch (e) { return null; }
  }
  function setProfile(p) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }

  // ---------------------------------------------------------
  // GAS通信（text/plainで送りプリフライトを回避する。gas/Code.gs冒頭コメント参照）
  // ---------------------------------------------------------
  async function gasPost(action, payload) {
    if (!GAS_ENDPOINT) throw new Error("not_configured");
    const res = await fetch(GAS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ action, token: APP_TOKEN }, payload)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function gasGet(action, params) {
    if (!GAS_ENDPOINT) throw new Error("not_configured");
    const qs = new URLSearchParams(Object.assign({ action }, params || {}));
    const res = await fetch(`${GAS_ENDPOINT}?${qs.toString()}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // ログイン必須API用ラッパー。セッション切れ等を検知したら自動でログイン画面に戻す。
  async function authedPost(action, payload) {
    const data = await gasPost(action, Object.assign({ session: getSession() }, payload));
    handleAuthError(data);
    return data;
  }
  async function authedGet(action, params) {
    const data = await gasGet(action, Object.assign({ session: getSession() }, params || {}));
    handleAuthError(data);
    return data;
  }

  // コミュニティレシピ／材料費の写真を取得し、<img>にそのまま設定できるdata:URIを返す
  // （GAS自身のaction=photoを経由する非公開プロキシ。Blobを直接返すdoGetは環境によってエラーになるため
  // JSON+Base64方式に統一し、ここでdata:URIへ変換する）。
  // type: "recipe"（既定, みんなのレシピ）または "purchase"（材料費の記録。本人のみ閲覧可）
  async function getPhotoDataUri(id, type) {
    try {
      const data = await authedGet("photo", { id, type: type || "recipe" });
      if (!data || data.error || !data.photoBase64) return "";
      return `data:${data.mimeType || "image/jpeg"};base64,${data.photoBase64}`;
    } catch (e) {
      return "";
    }
  }
  function handleAuthError(data) {
    if (data && (data.error === "unauthorized" || data.error === "session_expired" || data.error === "account_disabled")) {
      clearSession();
      showAuthScreen();
      showView("login");
      setError("login", data.error === "account_disabled" ? "アカウントが無効化されています" : "セッションの有効期限が切れました。再度ログインしてください。");
    }
  }

  // ---------------------------------------------------------
  // 画面制御
  // ---------------------------------------------------------
  function showAuthScreen() { $("authScreen").hidden = false; $("appRoot").hidden = true; }
  function hideAuthScreen() { $("authScreen").hidden = true; $("appRoot").hidden = false; }

  const VIEWS = ["login", "register", "forgot", "changePassword", "agreeTerms"];
  function showView(name) {
    VIEWS.forEach((v) => {
      const el = document.querySelector(`.auth-view[data-view="${v}"]`);
      if (el) el.hidden = v !== name;
    });
    clearErrors();
  }
  function clearErrors() {
    document.querySelectorAll(".auth-error").forEach((el) => {
      el.textContent = "";
      el.hidden = true;
      el.classList.remove("info");
    });
  }
  function setError(view, message, info) {
    const el = document.querySelector(`.auth-view[data-view="${view}"] .auth-error`);
    if (el) {
      el.textContent = message;
      el.hidden = false;
      el.classList.toggle("info", !!info);
    }
  }

  const ERROR_MESSAGES = {
    invalid_credentials: "メールアドレスまたはパスワードが正しくありません",
    account_locked: "ログイン試行回数が上限に達しました。しばらく時間をおいて再度お試しください",
    account_disabled: "このアカウントは無効化されています",
    invalid_email: "メールアドレスの形式が正しくありません",
    nickname_required: "ニックネームを入力してください",
    fullName_required: "氏名を入力してください",
    agree_terms_required: "利用規約・免責事項への同意が必要です",
    already_registered: "このメールアドレスは既に登録されています",
    quota_exceeded: "只今アクセスが集中しています。しばらくしてから再度お試しください",
    mail_failed: "メール送信に失敗しました。時間をおいて「パスワードを忘れた場合」から再度お試しください",
    password_too_short: "パスワードは8文字以上で設定してください",
    password_too_weak: "パスワードは英字と数字を両方含めてください",
    password_too_long: "パスワードが長すぎます",
    invalid_or_expired_ticket: "セッションの有効期限が切れました。もう一度ログインしてください",
    agree_required: "同意のチェックが必要です",
    unauthorized: "認証エラーが発生しました。もう一度ログインしてください",
    not_configured: "サーバーが未設定です。管理者にお問い合わせください。",
  };
  function messageFor(code) { return ERROR_MESSAGES[code] || "エラーが発生しました。時間をおいて再度お試しください"; }

  // ---------------------------------------------------------
  // パスワード表示切替
  // ---------------------------------------------------------
  function wireTogglePassword() {
    document.querySelectorAll(".toggle-pw").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = $(btn.dataset.target);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "隠す" : "表示";
        btn.setAttribute("aria-pressed", String(show));
      });
    });
  }

  // ---------------------------------------------------------
  // 利用規約の読み込み（legal/terms.html の #termsBody を取り込む）
  // ---------------------------------------------------------
  let termsHtmlCache = "";
  async function loadTermsHtml() {
    if (termsHtmlCache) return termsHtmlCache;
    try {
      const res = await fetch("legal/terms.html");
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, "text/html");
      const body = doc.getElementById("termsBody");
      termsHtmlCache = body ? body.innerHTML : "<p>規約の読み込みに失敗しました。<a href=\"legal/terms.html\" target=\"_blank\">こちら</a>から確認してください。</p>";
    } catch (e) {
      termsHtmlCache = "<p>規約の読み込みに失敗しました。<a href=\"legal/terms.html\" target=\"_blank\">こちら</a>から確認してください。</p>";
    }
    return termsHtmlCache;
  }

  // ---------------------------------------------------------
  // フォーム処理
  // ---------------------------------------------------------
  let pendingTicket = { changePassword: "", agreeTerms: "" };

  async function onLogin(e) {
    e.preventDefault();
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    setBusy("login", true);
    try {
      const data = await gasPost("login", { email, password });
      if (!data || data.error) { setError("login", messageFor(data && data.error)); return; }
      await handleLoginStep(data);
    } catch (err) {
      setError("login", messageFor(err && err.message === "not_configured" ? "not_configured" : ""));
    } finally {
      setBusy("login", false);
    }
  }

  async function handleLoginStep(data) {
    if (data.step === "changePassword") {
      pendingTicket.changePassword = data.ticket;
      $("changePasswordForm").reset();
      showView("changePassword");
      return;
    }
    if (data.step === "agreeTerms") {
      pendingTicket.agreeTerms = data.ticket;
      $("agreeTermsContent").innerHTML = await loadTermsHtml();
      $("agreeTermsCheckbox").checked = false;
      $("agreeTermsSubmit").disabled = true;
      showView("agreeTerms");
      return;
    }
    completeLogin(data);
  }

  function completeLogin(data) {
    setSession(data.session);
    setProfile(data.profile);
    applyProfileToHeader(data.profile);
    hideAuthScreen();
    window.dispatchEvent(new CustomEvent("nokori-auth-ready", { detail: { profile: data.profile } }));
  }

  async function onRegister(e) {
    e.preventDefault();
    const email = $("registerEmail").value.trim();
    const nickname = $("registerNickname").value.trim();
    const fullName = $("registerFullName").value.trim();
    const agree = $("registerAgree").checked;
    setBusy("register", true);
    try {
      const data = await gasPost("register", { email, nickname, fullName, agreeTerms: agree });
      if (!data || data.error) { setError("register", messageFor(data && data.error)); return; }
      $("registerForm").reset();
      $("registerSubmit").disabled = true;
      showView("login");
      setError("login", "登録が完了しました。届いたメールの仮パスワードでログインしてください。", true);
    } catch (err) {
      setError("register", messageFor(err && err.message === "not_configured" ? "not_configured" : ""));
    } finally {
      setBusy("register", false);
    }
  }

  async function onForgot(e) {
    e.preventDefault();
    const email = $("forgotEmail").value.trim();
    setBusy("forgot", true);
    try {
      await gasPost("forgotPassword", { email });
      $("forgotForm").reset();
      showView("login");
      setError("login", "ご登録のメールアドレス宛に仮パスワードを送信しました（該当アカウントが無い場合、メールは届きません）。", true);
    } catch (err) {
      setError("forgot", messageFor(err && err.message === "not_configured" ? "not_configured" : ""));
    } finally {
      setBusy("forgot", false);
    }
  }

  async function onChangePassword(e) {
    e.preventDefault();
    const p1 = $("newPassword").value;
    const p2 = $("newPasswordConfirm").value;
    if (p1 !== p2) { setError("changePassword", "新しいパスワードが一致しません"); return; }
    setBusy("changePassword", true);
    try {
      const data = await gasPost("setNewPassword", { ticket: pendingTicket.changePassword, newPassword: p1 });
      if (!data || data.error) { setError("changePassword", messageFor(data && data.error)); return; }
      pendingTicket.changePassword = "";
      await handleLoginStep(data);
    } catch (err) {
      setError("changePassword", messageFor(err && err.message === "not_configured" ? "not_configured" : ""));
    } finally {
      setBusy("changePassword", false);
    }
  }

  async function onAgreeTerms(e) {
    e.preventDefault();
    setBusy("agreeTerms", true);
    try {
      const data = await gasPost("agreeTerms", { ticket: pendingTicket.agreeTerms, agree: true });
      if (!data || data.error) { setError("agreeTerms", messageFor(data && data.error)); return; }
      pendingTicket.agreeTerms = "";
      completeLogin(data);
    } catch (err) {
      setError("agreeTerms", messageFor(err && err.message === "not_configured" ? "not_configured" : ""));
    } finally {
      setBusy("agreeTerms", false);
    }
  }

  async function onLogout() {
    try { await authedPost("logout", {}); } catch (err) { /* ローカルの状態は消すので失敗しても続行 */ }
    clearSession();
    $("accountMenu").hidden = true;
    showAuthScreen();
    showView("login");
  }

  async function onUpdateNickname(e) {
    e.preventDefault();
    const nickname = $("nicknameInput").value.trim();
    if (!nickname) return;
    try {
      const data = await authedPost("updateNickname", { nickname });
      if (!data || data.error) { alert(messageFor(data && data.error)); return; }
      const profile = Object.assign({}, getProfile(), { nickname: data.nickname });
      setProfile(profile);
      applyProfileToHeader(profile);
      $("nicknameForm").hidden = true;
    } catch (err) {
      alert(messageFor(err && err.message === "not_configured" ? "not_configured" : ""));
    }
  }

  function applyProfileToHeader(profile) {
    const label = $("nicknameLabel");
    if (label) label.textContent = (profile && profile.nickname) || "";
  }

  function setBusy(view, busy) {
    const btn = document.querySelector(`.auth-view[data-view="${view}"] button[type="submit"]`);
    if (btn) btn.disabled = busy;
  }

  // ---------------------------------------------------------
  // 初期化・セッション復元
  // ---------------------------------------------------------
  async function bootstrap() {
    const session = getSession();
    const cachedProfile = getProfile();
    if (!session) { showAuthScreen(); showView("login"); return; }
    try {
      const data = await gasGet("whoami", { session });
      if (data && data.ok) {
        setProfile(data.profile);
        applyProfileToHeader(data.profile);
        hideAuthScreen();
        window.dispatchEvent(new CustomEvent("nokori-auth-ready", { detail: { profile: data.profile } }));
        return;
      }
    } catch (err) {
      // ネットワーク不可時は、キャッシュ済みプロフィールで一旦表示だけ試みる（AI提案等はオンライン復帰後に動作）
      if (cachedProfile) {
        applyProfileToHeader(cachedProfile);
        hideAuthScreen();
        window.dispatchEvent(new CustomEvent("nokori-auth-ready", { detail: { profile: cachedProfile, offline: true } }));
        return;
      }
    }
    clearSession();
    showAuthScreen();
    showView("login");
  }

  function init() {
    wireTogglePassword();

    document.querySelectorAll("[data-switch-view]").forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); showView(el.dataset.switchView); });
    });

    $("loginForm").addEventListener("submit", onLogin);
    $("registerForm").addEventListener("submit", onRegister);
    $("forgotForm").addEventListener("submit", onForgot);
    $("changePasswordForm").addEventListener("submit", onChangePassword);
    $("agreeTermsForm").addEventListener("submit", onAgreeTerms);
    $("agreeTermsCheckbox").addEventListener("change", (e) => { $("agreeTermsSubmit").disabled = !e.target.checked; });
    $("registerAgree").addEventListener("change", (e) => { $("registerSubmit").disabled = !e.target.checked; });

    $("logoutBtn").addEventListener("click", onLogout);
    $("accountBtn").addEventListener("click", () => { $("accountMenu").hidden = !$("accountMenu").hidden; });
    $("editNicknameBtn").addEventListener("click", () => {
      $("accountMenu").hidden = true;
      $("nicknameForm").hidden = false;
      $("nicknameInput").value = (getProfile() || {}).nickname || "";
      $("nicknameInput").focus();
    });
    $("nicknameForm").addEventListener("submit", onUpdateNickname);
    $("nicknameCancelBtn").addEventListener("click", () => { $("nicknameForm").hidden = true; });

    bootstrap();
  }

  document.addEventListener("DOMContentLoaded", init);

  // app.js / community.js / costs.js から使う公開インターフェース
  window.NokoriAuth = { authedPost, authedGet, getProfile, getSession, getPhotoDataUri };
})();
