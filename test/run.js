const assert = require("node:assert/strict");
const core = require("../src/core.js");
const runApiTests = require("./api.js");
const runContentTests = require("./content.js");
let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log(`통과: ${name}`);
}
const baseUrl = "https://ridibooks.com/keyword-finder/bl?set_id=15";

test("태그 없는 주소와 기본 페이지·정렬", () => {
  assert.deepEqual(core.parseFinderUrl(baseUrl), {
    genrePath: "bl", setId: 15, tags: [], page: 1, orderParam: "", order: "RECENT",
  });
});
test("태그 한 개와 인코딩된 한글", () => {
  assert.deepEqual(core.parseFinderUrl(`${baseUrl}&tag_ids=3832-%EC%84%B8%ED%8A%B8`).tags, [{ id: 3832, name: "세트" }]);
});
test("태그 두 개·중복 제거·배열 형식·이름 없음", () => {
  assert.deepEqual(core.parseFinderUrl(`${baseUrl}&tag_ids=3832-세트&tag_ids[]=1234&tag_ids=3832-중복`).tags,
    [{ id: 3832, name: "세트" }, { id: 1234, name: "" }]);
  assert.deepEqual(core.parseFinderUrl(`${baseUrl}&tag_ids%5B%5D=99-%EC%9E%91%EA%B0%80`).tags, [{ id: 99, name: "작가" }]);
});
test("페이지 3·판매순·모든 정렬·알 수 없는 값", () => {
  const parsed = core.parseFinderUrl(`${baseUrl}&page=3&order=selling`);
  assert.equal(parsed.page, 3);
  assert.equal(parsed.order, "POPULARITY");
  assert.equal(core.orderToEnum("rating"), "RATING");
  assert.equal(core.orderToEnum("review_cnt"), "REVIEW");
  for (const value of ["recent", "unknown", "toString", undefined]) assert.equal(core.orderToEnum(value), "RECENT");
  for (const value of ["0", "-1", "no", "2.5"]) assert.equal(core.parseFinderUrl(`${baseUrl}&page=${value}`).page, 1);
});
test("잘못 인코딩된 이름·잘못된 태그", () => {
  assert.deepEqual(core.parseFinderUrl(`${baseUrl}&tag_ids=9-name%25oops&tag_ids=nope`).tags, [{ id: 9, name: "name%oops" }]);
});
test("요청 변수는 주소의 현재 태그·정렬·세트를 사용", () => {
  assert.deepEqual(core.buildVariables(core.parseFinderUrl(`${baseUrl}&tag_ids=8-태그&order=rating`), {
    genre: "BL", adultOption: "ONLY", tagAdultOption: "NONE", setId: 99,
  }), { genre: "BL", setId: 15, adultOption: "ONLY", tagAdultOption: "NONE", order: "RATING", tagIds: [8] });
  assert.deepEqual(core.buildVariables(core.parseFinderUrl(baseUrl)), {
    genre: "BL", setId: 15, adultOption: "NONE", tagAdultOption: "NONE", order: "RECENT", tagIds: [],
  });
});
const items = [{ tags: [{ id: 1 }, { id: 2 }] }, { tags: [{ id: 2 }] }, { tags: [{ id: 3 }] }];
test("제외 태그 한 개의 결과와 집계", () => {
  assert.deepEqual(core.filterItems(items, new Set([1]), new Set()), {
    kept: items.slice(1), removedCount: 1, perTag: { 1: 1 }, ignoredExcluded: [],
  });
});
test("한 작품의 제외 태그 두 개는 작품 한 번·태그별로 집계", () => {
  assert.deepEqual(core.filterItems([items[0]], new Set([1, 2]), new Set()), {
    kept: [], removedCount: 1, perTag: { 1: 1, 2: 1 }, ignoredExcluded: [],
  });
});
test("포함 조건과 겹친 제외는 무시", () => {
  assert.deepEqual(core.filterItems(items, new Set([1, 2]), new Set([2])), {
    kept: items.slice(1), removedCount: 1, perTag: { 1: 1 }, ignoredExcluded: [2],
  });
});
test("중복 태그와 태그 없는 작품", () => {
  const list = [{ tags: [{ id: 2 }, { id: 2 }] }, {}];
  assert.deepEqual(core.filterItems(list, new Set([2, 9]), new Set()), {
    kept: [list[1]], removedCount: 1, perTag: { 2: 1, 9: 0 }, ignoredExcluded: [],
  });
});
test("별점 다섯 구간의 가중 평균", () => {
  assert.deepEqual(core.ratingSummary([
    { rating: 1, count: 1 }, { rating: 2, count: 2 }, { rating: 3, count: 3 },
    { rating: 4, count: 4 }, { rating: 5, count: 10 },
  ]), { average: 4, count: 20 });
  assert.deepEqual(core.ratingSummary([{ rating: 4, count: 1 }, { rating: 5, count: 2 }]), { average: 4.7, count: 3 });
});
test("빈 별점·평가 수 0", () => {
  assert.deepEqual(core.ratingSummary([]), { average: null, count: 0 });
  assert.deepEqual(core.ratingSummary([{ rating: 5, count: 0 }]), { average: null, count: 0 });
});
test("마지막 페이지와 범위 보정", () => {
  const list = Array.from({ length: 43 }, (_, i) => i);
  assert.deepEqual(core.paginate(list, 3), { pageItems: [40, 41, 42], page: 3, totalPages: 3 });
  assert.equal(core.paginate(list, 99).page, 3);
  assert.equal(core.paginate(list, -1).page, 1);
  assert.deepEqual(core.paginate([], 9), { pageItems: [], page: 1, totalPages: 1 });
});
test("태그 추가는 이름을 한 번 인코딩하고 page=1", () => {
  const href = core.addTagToUrl(`${baseUrl}&tag_ids[]=3832-세트&page=3&order=selling`, { id: 7, name: "달 & 별" });
  const url = new URL(href);
  assert.deepEqual(url.searchParams.getAll("tag_ids"), ["3832-세트", "7-달 & 별"]);
  assert.ok(href.includes("3832-%EC%84%B8%ED%8A%B8"));
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("order"), "selling");
  assert.equal(url.searchParams.has("tag_ids[]"), false);
  assert.equal(core.parseFinderUrl(core.addTagToUrl(href, { id: 7, name: "중복" })).tags.length, 2);
});
test("태그 삭제는 나머지 조건을 보존하고 page=1", () => {
  const href = core.removeTagFromUrl(`${baseUrl}&tag_ids=3832-세트&tag_ids[]=7-태그&page=3&order=rating`, 3832);
  assert.deepEqual(core.parseFinderUrl(href).tags, [{ id: 7, name: "태그" }]);
  assert.equal(new URL(href).searchParams.get("page"), "1");
  assert.equal(new URL(href).searchParams.get("order"), "rating");
});

runApiTests().then(async (count) => {
  const contentCount = await runContentTests();
  const markdownCount = require("./markdown.js")();
  const panelCount = require("./panel.js")();
  const viewCount = require("./view.js")();
  const backgroundCount = await require("./background.js")();
  console.log(`전체 ${passed + count + contentCount + markdownCount + panelCount + backgroundCount + viewCount}개 테스트 통과 (순수 함수 ${passed}개, 수집 ${count}개, 연결 동작 ${contentCount}개, 할인 ${markdownCount}개, 패널 ${panelCount}개, 백그라운드 ${backgroundCount}개, 카드 ${viewCount}개)`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
