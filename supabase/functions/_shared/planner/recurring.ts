import type { RecurringRule } from "./types.ts";

/** Pure-JS ISO date helpers so the engine works in Deno and the browser without extra deps. */

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept yyyy-mm-dd or full ISO. Always treat as UTC midnight so arithmetic is stable.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const out = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(out.getTime()) ? null : out;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Expand a recurring rule into a list of dates from `from` up to `to` (inclusive-ish; we emit
 * any anchor whose date <= `to`). Designed to be bounded — callers should cap `to`.
 */
export function expandRecurringDates(
  rule: RecurringRule | null | undefined,
  from: Date,
  to: Date,
  maxIterations = 1024,
): Date[] {
  if (!rule) return [];
  const out: Date[] = [];
  const anchor = parseIsoDate(rule.anchorDate ?? null) ?? from;
  const startBoundary = startOfDay(from);
  const endBoundary = startOfDay(to);

  const push = (d: Date) => {
    const day = startOfDay(d);
    if (day.getTime() < startBoundary.getTime()) return;
    if (day.getTime() > endBoundary.getTime()) return;
    out.push(day);
  };

  switch (rule.type) {
    case "ONE_TIME": {
      push(anchor);
      break;
    }
    case "DAILY": {
      let cur = anchor;
      let iter = 0;
      while (iter++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, 1);
      }
      break;
    }
    case "WEEKLY": {
      let cur = anchor;
      let iter = 0;
      while (iter++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, 7);
      }
      break;
    }
    case "BIWEEKLY": {
      let cur = anchor;
      let iter = 0;
      while (iter++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, 14);
      }
      break;
    }
    case "EVERY_X_DAYS": {
      const step = Math.max(1, rule.intervalDays ?? 7);
      let cur = anchor;
      let iter = 0;
      while (iter++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, step);
      }
      break;
    }
    case "CUSTOM_INTERVAL": {
      const step = Math.max(1, rule.intervalDays ?? 30);
      let cur = anchor;
      let iter = 0;
      while (iter++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, step);
      }
      break;
    }
    case "SEMI_MONTHLY": {
      const days = rule.semiMonthlyDays && rule.semiMonthlyDays.length >= 1
        ? rule.semiMonthlyDays
        : [1, 15];
      let cursorYear = startBoundary.getUTCFullYear();
      let cursorMonth = startBoundary.getUTCMonth();
      let iter = 0;
      while (iter++ < maxIterations) {
        let anyEmitted = false;
        for (const dayRaw of days) {
          const day = Math.min(28, Math.max(1, dayRaw));
          const candidate = new Date(Date.UTC(cursorYear, cursorMonth, day));
          if (candidate.getTime() < startBoundary.getTime()) continue;
          if (candidate.getTime() > endBoundary.getTime()) return out;
          push(candidate);
          anyEmitted = true;
        }
        cursorMonth++;
        if (cursorMonth > 11) {
          cursorMonth = 0;
          cursorYear++;
        }
        if (!anyEmitted && cursorYear > endBoundary.getUTCFullYear() + 2) break;
      }
      break;
    }
    case "MONTHLY": {
      const preferredDay = rule.dayOfMonth ?? anchor.getUTCDate();
      let cursorYear = startBoundary.getUTCFullYear();
      let cursorMonth = startBoundary.getUTCMonth();
      let iter = 0;
      while (iter++ < maxIterations) {
        const maxDay = new Date(Date.UTC(cursorYear, cursorMonth + 1, 0)).getUTCDate();
        const day = Math.min(preferredDay, maxDay);
        const candidate = new Date(Date.UTC(cursorYear, cursorMonth, day));
        if (candidate.getTime() >= startBoundary.getTime() && candidate.getTime() <= endBoundary.getTime()) {
          push(candidate);
        }
        cursorMonth++;
        if (cursorMonth > 11) {
          cursorMonth = 0;
          cursorYear++;
        }
        if (cursorYear > endBoundary.getUTCFullYear() + 2) break;
      }
      break;
    }
    case "QUARTERLY": {
      const preferredDay = rule.dayOfMonth ?? anchor.getUTCDate();
      let cursor = startOfDay(anchor);
      let iter = 0;
      while (iter++ < maxIterations && cursor.getTime() <= endBoundary.getTime()) {
        if (cursor.getTime() >= startBoundary.getTime()) push(cursor);
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, preferredDay));
      }
      break;
    }
    case "YEARLY": {
      const anchorMonth = anchor.getUTCMonth();
      const anchorDay = anchor.getUTCDate();
      let cursorYear = Math.max(startBoundary.getUTCFullYear(), anchor.getUTCFullYear());
      let iter = 0;
      while (iter++ < maxIterations) {
        const candidate = new Date(Date.UTC(cursorYear, anchorMonth, anchorDay));
        if (candidate.getTime() > endBoundary.getTime()) break;
        if (candidate.getTime() >= startBoundary.getTime()) push(candidate);
        cursorYear++;
      }
      break;
    }
    default: {
      // Unknown rule type: treat as no recurrence.
      break;
    }
  }

  return out.sort((a, b) => a.getTime() - b.getTime());
}

export function nextDateAtOrAfter(
  rule: RecurringRule | null | undefined,
  from: Date,
  maxWindowDays = 365,
): Date | null {
  if (!rule) return null;
  const horizon = addDays(from, maxWindowDays);
  const all = expandRecurringDates(rule, from, horizon);
  return all[0] ?? null;
}
