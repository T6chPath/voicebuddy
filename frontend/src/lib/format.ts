import type { Conversation } from "../api/types";

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts * 1000);
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
              : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const DAY = 86400_000;

/** Sidebar sections: Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, Older. */
export function groupConversations(items: Conversation[], now = Date.now()): { label: string; items: Conversation[] }[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const order = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
  const groups = new Map<string, Conversation[]>(order.map((k) => [k, []]));
  for (const c of items) {
    const t = c.updated_at * 1000;
    const key = c.pinned ? "Pinned" : t >= t0 ? "Today" : t >= t0 - DAY ? "Yesterday" : t >= t0 - 7 * DAY ? "Previous 7 days"
      : t >= t0 - 30 * DAY ? "Previous 30 days" : "Older";
    groups.get(key)!.push(c);
  }
  return order.map((label) => ({ label, items: groups.get(label)! })).filter((g) => g.items.length);
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
