(function () {
  const QUERY = `query KeywordFinderBooks($tagIds: [Int!]!, $setId: Int!, $genre: KeywordFinderGenre!, $order: KeywordFinderOrder, $adultOption: AdultOption!, $pageLimitInput: PageLimitInput!, $tagAdultOption: AdultOption) {
    keywordFinderBooks(order: $order, tagIds: $tagIds, adultOption: $adultOption, pageLimitInput: $pageLimitInput, setId: $setId, genre: $genre, tagAdultOption: $tagAdultOption) {
      items {
        bookShell {
          badges { text type backgroundColors { light dark } }
          book {
            id
            title { main }
            authors { name role }
            publicationInfo { name }
            ratings { rating count }
            set { totalCount }
            isAdultOnly
            priceInfo { purchase { fullPrice sellingPrice discountRate } }
          }
        }
        tags { id name }
      }
      totalItemCount
    }
  }`;
  const cache = new Map();
  const pending = new Map();
  const TTL = 10 * 60 * 1000;
  let activeRequests = 0;
  const waiters = [];
  const abortError = () => new DOMException("수집을 중단했어요", "AbortError");
  const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };

  function cacheKey(variables) {
    return [variables.genre, variables.setId, variables.order, variables.adultOption, variables.tagAdultOption,
      [...variables.tagIds].sort((a, b) => a - b).join(",")].join("|");
  }

  function acquire(signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const entry = { start, cancel };
      function start() {
        signal.removeEventListener("abort", cancel);
        activeRequests++;
        resolve();
      }
      function cancel() {
        const index = waiters.indexOf(entry);
        if (index !== -1) waiters.splice(index, 1);
        reject(abortError());
      }
      if (activeRequests < 2) start();
      else {
        waiters.push(entry);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
  }

  function release() {
    activeRequests--;
    waiters.shift()?.start();
  }

  function delay(signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, 500);
      function cancel() {
        clearTimeout(timer);
        reject(abortError());
      }
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  async function requestPage(variables, page, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      checkAbort(signal);
      await acquire(signal);
      try {
        checkAbort(signal);
        const response = await fetch("/graphql", {
          method: "POST", credentials: "include", signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationName: "KeywordFinderBooks", query: QUERY,
            variables: { ...variables, pageLimitInput: { limit: 200, page } } }),
        });
        if (!response.ok) throw new Error("리디 응답 오류");
        const json = await response.json();
        const data = json.data?.keywordFinderBooks;
        if (json.errors || !Array.isArray(data?.items) || !Number.isFinite(data.totalItemCount) || data.totalItemCount < 0) {
          throw new Error("리디 응답 오류");
        }
        return data;
      } catch (error) {
        if (signal.aborted || error.name === "AbortError") throw abortError();
        if (attempt === 1) throw new Error("리디 응답 오류");
        console.warn("[리디 검색 도우미] 응답을 받지 못해 한 번 더 요청해요");
      } finally {
        release();
      }
      await delay(signal);
    }
  }

  function resultFor(entry, maxPages) {
    const loadedPages = Math.min(maxPages, Math.max(1, Math.ceil(entry.total / 200)));
    if (entry.results.has(loadedPages)) return entry.results.get(loadedPages);
    const result = { items: entry.pages.slice(0, loadedPages).flat(), total: entry.total,
      truncated: entry.total > loadedPages * 200, loadedPages };
    entry.results.set(loadedPages, result);
    return result;
  }

  async function collect(variables, task, entry, maxPages) {
    const signal = task.controller.signal;
    try {
      if (!entry.pages[0]) {
        const first = await requestPage(variables, 1, signal);
        entry.pages[0] = first.items;
        entry.total = first.totalItemCount;
      }
      const totalPages = Math.min(maxPages, Math.max(1, Math.ceil(entry.total / 200)));
      let nextPage = 2;
      let done = entry.pages.slice(0, totalPages).filter(Boolean).length;
      function progress() {
        task.progress = [done, totalPages];
        for (const subscriber of task.subscribers) subscriber.onProgress?.(done, totalPages);
      }
      progress();
      async function worker() {
        while (nextPage <= totalPages) {
          checkAbort(signal);
          const page = nextPage++;
          if (entry.pages[page - 1]) continue;
          const data = await requestPage(variables, page, signal);
          entry.pages[page - 1] = data.items;
          done++;
          progress();
        }
      }
      await Promise.all([worker(), worker()]);
      checkAbort(signal);
      entry.time = Date.now();
      return resultFor(entry, maxPages);
    } catch (error) {
      task.controller.abort();
      throw error;
    }
  }

  function collectAll(variablesBase, { signal, onProgress, maxPages = 15 } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    maxPages = Math.min(75, Math.max(1, Math.trunc(Number(maxPages)) || 15));
    const key = cacheKey(variablesBase);
    const now = Date.now();
    for (const [entryKey, entry] of cache) if (now - entry.time >= TTL && !pending.has(entryKey)) cache.delete(entryKey);
    let entry = cache.get(key);
    if (!entry) {
      entry = { time: now, pages: [], total: null, results: new Map() };
      cache.set(key, entry);
    }
    const needed = Math.min(maxPages, Math.max(1, Math.ceil(entry.total / 200)));
    if (entry.total !== null && Array.from({ length: needed }, (_, i) => entry.pages[i]).every(Boolean)) {
      return Promise.resolve(resultFor(entry, maxPages));
    }
    let task = pending.get(key);
    if (!task || task.controller.signal.aborted) {
      task = { controller: new AbortController(), subscribers: new Set(), progress: null };
      pending.set(key, task);
      task.promise = collect(variablesBase, task, entry, maxPages).finally(() => {
        if (pending.get(key) === task) pending.delete(key);
      });
    }
    const shared = task;
    return new Promise((resolve, reject) => {
      const subscriber = { onProgress };
      shared.subscribers.add(subscriber);
      function cleanup() {
        signal?.removeEventListener("abort", cancel);
        shared.subscribers.delete(subscriber);
      }
      function cancel() {
        cleanup();
        reject(abortError());
        // 같은 조건으로 화면만 바뀌면 진행 중인 수집을 이어서 써요.
        queueMicrotask(() => {
          if (!shared.subscribers.size) shared.controller.abort();
        });
      }
      signal?.addEventListener("abort", cancel, { once: true });
      if (shared.progress) onProgress?.(...shared.progress);
      shared.promise.then((result) => {
        cleanup();
        if (result.truncated && result.loadedPages < maxPages) {
          resolve(collectAll(variablesBase, { signal, onProgress, maxPages }));
        } else resolve(result);
      }, (error) => { cleanup(); reject(error); });
    });
  }

  window.RidiHelper = window.RidiHelper || {};
  window.RidiHelper.api = { collectAll, cacheKey };
})();
