import { App, Events, TFile } from "obsidian";
import {
  DiaryEntryInfo,
  normalizeDiaryFolder,
  parseDiaryDate,
} from "./diary";
import type { DiaryFeedSettings } from "./settings";

export class DiaryStore extends Events {
  private entries: DiaryEntryInfo[] = [];
  private filesByPath = new Map<string, TFile>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DiaryFeedSettings,
  ) {
    super();
  }

  get folder(): string {
    return normalizeDiaryFolder(this.getSettings().folder);
  }

  getEntries(): readonly DiaryEntryInfo[] {
    return this.entries;
  }

  isDiaryFile(file: TFile): boolean {
    return (
      file.extension === "md" &&
      file.parent?.path === this.folder &&
      parseDiaryDate(file.basename) !== null
    );
  }

  refresh(): void {
    const folderPath = this.folder;
    const folder = folderPath
      ? this.app.vault.getFolderByPath(folderPath)
      : null;
    const nextEntries: DiaryEntryInfo[] = [];

    if (folder) {
      for (const child of folder.children) {
        if (!(child instanceof TFile) || !this.isDiaryFile(child)) continue;
        const date = parseDiaryDate(child.basename);
        if (date) nextEntries.push({ date, file: child });
      }
    }

    nextEntries.sort((left, right) =>
      left.date < right.date ? 1 : left.date > right.date ? -1 : 0,
    );
    this.entries = nextEntries;
    this.filesByPath = new Map(
      nextEntries.map((entry) => [entry.file.path, entry.file]),
    );
    this.trigger("index-changed");
  }

  handleCreate(file: TFile): void {
    if (this.isDiaryFile(file)) this.refresh();
  }

  handleModify(file: TFile): void {
    this.trigger("file-modified", file);
  }

  handleDelete(file: TFile): void {
    const wasDiary = this.filesByPath.has(file.path);
    this.trigger("file-deleted", file);
    if (wasDiary) this.refresh();
  }

  handleRename(file: TFile, oldPath: string): void {
    const affectsIndex = this.filesByPath.has(oldPath) || this.isDiaryFile(file);
    this.trigger("file-renamed", file, oldPath);
    if (affectsIndex) this.refresh();
  }

  async ensureFolder(): Promise<void> {
    const folderPath = this.folder;
    if (!folderPath) throw new Error("请先设置日记文件夹");

    let current = "";
    for (const segment of folderPath.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getFolderByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}
