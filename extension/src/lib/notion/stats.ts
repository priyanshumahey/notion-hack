// Lightweight counters for the "X observations logged today" banner.
//
// Lives in chrome.storage.local — tiny, atomic enough for our needs. We rotate
// the daily counter at the day boundary (local time). The last-error string is
// updated on every failed createObservation; cleared on every success.

interface StatsRecord {
  total: number;
  todayDate: string; // YYYY-MM-DD (local)
  today: number;
}

const KEY_STATS = "notionObsStats";
const KEY_LAST_ERR = "notionObsLastError";

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getObservationStats(): Promise<{ today: number; total: number }> {
  const r = await chrome.storage.local.get([KEY_STATS]);
  const rec = (r[KEY_STATS] as StatsRecord | undefined) ?? null;
  if (!rec) return { today: 0, total: 0 };
  const today = rec.todayDate === todayKey() ? rec.today : 0;
  return { today, total: rec.total };
}

export async function bumpObservationStats(): Promise<void> {
  const r = await chrome.storage.local.get([KEY_STATS]);
  const cur = (r[KEY_STATS] as StatsRecord | undefined) ?? {
    total: 0,
    today: 0,
    todayDate: todayKey(),
  };
  const k = todayKey();
  const next: StatsRecord = {
    total: cur.total + 1,
    todayDate: k,
    today: cur.todayDate === k ? cur.today + 1 : 1,
  };
  await chrome.storage.local.set({ [KEY_STATS]: next });
}

export async function setObservationLastError(msg: string): Promise<void> {
  if (msg) {
    await chrome.storage.local.set({ [KEY_LAST_ERR]: msg });
  } else {
    await chrome.storage.local.remove([KEY_LAST_ERR]);
  }
}

export async function getObservationLastError(): Promise<string> {
  const r = await chrome.storage.local.get([KEY_LAST_ERR]);
  return (r[KEY_LAST_ERR] as string | undefined) ?? "";
}

/** Wipe the daily/total counters and the last-error string. Used by the
 *  Settings "reset local data" button. Does NOT touch credentials. */
export async function clearObservationStats(): Promise<void> {
  await chrome.storage.local.remove([KEY_STATS, KEY_LAST_ERR]);
}
