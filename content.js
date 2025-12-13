console.log("[RIDI-EX] content.js loaded", location.href);

const MODE_KEY = "excludeModeOn";      // 제외 모드 ON/OFF (클릭 가로채기 여부)
const EXCLUDED_KEY = "excludedTagMap"; // { [id]: label }

let modeOnCache = false;
let excludedMapCache = {};
let excludedIdsCache = [];

function bgGet(key, defaultValue) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "STORAGE_GET", key, defaultValue }, (res) => {
      resolve(res?.ok ? res.value : defaultValue);
    });
  });
}

function bgSet(key, value) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "STORAGE_SET", key, value }, () => resolve());
  });
}

async function loadMode() {
  return !!(await bgGet(MODE_KEY, false));
}

async function setMode(on) {
  await bgSet(MODE_KEY, !!on);
}

async function loadExcludedMap() {
  return (await bgGet(EXCLUDED_KEY, {})) || {};
}

async function saveExcludedMap(map) {
  await bgSet(EXCLUDED_KEY, map || {});
}

async function refreshCaches() {
  modeOnCache = await loadMode();
  excludedMapCache = await loadExcludedMap();
  excludedIdsCache = Object.keys(excludedMapCache).map(String);
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function extractIdLabelFromTagValue(tagValue) {
  const m = String(tagValue).match(/^(\d+)(?:-(.*))?$/);
  if (!m) return { id: null, label: "" };
  return { id: m[1], label: m[2] ? decodeSafe(m[2]) : "" };
}

function getTagParams(url) {
  const u = new URL(url);
  const keys = ["tag_ids", "tag_ids[]"];
  const out = [];
  for (const key of keys) {
    for (const v of u.searchParams.getAll(key)) out.push({ key, value: v });
  }
  return out;
}

function getIncludedTagsFromUrl(url) {
  const seen = new Set();
  const tags = [];
  for (const { value } of getTagParams(url)) {
    const t = extractIdLabelFromTagValue(value);
    if (!t.id) continue;
    const id = String(t.id);
    if (seen.has(id)) continue;
    seen.add(id);
    tags.push({ id, label: t.label || "" });
  }
  return tags;
}

function removeExcludedFromUrl(url, excludedIds) {
  const u = new URL(url);
  const sp = u.searchParams;

  const tags = getTagParams(url);
  if (!tags.length) return url;

  sp.delete("tag_ids");
  sp.delete("tag_ids[]");

  let changed = false;

  for (const { key, value } of tags) {
    const { id } = extractIdLabelFromTagValue(value);
    if (id && excludedIds.includes(String(id))) {
      changed = true;
      continue;
    }
    sp.append(key, value);
  }

  if (changed) sp.set("page", "1");
  return u.toString();
}

function isKeywordFinderUrl(href) {
  try {
    const u = new URL(href, location.href);
    return u.origin === "https://ridibooks.com" && u.pathname.startsWith("/keyword-finder/");
  } catch {
    return false;
  }
}

function isTagLinkHref(href) {
  return (
    href.includes("tag_ids=") ||
    href.includes("tag_ids[]=") ||
    href.includes("tag_ids%5B%5D=")
  );
}

(function injectStyle() {
  const css = `
    a.ridi-excluded-tag {
      background:rgb(112, 112, 112) !important;
      color: #666 !important;
      border-radius: 999px !important;
      padding: 2px 8px !important;
    }

    li.ridi-excluded-tag-li > a,
    li.ridi-excluded-tag-li {
      background: #f0f0f0 !important;
    }
  `;
  const style = document.createElement("style");
  style.setAttribute("data-ridi-ex-style", "1");
  style.textContent = css;
  document.documentElement.appendChild(style);
})();

function isProbablyWorkCard(el) {
  if (!el) return false;

  const hasWorkLink = !!el.querySelector('a[href*="/books/"]');
  const hasThumb = !!el.querySelector("img, picture source");
  const hasTagLink = !!el.querySelector(
    'a[href*="tag_ids="], a[href*="tag_ids[]="], a[href*="tag_ids%5B%5D="]'
  );

  return hasWorkLink && hasThumb && hasTagLink;
}

function findWorkCardFromTagLink(tagA) {
  const candidates = [
    tagA.closest("li"),
    tagA.closest("article"),
    tagA.closest('div[class*="card"]'),
    tagA.closest('div[class*="item"]'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (isProbablyWorkCard(c)) return c;
  }
  return null;
}

function applyDomExcludeAndMark() {
  const tagLinks = document.querySelectorAll(
    'a[href*="tag_ids="], a[href*="tag_ids[]="], a[href*="tag_ids%5B%5D="]'
  );

  for (const a of tagLinks) {
    const href = a.getAttribute("href") || "";
    let abs = "";
    try {
      abs = new URL(href, location.href).toString();
    } catch {
      abs = "";
    }
    if (!abs) continue;

    const idsInLink = getIncludedTagsFromUrl(abs).map((t) => String(t.id));
    const hit = idsInLink.some((id) => excludedIdsCache.includes(id));

    if (hit) {
      a.classList.add("ridi-excluded-tag");
      const li = a.closest("li");
      if (li) li.classList.add("ridi-excluded-tag-li");
    } else {
      a.classList.remove("ridi-excluded-tag");
      const li = a.closest("li");
      if (li) li.classList.remove("ridi-excluded-tag-li");
    }
  }

  if (!excludedIdsCache.length) return;

  for (const a of tagLinks) {
    const href = a.getAttribute("href") || "";
    let abs = "";
    try {
      abs = new URL(href, location.href).toString();
    } catch {
      abs = "";
    }
    if (!abs) continue;

    const idsInLink = getIncludedTagsFromUrl(abs).map((t) => String(t.id));
    const hit = idsInLink.some((id) => excludedIdsCache.includes(id));
    if (!hit) continue;

    const card = findWorkCardFromTagLink(a);
    if (!card) continue; 

    if (card.dataset.ridiExcluded !== "1") {
      card.dataset.ridiExcluded = "1";
      card.style.display = "none";
    }
  }
}

function restoreHiddenCardsIfNeeded() {
  const hidden = document.querySelectorAll('[data-ridi-excluded="1"]');
  for (const el of hidden) {
    el.style.display = "";
    el.dataset.ridiExcluded = "";
  }
  applyDomExcludeAndMark();
}

const mo = new MutationObserver(() => applyDomExcludeAndMark());
mo.observe(document.documentElement, { childList: true, subtree: true });

async function addExcluded(id, label) {
  const map = await loadExcludedMap();
  map[String(id)] = label || map[String(id)] || "";
  await saveExcludedMap(map);
  excludedMapCache = map;
  excludedIdsCache = Object.keys(map).map(String);
}

async function removeExcluded(id) {
  const map = await loadExcludedMap();
  delete map[String(id)];
  await saveExcludedMap(map);
  excludedMapCache = map;
  excludedIdsCache = Object.keys(map).map(String);
}

async function clearExcluded() {
  await saveExcludedMap({});
  excludedMapCache = {};
  excludedIdsCache = [];
}

function stopAll(e) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
}

async function interceptEventSafe(e) {
  if (!modeOnCache) return;

  const a = e.target?.closest?.("a");
  if (!a) return;

  const href = a.getAttribute("href") || "";
  if (!href) return;

  if (!isTagLinkHref(href)) return;
  if (!isKeywordFinderUrl(href)) return;

  let abs;
  try {
    abs = new URL(href, location.href).toString();
  } catch {
    return;
  }

  const currentIds = new Set(getIncludedTagsFromUrl(location.href).map((t) => String(t.id)));
  const nextTags = getIncludedTagsFromUrl(abs);
  const newlyAdded = nextTags.find((t) => !currentIds.has(String(t.id)));

  if (!newlyAdded) return; 

  stopAll(e);

  try {
    await addExcluded(newlyAdded.id, newlyAdded.label);
    applyDomExcludeAndMark();
    console.log("[RIDI-EX] excluded added:", newlyAdded.id, newlyAdded.label);
  } catch (err) {
    console.warn("[RIDI-EX] intercept failed", err);
  }
}

["pointerdown", "mousedown", "click"].forEach((type) => {
  document.addEventListener(type, interceptEventSafe, { capture: true, passive: false });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!isKeywordFinderUrl(location.href)) {
      sendResponse({ ok: false });
      return;
    }

    if (msg?.type === "GET_STATE") {
      const modeOn = await loadMode();
      const excluded = await loadExcludedMap();
      const included = getIncludedTagsFromUrl(location.href);
      sendResponse({ ok: true, modeOn, excluded, included });
      return;
    }

    if (msg?.type === "SET_MODE") {
      await setMode(!!msg.on);
      modeOnCache = !!msg.on;
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "REMOVE_EXCLUDED") {
      await removeExcluded(String(msg.id));
      restoreHiddenCardsIfNeeded();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "CLEAR_EXCLUDED") {
      await clearExcluded();
      restoreHiddenCardsIfNeeded();

      document.querySelectorAll("a.ridi-excluded-tag").forEach((a) => a.classList.remove("ridi-excluded-tag"));
      document.querySelectorAll("li.ridi-excluded-tag-li").forEach((li) => li.classList.remove("ridi-excluded-tag-li"));

      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "APPLY_EXCLUDED_NOW") {
      await refreshCaches();
      const cleaned = removeExcludedFromUrl(location.href, excludedIdsCache);
      if (cleaned !== location.href) location.replace(cleaned);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })();

  return true;
});

(async () => {
  await refreshCaches();
  applyDomExcludeAndMark();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes[MODE_KEY]) {
    modeOnCache = !!changes[MODE_KEY].newValue;
  }
  if (changes[EXCLUDED_KEY]) {
    excludedMapCache = changes[EXCLUDED_KEY].newValue || {};
    excludedIdsCache = Object.keys(excludedMapCache).map(String);
    restoreHiddenCardsIfNeeded();
  }
});
