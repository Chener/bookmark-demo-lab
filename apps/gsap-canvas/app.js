(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = typeof window.gsap === "function";

  const pinSteps = [
    {
      idx: "01",
      word: "设计",
      copy: "先把页面设计好。给它一个想法、一张截图或参考站，围绕需求探索方案，再做成可交互原型。",
      kicker: "Product Design",
      title: "探索方案",
    },
    {
      idx: "02",
      word: "节奏",
      copy: "滚动时文字逐步出现、画面跟着切换、内容钉住后展开。GSAP 把转场编成一条可感知的时间线。",
      kicker: "GSAP Motion",
      title: "钉住再展开",
    },
    {
      idx: "03",
      word: "冲击",
      copy: "流体、玻璃、粒子——画布特效压在真实 HTML 上，按钮和链接仍可点。冲击力是最后一层，不是整页的替代。",
      kicker: "Canvas UI",
      title: "叠上冲击力",
    },
  ];

  if (hasGsap) {
    const plugins = [window.ScrollTrigger, window.MotionPathPlugin].filter(Boolean);
    if (plugins.length) gsap.registerPlugin(...plugins);
  }

  function splitChars(el) {
    const text = el.textContent || "";
    el.textContent = "";
    [...text].forEach((ch) => {
      const span = document.createElement("span");
      span.className = "ch";
      span.textContent = ch === " " ? "\u00a0" : ch;
      el.appendChild(span);
    });
  }

  function initIntro() {
    document.querySelectorAll("[data-split]").forEach(splitChars);
    if (!hasGsap || reduced) return;

    gsap.from(".hero .ch", {
      yPercent: 110,
      opacity: 0,
      rotateX: -50,
      duration: 1.05,
      stagger: 0.035,
      ease: "power4.out",
    });
    gsap.from(".lede, .hero-actions, .kicker", {
      y: 16,
      opacity: 0,
      duration: 0.8,
      delay: 0.35,
      stagger: 0.08,
      ease: "power2.out",
    });

    if (window.MotionPathPlugin) {
      gsap.to("[data-cursor]", {
        motionPath: {
          path: "#orbit-path",
          align: "#orbit-path",
          alignOrigin: [0.18, 0.08],
          autoRotate: false,
        },
        duration: 7.5,
        repeat: -1,
        ease: "none",
      });
      gsap.to(".handle", {
        scale: 1.18,
        transformOrigin: "center",
        yoyo: true,
        repeat: -1,
        duration: 1.2,
        stagger: 0.2,
        ease: "sine.inOut",
      });
      gsap.fromTo(
        "#orbit-path",
        { strokeDasharray: 1200, strokeDashoffset: 1200 },
        { strokeDashoffset: 0, duration: 1.8, ease: "power2.inOut" }
      );
    }
  }

  function initPin() {
    const word = document.querySelector("[data-pin-word]");
    const copy = document.querySelector("[data-pin-copy]");
    const idx = document.querySelector("[data-pin-idx]");
    const kicker = document.querySelector("[data-pin-kicker]");
    const title = document.querySelector("[data-pin-title]");
    const beats = [...document.querySelectorAll("[data-beats] li")];
    const scrub = document.querySelector("[data-scrub]");
    const stage = document.querySelector(".pin-stage");
    if (!word || !stage) return;

    let current = 0;
    const apply = (i, animate) => {
      if (i === current && animate) return;
      current = i;
      const step = pinSteps[i];
      const paint = () => {
        idx.textContent = step.idx;
        word.textContent = step.word;
        copy.textContent = step.copy;
        kicker.textContent = step.kicker;
        title.textContent = step.title;
        beats.forEach((el, n) => el.classList.toggle("is-on", n === i));
        if (scrub && !animate) scrub.style.width = `${((i + 1) / 3) * 100}%`;
      };
      if (!hasGsap || reduced || !animate) {
        paint();
        return;
      }
      gsap.to([word, copy, title], {
        opacity: 0,
        y: 12,
        duration: 0.18,
        overwrite: true,
        onComplete: () => {
          paint();
          gsap.fromTo(
            [word, copy, title],
            { opacity: 0, y: -10 },
            { opacity: 1, y: 0, duration: 0.35, stagger: 0.04, ease: "power2.out" }
          );
        },
      });
    };

    document.querySelectorAll("[data-beat]").forEach((btn) => {
      btn.addEventListener("click", () => apply(Number(btn.dataset.beat), true));
    });

    apply(0, false);
    if (!hasGsap || reduced || !window.ScrollTrigger) return;

    const desktop = window.matchMedia("(min-width: 821px)");
    const mountPin = () => {
      if (!desktop.matches) return null;
      return ScrollTrigger.create({
        trigger: stage,
        start: "top 88px",
        end: "+=320%",
        pin: true,
        pinSpacing: true,
        scrub: 0.65,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const i = Math.min(2, Math.floor(self.progress * 0.999 * 3));
          apply(i, true);
          if (scrub) scrub.style.width = `${Math.round(self.progress * 100)}%`;
        },
      });
    };

    let pin = mountPin();
    desktop.addEventListener("change", () => {
      pin?.kill();
      pin = mountPin();
      ScrollTrigger.refresh();
    });
    requestAnimationFrame(() => ScrollTrigger.refresh());
  }

  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return { w: canvas.width, h: canvas.height, dpr, cssW: w, cssH: h };
  }

  const palettes = [
    ["rgba(37,99,235,0.95)", "rgba(34,197,94,0.9)", "rgba(125,211,252,0.85)"],
    ["rgba(244,114,182,0.95)", "rgba(251,191,36,0.9)", "rgba(249,115,22,0.85)"],
    ["rgba(167,139,250,0.95)", "rgba(34,211,238,0.9)", "rgba(52,211,153,0.85)"],
  ];

  function fadeRgba(color, alpha) {
    return color.replace(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
  }

  function initLiquid() {
    const canvas = document.querySelector("[data-liquid]");
    const frame = document.querySelector("[data-liquid-frame]");
    if (!canvas || !frame) return;
    const ctx = canvas.getContext("2d");
    const off = document.createElement("canvas");
    const octx = off.getContext("2d");
    const pointer = { x: 0.5, y: 0.45, tx: 0.5, ty: 0.45, inside: false };
    let palette = 0;
    let running = true;
    const blobs = Array.from({ length: 8 }, (_, i) => ({
      x: 0.5,
      y: 0.5,
      vx: 0,
      vy: 0,
      r: 0.09 + (i % 4) * 0.025,
      phase: i * 0.85,
    }));

    const setPointer = (event) => {
      const r = frame.getBoundingClientRect();
      pointer.tx = (event.clientX - r.left) / r.width;
      pointer.ty = (event.clientY - r.top) / r.height;
      pointer.inside = true;
    };
    frame.addEventListener("pointermove", setPointer);
    frame.addEventListener("pointerleave", () => { pointer.inside = false; });
    document.querySelectorAll("[data-palette]").forEach((btn) => {
      btn.addEventListener("click", () => { palette = (palette + 1) % palettes.length; });
    });

    const io = new IntersectionObserver((entries) => {
      running = entries.some((e) => e.isIntersecting);
    }, { threshold: 0.05 });
    io.observe(frame);

    let t = 0;
    const drawLens = (target, x, y, rad, src) => {
      target.save();
      target.beginPath();
      target.arc(x, y, rad, 0, Math.PI * 2);
      target.clip();
      const mag = 1.22;
      target.drawImage(
        src,
        x - rad * mag,
        y - rad * mag,
        rad * mag * 2,
        rad * mag * 2,
        x - rad,
        y - rad,
        rad * 2,
        rad * 2
      );
      target.restore();

      target.save();
      target.strokeStyle = "rgba(255,255,255,0.62)";
      target.lineWidth = Math.max(2, rad * 0.03);
      target.beginPath();
      target.arc(x, y, rad, 0, Math.PI * 2);
      target.stroke();
      target.strokeStyle = "rgba(255,255,255,0.9)";
      target.lineWidth = Math.max(2, rad * 0.035);
      target.beginPath();
      target.arc(x, y, rad * 0.86, -Math.PI * 0.95, -Math.PI * 0.5);
      target.stroke();
      const glare = target.createRadialGradient(x - rad * 0.28, y - rad * 0.32, 2, x, y, rad);
      glare.addColorStop(0, "rgba(255,255,255,0.28)");
      glare.addColorStop(0.45, "rgba(180,210,255,0.06)");
      glare.addColorStop(1, "rgba(0,0,0,0)");
      target.fillStyle = glare;
      target.beginPath();
      target.arc(x, y, rad, 0, Math.PI * 2);
      target.fill();
      target.restore();
    };

    const tick = () => {
      if (running) {
        const { w, h } = fitCanvas(canvas);
        off.width = w;
        off.height = h;
        t += 1;
        pointer.x += (pointer.tx - pointer.x) * 0.12;
        pointer.y += (pointer.ty - pointer.y) * 0.12;
        octx.clearRect(0, 0, w, h);
        octx.fillStyle = "#07090f";
        octx.fillRect(0, 0, w, h);
        const colors = palettes[palette];
        blobs.forEach((b, i) => {
          const idleX = 0.38 + (i % 4) * 0.08 + Math.cos(t / 70 + b.phase) * 0.2;
          const idleY = 0.42 + Math.sin(t / 80 + b.phase * 1.1) * 0.16;
          const follow = pointer.inside ? (0.18 + (i % 5) * 0.12) : 0;
          const tx = idleX * (1 - follow) + pointer.x * follow;
          const ty = idleY * (1 - follow) + pointer.y * follow;
          b.vx += (tx - b.x) * 0.04;
          b.vy += (ty - b.y) * 0.04;
          b.vx *= 0.9;
          b.vy *= 0.9;
          b.x += b.vx;
          b.y += b.vy;
          const cx = b.x * w;
          const cy = b.y * h;
          const rad = b.r * Math.min(w, h) * 2.1;
          const g = octx.createRadialGradient(cx, cy, 0, cx, cy, rad);
          g.addColorStop(0, colors[i % colors.length]);
          g.addColorStop(0.42, fadeRgba(colors[i % colors.length], 0.32));
          g.addColorStop(1, "rgba(0,0,0,0)");
          octx.globalCompositeOperation = "screen";
          octx.fillStyle = g;
          octx.beginPath();
          octx.arc(cx, cy, rad, 0, Math.PI * 2);
          octx.fill();
        });
        octx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(off, 0, 0);
        const lensR = Math.min(w, h) * 0.16;
        drawLens(ctx, pointer.x * w, pointer.y * h, lensR, off);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const words = ["设计", "节奏", "冲击"];

  function sampleWord(text) {
    const off = document.createElement("canvas");
    const octx = off.getContext("2d");
    const w = 720;
    const h = 300;
    off.width = w;
    off.height = h;
    octx.clearRect(0, 0, w, h);
    octx.fillStyle = "#fff";
    octx.font = "700 168px 'Noto Sans SC', 'PingFang SC', sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.fillText(text, w / 2, h / 2 + 8);
    const data = octx.getImageData(0, 0, w, h).data;
    const pts = [];
    const gap = 3;
    for (let y = 0; y < h; y += gap) {
      for (let x = 0; x < w; x += gap) {
        if (data[(y * w + x) * 4 + 3] > 80) {
          pts.push({ ox: x / w, oy: y / h });
        }
      }
    }
    return pts;
  }

  function initReveal() {
    const canvas = document.querySelector("[data-reveal]");
    const frame = document.querySelector("[data-reveal-frame]");
    if (!canvas || !frame) return;
    const ctx = canvas.getContext("2d");
    const pointer = { x: 0.5, y: 0.5, active: false };
    let running = true;
    let wordIndex = 0;
    const label = document.querySelector("[data-word-label]");
    let particles = [];

    const spawn = (text) => {
      const pts = sampleWord(text);
      const prev = particles;
      particles = pts.map((p, i) => {
        const old = prev.length ? prev[i % prev.length] : null;
        return {
          ox: p.ox,
          oy: p.oy,
          x: old ? old.x : p.ox + (Math.random() - 0.5) * 0.08,
          y: old ? old.y : p.oy + (Math.random() - 0.5) * 0.08,
          vx: 0,
          vy: 0,
          seed: i,
        };
      });
      if (label) label.textContent = text;
    };

    const boot = () => spawn(words[wordIndex]);
    boot();
    if (document.fonts?.ready) document.fonts.ready.then(boot);

    frame.addEventListener("pointermove", (event) => {
      const r = frame.getBoundingClientRect();
      pointer.x = (event.clientX - r.left) / r.width;
      pointer.y = (event.clientY - r.top) / r.height;
      pointer.active = true;
    });
    frame.addEventListener("pointerleave", () => { pointer.active = false; });
    document.querySelectorAll("[data-next-word]").forEach((btn) => {
      btn.addEventListener("click", () => {
        wordIndex = (wordIndex + 1) % words.length;
        spawn(words[wordIndex]);
      });
    });

    const io = new IntersectionObserver((entries) => {
      running = entries.some((e) => e.isIntersecting);
    }, { threshold: 0.05 });
    io.observe(frame);

    const tick = () => {
      if (running) {
        const { w, h, dpr } = fitCanvas(canvas);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#10141c";
        ctx.fillRect(0, 0, w, h);
        const radius = 0.18;
        const size = Math.max(2, 2.4 * dpr);
        particles.forEach((p) => {
          const dist = Math.hypot(p.ox - pointer.x, p.oy - pointer.y);
          const near = pointer.active ? Math.max(0, 1 - dist / radius) : 0.55;
          const home = 0.12 + near * 0.22;
          p.vx += (p.ox - p.x) * home;
          p.vy += (p.oy - p.y) * home;
          if (near < 0.2) {
            p.vx += Math.sin(p.seed + p.x * 12) * 0.0009;
            p.vy += Math.cos(p.seed + p.y * 10) * 0.0009;
          }
          p.vx *= 0.84;
          p.vy *= 0.84;
          p.x += p.vx;
          p.y += p.vy;
          const settled = 1 - Math.min(1, Math.hypot(p.x - p.ox, p.y - p.oy) * 8);
          const g = Math.round(150 + settled * 90);
          ctx.fillStyle = `rgba(${g}, ${g + 18}, ${255}, ${0.4 + settled * 0.6})`;
          ctx.fillRect(p.x * w, p.y * h, size, size);
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  initIntro();
  initPin();
  initLiquid();
  initReveal();
})();
