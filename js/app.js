/**
 * nokori-mono 本編（レシピ提案アプリ）
 * ------------------------------------------------------------
 * ログイン済みユーザーのみが利用できる。auth.js が発行する
 * "nokori-auth-ready" イベントを合図に初期化する。
 * GASへの通信はすべて window.NokoriAuth.authedGet/authedPost 経由（sessionトークンが自動付与される）。
 */
(function () {
  "use strict";

  /* ==========================================================
     1) データ（ローカル既定値。GAS_ENDPOINT設定時はサーバーの値で上書きされる）
     ========================================================== */
  const INGREDIENTS = {
    protein: [
      {id:"egg",   name:"卵",     emoji:"🥚"},
      {id:"pork",  name:"豚肉",   emoji:"🥩"},
      {id:"chicken",name:"鶏肉",  emoji:"🍗"},
      {id:"tofu",  name:"豆腐",   emoji:"⬜"},
      {id:"bacon", name:"ベーコン",emoji:"🥓"},
      {id:"tuna",  name:"ツナ缶", emoji:"🐟"},
    ],
    veg: [
      {id:"cabbage",name:"キャベツ",emoji:"🥬"},
      {id:"onion", name:"玉ねぎ",  emoji:"🧅"},
      {id:"carrot",name:"にんじん",emoji:"🥕"},
      {id:"potato",name:"じゃがいも",emoji:"🥔"},
      {id:"moyashi",name:"もやし", emoji:"🌱"},
      {id:"pepper",name:"ピーマン",emoji:"🫑"},
      {id:"daikon",name:"大根",   emoji:"⚪"},
      {id:"negi",  name:"長ねぎ",  emoji:"🥬"},
      {id:"tomato",name:"トマト",  emoji:"🍅"},
      {id:"kinoko",name:"きのこ",  emoji:"🍄"},
    ],
    other: [
      {id:"rice",  name:"ご飯",   emoji:"🍚"},
      {id:"noodle",name:"うどん", emoji:"🍜"},
      {id:"chikuwa",name:"ちくわ",emoji:"🍥"},
      {id:"cheese",name:"チーズ", emoji:"🧀"},
    ],
  };

  let RECIPES = [
    {name:"豚たま野菜炒め", needs:["pork","egg"],            desc:"豚肉と卵をさっと炒め、塩こしょうとしょうゆで。野菜があれば一緒に。", time_min:15, calories:420},
    {name:"肉じゃが",       needs:["pork","potato","onion"], desc:"定番の甘辛煮。じゃがいもは煮崩れる直前が食べごろ。", time_min:35, calories:480},
    {name:"親子丼",         needs:["chicken","egg","rice"],  desc:"めんつゆで鶏肉と玉ねぎを煮て卵でとじ、ご飯へ。", time_min:20, calories:650},
    {name:"野菜たっぷり回鍋肉風", needs:["pork","cabbage"],  desc:"キャベツと豚肉を味噌だれで炒めるだけの時短おかず。", time_min:15, calories:400},
    {name:"豆腐チャンプルー", needs:["tofu","moyashi","egg"],desc:"水切り豆腐ともやしを炒め、卵でまとめて鰹節を。", time_min:15, calories:310},
    {name:"ツナトマトパスタ風うどん", needs:["tuna","tomato","noodle"], desc:"トマトとツナを煮詰めてうどんに絡める和洋折衷。", time_min:15, calories:450},
    {name:"チーズオムライス", needs:["egg","rice","cheese"], desc:"ケチャップライスをチーズ入り卵で包む鉄板メニュー。", time_min:20, calories:600},
  ];
  let FEATURED = [];

  /* ==========================================================
     2) i18n
     ========================================================== */
  const I18N = {
    ja: {
      sub:"冷蔵庫の残り物、ぜんぶ味方。",
      lede:"冷蔵庫にある食材を<b>3つまで</b>タップ。下のまな板にのせたら、定番レシピを提案します。",
      catProtein:"お肉・たんぱく質", catVeg:"野菜", catOther:"主食・その他",
      timeFilter:"15分以内", excludeLabel:"除外食材を指定", cameraLabel:"写真から選ぶ",
      rememberText:"前回のまな板を再現しますか？", restore:"再現する", dismiss:"閉じる",
      modeNormal:"この食材で作る", modeAddOne:"あと1品買い足す",
      boardHint:"ここに食材がのります（タップで外せます）",
      back:"← 食材を選びなおす",
      noHitTitle:"ぴったりの定番が見つかりませんでした", noHitDesc:"組み合わせを1つ変えてみてください。",
      aiThinkingTitle:"AIシェフが考え中…", aiThinkingDesc:"残り物の活かし方を提案します。",
      aiFailTitle:"AI提案を取得できませんでした", aiFailDesc:"通信状況を確認して、もう一度検索してください。（上の定番レシピは利用できます）",
      feedbackTitle:"この提案は役に立ちましたか？", feedbackPlaceholder:"ひとことコメント（任意）",
      submit:"送信", thanks:"ありがとうございました！",
      footer:"nokori-mono — たべものを、さいごまでおいしく。",
      fullBadge:"全部使える", partialBadge:(n)=>`${n}つ使える`, aiBadge:"AI提案", minLabel:(n)=>`${n}分`, calLabel:(n)=>`${n}kcal`,
      boardFull:"まな板がいっぱいです。どれかを外してください",
      visionNone:"写真から食材を認識できませんでした",
      visionOk:(n)=>`写真から${n}件の食材を選択しました`,
    },
    en: {
      sub:"Everything in your fridge is on your side.",
      lede:"Tap up to <b>3 ingredients</b> from your fridge. Put them on the board below to get recipe ideas.",
      catProtein:"Protein", catVeg:"Vegetables", catOther:"Staples & More",
      timeFilter:"Under 15 min", excludeLabel:"Exclude ingredients", cameraLabel:"Scan a photo",
      rememberText:"Restore your last board?", restore:"Restore", dismiss:"Dismiss",
      modeNormal:"Cook with these", modeAddOne:"Buy just one more",
      boardHint:"Selected ingredients appear here (tap to remove)",
      back:"← Change ingredients",
      noHitTitle:"No exact match found", noHitDesc:"Try swapping one ingredient.",
      aiThinkingTitle:"AI chef is thinking…", aiThinkingDesc:"Finding the best way to use your leftovers.",
      aiFailTitle:"Couldn't get AI suggestions", aiFailDesc:"Check your connection and try again. (Suggestions above still work.)",
      feedbackTitle:"Was this helpful?", feedbackPlaceholder:"Leave a comment (optional)",
      submit:"Submit", thanks:"Thanks for your feedback!",
      footer:"nokori-mono — enjoy your food to the very last bite.",
      fullBadge:"Uses all", partialBadge:(n)=>`Uses ${n}`, aiBadge:"AI idea", minLabel:(n)=>`${n} min`, calLabel:(n)=>`${n} kcal`,
      boardFull:"Board is full. Remove one to add another.",
      visionNone:"Couldn't recognize ingredients in the photo",
      visionOk:(n)=>`Selected ${n} ingredient(s) from the photo`,
    },
  };
  let lang = localStorage.getItem("nokori-mono:lang") || "ja";

  function t(key, ...args) {
    const v = (I18N[lang] || I18N.ja)[key];
    return typeof v === "function" ? v(...args) : v;
  }

  function applyI18n() {
    document.documentElement.lang = lang;
    document.getElementById("brandSub").textContent = t("sub");
    document.getElementById("ledeText").innerHTML = t("lede");
    document.getElementById("catProtein").textContent = t("catProtein");
    document.getElementById("catVeg").textContent = t("catVeg");
    document.getElementById("catOther").textContent = t("catOther");
    document.getElementById("timeFilterLabel").textContent = t("timeFilter");
    document.getElementById("excludeLabel").textContent = t("excludeLabel");
    document.getElementById("cameraLabel").textContent = t("cameraLabel");
    document.getElementById("rememberText").textContent = t("rememberText");
    document.getElementById("restoreBtn").textContent = t("restore");
    document.getElementById("dismissBannerBtn").textContent = t("dismiss");
    document.getElementById("modeNormalBtn").textContent = t("modeNormal");
    document.getElementById("modeAddOneBtn").textContent = t("modeAddOne");
    document.getElementById("boardHint").textContent = t("boardHint");
    document.getElementById("backBtn").textContent = t("back");
    document.getElementById("feedbackTitle").textContent = t("feedbackTitle");
    document.getElementById("feedbackComment").placeholder = t("feedbackPlaceholder");
    document.getElementById("feedbackSubmit").textContent = t("submit");
    document.getElementById("footerText").textContent = t("footer");
    document.getElementById("langToggle").textContent = lang === "ja" ? "EN" : "日本語";
    renderBoard();
  }

  document.getElementById("langToggle").addEventListener("click", () => {
    lang = lang === "ja" ? "en" : "ja";
    localStorage.setItem("nokori-mono:lang", lang);
    applyI18n();
  });

  /* ==========================================================
     3) 状態と描画
     ========================================================== */
  const MAX = 3;
  let selected = [];
  let excludeIds = [];
  let excludeMode = false;
  let timeFilterOn = false;
  let mode = "normal";

  let flat = Object.values(INGREDIENTS).flat();
  let byId = Object.fromEntries(flat.map(i => [i.id, i]));

  function rebuildIndex() {
    flat = Object.values(INGREDIENTS).flat();
    byId = Object.fromEntries(flat.map(i => [i.id, i]));
  }

  function renderGrids() {
    for (const [cat, items] of Object.entries(INGREDIENTS)) {
      const grid = document.querySelector(`.grid[data-cat="${cat}"]`);
      if (!grid) continue;
      grid.innerHTML = "";
      for (const it of items) {
        const b = document.createElement("button");
        b.className = "ing";
        b.type = "button";
        b.dataset.id = it.id;
        const isExcluded = excludeMode && excludeIds.includes(it.id);
        b.classList.toggle("excluded", isExcluded);
        b.setAttribute("aria-pressed", selected.includes(it.id));
        b.disabled = !selected.includes(it.id) && selected.length >= MAX && !excludeMode;
        const isFeatured = FEATURED.some(f => f.ingredient_id === it.id);
        b.innerHTML = `<span class="emoji" aria-hidden="true">${it.emoji}</span>${it.name}${isFeatured ? '<span class="featured-badge">PR</span>' : ""}`;
        b.addEventListener("click", () => excludeMode ? toggleExclude(it.id) : toggle(it.id));
        grid.appendChild(b);
      }
    }
  }

  function toggleExclude(id) {
    excludeIds = excludeIds.includes(id) ? excludeIds.filter(x => x !== id) : [...excludeIds, id];
    renderGrids();
  }

  function renderBoard() {
    const board = document.getElementById("board");
    const hint = document.getElementById("boardHint");
    board.querySelectorAll(".chip").forEach(c => c.remove());
    hint.style.display = selected.length ? "none" : "";
    for (const id of selected) {
      const it = byId[id];
      if (!it) continue;
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.setAttribute("role", "listitem");
      chip.setAttribute("aria-label", `${it.name}`);
      chip.innerHTML = `${it.emoji} ${it.name} <span class="x">✕</span>`;
      chip.addEventListener("click", () => toggle(id));
      board.appendChild(chip);
    }
    const btn = document.getElementById("searchBtn");
    btn.disabled = selected.length === 0;
    const n = selected.length || 3;
    btn.innerHTML = lang === "ja" ? `この${n}つで<br>検索` : `Search with<br>${n}`;
  }

  function toggle(id) {
    if (selected.includes(id)) {
      selected = selected.filter(x => x !== id);
    } else if (selected.length < MAX) {
      selected = [...selected, id];
    } else {
      showToast(t("boardFull"));
      return;
    }
    saveLastBoard();
    renderGrids();
    renderBoard();
  }

  document.getElementById("excludeToggleBtn").addEventListener("click", (e) => {
    excludeMode = !excludeMode;
    e.currentTarget.setAttribute("aria-pressed", String(excludeMode));
    renderGrids();
  });
  document.getElementById("timeFilterBtn").addEventListener("click", (e) => {
    timeFilterOn = !timeFilterOn;
    e.currentTarget.setAttribute("aria-pressed", String(timeFilterOn));
  });
  document.getElementById("modeNormalBtn").addEventListener("click", () => {
    mode = "normal";
    document.getElementById("modeNormalBtn").setAttribute("aria-pressed", "true");
    document.getElementById("modeAddOneBtn").setAttribute("aria-pressed", "false");
  });
  document.getElementById("modeAddOneBtn").addEventListener("click", () => {
    mode = "addOne";
    document.getElementById("modeAddOneBtn").setAttribute("aria-pressed", "true");
    document.getElementById("modeNormalBtn").setAttribute("aria-pressed", "false");
  });

  /* ==========================================================
     4) 選択の記憶（localStorage）
     ========================================================== */
  function saveLastBoard() {
    localStorage.setItem("nokori-mono:lastBoard", JSON.stringify(selected));
  }
  function checkLastBoard() {
    try {
      const last = JSON.parse(localStorage.getItem("nokori-mono:lastBoard") || "[]");
      if (Array.isArray(last) && last.length && last.some(id => !selected.includes(id))) {
        document.getElementById("rememberBanner").hidden = false;
        document.getElementById("restoreBtn").onclick = () => {
          selected = last.filter(id => byId[id]).slice(0, MAX);
          document.getElementById("rememberBanner").hidden = true;
          renderGrids(); renderBoard();
        };
        document.getElementById("dismissBannerBtn").onclick = () => {
          document.getElementById("rememberBanner").hidden = true;
        };
      }
    } catch (e) { /* noop */ }
  }

  /* ==========================================================
     5) トースト
     ========================================================== */
  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* ==========================================================
     6) GAS経由のデータ取得（session付き）
     ========================================================== */
  async function loadRemoteData() {
    try {
      const [ingRes, recRes, featRes] = await Promise.all([
        window.NokoriAuth.authedGet("ingredients"),
        window.NokoriAuth.authedGet("recipes"),
        window.NokoriAuth.authedGet("featured"),
      ]);
      if (ingRes && Array.isArray(ingRes.ingredients) && ingRes.ingredients.length) {
        const grouped = {};
        for (const i of ingRes.ingredients) {
          (grouped[i.category] ||= []).push({ id: i.id, name: i.name, emoji: i.emoji });
        }
        Object.keys(INGREDIENTS).forEach(k => delete INGREDIENTS[k]);
        Object.assign(INGREDIENTS, grouped);
        rebuildIndex();
      }
      if (recRes && Array.isArray(recRes.recipes) && recRes.recipes.length) {
        RECIPES = recRes.recipes;
      }
      if (featRes && Array.isArray(featRes.featured)) {
        FEATURED = featRes.featured;
      }
      renderGrids();
      renderBoard();
    } catch (e) {
      console.warn("loadRemoteData failed, using local defaults", e);
    }
  }

  /* ==========================================================
     7) 検索
     ========================================================== */
  function scoreRecipe(r) {
    return r.needs.filter(n => selected.includes(n)).length;
  }

  async function search() {
    const list = document.getElementById("recipeList");
    document.getElementById("picker").hidden = true;
    const resultView = document.getElementById("resultView");
    resultView.hidden = false;
    resultView.scrollIntoView({ behavior: "smooth", block: "start" });
    resultView.focus({ preventScroll: true });
    resetFeedbackUI();

    let hits = RECIPES
      .map(r => ({ ...r, score: scoreRecipe(r) }))
      .filter(r => r.score > 0)
      .filter(r => !timeFilterOn || (r.time_min && r.time_min <= 15))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    list.innerHTML = hits.length
      ? hits.map(r => recipeCardHtml(r, false)).join("")
      : `<article class="recipe"><h3>${t("noHitTitle")}</h3><p>${t("noHitDesc")}</p></article>`;

    const loading = document.createElement("article");
    loading.className = "recipe";
    loading.innerHTML = `<h3>${t("aiThinkingTitle")}</h3><p>${t("aiThinkingDesc")}</p>`;
    list.appendChild(loading);

    try {
      const data = await window.NokoriAuth.authedPost("suggest", {
        ingredients: selected.map(id => byId[id].name),
        exclude: excludeIds.map(id => byId[id]?.name).filter(Boolean),
        mode, lang,
      });
      if (!data || data.error) throw new Error(data && data.error || "no data");
      loading.remove();
      for (const r of (data.recipes || [])) {
        const el = document.createElement("article");
        el.className = "recipe";
        el.innerHTML = recipeCardHtml({ name: r.name, desc: r.desc, time_min: r.time_min, calories: r.calories }, true);
        list.appendChild(el);
      }
    } catch (e) {
      loading.innerHTML = `<h3>${t("aiFailTitle")}</h3><p>${t("aiFailDesc")}</p>`;
    }
  }

  function recipeCardHtml(r, isAi) {
    const badges = [];
    if (!isAi) {
      const needCount = r.needs ? r.needs.length : 0;
      if (r.score === needCount) badges.push(`<span class="badge full">${t("fullBadge")}</span>`);
      else if (r.score) badges.push(`<span class="badge partial">${t("partialBadge", r.score)}</span>`);
    } else {
      badges.push(`<span class="badge ai">${t("aiBadge")}</span>`);
    }
    if (r.time_min) badges.push(`<span class="badge time">⏱ ${t("minLabel", r.time_min)}</span>`);
    if (r.calories) badges.push(`<span class="badge cal">🔥 ${t("calLabel", r.calories)}</span>`);
    return `<article class="recipe"><h3>${isAi ? "🤖 " : ""}${escapeHtml(r.name)}</h3><p>${escapeHtml(r.desc)}</p><div class="meta">${badges.join("")}</div></article>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  document.getElementById("searchBtn").addEventListener("click", search);
  document.getElementById("backBtn").addEventListener("click", () => {
    document.getElementById("picker").hidden = false;
    document.getElementById("resultView").hidden = true;
  });

  /* ==========================================================
     8) 写真から食材認識（Gemini Vision, GAS経由）
     ========================================================== */
  document.getElementById("cameraBtn").addEventListener("click", () => {
    document.getElementById("photoInput").click();
  });

  document.getElementById("photoInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    showToast(lang === "ja" ? "写真を解析中…" : "Analyzing photo…");
    try {
      const b64 = await fileToBase64(file);
      const data = await window.NokoriAuth.authedPost("vision", { imageBase64: b64, mimeType: file.type || "image/jpeg" });
      if (!data || data.error) throw new Error(data && data.error || "vision failed");
      const matched = (data.matched || []).filter(id => byId[id]);
      if (!matched.length) { showToast(t("visionNone")); return; }
      selected = matched.slice(0, MAX);
      saveLastBoard();
      renderGrids();
      renderBoard();
      showToast(t("visionOk")(selected.length));
    } catch (err) {
      showToast(t("visionNone"));
    } finally {
      e.target.value = "";
    }
  });

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ==========================================================
     9) フィードバック
     ========================================================== */
  let feedbackRating = 0;
  document.querySelectorAll("#stars button").forEach(btn => {
    btn.addEventListener("click", () => {
      feedbackRating = Number(btn.dataset.v);
      document.querySelectorAll("#stars button").forEach(b => {
        b.classList.toggle("active", Number(b.dataset.v) <= feedbackRating);
      });
    });
  });
  document.getElementById("feedbackSubmit").addEventListener("click", async () => {
    const comment = document.getElementById("feedbackComment").value;
    document.getElementById("feedbackSubmit").disabled = true;
    try {
      await window.NokoriAuth.authedPost("feedback", {
        rating: feedbackRating || 0,
        comment,
        ingredients: selected.map(id => byId[id]?.name).filter(Boolean),
      });
    } catch (e) { /* 失敗しても致命的ではないので握りつぶす */ }
    document.getElementById("feedbackBlock").querySelectorAll("h4,.stars,textarea,.submit").forEach(el => el.style.display = "none");
    document.getElementById("feedbackThanks").hidden = false;
    document.getElementById("feedbackThanks").textContent = t("thanks");
  });
  function resetFeedbackUI() {
    feedbackRating = 0;
    document.querySelectorAll("#stars button").forEach(b => b.classList.remove("active"));
    document.getElementById("feedbackComment").value = "";
    document.getElementById("feedbackSubmit").disabled = false;
    document.getElementById("feedbackBlock").querySelectorAll("h4,.stars,textarea,.submit").forEach(el => el.style.display = "");
    document.getElementById("feedbackThanks").hidden = true;
  }

  /* ==========================================================
     10) PWA: Service Worker登録
     ========================================================== */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {/* noop */});
    });
  }

  /* ==========================================================
     11) タブ切り替え（食材で探す／みんなのレシピ／材料費）
     ========================================================== */
  function initTabs() {
    const tabBtns = document.querySelectorAll(".tab-btn");
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        tabBtns.forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
        document.querySelectorAll(".tab-panel").forEach((p) => {
          p.hidden = p.dataset.tabPanel !== tab;
        });
        window.dispatchEvent(new CustomEvent("nokori-tab-shown", { detail: { tab } }));
      });
    });
  }

  /* ==========================================================
     12) 初期化（ログイン成功後にauth.jsから呼ばれる）
     ========================================================== */
  let started = false;
  function initApp() {
    if (started) return; // 二重初期化防止（再ログイン時など）
    started = true;
    applyI18n();
    renderGrids();
    renderBoard();
    checkLastBoard();
    loadRemoteData();
    initTabs();
  }

  window.addEventListener("nokori-auth-ready", initApp);
})();
