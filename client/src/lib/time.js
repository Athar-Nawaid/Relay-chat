const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 14:32 */
export const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Compact relative time for the conversation list: "now", "4m", "3h",
 * "Tue", "12 Mar". Chat lists are scanned rather than read, so a short token
 * beats a precise sentence.
 */
export function formatRelative(iso) {
  if (!iso) return '';

  const then = new Date(iso);
  const delta = Date.now() - then.getTime();

  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return then.toLocaleDateString([], { weekday: 'short' });

  return then.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Stable per-day key, used to decide where a date separator goes. */
export const dayKey = (iso) => new Date(iso).toDateString();

/** "Today" / "Yesterday" / "Monday" / "12 March 2026" */
export function formatDayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - DAY);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  if (today.getTime() - date.getTime() < 7 * DAY) {
    return date.toLocaleDateString([], { weekday: 'long' });
  }

  return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Whether two messages should render as one visual group: same sender, close
 * together in time. Grouping is what stops a burst of short messages from
 * looking like a wall of avatars.
 */
export function sameGroup(a, b) {
  if (!a || !b) return false;
  if (a.senderId !== b.senderId) return false;
  return Math.abs(new Date(b.createdAt) - new Date(a.createdAt)) < 5 * MINUTE;
}
