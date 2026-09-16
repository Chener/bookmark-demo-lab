(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var TRACKS = ["a-roll", "b-roll", "caption", "sfx"];
  var TRACK_ZH = { "a-roll": "A-roll", "b-roll": "B-roll", caption: "字幕", sfx: "音效" };
  var COLORS = {
    "a-roll": "#5ce1e6",
    "b-roll": "#ff5ca8",
    caption: "#c6ff6a",
    sfx: "#f5c542"
  };

  var PRESETS = {
    rank: {
      prompt: "/hypit 做一条 18 秒竖屏榜单，把 Hypit 排进 S 档，剪映手搓和抽卡黑盒掉到 D。",
      source:
        "composition rank {\n" +
        "  duration 18s\n" +
        "  ratio 9:16\n" +
        "  caption karaoke word-anchor\n" +
        "}\n\n" +
        "on \"今天给工具排个榜\" {\n" +
        "  a-roll presenter\n" +
        "  graphic board\n" +
        "}\n" +
        "on \"剪映手搓\" {\n" +
        "  b-roll nle-mess\n" +
        "  stamp D\n" +
        "}\n" +
        "on \"抽卡黑盒\" {\n" +
        "  b-roll gacha\n" +
        "  stamp D\n" +
        "}\n" +
        "on \"脚本编译成时间线\" {\n" +
        "  a-roll presenter\n" +
        "  stamp S on Hypit\n" +
        "}\n"
    },
    cast: {
      prompt: "/hypit 做一条 16 秒播客切片：主持逼问助手，为什么视频还要人手对时间码。",
      source:
        "composition podcast {\n" +
        "  duration 16s\n" +
        "  layout split-screen\n" +
        "}\n\n" +
        "on \"你还在拖时间线？\" {\n" +
        "  a-roll host\n" +
        "  caption speaker-aware\n" +
        "}\n" +
        "on \"Agent 对不准帧号\" {\n" +
        "  a-roll guest\n" +
        "  b-roll timecode\n" +
        "}\n" +
        "on \"把画面绑在词上\" {\n" +
        "  a-roll host\n" +
        "  sfx sting\n" +
        "}\n"
    },
    street: {
      prompt: "/hypit 模仿街头采访结构：三条规矩，竖屏节奏，角色换成两只银猫。",
      source:
        "composition street {\n" +
        "  duration 20s\n" +
        "  ratio 9:16\n" +
        "  reveal three-rules\n" +
        "}\n\n" +
        "on \"第一条，别手搓\" {\n" +
        "  a-roll cat-a\n" +
        "  graphic rule-1\n" +
        "}\n" +
        "on \"第二条，别抽卡\" {\n" +
        "  a-roll cat-b\n" +
        "  graphic rule-2\n" +
        "}\n" +
        "on \"第三条，编译再导出\" {\n" +
        "  a-roll both\n" +
        "  sfx pop\n" +
        "}\n"
    }
  };

  var els = {
    prompt: document.getElementById("prompt"),
    source: document.getElementById("source"),
    ir: document.getElementById("ir"),
    log: document.getElementById("log"),
    tracks: document.getElementById("tracks"),
    ruler: document.getElementById("ruler"),
    screen: document.getElementById("screen"),
    canvas: document.getElementById("frame"),
    cap: document.getElementById("cap"),
    word: document.getElementById("word"),
    clock: document.getElementById("clock"),
    scrub: document.getElementById("scrub"),
    play: document.querySelector("[data-play]"),
    bar: document.getElementById("bar"),
    receipt: document.getElementById("receipt"),
    scriptStatus: document.querySelector("[data-script-status]"),
    tlMeta: document.querySelector("[data-tl-meta]"),
    progress: document.querySelector(".progress")
  };
  var ctx = els.canvas.getContext("2d");

  var state = {
    preset: "rank",
    program: null,
    t: 0,
    playing: false,
    busy: false,
    lastTs: 0,
    selected: null
  };

  function pad(n, w) {
    return String(n).padStart(w, "0");
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }

  function parseSource(src) {
    var durationMatch = /duration\s+(\d+(?:\.\d+)?)s/.exec(src);
    var blocks = [];
    var re = /on\s+"([^"]+)"\s*\{([^}]*)\}/g;
    var m;
    while ((m = re.exec(src))) {
      var body = m[2];
      var tracks = [];
      if (/a-roll/.test(body)) tracks.push("a-roll");
      if (/b-roll|graphic/.test(body)) tracks.push("b-roll");
      if (/caption/.test(body) || true) tracks.push("caption");
      if (/sfx|stamp/.test(body)) tracks.push("sfx");
      var stamp = (/\bstamp\s+(\S+)/.exec(body) || [])[1] || "";
      blocks.push({
        word: m[1],
        tracks: tracks,
        stamp: stamp.replace(/on.*/, "").trim(),
        visual: ((/a-roll\s+(\S+)/.exec(body) || [])[1] || ( /b-roll\s+(\S+)/.exec(body) || [])[1] || "presenter")
      });
    }
    if (!blocks.length) {
      src.split(/[\n。！？]/).map(function (line) {
        return line.replace(/[#{}]/g, " ").trim();
      }).filter(function (line) {
        return line && !/^composition\b/.test(line) && !/^(duration|ratio|caption|layout|reveal)\b/.test(line);
      }).forEach(function (line) {
        blocks.push({
          word: line.slice(0, 18),
          tracks: ["a-roll", "caption"],
          stamp: "",
          visual: "presenter"
        });
      });
    }
    var n = Math.max(blocks.length, 1);
    var total = durationMatch ? Number(durationMatch[1]) : Math.max(12, n * 4.2);
    var cursor = 0;
    var clips = [];
    blocks.forEach(function (b, i) {
      var dur = total / n;
      var start = cursor;
      cursor += dur;
      b.tracks.forEach(function (track) {
        clips.push({
          id: track + "-" + i,
          track: track,
          label: track === "caption" ? b.word : (b.stamp ? "戳 " + b.stamp : b.visual),
          word: b.word,
          start: start,
          dur: dur * (track === "sfx" ? 0.35 : track === "b-roll" ? 0.78 : 1),
          offset: track === "sfx" ? dur * 0.55 : track === "b-roll" ? dur * 0.12 : 0,
          stamp: b.stamp,
          hue: (i * 47 + (track === "b-roll" ? 80 : 0)) % 360
        });
      });
    });
    return {
      duration: total,
      words: blocks.map(function (b) { return b.word; }),
      clips: clips,
      ir:
        "WORD-IR  duration=" + total.toFixed(1) + "s  units=" + blocks.length + "\n" +
        blocks.map(function (b, i) {
          return pad(i, 2) + "  " + JSON.stringify(b.word) + "\n    tracks: " + b.tracks.join(", ") +
            (b.stamp ? "\n    stamp: " + b.stamp : "") +
            "\n    bind: word-anchor  (not timecode)";
        }).join("\n")
    };
  }

  function setStage(id, opts) {
    opts = opts || {};
    document.querySelectorAll("[data-stage]").forEach(function (btn) {
      var on = btn.dataset.stage === id;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (opts.scroll) {
      var map = { script: ".script-pane", compile: ".compile-pane", timeline: ".timeline", export: ".export" };
      var node = document.querySelector(map[id] || ".script-pane");
      if (node) node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
  }

  function logLine(text, kind) {
    var li = document.createElement("li");
    if (kind) li.className = kind;
    li.textContent = text;
    els.log.append(li);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clearLog() {
    els.log.replaceChildren();
  }

  function renderRuler(duration) {
    els.ruler.replaceChildren();
    var steps = 6;
    for (var i = 0; i < steps; i += 1) {
      var span = document.createElement("span");
      span.textContent = (duration * i / (steps - 1)).toFixed(1) + "s";
      els.ruler.append(span);
    }
  }

  function renderTracks(program) {
    els.tracks.replaceChildren();
    TRACKS.forEach(function (track) {
      var row = document.createElement("div");
      row.className = "track";
      var label = document.createElement("b");
      label.textContent = TRACK_ZH[track];
      var lane = document.createElement("div");
      lane.className = "lane";
      lane.dataset.track = track;
      program.clips.filter(function (c) { return c.track === track; }).forEach(function (clip) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "clip";
        btn.textContent = clip.label;
        btn.title = clip.word;
        btn.style.left = ((clip.start + clip.offset) / program.duration * 100) + "%";
        btn.style.width = (clip.dur / program.duration * 100) + "%";
        btn.style.background = COLORS[track];
        btn.addEventListener("click", function () {
          state.selected = clip.id;
          seek(clip.start + clip.offset, true);
          highlightClips();
        });
        btn.dataset.id = clip.id;
        lane.append(btn);
      });
      var head = document.createElement("div");
      head.className = "head";
      lane.append(head);
      row.append(label, lane);
      els.tracks.append(row);
    });
    renderRuler(program.duration);
  }

  function highlightClips() {
    document.querySelectorAll(".clip").forEach(function (btn) {
      btn.classList.toggle("is-on", btn.dataset.id === state.selected);
    });
  }

  function activeAt(t) {
    if (!state.program) return null;
    var hits = state.program.clips.filter(function (c) {
      return t >= c.start + c.offset && t < c.start + c.offset + c.dur;
    });
    return hits.sort(function (a, b) { return (a.track === "caption" ? 1 : 0) - (b.track === "caption" ? 1 : 0); })[0] || null;
  }

  function drawFrame(t) {
    var w = els.canvas.width;
    var h = els.canvas.height;
    var clip = activeAt(t);
    ctx.fillStyle = "#11141c";
    ctx.fillRect(0, 0, w, h);
    var hue = clip ? clip.hue : 200;
    ctx.fillStyle = "hsl(" + hue + " 70% 38%)";
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.42, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(8,10,16,0.35)";
    ctx.fillRect(18, 36, w - 36, 88);
    ctx.fillStyle = "#e8edf7";
    ctx.font = "700 22px Noto Sans SC, sans-serif";
    ctx.fillText(clip && clip.stamp ? clip.stamp : "HYPIT", 28, 92);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, h - 92, w, 92);
    els.cap.textContent = clip ? clip.word : "未挂载时间线";
    els.word.textContent = clip ? (clip.track + " · " + clip.label) : "compile first";
    var ratio = state.program ? t / state.program.duration : 0;
    document.querySelectorAll(".head").forEach(function (head) {
      head.style.left = (Math.min(1, Math.max(0, ratio)) * 100) + "%";
    });
    els.clock.textContent = t.toFixed(1) + "s";
    if (state.program && Number(els.scrub.value) !== Math.round(t * 10)) {
      els.scrub.value = String(Math.round(t * 10));
    }
  }

  function seek(next, pause) {
    var dur = state.program ? state.program.duration : 18;
    state.t = Math.max(0, Math.min(dur, next));
    if (pause) {
      state.playing = false;
      syncPlay();
    }
    drawFrame(state.t);
  }

  function syncPlay() {
    els.play.textContent = state.playing ? "暂停" : "播放";
    els.play.setAttribute("aria-pressed", state.playing ? "true" : "false");
  }

  function applyProgram(program, note) {
    state.program = program;
    state.t = 0;
    state.selected = program.clips[0] ? program.clips[0].id : null;
    els.ir.textContent = program.ir;
    els.scrub.max = String(Math.round(program.duration * 10));
    els.scriptStatus.textContent = note || ("已编译 · " + program.words.length + " 个词锚点");
    els.tlMeta.textContent = program.duration.toFixed(1) + "s · " + program.clips.length + " 个片段 · 词锚定，不是时间码";
    renderTracks(program);
    highlightClips();
    drawFrame(0);
    document.querySelectorAll("[data-stage]").forEach(function (btn) {
      var id = btn.dataset.stage;
      btn.classList.toggle("is-done", id === "script" || id === "compile" || id === "timeline");
    });
  }

  function compileNow() {
    var program = parseSource(els.source.value);
    clearLog();
    logLine("lex  词块 " + program.words.length, "ok");
    logLine("bind 画面 ← 词，而不是帧号", "ok");
    logLine("lower 四条轨道：" + TRACKS.join(" / "), "ok");
    logLine("skip  ffmpeg / 模型抽卡（玩具板）", "warn");
    applyProgram(program);
    setStage("compile");
    return program;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, reduced ? 0 : ms);
    });
  }

  function markBusy(id, on) {
    document.querySelectorAll("[data-stage]").forEach(function (btn) {
      btn.classList.toggle("is-busy", on && btn.dataset.stage === id);
    });
  }

  async function runPipeline() {
    if (state.busy) return;
    state.busy = true;
    els.receipt.hidden = true;
    document.querySelector("[data-run]").disabled = true;
    setStage("script", { scroll: true });
    markBusy("script", true);
    logLine("ingest 提示台", "ok");
    await wait(420);
    markBusy("script", false);
    setStage("compile");
    markBusy("compile", true);
    compileNow();
    await wait(520);
    markBusy("compile", false);
    setStage("timeline", { scroll: true });
    markBusy("timeline", true);
    state.playing = !reduced;
    syncPlay();
    await wait(720);
    markBusy("timeline", false);
    setStage("export", { scroll: true });
    document.querySelector("[data-run]").disabled = false;
    state.busy = false;
  }

  function fakeHash(program) {
    return "sim-" + hashStr(program.ir + program.duration);
  }

  async function exportSim() {
    if (!state.program) compileNow();
    var program = state.program;
    els.progress.hidden = false;
    els.receipt.hidden = true;
    setStage("export", { scroll: true });
    var start = performance.now();
    var dur = reduced ? 0 : 900;
    await new Promise(function (resolve) {
      function tick(now) {
        var p = dur ? Math.min(1, (now - start) / dur) : 1;
        els.bar.style.width = Math.round(p * 100) + "%";
        seek(p * program.duration, true);
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    document.getElementById("receipt-file").textContent = "hypit-demo.mp4";
    document.querySelector("[data-r-dur]").textContent = program.duration.toFixed(1) + "s";
    document.querySelector("[data-r-clips]").textContent = String(program.clips.length);
    document.querySelector("[data-r-words]").textContent = String(program.words.length);
    document.querySelector("[data-r-hash]").textContent = "digest  " + fakeHash(program) + "  ·  mux skipped";
    els.receipt.hidden = false;
    logLine("export 模拟收据已开，未写文件", "warn");
    document.querySelector('[data-stage="export"]').classList.add("is-done");
  }

  function loadPreset(id) {
    var p = PRESETS[id] || PRESETS.rank;
    state.preset = id;
    document.querySelectorAll("[data-preset]").forEach(function (btn) {
      btn.classList.toggle("is-on", btn.dataset.preset === id);
    });
    els.prompt.value = p.prompt;
    els.source.value = p.source;
    els.scriptStatus.textContent = "已载入样例，等待编译。";
    els.ir.textContent = "等待脚本进站…";
    clearLog();
    state.program = null;
    els.tracks.replaceChildren();
    els.ruler.replaceChildren();
    els.tlMeta.textContent = "还没有片段。先编译脚本。";
    els.receipt.hidden = true;
    document.querySelectorAll("[data-stage]").forEach(function (btn) {
      btn.classList.remove("is-done", "is-busy");
    });
    drawFrame(0);
    setStage("script");
  }

  document.querySelectorAll("[data-preset]").forEach(function (btn) {
    btn.addEventListener("click", function () { loadPreset(btn.dataset.preset); });
  });
  document.querySelectorAll("[data-stage]").forEach(function (btn) {
    btn.addEventListener("click", function () { setStage(btn.dataset.stage, { scroll: true }); });
  });
  document.querySelector("[data-compile]").addEventListener("click", function () {
    compileNow();
    setStage("timeline", { scroll: true });
  });
  document.querySelector("[data-run]").addEventListener("click", function () { runPipeline(); });
  document.querySelector("[data-export]").addEventListener("click", function () { exportSim(); });
  els.play.addEventListener("click", function () {
    if (!state.program) compileNow();
    state.playing = !state.playing;
    syncPlay();
    setStage("timeline");
  });
  els.scrub.addEventListener("input", function () {
    if (!state.program) return;
    seek(Number(els.scrub.value) / 10, true);
  });
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var was = btn.textContent;
      function done(ok) {
        btn.textContent = ok ? "已复制" : "复制失败";
        window.setTimeout(function () { btn.textContent = was; }, 1200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else done(false);
    });
  });

  function tick(ts) {
    if (!state.lastTs) state.lastTs = ts;
    var dt = Math.min(48, ts - state.lastTs) / 1000;
    state.lastTs = ts;
    if (state.playing && state.program) {
      state.t += dt;
      if (state.t >= state.program.duration) state.t = 0;
      drawFrame(state.t);
    }
    requestAnimationFrame(tick);
  }

  loadPreset("rank");
  syncPlay();
  requestAnimationFrame(tick);
})();
