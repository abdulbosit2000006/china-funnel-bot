// Date arithmetic on local calendar dates (YYYY-MM-DD) for the weekly plan.

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The Monday after the given date (a Monday gives the following Monday). */
export function nextMonday(date: string): string {
  const wd = weekdayOf(date);
  return addDays(date, ((8 - wd) % 7) || 7);
}

/** Monday of the week the date is in. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const DAY_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTH_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** "Пн 12 окт" */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAY_RU[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_RU[d.getUTCMonth()]}`;
}

export const dayShort = (date: string) => DAY_RU[weekdayOf(date)]!;
