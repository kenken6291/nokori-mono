/**
 * nokori-mono 材料費モジュール
 * ------------------------------------------------------------
 * 買い物の記録（材料名・価格・日付）を送信し、今週の合計・食材ごとの内訳・
 * 直近の記録・全会員の「みんなの相場」（直近90日の平均購入価格）を表示する。
 * GASへの通信はすべて window.NokoriAuth.authedGet/authedPost 経由（sessionトークンが自動付与される）。
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
    quota_exceeded: "本日の記録上限に達しました。日をあらためてお試しください",
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
    return "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");
  }

  async function onSubmitPurchase(e) {
    e.preventDefault();
    setFormError("");

    const ingredientName = $("purchaseIngredient").value.trim();
    const price = Number($("purchasePrice").value);
    const dateStr = $("purchaseDate").value;

    if (!ingredientName) { setFormError(messageFor("ingredient_required")); return; }
    if (!Number.isFinite(price) || price < 0 || price > 100000) { setFormError(messageFor("invalid_price")); return; }

    const btn = e.target.querySelector("button[type='submit']");
    btn.disabled = true;
    try {
      const payload = { ingredientName, price };
      if (dateStr) payload.purchasedAt = new Date(dateStr + "T12:00:00").toISOString();
      const data = await window.NokoriAuth.authedPost("addPurchase", payload);
      if (!data || data.error) { setFormError(messageFor(data && data.error)); return; }
      $("purchaseForm").reset();
      await loadSummary();
    } catch (err) {
      setFormError(messageFor(""));
    } finally {
      btn.disabled = false;
    }
  }

  function renderRows(container, items, emptyText, rowFn) {
    if (!items || !items.length) {
      container.innerHTML = `<p class="cost-empty">${escapeHtml(emptyText)}</p>`;
      return;
    }
    container.innerHTML = items.map(rowFn).join("");
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

      renderRows($("costRecent"), data.recent, "購入記録がありません。", (r) => `
        <div class="cost-row">
          <span class="name">${escapeHtml(r.ingredientName)}</span>
          <span>${yen(r.price)}<span class="sub"> （${escapeHtml((r.purchasedAt || "").slice(0, 10))}）</span></span>
        </div>`);
    } catch (err) {
      // 静かに失敗（オフライン等）。次回タブ表示時に再試行される
    }
  }

  let summaryLoaded = false;

  function init() {
    $("purchaseForm").addEventListener("submit", onSubmitPurchase);

    window.addEventListener("nokori-tab-shown", (e) => {
      if (e.detail && e.detail.tab === "costs" && !summaryLoaded) {
        summaryLoaded = true;
        loadSummary();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
