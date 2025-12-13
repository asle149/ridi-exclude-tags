async function getActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (active?.id && isRidiKeywordTab(active.url)) return active.id;

  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const ridiTab = tabs.find((t) => isRidiKeywordTab(t.url));
  return ridiTab?.id;
}

function isRidiKeywordTab(url) {
  if (typeof url !== "string") return false;
  return url.startsWith("https://ridibooks.com/keyword-finder/");
}

function setStatus(msg) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  if (msg) setTimeout(() => (el.textContent = ""), 1400);
}

function makeChip(text, { muted = false, removable = false, onRemove } = {}) {
  const chip = document.createElement("div");
  chip.className = `chip${muted ? " muted" : ""}${removable ? " removable" : ""}`;
  chip.textContent = text;

  if (removable) {
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "X";
    chip.appendChild(x);

    x.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove?.();
    });
  }
  return chip;
}

function renderIncluded(included, excludedMap) {
  const box = document.getElementById("includedList");
  box.innerHTML = "";

  if (!included?.length) {
    box.appendChild(makeChip("포함 태그 없음", { muted: true }));
    return;
  }

  const excludedIds = new Set(Object.keys(excludedMap || {}).map(String));
  for (const t of included) {
    const label = t.label ? `#${t.label}` : `#${t.id}`;
    const muted = excludedIds.has(String(t.id));
    box.appendChild(makeChip(label, { muted }));
  }
}

function renderExcluded(excludedMap) {
  const box = document.getElementById("excludedList");
  box.innerHTML = "";

  const ids = Object.keys(excludedMap || {});
  if (!ids.length) {
    box.appendChild(makeChip("제외 태그 없음", { muted: true }));
    return;
  }

  for (const id of ids) {
    const label = excludedMap[id] || "";
    const text = label ? `#${label}` : `#${id}`;

    box.appendChild(
      makeChip(text, {
        removable: true,
        onRemove: async () => {
          const tabId = await getActiveTabId();
          if (!tabId) return;

          chrome.tabs.sendMessage(tabId, { type: "REMOVE_EXCLUDED", id }, () => {
            setStatus("제외 해제됨");
            refreshState();
          });
        },
      })
    );
  }
}

async function refreshState() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("RIDI 키워드 검색 탭을 찾지 못했습니다.");
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus("RIDI 키워드 검색 탭에서만 동작합니다.");
      return;
    }
    if (!res?.ok) {
      setStatus("이 페이지는 지원되지 않습니다.");
      return;
    }

    document.getElementById("modeToggle").checked = !!res.modeOn;
    renderIncluded(res.included, res.excluded);
    renderExcluded(res.excluded);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("modeToggle").addEventListener("change", async (e) => {
    const on = e.target.checked;
    const tabId = await getActiveTabId();
    if (!tabId) return;

    chrome.tabs.sendMessage(tabId, { type: "SET_MODE", on }, () => {
      setStatus(on ? "제외 모드 ON" : "제외 모드 OFF");
      refreshState();
    });
  });

  document.getElementById("applyNow").addEventListener("click", async () => {
    const tabId = await getActiveTabId();
    if (!tabId) return;

    chrome.tabs.sendMessage(tabId, { type: "APPLY_EXCLUDED_NOW" }, () => {
      setStatus("검색 반영");
      setTimeout(refreshState, 600);
    });
  });

  document.getElementById("clearExcluded").addEventListener("click", async () => {
    const tabId = await getActiveTabId();
    if (!tabId) return;

    chrome.tabs.sendMessage(tabId, { type: "CLEAR_EXCLUDED" }, () => {
      setStatus("제외 태그 전체 삭제");
      refreshState();
    });
  });

  refreshState();
});
