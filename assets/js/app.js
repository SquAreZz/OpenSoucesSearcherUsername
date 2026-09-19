/*
 * OSS Search — веб-версия Telegram OSINT-бота.
 * Полностью статичный клиентский код: без бэкенда, для GitHub Pages.
 *
 * Быстрый режим: мгновенно строит прямые ссылки на профиль по базе Sherlock (assets/js/sites.json).
 * Экспериментальный режим: повторяет логику детекции Sherlock (status_code / message / response_url),
 * но т.к. браузер не может напрямую опрашивать большинство сайтов из-за CORS, запросы идут
 * через публичный CORS-прокси (allorigins.win).
 */
(() => {
  "use strict";

  const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;
  const CONCURRENCY = 8;
  const REQUEST_TIMEOUT_MS = 12000;
  const CACHE_PREFIX = "oss_search_cache_v1:";

  // Публичные CORS-прокси в порядке приоритета. Первый даёт код ответа (http_code),
  // второй — только "сырое" тело (используется как резерв, если первый недоступен).
  const PROXIES = [
    {
      name: "allorigins-get",
      build: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
      parse: async (res) => {
        const data = await res.json();
        return { status: data?.status?.http_code ?? null, text: data?.contents ?? "" };
      },
    },
    {
      name: "allorigins-raw",
      build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      parse: async (res) => ({ status: res.status || null, text: await res.text() }),
    },
  ];

  const WAF_FINGERPRINTS = [
    "challenge-running",
    "challenge-error-text",
    "AwsWafIntegration.forceRefreshToken",
  ];

  /** @type {Record<string, {u:string,m:string,t:string,e?:string|string[],c?:number|number[],r?:string,n?:number}>} */
  let SITES = {};
  let currentRunId = 0;
  let cancelled = false;

  const el = (id) => document.getElementById(id);
  const form = el("search-form");
  const usernameInput = el("username");
  const usernameHint = el("username-hint");
  const deepModeToggle = el("deep-mode");
  const nsfwToggle = el("nsfw-toggle");
  const deepModeWarning = el("deep-mode-warning");
  const sitesCountLabel = el("sites-count");
  const resultsPanel = el("results-panel");
  const resultsGrid = el("results-grid");
  const emptyState = el("empty-state");
  const statTotal = el("stat-total");
  const statFound = el("stat-found");
  const statUnknown = el("stat-unknown");
  const progressFill = el("progress-fill");
  const progressLabel = el("progress-label");
  const cancelBtn = el("cancel-btn");
  const exportBtn = el("export-btn");
  const filterInput = el("filter-input");
  const cacheBadge = el("cache-badge");
  const chips = Array.from(document.querySelectorAll(".chip"));

  let activeFilter = "all";
  let activeQuery = "";

  init();

  async function init() {
    try {
      const res = await fetch("assets/js/sites.json");
      SITES = await res.json();
    } catch (err) {
      SITES = {};
      console.error("Не удалось загрузить базу сайтов:", err);
    }
    sitesCountLabel.textContent = Object.keys(SITES).length.toString();

    form.addEventListener("submit", onSubmit);
    usernameInput.addEventListener("input", validateInputLive);
    deepModeToggle.addEventListener("change", () => {
      deepModeWarning.hidden = !deepModeToggle.checked;
    });
    cancelBtn.addEventListener("click", () => {
      cancelled = true;
    });
    exportBtn.addEventListener("click", exportReport);
    filterInput.addEventListener("input", () => {
      activeQuery = filterInput.value.trim().toLowerCase();
      applyFilters();
    });
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        chips.forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        activeFilter = chip.dataset.filter;
        applyFilters();
      });
    });

    // Позволяет открыть страницу сразу с результатом по ссылке ?u=username
    const params = new URLSearchParams(location.search);
    const presetUser = params.get("u");
    if (presetUser) {
      usernameInput.value = presetUser;
      runSearch(presetUser, false);
    }
  }

  function validateInputLive() {
    const value = usernameInput.value.trim();
    const valid = value.length === 0 || USERNAME_RE.test(value);
    usernameInput.classList.toggle("invalid", !valid);
    usernameHint.textContent = valid
      ? "Только буквы, цифры и символы ._- , от 3 до 30 символов — как в оригинальном боте."
      : "⚠️ Недопустимый юзернейм: разрешены только a-z, A-Z, 0-9, а также . _ - (3-30 символов).";
  }

  function onSubmit(e) {
    e.preventDefault();
    const username = usernameInput.value.trim();
    if (!USERNAME_RE.test(username)) {
      validateInputLive();
      usernameInput.focus();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set("u", username);
    history.replaceState(null, "", url);
    runSearch(username, deepModeToggle.checked);
  }

  async function runSearch(username, deep) {
    cancelled = true; // остановить предыдущий прогон, если был
    await Promise.resolve(); // дать предыдущему циклу шанс увидеть флаг
    cancelled = false;
    const runId = ++currentRunId;

    resultsPanel.hidden = false;
    resultsPanel.classList.toggle("mode-deep", deep);
    resultsGrid.innerHTML = "";
    exportBtn.disabled = true;
    cacheBadge.hidden = true;

    const showNsfw = nsfwToggle.checked;
    const entries = Object.entries(SITES).filter(([, meta]) => showNsfw || !meta.n);

    const cacheKey = CACHE_PREFIX + username + ":" + (deep ? "deep" : "quick");
    const cached = deep ? readCache(cacheKey) : null;

    /** @type {Map<string, {status:string, url:string, name:string}>} */
    const state = new Map();

    entries.forEach(([name, meta]) => {
      const url = meta.u.replace("{}", encodeURIComponent(username));
      let status = "pending";
      if (!deep) status = "link";
      if (meta.r) {
        try {
          if (!new RegExp(meta.r).test(username)) status = "skipped";
        } catch (_) { /* игнорируем некорректный regex в данных */ }
      }
      state.set(name, { status, url, name, urlMain: meta.m });
    });

    if (cached) {
      for (const [name, cachedStatus] of Object.entries(cached.results)) {
        if (state.has(name) && state.get(name).status !== "skipped") {
          state.get(name).status = cachedStatus;
        }
      }
      cacheBadge.hidden = false;
      cacheBadge.textContent = `Из кэша браузера · ${new Date(cached.ts).toLocaleString("ru-RU")}`;
    }

    renderGrid(state);
    updateStats(state, entries.length);
    cancelBtn.hidden = !deep || !!cached;
    exportBtn.disabled = false;

    if (!deep || cached) return;

    // Экспериментальная проверка: пул с ограниченной конкурентностью
    const queue = entries.filter(([name]) => state.get(name).status === "pending");
    let index = 0;
    let done = 0;

    async function worker() {
      while (index < queue.length) {
        if (cancelled || runId !== currentRunId) return;
        const i = index++;
        const [name, meta] = queue[i];
        const item = state.get(name);
        try {
          item.status = await checkSite(meta, username);
        } catch (_) {
          item.status = "unknown";
        }
        done++;
        if (runId === currentRunId) {
          updateCard(name, item.status);
          updateStats(state, entries.length, done);
        }
      }
    }

    cancelBtn.hidden = false;
    const workers = Array.from({ length: CONCURRENCY }, worker);
    await Promise.all(workers);
    cancelBtn.hidden = true;

    if (runId === currentRunId) {
      const toStore = {};
      for (const [name, item] of state.entries()) {
        if (item.status !== "skipped" && item.status !== "pending") toStore[name] = item.status;
      }
      writeCache(cacheKey, toStore);
      progressLabel.textContent = cancelled ? "остановлено" : "готово";
    }
  }

  async function checkSite(meta, username) {
    const targetUrl = meta.u.replace("{}", encodeURIComponent(username));
    let result = null;

    for (const proxy of PROXIES) {
      try {
        result = await fetchWithTimeout(proxy.build(targetUrl), proxy.parse);
        if (result) break;
      } catch (_) {
        continue;
      }
    }

    if (!result || result.status == null && !result.text) return "unknown";

    const { status, text } = result;

    if (text && WAF_FINGERPRINTS.some((fp) => text.includes(fp))) {
      return "unknown";
    }

    switch (meta.t) {
      case "message": {
        const errors = meta.e;
        const list = Array.isArray(errors) ? errors : [errors];
        const hasError = list.some((msg) => msg && text && text.includes(msg));
        return hasError ? "notfound" : "found";
      }
      case "status_code": {
        if (status == null) return "unknown";
        const codes = meta.c == null ? null : Array.isArray(meta.c) ? meta.c : [meta.c];
        if (codes) return codes.includes(status) ? "notfound" : "found";
        return status >= 300 || status < 200 ? "notfound" : "found";
      }
      case "response_url": {
        if (status == null) return "unknown";
        return status >= 200 && status < 300 ? "found" : "notfound";
      }
      default:
        return "unknown";
    }
  }

  function fetchWithTimeout(url, parse) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok && res.status !== 0) {
          // прокси сам вернул ошибку — не путать со статусом целевого сайта
          if (res.status >= 500 || res.status === 429) throw new Error("proxy error " + res.status);
        }
        return parse(res);
      })
      .finally(() => clearTimeout(timer));
  }

  function renderGrid(state) {
    const frag = document.createDocumentFragment();
    for (const item of state.values()) {
      frag.appendChild(buildCard(item));
    }
    resultsGrid.innerHTML = "";
    resultsGrid.appendChild(frag);
    applyFilters();
  }

  function buildCard(item) {
    const li = document.createElement("li");
    li.className = "site-card";
    li.dataset.status = item.status;
    li.dataset.name = item.name;
    li.innerHTML = `
      <span class="site-meta"><span class="status-dot"></span><span class="site-name">${escapeHtml(item.name)}</span></span>
      <a class="site-link" href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer" title="Открыть профиль">↗</a>
    `;
    return li;
  }

  function updateCard(name, status) {
    const card = resultsGrid.querySelector(`li[data-name="${cssEscape(name)}"]`);
    if (card) card.dataset.status = status;
    applyFiltersToCard(card);
  }

  function applyFilters() {
    const cards = Array.from(resultsGrid.children);
    let visible = 0;
    cards.forEach((card) => {
      const match = matchesFilters(card);
      card.style.display = match ? "" : "none";
      if (match) visible++;
    });
    emptyState.hidden = visible !== 0;
  }

  function applyFiltersToCard(card) {
    if (!card) return;
    card.style.display = matchesFilters(card) ? "" : "none";
  }

  function matchesFilters(card) {
    const status = card.dataset.status;
    const name = card.dataset.name.toLowerCase();
    if (activeQuery && !name.includes(activeQuery)) return false;
    if (activeFilter === "all") return true;
    if (activeFilter === "found") return status === "found";
    if (activeFilter === "notfound") return status === "notfound" || status === "skipped";
    if (activeFilter === "unknown") return status === "unknown" || status === "pending";
    return true;
  }

  function updateStats(state, total, done) {
    let found = 0, unknown = 0, skipped = 0, finished = 0;
    for (const item of state.values()) {
      if (item.status === "found" || item.status === "link") found++;
      if (item.status === "unknown") unknown++;
      if (item.status === "skipped") skipped++;
      if (item.status !== "pending") finished++;
    }
    statTotal.textContent = total.toString();
    statFound.textContent = found.toString();
    statUnknown.textContent = unknown.toString();
    const completed = done != null ? done + skipped : finished;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    progressFill.style.width = pct + "%";
    progressLabel.textContent = done != null ? `${completed}/${total}` : "готово";
  }

  function exportReport() {
    const username = usernameInput.value.trim();
    const deep = resultsPanel.classList.contains("mode-deep");
    const cards = Array.from(resultsGrid.children);
    const foundLinks = cards
      .filter((c) => c.dataset.status === (deep ? "found" : "link"))
      .map((c) => c.querySelector(".site-link").getAttribute("href"));
    const allLinks = cards
      .filter((c) => c.dataset.status !== "skipped")
      .map((c) => `${c.dataset.name}: ${c.querySelector(".site-link").getAttribute("href")}`);

    const lines = deep
      ? [
          `OSS Search — отчёт для юзернейма: ${username}`,
          `Сгенерировано: ${new Date().toLocaleString("ru-RU")}`,
          `Режим: экспериментальная проверка`,
          `Найдено вероятных совпадений: ${foundLinks.length}`,
          "",
          "=== Вероятно найденные аккаунты ===",
          ...foundLinks,
          "",
          "=== Все проверенные сайты ===",
          ...allLinks,
        ]
      : [
          `OSS Search — отчёт для юзернейма: ${username}`,
          `Сгенерировано: ${new Date().toLocaleString("ru-RU")}`,
          `Режим: быстрый (только сгенерированные ссылки, без проверки существования)`,
          `Всего ссылок: ${allLinks.length}`,
          "",
          "=== Ссылки на проверку ===",
          ...allLinks,
        ];

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${username}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function writeCache(key, results) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), results }));
    } catch (_) {
      /* localStorage может быть недоступен (приватный режим) — молча игнорируем */
    }
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }
  function cssEscape(str) { return str.replace(/["\\]/g, "\\$&"); }
})();
