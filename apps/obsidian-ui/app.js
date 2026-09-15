(() => {
  const tabCopy = {
    buttons: "滑块会跟到当前项，复制即用的标签页原语。",
    motion: "换内容、留框架。动效是一等公民。",
    input: "表单平时安静，需要时才发声。验证码、搜索，一次搞定。",
  };

  const magnet = document.querySelector("[data-magnet]");
  const pill = document.querySelector("[data-magnet-pill]");
  const copy = document.querySelector("[data-tab-copy]");

  function placePill(btn) {
    if (!magnet || !pill || !btn) return;
    const box = magnet.getBoundingClientRect();
    const t = btn.getBoundingClientRect();
    pill.style.width = `${t.width}px`;
    pill.style.transform = `translateX(${t.left - box.left}px)`;
  }

  if (magnet) {
    const current = magnet.querySelector(".is-on") || magnet.querySelector("button");
    placePill(current);
    magnet.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-tab]");
      if (!btn) return;
      magnet.querySelectorAll("button").forEach((el) => el.classList.toggle("is-on", el === btn));
      placePill(btn);
      if (copy) copy.textContent = tabCopy[btn.dataset.tab] || copy.textContent;
    });
    window.addEventListener("resize", () => placePill(magnet.querySelector(".is-on")));
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => placePill(magnet.querySelector(".is-on")));
    }
  }

  const otp = document.querySelector("[data-otp]");
  if (otp) {
    const inputs = [...otp.querySelectorAll("input")];
    inputs.forEach((input, index) => {
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 1);
        if (input.value && inputs[index + 1]) inputs[index + 1].focus();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !input.value && inputs[index - 1]) {
          inputs[index - 1].focus();
        }
      });
      input.addEventListener("paste", (event) => {
        const text = (event.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "");
        if (!text) return;
        event.preventDefault();
        inputs.forEach((el, i) => { el.value = text[i] || ""; });
        inputs[Math.min(text.length, inputs.length - 1)].focus();
      });
    });
  }

  const flip = document.querySelector("[data-flip]");
  if (flip) {
    const text = flip.textContent;
    flip.textContent = "";
    [...text].forEach((ch, i) => {
      const span = document.createElement("span");
      span.textContent = ch === " " ? "\u00a0" : ch;
      span.style.animationDelay = `${i * 45}ms`;
      flip.appendChild(span);
    });
  }

  const tilt = document.querySelector("[data-tilt]");
  if (tilt) {
    tilt.addEventListener("mousemove", (event) => {
      const r = tilt.getBoundingClientRect();
      const x = (event.clientX - r.left) / r.width;
      const y = (event.clientY - r.top) / r.height;
      tilt.style.transform = `rotateX(${(0.5 - y) * 12}deg) rotateY(${(x - 0.5) * 14}deg)`;
      tilt.style.setProperty("--mx", `${x * 100}%`);
      tilt.style.setProperty("--my", `${y * 100}%`);
    });
    tilt.addEventListener("mouseleave", () => {
      tilt.style.transform = "rotateX(0) rotateY(0)";
    });
  }

  const overlay = document.querySelector("[data-overlay]");
  const spotInput = document.querySelector("[data-spot-input]");
  const spotList = document.querySelector("[data-spot-list]");

  function openSearch() {
    if (!overlay) return;
    overlay.classList.add("is-open");
    document.body.style.overflow = "hidden";
    spotInput?.focus();
    spotInput?.select();
  }

  function closeSearch() {
    if (!overlay) return;
    overlay.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  document.querySelectorAll(".search-open").forEach((btn) => {
    btn.addEventListener("click", openSearch);
  });

  overlay?.addEventListener("click", (event) => {
    if (event.target === overlay) closeSearch();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (overlay?.classList.contains("is-open")) closeSearch();
      else openSearch();
    }
    if (event.key === "Escape") closeSearch();
  });

  spotInput?.addEventListener("input", () => {
    const q = spotInput.value.trim().toLowerCase();
    spotList?.querySelectorAll("li").forEach((li) => {
      li.hidden = q !== "" && !li.textContent.toLowerCase().includes(q);
    });
  });

  spotList?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-jump]");
    if (!btn) return;
    closeSearch();
    document.querySelector(btn.dataset.jump)?.scrollIntoView({ behavior: "smooth" });
  });

  const themeBtn = document.querySelector(".theme-toggle");
  themeBtn?.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark");
    themeBtn.setAttribute("aria-pressed", String(dark));
    themeBtn.setAttribute("aria-label", dark ? "切换到浅色主题" : "切换深色主题");
  });
})();
