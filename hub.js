(function () {
  const FP_STORAGE_KEY = "bdl_fingerprint";
  const receiptKey = function (wid) { return "bdl_receipt_" + wid; };

  const MODEL_CATALOG = [
    { id: "grok-4.6", name: "grok-4.6", note: "Cursor主力推荐", isCursor: true },
    { id: "composer-2.5", name: "composer-2.5", note: "Cursor原生架构", isCursor: true },
    { id: "claude-3.7-sonnet", name: "claude-3.7", note: "Anthropic前沿", isCursor: false },
    { id: "gemini-2.0-flash", name: "gemini-2.0", note: "Google AI Pro专署", isCursor: false },
    { id: "deepseek-r1", name: "deepseek-r1", note: "OpenRouter开源前沿", isCursor: false }
  ];

  const TIER_LABEL = { fuel: "燃料", harness: "载体", environment: "7×24" };
  const WINDOW_POLL_MS = 20000;

  const state = {
    config: null,
    window: null,
    arsenal: null,
    ledger: null,
    bookmarks: [],
    submitting: false,
    countdownTimer: null,
    watchMode: null,
    countdownClosesMs: null,
    windowRefreshing: false,
    lastWindowPollAt: 0,
    cascadeBound: false,
    searchBound: false
  };

  function safeUrl(u) {
    try {
      const url = new URL(u);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch (_) {}
    return "";
  }

  function safeRelativePath(path, slug) {
    const raw = String(path || "").trim();
    const normalized = raw.replace(/^\/+/, "");
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized);
    const isProtocolRelative = normalized.slice(0, 2) === "//";
    const hasBackslash = normalized.indexOf("\\") !== -1;
    const hasDotDot = normalized.split("/").indexOf("..") !== -1;
    if (
      normalized &&
      normalized !== "#" &&
      !hasScheme &&
      !isProtocolRelative &&
      !hasBackslash &&
      !hasDotDot
    ) {
      return normalized;
    }
    const s = String(slug || "").trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
      return "apps/" + s + "/";
    }
    return "#";
  }

  function getFingerprint() {
    try {
      let fp = localStorage.getItem(FP_STORAGE_KEY);
      if (!fp) {
        fp = (crypto.randomUUID && crypto.randomUUID()) ||
             ("fp-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem(FP_STORAGE_KEY, fp);
      }
      return fp;
    } catch (_) {
      return "fp-fallback-" + Math.random().toString(36).slice(2);
    }
  }

  function formatClock(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleTimeString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (_) {
      return iso;
    }
  }

  function formatCountdownDigits(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }

  function formatWindowCountdownLabel(opensMs, closesMs) {
    const durationMs = closesMs - opensMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return "倒计时";
    const minutes = Math.round(durationMs / 60000);
    if (minutes <= 15) return "倒计时 · " + Math.max(1, minutes) + " 分钟窗";
    return "倒计时";
  }

  function windowFingerprint(win) {
    if (!win) return "";
    const ids = (Array.isArray(win.candidates) ? win.candidates : [])
      .map(function (c) { return (c && c.id) + ":" + (c && c.status); })
      .join(",");
    return [win.windowId || "", win.opensAt || "", win.closesAt || "", ids].join("|");
  }

  function stopWindowWatch() {
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
    state.watchMode = null;
    state.countdownClosesMs = null;
  }

  function clearSubmitState() {
    state.submitting = false;
    const btn = document.getElementById("vote-submit-btn");
    const msg = document.getElementById("vote-msg");
    if (btn) btn.disabled = true;
    if (msg) {
      msg.textContent = "";
      msg.removeAttribute("data-kind");
    }
  }

  function voteApiBase() {
    return String(state.config && state.config.voteApiBase || "").trim().replace(/\/$/, "");
  }

  function setStackPill(el, label, value) {
    if (!el) return;
    el.replaceChildren();
    const b = document.createElement("b");
    b.textContent = label;
    el.append(b, document.createTextNode(value == null ? "" : String(value)));
  }

  function arsenalItemByName(sectionId, name) {
    const sections = (state.arsenal && Array.isArray(state.arsenal.sections)) ? state.arsenal.sections : [];
    const sec = sections.find(function (s) { return s && s.id === sectionId; });
    if (!sec) return null;
    const want = String(name || "").trim();
    return (sec.items || []).find(function (it) {
      return String((it && (it.nameZh || it.name)) || "").trim() === want;
    }) || null;
  }

  async function refreshLiveWindow() {
    if (state.windowRefreshing) return;
    state.windowRefreshing = true;
    state.lastWindowPollAt = Date.now();
    try {
      const winData = await loadWindow(voteApiBase());
      const prev = windowFingerprint(state.window);
      const next = windowFingerprint(winData);
      state.window = winData;
      if (prev !== next) {
        renderPipelineStrip();
        renderVotePanel();
      }
    } catch (err) {
      console.warn("轻量轮询 /api/window 失败:", err);
    } finally {
      state.windowRefreshing = false;
    }
  }

  async function loadAllData() {
    try {
      const cfgRes = await fetch("./tracking/rotate-config.json", { cache: "no-store" });
      if (cfgRes.ok) state.config = await cfgRes.json();
    } catch (e) {
      console.warn("读取 rotate-config.json 失败:", e);
    }

    const apiBase = String(state.config && state.config.voteApiBase || "").trim().replace(/\/$/, "");
    const promises = [
      loadWindow(apiBase),
      fetchJson("./tracking/arsenal.json").catch(function () { return null; }),
      fetchJson("./tracking/seen-bookmarks.json").catch(function () { return null; }),
      loadLedger(apiBase)
    ];

    const packed = await Promise.all(promises);
    state.window = packed[0];
    state.arsenal = packed[1];
    state.bookmarks = (packed[2] && packed[2].items) ? packed[2].items : [];
    state.ledger = packed[3];
    renderAll();
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function loadWindow(apiBase) {
    if (apiBase) {
      try {
        const liveRes = await fetch(apiBase + "/api/window", { cache: "no-store" });
        let liveData = null;
        try {
          liveData = await liveRes.json();
        } catch (_) {
          liveData = null;
        }
        if (liveData && liveData.ok && liveData.window) {
          return liveData.window;
        }
        return null;
      } catch (err) {
        console.warn("Live /api/window 连接失败，降级本地:", err);
      }
    }
    try {
      return await fetchJson("./tracking/ballot-window.json");
    } catch (e) {
      console.warn("读取 ballot-window.json 失败:", e);
      return null;
    }
  }

  async function loadLedger(apiBase) {
    if (apiBase) {
      try {
        const res = await fetch(apiBase + "/api/ledger", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && data.ledger) return data.ledger;
        }
      } catch (_) {}
    }
    try {
      return await fetchJson("./tracking/vote-ledger.json");
    } catch (_) {
      return null;
    }
  }

  function renderAll() {
    renderPipelineStrip();
    renderVotePanel();
    renderShippedCards();
    renderArsenal();
  }

  function renderPipelineStrip() {
    const win = state.window;
    const now = Date.now();
    const opens = win ? Date.parse(win.opensAt) : 0;
    const closes = win ? Date.parse(win.closesAt) : 0;
    const isOpen = Number.isFinite(opens) && Number.isFinite(closes) && now >= opens && now < closes;
    const openCands = win && Array.isArray(win.candidates)
      ? win.candidates.filter(function (c) { return c && c.status === "open"; })
      : [];

    const metaEl = document.getElementById("pipe-window-meta");
    if (metaEl && win) {
      metaEl.textContent = (win.windowId || "—") + " · " + formatClock(win.opensAt) + " → " + formatClock(win.closesAt);
    } else if (metaEl && !win) {
      metaEl.textContent = "无 live 窗";
    }

    const preTitle = document.getElementById("pipe-pre-title");
    const preDesc = document.getElementById("pipe-pre-desc");
    const preNode = document.getElementById("pipe-stage-pre");
    if (preTitle && preDesc) {
      if (!isOpen) {
        preTitle.textContent = "封票";
        preDesc.textContent = "等下一窗";
      } else if (!openCands.length) {
        preTitle.textContent = "空窗";
        preDesc.textContent = "入口静默";
      } else {
        preTitle.textContent = openCands.length + " 候选项";
        preDesc.textContent = "投燃料 / 载体 / 7×24";
      }
    }
    if (preNode) preNode.classList.toggle("is-active", isOpen && openCands.length > 0);

    const ledgerWin = state.ledger && state.ledger.winningStack;
    if (ledgerWin) {
      if (ledgerWin.fuel) setStackPill(document.getElementById("pipe-pill-fuel"), "燃料", ledgerWin.fuel);
      if (ledgerWin.harness) setStackPill(document.getElementById("pipe-pill-harness"), "载体", ledgerWin.harness);
      if (ledgerWin.environment) setStackPill(document.getElementById("pipe-pill-env"), "环境", ledgerWin.environment);
    }

    const postTitle = document.getElementById("pipe-post-title");
    const postDesc = document.getElementById("pipe-post-desc");
    const hudShipped = document.getElementById("hud-shipped-count");
    const count = state.bookmarks.length;
    if (hudShipped) hudShipped.textContent = "上线 " + count;
    if (postTitle) postTitle.textContent = count + " 演示";
    if (postDesc && count > 0) {
      const topOne = state.bookmarks.slice().sort(function (a, b) {
        return (Date.parse(b.processedAt) || 0) - (Date.parse(a.processedAt) || 0);
      })[0];
      postDesc.textContent = topOne.hubTitle || topOne.titleZh || topOne.slug;
    }
  }

  function renderVotePanel() {
    const panel = document.getElementById("vote-panel");
    if (!panel) return;

    const win = state.window;
    if (!win) {
      panel.hidden = true;
      clearSubmitState();
      startIdleWindowPoll();
      return;
    }

    const now = Date.now();
    const opens = Date.parse(win.opensAt);
    const closes = Date.parse(win.closesAt);
    const remainingSec = Number.isFinite(closes) ? Math.max(0, Math.floor((closes - now) / 1000)) : 0;
    const isOpen = Number.isFinite(opens) && Number.isFinite(closes) && now >= opens && now < closes && remainingSec > 0;

    const openCands = Array.isArray(win.candidates)
      ? win.candidates.filter(function (c) { return c && c.status === "open"; })
      : [];

    const labelEl = document.getElementById("timer-hud-label-text");
    if (labelEl) labelEl.textContent = formatWindowCountdownLabel(opens, closes);

    if (!isOpen || openCands.length === 0) {
      panel.hidden = true;
      clearSubmitState();
      if (isOpen) {
        startCountdown(closes, opens, true);
      } else {
        startIdleWindowPoll();
      }
      return;
    }

    panel.hidden = false;
    const badge = document.getElementById("vote-window-badge");
    if (badge) badge.textContent = win.windowId || "";
    const noteEl = document.getElementById("vote-ingest-note");
    if (noteEl) {
      noteEl.textContent = win.ingestNoteZh || "选燃料 / 载体 / 7×24。单 IP 每窗一票。";
    }

    startCountdown(closes, opens, false);
    renderCandidates(openCands);
    renderStackSelectors();
    checkVoteReceipt(win.windowId);
    loadLiveTallies(win.windowId);
  }

  function startIdleWindowPoll() {
    if (state.watchMode === "idle" && state.countdownTimer) return;
    stopWindowWatch();
    state.watchMode = "idle";
    state.countdownTimer = setInterval(refreshLiveWindow, WINDOW_POLL_MS);
  }

  function startCountdown(closesMs, opensMs, pollLive) {
    const mode = pollLive ? "countdown-poll" : "countdown";
    if (state.watchMode === mode && state.countdownTimer && state.countdownClosesMs === closesMs) {
      return;
    }
    stopWindowWatch();
    state.watchMode = mode;
    state.countdownClosesMs = closesMs;
    state.lastWindowPollAt = Date.now();

    const digitsEl = document.getElementById("timer-digits");
    const barEl = document.getElementById("timer-progress-bar");
    const totalDuration = Math.max(1, (closesMs - opensMs) / 1000);

    function tick() {
      const remainingSec = Math.max(0, Math.floor((closesMs - Date.now()) / 1000));
      if (digitsEl) digitsEl.textContent = formatCountdownDigits(remainingSec);
      if (barEl) {
        const pct = Math.min(100, Math.max(0, (remainingSec / totalDuration) * 100));
        barEl.style.width = pct + "%";
      }
      if (pollLive && Date.now() - state.lastWindowPollAt >= WINDOW_POLL_MS) {
        refreshLiveWindow();
      }
      if (remainingSec <= 0) {
        stopWindowWatch();
        if (digitsEl) digitsEl.textContent = "00:00";
        Promise.resolve(loadAllData()).finally(function () {
          if (!state.countdownTimer) startIdleWindowPoll();
        });
      }
    }

    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  function renderCandidates(candidates) {
    const container = document.getElementById("candidates-container");
    if (!container) return;
    container.replaceChildren();

    candidates.forEach(function (cand, idx) {
      const card = document.createElement("label");
      card.className = "cand-card";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "candidateId";
      radio.value = String(cand.id || "");
      if (idx === 0) radio.checked = true;

      const body = document.createElement("div");
      body.className = "cand-body";

      const titleRow = document.createElement("div");
      titleRow.className = "cand-title-row";

      const h3 = document.createElement("h3");
      h3.className = "cand-title";
      h3.textContent = cand.titleZh || cand.title || "未命名";

      const auth = document.createElement("span");
      auth.className = "cand-author";
      auth.textContent = cand.author ? "@" + cand.author : "";

      titleRow.append(h3, auth);
      body.append(titleRow);

      const rationale = cand.rationaleZh || cand.planZh || "";
      if (rationale) {
        const ratBox = document.createElement("div");
        ratBox.className = "rationale-strip";
        const ratTag = document.createElement("span");
        ratTag.className = "rationale-tag";
        ratTag.textContent = "理由";
        const ratText = document.createElement("p");
        ratText.className = "rationale-text";
        ratText.textContent = rationale;
        ratBox.append(ratTag, ratText);
        body.append(ratBox);
      }

      if (cand.planZh && cand.planZh !== rationale) {
        const planP = document.createElement("p");
        planP.className = "cand-plan";
        planP.textContent = cand.planZh;
        body.append(planP);
      }

      const originHref = safeUrl(cand.url);
      if (originHref) {
        const originLink = document.createElement("a");
        originLink.className = "cand-origin-link";
        originLink.href = originHref;
        originLink.target = "_blank";
        originLink.rel = "noopener";
        originLink.textContent = "原帖 ↗";
        body.append(originLink);
      }

      card.append(radio, body);
      container.append(card);
    });
  }

  function getActiveArsenalSets() {
    const out = { fuel: [], harness: [], environment: [] };
    if (!state.arsenal || !Array.isArray(state.arsenal.sections)) return out;
    state.arsenal.sections.forEach(function (sec) {
      if (!out[sec.id]) return;
      (sec.items || []).forEach(function (it) {
        if (it && it.status === "active") {
          const name = String(it.nameZh || it.name || "").trim();
          if (name) out[sec.id].push(name);
        }
      });
    });
    return out;
  }

  function renderStackSelectors() {
    const arsenalActive = getActiveArsenalSets();
    const winOpts = (state.window && state.window.options) || {};

    const fuels = arsenalActive.fuel.length ? arsenalActive.fuel : (winOpts.fuel || ["Cursor Ultra"]);
    const harnesses = arsenalActive.harness.length ? arsenalActive.harness : (winOpts.harness || ["Cursor Cloud Agent"]);
    const envs = arsenalActive.environment.length ? arsenalActive.environment : (winOpts.environment || ["Cursor Cloud Agent 托管机"]);

    renderChoiceGroup("fuel-choices", "fuel", fuels, fuels[0]);
    renderChoiceGroup("harness-choices", "harness", harnesses, harnesses[0]);
    renderChoiceGroup("env-choices", "environment", envs, envs[0]);
    renderModelChoices();
    bindCascadingConstraints();
  }

  function appendTags(parent, tags) {
    if (!tags || !tags.length) return;
    const row = document.createElement("div");
    row.className = "choice-chips";
    tags.slice(0, 3).forEach(function (t) {
      const chip = document.createElement("span");
      chip.className = "choice-chip";
      chip.textContent = t;
      row.append(chip);
    });
    parent.append(row);
  }

  function renderChoiceGroup(containerId, groupName, items, defaultVal) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.replaceChildren();

    items.forEach(function (item, idx) {
      const lab = document.createElement("label");
      lab.className = "choice-label";

      const inp = document.createElement("input");
      inp.type = "radio";
      inp.name = groupName;
      inp.value = item;
      if (item === defaultVal || (!defaultVal && idx === 0)) inp.checked = true;

      const wrap = document.createElement("div");
      const title = document.createElement("span");
      title.className = "choice-title";
      title.textContent = item;
      wrap.append(title);

      const meta = arsenalItemByName(groupName, item);
      if (meta) {
        const noteBits = [meta.bandZh, meta.noteZh].filter(Boolean);
        if (noteBits.length) {
          const note = document.createElement("span");
          note.className = "choice-note";
          note.textContent = meta.bandZh || meta.noteZh;
          wrap.append(note);
        }
        if (Array.isArray(meta.tags)) appendTags(wrap, meta.tags);
      }

      lab.append(inp, wrap);
      box.append(lab);
    });
  }

  function renderModelChoices() {
    const box = document.getElementById("model-choices");
    if (!box) return;
    box.replaceChildren();

    MODEL_CATALOG.forEach(function (m, idx) {
      const lab = document.createElement("label");
      lab.className = "choice-label";
      lab.dataset.modelId = m.id;

      const inp = document.createElement("input");
      inp.type = "radio";
      inp.name = "model";
      inp.value = m.id;
      if (idx === 0) inp.checked = true;

      const body = document.createElement("div");
      const title = document.createElement("span");
      title.className = "choice-title";
      title.textContent = m.name;
      const note = document.createElement("span");
      note.className = "choice-note";
      note.textContent = m.note;
      body.append(title, note);

      lab.append(inp, body);
      box.append(lab);
    });
  }

  function applyCascading() {
    const form = document.getElementById("vote-form");
    if (!form) return;

    const fd = new FormData(form);
    const selFuel = String(fd.get("fuel") || "");
    const selHarness = String(fd.get("harness") || "");
    const isCursorFamily = selFuel.toLowerCase().includes("cursor") || selHarness.toLowerCase().includes("cursor");

    const badge = document.getElementById("model-cascade-badge");
    if (badge) {
      badge.textContent = isCursorFamily ? "仅 Grok / Composer" : "全模型";
    }

    const modelLabels = document.querySelectorAll("#model-choices .choice-label");
    modelLabels.forEach(function (label) {
      const radio = label.querySelector('input[type="radio"]');
      const modelId = label.dataset.modelId;
      const item = MODEL_CATALOG.find(function (m) { return m.id === modelId; });
      const isCursorAllowed = item && item.isCursor;
      const noteEl = label.querySelector(".choice-note");

      if (isCursorFamily) {
        if (isCursorAllowed) {
          radio.disabled = false;
          label.classList.remove("is-disabled");
          if (noteEl) noteEl.textContent = item.id === "grok-4.6" ? "Cursor主力" : "Cursor原生";
        } else {
          radio.disabled = true;
          label.classList.add("is-disabled");
          if (noteEl) noteEl.textContent = "Cursor 系不可用";
          if (radio.checked) {
            const defRadio = document.querySelector('input[name="model"][value="grok-4.6"]');
            if (defRadio) defRadio.checked = true;
          }
        }
      } else {
        radio.disabled = false;
        label.classList.remove("is-disabled");
        if (noteEl) noteEl.textContent = item ? item.note : "";
      }
    });

    const curModel = String(form.elements["model"] ? form.elements["model"].value : "grok-4.6");
    const curEnv = String(fd.get("environment") || "Cloud Agent 托管机");
    setStackPill(document.getElementById("pipe-pill-fuel"), "燃料", selFuel);
    setStackPill(document.getElementById("pipe-pill-model"), "模型", curModel);
    setStackPill(document.getElementById("pipe-pill-harness"), "载体", selHarness);
    setStackPill(document.getElementById("pipe-pill-env"), "环境", curEnv);
  }

  function bindCascadingConstraints() {
    const form = document.getElementById("vote-form");
    if (!form) return;
    if (!state.cascadeBound) {
      state.cascadeBound = true;
      form.addEventListener("change", applyCascading);
    }
    applyCascading();
  }

  function checkVoteReceipt(windowId) {
    const btn = document.getElementById("vote-submit-btn");
    const msg = document.getElementById("vote-msg");
    try {
      const raw = localStorage.getItem(receiptKey(windowId));
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec && rec.windowId === windowId) {
          if (btn) btn.disabled = true;
          if (msg) {
            msg.textContent = "本机已投过（单 IP 每窗一次）。";
            msg.setAttribute("data-kind", "ok");
          }
          return true;
        }
      }
    } catch (_) {}
    if (btn) btn.disabled = false;
    if (msg) { msg.textContent = ""; msg.removeAttribute("data-kind"); }
    return false;
  }

  const voteForm = document.getElementById("vote-form");
  if (voteForm) {
    voteForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (state.submitting) return;
      const panel = document.getElementById("vote-panel");
      if (!state.window || (panel && panel.hidden)) return;

      const btn = document.getElementById("vote-submit-btn");
      const msg = document.getElementById("vote-msg");
      const fd = new FormData(voteForm);

      const payload = {
        windowId: state.window.windowId,
        fuel: String(fd.get("fuel") || ""),
        harness: String(fd.get("harness") || ""),
        environment: String(fd.get("environment") || ""),
        candidateId: String(fd.get("candidateId") || ""),
        fingerprint: getFingerprint()
      };

      if (!payload.fuel || !payload.harness || !payload.environment) {
        msg.textContent = "请勾选燃料、载体与 7×24。";
        msg.setAttribute("data-kind", "err");
        return;
      }

      state.submitting = true;
      if (btn) btn.disabled = true;
      msg.textContent = "提交中…";
      msg.removeAttribute("data-kind");

      const apiBase = String(state.config && state.config.voteApiBase || "").trim().replace(/\/$/, "");
      const voteUrl = apiBase ? (apiBase + "/api/vote") : "/api/vote";

      try {
        const res = await fetch(voteUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.status === 409 && data.error === "already_voted") {
          msg.textContent = "该公网 IP 已在本窗投过。";
          msg.setAttribute("data-kind", "err");
          localStorage.setItem(receiptKey(state.window.windowId), JSON.stringify({
            windowId: state.window.windowId, at: new Date().toISOString()
          }));
          return;
        }

        if (!data.ok) {
          const errMap = {
            window_closed: "本窗已关。",
            invalid_option: "仅可投军火库启用项。",
            rate_limited: "请稍后再试。",
            unknown_window: "投票窗尚未同步。"
          };
          msg.textContent = errMap[data.error] || ("失败: " + (data.error || res.status));
          msg.setAttribute("data-kind", "err");
          if (btn) btn.disabled = false;
          return;
        }

        localStorage.setItem(receiptKey(state.window.windowId), JSON.stringify({
          windowId: state.window.windowId,
          at: new Date().toISOString(),
          payload: payload
        }));

        msg.textContent = "已记票。窗关后自动结算。";
        msg.setAttribute("data-kind", "ok");
        loadLiveTallies(state.window.windowId);
      } catch (err) {
        console.error("投票请求异常:", err);
        msg.textContent = "投票接口不可达。";
        msg.setAttribute("data-kind", "err");
        if (btn) btn.disabled = false;
      } finally {
        state.submitting = false;
      }
    });
  }

  async function loadLiveTallies(windowId) {
    const apiBase = String(state.config && state.config.voteApiBase || "").trim().replace(/\/$/, "");
    if (!apiBase) return;
    try {
      const res = await fetch(apiBase + "/api/vote?windowId=" + encodeURIComponent(windowId), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok) renderTalliesView(data);
    } catch (_) {}
  }

  function renderTalliesView(data) {
    const box = document.getElementById("tallies-box");
    const countTag = document.getElementById("tallies-count-tag");
    const grid = document.getElementById("tallies-grid");
    if (!box || !grid) return;

    box.hidden = false;
    if (countTag) countTag.textContent = (data.voteCount || 0) + " 票";
    grid.replaceChildren();

    const labels = { fuel: "燃料", harness: "载体", environment: "7×24" };
    const tallies = data.tallies || {};

    ["fuel", "harness", "environment"].forEach(function (kind) {
      const col = document.createElement("div");
      col.className = "tally-group";
      const h4 = document.createElement("h4");
      h4.textContent = labels[kind];
      col.append(h4);

      const map = tallies[kind] || {};
      const keys = Object.keys(map).sort(function (a, b) { return (map[b] || 0) - (map[a] || 0); });

      if (!keys.length) {
        const empty = document.createElement("p");
        empty.style.fontSize = "0.72rem";
        empty.style.color = "var(--faint)";
        empty.style.margin = "0";
        empty.textContent = "暂无票";
        col.append(empty);
      } else {
        keys.forEach(function (k) {
          const row = document.createElement("div");
          row.className = "tally-bar-row";
          const name = document.createElement("span");
          name.textContent = k;
          const count = document.createElement("b");
          count.textContent = map[k] + " 票";
          row.append(name, count);
          col.append(row);
        });
      }
      grid.append(col);
    });

    const winBox = document.getElementById("tallies-winner");
    if (winBox && state.ledger) {
      const w = state.ledger.winningStack;
      if (w) {
        winBox.replaceChildren();
        const b = document.createElement("b");
        b.textContent = "上一窗：";
        const rest = w.autoPick
          ? "零票 autoPick"
          : [w.fuel, w.harness, w.environment].filter(Boolean).join(" · ");
        winBox.append(b, document.createTextNode(rest));
      }
    }
  }

  function makeLayerTag(kind, text) {
    const tag = document.createElement("span");
    tag.className = "card-tag tag-" + (kind === "environment" ? "env" : kind);
    tag.title = TIER_LABEL[kind] || kind;
    const prefix = document.createElement("i");
    prefix.textContent = TIER_LABEL[kind] || kind;
    tag.append(prefix, document.createTextNode(text));
    return tag;
  }

  function renderShippedCards() {
    const grid = document.getElementById("cards-grid");
    const searchInput = document.getElementById("demo-search");
    if (!grid) return;

    const items = state.bookmarks.slice().sort(function (a, b) {
      return (Date.parse(b.processedAt) || 0) - (Date.parse(a.processedAt) || 0);
    });

    function filterAndRender() {
      const q = String(searchInput ? searchInput.value : "").trim().toLowerCase();
      grid.replaceChildren();

      const matched = items.filter(function (it) {
        if (!q) return true;
        const fullText = [
          it.slug, it.titleZh, it.title, it.hubTitle, it.author, it.blurbZh, it.rationaleZh,
          it.subscriptionZh, it.modelZh, it.harnessZh, it.environmentZh, it.fuelZh, it.fuel
        ].join(" ").toLowerCase();
        return fullText.includes(q);
      });

      if (!matched.length) {
        const empty = document.createElement("p");
        empty.style.gridColumn = "1 / -1";
        empty.style.color = "var(--faint)";
        empty.style.padding = "2rem 0";
        empty.style.textAlign = "center";
        empty.textContent = "没有匹配的演示";
        grid.append(empty);
        return;
      }

      matched.forEach(function (item) {
        const card = document.createElement("article");
        card.className = "card";
        card.addEventListener("mousemove", function (e) {
          const rect = card.getBoundingClientRect();
          card.style.setProperty("--mouse-x", (e.clientX - rect.left) + "px");
          card.style.setProperty("--mouse-y", (e.clientY - rect.top) + "px");
        });

        const topRow = document.createElement("div");
        topRow.className = "card-top";
        const slugSpan = document.createElement("span");
        slugSpan.className = "card-slug-badge";
        slugSpan.textContent = item.slug || "demo";
        topRow.append(slugSpan);

        const originUrl = safeUrl(item.url);
        if (originUrl) {
          const originBtn = document.createElement("a");
          originBtn.className = "card-origin-btn";
          originBtn.href = originUrl;
          originBtn.target = "_blank";
          originBtn.rel = "noopener";
          originBtn.textContent = "原帖";
          topRow.append(originBtn);
        }

        const mid = document.createElement("div");
        const h4 = document.createElement("h4");
        h4.className = "card-title";
        h4.textContent = item.hubTitle || item.titleZh || item.title || item.slug;
        mid.append(h4);

        const line = item.blurbZh || item.rationaleZh || "";
        if (line) {
          const p = document.createElement("p");
          p.className = "card-blurb";
          p.textContent = line;
          mid.append(p);
        }

        const tagsRow = document.createElement("div");
        tagsRow.className = "card-tags";

        const fuelVal = item.fuelZh || item.fuel ||
          [item.subscriptionZh || item.subscription, item.modelZh || item.model].filter(Boolean).join(" · ");
        if (fuelVal) tagsRow.append(makeLayerTag("fuel", fuelVal));
        const harnessVal = item.harnessZh || item.harness;
        if (harnessVal) tagsRow.append(makeLayerTag("harness", harnessVal));
        const envVal = item.environmentZh || item.environment || item.cloudZh || item.cloud;
        if (envVal) tagsRow.append(makeLayerTag("environment", envVal));
        mid.append(tagsRow);

        const btm = document.createElement("div");
        btm.className = "card-bottom";
        const authSpan = document.createElement("span");
        authSpan.className = "card-author-meta";
        authSpan.textContent = item.author ? "@" + item.author : "";
        const enterBtn = document.createElement("a");
        enterBtn.className = "card-enter-btn";
        enterBtn.href = safeRelativePath(item.path, item.slug);
        enterBtn.textContent = "进入";
        btm.append(authSpan, enterBtn);

        card.append(topRow, mid, btm);
        grid.append(card);
      });
    }

    state.demoFilterAndRender = filterAndRender;
    if (searchInput && !state.searchBound) {
      state.searchBound = true;
      searchInput.addEventListener("input", function () {
        if (typeof state.demoFilterAndRender === "function") state.demoFilterAndRender();
      });
    }
    filterAndRender();
  }

  function renderArsenal() {
    const sec = document.getElementById("arsenal-section");
    const container = document.getElementById("arsenal-3tiers");
    if (!sec || !container || !state.arsenal) return;

    const sections = Array.isArray(state.arsenal.sections) ? state.arsenal.sections : [];
    if (!sections.length) { sec.hidden = true; return; }

    sec.hidden = false;

    const overviewEl = document.getElementById("arsenal-overview");
    if (overviewEl) {
      overviewEl.textContent = state.arsenal.overviewZh || "燃料 → 载体 → 7×24。";
    }
    const quotaEl = document.getElementById("arsenal-quota-note");
    if (quotaEl) {
      const board = state.arsenal.quotaBoardZh || "CodexBar";
      quotaEl.textContent = state.arsenal.quotaNoteZh || (board + " 管配额明细");
    }

    container.replaceChildren();

    sections.forEach(function (s) {
      const col = document.createElement("div");
      col.className = "arsenal-column";
      col.dataset.tier = s.id || "";

      const head = document.createElement("div");
      head.className = "tier-header";

      const titleRow = document.createElement("div");
      titleRow.className = "tier-title";
      const titleName = document.createElement("span");
      titleName.textContent = s.titleZh || s.id;
      const titleBadge = document.createElement("span");
      titleBadge.className = "tier-badge";
      titleBadge.textContent = s.kickerZh || (s.id ? s.id.toUpperCase() : "");
      titleRow.append(titleName, titleBadge);
      head.append(titleRow);

      if (s.blurbZh) {
        const blurb = document.createElement("p");
        blurb.className = "tier-blurb";
        blurb.textContent = s.blurbZh;
        head.append(blurb);
      }
      col.append(head);

      const ul = document.createElement("ul");
      ul.className = "tier-list";

      (s.items || []).forEach(function (it) {
        const li = document.createElement("li");
        const isPlanned = it.status === "planned";
        li.className = "tier-item" + (isPlanned ? " is-planned" : "");

        const row = document.createElement("div");
        row.className = "tier-item-row";

        const name = document.createElement("span");
        name.className = "tier-item-name";
        name.textContent = it.nameZh || it.name || "—";

        const chip = document.createElement("span");
        chip.className = "status-chip " + (isPlanned ? "chip-planned" : "chip-active");
        chip.textContent = isPlanned ? "规划" : "启用";

        row.append(name, chip);
        li.append(row);

        if (it.noteZh) {
          const note = document.createElement("span");
          note.className = "tier-item-note";
          note.textContent = it.noteZh;
          li.append(note);
        }

        if (Array.isArray(it.tags) && it.tags.length) {
          const tags = document.createElement("div");
          tags.className = "tier-tags";
          it.tags.forEach(function (t) {
            const tg = document.createElement("span");
            tg.className = "tier-tag";
            tg.textContent = t;
            tags.append(tg);
          });
          li.append(tags);
        }

        ul.append(li);
      });

      col.append(ul);
      container.append(col);
    });
  }

  (function bgCanvas() {
    const canvas = document.getElementById("bg-canvas");
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    const particles = [];
    const COUNT = Math.min(28, Math.floor(w / 42));
    for (let i = 0; i < COUNT; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        radius: Math.random() * 1.4 + 0.6,
        alpha: Math.random() * 0.32 + 0.08
      });
    }
    window.addEventListener("resize", function () {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    });
    function render() {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(92, 225, 230, " + p.alpha + ")";
        ctx.fill();
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 110) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = "rgba(140, 190, 255, " + (0.1 * (1 - dist / 110)) + ")";
            ctx.lineWidth = 0.7;
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  })();

  loadAllData();
})();
