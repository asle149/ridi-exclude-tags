const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../src/api.js"), "utf8");
const variables = { genre: "BL", setId: 15, order: "RECENT", adultOption: "NONE", tagAdultOption: "NONE", tagIds: [2, 1] };
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ total = 601, fail = () => false } = {}) {
  const calls = [];
  const retryDelays = [];
  let active = 0;
  let maximum = 0;
  let now = 1000;
  const context = vm.createContext({ window: {}, AbortController, DOMException, queueMicrotask,
    console: { warn() {} }, Date: { now: () => now }, clearTimeout,
    setTimeout(callback, delay) { retryDelays.push(delay); return setTimeout(callback, 0); },
    async fetch(url, options) {
      assert.equal(url, "/graphql");
      assert.equal(options.credentials, "include");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["content-type"], "application/json");
      const body = JSON.parse(options.body);
      assert.equal(body.operationName, "KeywordFinderBooks");
      assert.equal(body.variables.pageLimitInput.limit, 200);
      const page = body.variables.pageLimitInput.page;
      calls.push(body.variables);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { options.signal.removeEventListener("abort", cancel); resolve(); }, 5);
          function cancel() { clearTimeout(timer); reject(new DOMException("중단", "AbortError")); }
          options.signal.addEventListener("abort", cancel, { once: true });
          if (options.signal.aborted) cancel();
        });
        const failure = fail(page, calls.length);
        if (failure === "network") throw new Error("연결 실패");
        if (failure === "http") return { ok: false };
        if (failure === "graphql") return { ok: true, json: async () => ({ errors: [{ message: "실패" }] }) };
        return { ok: true, json: async () => ({ data: { keywordFinderBooks: {
          totalItemCount: total,
          items: Array.from({ length: Math.max(0, Math.min(200, total - (page - 1) * 200)) }, (_, i) => ({ id: (page - 1) * 200 + i })),
        } } }) };
      } finally { active--; }
    },
  });
  vm.runInContext(source, context);
  return { api: context.window.RidiHelper.api, calls, retryDelays, maximum: () => maximum, active: () => active,
    advance: (ms) => { now += ms; } };
}

module.exports = async function runApiTests() {
  let passed = 0;
  async function test(name, run) {
    await run();
    passed++;
    console.log(`통과: ${name}`);
  }
  await test("전체 페이지 수집·원래 순서·동시 요청 2개·진행률", async () => {
    const env = setup();
    const progress = [];
    const result = await env.api.collectAll(variables, { onProgress: (done, total) => progress.push([done, total]) });
    assert.equal(result.items.length, 601);
    assert.equal(result.total, 601);
    assert.equal(result.truncated, false);
    assert.equal(env.maximum(), 2);
    assert.deepEqual(env.calls.map((call) => call.pageLimitInput.page), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(result.items, (item) => item.id), Array.from({ length: 601 }, (_, i) => i));
    assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  });
  await test("3,000개 상한·15페이지만 요청", async () => {
    const env = setup({ total: 3100 });
    const result = await env.api.collectAll(variables);
    assert.equal(result.items.length, 3000);
    assert.equal(result.total, 3100);
    assert.equal(result.truncated, true);
    assert.equal(env.calls.length, 15);
    assert.equal(env.maximum(), 2);
  });
  await test("15페이지 캐시 뒤 30페이지 요청은 16페이지부터 이어 받음", async () => {
    const env = setup({ total: 12802 });
    assert.equal((await env.api.collectAll(variables)).loadedPages, 15);
    const result = await env.api.collectAll(variables, { maxPages: 30 });
    assert.equal(result.items.length, 6000);
    assert.equal(result.loadedPages, 30);
    assert.deepEqual(env.calls.slice(15).map((call) => call.pageLimitInput.page), Array.from({ length: 15 }, (_, i) => i + 16));
    assert.equal(env.maximum(), 2);
  });
  await test("이어 받기 절대 상한 75페이지·동시 요청도 페이지 공유", async () => {
    const env = setup({ total: 16000 });
    const [first, second] = await Promise.all([env.api.collectAll(variables), env.api.collectAll(variables, { maxPages: 100 })]);
    assert.equal(first.loadedPages, 15);
    assert.equal(second.loadedPages, 75);
    assert.equal(second.items.length, 15000);
    assert.equal(second.truncated, true);
    assert.equal(env.calls.length, 75);
  });
  await test("0개 결과는 첫 페이지만 요청", async () => {
    const env = setup({ total: 0 });
    const result = await env.api.collectAll(variables);
    assert.equal(result.items.length, 0);
    assert.equal(env.calls.length, 1);
  });
  await test("태그 순서가 다른 같은 조건·진행 중 요청·완료 캐시 공유", async () => {
    const env = setup();
    const [first, second] = await Promise.all([
      env.api.collectAll(variables), env.api.collectAll({ ...variables, tagIds: [1, 2] }),
    ]);
    assert.strictEqual(first, second);
    assert.equal(env.calls.length, 4);
    assert.strictEqual(await env.api.collectAll(variables), first);
    assert.equal(env.calls.length, 4);
    env.advance(10 * 60 * 1000);
    await env.api.collectAll(variables);
    assert.equal(env.calls.length, 8);
  });
  await test("조건별 캐시 분리·서로 다른 수집도 동시 요청 총 2개", async () => {
    const env = setup();
    await Promise.all([env.api.collectAll(variables), env.api.collectAll({ ...variables, order: "RATING" })]);
    assert.equal(env.calls.length, 8);
    assert.equal(env.maximum(), 2);
    const key = env.api.cacheKey(variables);
    for (const [field, value] of Object.entries({ genre: "ROMANCE", setId: 9, order: "REVIEW", adultOption: "ONLY", tagAdultOption: "ONLY", tagIds: [8] })) {
      assert.notEqual(env.api.cacheKey({ ...variables, [field]: value }), key);
    }
  });
  await test("이미 중단된 요청은 서버를 호출하지 않음", async () => {
    const env = setup();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(env.api.collectAll(variables, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(env.calls.length, 0);
  });
  await test("수집 중 중단·새 조건 전환 시 동시 요청 제한", async () => {
    const env = setup();
    const controller = new AbortController();
    const result = env.api.collectAll(variables, { signal: controller.signal, onProgress(done) { if (done === 1) controller.abort(); } });
    await assert.rejects(result, { name: "AbortError" });
    await env.api.collectAll({ ...variables, order: "RATING" });
    assert.ok(env.maximum() <= 2);
    assert.equal(env.active(), 0);
  });
  await test("한 구독자의 중단은 다른 구독자의 수집을 유지", async () => {
    const env = setup();
    const controller = new AbortController();
    const first = env.api.collectAll(variables, { signal: controller.signal });
    const second = env.api.collectAll(variables);
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal((await second).items.length, 601);
    assert.equal(env.calls.length, 4);
  });
  await test("같은 조건으로 즉시 교체하면 진행 중 수집을 이어서 사용", async () => {
    const env = setup();
    const controller = new AbortController();
    const first = env.api.collectAll(variables, { signal: controller.signal });
    controller.abort();
    const second = env.api.collectAll(variables);
    await assert.rejects(first, { name: "AbortError" });
    await second;
    assert.equal(env.calls.length, 4);
  });
  await test("HTTP·쿼리·연결 오류는 500ms 뒤 한 번만 재시도", async () => {
    for (const failure of ["http", "graphql", "network"]) {
      const env = setup({ fail: () => failure });
      await assert.rejects(env.api.collectAll(variables), { message: "리디 응답 오류" });
      assert.equal(env.calls.length, 2);
      assert.deepEqual(env.retryDelays, [500]);
    }
  });
  await test("일시 오류는 재시도 후 성공·실패한 결과는 캐시하지 않음", async () => {
    const env = setup({ total: 20, fail: (page, count) => count <= 2 ? "http" : false });
    await assert.rejects(env.api.collectAll(variables), { message: "리디 응답 오류" });
    assert.equal((await env.api.collectAll(variables)).items.length, 20);
    const transient = setup({ total: 20, fail: (page, count) => count === 1 ? "http" : false });
    assert.equal((await transient.api.collectAll(variables)).items.length, 20);
    assert.equal(transient.calls.length, 2);
  });
  await test("중간 페이지 실패는 다른 작업도 멈추고 오류 전달", async () => {
    const env = setup({ fail: (page) => page === 2 ? "graphql" : false });
    await assert.rejects(env.api.collectAll(variables), { message: "리디 응답 오류" });
    await pause();
    assert.equal(env.active(), 0);
    assert.ok(env.maximum() <= 2);
  });
  return passed;
};
