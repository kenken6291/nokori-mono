/**
 * nokori-mono 材料費モジュール
 * ------------------------------------------------------------
 * 買い物の記録（材料名・価格・日付・数量/単位・写真任意）を送信し、今週の合計・食材ごとの内訳・
 * 直近の記録（単価・編集・削除つき）・全会員の「みんなの相場」（直近90日の平均購入価格）を表示する。
 * GASへの通信はすべて window.NokoriAuth.authedGet/authedPost 経由（sessionトークンが自動付与される）。
 * 写真は送信前にブラウザ側(Canvas)で自動的に縮小・圧縮してからBase64で送る（js/community.jsと同じ方式）。
 * 写真は本人のみ閲覧できるプロキシ(action=photo, type=purchase)経由で取得する。
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const ERROR_MESSAGES = {
    ingredient_required: "食材名を入力してください",
    invalid_price: "価格は0〜100000円の範囲で入力してください",
    invalid_quantity: "数量を正しく入力してください",
    photo_too_large: "写真のサイズが大きすぎます。もう一度お試しください",
    invalid_photo_type: "対応していない画像形式です（JPEG/PNG/WebPのみ）",
    invalid_photo_data: "写真の読み込みに失敗しました",
    quota_exceeded: "本日の記録上限に達しました。日をあらためてお試しください",
    not_found: "記録が見つかりませんでした（削除された可能性があります）",
    forbidden: "この記録を編集・削除する権限がありません",
    unauthorized: "セッションの有効期限が切れました。再度ログインしてください",
  };
  function messageFor(code) {
    return ERROR_MESSAGES[code] || "エラーが発生しました。時間をおいて再度お試しください";
  }

  function setFormError(msg) {
    const el = $("purchaseFormError");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; el.textContent = ""; }
  }

  function yen(n) {
    if (n == null || !Number.isFinite(Number(n))) return "";
    return "¥" + Math.round(Number(n)).toLocaleString("ja-JP");
  }

  /* ==========================================================
     写真の自動縮小（Canvas）※js/community.jsのresizePhotoと同じ実装
     ========================================================== */
  const PHOTO_MAX_DIM = 1280;
  const PHOTO_TARGET_B64_LEN = 2.5 * 1024 * 1024;

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

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
  }

  // レシート自動読み取り用に、縮小せず元ファイルのままBase64化する（縮小すると小さい文字が潰れて
  // 読み取り精度が落ちるため）。保存用の写真は引き続きresizePhotoで縮小したものを使う。
  const MAX_RECEIPT_SCAN_FILE_BYTES = 12 * 1024 * 1024; // 元画像の読み取りに使う上限（サーバー側の上限と合わせて余裕を持たせる）

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_RECEIPT_SCAN_FILE_BYTES) {
        reject(new Error("file_too_large"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const base64 = dataUrl.split(",")[1] || "";
        const mimeType = file.type && file.type.indexOf("image/") === 0 ? file.type : "image/jpeg";
        resolve({ base64, mimeType });
      };
      reader.onerror = () => reject(new Error("file_read_failed"));
      reader.readAsDataURL(file);
    });
  }

  /* ==========================================================
     記録フォーム（新規・編集共用）
     ========================================================== */
  let pendingPhoto = null; // { base64, mimeType }
  let editingPurchaseId = null;
  let currentRecent = [];

  function updateQuantityFieldVisibility() {
    const unit = $("purchaseUnit").value;
    const field = $("purchaseQuantityField");
    const label = $("purchaseQuantityLabel");
    if (unit === "count") {
      field.hidden = false;
      label.textContent = "個数";
      $("purchaseQuantity").step = "1";
    } else if (unit === "gram") {
      field.hidden = false;
      label.textContent = "グラム数";
      $("purchaseQuantity").step = "0.1";
    } else {
      field.hidden = true;
      $("purchaseQuantity").value = "";
    }
  }

  function resetPurchaseForm() {
    $("purchaseForm").reset();
    $("purchasePhotoPreview").hidden = true;
    $("purchasePhotoPreview").removeAttribute("src");
    $("purchasePhotoHint").textContent = "";
    pendingPhoto = null;
    editingPurchaseId = null;
    $("purchaseSubmitBtn").textContent = "記録する";
    $("purchaseCancelBtn").hidden = true;
    updateQuantityFieldVisibility();
    setFormError("");
  }

  async function startEditPurchase(purchaseId) {
    const r = currentRecent.find((x) => x.id === purchaseId);
    if (!r) return;
    resetPurchaseForm();
    editingPurchaseId = purchaseId;

    $("purchaseIngredient").value = r.ingredientName || "";
    $("purchasePrice").value = r.price != null ? r.price : "";
    $("purchaseUnit").value = r.unit || "";
    updateQuantityFieldVisibility();
    if (r.unit && r.quantity != null) $("purchaseQuantity").value = r.quantity;
    if (r.purchasedAt) $("purchaseDate").value = String(r.purchasedAt).slice(0, 10);

    if (r.hasPhoto) {
      $("purchasePhotoHint").textContent = "既存の写真を読み込み中…";
      const uri = await window.NokoriAuth.getPhotoDataUri(r.id, "purchase");
      if (uri) {
        $("purchasePhotoPreview").src = uri;
        $("purchasePhotoPreview").hidden = false;
        $("purchasePhotoHint").textContent = "既存の写真です（変更する場合のみ新しい写真を選んでください）";
      } else {
        $("purchasePhotoHint").textContent = "";
      }
    }

    $("purchaseSubmitBtn").textContent = "更新する";
    $("purchaseCancelBtn").hidden = false;
    $("purchaseIngredient").focus();
    $("purchaseForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function onPhotoSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $("purchasePhotoHint").textContent = "写真を処理しています…";

    // 保存用のプレビュー・添付データは従来通り縮小する
    let resized;
    try {
      resized = await resizePhoto(file);
      pendingPhoto = { base64: resized.base64, mimeType: resized.mimeType };
      $("purchasePhotoPreview").src = "data:" + resized.mimeType + ";base64," + resized.base64;
      $("purchasePhotoPreview").hidden = false;
    } catch (err) {
      pendingPhoto = null;
      $("purchasePhotoHint").textContent = "写真の読み込みに失敗しました。別の写真をお試しください。";
      return;
    }

    const baseHint = `自動縮小しました（${resized.width}×${resized.height}px, 約${resized.approxKB}KB）。`;
    $("purchasePhotoHint").textContent = baseHint + "レシートを読み取っています…";

    // レシートの自動読み取りは縮小前の元画像で行う（縮小すると小さい文字が潰れて読み取り精度が落ちるため）。
    // 読み取り用の元画像は送信のみに使い、保存はしない（保存されるのは上のresizePhoto版のみ）。
    try {
      const original = await fileToBase64(file);
      await scanReceiptAndFill(original, baseHint);
    } catch (err) {
      $("purchasePhotoHint").textContent = baseHint + "写真のサイズが大きすぎて自動読み取りできませんでした。内容を手入力してください。";
    }
  }

  // レシート・値札の写真（縮小前の元画像）から食材名・価格・数量をGemini Visionで自動抽出し、
  // フォームへ自動入力する。あくまで下書きの自動入力であり、登録自体はユーザーが内容を確認して
  // 「記録する」を押すまで行われない。
  async function scanReceiptAndFill(original, baseHint) {
    try {
      const data = await window.NokoriAuth.authedPost("scanReceipt", {
        imageBase64: original.base64,
        mimeType: original.mimeType,
      });
      if (!data || data.error) {
        $("purchasePhotoHint").textContent = baseHint + "レシートの自動読み取りはできませんでした。内容を手入力してください。";
        return;
      }
      if (data.ingredientName) $("purchaseIngredient").value = data.ingredientName;
      if (data.price != null) $("purchasePrice").value = data.price;
      if (data.unit === "count" || data.unit === "gram") {
        $("purchaseUnit").value = data.unit;
        updateQuantityFieldVisibility();
        if (data.quantity != null) $("purchaseQuantity").value = data.quantity;
      }
      $("purchasePhotoHint").textContent = baseHint + "レシートから読み取りました。内容を確認してから「記録する」を押してください（読み取り精度は完全ではありません）。";
    } catch (err) {
      $("purchasePhotoHint").textContent = baseHint + "レシートの自動読み取りに失敗しました。内容を手入力してください。";
    }
  }

  async function onSubmitPurchase(e) {
    e.preventDefault();
    setFormError("");

    const ingredientName = $("purchaseIngredient").value.trim();
    const price = Number($("purchasePrice").value);
    const dateStr = $("purchaseDate").value;
    const unit = $("purchaseUnit").value;
    const quantity = unit ? Number($("purchaseQuantity").value) : null;

    if (!ingredientName) { setFormError(messageFor("ingredient_required")); return; }
    if (!Number.isFinite(price) || price < 0 || price > 100000) { setFormError(messageFor("invalid_price")); return; }
    if (unit && (!Number.isFinite(quantity) || quantity <= 0)) { setFormError(messageFor("invalid_quantity")); return; }

    const btn = $("purchaseSubmitBtn");
    btn.disabled = true;
    try {
      const payload = { ingredientName, price };
      if (unit) { payload.unit = unit; payload.quantity = quantity; }
      if (dateStr) payload.purchasedAt = new Date(dateStr + "T12:00:00").toISOString();
      if (pendingPhoto) {
        payload.photoBase64 = pendingPhoto.base64;
        payload.mimeType = pendingPhoto.mimeType;
      }
      const isEditing = !!editingPurchaseId;
      if (isEditing) payload.purchaseId = editingPurchaseId;
      const action = isEditing ? "updatePurchase" : "addPurchase";
      const data = await window.NokoriAuth.authedPost(action, payload);
      if (!data || data.error) { setFormError(messageFor(data && data.error)); return; }
      resetPurchaseForm();
      await loadSummary();
    } catch (err) {
      setFormError(messageFor(""));
    } finally {
      btn.disabled = false;
    }
  }

  /* ==========================================================
     一覧表示
     ========================================================== */
  function renderRows(container, items, emptyText, rowFn) {
    if (!items || !items.length) {
      container.innerHTML = `<p class="cost-empty">${escapeHtml(emptyText)}</p>`;
      return;
    }
    container.innerHTML = items.map(rowFn).join("");
  }

  function recentRowHtml(r) {
    const dateStr = escapeHtml(String(r.purchasedAt || "").slice(0, 10));
    const unitPriceHtml = r.unitPrice != null
      ? `<span class="unit-price">${r.unit === "count" ? "1個あたり" : "100gあたり"} ${yen(r.unitPrice)}</span>`
      : "";
    const photoHtml = r.hasPhoto
      ? `<img class="cost-row-thumb" loading="lazy" alt="${escapeHtml(r.ingredientName)}の写真" data-photo-id="${escapeHtml(r.id)}">`
      : "";
    return `
      <div class="cost-row" data-id="${escapeHtml(r.id)}">
        <div class="cost-row-main">
          <span class="name">${escapeHtml(r.ingredientName)}</span>
          <span>${yen(r.price)}<span class="sub"> （${dateStr}）</span></span>
          ${unitPriceHtml}
        </div>
        ${photoHtml}
        <div class="cost-row-actions">
          <button type="button" class="cost-edit-btn">✏️ 編集</button>
          <button type="button" class="cost-delete-btn">🗑 削除</button>
        </div>
      </div>`;
  }

  // 写真付きの記録だけ非同期にBase64画像を取得してimgのsrcへ差し込む
  function loadRecentPhotos(items, containerEl) {
    items.filter((r) => r.hasPhoto).forEach(async (r) => {
      const uri = await window.NokoriAuth.getPhotoDataUri(r.id, "purchase");
      if (!uri) return;
      const img = containerEl.querySelector(`img[data-photo-id="${cssEscape(r.id)}"]`);
      if (img) img.src = uri;
    });
  }

  async function onRecentClick(e) {
    const row = e.target.closest(".cost-row");
    if (!row) return;
    const purchaseId = row.dataset.id;
    if (!purchaseId) return;

    if (e.target.closest(".cost-edit-btn")) {
      await startEditPurchase(purchaseId);
      return;
    }

    if (e.target.closest(".cost-delete-btn")) {
      const ok = window.confirm("この記録を削除しますか？この操作は取り消せません。");
      if (!ok) return;
      const btn = e.target.closest(".cost-delete-btn");
      btn.disabled = true;
      try {
        const data = await window.NokoriAuth.authedPost("deletePurchase", { purchaseId });
        if (!data || data.error) {
          window.alert(messageFor(data && data.error));
          btn.disabled = false;
          return;
        }
        if (editingPurchaseId === purchaseId) resetPurchaseForm();
        await loadSummary();
      } catch (err) {
        window.alert(messageFor(""));
        btn.disabled = false;
      }
      return;
    }
  }

  async function loadSummary() {
    try {
      const data = await window.NokoriAuth.authedGet("myPurchases", {});
      if (!data || data.error) return;

      $("costWeekStart").textContent = data.weekStart || "";
      $("costWeekTotal").textContent = yen(data.weekTotal);

      renderRows($("costByIngredient"), data.byIngredient, "今週の記録はまだありません。", (r) => `
        <div class="cost-row">
          <span class="name">${escapeHtml(r.ingredientName)}</span>
          <span>${yen(r.total)}<span class="sub"> （${r.count}回）</span></span>
        </div>`);

      renderRows($("costCommunityAverage"), data.communityAverage, "まだデータがありません。", (r) => `
        <div class="cost-row">
          <span class="name">${escapeHtml(r.ingredientName)}</span>
          <span>${yen(r.avgPrice)}<span class="sub"> （${r.sampleCount}件の平均）</span></span>
        </div>`);

      currentRecent = data.recent || [];
      const recentEl = $("costRecent");
      renderRows(recentEl, currentRecent, "購入記録がありません。", recentRowHtml);
      loadRecentPhotos(currentRecent, recentEl);
    } catch (err) {
      // 静かに失敗（オフライン等）。次回タブ表示時に再試行される
    }
  }

  let summaryLoaded = false;

  function init() {
    $("purchaseForm").addEventListener("submit", onSubmitPurchase);
    $("purchaseUnit").addEventListener("change", updateQuantityFieldVisibility);
    $("purchasePhoto").addEventListener("change", onPhotoSelected);
    $("purchaseCancelBtn").addEventListener("click", resetPurchaseForm);
    $("costRecent").addEventListener("click", onRecentClick);
    updateQuantityFieldVisibility();

    window.addEventListener("nokori-tab-shown", (e) => {
      if (e.detail && e.detail.tab === "costs" && !summaryLoaded) {
        summaryLoaded = true;
        loadSummary();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
