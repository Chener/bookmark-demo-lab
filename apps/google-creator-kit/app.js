(() => {
  const COLORS = ["#4285f4", "#ea4335", "#fbbc05", "#34a853"];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const usages = [
    {
      id: "codex",
      pane: "codex",
      idx: "01",
      pin: "#4285f4",
      title: "Pro 接进 Codex",
      blurb: "挑几个 Google Pro，接到 Codex 工位。",
    },
    {
      id: "gemini",
      pane: "codex",
      idx: "02",
      pin: "#ea4335",
      title: "Skill 换 Gemini 跑",
      blurb: "以前做视频的 Skill，换 Gemini 也顺。",
    },
    {
      id: "flow",
      pane: "flow",
      idx: "03",
      pin: "#fbbc05",
      title: "Flow 批量做图",
      blurb: "配合插件，一次排出一组画面。",
    },
    {
      id: "notebook",
      pane: "notebook",
      idx: "04",
      pin: "#34a853",
      title: "NotebookLM 做 PPT",
      blurb: "拿现成资料，压成一套简报。",
    },
    {
      id: "reverse",
      pane: "reverse",
      idx: "05",
      pin: "#4285f4",
      title: "视频反推",
      blurb: "作者最推荐先练的入口。",
      star: true,
    },
    {
      id: "boards",
      pane: "reverse",
      idx: "06",
      pin: "#ea4335",
      title: "拆一次分镜",
      blurb: "拿一条喜欢的视频，拆成格子。",
    },
    {
      id: "short",
      pane: "reverse",
      idx: "07",
      pin: "#fbbc05",
      title: "做一条短片",
      blurb: "按分镜试着串出自己的一条。",
    },
  ];

  const nodeCopy = {
    pro: "Google Pro 当燃料：额度够用，才适合预算有限的创作者反复试错。",
    codex: "把 Pro 接到 Codex：原来写视频 Skill 的工位，现在可以继续调度。",
    gemini: "同一套 Skill 换 Gemini 跑。原帖的体感就一句话：非常香。",
  };

  const clips = {
    night: {
      title: "夜市灯牌",
      shots: ["远景摊位", "灯牌特写", "蒸汽升腾", "手递小吃", "地面反光", "收束夜色"],
    },
    pour: {
      title: "手冲咖啡",
      shots: ["器具静物", "注水圆弧", "粉层开花", "液面旋纹", "杯壁拉花", "端到窗边"],
    },
    rain: {
      title: "城市雨巷",
      shots: ["雨丝街灯", "伞沿滴水", "橱窗倒影", "脚步溅花", "霓虹招牌", "巷口回望"],
    },
  };

  const slidesAll = {
    post: {
      title: "预算有限，也能很香",
      body: "原帖：把 Google 这套工具整理成 7 种用法，特别适合预算有限的内容创作者。",
    },
    flow: {
      title: "Flow 配合插件",
      body: "批量做图：锁风格、排四宫格、再把画幅拧到短视频能用的比例。",
    },
    ppt: {
      title: "NotebookLM 做 PPT",
      body: "不要从空白页开始。把现成资料丢进去，先出一版能讲的简报。",
    },
    reverse: {
      title: "先练视频反推",
      body: "拿一条喜欢的视频，拆一次分镜，再试着做一条自己的短片。",
    },
  };

  const cardsEl = document.querySelector("[data-cards]");
  const pinLabel = document.querySelector("[data-pin-label]");
  const creditsEl = document.querySelector("[data-credits]");
  let credits = 1000;
  let pptIndex = 0;
  let pptSlides = [];
  let activeClip = "night";
  let filmTimer = 0;
  let flowTimer = 0;

  function paintCard(item) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "card";
    btn.style.setProperty("--pin", item.pin);
    btn.dataset.id = item.id;
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = `
      <span class="pin" aria-hidden="true"></span>
      <p class="idx">${item.idx}${item.star ? '<span class="star">最推荐</span>' : ""}</p>
      <h3>${item.title}</h3>
      <p>${item.blurb}</p>
    `;
    btn.addEventListener("click", () => select(item.id, { scroll: true }));
    return btn;
  }

  usages.forEach((item) => cardsEl.append(paintCard(item)));

  function select(id, opts = {}) {
    const item = usages.find((u) => u.id === id) || usages[4];
    cardsEl.querySelectorAll(".card").forEach((el) => {
      const on = el.dataset.id === item.id;
      el.classList.toggle("is-on", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll("[data-pane]").forEach((pane) => {
      pane.classList.toggle("is-hot", pane.dataset.pane === item.pane);
    });
    pinLabel.textContent = "当前图钉：" + item.title;
    if (item.pane === "codex") {
      const node = item.id === "gemini" ? "gemini" : "pro";
      setNode(node);
    }
    if (opts.scroll) {
      document.getElementById("bench").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
    if (item.id === "short") playShort();
    if (item.id === "boards" || item.id === "reverse") drawStoryboard(activeClip);
  }

  function setNode(name) {
    document.querySelectorAll("[data-node]").forEach((el) => {
      el.classList.toggle("is-on", el.dataset.node === name);
    });
    const copy = document.querySelector("[data-node-copy]");
    if (copy) copy.textContent = nodeCopy[name] || nodeCopy.pro;
  }

  document.querySelectorAll("[data-node]").forEach((btn) => {
    btn.addEventListener("click", () => setNode(btn.dataset.node));
  });

  document.querySelectorAll("[data-plugin]").forEach((btn) => {
    btn.addEventListener("click", () => btn.classList.toggle("is-on"));
  });

  function spend(n) {
    credits = Math.max(0, credits - n);
    creditsEl.textContent = String(credits);
  }

  function drawAbstract(canvas, seed, wide) {
    const ctx = canvas.getContext("2d");
    const w = (canvas.width = wide ? 320 : 220);
    const h = (canvas.height = wide ? 160 : 140);
    const rng = mulberry(seed);
    const bg = COLORS[Math.floor(rng() * COLORS.length)];
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i += 1) {
      ctx.fillStyle = COLORS[Math.floor(rng() * COLORS.length)];
      ctx.globalAlpha = 0.55;
      const x = rng() * w;
      const y = rng() * h;
      const r = 18 + rng() * 54;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#fffdf7";
    ctx.fillRect(w * 0.12, h * 0.62, w * 0.46, 8);
    ctx.globalAlpha = 1;
  }

  function mulberry(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const polaroids = document.querySelector("[data-polaroids]");
  document.querySelector("[data-flow-go]").addEventListener("click", () => {
    if (flowTimer) return;
    window.clearTimeout(flowTimer);
    const plugins = [...document.querySelectorAll("[data-plugin].is-on")].map((el) => el.dataset.plugin);
    const wide = plugins.includes("wide");
    const count = plugins.includes("batch") ? 4 : 2;
    const prompt = document.getElementById("flow-prompt").value.trim() || "未命名画面";
    polaroids.innerHTML = "";
    for (let i = 0; i < count; i += 1) {
      const wait = document.createElement("div");
      wait.className = "polaroid is-wait";
      wait.style.setProperty("--spin", `${(i % 2 ? 1 : -1) * (1.2 + i * 0.4)}deg`);
      polaroids.append(wait);
    }
    spend(plugins.includes("style") ? 12 : 8);
    flowTimer = window.setTimeout(() => {
      flowTimer = 0;
      polaroids.innerHTML = "";
      for (let i = 0; i < count; i += 1) {
        const fig = document.createElement("figure");
        fig.className = "polaroid";
        fig.style.setProperty("--spin", `${(i % 2 ? 1 : -1) * (1.2 + i * 0.4)}deg`);
        const canvas = document.createElement("canvas");
        drawAbstract(canvas, Date.now() + i * 97, wide);
        const cap = document.createElement("figcaption");
        cap.textContent = `${prompt.slice(0, 10)} · ${String(i + 1).padStart(2, "0")}`;
        fig.append(canvas, cap);
        polaroids.append(fig);
      }
    }, reduced ? 0 : 420);
  });

  document.querySelectorAll("[data-source]").forEach((btn) => {
    btn.addEventListener("click", () => btn.classList.toggle("is-on"));
  });

  const deck = document.querySelector("[data-deck]");
  const slideEl = document.querySelector("[data-slide]");
  const pptCount = document.querySelector("[data-ppt-count]");

  function renderSlide() {
    if (!pptSlides.length) return;
    const slide = pptSlides[pptIndex];
    slideEl.innerHTML = `<h4>${slide.title}</h4><p>${slide.body}</p>`;
    pptCount.hidden = false;
    pptCount.textContent = `${pptIndex + 1} / ${pptSlides.length}`;
  }

  document.querySelector("[data-ppt-go]").addEventListener("click", () => {
    const keys = [...document.querySelectorAll("[data-source].is-on")].map((el) => el.dataset.source);
    pptSlides = keys.map((k) => slidesAll[k]).filter(Boolean);
    if (!pptSlides.length) {
      pptSlides = [slidesAll.post];
    }
    pptIndex = 0;
    deck.hidden = false;
    renderSlide();
    spend(5);
  });

  document.querySelector("[data-ppt-prev]").addEventListener("click", () => {
    if (!pptSlides.length) return;
    pptIndex = (pptIndex - 1 + pptSlides.length) % pptSlides.length;
    renderSlide();
  });
  document.querySelector("[data-ppt-next]").addEventListener("click", () => {
    if (!pptSlides.length) return;
    pptIndex = (pptIndex + 1) % pptSlides.length;
    renderSlide();
  });

  document.querySelectorAll("[data-clip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeClip = btn.dataset.clip;
      document.querySelectorAll("[data-clip]").forEach((el) => el.classList.toggle("is-on", el === btn));
      drawStoryboard(activeClip);
      if (!film.hidden) startFilm();
    });
  });

  const board = document.querySelector("[data-storyboard]");
  function drawStoryboard(clipId) {
    const clip = clips[clipId] || clips.night;
    board.innerHTML = "";
    clip.shots.forEach((label, i) => {
      const li = document.createElement("li");
      li.className = "shot";
      const canvas = document.createElement("canvas");
      drawAbstract(canvas, clip.title.length * 13 + i * 41, true);
      li.innerHTML = `<b>镜头 ${i + 1}</b><span>${label}</span>`;
      li.prepend(canvas);
      board.append(li);
    });
  }

  const film = document.querySelector("[data-film]");
  const filmFrame = document.querySelector("[data-film-frame]");
  const filmCap = document.querySelector("[data-film-cap]");

  function stopFilm() {
    window.clearInterval(filmTimer);
    filmTimer = 0;
  }

  function startFilm() {
    const clip = clips[activeClip] || clips.night;
    film.hidden = false;
    let i = 0;
    const tick = () => {
      const shot = clip.shots[i % clip.shots.length];
      filmCap.textContent = `${clip.title} · ${shot}`;
      filmFrame.style.filter = `hue-rotate(${i * 28}deg)`;
      i += 1;
    };
    stopFilm();
    tick();
    if (!reduced) filmTimer = window.setInterval(tick, 800);
  }

  document.querySelector("[data-reverse-go]").addEventListener("click", () => {
    drawStoryboard(activeClip);
    spend(10);
    film.hidden = true;
    stopFilm();
  });

  function playShort() {
    if (!board.children.length) drawStoryboard(activeClip);
    startFilm();
    spend(15);
  }

  document.querySelector("[data-short-go]").addEventListener("click", playShort);

  document.querySelector("[data-recommend]").addEventListener("click", () => {
    select("reverse", { scroll: true });
  });

  select("reverse");
  drawStoryboard(activeClip);
})();
