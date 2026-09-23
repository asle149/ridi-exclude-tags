const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../src/core.js");

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.hidden = false; this.isConnected = true; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ""; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  hasAttribute(name) { return name === "hidden" ? this.hidden : name in this.attributes; }
  addEventListener(name, callback) { this.events[name] = callback; }
  before(node) { this.parentElement.append(node); }
  remove() { this.isConnected = false; }
  closest(selector) { return selector === ".rh-results" && this.className === "rh-results" ? this : this.parentElement?.closest(selector); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
}

module.exports = function runViewTests() {
  let passed = 0;
  function test(name, run) { run(); passed++; console.log(`통과: ${name}`); }
  const href = "https://ridibooks.com/keyword-finder/fantasy?tag_ids=1-포함";
  const main = new Node("main");
  const original = new Node("ul");
  const originalItem = new Node("li");
  originalItem.querySelector = () => new Node("a");
  original.append(originalItem);
  const header = new Node("div");
  const inner = new Node("span"); inner.textContent = "12,802개의 작품";
  header.append(inner);
  main.append(original, header);
  main.querySelectorAll = (selector) => selector === "ul" ? [original] : selector === "*" ? [header, inner] : [];
  const window = { RidiHelper: { core } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/view.js"), "utf8"), { window, location: { href },
    document: { createElement: (tag) => new Node(tag), createTextNode(text) { const node = new Node("text"); node.textContent = text; return node; } } });
  const view = window.RidiHelper.view;
  const section = view.mount(main);
  const all = (node, className) => [node, ...node.children.flatMap((child) => all(child, className))].filter((entry) => entry.className === className);
  const item = { bookShell: { book: { id: 1, title: { main: "연재물" }, set: { totalCount: 3 }, priceInfo: { purchase: { sellingPrice: 0 } } },
    badges: [{ text: "30%", type: "DISCOUNT" }, { text: "Up", type: "UP" }, { text: "리다무", type: "WAIT_FREE" }, { text: "Up", type: "UP" }, { text: "25화 무료", type: "PARTIAL_FREE" }] },
    tags: [{ id: 1, name: "포함" }, { id: 2, name: "다른 태그" }] };
  let more = 0;
  const data = { filtered: { kept: [item], removedCount: 0, ignoredExcluded: [] }, total: 12802, truncated: true, loadedPages: 15,
    paged: { pageItems: [item], page: 1, totalPages: 1 }, excluded: {}, href, onPage() {}, onMore() { more++; },
    markdownByBook: { 1: { label: { text: "행사 30→50% · 최대", strong: "50%", title: "설명" }, recommended: true } } };
  test("카드 0원 생략·배지 순서와 중복 제거·포함 태그 생략·할인과 추천", () => {
    view.render(data);
    assert.equal(all(section, "rh-price").length, 0);
    assert.deepEqual(all(section, "rh-badge").map((node) => node.textContent), ["3권 세트", "찜 추천", "Up", "리다무", "25화 무료"]);
    assert.deepEqual(all(section, "rh-tag").map((node) => node.textContent), ["#다른 태그"]);
    const line = all(section, "rh-markdown")[0];
    assert.equal(line.textContent, "행사 30→50% · 최대");
    assert.equal(line.children[1].tagName, "STRONG");
    assert.equal(line.children[1].textContent, "50%");
    assert.equal(line.title, "설명");
    all(section, "rh-more")[0].events.click();
    assert.equal(more, 1);
    view.render({ ...data, collecting: true });
    assert.equal(all(section, "rh-more")[0].disabled, true);
  });
  test("판매 가격·최대 수집 안내·가장 안쪽 원래 머리글 숨김과 복구", () => {
    item.bookShell.book.priceInfo.purchase = { fullPrice: 10000, sellingPrice: 9000, discountRate: 10 };
    view.render({ ...data, loadedPages: 75 });
    assert.equal(all(section, "rh-price")[0].textContent, "10,000원10%9,000원");
    assert.equal(all(section, "rh-more").length, 0);
    assert.equal(inner.hidden, true);
    assert.equal(header.hidden, false);
    assert.equal(original.hidden, true);
    view.unmount();
    assert.equal(inner.hidden, false);
    assert.equal(original.hidden, false);
  });
  return passed;
};
