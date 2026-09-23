const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../src/core.js");
const source = fs.readFileSync(require.resolve("../content.js"), "utf8");
const href = "https://ridibooks.com/keyword-finder/bl?set_id=15&tag_ids=1-포함&page=1";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ excluded = { 2: "제외" }, deferred = false } = {}) {
  let saved = { helperEnabled: true, excludeModeOn: false, excludedTagMap: excluded };
  let subscribe;
  let listener;
  let tick;
  let rendered;
  let unmounts = 0;
  const events = {};
  const timers = new Map();
  const requests = [];
  const marks = [];
  const main = {};
  const section = {};
  const location = { href };
  const result = { items: Array.from({ length: 45 }, (_, i) => ({ tags: [{ id: i < 3 ? 2 : 3 }] })), total: 45, truncated: false };
  const window = {
    addEventListener(type, callback) { events[type] = callback; },
    RidiHelper: {
      core,
      store: {
        read: async () => saved,
        subscribe(callback) { subscribe = callback; },
        async update(change) {
          const patch = typeof change === "function" ? change(saved) : change;
          saved = { ...saved, ...patch };
          subscribe(patch);
          return saved;
        },
      },
      api: {
        cacheKey: (variables) => JSON.stringify(variables),
        collectAll(variables, options) {
          if (!deferred) { requests.push({ variables, options }); return Promise.resolve(result); }
          return new Promise((resolve, reject) => {
            requests.push({ variables, options, resolve, reject });
            options.signal.addEventListener("abort", () => reject(new DOMException("중단", "AbortError")), { once: true });
          });
        },
      },
      view: {
        setMode() {}, scrollToTop() {}, showStatus() {},
        markPanelTags(ids) { marks.push([...ids]); },
        mount: () => section,
        unmount() { unmounts++; },
        render(value) { rendered = value; },
      },
    },
  };
  const context = vm.createContext({ window, URL, AbortController, DOMException, location,
    history: { replaceState(state, title, value) { assert.equal(state, null); location.href = value; } },
    document: {
      querySelector: () => main,
      getElementById: () => ({ textContent: JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [
        { queryKey: ["KeywordFinderBooks", { genre: "BL", setId: 15, adultOption: "ONLY", tagAdultOption: "NONE", tagIds: [999], order: "REVIEW" }] },
      ] } } } }) }),
      addEventListener(type, callback) { events[type] = callback; },
    },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval(callback, ms) { assert.equal(ms, 300); tick = callback; },
    setTimeout(callback, ms) { const id = {}; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, console: { warn() {} },
  });
  vm.runInContext(source, context);
  return {
    requests, location, events, timers, marks, result,
    render: () => rendered, unmounts: () => unmounts, tick: () => tick(),
    message: (message) => new Promise((resolve) => listener(message, {}, resolve)),
    external: (patch) => { saved = { ...saved, ...patch }; subscribe(patch); },
  };
}

module.exports = async function runContentTests() {
  let passed = 0;
  async function test(name, run) { await run(); passed++; console.log(`통과: ${name}`); }
  await test("초기 변수와 현재 URL 조합·중복 재계산 방지·팝업 요약", async () => {
    const env = setup();
    await flush();
    const state = await env.message({ type: "GET_STATE" });
    assert.equal(state.summary.kept, 42);
    assert.equal(state.summary.removed, 3);
    assert.equal(state.collecting, false);
    assert.equal(env.requests[0].variables.adultOption, "ONLY");
    assert.equal(env.requests[0].variables.order, "RECENT");
    assert.deepEqual(env.requests[0].variables.tagIds, [1]);
    env.tick();
    env.events.popstate();
    await env.message({ type: "GET_STATE" });
    assert.equal(env.requests.length, 1);
  });
  await test("우리 페이지 이동·제외 변경·다른 탭 변경은 수집 결과 재사용", async () => {
    const env = setup();
    await flush();
    env.render().onPage(3);
    assert.equal(new URL(env.location.href).searchParams.get("page"), "3");
    assert.equal(env.render().paged.page, 3);
    assert.equal(env.render().paged.pageItems.length, 2);
    await env.message({ type: "SET_MODE", on: true });
    env.external({ excludedTagMap: { 3: "다른 제외" } });
    const state = await env.message({ type: "GET_STATE" });
    assert.equal(state.summary.kept, 3);
    assert.equal(env.render().paged.page, 1);
    assert.equal(env.requests.length, 1);
  });
  await test("도우미 끄기·제외 전체 삭제·포함과만 겹칠 때 원래 목록 복귀", async () => {
    const env = setup();
    await flush();
    await env.message({ type: "SET_ENABLED", on: false });
    assert.equal((await env.message({ type: "GET_STATE" })).summary, null);
    assert.ok(env.unmounts() > 0);
    assert.deepEqual(env.marks.at(-1), []);
    await env.message({ type: "SET_ENABLED", on: true });
    await env.message({ type: "CLEAR_EXCLUDED" });
    assert.equal((await env.message({ type: "GET_STATE" })).summary, null);
    env.external({ excludedTagMap: { 1: "포함" } });
    assert.equal((await env.message({ type: "GET_STATE" })).summary, null);
    assert.equal(env.requests.length, 1);
  });
  await test("URL 변경은 진행 중 수집 중단·오래된 결과 무시", async () => {
    const env = setup({ deferred: true });
    await flush();
    assert.equal((await env.message({ type: "GET_STATE" })).collecting, true);
    env.location.href += "&order=rating";
    env.tick();
    assert.equal(env.requests.length, 2);
    assert.equal(env.requests[0].options.signal.aborted, true);
    assert.equal(env.requests[1].variables.order, "RATING");
    env.requests[1].resolve(env.result);
    await flush();
    assert.equal((await env.message({ type: "GET_STATE" })).summary.kept, 42);
    assert.equal(env.render().href, env.location.href);
  });
  await test("수집 실패는 3초 뒤 복귀·검색 페이지 밖 메시지 거절", async () => {
    const env = setup({ deferred: true });
    await flush();
    env.requests[0].reject(new Error("리디 응답 오류"));
    await flush();
    const timer = [...env.timers.values()].find((entry) => entry.ms === 3000);
    assert.ok(timer);
    timer.callback();
    assert.ok(env.unmounts() > 0);
    assert.equal((await env.message({ type: "GET_STATE" })).collecting, false);
    env.location.href = "https://ridibooks.com/books/123";
    env.tick();
    assert.equal((await env.message({ type: "GET_STATE" })).ok, false);
  });
  await test("제외 모드의 새 태그만 클릭 차단·클릭 한 번에 저장", async () => {
    const env = setup({ excluded: {} });
    await flush();
    await env.message({ type: "SET_MODE", on: true });
    let stopped = 0;
    const link = { href: core.addTagToUrl(href, { id: 2, name: "제외" }) };
    function event(type) {
      return { type, target: { closest: () => link }, preventDefault() { stopped++; }, stopPropagation() {}, stopImmediatePropagation() {} };
    }
    env.events.pointerdown(event("pointerdown"));
    env.events.mousedown(event("mousedown"));
    assert.equal(Object.keys((await env.message({ type: "GET_STATE" })).excluded).length, 0);
    env.events.click(event("click"));
    await flush();
    assert.equal((await env.message({ type: "GET_STATE" })).excluded[2], "제외");
    assert.equal(stopped, 3);
    link.href = href;
    env.events.click(event("click"));
    assert.equal(stopped, 3);
    await env.message({ type: "SET_MODE", on: false });
    link.href = core.addTagToUrl(href, { id: 3, name: "보통 태그" });
    env.events.click(event("click"));
    assert.equal(stopped, 3);
  });
  return passed;
};
