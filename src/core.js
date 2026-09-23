(function () {
  function decodeSafe(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function orderToEnum(orderParam) {
    switch (orderParam) {
      case "selling": return "POPULARITY";
      case "rating": return "RATING";
      case "review_cnt": return "REVIEW";
      default: return "RECENT";
    }
  }

  function parseFinderUrl(href) {
    const url = new URL(href);
    const tags = [];
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
      if (key !== "tag_ids" && key !== "tag_ids[]") continue;
      const match = value.match(/^(\d+)(?:-(.*))?$/);
      if (!match) continue;
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || seen.has(id)) continue;
      seen.add(id);
      tags.push({ id, name: decodeSafe(match[2] || "") });
    }
    const page = Number(url.searchParams.get("page"));
    const orderParam = url.searchParams.get("order") || "";
    return {
      genrePath: url.pathname.split("/")[2] || "",
      setId: Number(url.searchParams.get("set_id")),
      tags,
      page: Number.isSafeInteger(page) && page > 0 ? page : 1,
      orderParam,
      order: orderToEnum(orderParam),
    };
  }

  function buildVariables(parsed, base = {}) {
    return {
      genre: base.genre || parsed.genrePath.toUpperCase(),
      setId: parsed.setId || base.setId || 0,
      adultOption: base.adultOption || "NONE",
      tagAdultOption: base.tagAdultOption || "NONE",
      order: parsed.order,
      tagIds: parsed.tags.map((tag) => tag.id),
    };
  }

  function filterItems(items, excludedIds, includedIds) {
    const ignoredExcluded = [...excludedIds].filter((id) => includedIds.has(id));
    const active = new Set([...excludedIds].filter((id) => !includedIds.has(id)));
    const perTag = Object.fromEntries([...active].map((id) => [id, 0]));
    const kept = [];
    let removedCount = 0;
    for (const item of items) {
      const hits = new Set((item.tags || []).map((tag) => Number(tag.id)).filter((id) => active.has(id)));
      if (!hits.size) kept.push(item);
      else {
        removedCount++;
        for (const id of hits) perTag[id]++;
      }
    }
    return { kept, removedCount, perTag, ignoredExcluded };
  }

  function ratingSummary(ratings = []) {
    let count = 0;
    let sum = 0;
    for (const entry of ratings || []) {
      const n = Number(entry.count);
      const rating = Number(entry.rating);
      if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(rating)) continue;
      count += n;
      sum += rating * n;
    }
    return { average: count ? Number((sum / count).toFixed(1)) : null, count };
  }

  function paginate(list, page, perPage = 20) {
    const size = Number.isSafeInteger(perPage) && perPage > 0 ? perPage : 20;
    const totalPages = Math.max(1, Math.ceil(list.length / size));
    const current = Math.min(totalPages, Math.max(1, Math.trunc(Number(page)) || 1));
    return { pageItems: list.slice((current - 1) * size, current * size), page: current, totalPages };
  }

  function writeTags(href, tags) {
    const url = new URL(href);
    url.searchParams.delete("tag_ids");
    url.searchParams.delete("tag_ids[]");
    for (const tag of tags) url.searchParams.append("tag_ids", `${tag.id}-${tag.name}`);
    url.searchParams.set("page", "1");
    return url.toString();
  }

  function addTagToUrl(href, tag) {
    const tags = parseFinderUrl(href).tags;
    if (!tags.some((entry) => entry.id === Number(tag.id))) tags.push({ id: Number(tag.id), name: tag.name || "" });
    return writeTags(href, tags);
  }

  function removeTagFromUrl(href, id) {
    return writeTags(href, parseFinderUrl(href).tags.filter((tag) => tag.id !== Number(id)));
  }

  const core = { parseFinderUrl, orderToEnum, buildVariables, filterItems, ratingSummary, paginate, addTagToUrl, removeTagFromUrl };
  if (typeof module !== "undefined") module.exports = core;
  else {
    globalThis.RidiHelper = globalThis.RidiHelper || {};
    globalThis.RidiHelper.core = core;
  }
})();
