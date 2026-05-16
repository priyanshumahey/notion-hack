// Runs in the page context of every URL. Keep this lightweight.
console.log("[notion-hack] content script loaded on", location.href);

chrome.runtime
  .sendMessage({ type: "ping" })
  .then((res) => console.log("[notion-hack] background replied:", res))
  .catch(() => {
    /* background may be asleep on first load */
  });
