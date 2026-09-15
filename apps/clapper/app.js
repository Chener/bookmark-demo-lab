(function () {
  var LAST = 179;
  var FPS = 30;
  var LINES = [
    [0, "写下这一镜。", "场次：开场"],
    [60, "配上这条槽。", "场次：论证"],
    [130, "拖着改，改完渲。", "场次：收束"]
  ];
  var SHEET_FRAMES = [0, 36, 72, 108, 144, 179];

  var scrub = document.getElementById("scrub");
  var hud = document.getElementById("hud");
  var heroHud = document.getElementById("hero-hud");
  var boardFrame = document.getElementById("board-frame");
  var playBtn = document.getElementById("toggle-play");
  var sheet = document.getElementById("sheet");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var playing = !reduce;
  var grabbed = false;
  var frame = 0;
  var acc = 0;
  var lastTs = 0;
  var thumbs = [];

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function pad(n, w) {
    return String(n).padStart(w, "0");
  }

  function lineAt(f) {
    var line = LINES[0];
    for (var i = 0; i < LINES.length; i++) if (f >= LINES[i][0]) line = LINES[i];
    return line;
  }

  function pose(f) {
    var t = ease(f / LAST);
    var x = lerp(70, 500, t);
    var hop = Math.abs(Math.sin((f / LAST) * Math.PI * 4)) * 110;
    var squash = f % 32 < 3 ? 0.8 : 1;
    var y = 250 - hop;
    var line = lineAt(f);
    return { x: x, y: y, hop: hop, squash: squash, line: line };
  }

  function applyActor(prefix, p) {
    var box = document.getElementById(prefix === "hero" ? "hero-box" : "box");
    var shadow = document.getElementById(prefix === "hero" ? "hero-shadow" : "shadow");
    var e1 = document.getElementById(prefix === "hero" ? "hero-eye-l" : "eye1");
    var e2 = document.getElementById(prefix === "hero" ? "hero-eye-r" : "eye2");
    if (!box) return;
    var w = prefix === "hero" ? 64 : 60;
    var h = prefix === "hero" ? 64 : 60;
    box.setAttribute("x", String(p.x));
    box.setAttribute("y", String(p.y));
    box.setAttribute(
      "transform",
      "translate(" + (p.x + w / 2) + " " + (p.y + h) + ") scale(" + (2 - p.squash) + " " + p.squash + ") translate(" + (-(p.x + w / 2)) + " " + (-(p.y + h)) + ")"
    );
    if (prefix === "hero") {
      var lid = document.getElementById("hero-lid");
      lid.setAttribute("x", String(p.x - 2));
      lid.setAttribute("y", String(p.y - 12));
      shadow.setAttribute("cx", String(p.x + 32));
      shadow.setAttribute("rx", String(42 - p.hop * 0.12));
      shadow.setAttribute("opacity", String(0.45 - p.hop / 420));
      e1.setAttribute("cx", String(p.x + 20));
      e1.setAttribute("cy", String(p.y + 26));
      e2.setAttribute("cx", String(p.x + 44));
      e2.setAttribute("cy", String(p.y + 26));
    } else {
      shadow.setAttribute("cx", String(p.x + 30));
      shadow.setAttribute("rx", String(40 - p.hop * 0.12));
      shadow.setAttribute("opacity", String(0.5 - p.hop / 400));
      e1.setAttribute("cx", String(p.x + 20));
      e1.setAttribute("cy", String(p.y + 22));
      e2.setAttribute("cx", String(p.x + 40));
      e2.setAttribute("cy", String(p.y + 22));
    }
  }

  function draw(f) {
    var p = pose(f);
    applyActor("demo", p);
    applyActor("hero", p);
    var cap = document.getElementById("cap");
    var sub = document.getElementById("sub");
    var heroLine = document.getElementById("hero-line");
    var heroSub = document.getElementById("hero-sub");
    cap.textContent = p.line[1];
    sub.textContent = p.line[2] + " · 局部帧 " + (f - p.line[0]);
    heroLine.textContent = p.line[1];
    heroSub.textContent = p.line[2] + " · 第 " + pad(f, 3) + " 帧";
    var clock = "第 " + pad(f, 3) + " 帧 · " + (f / FPS).toFixed(2) + " 秒";
    hud.textContent = clock;
    heroHud.textContent = clock;
    boardFrame.textContent = "f " + pad(f, 4);
    if (scrub && Number(scrub.value) !== f) scrub.value = String(f);
    thumbs.forEach(function (btn) {
      btn.classList.toggle("active", Number(btn.getAttribute("data-frame")) === f);
    });
  }

  function seek(next, pause) {
    frame = Math.max(0, Math.min(LAST, next));
    if (pause) playing = false;
    syncPlay();
    draw(frame);
  }

  function syncPlay() {
    playBtn.textContent = playing ? "暂停" : "播放";
    playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
  }

  playBtn.addEventListener("click", function () {
    playing = !playing;
    grabbed = false;
    syncPlay();
  });

  scrub.addEventListener("input", function () {
    grabbed = true;
    playing = false;
    syncPlay();
    seek(Number(scrub.value), true);
  });
  scrub.addEventListener("pointerup", function () { grabbed = false; });
  scrub.addEventListener("pointercancel", function () { grabbed = false; });

  function tick(ts) {
    if (!lastTs) lastTs = ts;
    var dt = Math.min(48, ts - lastTs);
    lastTs = ts;
    if (playing && !grabbed) {
      acc += dt;
      var step = 1000 / FPS;
      while (acc >= step) {
        acc -= step;
        frame = (frame + 1) % (LAST + 1);
      }
      draw(frame);
    }
    requestAnimationFrame(tick);
  }

  function miniSvg(f) {
    var p = pose(f);
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 640 360");
    svg.setAttribute("aria-hidden", "true");
    function el(tag, attrs) {
      var node = document.createElementNS(ns, tag);
      Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
      return node;
    }
    svg.appendChild(el("rect", { width: "640", height: "360", fill: "#141311" }));
    svg.appendChild(el("line", { x1: "40", y1: "300", x2: "600", y2: "300", stroke: "#3a3730", "stroke-width": "2" }));
    svg.appendChild(el("ellipse", {
      cx: String(p.x + 30), cy: "300", rx: String(40 - p.hop * 0.12), ry: "8",
      fill: "#000", opacity: String(0.5 - p.hop / 400)
    }));
    svg.appendChild(el("rect", {
      x: String(p.x), y: String(p.y), width: "60", height: "60", rx: "12", fill: "#f1c95a"
    }));
    var label = el("text", {
      x: "28", y: "48", fill: "#f6f1e6", "font-size": "28", "font-family": "Noto Serif SC, serif", "font-weight": "700"
    });
    label.textContent = p.line[1];
    svg.appendChild(label);
    return svg;
  }

  SHEET_FRAMES.forEach(function (f) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb";
    btn.setAttribute("data-frame", String(f));
    btn.appendChild(miniSvg(f));
    var cap = document.createElement("span");
    cap.className = "thumb-cap";
    cap.textContent = "第 " + pad(f, 3) + " 帧";
    btn.appendChild(cap);
    btn.addEventListener("click", function () { seek(f, true); });
    sheet.appendChild(btn);
    thumbs.push(btn);
  });

  var names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var phrase = ["C5", "D5", "E5", "G5", "A5", "G5", "E5", "D5"];
  function midi(n) {
    var m = /^([A-G]#?)(\d)$/.exec(n);
    return names.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
  }
  var roll = document.getElementById("roll");
  var lo = 71, hi = 82, W = 520, H = 220, left = 44, top = 10;
  var rowH = (H - 30) / (hi - lo + 1);
  var beatW = (W - left - 10) / 4;
  var ns = "http://www.w3.org/2000/svg";
  function el(tag, attrs) {
    var node = document.createElementNS(ns, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }
  for (var pitch = hi; pitch >= lo; pitch--) {
    var yy = top + (hi - pitch) * rowH;
    var black = names[pitch % 12].indexOf("#") > -1;
    roll.appendChild(el("rect", {
      x: String(left), y: String(yy), width: String(W - left - 10), height: String(rowH),
      fill: black ? "#efe6d6" : "#fffaf1"
    }));
    if (!black) {
      var tl = el("text", {
        x: "6", y: String(yy + rowH * 0.72),
        "font-family": "ui-monospace, Menlo, monospace", "font-size": "10", fill: "#6d665b"
      });
      tl.textContent = names[pitch % 12] + (Math.floor(pitch / 12) - 1);
      roll.appendChild(tl);
    }
  }
  for (var b = 0; b <= 4; b++) {
    roll.appendChild(el("line", {
      x1: String(left + b * beatW), y1: String(top),
      x2: String(left + b * beatW), y2: String(top + (hi - lo + 1) * rowH),
      stroke: b % 2 === 0 ? "#b9b3a4" : "#e6e1d4",
      "stroke-width": b % 2 === 0 ? "2" : "1"
    }));
  }
  phrase.forEach(function (n, i) {
    var m = midi(n);
    var yy = top + (hi - m) * rowH;
    roll.appendChild(el("rect", {
      x: String(left + i * (beatW / 2) + 1),
      y: String(yy + 1),
      width: String(beatW / 2 - 2),
      height: String(rowH - 2),
      rx: "3",
      fill: i < 4 ? "#b23a2c" : "#2f6b5c"
    }));
  });
  var lbl = el("text", {
    x: String(left), y: String(H - 4),
    "font-family": "ui-monospace, Menlo, monospace", "font-size": "10", fill: "#6d665b"
  });
  lbl.textContent = 'phrase("C5 D5 E5 G5 A5 G5 E5 D5")';
  roll.appendChild(lbl);

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var was = btn.textContent;
      function done(ok) {
        btn.textContent = ok ? "已复制" : "复制失败";
        setTimeout(function () { btn.textContent = was; }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  });

  syncPlay();
  draw(0);
  requestAnimationFrame(tick);
})();
