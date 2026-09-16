(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const rules = [
    {
      id: "minmax",
      go: "1.21",
      impact: "High",
      title: "min / max",
      why: "原帖点名：手写 if-else 比大小。",
      tweet: true,
      before: `if b > a {\n\ta = b\n}`,
      after: `a = max(a, b)`,
    },
    {
      id: "contains",
      go: "1.21",
      impact: "Critical",
      title: "slices.Contains",
      why: "原帖点名：for 循环查切片里有没有某个值。",
      tweet: true,
      before: `found := false\nfor _, item := range items {\n\tif item == x {\n\t\tfound = true\n\t\tbreak\n\t}\n}`,
      after: `found := slices.Contains(items, x)`,
    },
    {
      id: "cmpor",
      go: "1.22",
      impact: "High",
      title: "cmp.Or",
      why: "原帖点名：一层层判 nil / 判空。官方 README 用 cmp.Or 收束。",
      tweet: true,
      before: `var result *User\nif a != nil {\n\tresult = a\n} else if b != nil {\n\tresult = b\n} else {\n\tresult = c\n}`,
      after: `result := cmp.Or(a, b, c)`,
    },
    {
      id: "rangeint",
      go: "1.22",
      impact: "Critical",
      title: "for i := range n",
      why: "语料里旧三点 for 更多，现代化改写会改成 range 整数。",
      before: `for i := 0; i < len(items); i++ {\n\tprocess(items[i])\n}`,
      after: `for i := range len(items) {\n\tprocess(items[i])\n}`,
    },
    {
      id: "any",
      go: "1.18",
      impact: "Critical",
      title: "any",
      why: "别再写 interface{}，用内建别名 any。",
      before: `func Decode(v interface{}) error {\n\treturn nil\n}`,
      after: `func Decode(v any) error {\n\treturn nil\n}`,
    },
    {
      id: "errorsis",
      go: "1.13",
      impact: "Critical",
      title: "errors.Is",
      why: "直接 == 会漏掉被 wrap 的错误。",
      before: `if err == os.ErrNotExist {\n\treturn nil\n}`,
      after: `if errors.Is(err, os.ErrNotExist) {\n\treturn nil\n}`,
    },
    {
      id: "newexpr",
      go: "1.26",
      impact: "High",
      title: "new(value)",
      why: "Go 1.26：不必再写临时变量只为取地址。",
      before: `retries := 3\ncfg := Config{\n\tRetries: &retries,\n}`,
      after: `cfg := Config{\n\tRetries: new(3),\n}`,
    },
    {
      id: "astype",
      go: "1.26",
      impact: "Medium",
      title: "errors.AsType[T]",
      why: "Go 1.26：类型安全取错误，少一个临时变量。",
      before: `var pathErr *os.PathError\nif errors.As(err, &pathErr) {\n\thandle(pathErr)\n}`,
      after: `if pathErr, ok := errors.AsType[*os.PathError](err); ok {\n\thandle(pathErr)\n}`,
    },
  ];

  const versions = ["1.18", "1.21", "1.22", "1.24", "1.26"];

  const agents = {
    claude: {
      name: "Claude Code",
      steps: [
        { cmd: "/plugin marketplace add JetBrains/go-modern-guidelines", note: "把官方仓加成 marketplace" },
        { cmd: "/plugin install modern-go-guidelines@goland-claude-marketplace", note: "安装插件" },
        { cmd: "/modern-go-guidelines:use-modern-go", note: "按 go.mod 激活护栏" },
      ],
    },
    codex: {
      name: "Codex",
      steps: [
        { cmd: "codex plugin marketplace add JetBrains/go-modern-guidelines", note: "终端里加 marketplace" },
        { cmd: "codex plugin add modern-go-guidelines@goland-codex-marketplace", note: "安装 Codex 插件" },
      ],
    },
    cursor: {
      name: "Cursor",
      steps: [
        { cmd: "cursor-agent plugin marketplace add https://github.com/JetBrains/go-modern-guidelines", note: "终端里加 marketplace" },
        { cmd: "/plugins  →  安装 modern-go-guidelines", note: "会话里打开插件面板" },
      ],
    },
    skills: {
      name: "skills.sh",
      steps: [
        { cmd: "npx skills add JetBrains/go-modern-guidelines", note: "其他 agent 共用同一 skill" },
      ],
    },
  };

  const gomodEl = document.querySelector("[data-gomod]");
  const coverEl = document.querySelector("[data-cover]");
  const beforeEl = document.querySelector("[data-before]");
  const afterEl = document.querySelector("[data-after]");
  const noteEl = document.querySelector("[data-note]");
  const rulesEl = document.querySelector("[data-rules]");
  const versionsEl = document.querySelector("[data-versions]");
  const afterFileEl = document.querySelector("[data-after-file]");
  const stalePane = document.querySelector(".pane.stale");
  const freshPane = document.querySelector(".pane.fresh");
  const agentsEl = document.querySelector("[data-agents]");
  const stepsEl = document.querySelector("[data-steps]");
  const termEl = document.querySelector("[data-term]");
  const termStatus = document.querySelector("[data-term-status]");
  const agentLabel = document.querySelector("[data-agent-label]");

  let goVersion = "1.24";
  let activeId = "contains";
  let modern = false;
  let checked = new Set();
  let agentId = "claude";
  let stepIndex = 0;
  let termLines = [];

  function goAtLeast(have, need) {
    const [a, b] = have.split(".").map(Number);
    const [c, d] = need.split(".").map(Number);
    return a > c || (a === c && b >= d);
  }

  function esc(src) {
    return String(src)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function paintGo(src) {
    let out = esc(src);
    out = out.replace(/(\/\/.*)$/gm, '<span class="cm">$1</span>');
    out = out.replace(/`[^`]*`|"[^"\n]*"/g, '<span class="str">$&</span>');
    out = out.replace(
      /\b(func|if|else|return|for|range|var|type|go|defer|true|false|nil|break)\b/g,
      '<span class="kw">$1</span>'
    );
    out = out.replace(
      /\b(slices|cmp|errors|os|Config|User|PathError)\b/g,
      '<span class="type">$1</span>'
    );
    out = out.replace(
      /\b(Contains|Or|Is|As|AsType|handle|process|Decode|max|new|len)\b/g,
      '<span class="fn">$1</span>'
    );
    return out;
  }

  function currentRule() {
    return rules.find((r) => r.id === activeId) || rules[1];
  }

  function unlocked(rule) {
    return goAtLeast(goVersion, rule.go);
  }

  function renderVersions() {
    versionsEl.replaceChildren();
    versions.forEach((v) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (v === goVersion ? " is-on" : "");
      btn.textContent = "go " + v;
      btn.setAttribute("aria-pressed", v === goVersion ? "true" : "false");
      btn.addEventListener("click", () => {
        goVersion = v;
        const rule = currentRule();
        if (!unlocked(rule)) {
          const fallback = rules.find(unlocked) || rules[4];
          activeId = fallback.id;
          modern = false;
        }
        render();
      });
      versionsEl.append(btn);
    });
  }

  function renderRules() {
    rulesEl.replaceChildren();
    rules.forEach((rule) => {
      const wrap = document.createElement("div");
      const on = rule.id === activeId;
      const lock = !unlocked(rule);
      wrap.className = "rule" + (on ? " is-on" : "") + (lock ? " is-locked" : "");
      wrap.setAttribute("role", "button");
      wrap.tabIndex = lock ? -1 : 0;
      wrap.setAttribute("aria-pressed", on ? "true" : "false");
      wrap.setAttribute("aria-disabled", lock ? "true" : "false");

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "check";
      box.checked = checked.has(rule.id);
      box.disabled = lock;
      box.setAttribute("aria-label", "已对照 " + rule.title);
      box.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (lock) return;
        if (checked.has(rule.id)) checked.delete(rule.id);
        else checked.add(rule.id);
        renderCover();
      });

      const body = document.createElement("div");
      const h3 = document.createElement("h3");
      h3.textContent = rule.title + (rule.tweet ? " · 原帖" : "");
      const p = document.createElement("p");
      p.textContent = lock ? ("需要 Go " + rule.go + "+ · " + rule.why) : rule.why;
      body.append(h3, p);

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Go " + rule.go;

      wrap.append(box, body, badge);
      const pick = () => {
        if (lock) {
          noteEl.textContent = "当前 go.mod 是 " + goVersion + "，这条要 Go " + rule.go + "+。先把版本拧上去。";
          return;
        }
        activeId = rule.id;
        modern = false;
        render();
      };
      wrap.addEventListener("click", (ev) => {
        if (ev.target === box) return;
        pick();
      });
      wrap.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          pick();
        }
      });
      rulesEl.append(wrap);
    });
  }

  function renderCover() {
    const open = rules.filter(unlocked);
    const n = open.filter((r) => checked.has(r.id)).length;
    coverEl.textContent = "护栏覆盖 " + n + " / " + open.length;
  }

  function renderPanes() {
    const rule = currentRule();
    const lock = !unlocked(rule);
    gomodEl.textContent = "go " + goVersion;
    beforeEl.innerHTML = paintGo(rule.before);
    afterEl.innerHTML = paintGo(lock ? "// 当前版本还用不上这条。\n// 把 go.mod 升到 " + rule.go + "+" : rule.after);
    afterFileEl.textContent = modern ? "main.go · 已现代化" : "main.go";
    stalePane.classList.toggle("is-dim", modern && !lock);
    freshPane.classList.toggle("is-hot", modern && !lock);
    noteEl.textContent = lock
      ? "当前 go.mod 是 " + goVersion + "。官方护栏会检测版本，不会提前用 " + rule.go + " 的语法。"
      : (modern ? "对照后：" + rule.why : "过时侧还是模型常写的旧法。" + rule.why);
  }

  function render() {
    renderVersions();
    renderRules();
    renderPanes();
    renderCover();
  }

  document.querySelector("[data-modernize]").addEventListener("click", () => {
    const rule = currentRule();
    if (!unlocked(rule)) {
      noteEl.textContent = "先把 go.mod 升到 " + rule.go + "，再对照这条。";
      return;
    }
    modern = !modern;
    if (modern) checked.add(rule.id);
    render();
  });

  function renderAgents() {
    agentsEl.replaceChildren();
    Object.keys(agents).forEach((id) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agent" + (id === agentId ? " is-on" : "");
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", id === agentId ? "true" : "false");
      btn.textContent = agents[id].name;
      btn.addEventListener("click", () => {
        agentId = id;
        resetTerm(true);
      });
      agentsEl.append(btn);
    });
  }

  function renderSteps() {
    const pack = agents[agentId];
    stepsEl.replaceChildren();
    pack.steps.forEach((step, i) => {
      const li = document.createElement("li");
      li.textContent = (i + 1) + ". " + step.note;
      if (i < stepIndex) li.className = "is-done";
      else if (i === stepIndex) li.className = "is-now";
      stepsEl.append(li);
    });
  }

  function writeTerm() {
    termEl.innerHTML = termLines.join("\n");
  }

  function pushLine(html) {
    termLines.push(html);
    writeTerm();
  }

  function resetTerm(renderAgent) {
    stepIndex = 0;
    termLines = [
      '<span class="prompt">$</span> # 玩具终端 · 不会改本机',
      '<span class="cm"># 选 ' + esc(agents[agentId].name) + "，按官方 README 走一遍</span>",
    ];
    agentLabel.textContent = agents[agentId].name;
    termStatus.textContent = "点「执行下一步」，把护栏挂上。";
    if (renderAgent) renderAgents();
    renderSteps();
    writeTerm();
  }

  function finishInstall() {
    modern = true;
    rules.filter(unlocked).forEach((r) => checked.add(r.id));
    termStatus.textContent = "本项目 Go " + goVersion + "，按现代惯用法写到该版本为止。对照工位已全部勾上当前版本能用的规则。";
    render();
  }

  document.querySelector("[data-run-step]").addEventListener("click", () => {
    const pack = agents[agentId];
    if (stepIndex >= pack.steps.length) {
      finishInstall();
      return;
    }
    const step = pack.steps[stepIndex];
    pushLine('<span class="prompt">$</span> ' + esc(step.cmd));
    const apply = () => {
        pushLine('<span class="okline">完成</span>  ' + esc(step.note));
      stepIndex += 1;
      renderSteps();
      if (stepIndex >= pack.steps.length) {
        pushLine('<span class="okline">护栏已挂上</span>  检测到 go.mod → Go ' + goVersion);
        termStatus.textContent = agents[agentId].name + " 已挂上护栏。再点一次「执行下一步」会对照全部能用的规则。";
      } else {
        termStatus.textContent = "下一步：" + pack.steps[stepIndex].note;
      }
    };
    if (reduced) apply();
    else window.setTimeout(apply, 280);
  });

  document.querySelector("[data-reset-term]").addEventListener("click", () => resetTerm(false));

  renderAgents();
  resetTerm(false);
  render();
})();
