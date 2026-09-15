(() => {
  const MODELS = [
    {
      id: "gpt2-xl",
      name: "GPT-2 XL",
      scale: "1.5B",
      family: ["dense", "mha"],
      tint: "#c9d3e3",
      attnColor: "#2563eb",
      decoder: "稠密解码器",
      attention: "多头注意力 · 学习式绝对位置",
      layers: "48 × MHA",
      context: "1,024",
      kv: "约 300 KiB / token",
      summary: "2019 年的对照原点：Dropout、GELU、LayerNorm，完整多头注意力。后来几乎所有新卡都在改这三块积木。",
      bullets: [
        "词嵌入与位置嵌入分开相加，上下文很短。",
        "每个块都是层归一化 → 注意力 → 残差 → 层归一化 → 前馈。",
        "没有分组查询，也没有旋转位置，KV 缓存相对偏贵。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "绝对位置"],
        ["norm", "LayerNorm"],
        ["attn", "多头注意力"],
        ["ffn", "GELU 前馈"],
        ["repeat", "× 48 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "llama3-8b",
      name: "Llama 3 8B",
      scale: "8B",
      family: ["dense", "gqa"],
      tint: "#f0c4de",
      attnColor: "#db2777",
      decoder: "稠密解码器",
      attention: "分组查询注意力 · RoPE",
      layers: "32 × GQA",
      context: "8,192",
      kv: "约 128 KiB / token",
      summary: "当代稠密栈的基准卡：预归一化、旋转位置、分组查询，宽度比同规模 OLMo 2 更大。",
      bullets: [
        "RMSNorm 取代 LayerNorm，SwiGLU 取代 GELU。",
        "GQA 让 KV 头少于查询头，推理缓存立刻变轻。",
        "适合拿来对照后续的 QK 归一化、滑动窗口和专家路由。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMSNorm"],
        ["attn", "分组查询"],
        ["ffn", "SwiGLU"],
        ["repeat", "× 32 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "olmo2-7b",
      name: "OLMo 2 7B",
      scale: "7B",
      family: ["dense", "mha"],
      tint: "#d8c7f0",
      attnColor: "#7c3aed",
      decoder: "稠密解码器",
      attention: "多头注意力 · QK 归一化",
      layers: "32 × MHA",
      context: "4,096",
      kv: "约 512 KiB / token",
      summary: "透明开源对照：保住经典多头，却把归一化挪进残差内部，训练更稳、缓存更重。",
      bullets: [
        "不是常见的预归一化，而是残差内部的后归一化。",
        "查询键再做一次归一化，注意力数值更稳。",
        "完整 MHA 让 KV 体积明显高于同规模 GQA 模型。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["attn", "多头 + QK 归一"],
        ["norm", "残差内归一化"],
        ["ffn", "前馈"],
        ["repeat", "× 32 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "llama32-1b",
      name: "Llama 3.2 1B",
      scale: "1B",
      family: ["dense", "gqa"],
      tint: "#e4c6ea",
      attnColor: "#a21caf",
      decoder: "稠密解码器",
      attention: "分组查询注意力 · RoPE",
      layers: "16 × GQA",
      context: "128,000",
      kv: "约 32 KiB / token",
      summary: "小参数、长上下文：层数更少、隐藏维更宽，常被拿来和 Qwen3 小卡对着看。",
      bullets: [
        "只有 16 层，但上下文直接拉到 128K。",
        "KV 很轻，适合本机试结构而不是冲分数。",
        "配方仍是 Llama 家族的 RMS + GQA + RoPE。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMSNorm"],
        ["attn", "分组查询"],
        ["ffn", "SwiGLU"],
        ["repeat", "× 16 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "qwen3-4b",
      name: "Qwen3 4B",
      scale: "4B",
      family: ["dense", "gqa"],
      tint: "#c5e0f7",
      attnColor: "#0284c7",
      decoder: "稠密解码器",
      attention: "分组查询 · QK 归一化",
      layers: "36 × GQA",
      context: "32,768",
      kv: "约 144 KiB / token",
      summary: "更深更窄的小稠密卡：QK 归一化加上约 15 万词表，是看 Qwen3 家族的入门积木。",
      bullets: [
        "比 Llama 3.2 1B 更深，层数来到 36。",
        "查询键归一化是 Qwen3 稠密栈的标志。",
        "上下文 32K，先把结构看清再看更大的 8B / 32B。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMS + QK 归一"],
        ["attn", "分组查询"],
        ["ffn", "SwiGLU"],
        ["repeat", "× 36 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "qwen3-8b",
      name: "Qwen3 8B",
      scale: "8B",
      family: ["dense", "gqa"],
      tint: "#b7e6ee",
      attnColor: "#0e7490",
      decoder: "稠密解码器",
      attention: "分组查询 · QK 归一化",
      layers: "36 × GQA",
      context: "128,000",
      kv: "约 144 KiB / token",
      summary: "8B 对照卡：和 4B 几乎同一套积木，只是上下文与容量拉大，方便和 OLMo 3 对齐。",
      bullets: [
        "仍是 36 层 GQA，8 个 KV 头。",
        "QK 归一化贯穿整张卡。",
        "适合当作「标准 Qwen3 稠密」去对比专家卡。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMS + QK 归一"],
        ["attn", "分组查询"],
        ["ffn", "SwiGLU"],
        ["repeat", "× 36 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "qwen3-32b",
      name: "Qwen3 32B",
      scale: "32B",
      family: ["dense", "gqa"],
      tint: "#9fd9d4",
      attnColor: "#0f766e",
      decoder: "稠密解码器",
      attention: "分组查询 · QK 归一化",
      layers: "64 × GQA",
      context: "128,000",
      kv: "约 256 KiB / token",
      summary: "大号稠密 Qwen：64 层把深度拉满，是和 32B 级开源稠密模型一对一比较的清晰底板。",
      bullets: [
        "层数几乎是 8B 的两倍。",
        "注意力机制没有换成潜在注意力，仍走 GQA。",
        "KV 中等偏高，换来完整全局注意力。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMS + QK 归一"],
        ["attn", "分组查询"],
        ["ffn", "SwiGLU"],
        ["repeat", "× 64 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "deepseek-v3",
      name: "DeepSeek V3",
      scale: "671B / 37B 激活",
      family: ["moe", "mla"],
      tint: "#f5c3b8",
      attnColor: "#e11d48",
      moe: true,
      decoder: "稀疏混合专家",
      attention: "多头潜在注意力",
      layers: "61 × MLA",
      context: "128,000",
      kv: "约 68.6 KiB / token",
      summary: "近年开源 MoE 的模板卡：潜在注意力压缓存，共享专家加稠密前缀，再加多 token 预测。",
      bullets: [
        "MLA 把 KV 压进潜在向量，长上下文才扛得住。",
        "路由专家旁边永远有一条共享专家。",
        "训练时的 MTP 让推测解码更顺，结构上也多出一条头。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["attn", "潜在注意力"],
        ["moe", "共享 + 路由专家"],
        ["repeat", "× 61 层"],
        ["head", "语言头 + MTP"],
      ],
    },
    {
      id: "kimi-k2",
      name: "Kimi K2",
      scale: "1T / 32B 激活",
      family: ["moe", "mla"],
      tint: "#bfe3c4",
      attnColor: "#16a34a",
      moe: true,
      decoder: "稀疏混合专家",
      attention: "多头潜在注意力",
      layers: "61 × MLA",
      context: "128,000",
      kv: "约 68.6 KiB / token",
      summary: "把 DeepSeek 配方再放大：专家更多、MLA 头更少，激活参数仍控制在可服务的量级。",
      bullets: [
        "总参数跨到万亿，激活大约 32B。",
        "注意力仍是潜在压缩，所以 KV 几乎和 V3 同级。",
        "看这张卡，重点是「同样的积木、不同的专家数量」。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["attn", "潜在注意力"],
        ["moe", "更宽专家池"],
        ["repeat", "× 61 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "gemma3-27b",
      name: "Gemma 3 27B",
      scale: "27B",
      family: ["dense", "gqa", "swa"],
      tint: "#ead7a2",
      attnColor: "#ca8a04",
      decoder: "稠密解码器",
      attention: "分组查询 · 5:1 滑动窗口",
      layers: "52 窗口 + 10 全局",
      context: "128,000",
      kv: "约 496 KiB / token",
      summary: "本地窗口唱主角：五层局部夹一层全局，词表极大，稠密模型里对长文最「肯花钱」。",
      bullets: [
        "滑动窗口大幅减少大多数层的可见范围。",
        "每隔若干层仍保留全局注意力，远距离信号不会断。",
        "QK 归一化 + 26 万级词表，是 Gemma 3 家族的共同标签。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMS + QK 归一"],
        ["attn", "窗口 / 全局"],
        ["ffn", "门控前馈"],
        ["repeat", "× 62 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "mistral-24b",
      name: "Mistral 3.1 24B",
      scale: "24B",
      family: ["dense", "gqa"],
      tint: "#f3c7bc",
      attnColor: "#ea580c",
      decoder: "稠密解码器",
      attention: "标准分组查询",
      layers: "40 × GQA",
      context: "128,000",
      kv: "约 160 KiB / token",
      summary: "为延迟改过的 24B：丢掉旧版滑动窗口，层数比 Gemma 3 27B 更少，KV 也更克制。",
      bullets: [
        "注意力回到朴素 GQA，结构非常好认。",
        "40 层比同级 Gemma 更浅，服务时更好排。",
        "适合当作「无窗口的现代稠密卡」去对比。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMSNorm"],
        ["attn", "分组查询"],
        ["ffn", "SwiGLU"],
        ["repeat", "× 40 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "llama4-maverick",
      name: "Llama 4 Maverick",
      scale: "400B / 17B 激活",
      family: ["moe", "gqa", "swa"],
      tint: "#f3c49a",
      attnColor: "#c2410c",
      moe: true,
      decoder: "稀疏混合专家",
      attention: "分块 + 全局分组查询",
      layers: "36 分块 + 12 全量",
      context: "1,000,000",
      kv: "约 192 KiB / token",
      summary: "Meta 的大 MoE：专家更少更大，稠密块与专家块交替，上下文直接拉到百万级。",
      bullets: [
        "注意力在分块局部和全量 GQA 之间切换。",
        "专家数量少于 DeepSeek，单个专家更宽。",
        "看这张卡能立刻感到「MoE 也可以很传统」。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["attn", "分块 / 全量 GQA"],
        ["moe", "交替专家块"],
        ["repeat", "× 48 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "qwen3-235b",
      name: "Qwen3 235B-A22B",
      scale: "235B / 22B 激活",
      family: ["moe", "gqa"],
      tint: "#9fd6cf",
      attnColor: "#0f766e",
      moe: true,
      decoder: "稀疏混合专家",
      attention: "分组查询 · QK 归一化",
      layers: "94 × GQA",
      context: "128,000",
      kv: "约 188 KiB / token",
      summary: "贴近 DeepSeek 的稀疏 Qwen：更深、不设共享专家，用路由效率换服务成本。",
      bullets: [
        "94 层把专家卡做得很深。",
        "没有共享专家，所有容量都交给路由。",
        "注意力仍是 GQA 而不是 MLA，KV 比 V3 更重。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["norm", "RMS + QK 归一"],
        ["attn", "分组查询"],
        ["moe", "纯路由专家"],
        ["repeat", "× 94 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "smollm3",
      name: "SmolLM3 3B",
      scale: "3B",
      family: ["dense", "gqa"],
      tint: "#e2d5a8",
      attnColor: "#a16207",
      decoder: "稠密解码器",
      attention: "分组查询 · 周期性无位置",
      layers: "36 × GQA",
      context: "131,072",
      kv: "约 72 KiB / token",
      summary: "小模型里的结构实验：每隔四层摘掉 RoPE，看「无位置层」会不会让长度外推更稳。",
      bullets: [
        "主体仍是 GQA 稠密栈。",
        "每四层出现一次 NoPE，积木上会缺一块位置色。",
        "KV 很低，适合把结构差异摆在桌面上讲。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "RoPE / 间歇 NoPE"],
        ["norm", "RMSNorm"],
        ["attn", "分组查询"],
        ["ffn", "前馈"],
        ["repeat", "× 36 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "gpt-oss-20b",
      name: "GPT-OSS 20B",
      scale: "21B / 3.6B 激活",
      family: ["moe", "gqa", "swa"],
      tint: "#d9c8f2",
      attnColor: "#6d28d9",
      moe: true,
      decoder: "稀疏混合专家",
      attention: "交替窗口 / 全局 GQA",
      layers: "12 窗口 + 12 全局",
      context: "128,000",
      kv: "约 48 KiB / token",
      summary: "OpenAI 开源小 MoE：更宽更浅，窗口与全局一层隔一层，还带注意力偏置和 sink。",
      bullets: [
        "激活比例高（约 17%），和小而密的 MoE 更像。",
        "交替注意力让 KV 压到很低。",
        "和 Qwen3 30B-A3B 比，这张卡更宽、更浅。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["attn", "窗口 ⇄ 全局"],
        ["moe", "宽浅专家"],
        ["repeat", "× 24 层"],
        ["head", "语言头"],
      ],
    },
    {
      id: "glm-45",
      name: "GLM-4.5",
      scale: "355B / 32B 激活",
      family: ["moe", "gqa"],
      tint: "#b7e3d8",
      attnColor: "#0f766e",
      moe: true,
      decoder: "稀疏混合专家",
      attention: "分组查询 · QK 归一化",
      layers: "92 × GQA",
      context: "128,000",
      kv: "约 368 KiB / token",
      summary: "代理向混合配方：前三层稠密、其后 MoE，共享专家加上训练期多 token 预测。",
      bullets: [
        "开头几层不路由，先把表示打稳。",
        "共享专家始终在线，和 DeepSeek 同一思路。",
        "KV 偏高，因为注意力没有改成潜在压缩。",
      ],
      stack: [
        ["embed", "词嵌入"],
        ["pos", "旋转位置"],
        ["attn", "分组查询"],
        ["moe", "稠密前缀 + 专家"],
        ["repeat", "× 92 层"],
        ["head", "语言头 + MTP"],
      ],
    },
  ];

  const board = document.querySelector("[data-board]");
  const viewport = document.querySelector("[data-viewport]");
  const drawer = document.querySelector("[data-drawer]");
  const explode = document.querySelector("[data-explode]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const narrow = () => window.matchMedia("(max-width: 640px)").matches;

  let rotX = 18;
  let rotY = -16;
  let drag = null;
  let filter = "all";

  function applyBoard() {
    if (!board) return;
    if (narrow() || reduceMotion) {
      board.style.transform = "none";
      return;
    }
    board.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg)`;
  }

  function plateHtml(stack) {
    return stack.map(([kind, label]) => `<span class="plate ${kind}">${label}</span>`).join("");
  }

  function renderBoard() {
    if (!board) return;
    board.innerHTML = MODELS.map((model) => `
      <article class="card" data-card="${model.id}" data-family="${model.family.join(" ")}" style="--tint:${model.tint}" tabindex="0" role="button" aria-label="打开 ${model.name} 拆解">
        <div class="card-side"></div>
        <div class="card-bottom"></div>
        <div class="card-body">
          <h2 class="card-name">${model.name}</h2>
          <p class="card-meta">${model.scale} · ${model.decoder}</p>
          <div class="arch" style="--tint:${model.tint}">
            <div class="plates">${plateHtml(model.stack)}</div>
            ${model.moe ? '<div class="moe-fan" aria-hidden="true"><span></span><span></span><span></span><span></span></div>' : ""}
          </div>
        </div>
      </article>
    `).join("");
  }

  function setFilter(next) {
    filter = next;
    document.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.filter === next);
    });
    document.querySelectorAll("[data-card]").forEach((card) => {
      const family = card.dataset.family.split(" ");
      const show = next === "all" || family.includes(next) || (next === "dense" && family.includes("dense"));
      card.classList.toggle("is-hidden", !show);
    });
  }

  function openModel(id) {
    const model = MODELS.find((item) => item.id === id);
    if (!model || !drawer) return;
    drawer.hidden = false;
    document.querySelector("[data-fact-tag]").textContent = `${model.decoder} · ${model.attention}`;
    document.querySelector("[data-fact-title]").textContent = `${model.name} · ${model.scale}`;
    document.querySelector("[data-fact-summary]").textContent = model.summary;
    document.querySelector("[data-spec]").innerHTML = `
      <dt>层配方</dt><dd>${model.layers}</dd>
      <dt>上下文</dt><dd>${model.context} token</dd>
      <dt>KV 量级</dt><dd>${model.kv}（bf16 粗算）</dd>
    `;
    document.querySelector("[data-bullets]").innerHTML = model.bullets.map((line) => `<li>${line}</li>`).join("");

    const colors = { embed: "#4d5d78", pos: "#6a7c99", norm: "#2f3544", attn: model.attnColor, ffn: "#0f766e", moe: "#c2410c", head: "#4338ca", repeat: "#334155" };
    explode.innerHTML = '<div class="spine" aria-hidden="true"></div>' + model.stack.map((entry, index) => {
      const [kind, label] = entry;
      const top = 12 + index * 34;
      const z = (index - 3) * 16;
      return `<div class="layer" style="top:${top}px;background:${colors[kind] || "#334155"};transform:translateZ(${z}px)">${label}</div>`;
    }).join("");
  }

  function closeDrawer() {
    if (drawer) drawer.hidden = true;
  }

  renderBoard();
  applyBoard();

  document.querySelector("[data-filters]")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (btn) setFilter(btn.dataset.filter);
  });

  document.querySelector("[data-reset]")?.addEventListener("click", () => {
    rotX = 18;
    rotY = -16;
    applyBoard();
  });

  board?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-card]");
    if (card) openModel(card.dataset.card);
  });

  board?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-card]");
    if (!card) return;
    event.preventDefault();
    openModel(card.dataset.card);
  });

  document.querySelector("[data-close]")?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });

  if (viewport && !reduceMotion) {
    viewport.addEventListener("pointerdown", (event) => {
      if (narrow() || event.target.closest("[data-card]")) return;
      drag = { x: event.clientX, y: event.clientY, rotX, rotY };
      viewport.classList.add("is-drag");
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!drag) return;
      rotY = drag.rotY + (event.clientX - drag.x) * 0.18;
      rotX = Math.max(-8, Math.min(36, drag.rotX - (event.clientY - drag.y) * 0.12));
      applyBoard();
    });
    const endDrag = () => {
      drag = null;
      viewport.classList.remove("is-drag");
    };
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
  }

  window.addEventListener("resize", applyBoard);
})();
