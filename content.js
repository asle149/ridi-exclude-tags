(function () {
  const { core, store, api, view } = window.RidiHelper;
  let state = { excludedTagMap: {}, excludeModeOn: false, helperEnabled: true };
  let initialized = false;
  let summary = null;
  let collecting = false;
  let controller = null;
  let generation = 0;
  let lastHandled = "";
  let lastHref = location.href;
  let snapshot = null;
  let collected = null;
  let statusText = "";
  let errorTimer = null;
  let observedMain = null;
  let mountedSection = null;
  let markTimer = null;
  const initialParsed = core.parseFinderUrl(location.href);
  const base = readBase();

  function readBase() {
    try {
      const data = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null");
      const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
      const variables = queries.find((entry) => entry.queryKey?.[0] === "KeywordFinderBooks")?.queryKey?.[1];
      if (variables) return { genre: variables.genre, setId: variables.setId,
        adultOption: variables.adultOption, tagAdultOption: variables.tagAdultOption };
    } catch (error) {
      console.warn("[리디 검색 도우미] 초기 검색 정보를 읽지 못해 주소의 조건을 사용해요", error);
    }
    return {};
  }

  function isFinder(href) {
    try {
      const url = new URL(href, location.href);
      return url.origin === "https://ridibooks.com" && url.pathname.startsWith("/keyword-finder/");
    } catch { return false; }
  }

  function excludedIds() {
    return new Set(Object.keys(state.excludedTagMap).map(Number));
  }

  function markPanel() {
    view.markPanelTags(state.helperEnabled && isFinder(location.href) ? excludedIds() : new Set());
  }

  const observer = new MutationObserver(() => {
    clearTimeout(markTimer);
    markTimer = setTimeout(markPanel, 200);
  });

  function syncMain() {
    const main = document.querySelector("main");
    if (observedMain !== main) {
      observer.disconnect();
      observedMain = main;
      if (main) observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
      markPanel();
    }
    view.setMode(main, !!main && isFinder(location.href) && state.helperEnabled && state.excludeModeOn);
    return main;
  }

  function paint() {
    const main = syncMain();
    if (!main || (!snapshot && !statusText)) return;
    mountedSection = view.mount(main);
    if (snapshot) view.render(snapshot);
    else view.showStatus(statusText);
  }

  function onPage(page) {
    const url = new URL(location.href);
    url.searchParams.set("page", String(page));
    history.replaceState(null, "", url.toString());
    recompute();
    view.scrollToTop();
  }

  async function recompute() {
    if (!initialized) return;
    const href = location.href;
    const signature = JSON.stringify([href, state.helperEnabled, state.excludeModeOn, state.excludedTagMap]);
    if (signature === lastHandled) return;
    lastHandled = signature;
    lastHref = href;
    const current = ++generation;
    controller?.abort();
    controller = null;
    clearTimeout(errorTimer);
    collecting = false;
    summary = null;
    snapshot = null;
    statusText = "";
    syncMain();
    markPanel();
    const parsed = core.parseFinderUrl(href);
    const includedIds = new Set(parsed.tags.map((tag) => tag.id));
    const excluded = excludedIds();
    if (!isFinder(href) || !state.helperEnabled || !parsed.tags.length || ![...excluded].some((id) => !includedIds.has(id))) {
      view.unmount();
      mountedSection = null;
      return;
    }
    controller = new AbortController();
    const variables = core.buildVariables(parsed, parsed.genrePath === initialParsed.genrePath ? base : {});
    const key = api.cacheKey(variables);
    collecting = true;
    statusText = "검색 결과를 모으는 중… (0/1)";
    paint();
    try {
      const result = collected?.key === key ? collected.result : await api.collectAll(variables, {
        signal: controller.signal,
        onProgress(done, totalPages) {
          if (generation !== current) return;
          statusText = `검색 결과를 모으는 중… (${done}/${totalPages})`;
          paint();
        },
      });
      if (generation !== current) return;
      collected = { key, result };
      const filtered = core.filterItems(result.items, excluded, includedIds);
      summary = { kept: filtered.kept.length, total: result.total, removed: filtered.removedCount,
        perTag: filtered.perTag, ignoredExcluded: filtered.ignoredExcluded };
      snapshot = { filtered, total: result.total, truncated: result.truncated,
        paged: core.paginate(filtered.kept, parsed.page), excluded: state.excludedTagMap, href, onPage };
      statusText = "";
      paint();
    } catch (error) {
      if (generation !== current || error.name === "AbortError") return;
      console.warn("[리디 검색 도우미] 결과 수집에 실패했어요", error);
      statusText = "결과를 가져오지 못했어요. 리디 원래 목록을 보여 드릴게요.";
      paint();
      errorTimer = setTimeout(() => {
        if (generation !== current) return;
        statusText = "";
        view.unmount();
        mountedSection = null;
      }, 3000);
    } finally {
      if (generation === current) collecting = false;
    }
  }

  async function update(change) {
    state = await store.update(change);
    recompute();
  }

  function intercept(event) {
    if (!initialized || !state.helperEnabled || !state.excludeModeOn || !isFinder(location.href)) return;
    const link = event.target?.closest?.("a");
    if (!link || !isFinder(link.href)) return;
    const url = new URL(link.href);
    if (!url.searchParams.has("tag_ids") && !url.searchParams.has("tag_ids[]")) return;
    const included = new Set(core.parseFinderUrl(location.href).tags.map((tag) => tag.id));
    const added = core.parseFinderUrl(link.href).tags.filter((tag) => !included.has(tag.id));
    if (!added.length) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type !== "click") return;
    update((saved) => {
      const map = { ...saved.excludedTagMap };
      for (const tag of added) map[tag.id] = tag.name || map[tag.id] || "";
      return { excludedTagMap: map };
    }).catch((error) => console.warn("[리디 검색 도우미] 제외 태그를 저장하지 못했어요", error));
  }

  for (const type of ["pointerdown", "mousedown", "click"]) {
    document.addEventListener(type, intercept, { capture: true, passive: false });
  }

  const ready = store.read().then((saved) => {
    state = saved;
    initialized = true;
    store.subscribe((patch) => {
      state = { ...state, ...patch };
      recompute();
    });
    recompute();
  });
  ready.catch((error) => console.warn("[리디 검색 도우미] 설정을 읽지 못했어요", error));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      await ready;
      if (!isFinder(location.href)) return { ok: false };
      switch (message?.type) {
        case "GET_STATE":
          recompute();
          return { ok: true, helperEnabled: state.helperEnabled, modeOn: state.excludeModeOn,
            included: core.parseFinderUrl(location.href).tags, excluded: state.excludedTagMap, summary, collecting };
        case "SET_MODE":
          await update({ excludeModeOn: !!message.on });
          break;
        case "SET_ENABLED":
          await update({ helperEnabled: !!message.on });
          break;
        case "REMOVE_EXCLUDED":
          await update((saved) => {
            const map = { ...saved.excludedTagMap };
            delete map[String(message.id)];
            return { excludedTagMap: map };
          });
          break;
        case "CLEAR_EXCLUDED":
          await update({ excludedTagMap: {} });
          break;
        default: return { ok: false };
      }
      return { ok: true };
    })().then(sendResponse, (error) => {
      console.warn("[리디 검색 도우미] 설정을 변경하지 못했어요", error);
      sendResponse({ ok: false });
    });
    return true;
  });

  window.addEventListener("popstate", () => recompute());
  setInterval(() => {
    if (!initialized) return;
    if (lastHref !== location.href) recompute();
    const main = syncMain();
    if (!main || (!snapshot && !statusText)) return;
    const section = view.mount(main);
    if (section !== mountedSection) paint();
  }, 300);
})();
