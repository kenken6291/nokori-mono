/**
 * nokori-mono 会員間レシピ共有モジュール（みんなのレシピ）
 * ------------------------------------------------------------
 * 投稿・いいね・コメント・通報・写真アップロードを扱う。
 * GASへの通信はすべて window.NokoriAuth.authedGet/authedPost 経由（sessionトークンが自動付与される）。
 * 写真は送信前にブラウザ側(Canvas)で自動的に縮小・圧縮してからBase64で送る
 * （サーバー側のGAS/Apps Scriptには手軽な画像リサイズ手段が無いための対応。詳細はgas/Code.gs参照）。
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const ERROR_MESSAGES = {
    title_required: "タイトルを入力してください",
    description_required: "紹介文か作り方のどちらかを入力してください",
    photo_too_large: "写真のサイズが大きすぎます。もう一度お試しください",
    invalid_photo_type: "対応していない画像形式です（JPEG/PNG/WebPのみ）",
    invalid_photo_data: "写真の読み込みに失敗しました",
    quota_exceeded: "本日の投稿上限に達しました。日をあらためてお試しください",
    comment_required: "コメントを入力してください",
    not_found: "レシピが見つかりませんでした（削除された可能性があります）",
    unauthorized: "セッションの有効期限が切れました。再度ログインしてください",
  };
  function messageFor(code) {
    return ERROR_MESSAGES[code] || "エラーが発生しました。時間をおいて再度お試しください";
  }

  /* ==========================================================
     写真の自動縮小（Canvas）
     ========================================================== */
  const PHOTO_MAX_DIM = 1280;
  const PHOTO_TARGET_B64_LEN = 2.5 * 1024 * 1024; // 概ね1.8MB程度の元画像に相当（サーバー側上限4MBより十分小さく抑える）

  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > PHOTO_MAX_DIM) {
            height = Math.round(height * (PHOTO_MAX_DIM / width));
            width = PHOTO_MAX_DIM;
          } else if (height >= width && height > PHOTO_MAX_DIM) {
            width = Math.round(width * (PHOTO_MAX_DIM / height));
            height = PHOTO_MAX_DIM;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);

          let quality = 0.82;
          let dataUrl = canvas.toDataURL("image/jpeg", quality);
          let tries = 0;
          while (dataUrl.length > PHOTO_TARGET_B64_LEN && quality > 0.4 && tries < 6) {
            quality -= 0.12;
            dataUrl = canvas.toDataURL("image/jpeg", quality);
            tries++;
          }
          const base64 = (dataUrl.split(",")[1] || "");
          resolve({ base64, mimeType: "image/jpeg", width, height, approxKB: Math.round((base64.length * 0.75) / 1024) });
        };
        img.onerror = () => reject(new Error("image_load_failed"));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("file_read_failed"));
      reader.readAsDataURL(file);
    });
  }

  /* ==========================================================
     投稿フォーム
     ========================================================== */
  let pendingPhoto = null; // { base64, mimeType }
  const MAX_RECIPE_ING = 3;
  let selectedIngredientIds = [];
  let editingRecipeId = null;
  let currentRecipes = [];

  function setFormError(msg) {
    const el = $("recipeFormError");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; el.textContent = ""; }
  }

  /* ==========================================================
     食材ピッカー（冷蔵庫の食材から最大3個までタップ）
     js/app.js が公開する window.NokoriIngredients を共有利用する
     ========================================================== */
  function renderIngredientPicker() {
    const picker = $("recipeIngredientPicker");
    if (!picker) return;
    const items = window.NokoriIngredients || [];
    picker.innerHTML = "";
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ing";
      b.dataset.id = it.id;
      const isSelected = selectedIngredientIds.includes(it.id);
      b.setAttribute("aria-pressed", String(isSelected));
      b.disabled = !isSelected && selectedIngredientIds.length >= MAX_RECIPE_ING;
      b.innerHTML = `<span class="emoji" aria-hidden="true">${it.emoji || ""}</span>${escapeHtml(it.name)}`;
      b.addEventListener("click", () => toggleIngredient(it.id));
      picker.appendChild(b);
    });
  }

  function toggleIngredient(id) {
    if (selectedIngredientIds.includes(id)) {
      selectedIngredientIds = selectedIngredientIds.filter((x) => x !== id);
    } else if (selectedIngredientIds.length < MAX_RECIPE_ING) {
      selectedIngredientIds = [...selectedIngredientIds, id];
    } else {
      return;
    }
    renderIngredientPicker();
  }

  function resetRecipeForm() {
    $("recipeForm").reset();
    $("recipePhotoPreview").hidden = true;
    $("recipePhotoPreview").removeAttribute("src");
    $("recipePhotoHint").textContent = "";
    pendingPhoto = null;
    selectedIngredientIds = [];
    editingRecipeId = null;
    $("recipeSubmitBtn").textContent = "投稿する";
    renderIngredientPicker();
    setFormError("");
  }

  async function startEditRecipe(recipeId) {
    const r = currentRecipes.find((x) => x.id === recipeId);
    if (!r) return;
    resetRecipeForm();
    editingRecipeId = recipeId;
    $("recipeTitle").value = r.title || "";
    $("recipeDescription").value = r.description || "";
    $("recipeSteps").value = r.steps || "";

    const items = window.NokoriIngredients || [];
    const idByName = Object.fromEntries(items.map((i) => [i.name, i.id]));
    selectedIngredientIds = (r.ingredients || [])
      .map((n) => idByName[n])
      .filter(Boolean)
      .slice(0, MAX_RECIPE_ING);
    renderIngredientPicker();

    if (r.hasPhoto) {
      $("recipePhotoHint").textContent = "既存の写真を読み込み中…";
      const uri = await window.NokoriAuth.getPhotoDataUri(r.id);
      if (uri) {
        $("recipePhotoPreview").src = uri;
        $("recipePhotoPreview").hidden = false;
        $("recipePhotoHint").textContent = "既存の写真です（変更する場合のみ新しい写真を選んでください）";
      } else {
        $("recipePhotoHint").textContent = "";
      }
    }

    $("recipeSubmitBtn").textContent = "更新する";
    const form = $("recipeForm");
    form.hidden = false;
    $("recipeTitle").focus();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function onPhotoSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $("recipePhotoHint").textContent = "写真を処理しています…";
    try {
      const resized = await resizePhoto(file);
      pendingPhoto = { base64: resized.base64, mimeType: resized.mimeType };
      $("recipePhotoPreview").src = "data:" + resized.mimeType + ";base64," + resized.base64;
      $("recipePhotoPreview").hidden = false;
      $("recipePhotoHint").textContent = `自動縮小しました（${resized.width}×${resized.height}px, 約${resized.approxKB}KB）`;
    } catch (err) {
      pendingPhoto = null;
      $("recipePhotoHint").textContent = "写真の読み込みに失敗しました。別の写真をお試しください。";
    }
  }

  async function onSubmitRecipe(e) {
    e.preventDefault();
    setFormError("");

    const title = $("recipeTitle").value.trim();
    const items = window.NokoriIngredients || [];
    const nameById = Object.fromEntries(items.map((i) => [i.id, i.name]));
    const ingredients = selectedIngredientIds.map((id) => nameById[id]).filter(Boolean);
    const description = $("recipeDescription").value.trim();
    const steps = $("recipeSteps").value.trim();

    if (!title) { setFormError(messageFor("title_required")); return; }
    if (!description && !steps) { setFormError(messageFor("description_required")); return; }

    const btn = $("recipeSubmitBtn");
    btn.disabled = true;
    try {
      const payload = { title, ingredients, description, steps };
      if (pendingPhoto) {
        payload.photoBase64 = pendingPhoto.base64;
        payload.mimeType = pendingPhoto.mimeType;
      }
      const isEditing = !!editingRecipeId;
      if (isEditing) payload.recipeId = editingRecipeId;
      const action = isEditing ? "updateCommunityRecipe" : "postCommunityRecipe";
      const data = await window.NokoriAuth.authedPost(action, payload);
      if (!data || data.error) { setFormError(messageFor(data && data.error)); return; }
      resetRecipeForm();
      $("recipeForm").hidden = true;
      await loadFeed();
    } catch (err) {
      setFormError(messageFor(""));
    } finally {
      btn.disabled = false;
    }
  }

  /* ==========================================================
     フィード表示
     ========================================================== */
  let feedLoaded = false;

  function recipeCardHtml(r) {
    const tags = r.ingredients.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const photoHtml = r.hasPhoto
      ? `<img class="dish-photo" loading="lazy" alt="${escapeHtml(r.title)}の写真" data-photo-id="${escapeHtml(r.id)}">`
      : "";
    const stepsHtml = r.steps
      ? `<details class="steps"><summary>作り方を見る</summary><p>${escapeHtml(r.steps)}</p></details>`
      : "";
    const ownerActionsHtml = r.isMine
      ? `<button type="button" class="edit-btn">✏️ 編集</button>
         <button type="button" class="delete-btn">🗑 削除</button>`
      : `<button type="button" class="report-btn">🚩 通報</button>`;
    return `
      <article class="recipe-card" data-id="${escapeHtml(r.id)}">
        <header>
          <span>${escapeHtml(r.nickname)}${r.isMine ? "（あなた）" : ""}</span>
          <time>${escapeHtml((r.createdAt || "").slice(0, 10))}</time>
        </header>
        <h3>${escapeHtml(r.title)}</h3>
        <div class="tags">${tags}</div>
        ${photoHtml}
        ${r.description ? `<p class="desc">${escapeHtml(r.description)}</p>` : ""}
        ${stepsHtml}
        <div class="recipe-actions">
          <button type="button" class="like-btn" aria-pressed="${r.liked ? "true" : "false"}">
            ${r.liked ? "❤" : "🤍"} <span class="like-count">${r.likeCount}</span>
          </button>
          <button type="button" class="comment-toggle-btn">💬 <span class="comment-count">${r.commentCount}</span></button>
          ${ownerActionsHtml}
        </div>
        <div class="comments" hidden>
          <div class="comment-list"></div>
          <form class="comment-form">
            <input type="text" maxlength="300" placeholder="コメントする…">
            <button type="submit">送信</button>
          </form>
        </div>
      </article>`;
  }

  async function loadFeed() {
    const feedEl = $("communityFeed");
    const emptyEl = $("communityEmpty");
    try {
      const data = await window.NokoriAuth.authedGet("communityRecipes", {});
      if (!data || data.error) return;
      currentRecipes = data.recipes || [];
      feedEl.innerHTML = currentRecipes.map(recipeCardHtml).join("");
      emptyEl.hidden = currentRecipes.length > 0;
      feedLoaded = true;
      loadCardPhotos(currentRecipes, feedEl);
    } catch (err) {
      // 静かに失敗（オフライン等）。次回タブ表示時に再試行される
    }
  }

  // カード表示後、写真付きレシピだけ非同期にBase64画像を取得してimgのsrcへ差し込む
  function loadCardPhotos(recipes, containerEl) {
    recipes.filter((r) => r.hasPhoto).forEach(async (r) => {
      const uri = await window.NokoriAuth.getPhotoDataUri(r.id);
      if (!uri) return;
      const img = containerEl.querySelector(`img[data-photo-id="${cssEscape(r.id)}"]`);
      if (img) img.src = uri;
    });
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
  }

  /* ==========================================================
     カード内アクション（イベント委譲）
     ========================================================== */
  async function onFeedClick(e) {
    const card = e.target.closest(".recipe-card");
    if (!card) return;
    const recipeId = card.dataset.id;

    if (e.target.closest(".like-btn")) {
      const btn = e.target.closest(".like-btn");
      btn.disabled = true;
      try {
        const data = await window.NokoriAuth.authedPost("toggleLike", { recipeId });
        if (data && !data.error) {
          btn.setAttribute("aria-pressed", String(data.liked));
          btn.innerHTML = (data.liked ? "❤" : "🤍") + ` <span class="like-count">${data.likeCount}</span>`;
        }
      } catch (err) { /* noop */ }
      btn.disabled = false;
      return;
    }

    if (e.target.closest(".comment-toggle-btn")) {
      const box = card.querySelector(".comments");
      box.hidden = !box.hidden;
      if (!box.hidden && !box.dataset.loaded) {
        box.dataset.loaded = "1";
        await loadComments(recipeId, box.querySelector(".comment-list"));
      }
      return;
    }

    if (e.target.closest(".report-btn")) {
      const reason = window.prompt("通報理由を入力してください（任意）。運営者が内容を確認します。", "");
      if (reason === null) return; // キャンセル
      try {
        await window.NokoriAuth.authedPost("reportRecipe", { recipeId, reason: reason || "" });
        window.alert("通報を受け付けました。ご協力ありがとうございます。");
      } catch (err) {
        window.alert("通報の送信に失敗しました。時間をおいて再度お試しください。");
      }
      return;
    }

    if (e.target.closest(".edit-btn")) {
      await startEditRecipe(recipeId);
      return;
    }

    if (e.target.closest(".delete-btn")) {
      const ok = window.confirm("この投稿を削除しますか？この操作は取り消せません。");
      if (!ok) return;
      const btn = e.target.closest(".delete-btn");
      btn.disabled = true;
      try {
        const data = await window.NokoriAuth.authedPost("deleteCommunityRecipe", { recipeId });
        if (!data || data.error) {
          window.alert(messageFor(data && data.error));
          btn.disabled = false;
          return;
        }
        currentRecipes = currentRecipes.filter((r) => r.id !== recipeId);
        card.remove();
        $("communityEmpty").hidden = currentRecipes.length > 0;
        if (editingRecipeId === recipeId) {
          resetRecipeForm();
          $("recipeForm").hidden = true;
        }
      } catch (err) {
        window.alert(messageFor(""));
        btn.disabled = false;
      }
      return;
    }
  }

  function commentItemHtml(c) {
    return `<div class="comment-item"><span class="c-nick">${escapeHtml(c.nickname)}</span>${escapeHtml(c.comment)}</div>`;
  }

  async function loadComments(recipeId, listEl) {
    listEl.innerHTML = "";
    try {
      const data = await window.NokoriAuth.authedGet("recipeComments", { recipeId });
      const comments = (data && data.comments) || [];
      listEl.innerHTML = comments.length
        ? comments.map(commentItemHtml).join("")
        : `<div class="comment-item" style="color:var(--ink-soft);">まだコメントがありません</div>`;
    } catch (err) {
      listEl.innerHTML = `<div class="comment-item" style="color:var(--ink-soft);">読み込みに失敗しました</div>`;
    }
  }

  async function onFeedSubmit(e) {
    if (!e.target.classList.contains("comment-form")) return;
    e.preventDefault();
    const card = e.target.closest(".recipe-card");
    const recipeId = card.dataset.id;
    const input = e.target.querySelector("input");
    const comment = input.value.trim();
    if (!comment) return;

    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const data = await window.NokoriAuth.authedPost("commentRecipe", { recipeId, comment });
      if (!data || data.error) {
        window.alert(messageFor(data && data.error));
        return;
      }
      input.value = "";
      const countEl = card.querySelector(".comment-count");
      countEl.textContent = String(Number(countEl.textContent || "0") + 1);
      const listEl = card.querySelector(".comment-list");
      await loadComments(recipeId, listEl);
    } catch (err) {
      window.alert(messageFor(""));
    } finally {
      btn.disabled = false;
    }
  }

  /* ==========================================================
     初期化
     ========================================================== */
  function init() {
    $("newRecipeBtn").addEventListener("click", () => {
      const form = $("recipeForm");
      const willShow = form.hidden;
      if (willShow) resetRecipeForm(); // 編集モードの残留状態をクリアして新規投稿として開く
      form.hidden = !form.hidden;
      if (!form.hidden) $("recipeTitle").focus();
    });
    $("recipeCancelBtn").addEventListener("click", () => {
      resetRecipeForm();
      $("recipeForm").hidden = true;
    });
    $("recipeForm").addEventListener("submit", onSubmitRecipe);
    $("recipePhoto").addEventListener("change", onPhotoSelected);
    $("communityFeed").addEventListener("click", onFeedClick);
    $("communityFeed").addEventListener("submit", onFeedSubmit);
    renderIngredientPicker();

    window.addEventListener("nokori-tab-shown", (e) => {
      if (e.detail && e.detail.tab === "community" && !feedLoaded) {
        loadFeed();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
