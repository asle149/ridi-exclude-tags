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

  async function collect(variables, task) {
    const signal = task.controller.signal;
    try {
      const first = await requestPage(variables, 1, signal);
      const totalPages = Math.min(15, Math.max(1, Math.ceil(first.totalItemCount / 200)));
      const pages = [first.items];
      let nextPage = 2;
      let done = 1;
      function progress() {
        task.progress = [done, totalPages];
        for (const subscriber of task.subscribers) subscriber.onProgress?.(done, totalPages);
      }
      progress();
      async function worker() {
        while (nextPage <= totalPages) {
          checkAbort(signal);
          const page = nextPage++;
          const data = await requestPage(variables, page, signal);
          pages[page - 1] = data.items;
          done++;
          progress();
        }
      }
      await Promise.all([worker(), worker()]);
      checkAbort(signal);
      return { items: pages.flat().slice(0, 3000), total: first.totalItemCount, truncated: first.totalItemCount > 3000 };
    } catch (error) {
      task.controller.abort();
      throw error;
    }
  }

  function collectAll(variablesBase, { signal, onProgress } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const key = cacheKey(variablesBase);
    const now = Date.now();
    for (const [entryKey, entry] of cache) if (now - entry.time >= TTL) cache.delete(entryKey);
    if (cache.has(key)) return Promise.resolve(cache.get(key).result);
    let task = pending.get(key);
    if (!task || task.controller.signal.aborted) {
      task = { controller: new AbortController(), subscribers: new Set(), progress: null };
      pending.set(key, task);
      task.promise = collect(variablesBase, task).then((result) => {
        cache.set(key, { time: Date.now(), result });
        return result;
      }).finally(() => {
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
      shared.promise.then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
    });
  }

  window.RidiHelper = window.RidiHelper || {};
  window.RidiHelper.api = { collectAll, cacheKey };
})();
