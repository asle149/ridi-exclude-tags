let busy = false;
let refreshing = false;
let lastState = "";
let statusTimer = null;

async function getActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && isRidiKeywordTab(active.url)) return active.id;
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  return tabs.find((tab) => isRidiKeywordTab(tab.url))?.id;
}

function isRidiKeywordTab(url) {
  return typeof url === "string" && url.startsWith("https://ridibooks.com/keyword-finder/");
}

function setStatus(message) {
  clearTimeout(statusTimer);
  document.getElementById("status").textContent = message;
  if (message) statusTimer = setTimeout(() => { document.getElementById("status").textContent = ""; }, 2500);
}

function makeChip(text, { muted = false, onRemove, label } = {}) {
  const chip = document.createElement(onRemove ? "button" : "span");
  chip.className = `chip${muted ? " muted" : ""}${onRemove ? " removable" : ""}`;
  chip.textContent = text;
  if (onRemove) {
    chip.type = "button";
    chip.title = `${label} 제외 해제`;
    chip.setAttribute("aria-label", `${label} 제외 해제`);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "X";
    x.setAttribute("aria-hidden", "true");
    chip.append(x);
    chip.addEventListener("click", onRemove);
  }
  return chip;
}

function renderState(state) {
  const signature = JSON.stringify(state);
  if (lastState === signature) return;
  lastState = signature;
  document.getElementById("enabledToggle").checked = !!state.helperEnabled;
  document.getElementById("modeToggle").checked = !!state.modeOn;
  document.getElementById("enabledToggle").disabled = false;
  document.getElementById("modeToggle").disabled = !state.helperEnabled;
  document.getElementById("clearExcluded").disabled = !Object.keys(state.excluded).length;
  const summary = document.getElementById("summary");
  if (!state.helperEnabled) summary.textContent = "도우미가 꺼져 있어요.";
  else if (state.collecting) summary.textContent = "검색 결과를 모으는 중…";
  else if (state.summary) summary.textContent = `제외 반영 ${state.summary.kept.toLocaleString("ko-KR")}개 · ${state.summary.removed.toLocaleString("ko-KR")}개 제외`;
  else summary.textContent = "제외 태그를 넣으면 여기서 결과가 걸러져요.";
  const included = document.getElementById("includedList");
  included.replaceChildren();
  for (const tag of state.included) included.append(makeChip(`#${tag.name || tag.id}`));
  if (!state.included.length) included.append(makeChip("포함 태그 없음", { muted: true }));
  const excluded = document.getElementById("excludedList");
  excluded.replaceChildren();
  const ignored = new Set(state.summary?.ignoredExcluded || state.included.map((tag) => tag.id));
  for (const [id, name] of Object.entries(state.excluded)) {
    const label = `#${name || id}`;
    const count = state.summary?.perTag[id] || 0;
    const chip = makeChip(`${label} ·${count.toLocaleString("ko-KR")}`, {
      muted: ignored.has(Number(id)), label,
      onRemove: () => change({ type: "REMOVE_EXCLUDED", id }, "제외 태그를 지웠어요."),
    });
    if (ignored.has(Number(id))) chip.title = "포함 조건과 겹쳐 제외하지 않아요. 누르면 제외 목록에서 지워요.";
    excluded.append(chip);
  }
  if (!Object.keys(state.excluded).length) excluded.append(makeChip("제외 태그 없음", { muted: true }));
}

function unavailable(message) {
  lastState = "";
  document.getElementById("summary").textContent = message;
  for (const id of ["enabledToggle", "modeToggle", "clearExcluded"]) document.getElementById(id).disabled = true;
  document.getElementById("includedList").replaceChildren();
  document.getElementById("excludedList").replaceChildren();
}

async function refreshState() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    const tabId = await getActiveTabId();
    if (!tabId) {
      unavailable("리디 키워드 검색 페이지에서 열어 주세요.");
      return;
    }
    const state = await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" });
    if (busy) return;
    if (!state?.ok) unavailable("리디 키워드 검색 페이지에서 열어 주세요.");
    else renderState(state);
  } catch {
    unavailable("리디 키워드 검색 페이지를 새로고침해 주세요.");
  } finally {
    refreshing = false;
  }
}

async function change(message, notice) {
  if (busy) return;
  busy = true;
  try {
    const tabId = await getActiveTabId();
    if (!tabId) throw new Error("검색 페이지 없음");
    const result = await chrome.tabs.sendMessage(tabId, message);
    if (!result?.ok) throw new Error("설정 변경 실패");
    setStatus(notice);
  } catch {
    setStatus("변경하지 못했어요. 검색 페이지를 새로고침해 주세요.");
  } finally {
    busy = false;
    lastState = "";
    refreshState();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("enabledToggle").addEventListener("change", (event) => {
    change({ type: "SET_ENABLED", on: event.target.checked }, event.target.checked ? "도우미를 켰어요." : "도우미를 껐어요.");
  });
  document.getElementById("modeToggle").addEventListener("change", (event) => {
    change({ type: "SET_MODE", on: event.target.checked }, event.target.checked ? "제외 모드를 켰어요." : "제외 모드를 껐어요.");
  });
  document.getElementById("clearExcluded").addEventListener("click", () => {
    change({ type: "CLEAR_EXCLUDED" }, "제외 태그를 모두 지웠어요.");
  });
  refreshState();
  setInterval(refreshState, 800);
});
