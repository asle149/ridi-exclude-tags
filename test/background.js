const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const markdown = require("../src/markdown.js");
const source = fs.readFileSync(require.resolve("../background.js"), "utf8");
const eventFixture = fs.readFileSync(`${__dirname}/fixtures/novel-calendar-events.html`, "utf8");

function setup({ pages = 2, fail = () => false } = {}) {
  let saved;
  let listener;
  let now = Date.parse("2026-09-23T12:00:00+09:00");
  let active = 0;
  let maximum = 0;
  const requests = [];
  const progress = [];
  const context = vm.createContext({ importScripts() {}, RidiHelper: { markdown: { ...markdown,
    isFresh: (cache, slugs) => markdown.isFresh(cache, slugs, now) } }, Date: { now: () => now },
    setTimeout(callback, ms) { now += ms; queueMicrotask(callback); }, console: { warn() {} },
    chrome: {
      storage: { local: { async get() { return { markdownCache: saved && JSON.parse(JSON.stringify(saved)) }; },
        async set(value) { saved = JSON.parse(JSON.stringify(value.markdownCache)); } } },
      tabs: { async sendMessage(id, message) { progress.push({ id, ...message }); } },
      runtime: { onMessage: { addListener(callback) { listener = callback; } } },
    },
    async fetch(url, options) {
      assert.equal(options?.cache, undefined);
      requests.push({ url, time: now });
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      if (fail(url)) return { ok: false };
      if (url.endsWith("/events")) return { ok: true, text: async () => eventFixture };
      const slug = url.split("/markdown/")[1].split("/")[0];
      const item = { ridi_id: 123, title: "저장하지 않을 제목", author: "저장하지 않을 작가", event_id: slug, discount_rate: 50, purchase_price: 1000 };
      const html = `<a href="?page=${pages}">${pages}</a><script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ items: [item] }))}])</script>`;
      return { ok: true, text: async () => html };
    },
  });
  vm.runInContext(source, context);
  return { requests, progress, saved: () => saved, maximum: () => maximum,
    message: (genrePath = "bl", type = "MARKDOWN_GET", id = 1) => new Promise((resolve) => listener({ type, genrePath }, { tab: { id } }, resolve)) };
}

module.exports = async function runBackgroundTests() {
  let passed = 0;
  async function test(name, run) { await run(); passed++; console.log(`통과: ${name}`); }
  await test("할인 수집은 순차·300ms 간격·최근 5개·진행 중 추천만", async () => {
    const env = setup();
    const response = await env.message();
    assert.equal(response.ok, true);
    assert.equal(env.maximum(), 1);
    assert.equal(env.requests.length, 12);
    for (let i = 1; i < env.requests.length; i++) assert.ok(env.requests[i].time - env.requests[i - 1].time >= 300);
    assert.equal(env.requests.filter((request) => request.url.includes("/recommendation/")).length, 1);
    assert.equal(Object.keys(env.saved().events).length, 5);
    assert.deepEqual(env.saved().genres["bl-novel"].byBook[123]["2026-09"], [50, 1000]);
    assert.equal(JSON.stringify(env.saved()).includes("저장하지 않을"), false);
    assert.equal(env.progress.at(-1).done, 12);
  });
  await test("여러 탭은 한 수집 공유·각 탭 진행 전달·24시간 캐시·강제 갱신", async () => {
    const env = setup();
    const responses = await Promise.all([env.message("bl", "MARKDOWN_GET", 1), env.message("bl", "MARKDOWN_GET", 2)]);
    assert.ok(responses.every((response) => response.ok));
    assert.equal(env.requests.length, 12);
    assert.deepEqual([...new Set(env.progress.map((message) => message.id))], [1, 2]);
    await env.message();
    assert.equal(env.requests.length, 12);
    await env.message("bl", "MARKDOWN_REFRESH");
    assert.equal(env.requests.length, 24);
  });
  await test("할인 80페이지 상한은 오래된 행사부터 제외", async () => {
    const env = setup({ pages: 30 });
    const response = await env.message();
    assert.equal(response.ok, true);
    assert.equal(response.partial, true);
    assert.ok(env.requests.length <= 80);
    assert.deepEqual(Object.keys(env.saved().events), ["2026-09", "2026-07"]);
    assert.equal(env.requests.some((request) => request.url.includes("2026-02")), false);
  });
  await test("실패 페이지 1회 재시도·그 행사 전체 제외·나머지 계속", async () => {
    const env = setup({ fail: (url) => url.includes("2026-07") && url.endsWith("page=2") });
    const response = await env.message();
    assert.equal(response.ok, true);
    assert.equal(response.partial, true);
    assert.equal(env.requests.filter((request) => request.url.includes("2026-07") && request.url.endsWith("page=2")).length, 2);
    assert.equal(env.saved().events["2026-07"], undefined);
    assert.ok(env.saved().events["2026-02"]);
  });
  await test("로맨스 두 장르도 순차·장르 없는 행사는 건너뜀", async () => {
    const env = setup({ pages: 1 });
    assert.equal((await env.message("romance")).ok, true);
    assert.deepEqual(Object.keys(env.saved().genres), ["romance", "romance-fantasy"]);
    assert.equal(env.requests.some((request) => request.url.includes("2026-02-100y")), false);
    assert.equal(env.maximum(), 1);
  });
  await test("미지원 장르는 요청 없음·전체 실패 응답", async () => {
    const env = setup({ fail: () => true });
    assert.equal((await env.message("comic")).reason, "unsupported");
    assert.equal(env.requests.length, 0);
    assert.equal((await env.message()).reason, "failed");
    assert.equal(env.requests.length, 2);
    assert.equal(env.saved(), undefined);
  });
  return passed;
};
