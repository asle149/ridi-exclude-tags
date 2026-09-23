(function () {
  function create(callbacks) {
    const node = (tag, className, text) => {
      const el = document.createElement(tag);
      el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const root = node("aside", "rh-panel");
    root.setAttribute("aria-label", "리디 검색 도우미");
    const head = node("div", "rh-panel-head");
    const title = node("strong", "rh-panel-title", "리디 검색 도우미");
    const fold = node("button", "rh-panel-fold", "접기");
    const pill = node("button", "rh-panel-pill");
    const body = node("div", "rh-panel-body");
    let panelState = {};
    let dragging = null;
    function save(patch) {
      panelState = { ...panelState, ...patch };
      applyPosition();
      callbacks.onPanelStateChange(panelState);
    }
    function toggle(text, callback) {
      const label = node("label", "rh-panel-toggle");
      const input = node("input", "");
      input.type = "checkbox";
      input.addEventListener("change", () => callback(input.checked));
      label.append(input, node("span", "", text));
      body.append(label);
      return input;
    }
    head.append(title, fold);
    root.append(head, pill, body);
    const enabled = toggle("도우미 켜기", callbacks.onToggleEnabled);
    const mode = toggle("제외 모드", callbacks.onToggleMode);
    body.append(node("p", "rh-panel-note", "켜 두고 태그를 누르면 제외 목록에 들어가요"));
    const summary = node("p", "rh-panel-summary");
    summary.setAttribute("aria-live", "polite");
    const chips = node("div", "rh-panel-chips");
    const clear = node("button", "rh-panel-clear", "전체 삭제");
    clear.addEventListener("click", callbacks.onClearExcluded);
    body.append(summary, chips, clear, node("hr", "rh-panel-divider"), node("strong", "rh-panel-title", "할인 정보"));
    const markdown = toggle("마크다운 할인 정보", callbacks.onToggleMarkdown);
    const status = node("p", "rh-panel-note");
    status.setAttribute("role", "status");
    body.append(status);
    const filter = toggle("이번 행사 최대 할인만", callbacks.onFilterChange);
    const sort = node("select", "rh-panel-sort");
    sort.setAttribute("aria-label", "결과 정렬");
    for (const [value, text] of [["ridi", "리디 순서"], ["delta", "할인 증가순"], ["current", "이번 행사 할인율순"]]) {
      const option = node("option", "", text);
      option.value = value;
      sort.append(option);
    }
    sort.addEventListener("change", () => callbacks.onSortChange(sort.value));
    const credit = node("a", "rh-panel-credit", "할인 정보: novel-calendar.com");
    credit.href = "https://www.novel-calendar.com";
    credit.target = "_blank";
    credit.rel = "noopener noreferrer";
    body.append(sort, credit);
    for (const button of [fold, pill, clear]) button.type = "button";
    fold.addEventListener("click", () => save({ collapsed: true }));
    pill.addEventListener("click", () => save({ collapsed: false }));

    function defaultPosition() {
      root.style.left = "";
      root.style.top = "";
      root.style.right = "16px";
      root.style.bottom = "16px";
    }
    function applyPosition() {
      head.hidden = body.hidden = !!panelState.collapsed;
      pill.hidden = !panelState.collapsed;
      root.classList.toggle("rh-panel-collapsed", !!panelState.collapsed);
      const { left, top } = panelState;
      if (Number.isFinite(left) && Number.isFinite(top)) {
        const rect = root.getBoundingClientRect();
        root.style.left = `${Math.max(0, Math.min(left, window.innerWidth - rect.width))}px`;
        root.style.top = `${Math.max(0, Math.min(top, window.innerHeight - rect.height))}px`;
        root.style.right = root.style.bottom = "auto";
      } else defaultPosition();
    }
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = root.getBoundingClientRect();
      dragging = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
      try { head.setPointerCapture(event.pointerId); } catch { /* 포인터를 못 잡아도 끌기는 이어간다 */ }
      event.preventDefault();
    });
    head.addEventListener("pointermove", (event) => {
      if (!dragging || dragging.id !== event.pointerId) return;
      const rect = root.getBoundingClientRect();
      panelState = { ...panelState, left: Math.max(0, Math.min(event.clientX - dragging.x, window.innerWidth - rect.width)),
        top: Math.max(0, Math.min(event.clientY - dragging.y, window.innerHeight - rect.height)) };
      applyPosition();
    });
    function endDrag(event) {
      if (!dragging || dragging.id !== event.pointerId) return;
      dragging = null;
      callbacks.onPanelStateChange(panelState);
    }
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
    head.addEventListener("lostpointercapture", endDrag);
    window.addEventListener("resize", () => {
      const rect = root.getBoundingClientRect();
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
        save({ left: null, top: null });
      }
    });
    document.body.append(root);
    function update(state) {
      root.hidden = state.visible === false;
      enabled.checked = !!state.helperEnabled;
      mode.checked = !!state.excludeModeOn;
      mode.disabled = !state.helperEnabled;
      markdown.checked = !!state.markdownEnabled;
      filter.checked = !!state.markdownFilterMax;
      filter.disabled = sort.disabled = !state.markdownEnabled || !state.markdownSupported;
      sort.value = state.resultSort || "ridi";
      summary.textContent = state.summaryText || "제외할 태그를 골라 주세요.";
      status.textContent = state.markdownStatus || "";
      const excluded = Object.entries(state.excludedTagMap || {});
      clear.disabled = !excluded.length;
      chips.replaceChildren();
      const format = (n) => Number(n).toLocaleString("ko-KR");
      for (const [id, name] of excluded) {
        const chip = node("span", "rh-panel-chip");
        chip.append(node("span", "", `#${name || id}${state.summary?.perTag?.[id] == null ? "" : ` ·${format(state.summary.perTag[id])}`}`));
        const remove = node("button", "rh-panel-remove", "X");
        remove.type = "button";
        remove.setAttribute("aria-label", `#${name || id} 제외 삭제`);
        remove.addEventListener("click", () => callbacks.onRemoveExcluded(Number(id)));
        chip.append(remove);
        chips.append(chip);
      }
      pill.textContent = `제외 ${excluded.length}${state.summary ? ` · ${format(state.summary.kept)}개` : ""}`;
      if (!dragging) panelState = { ...state.panelState };
      applyPosition();
    }
    return { update };
  }
  window.RidiHelper.panel = { create };
})();
