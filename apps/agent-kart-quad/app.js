(() => {
  const RACERS = [
    {
      id: "ds-astra",
      name: "DeepSeek ← Astra",
      role: "交叉 · 子代理",
      lead: "DeepSeek max",
      helper: "Astra medium",
      accent: "#3ee0c6",
      accentHi: "#9ff7e8",
      badge: "#ff6b9d",
      simple: false,
      delay: 0.32,
      accel: 0.58,
      max: 0.93,
      grip: 0.92,
      boostSkill: 0.86,
      summary: "DeepSeek 把赛道规则写完整，Astra 子代理补按钮、计时和车漆。起步会停半拍，路线最贴中线。",
      steps: ["规则先立住", "补齐发车 HUD", "车漆与粒子", "冲线回放"],
    },
    {
      id: "astra-ds",
      name: "Astra ← DeepSeek",
      role: "交叉 · 子代理",
      lead: "Astra medium",
      helper: "DeepSeek max",
      accent: "#ff6b9d",
      accentHi: "#ffd0e0",
      badge: "#3ee0c6",
      simple: false,
      delay: 0.1,
      accel: 0.8,
      max: 0.88,
      grip: 0.6,
      boostSkill: 0.72,
      summary: "Astra 先把能玩的车开出来，DeepSeek 子代理在后座改碰撞和加速曲线。出手快，过弯会甩尾。",
      steps: ["先能开起来", "借力补物理", "道具带一点", "边开边修"],
    },
    {
      id: "ds-solo",
      name: "DeepSeek 独跑",
      role: "独跑 · max",
      lead: "DeepSeek max",
      helper: "无",
      accent: "#7aa2ff",
      accentHi: "#d4e2ff",
      badge: "#ffd56a",
      simple: false,
      delay: 0.58,
      accel: 0.46,
      max: 0.97,
      grip: 0.96,
      boostSkill: 0.52,
      summary: "没有子代理可问。max 推理把物理想透再动，热身最长，后期车体最完整、抓地最好。",
      steps: ["先想清物理", "再画车道", "HUD 较晚", "终点最稳"],
    },
    {
      id: "astra-solo",
      name: "Astra 独跑",
      role: "独跑 · medium",
      lead: "Astra medium",
      helper: "无",
      accent: "#ffb347",
      accentHi: "#ffe0ad",
      badge: "#ffb347",
      simple: true,
      delay: 0.02,
      accel: 0.92,
      max: 0.8,
      grip: 0.48,
      boostSkill: 0.4,
      summary: "medium 独跑：最快交出可玩版本。车体更简、道具更少，靠爆发起步，后半会被完整车追上。",
      steps: ["立刻能玩", "车体从简", "少做回放", "先冲线再说"],
    },
  ];

  const BOOSTS = [0.28, 0.52, 0.74];
  const FINISH = 0.965;

  const lanesEl = document.getElementById("lanes");
  const goBtn = document.getElementById("go");
  const resetBtn = document.getElementById("reset");
  const clearBtn = document.getElementById("clear-focus");
  const clockEl = document.getElementById("clock");
  const countdownEl = document.getElementById("countdown");
  const inspectTitle = document.getElementById("inspect-title");
  const inspectBody = document.getElementById("inspect-body");
  const inspectSpec = document.getElementById("inspect-spec");
  const inspectBuild = document.getElementById("inspect-build");
  const inspectKicker = document.querySelector(".inspect-kicker");

  const state = {
    running: false,
    counting: false,
    t: 0,
    last: 0,
    focus: null,
    places: [],
    racers: RACERS.map((r) => ({
      ...r,
      x: 0,
      v: 0,
      wobble: 0,
      done: false,
      time: null,
      used: new Set(),
    })),
  };

  function kartHTML(racer) {
    return `
      <span class="kart ${racer.simple ? "simple" : ""}" data-kart="${racer.id}" style="--accent:${racer.accent};--accent-hi:${racer.accentHi};--badge:${racer.badge}">
        <span class="shadow"></span>
        <span class="wheel fl"></span>
        <span class="wheel fr"></span>
        <span class="wheel rl"></span>
        <span class="wheel rr"></span>
        <span class="body">
          <span class="spoiler"></span>
          <span class="cockpit"></span>
          <span class="nose"></span>
          <span class="badge"></span>
        </span>
      </span>
    `;
  }

  function boostHTML() {
    return BOOSTS.map((p) => `<span class="boost" style="left:${p * 100}%"></span>`).join("");
  }

  function renderLanes() {
    lanesEl.replaceChildren();
    state.racers.forEach((racer, index) => {
      const btn = document.createElement("article");
      btn.className = "lane";
      btn.dataset.lane = racer.id;
      btn.style.setProperty("--accent", racer.accent);
      btn.setAttribute("role", "button");
      btn.tabIndex = 0;
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = `
        <div class="lane-meta">
          <p class="lane-name">${racer.name}</p>
          <p class="lane-role">${racer.role}</p>
          <p class="lane-place" data-place></p>
        </div>
        <div class="track" aria-hidden="true">
          <div class="boosts">${boostHTML()}</div>
          <span class="finish"></span>
          ${kartHTML(racer)}
        </div>
        <div class="progress"><span data-bar></span></div>
      `;
      btn.addEventListener("click", () => setFocus(racer.id));
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          setFocus(racer.id);
        }
      });
      lanesEl.append(btn);
      racer.el = btn;
      racer.kart = btn.querySelector("[data-kart]");
      racer.bar = btn.querySelector("[data-bar]");
      racer.placeEl = btn.querySelector("[data-place]");
      racer.index = index;
    });
  }

  function setFocus(id) {
    state.focus = state.focus === id ? null : id;
    document.querySelectorAll("[data-focus]").forEach((cell) => {
      cell.setAttribute("aria-pressed", cell.dataset.focus === state.focus ? "true" : "false");
    });
    state.racers.forEach((racer) => {
      const on = !state.focus || racer.id === state.focus;
      racer.el.classList.toggle("is-focus", racer.id === state.focus);
      racer.el.classList.toggle("is-dim", Boolean(state.focus) && !on);
      racer.el.setAttribute("aria-pressed", racer.id === state.focus ? "true" : "false");
    });
    const racer = RACERS.find((r) => r.id === (state.focus || ""));
    paintInspect(racer || null);
  }

  function paintInspect(racer) {
    if (!racer) {
      inspectKicker.textContent = "点车道或矩阵看这一车";
      inspectTitle.textContent = "四车同题，脾气不同";
      inspectBody.textContent = "交叉两车互相借力，独跑两车只靠自己。发车后看起步、抓地和冲线，不要只看谁先到。";
      inspectSpec.replaceChildren();
      inspectBuild.replaceChildren();
      return;
    }
    inspectKicker.textContent = racer.role;
    inspectTitle.textContent = racer.name;
    inspectBody.textContent = racer.summary;
    inspectSpec.replaceChildren();
    [
      ["主导", racer.lead],
      ["子代理", racer.helper],
      ["起步", racer.delay < 0.2 ? "几乎立刻" : racer.delay > 0.45 ? "先想再开" : "停半拍"],
      ["抓地", racer.grip > 0.85 ? "贴线" : racer.grip > 0.55 ? "略晃" : "甩尾"],
    ].forEach(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      inspectSpec.append(dt, dd);
    });
    inspectBuild.replaceChildren();
    inspectBuild.style.setProperty("--accent", racer.accent);
    racer.steps.forEach((step, i) => {
      const li = document.createElement("li");
      li.textContent = `${String(i + 1).padStart(2, "0")}  ${step}`;
      inspectBuild.append(li);
    });
    syncBuildLights();
  }

  function syncBuildLights() {
    const racer = state.racers.find((r) => r.id === state.focus);
    const items = inspectBuild.querySelectorAll("li");
    items.forEach((li, i) => {
      const threshold = (i + 1) / items.length;
      const x = racer ? racer.x : 0;
      li.classList.toggle("is-on", x >= threshold * 0.92 || (racer && racer.done));
    });
  }

  function resetRace(keepFocus) {
    state.running = false;
    state.counting = false;
    state.t = 0;
    state.last = 0;
    state.places = [];
    goBtn.textContent = "发车";
    goBtn.setAttribute("aria-pressed", "false");
    countdownEl.hidden = true;
    countdownEl.textContent = "";
    clockEl.textContent = "待机 0.00s";
    state.racers.forEach((racer) => {
      racer.x = 0;
      racer.v = 0;
      racer.wobble = 0;
      racer.done = false;
      racer.time = null;
      racer.used = new Set();
      if (racer.placeEl) racer.placeEl.textContent = "";
      paintKart(racer);
    });
    if (!keepFocus) setFocus(null);
    else syncBuildLights();
  }

  function placeLabel(n) {
    return ["① 冲线", "② 冲线", "③ 冲线", "④ 冲线"][n] || "";
  }

  function paintKart(racer) {
    const x = racer.x;
    const track = racer.el.querySelector(".track");
    const usable = Math.max(track.clientWidth - 62, 1);
    const wobble = Math.sin(state.t * (4.2 - racer.grip * 2.4) + racer.index) * (1 - racer.grip) * 7;
    racer.kart.style.transform = `translate(${x * usable}px, calc(-50% + ${wobble}px))`;
    racer.kart.classList.toggle("is-spin", state.running && !racer.done && racer.v > 0.01);
    racer.bar.style.width = `${Math.min(100, x * 100)}%`;
    racer.bar.style.background = racer.accent;
  }

  function step(dt) {
    state.t += dt;
    state.racers.forEach((racer) => {
      if (racer.done) return;
      if (state.t < racer.delay) {
        paintKart(racer);
        return;
      }
      const warm = Math.min(1, (state.t - racer.delay) / 0.9);
      let target = racer.accel * 0.22 + racer.max * 0.55 * warm;
      BOOSTS.forEach((p, i) => {
        if (racer.x > p && racer.x < p + 0.045 && !racer.used.has(i)) {
          racer.used.add(i);
          target += 0.22 * racer.boostSkill;
        }
      });
      const slip = (Math.random() - 0.5) * (1 - racer.grip) * 0.18;
      racer.v += (target - racer.v) * Math.min(1, dt * (2.4 + racer.grip));
      racer.x += Math.max(0.02, racer.v + slip) * dt * 0.42;
      if (racer.x >= FINISH) {
        racer.x = 1;
        racer.v = 0;
        racer.done = true;
        racer.time = state.t;
        state.places.push(racer.id);
        racer.placeEl.textContent = placeLabel(state.places.length - 1) + "  " + racer.time.toFixed(2) + "s";
      }
      paintKart(racer);
    });
    clockEl.textContent = (state.places.length === 4 ? "完赛 " : "计时 ") + state.t.toFixed(2) + "s";
    syncBuildLights();
    if (state.places.length === 4) {
      state.running = false;
      goBtn.textContent = "再看一轮";
      goBtn.setAttribute("aria-pressed", "false");
    }
  }

  function loop(now) {
    if (!state.running) return;
    if (!state.last) state.last = now;
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    step(dt);
    if (state.running) requestAnimationFrame(loop);
  }

  function startCountdown() {
    if (state.counting) return;
    if (state.places.length === 4 || state.t === 0) resetRace(true);
    state.counting = true;
    const beats = ["3", "2", "1", "发车"];
    let i = 0;
    countdownEl.hidden = false;
    const tick = () => {
      if (!state.counting) return;
      if (i >= beats.length) {
        countdownEl.hidden = true;
        countdownEl.textContent = "";
        state.counting = false;
        state.running = true;
        state.last = 0;
        goBtn.textContent = "暂停";
        goBtn.setAttribute("aria-pressed", "true");
        requestAnimationFrame(loop);
        return;
      }
      countdownEl.textContent = beats[i];
      i += 1;
      setTimeout(tick, i === beats.length ? 380 : 520);
    };
    tick();
  }

  function toggleRun() {
    if (state.counting) return;
    if (state.running) {
      state.running = false;
      goBtn.textContent = "继续";
      goBtn.setAttribute("aria-pressed", "false");
      return;
    }
    if (state.t > 0 && state.places.length < 4) {
      state.running = true;
      state.last = 0;
      goBtn.textContent = "暂停";
      goBtn.setAttribute("aria-pressed", "true");
      requestAnimationFrame(loop);
      return;
    }
    startCountdown();
  }

  goBtn.addEventListener("click", toggleRun);
  resetBtn.addEventListener("click", () => resetRace(true));
  clearBtn.addEventListener("click", () => setFocus(null));

  document.querySelectorAll("[data-focus]").forEach((cell) => {
    cell.addEventListener("click", () => setFocus(cell.dataset.focus));
  });

  window.addEventListener("keydown", (ev) => {
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (ev.code === "Space") {
      if (ev.target && ev.target.closest && ev.target.closest("button")) return;
      ev.preventDefault();
      toggleRun();
    } else if (ev.key === "r" || ev.key === "R") {
      resetRace(true);
    } else if (ev.key >= "1" && ev.key <= "4") {
      setFocus(RACERS[Number(ev.key) - 1].id);
    }
  });

  window.addEventListener("resize", () => {
    state.racers.forEach(paintKart);
  });

  renderLanes();
  paintInspect(null);
})();
