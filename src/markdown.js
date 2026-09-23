(function () {
  const genreNames = { romance: "로맨스", "romance-fantasy": "로판", "bl-novel": "BL소설", fantasy: "판타지" };

  function genreSlugsFor(path) {
    return ({ bl: ["bl-novel"], romance: ["romance", "romance-fantasy"], fantasy: ["fantasy"] }[path] || []).slice();
  }

  function unescapeRsc(html) {
    const chunks = [];
    const pattern = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)/g;
    for (const match of html.matchAll(pattern)) chunks.push(JSON.parse(match[1]));
    return chunks.join("");
  }

  function parseLineupHtml(html) {
    const text = unescapeRsc(html);
    const items = new Map();
    let found = false;
    for (const match of text.matchAll(/"items"\s*:\s*\[/g)) {
      const start = match.index + match[0].length - 1;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "[") depth++;
        else if (c === "]" && --depth === 0) {
          for (const item of JSON.parse(text.slice(start, i + 1))) {
            const ridiId = Number(item.ridi_id);
            if (!Number.isSafeInteger(ridiId) || ridiId <= 0) continue;
            items.set(ridiId, { ridiId, title: item.title, author: item.author, genre: item.genre,
              rating: item.rating, reviewCount: item.review_count, purchasePrice: item.purchase_price,
              discountRate: item.discount_rate, eventId: item.event_id, isRental: item.is_rental, isSetPrice: item.is_set_price });
          }
          found = true;
          break;
        }
      }
    }
    if (!found) throw new Error("할인 목록을 읽지 못했어요");
    const pages = [...html.matchAll(/href=["'][^"']*\?page=(\d+)/g)].map((match) => Number(match[1]));
    return { items: [...items.values()], pageCount: pages.length ? Math.max(1, ...pages) : null };
  }

  function plain(text) {
    return text.replace(/<[^>]*>/g, "").replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(\d+);|&#x([\da-f]+);/gi, (entity, dec, hex) => {
      if (dec || hex) return String.fromCodePoint(parseInt(dec || hex, hex ? 16 : 10));
      return ({ "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " })[entity] || entity;
    }).trim();
  }

  function parseEventsHtml(html, page = 1) {
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    const links = [...markup.matchAll(/<a\b[^>]*aria-label=["'][^"']* 상세 보기["'][^>]*>/g)];
    const events = [];
    const seen = new Set();
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const slug = link[0].match(/href=["']\/markdown\/([^/"']+)\//)?.[1];
      if (!slug || seen.has(slug)) continue;
      const card = markup.slice(link.index, links[i + 1]?.index ?? markup.length);
      const dates = card.match(/(\d{4})\.\s*(\d{2})\.\s*(\d{2})\s*~\s*(\d{4})\.\s*(\d{2})\.\s*(\d{2})/);
      if (!dates) continue;
      const paragraphs = [...card.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) => plain(match[1]));
      const genres = paragraphs.find((p) => /로맨스|로판|BL소설|판타지|웹툰|만화/.test(p))?.split(/\s*,\s*/) || [];
      const count = card.match(/\(([\d,]+)\s*작품\)/);
      events.push({ slug, name: plain(link[0].match(/aria-label=["'](.*) 상세 보기["']/)?.[1] || ""),
        start: dates.slice(1, 4).join("-"), end: dates.slice(4, 7).join("-"), genres,
        ongoing: />\s*진행 중\s*</.test(card), count: count ? Number(count[1].replace(/,/g, "")) : null });
      seen.add(slug);
    }
    const currentPage = page;
    const pages = [...markup.matchAll(/href=["']\/markdown\/events\/page-(\d+)["']/g)].map((match) => Number(match[1]));
    events.nextPage = pages.filter((page) => page > currentPage).sort((a, b) => a - b)[0] || null;
    return events;
  }

  function discountLabel(history, events) {
    const records = history.filter((entry) => events[entry.eventSlug] && Number.isFinite(entry.rate))
      .slice().sort((a, b) => events[a.eventSlug].start.localeCompare(events[b.eventSlug].start));
    const current = records.filter((entry) => events[entry.eventSlug].ongoing).at(-1);
    if (!current) return null;
    const index = records.indexOf(current);
    const previous = records[index - 1];
    const past = records.slice(0, index);
    const isMax = past.every((entry) => entry.rate <= current.rate);
    const tied = past.some((entry) => entry.rate === current.rate);
    const delta = previous ? current.rate - previous.rate : null;
    const strong = `${current.rate}%`;
    const suffix = previous && isMax ? (tied ? " · 공동 최대" : " · 최대") : "";
    const text = previous ? `행사 ${previous.rate}${delta === 0 ? "=" : "→"}${strong}${suffix}` : `행사 ${strong} · 첫 기록`;
    const event = events[current.eventSlug];
    const date = (value) => value.slice(5).split("-").map(Number).join("/");
    let year = "";
    const timeline = records.slice(0, index + 1).map((entry) => {
      if (entry === current) return `이번 ${entry.rate}%`;
      const start = events[entry.eventSlug].start;
      const prefix = start.slice(0, 4) === year ? "" : `${start.slice(0, 4)}년 `;
      year = start.slice(0, 4);
      return `${prefix}${Number(start.slice(5, 7))}월 ${entry.rate}%`;
    }).join(" · ");
    const change = !previous ? "첫 수집 기록" : delta === 0 ? "직전과 같음" : `직전보다 ${Math.abs(delta)}%p ${delta > 0 ? "증가" : "감소"}`;
    const maximum = previous && isMax ? ` · 기록 내 ${tied ? "공동 " : ""}최대 할인` : "";
    return { text, strong, title: `${event.name} 참여 (${date(event.start)}~${date(event.end)})\n${timeline}\n${change}${maximum}`,
      isMax, delta, currentRate: current.rate };
  }

  function isFresh(cache, slugs, now = Date.now()) {
    // 하루에 한 번만 받는다. 행사가 없는 기간에도 매번 다시 받지 않도록 시각만 본다.
    return cache?.version === 1 && slugs.length > 0 && slugs.every((slug) => {
      const genre = cache.genres?.[slug];
      return !!genre && now >= genre.fetchedAt && now - genre.fetchedAt < 24 * 60 * 60 * 1000;
    });
  }

  const markdown = { unescapeRsc, parseLineupHtml, parseEventsHtml, genreSlugsFor, genreNames, discountLabel, isFresh };
  if (typeof module !== "undefined") module.exports = markdown;
  else {
    globalThis.RidiHelper = globalThis.RidiHelper || {};
    globalThis.RidiHelper.markdown = markdown;
  }
})();
