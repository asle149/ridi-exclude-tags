(function () {
  const { core, store, api, view, markdown, panel } = window.RidiHelper;
  let state = { excludedTagMap: {}, excludeModeOn: false, helperEnabled: true,
    markdownEnabled: true, markdownFilterMax: false, resultSort: "ridi", panelState: {} };
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
  let maxPages = 15;
  let collectionKey = "";
  let markdownData = null;
  let markdownRequested = "";
  let markdownStatus = "";
  let markdownGeneration = 0;
  const remote = panel?.create({
    onToggleEnabled: (on) => update({ helperEnabled: on }),
    onToggleMode: (on) => update({ excludeModeOn: on }),
    onRemoveExcluded: (id) => update((saved) => {
      const map = { ...saved.excludedTagMap };
      delete map[id];
      return { excludedTagMap: map };
    }),
    onClearExcluded: () => update({ excludedTagMap: {} }),
    onToggleMarkdown: (on) => { markdownRequested = ""; return update({ markdownEnabled: on }); },
    onFilterChange: (on) => changeDisplay({ markdownFilterMax: on }),
    onSortChange: (value) => changeDisplay({ resultSort: value }),
    onPanelStateChange: (panelState) => update({ panelState }),
  });
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

  function updatePanel() {
    const supported = !!markdown?.genreSlugsFor(core.parseFinderUrl(location.href).genrePath).length;
    const format = (n) => Number(n).toLocaleString("ko-KR");
    remote?.update({ ...state, visible: isFinder(location.href), summary,
      summaryText: collecting ? statusText : summary ? `제외 반영 ${format(summary.kept)}개 · ${format(summary.removed)}개 제외` :
        statusText || (state.helperEnabled ? "제외할 태그를 골라 주세요." : "도우미가 꺼져 있어요."),
      markdownSupported: supported, markdownStatus: !supported ? "이 장르는 지원하지 않아요" :
        !state.markdownEnabled ? "할인 정보가 꺼져 있어요" : markdownStatus || "목록을 표시하면 할인 정보를 받아요" });
  }

  function changeDisplay(patch) {
    const url = new URL(location.href);
    url.searchParams.set("page", "1");
    history.replaceState(null, "", url.toString());
    return update(patch);
  }

  function requestMarkdown(genrePath) {
    if (!markdown || !state.markdownEnabled || !markdown.genreSlugsFor(genrePath).length || markdownRequested === genrePath) return;
    markdownRequested = genrePath;
    markdownData = null;
    markdownStatus = "받는 중 0/1";
    const current = ++markdownGeneration;
    chrome.runtime.sendMessage({ type: "MARKDOWN_GET", genrePath }).then((response) => {
      if (current !== markdownGeneration) return;
      if (!response?.ok) throw new Error("할인 정보 수집 실패");
      markdownData = { genrePath, data: response.data };
      const slugs = markdown.genreSlugsFor(genrePath);
      const time = Math.min(...slugs.map((slug) => response.data.genres[slug]?.fetchedAt || 0));
      const date = new Date(time);
      const day = date.toLocaleDateString("ko-KR") === new Date().toLocaleDateString("ko-KR") ? "오늘" : date.toLocaleDateString("ko-KR");
      const events = new Set();
      for (const slug of slugs) {
        const genre = response.data.genres[slug];
        for (const book of Object.values(genre?.byBook || {})) for (const event of Object.keys(book)) events.add(event);
        for (const event of Object.keys(genre?.recommended || {})) events.add(event);
      }
      markdownStatus = `최근 ${events.size}개 행사 · ${day} ${date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })} 갱신${response.partial ? " · 일부 행사 제외" : ""}`;
      if (snapshot && collected) renderResults();
      updatePanel();
    }).catch(() => {
      if (current !== markdownGeneration) return;
      markdownStatus = "할인 정보를 가져오지 못했어요";
      updatePanel();
    });
    updatePanel();
  }

  function bookMarkdown(items, genrePath) {
    const byBook = {};
    if (!state.markdownEnabled || markdownData?.genrePath !== genrePath) return byBook;
    const data = markdownData.data;
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const events = Object.fromEntries(Object.entries(data.events).map(([slug, event]) => [slug,
      { ...event, ongoing: event.ongoing && event.start <= today && today <= event.end }]));
    const genres = markdown.genreSlugsFor(genrePath).map((slug) => data.genres[slug]).filter(Boolean);
    const recommended = new Set(genres.flatMap((genre) => Object.entries(genre.recommended)
      .filter(([slug]) => events[slug]?.ongoing).flatMap(([, ids]) => ids)));
    for (const item of items) {
      const id = item.bookShell?.book?.id;
      const history = Object.assign({}, ...genres.map((genre) => genre.byBook[id] || {}));
      byBook[id] = { label: markdown.discountLabel(Object.entries(history).map(([eventSlug, values]) => ({ eventSlug, rate: values[0] })), events),
        recommended: recommended.has(Number(id)) };
    }
    return byBook;
  }

  function renderResults() {
    const parsed = core.parseFinderUrl(location.href);
    const result = collected.result;
    const filtered = core.filterItems(result.items, excludedIds(), new Set(parsed.tags.map((tag) => tag.id)));
    const markdownByBook = bookMarkdown(filtered.kept, parsed.genrePath);
    const beforeMarkdown = filtered.kept.length;
    const markdownReady = state.markdownEnabled && markdownData?.genrePath === parsed.genrePath;
    if (markdownReady && state.markdownFilterMax) filtered.kept = filtered.kept.filter((item) => markdownByBook[item.bookShell?.book?.id]?.label?.isMax);
    if (markdownReady && state.resultSort !== "ridi") {
      const field = state.resultSort === "delta" ? "delta" : "currentRate";
      const value = (item) => markdownByBook[item.bookShell?.book?.id]?.label?.[field] ?? -Infinity;
      filtered.kept.sort((a, b) => value(b) - value(a));
    }
    summary = { kept: filtered.kept.length, total: result.total, removed: filtered.removedCount,
      perTag: filtered.perTag, ignoredExcluded: filtered.ignoredExcluded };
    snapshot = { filtered, total: result.total, truncated: result.truncated, loadedPages: result.loadedPages,
      paged: core.paginate(filtered.kept, parsed.page), excluded: state.excludedTagMap, href: location.href, onPage,
      markdownByBook, beforeMarkdown: markdownReady && state.markdownFilterMax ? beforeMarkdown : null,
      onMore() { if (!collecting && maxPages < 75) { maxPages += 15; recompute(); } }, collecting, progressText: statusText };
    paint();
    updatePanel();
  }

  async function recompute() {
    if (!initialized) return;
    updatePanel();
    const href = location.href;
    const parsed = core.parseFinderUrl(href);
    const variables = core.buildVariables(parsed, parsed.genrePath === initialParsed.genrePath ? base : {});
    const key = api.cacheKey(variables);
    if (collectionKey !== key) { collectionKey = key; maxPages = 15; }
    const signature = JSON.stringify([href, state.helperEnabled, state.excludeModeOn, state.excludedTagMap,
      state.markdownEnabled, state.markdownFilterMax, state.resultSort, maxPages]);
    if (signature === lastHandled) return;
    lastHandled = signature;
    lastHref = href;
    const current = ++generation;
    controller?.abort();
    controller = null;
    clearTimeout(errorTimer);
    collecting = false;
    summary = null;
    const previous = snapshot;
    snapshot = null;
    statusText = "";
    syncMain();
    markPanel();
    const includedIds = new Set(parsed.tags.map((tag) => tag.id));
    const excluded = excludedIds();
    const markdownOn = state.markdownEnabled && markdown?.genreSlugsFor(parsed.genrePath).length;
    if (!isFinder(href) || !state.helperEnabled || !parsed.tags.length ||
        (!markdownOn && ![...excluded].some((id) => !includedIds.has(id)))) {
      view.unmount();
      mountedSection = null;
      updatePanel();
      return;
    }
    requestMarkdown(parsed.genrePath);
    controller = new AbortController();
    collecting = true;
    statusText = "검색 결과를 모으는 중… (0/1)";
    if (previous && collected?.key === key && collected.result.truncated && collected.result.loadedPages < maxPages) {
      snapshot = { ...previous, collecting: true, progressText: statusText };
    }
    paint();
    updatePanel();
    try {
      const reusable = collected?.key === key && (!collected.result.truncated || collected.result.loadedPages >= maxPages);
      const result = reusable ? collected.result : await api.collectAll(variables, {
        signal: controller.signal, maxPages,
        onProgress(done, totalPages) {
          if (generation !== current) return;
          statusText = `검색 결과를 모으는 중… (${done}/${totalPages})`;
          if (snapshot) snapshot = { ...snapshot, collecting: true, progressText: statusText };
          paint();
          updatePanel();
        },
      });
      if (generation !== current) return;
      collected = { key, result };
      collecting = false;
      statusText = "";
      renderResults();
    } catch (error) {
      if (generation !== current || error.name === "AbortError") return;
      console.warn("[리디 검색 도우미] 결과 수집에 실패했어요", error);
      statusText = "결과를 가져오지 못했어요. 리디 원래 목록을 보여 드릴게요.";
      snapshot = null;
      paint();
      errorTimer = setTimeout(() => {
        if (generation !== current) return;
        statusText = "";
        view.unmount();
        mountedSection = null;
        updatePanel();
      }, 3000);
    } finally {
      if (generation === current) { collecting = false; updatePanel(); }
    }
  }

  async function update(change) {
    state = { ...state, ...await store.update(change) };
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
    state = { ...state, ...saved };
    initialized = true;
    store.subscribe((patch) => {
      state = { ...state, ...patch };
      recompute();
    });
    recompute();
  });
  ready.catch((error) => console.warn("[리디 검색 도우미] 설정을 읽지 못했어요", error));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "MARKDOWN_PROGRESS") {
      if (message.genrePath === core.parseFinderUrl(location.href).genrePath) {
        markdownStatus = `받는 중 ${message.done}/${message.total}`;
        updatePanel();
      }
      return false;
    }
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
