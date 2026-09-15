(() => {
  const FPS = 30;
  const DURATION = 18 * FPS;
  const TEAR = 18;

  const SCENES = [
    {
      id: "beige",
      from: 0,
      to: 48,
      caption: "你现在看到的这条短片，完全由静态网页致敬完成。",
    },
    {
      id: "title",
      from: 30,
      to: 168,
      caption: "报纸底、撕裂边、印章字 —— Remotion 撕纸片的静态原作致敬。",
    },
    {
      id: "steps",
      from: 150,
      to: 258,
      caption: "今天就把整体的剪辑思路拆给你，一共就 6 步。",
    },
    {
      id: "static-first",
      from: 252,
      to: 372,
      caption: "先确认静态构图，再做视频，效果才稳。",
    },
    {
      id: "strips",
      from: 360,
      to: 462,
      caption: "录屏、截图、Logo、品牌，都先撕成纸片。",
    },
    {
      id: "end",
      from: 450,
      to: DURATION + 6,
      caption: "最小片到此循环。源书签在页脚。",
    },
  ];

  const stage = document.getElementById("stage");
  const canvas = document.getElementById("newsprint");
  const captionEl = document.getElementById("caption");
  const playBtn = document.getElementById("play");
  const replayBtn = document.getElementById("replay");
  const scrub = document.getElementById("scrub");
  const clock = document.getElementById("clock");
  const framesEl = document.getElementById("frames");
  const loopEl = document.getElementById("loop");
  const layers = [...document.querySelectorAll(".layer")];
  const layerMap = Object.fromEntries(layers.map((el) => [el.dataset.scene, el]));

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let frame = 0;
  let playing = !reduce;
  let lastTs = 0;
  let leftover = 0;

  function hash(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }

  function jaggedClip(progress, seed) {
    const steps = 48;
    const xBase = progress * 122 - 10;
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const y = (i / steps) * 100;
      const jag =
        Math.sin(i * 2.35 + seed) * 2.1 +
        Math.sin(i * 0.55 + seed * 0.3) * 1.4 +
        (hash(i * 19 + seed * 7) - 0.5) * 7.5;
      pts.push(`${(xBase + jag).toFixed(2)}% ${y.toFixed(2)}%`);
    }
    return `polygon(125% -6%, 125% 106%, ${pts.reverse().join(",")})`;
  }

  function drawSkyline(ctx, x, y, w, h, seed) {
    ctx.fillStyle = "#c2b7a6";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#a89e8d";
    const ground = y + h * 0.92;
    let cx = x + 6;
    let b = 0;
    while (cx < x + w - 8) {
      const bw = 6 + hash(seed + b) * (w * 0.12);
      const bh = h * (0.28 + hash(seed + b + 3) * 0.55);
      ctx.fillRect(cx, ground - bh, bw, bh);
      cx += bw + 2;
      b += 1;
    }
    ctx.fillStyle = "#b7ad9c";
    ctx.fillRect(x, y, w, 3);
  }

  function paintNewsprint() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#e4dccf";
    ctx.fillRect(0, 0, w, h);

    const cols = 7;
    const gutter = w * 0.01;
    const colW = (w - gutter * (cols + 1)) / cols;
    for (let c = 0; c < cols; c += 1) {
      const x = gutter + c * (colW + gutter);
      ctx.fillStyle = "rgba(110, 100, 88, 0.18)";
      ctx.fillRect(x + colW, h * 0.04, 1, h * 0.82);
      for (let y = h * 0.07; y < h * 0.86; y += 5) {
        if (hash(c * 40 + y) > 0.92) {
          y += 8;
          continue;
        }
        const lw = colW * (0.62 + hash(c * 80 + y) * 0.32);
        ctx.globalAlpha = 0.22 + hash(y + c) * 0.18;
        ctx.fillStyle = "#8f8678";
        ctx.fillRect(x + 3, y, lw, 1.05);
      }
      ctx.globalAlpha = 1;
      if (c === 0) drawSkyline(ctx, x + 4, h * 0.16, colW - 8, h * 0.2, 11);
      if (c === 6) drawSkyline(ctx, x + 4, h * 0.52, colW - 8, h * 0.2, 29);
      if (c === 3) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = "#7d7468";
        ctx.font = `700 ${Math.max(9, w * 0.013)}px serif`;
        ctx.fillText("Daily News", x, h * 0.055);
        ctx.globalAlpha = 1;
      }
    }
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatTime(f) {
    const sec = Math.min(DURATION / FPS, f / FPS);
    const total = DURATION / FPS;
    return `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))} / ${pad(
      Math.floor(total / 60)
    )}:${pad(Math.floor(total % 60))}`;
  }

  function applyFrame(f) {
    const wrapped = ((f % DURATION) + DURATION) % DURATION;
    let caption = SCENES[0].caption;

    SCENES.forEach((scene) => {
      const el = layerMap[scene.id];
      if (!el) return;
      const active = wrapped >= scene.from && wrapped < scene.to;
      el.classList.toggle("is-on", active);
      const tearStart = scene.to - TEAR;
      const tearing = active && wrapped >= tearStart;
      el.classList.toggle("is-exit", tearing);
      if (tearing) {
        el.style.clipPath = jaggedClip((wrapped - tearStart) / TEAR, scene.from);
      } else {
        el.style.clipPath = "";
      }
      if (active) caption = scene.caption;
    });

    const title = layerMap.title;
    if (title && title.classList.contains("is-on")) {
      const local = wrapped - 30;
      const a = title.querySelector("[data-type='a']");
      const b = title.querySelector("[data-type='b']");
      const comma = title.querySelector(".comma");
      if (a) a.style.opacity = local > 10 ? "1" : "0";
      if (comma) comma.style.opacity = local > 18 ? "1" : "0";
      if (b) b.style.opacity = local > 22 ? "1" : "0";
    }

    captionEl.textContent = caption;
    scrub.value = String(wrapped);
    clock.textContent = formatTime(wrapped);
    framesEl.textContent = `第 ${wrapped} 帧`;
  }

  function setPlaying(next) {
    playing = next;
    playBtn.textContent = playing ? "暂停" : "播放";
    playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
    playBtn.setAttribute("aria-label", playing ? "暂停" : "播放");
  }

  function tick(ts) {
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    if (playing) {
      leftover += dt;
      const step = 1000 / FPS;
      while (leftover >= step) {
        leftover -= step;
        frame += 1;
        if (frame >= DURATION) {
          if (loopEl.checked) frame = 0;
          else {
            frame = DURATION - 1;
            setPlaying(false);
          }
        }
      }
      applyFrame(frame);
    }
    requestAnimationFrame(tick);
  }

  playBtn.addEventListener("click", () => setPlaying(!playing));
  replayBtn.addEventListener("click", () => {
    frame = 0;
    leftover = 0;
    applyFrame(frame);
    setPlaying(true);
  });
  scrub.addEventListener("input", () => {
    frame = Number(scrub.value);
    leftover = 0;
    applyFrame(frame);
  });
  stage.addEventListener("click", (event) => {
    if (event.target.closest("a, button, input, label")) return;
    setPlaying(!playing);
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      setPlaying(!playing);
    } else if (event.key === "ArrowRight") {
      frame = Math.min(DURATION - 1, frame + 5);
      applyFrame(frame);
    } else if (event.key === "ArrowLeft") {
      frame = Math.max(0, frame - 5);
      applyFrame(frame);
    }
  });

  const ro = new ResizeObserver(paintNewsprint);
  ro.observe(stage);
  paintNewsprint();
  applyFrame(reduce ? 90 : 0);
  if (reduce) setPlaying(false);
  requestAnimationFrame(tick);
})();
