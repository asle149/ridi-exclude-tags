chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "STORAGE_GET") {
      chrome.storage.local.get({ [msg.key]: msg.defaultValue }, (res) => {
        sendResponse({ ok: true, value: res[msg.key] });
      });
      return true;
    }
  
    if (msg?.type === "STORAGE_SET") {
      chrome.storage.local.set({ [msg.key]: msg.value }, () => {
        sendResponse({ ok: true });
      });
      return true;
    }
  });
  