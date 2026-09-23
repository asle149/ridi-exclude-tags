(function () {
  const defaults = { excludedTagMap: {}, excludeModeOn: false, helperEnabled: true,
    markdownEnabled: true, markdownFilterMax: false, resultSort: "ridi", panelState: {} };
  let writes = Promise.resolve();

  function read() {
    return chrome.storage.local.get(defaults);
  }

  function update(change) {
    const next = writes.then(async () => {
      const state = await read();
      await chrome.storage.local.set(typeof change === "function" ? change(state) : change);
      return read();
    });
    writes = next.catch(() => {});
    return next;
  }

  function subscribe(callback) {
    const listener = (changes, area) => {
      if (area !== "local" || !Object.keys(defaults).some((key) => key in changes)) return;
      const patch = {};
      for (const key of Object.keys(defaults)) {
        if (key in changes) patch[key] = changes[key].newValue ?? defaults[key];
      }
      callback(patch);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  window.RidiHelper = window.RidiHelper || {};
  window.RidiHelper.store = { read, update, subscribe };
})();
