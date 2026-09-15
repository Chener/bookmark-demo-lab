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
      to: 282,
      caption: "今天就把整体的剪辑思路拆给你，一共就 6 步。",
    },
    {
      id: "static-first",
      from: 264,
      to: 384,
      caption: "先确认静态构图，再做视频，效果才稳。",
    },
    {
      id: "strips",
      from: 366,
      to: 468,
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
    const steps = 26;
    const xBase = progress * 118 - 8;
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const y = (i / steps) * 100;
      const jag =
        Math.sin(i * 1.63 + seed) * 3.4 +
        (hash(i * 19 + seed * 7) - 0.5) * 4.2;
      pts.push(`${(xBase + jag).toFixed(2)}% ${y.toFixed(2)}%`);
    }
    return `polygon(120% -4%, 120% 104%, ${pts.reverse().join(",")})`;
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
    ctx.fillStyle = "#e6dfd2";
    ctx.fillRect(0, 0, w, h);

    const cols = 6;
    const gutter = w * 0.012;
    const colW = (w - gutter * (cols + 1)) / cols;
    ctx.fillStyle = "#cfc6b6";
    for (let c = 0; c < cols; c += 1) {
      const x = gutter + c * (colW + gutter);
      ctx.fillRect(x + colW, 0, 1, h);
      for (let y = h * 0.08; y < h * 0.96; y += 7) {
        const lw = colW * (0.55 + hash(c * 80 + y) * 0.4);
        ctx.globalAlpha = 0.28 + hash(y + c) * 0.2;
        ctx.fillRect(x + 4, y, lw, 1.2);
      }
      ctx.globalAlpha = 1;
      if (c === 0 || c === 5) {
        const bx = x + 6;
        const by = h * (c === 0 ? 0.18 : 0.58);
        const bw = colW - 12;
        const bh = h * 0.22;
        ctx.fillStyle = "#c3b9a8";
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = "#a89f90";
        ctx.beginPath();
        ctx.moveTo(bx + 8, by + bh - 12);
        ctx.lineTo(bx + bw * 0.35, by + bh * 0.45);
        ctx.lineTo(bx + bw * 0.62, by + bh - 18);
        ctx.lineTo(bx + bw - 6, by + bh - 8);
        ctx.lineTo(bx + bw - 6, by + bh - 4);
        ctx.lineTo(bx + 8, by + bh - 4);
        ctx.fill();
        ctx.fillStyle = "#cfc6b6";
      }
    }

    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#8a8174";
    ctx.font = `${Math.max(10, w * 0.018)}px serif`;
    ctx.fillText("Daily News", w * 0.08, h * 0.07);
    ctx.fillText("In Step with a Changing World", w * 0.62, h * 0.94);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "rgba(90,80,70,0.18)";
    ctx.beginPath();
    ctx.moveTo(w * 0.5, 0);
    ctx.lineTo(w * 0.5, h);
    ctx.stroke();
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
      if (a) a.style.opacity = local > 28 ? "1" : "0";
      if (comma) comma.style.opacity = local > 40 ? "1" : "0";
      if (b) b.style.opacity = local > 46 ? "1" : "0";
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
