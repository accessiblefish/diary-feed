import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { DiaryEntryInfo } from "./diary";
import { DiaryEntryController } from "./entry";
import type { DiaryStore } from "./store";

export const DIARY_FEED_VIEW_TYPE = "diary-feed-view";

const ESTIMATED_ROW_HEIGHT = 260;
const OVERSCAN_PX = 800;

interface VisibleRow {
  element: HTMLElement;
  controller: DiaryEntryController;
}

export class DiaryFeedView extends ItemView {
  private scroller: HTMLElement | null = null;
  private spacer: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private entries: DiaryEntryInfo[] = [];
  private controllers = new Map<string, DiaryEntryController>();
  private rows = new Map<number, VisibleRow>();
  private rowIndexes = new Map<HTMLElement, number>();
  private heights = new Map<string, number>();
  private offsets: number[] = [0];
  private resizeObserver: ResizeObserver | null = null;
  private layoutFrame: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly store: DiaryStore,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DIARY_FEED_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "日记流";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("diary-feed-view");
    const root = this.contentEl.createDiv({ cls: "diary-feed-root" });
    this.emptyEl = root.createDiv({ cls: "diary-feed-empty" });
    this.scroller = root.createDiv({ cls: "diary-feed-scroller" });
    this.spacer = this.scroller.createDiv({ cls: "diary-feed-spacer" });
    this.scroller.addEventListener("scroll", () => this.scheduleLayout(), {
      passive: true,
    });

    this.resizeObserver = new ResizeObserver((observed) => {
      let heightsChanged = false;
      for (const entry of observed) {
        const index = this.rowIndexes.get(entry.target as HTMLElement);
        if (index === undefined) {
          this.scheduleLayout();
          continue;
        }
        const diary = this.entries[index];
        if (!diary) continue;
        const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs((this.heights.get(diary.file.path) ?? 0) - height) > 1) {
          this.heights.set(diary.file.path, height);
          heightsChanged = true;
        }
      }
      if (heightsChanged) {
        this.rebuildOffsets();
        this.scheduleLayout();
      }
    });
    if (this.scroller) this.resizeObserver.observe(this.scroller);

    this.registerEvent(this.store.on("index-changed", () => this.reconcile()));
    this.registerEvent(
      this.store.on("file-modified", (file) => {
        if (file instanceof TFile) {
          this.controllers.get(file.path)?.handleModified(file);
        }
      }),
    );
    this.registerEvent(
      this.store.on("file-deleted", (file) => {
        if (file instanceof TFile) {
          this.controllers.get(file.path)?.handleDeleted(file);
        }
      }),
    );
    this.registerEvent(
      this.store.on("file-renamed", (file, oldPath) => {
        if (!(file instanceof TFile) || typeof oldPath !== "string") return;
        const controller = this.controllers.get(oldPath);
        if (!controller) return;
        this.controllers.delete(oldPath);
        controller.handleRenamed(file, oldPath);
        this.controllers.set(file.path, controller);
      }),
    );

    this.store.refresh();
  }

  async onClose(): Promise<void> {
    if (this.layoutFrame !== null) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    await Promise.all(
      Array.from(this.controllers.values(), (controller) => controller.dispose()),
    );
    this.controllers.clear();
    this.rows.clear();
    this.rowIndexes.clear();
    this.scroller = null;
    this.spacer = null;
    this.emptyEl = null;
  }

  onResize(): void {
    this.scheduleLayout();
  }

  private reconcile(): void {
    const previousFirstPath = this.entries[0]?.file.path;
    const indexedPaths = new Set(
      this.store.getEntries().map((entry) => entry.file.path),
    );
    const retained: DiaryEntryInfo[] = [];
    for (const controller of this.controllers.values()) {
      if (!indexedPaths.has(controller.file.path) && controller.hasUnsavedContent) {
        retained.push({ date: controller.date, file: controller.file });
      }
    }
    this.entries = [...this.store.getEntries(), ...retained].sort((left, right) =>
      left.date < right.date ? 1 : left.date > right.date ? -1 : 0,
    );

    for (const row of this.rows.values()) {
      void row.controller.detach();
      this.resizeObserver?.unobserve(row.element);
      this.rowIndexes.delete(row.element);
      row.element.remove();
    }
    this.rows.clear();

    const activePaths = new Set(this.entries.map((entry) => entry.file.path));
    for (const [path, controller] of this.controllers) {
      if (!activePaths.has(path) && !controller.hasUnsavedContent) {
        this.controllers.delete(path);
      }
    }

    this.rebuildOffsets();
    if (previousFirstPath !== this.entries[0]?.file.path && this.scroller) {
      this.scroller.scrollTop = 0;
    }
    if (this.emptyEl) {
      this.emptyEl.setText(this.entries.length ? "" : "还没有日记。");
      this.emptyEl.toggle(this.entries.length === 0);
    }
    this.scheduleLayout();
  }

  private rebuildOffsets(): void {
    const offsets = new Array<number>(this.entries.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < this.entries.length; index += 1) {
      const height =
        this.heights.get(this.entries[index].file.path) ?? ESTIMATED_ROW_HEIGHT;
      offsets[index + 1] = offsets[index] + height;
    }
    this.offsets = offsets;
    if (this.spacer) {
      this.spacer.style.height = `${offsets[offsets.length - 1]}px`;
    }
  }

  private scheduleLayout(): void {
    if (this.layoutFrame !== null) return;
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = null;
      this.updateVisibleRows();
    });
  }

  private updateVisibleRows(): void {
    if (!this.scroller || !this.spacer || !this.entries.length) return;
    const first = this.findRowAt(
      Math.max(0, this.scroller.scrollTop - OVERSCAN_PX),
    );
    const last = this.findRowAt(
      this.scroller.scrollTop + this.scroller.clientHeight + OVERSCAN_PX,
    );

    for (const [index, row] of this.rows) {
      if (index >= first && index <= last) continue;
      void row.controller.detach();
      this.resizeObserver?.unobserve(row.element);
      this.rowIndexes.delete(row.element);
      row.element.remove();
      this.rows.delete(index);
    }

    for (let index = first; index <= last; index += 1) {
      const diary = this.entries[index];
      if (!diary) continue;
      let row = this.rows.get(index);
      if (!row) {
        const element = this.spacer.createDiv({ cls: "diary-feed-row" });
        let controller = this.controllers.get(diary.file.path);
        if (!controller) {
          controller = new DiaryEntryController(
            this.app,
            this,
            this.store,
            diary.date,
            diary.file,
          );
          this.controllers.set(diary.file.path, controller);
        }
        row = { element, controller };
        this.rows.set(index, row);
        this.rowIndexes.set(element, index);
        controller.attach(element);
        this.resizeObserver?.observe(element);
      }
      row.element.style.transform = `translateY(${this.offsets[index]}px)`;
    }
  }

  private findRowAt(position: number): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.offsets[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return Math.min(low, this.entries.length - 1);
  }

}
