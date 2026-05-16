// MV3 service worker. Runs in the extension background context.
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[notion-hack] installed:", details.reason);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ type: "pong", at: Date.now() });
    return true;
  }
  return false;
});
