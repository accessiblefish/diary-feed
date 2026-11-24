import { getFrontMatterInfo, normalizePath, TFile } from "obsidian";

export interface DiaryEntryInfo {
  date: string;
  file: TFile;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDiaryDate(value: string): string | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? value : null;
}

export function normalizeDiaryFolder(value: string): string {
  const withoutSlashes = value.trim().replace(/^\/+|\/+$/g, "");
  return withoutSlashes ? normalizePath(withoutSlashes) : "";
}

export function getDiaryBody(raw: string): string {
  return raw.slice(getFrontMatterInfo(raw).contentStart);
}

export function replaceDiaryBody(raw: string, body: string): string {
  return raw.slice(0, getFrontMatterInfo(raw).contentStart) + body;
}
