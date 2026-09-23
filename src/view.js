(function () {
  const { core } = window.RidiHelper;
  let section = null;
  let main = null;
  let modeBanner = null;
  const hiddenElements = new Map();
  const format = (number) => Number(number).toLocaleString("ko-KR");

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function findResultList(mainEl) {
    return [...mainEl.querySelectorAll("ul")].find((ul) => !ul.closest(".rh-results") &&
      [...ul.children].some((li) => li.tagName === "LI" && li.querySelector('a[href*="/books/"]'))) || null;
  }

  function findPagination(mainEl) {
    const links = [...mainEl.querySelectorAll('a[href*="page="]')].filter((link) => {
      if (link.closest('.rh-results, [data-ridi-helper-hidden="1"]') || link.querySelector("img") ||
          link.closest("li")?.querySelector('a[href*="/books/"]')) return false;
      const current = core.parseFinderUrl(location.href);
      const target = core.parseFinderUrl(link.href);
      if (target.genrePath !== current.genrePath || target.setId !== current.setId || target.order !== current.order ||
          target.tags.map((tag) => tag.id).sort().join(",") !== current.tags.map((tag) => tag.id).sort().join(",")) return false;
      return /^\d+$/.test(link.textContent.trim()) || /이전|다음|처음|마지막|previous|next/i.test(
        `${link.textContent} ${link.getAttribute("aria-label") || ""}`);
    });
    // 페이지 번호가 li 안에 있는 형태도 지원해요.
    for (const nav of mainEl.querySelectorAll("nav")) {
      if (!nav.closest(".rh-results") && links.filter((link) => nav.contains(link)).length > 1 &&
          !nav.querySelector('a[href*="/books/"], select')) return nav;
    }
    if (links.length < 2) return null;
    let parent = links[0].parentElement;
    while (parent && parent !== mainEl) {
      if (links.every((link) => parent.contains(link))) {
        return parent.querySelector('a[href*="/books/"], select, .rh-results') ? null : parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function hide(node) {
    if (!node) return;
    if (!hiddenElements.has(node)) hiddenElements.set(node, node.hasAttribute("hidden"));
    node.dataset.ridiHelperHidden = "1";
    node.hidden = true;
  }

  function mount(mainEl) {
    if (section && (!section.isConnected || main !== mainEl)) unmount();
    main = mainEl;
    const list = findResultList(mainEl);
    if (!list) return section;
    const pagination = findPagination(mainEl);
    if (!section) {
      section = element("section", "rh-results");
      section.setAttribute("aria-label", "제외 반영 검색 결과");
      list.before(section);
    }
    hide(list);
    hide(pagination);
    return section;
  }

  function unmount() {
    section?.remove();
    section = null;
    for (const [node, wasHidden] of hiddenElements) {
      node.hidden = wasHidden;
      delete node.dataset.ridiHelperHidden;
    }
    hiddenElements.clear();
    main = null;
  }

  function setMode(mainEl, on) {
    if (modeBanner && (!on || modeBanner.parentElement !== mainEl)) {
      modeBanner.remove();
      modeBanner = null;
    }
    if (on && mainEl && !modeBanner) {
      modeBanner = element("div", "rh-mode", "제외 모드: 태그를 누르면 제외 목록에 들어가요");
      mainEl.prepend(modeBanner);
    }
  }

  function showStatus(message) {
    if (!section) return;
    const status = element("p", "rh-status", message);
    status.setAttribute("role", "status");
    section.replaceChildren(status);
  }

  function bookLink(book, text, className) {
    const link = element("a", className, text);
    link.href = `https://ridibooks.com/books/${encodeURIComponent(book.id)}`;
    return link;
  }

  function card(item, href) {
    const shell = item.bookShell || {};
    const book = shell.book || {};
    const row = element("li", "rh-card");
    const cover = bookLink(book, undefined, "rh-cover");
    const image = element("img");
    if (book.id) image.src = `https://img.ridicdn.net/cover/${encodeURIComponent(book.id)}/large`;
    image.alt = book.title?.main || "표지";
    image.loading = "lazy";
    cover.append(image);
    const info = element("div", "rh-info");
    const title = element("h3", "rh-title");
    if (book.isAdultOnly) title.append(element("span", "rh-adult", "19"));
    title.append(bookLink(book, book.title?.main || "제목 없음"));
    info.append(title);
    const authors = (book.authors || []).map((author) => author.name).filter(Boolean).join(", ");
    if (authors) info.append(element("p", "rh-meta", authors));
    if (book.publicationInfo?.name) info.append(element("p", "rh-meta", book.publicationInfo.name));
    const rating = core.ratingSummary(book.ratings);
    if (rating.count) info.append(element("p", "rh-rating", `★ ${rating.average.toFixed(1)} (${format(rating.count)})`));
    const badges = element("div", "rh-badges");
    if (book.set?.totalCount) badges.append(element("span", "rh-badge", `${book.set.totalCount}권 세트`));
    for (const badge of shell.badges || []) {
      if (badge.type === "DISCOUNT") badges.append(element("span", "rh-badge", badge.text));
    }
    info.append(badges);
    const price = book.priceInfo?.purchase;
    if (price && price.sellingPrice != null) {
      const line = element("p", "rh-price");
      if (price.discountRate > 0) {
        if (price.fullPrice != null) line.append(element("del", "rh-meta", `${format(price.fullPrice)}원`));
        line.append(element("span", "rh-discount", `${price.discountRate}%`));
      }
      line.append(element("strong", "", `${format(price.sellingPrice)}원`));
      info.append(line);
    }
    const tags = element("div", "rh-tags");
    for (const tag of item.tags || []) {
      const chip = element("a", "rh-tag", `#${tag.name || tag.id}`);
      chip.href = core.addTagToUrl(href, tag);
      tags.append(chip);
    }
    info.append(tags);
    row.append(cover, info);
    return row;
  }

  function pagination(page, totalPages, onPage) {
    const nav = element("nav", "rh-pagination");
    nav.setAttribute("aria-label", "제외 반영 결과 페이지");
    function button(label, target, disabled = false) {
      const node = element("button", "rh-page", label);
      node.type = "button";
      node.disabled = disabled;
      if (target === page && /^\d+$/.test(label)) node.setAttribute("aria-current", "page");
      node.addEventListener("click", () => onPage(target));
      nav.append(node);
    }
    button("이전", page - 1, page === 1);
    const pages = new Set([1, totalPages]);
    for (let n = Math.max(1, page - 3); n <= Math.min(totalPages, page + 3); n++) pages.add(n);
    let previous = 0;
    for (const n of [...pages].sort((a, b) => a - b)) {
      if (n - previous > 1) nav.append(element("span", "rh-gap", "…"));
      button(String(n), n);
      previous = n;
    }
    button("다음", page + 1, page === totalPages);
    return nav;
  }

  function render({ filtered, total, truncated, paged, excluded, href, onPage }) {
    if (!section) return;
    const header = element("div", "rh-heading");
    header.append(element("p", "rh-count", `제외 반영 ${format(filtered.kept.length)}개 · 전체 ${format(total)}개 중 ${format(filtered.removedCount)}개 제외${truncated ? " (상위 3,000개까지만 걸렀어요)" : ""}`));
    if (filtered.ignoredExcluded.length) {
      header.append(element("p", "rh-note", `포함 조건과 겹치는 제외 태그는 무시했어요: ${filtered.ignoredExcluded.map((id) => `#${excluded[id] || id}`).join(", ")}`));
    }
    section.replaceChildren(header);
    if (!filtered.kept.length) {
      const empty = element("p", "rh-status", "제외한 뒤 남는 작품이 없어요.");
      empty.setAttribute("role", "status");
      section.append(empty);
      return;
    }
    const list = element("ul", "rh-list");
    for (const item of paged.pageItems) list.append(card(item, href));
    section.append(list, pagination(paged.page, paged.totalPages, onPage));
  }

  function markPanelTags(excludedIds) {
    const mainEl = document.querySelector("main");
    if (!mainEl) return;
    const includedIds = new Set(core.parseFinderUrl(location.href).tags.map((tag) => tag.id));
    const originalList = findResultList(mainEl);
    for (const link of mainEl.querySelectorAll('a[href*="tag_ids"]')) {
      if (link.closest('.rh-results, [data-ridi-helper-hidden="1"]') || originalList?.contains(link) ||
          link.closest("li")?.querySelector('a[href*="/books/"]')) continue;
      let marked = false;
      try {
        const tags = core.parseFinderUrl(link.href).tags;
        const added = tags.filter((tag) => !includedIds.has(tag.id));
        const targets = added.length ? added : tags.length === 1 ? tags : [];
        marked = targets.some((tag) => excludedIds.has(tag.id));
      } catch { /* 태그 링크가 아니면 표시하지 않아요. */ }
      if (link.classList.contains("rh-excluded") !== marked) link.classList.toggle("rh-excluded", marked);
    }
  }

  window.RidiHelper = window.RidiHelper || {};
  window.RidiHelper.view = { mount, unmount, render, showStatus, setMode, markPanelTags, findResultList, findPagination,
    scrollToTop: () => section?.scrollIntoView({ block: "start", behavior: "smooth" }) };
})();
