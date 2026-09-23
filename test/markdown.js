const assert = require("node:assert/strict");
const fs = require("node:fs");
const markdown = require("../src/markdown.js");
const fixture = (name) => fs.readFileSync(`${__dirname}/fixtures/novel-calendar-${name}.html`, "utf8");

module.exports = function runMarkdownTests() {
  let passed = 0;
  function test(name, run) { run(); passed++; console.log(`통과: ${name}`); }
  test("실제 라인업·추천 청크 파싱·페이지 수·픽스처 크기", () => {
    const lineup = markdown.parseLineupHtml(fixture("lineup-last"));
    assert.equal(lineup.items.length, 75);
    assert.equal(lineup.pageCount, 15);
    assert.equal(typeof lineup.items[0].ridiId, "number");
    assert.equal(lineup.items[0].discountRate, 50);
    assert.equal(lineup.items[0].purchasePrice, 12600);
    assert.equal(lineup.items[0].eventId, "2026-09");
    assert.equal(markdown.parseLineupHtml(fixture("recommendation")).items.length, 100);
    for (const name of ["events", "lineup-last", "recommendation"]) assert.ok(Buffer.byteLength(fixture(name)) <= 120 * 1024);
  });
  test("여러 청크에 걸친 배열·괄호와 따옴표·중복 작품", () => {
    const item = { ridi_id: 123, title: '괄호 ] [ 와 "따옴표"\n줄', discount_rate: 30 };
    const source = JSON.stringify({ items: [item, item] });
    const html = [source.slice(0, 25), source.slice(25)].map((part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`).join("");
    assert.equal(markdown.unescapeRsc(html), source);
    assert.equal(markdown.parseLineupHtml(html).items.length, 1);
    assert.equal(markdown.parseLineupHtml(html).items[0].title, item.title);
    assert.throws(() => markdown.parseLineupHtml("<html>오류</html>"));
  });
  test("실제 행사 카드·기간·장르·중복·다음 페이지", () => {
    const events = markdown.parseEventsHtml(fixture("events"));
    assert.deepEqual(events[0], { slug: "2026-09", name: "2026 리디 뿌리를 찾아서", start: "2026-09-23", end: "2026-10-05",
      ongoing: true, genres: ["로맨스", "로판", "BL소설", "판타지"], count: 6130 });
    assert.deepEqual(events.find((event) => event.slug === "2026-02-100y").genres, ["BL소설"]);
    assert.equal(markdown.parseEventsHtml(fixture("events") + fixture("events")).length, events.length);
    assert.equal(markdown.parseEventsHtml('<a href="/markdown/events/page-2">2</a><a href="/markdown/events/page-3">3</a>', 2).nextPage, 3);
  });
  const events = Object.fromEntries([["may", "2026-05-01", false], ["july", "2026-07-14", false], ["now", "2026-09-23", true]]
    .map(([slug, start, ongoing]) => [slug, { start, end: "2026-10-05", ongoing, name: "2026 리디 뿌리를 찾아서" }]));
  const label = (rates) => markdown.discountLabel(rates.map((rate, i) => ({ eventSlug: ["may", "july", "now"][3 - rates.length + i], rate })), events);
  test("할인 상승", () => { assert.equal(label([30, 50]).text, "행사 30→50% · 최대"); assert.equal(label([30, 50]).delta, 20); });
  test("할인 동일", () => { assert.equal(label([50, 30, 30]).text, "행사 30=30%"); assert.equal(label([50, 30, 30]).delta, 0); });
  test("할인 하락", () => { assert.equal(label([50, 30]).text, "행사 50→30%"); assert.equal(label([50, 30]).isMax, false); });
  test("할인 첫 기록", () => { assert.equal(label([50]).text, "행사 50% · 첫 기록"); assert.equal(label([50]).delta, null); assert.equal(label([50]).isMax, true); });
  test("할인 기록 내 최대", () => { assert.equal(label([30, 40, 50]).isMax, true); assert.equal(label([30, 40, 50]).strong, "50%"); });
  test("할인 공동 최대", () => { assert.equal(label([50, 30, 50]).text, "행사 30→50% · 공동 최대"); assert.equal(label([30, 30]).text, "행사 30=30% · 공동 최대"); });
  test("진행 중 행사 미참여", () => { assert.equal(markdown.discountLabel([{ eventSlug: "july", rate: 30 }], events), null); });
  test("할인 툴팁·날짜순 비교", () => {
    assert.equal(label([30, 30, 50]).title, "2026 리디 뿌리를 찾아서 참여 (9/23~10/5)\n2026년 5월 30% · 7월 30% · 이번 50%\n직전보다 20%p 증가 · 기록 내 최대 할인");
    assert.equal(markdown.discountLabel([{ eventSlug: "now", rate: 50 }, { eventSlug: "may", rate: 30 }], events).delta, 20);
  });
  test("리디 네 장르 대응", () => {
    assert.deepEqual(markdown.genreSlugsFor("bl"), ["bl-novel"]);
    assert.deepEqual(markdown.genreSlugsFor("romance"), ["romance", "romance-fantasy"]);
    assert.deepEqual(markdown.genreSlugsFor("fantasy"), ["fantasy"]);
    assert.deepEqual(markdown.genreSlugsFor("comic"), []);
  });
  const now = Date.parse("2026-09-23T12:00:00+09:00");
  const cache = { version: 1, events, genres: { "bl-novel": { fetchedAt: now, recommended: { now: [] } } } };
  test("24시간 이내 캐시는 행사 유무와 관계없이 신선함", () => {
    assert.equal(markdown.isFresh(cache, ["bl-novel"], now), true);
    assert.equal(markdown.isFresh({ ...cache, events: {} }, ["bl-novel"], now), true);
  });
  test("기한 만료·장르 누락 캐시는 갱신", () => {
    assert.equal(markdown.isFresh(cache, ["bl-novel"], now + 86400000), false);
    assert.equal(markdown.isFresh(cache, ["fantasy"], now), false);
  });
  return passed;
};
