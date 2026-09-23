importScripts("src/markdown.js");

(function () {
  const { markdown } = globalThis.RidiHelper;
  const pending = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function refresh(genrePath, task) {
    const slugs = markdown.genreSlugsFor(genrePath);
    const saved = (await chrome.storage.local.get("markdownCache")).markdownCache;
    if (!task.force && markdown.isFresh(saved, slugs)) return { ok: true, data: saved };
    const cache = saved?.version === 1 ? saved : { version: 1, fetchedAt: 0, events: {}, genres: {} };
    let done = 0;
    let total = 1;
    let partial = false;
    function progress() {
      for (const tabId of task.tabs) {
        chrome.tabs.sendMessage(tabId, { type: "MARKDOWN_PROGRESS", genrePath, done, total: Math.min(80, Math.max(done, total)) }).catch(() => {});
      }
    }
    async function request(path, parse) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (done >= 80) throw new Error("수집 상한에 도달했어요");
        await pause(Math.max(0, 300 - (Date.now() - lastRequestAt)));
        lastRequestAt = Date.now();
        try {
          const response = await fetch(`https://www.novel-calendar.com${path}`);
          if (!response.ok) throw new Error("할인 정보 응답 오류");
          return parse(await response.text());
        } catch (error) {
          if (attempt === 1) throw error;
          total++;
        } finally {
          lastRequestAt = Date.now();
          done++;
          progress();
        }
      }
    }
    const found = new Map();
    let page = 1;
    for (let count = 0; count < 3; count++) {
      const events = await request(page === 1 ? "/markdown/events" : `/markdown/events/page-${page}`, (html) => markdown.parseEventsHtml(html, page));
      if (!events.length) throw new Error("행사 목록을 읽지 못했어요");
      for (const event of events) found.set(event.slug, event);
      const matching = [...found.values()].filter((event) => slugs.some((slug) => event.genres.includes(markdown.genreNames[slug])));
      if (matching.length >= 5 || !events.nextPage || events.nextPage <= page) break;
      page = events.nextPage;
      total++;
    }
    const events = [...found.values()].filter((event) => slugs.some((slug) => event.genres.includes(markdown.genreNames[slug])))
      .sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || b.start.localeCompare(a.start)).slice(0, 5)
      .sort((a, b) => b.start.localeCompare(a.start));
    if (!events.length) throw new Error("이 장르의 행사가 없어요");
    const genres = Object.fromEntries(slugs.map((slug) => [slug, { fetchedAt: 0, byBook: {}, recommended: {} }]));
    const completed = [];
    let stop = false;
    total += events.reduce((sum, event) => sum + slugs.filter((slug) => event.genres.includes(markdown.genreNames[slug])).length, 0);
    for (const event of events) {
      const eventGenres = slugs.filter((slug) => event.genres.includes(markdown.genreNames[slug]));
      const buffers = {};
      try {
        for (const slug of eventGenres) {
          const path = `/markdown/${encodeURIComponent(event.slug)}/${slug}`;
          const first = await request(`${path}?page=1`, markdown.parseLineupHtml);
          const pageCount = first.pageCount || 1;
          const remaining = pageCount - 1 + (event.ongoing ? 1 : 0);
          total += remaining;
          if (done + remaining > 80) { stop = true; throw new Error("수집 상한에 도달했어요"); }
          const items = first.items.slice();
          for (let n = 2; n <= pageCount; n++) items.push(...(await request(`${path}?page=${n}`, markdown.parseLineupHtml)).items);
          const recommended = event.ongoing ? (await request(`/markdown/${encodeURIComponent(event.slug)}/recommendation/${slug}`, markdown.parseLineupHtml)).items.map((item) => item.ridiId) : [];
          buffers[slug] = { items, recommended };
        }
        for (const [slug, buffer] of Object.entries(buffers)) {
          for (const item of buffer.items) {
            if (!Number.isFinite(item.discountRate)) continue;
            const book = genres[slug].byBook[item.ridiId] ||= {};
            book[event.slug] = [item.discountRate, Number.isFinite(item.purchasePrice) ? item.purchasePrice : null];
          }
          if (event.ongoing) genres[slug].recommended[event.slug] = [...new Set(buffer.recommended)];
        }
        completed.push(event);
      } catch (error) {
        partial = true;
        console.warn("[리디 검색 도우미] 행사를 건너뛰었어요", event.slug, error);
        if (stop || done >= 80) break;
      }
    }
    if (!completed.length) throw new Error("할인 정보를 가져오지 못했어요");
    const now = Date.now();
    for (const genre of Object.values(genres)) genre.fetchedAt = now;
    cache.genres = { ...cache.genres, ...genres };
    // 끝난 행사가 다른 장르의 기록에서 진행 중으로 남지 않게 갱신해요.
    for (const event of found.values()) {
      if (cache.events[event.slug] || completed.some((entry) => entry.slug === event.slug)) {
        cache.events[event.slug] = { name: event.name, start: event.start, end: event.end, ongoing: event.ongoing };
      }
    }
    const used = new Set();
    for (const genre of Object.values(cache.genres)) {
      for (const book of Object.values(genre.byBook)) for (const slug of Object.keys(book)) used.add(slug);
      for (const slug of Object.keys(genre.recommended)) used.add(slug);
    }
    for (const slug of Object.keys(cache.events)) if (!used.has(slug)) delete cache.events[slug];
    cache.fetchedAt = now;
    await chrome.storage.local.set({ markdownCache: cache });
    return { ok: true, data: cache, partial };
  }

  async function get(genrePath, force, tabId) {
    const slugs = markdown.genreSlugsFor(genrePath);
    if (!slugs.length) return { ok: false, reason: "unsupported" };
    if (!force) {
      const saved = (await chrome.storage.local.get("markdownCache")).markdownCache;
      if (markdown.isFresh(saved, slugs)) return { ok: true, data: saved };
    }
    let task = pending.get(genrePath);
    if (!task) {
      task = { force, tabs: new Set() };
      pending.set(genrePath, task);
      task.promise = queue.then(() => refresh(genrePath, task)).catch(() => ({ ok: false, reason: "failed" }))
        .finally(() => pending.delete(genrePath));
      queue = task.promise;
    }
    if (Number.isInteger(tabId)) task.tabs.add(tabId);
    return task.promise;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["MARKDOWN_GET", "MARKDOWN_REFRESH"].includes(message?.type)) return false;
    get(message.genrePath, message.type === "MARKDOWN_REFRESH", sender.tab?.id).then(sendResponse, () => sendResponse({ ok: false, reason: "failed" }));
    return true;
  });
})();
