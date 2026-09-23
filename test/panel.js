const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.events = {}; this.attributes = {}; this.hidden = false; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  getBoundingClientRect() { return { left: 16, top: 16, right: 296, bottom: 450, width: 280, height: 434 }; }
  setPointerCapture() {}
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
}

module.exports = function runPanelTests() {
  let passed = 0;
  function test(name, run) { run(); passed++; console.log(`통과: ${name}`); }
  const body = new Node("body");
  const window = { RidiHelper: {}, innerWidth: 1200, innerHeight: 800, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/panel.js"), "utf8"), { window, document: { body, createElement: (tag) => new Node(tag) } });
  let removed;
  let position;
  const callbacks = { onToggleEnabled() {}, onToggleMode() {}, onRemoveExcluded(id) { removed = id; }, onClearExcluded() {},
    onToggleMarkdown() {}, onFilterChange() {}, onSortChange() {}, onPanelStateChange(value) { position = value; } };
  const panel = window.RidiHelper.panel.create(callbacks);
  const find = (name, node = body) => node.className === name ? node : node.children.map((child) => find(name, child)).find(Boolean);
  test("패널 요약·칩 개수·삭제 콜백·접힘 문구 갱신", () => {
    panel.update({ helperEnabled: true, excludedTagMap: { 2: "태그" }, summary: { kept: 1032, perTag: { 2: 338 } },
      summaryText: "제외 반영 1,032개 · 338개 제외", panelState: { collapsed: true } });
    assert.equal(find("rh-panel-summary").textContent, "제외 반영 1,032개 · 338개 제외");
    assert.equal(find("rh-panel-chip").textContent, "#태그 ·338X");
    assert.equal(find("rh-panel-pill").textContent, "제외 1 · 1,032개");
    assert.equal(find("rh-panel-body").hidden, true);
    find("rh-panel-remove").events.click();
    assert.equal(removed, 2);
    find("rh-panel-pill").events.click();
    assert.equal(position.collapsed, false);
  });
  test("도우미가 꺼져도 패널 표시·결과 없는 접힘·화면 밖 드래그 보정", () => {
    panel.update({ helperEnabled: false, excludedTagMap: { 1: "하나", 2: "둘" }, panelState: { collapsed: false } });
    assert.equal(find("rh-panel").hidden, false);
    assert.equal(find("rh-panel-pill").textContent, "제외 2");
    const head = find("rh-panel-head");
    head.events.pointerdown({ button: 0, pointerId: 1, clientX: 30, clientY: 30, target: { closest() { return null; } }, preventDefault() {} });
    head.events.pointermove({ pointerId: 1, clientX: 2000, clientY: -500 });
    head.events.pointerup({ pointerId: 1 });
    assert.equal(position.left, 920);
    assert.equal(position.top, 0);
    panel.update({ visible: false });
    assert.equal(find("rh-panel").hidden, true);
  });
  return passed;
};
