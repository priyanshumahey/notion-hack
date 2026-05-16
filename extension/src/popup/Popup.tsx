import { useEffect, useState } from "react";

export function Popup() {
  const [count, setCount] = useState(0);
  const [tabUrl, setTabUrl] = useState<string>("");

  useEffect(() => {
    chrome.storage?.local.get(["count"]).then((res) => {
      if (typeof res.count === "number") setCount(res.count);
    });
    chrome.tabs?.query({ active: true, currentWindow: true }).then((tabs) => {
      setTabUrl(tabs[0]?.url ?? "");
    });
  }, []);

  const increment = async () => {
    const next = count + 1;
    setCount(next);
    await chrome.storage?.local.set({ count: next });
  };

  return (
    <div className="w-80 p-4 font-sans bg-white text-slate-900">
      <header className="mb-3">
        <h1 className="text-lg font-semibold">Notion Hack</h1>
        <p className="text-xs text-slate-500">React + Tailwind MV3 starter</p>
      </header>

      <div className="rounded-lg border border-slate-200 p-3 mb-3">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">
          Active tab
        </div>
        <div className="text-sm break-all">{tabUrl || "(none)"}</div>
      </div>

      <button
        onClick={increment}
        className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
      >
        Clicked {count} times
      </button>
    </div>
  );
}
