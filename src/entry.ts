import {
  App,
  debounce,
  ItemView,
  MarkdownRenderChild,
  MarkdownRenderer,
  setIcon,
  TFile,
  type Debouncer,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { createMarkdownEditor } from "./editor";
import { getDiaryBody, parseDiaryDate, replaceDiaryBody } from "./diary";
import type { DiaryStore } from "./store";

class DiaryConflictError extends Error {
  constructor(readonly externalRaw: string) {
    super("Diary changed outside this editing session");
  }
}

export class DiaryEntryController {
  date: string;
  file: TFile;

  private host: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private conflictEl: HTMLElement | null = null;
  private conflictLocalEl: HTMLTextAreaElement | null = null;
  private attachAbort: AbortController | null = null;
  private editor: EditorView | null = null;
  private renderChild: MarkdownRenderChild | null = null;
  private renderVersion = 0;

  private baselineRaw: string | null = null;
  private body = "";
  private loaded = false;
  private loading: Promise<void> | null = null;
  private mode: "read" | "edit" = "read";
  private dirty = false;
  private saving = false;
  private pendingSave = false;
  private savePromise: Promise<void> | null = null;
  private syncPromise: Promise<void> | null = null;
  private syncRequested = false;
  private conflictRaw: string | null = null;
  private saveError = "";
  private deleted = false;

  private readonly debouncedSave: Debouncer<[], void> = debounce(() => {
    void this.save();
  }, 500);

  constructor(
    private readonly app: App,
    private readonly view: ItemView,
    private readonly store: DiaryStore,
    date: string,
    file: TFile,
  ) {
    this.date = date;
    this.file = file;
  }

  get hasUnsavedContent(): boolean {
    return this.dirty || this.saving || this.conflictRaw !== null;
  }

  attach(host: HTMLElement): void {
    this.detachDom();
    this.host = host;
    this.attachAbort = new AbortController();
    const { signal } = this.attachAbort;

    const article = host.createDiv({ cls: "diary-feed-entry" });
    const header = article.createDiv({ cls: "diary-feed-entry-header" });
    const time = header.createEl("time", {
      cls: "diary-feed-entry-date",
      text: this.date,
    });
    time.dateTime = this.date;

    const actions = header.createDiv({ cls: "diary-feed-entry-actions" });
    const openButton = actions.createEl("button", {
      cls: "clickable-icon diary-feed-button diary-feed-open-file",
      attr: {
        type: "button",
        "aria-label": `打开 ${this.date} 的原文件`,
        title: "打开原文件",
      },
    });
    setIcon(openButton, "file-text");

    this.statusEl = article.createDiv({
      cls: "diary-feed-entry-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    this.bodyEl = article.createDiv({ cls: "diary-feed-entry-body" });
    this.conflictEl = article.createDiv({ cls: "diary-feed-conflict" });

    openButton.addEventListener(
      "click",
      () => {
        void this.app.workspace.getLeaf("tab").openFile(this.file);
      },
      { signal },
    );
    this.bodyEl.addEventListener(
      "click",
      (event) => {
        if (this.mode === "edit") return;
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            "a, button, input, textarea, select, video, audio, [contenteditable]",
          )
        ) {
          return;
        }
        void this.enterEditing();
      },
      { signal },
    );
    this.bodyEl.addEventListener(
      "keydown",
      (event) => {
        if (this.mode !== "edit" || event.isComposing) return;
        if (event.key === "Escape" || (event.key === "Enter" && event.metaKey)) {
          event.preventDefault();
          void this.finishEditing();
        }
      },
      { signal },
    );
    this.bodyEl.addEventListener(
      "focusout",
      (event) => {
        if (this.mode !== "edit") return;
        const next = event.relatedTarget;
        if (next instanceof Node && this.bodyEl?.contains(next)) return;
        void this.finishEditing();
      },
      { signal },
    );

    this.renderStatus();
    this.renderConflict();
    this.renderBody();
    void this.ensureLoaded();
  }

  async detach(): Promise<void> {
    this.debouncedSave.cancel();
    const flushed = this.flush();
    this.detachDom();
    await flushed;
    if (!this.host && !this.hasUnsavedContent && !this.saveError) {
      this.baselineRaw = null;
      this.body = "";
      this.loaded = false;
      this.mode = "read";
    }
  }

  async dispose(): Promise<void> {
    await this.detach();
  }

  async enterEditing(): Promise<void> {
    await this.ensureLoaded();
    if (!this.loaded) return;
    this.mode = "edit";
    this.renderBody();
    this.renderStatus();
  }

  async finishEditing(): Promise<void> {
    await this.flush();
    this.mode = "read";
    this.renderBody();
    this.renderStatus();
  }

  handleModified(file: TFile): void {
    if (file.path !== this.file.path || !this.loaded) return;
    this.syncRequested = true;
    void this.syncFromDisk();
  }

  handleDeleted(file: TFile): void {
    if (file.path !== this.file.path) return;
    this.deleted = true;
    this.renderStatus();
    this.renderConflict();
  }

  handleRenamed(file: TFile, oldPath: string): void {
    if (oldPath !== this.file.path) return;
    this.file = file;
    this.deleted = false;
    const renamedDate = parseDiaryDate(file.basename);
    if (this.store.isDiaryFile(file) && renamedDate) this.date = renamedDate;
  }

  async flush(): Promise<void> {
    this.debouncedSave.cancel();
    if (this.dirty && !this.conflictRaw && !this.deleted) {
      await this.save();
    } else if (this.savePromise) {
      await this.savePromise;
    }
  }

  private detachDom(): void {
    this.attachAbort?.abort();
    this.attachAbort = null;
    this.destroyEditor();
    this.unloadRenderer();
    this.host = null;
    this.bodyEl = null;
    this.statusEl = null;
    this.conflictEl = null;
    this.conflictLocalEl = null;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || this.loading) return this.loading ?? undefined;
    this.loading = (async () => {
      try {
        const raw = await this.app.vault.read(this.file);
        this.baselineRaw = raw;
        this.body = getDiaryBody(raw);
        this.dirty = false;
        this.loaded = true;
        this.deleted = false;
        this.saveError = "";
      } catch (error) {
        this.saveError = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = null;
        this.renderStatus();
        this.renderBody();
      }
    })();
    return this.loading;
  }

  private onBodyChanged(body: string): void {
    this.body = body;
    this.dirty = this.baselineRaw !== null && body !== getDiaryBody(this.baselineRaw);
    this.saveError = "";
    if (this.saving) this.pendingSave = true;
    if (this.conflictLocalEl) this.conflictLocalEl.value = body;
    this.renderStatus();
    if (!this.conflictRaw && !this.deleted) this.debouncedSave();
  }

  private save(): Promise<void> {
    if (
      !this.loaded ||
      !this.dirty ||
      this.conflictRaw !== null ||
      this.deleted ||
      this.baselineRaw === null
    ) {
      return Promise.resolve();
    }
    if (this.savePromise) {
      this.pendingSave = true;
      return this.savePromise;
    }

    const run = (async () => {
      try {
        let succeeded = true;
        while (
          succeeded &&
          this.dirty &&
          this.conflictRaw === null &&
          !this.deleted
        ) {
          this.pendingSave = false;
          succeeded = await this.performSave();
        }
      } finally {
        this.savePromise = null;
        if (this.syncRequested) void this.syncFromDisk();
      }
    })();
    this.savePromise = run;
    return run;
  }

  private async performSave(): Promise<boolean> {
    if (this.baselineRaw === null) return false;
    const bodyToSave = this.body;
    this.saving = true;
    this.renderStatus();

    try {
      const raw = await this.app.vault.process(this.file, (currentRaw) => {
        if (currentRaw !== this.baselineRaw) {
          throw new DiaryConflictError(currentRaw);
        }
        return replaceDiaryBody(currentRaw, bodyToSave);
      });
      this.baselineRaw = raw;
      this.dirty = this.body !== getDiaryBody(raw);
      this.saveError = "";
      return true;
    } catch (error) {
      if (error instanceof DiaryConflictError) {
        this.conflictRaw = error.externalRaw;
      } else {
        this.saveError = error instanceof Error ? error.message : String(error);
      }
      this.dirty = true;
      return false;
    } finally {
      this.saving = false;
      this.renderStatus();
      this.renderConflict();
    }
  }

  private syncFromDisk(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncRequested = false;

    const run = (async () => {
      try {
        if (!this.loaded || this.deleted) return;
        if (this.saving) {
          this.syncRequested = true;
          return;
        }
        const raw = await this.app.vault.read(this.file);
        if (this.saving) {
          this.syncRequested = true;
          return;
        }
        if (raw === this.baselineRaw) return;

        if (this.dirty) {
          this.conflictRaw = raw;
        } else {
          this.baselineRaw = raw;
          this.body = getDiaryBody(raw);
          this.renderBody();
        }
        this.renderStatus();
        this.renderConflict();
      } catch (error) {
        this.saveError = error instanceof Error ? error.message : String(error);
        this.renderStatus();
      }
    })();
    this.syncPromise = run;
    void run.finally(() => {
      this.syncPromise = null;
      if (this.syncRequested && !this.saving) {
        void this.syncFromDisk();
      }
    });
    return run;
  }

  private renderStatus(): void {
    if (!this.statusEl) return;
    let text = "";
    if (this.deleted && this.hasUnsavedContent) text = "文件已删除，本地编辑仍保留";
    else if (this.conflictRaw !== null) text = "检测到外部修改，自动保存已暂停";
    else if (this.saveError) text = `错误：${this.saveError}`;
    else if (this.loading) text = "加载中…";
    else if (this.saving) text = "保存中…";
    else if (this.dirty) text = "未保存";
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", Boolean(this.saveError || this.conflictRaw));
  }

  private renderBody(): void {
    if (!this.bodyEl) return;
    this.destroyEditor();
    this.unloadRenderer();
    this.bodyEl.replaceChildren();

    if (!this.loaded) {
      this.bodyEl.setText(this.saveError ? "无法加载日记" : "加载中…");
      return;
    }

    if (this.mode === "edit") {
      this.createLivePreview();
      return;
    }

    const container = this.bodyEl.createDiv({
      cls: "markdown-rendered diary-feed-rendered",
    });
    if (!this.body.trim()) {
      container.createDiv({ cls: "diary-feed-empty-entry", text: "空日记，点击编辑" });
      return;
    }

    const version = ++this.renderVersion;
    const child = new MarkdownRenderChild(container);
    this.renderChild = child;
    this.view.addChild(child);
    void MarkdownRenderer.render(
      this.app,
      this.body,
      container,
      this.file.path,
      child,
    )
      .then(() => {
        if (version !== this.renderVersion && this.renderChild === child) {
          this.unloadRenderer();
        }
      })
      .catch((error: unknown) => {
        this.saveError = error instanceof Error ? error.message : String(error);
        this.renderStatus();
      });
  }

  private createLivePreview(): void {
    if (!this.bodyEl) return;
    try {
      this.editor = createMarkdownEditor(
        this.bodyEl,
        this.body,
        {
          onChange: (body) => this.onBodyChanged(body),
          onBlur: () => void this.finishEditing(),
          onDone: () => void this.finishEditing(),
        },
        this.app,
        this.view,
        this.file.path,
      );
    } catch (error) {
      this.saveError = error instanceof Error ? error.message : String(error);
      this.renderStatus();
    }
  }

  private renderConflict(): void {
    if (!this.conflictEl) return;
    this.conflictEl.replaceChildren();
    this.conflictLocalEl = null;
    if (this.deleted && this.hasUnsavedContent) {
      this.conflictEl.createDiv({
        cls: "diary-feed-conflict-title",
        text: "原文件已删除，本地编辑仍保留。只有点击恢复才会重新创建文件。",
      });
      const restore = this.conflictEl.createEl("button", {
        cls: "mod-cta diary-feed-button",
        text: "恢复日记",
        attr: { type: "button" },
      });
      restore.addEventListener("click", () => void this.restore(), {
        signal: this.attachAbort?.signal,
      });
    }
    if (this.conflictRaw === null) return;

    this.conflictEl.createDiv({
      cls: "diary-feed-conflict-title",
      text: "此文件同时在外部被修改。请选择要保留的版本，自动保存不会覆盖外部版本。",
    });
    const columns = this.conflictEl.createDiv({ cls: "diary-feed-conflict-columns" });
    this.createConflictVersion(columns, "我的版本", this.body, true);
    this.createConflictVersion(
      columns,
      "外部版本",
      getDiaryBody(this.conflictRaw),
      false,
    );

    const actions = this.conflictEl.createDiv({ cls: "diary-feed-conflict-actions" });
    const mine = actions.createEl("button", {
      cls: "mod-warning diary-feed-button",
      text: "保留我的版本",
      attr: { type: "button" },
    });
    const external = actions.createEl("button", {
      cls: "diary-feed-button",
      text: "载入外部版本",
      attr: { type: "button" },
    });
    mine.addEventListener("click", () => void this.keepMine(), {
      signal: this.attachAbort?.signal,
    });
    external.addEventListener("click", () => this.keepExternal(), {
      signal: this.attachAbort?.signal,
    });
  }

  private createConflictVersion(
    parent: HTMLElement,
    title: string,
    content: string,
    local: boolean,
  ): void {
    const section = parent.createDiv();
    section.createEl("strong", { text: title });
    const textarea = section.createEl("textarea", {
      cls: "diary-feed-conflict-text",
    });
    textarea.value = content;
    textarea.readOnly = true;
    textarea.setAttribute("aria-label", title);
    if (local) this.conflictLocalEl = textarea;

    const copy = section.createEl("button", {
      cls: "diary-feed-button",
      text: local ? "复制我的内容" : "复制外部内容",
      attr: { type: "button" },
    });
    copy.addEventListener(
      "click",
      () => {
        void navigator.clipboard.writeText(content).then(() => copy.setText("已复制"));
      },
      { signal: this.attachAbort?.signal },
    );
  }

  private async keepMine(): Promise<void> {
    if (this.conflictRaw === null) return;
    this.baselineRaw = this.conflictRaw;
    this.conflictRaw = null;
    this.dirty = true;
    this.renderConflict();
    await this.save();
  }

  private keepExternal(): void {
    if (this.conflictRaw === null) return;
    const raw = this.conflictRaw;
    this.conflictRaw = null;
    this.baselineRaw = raw;
    this.body = getDiaryBody(raw);
    this.dirty = false;
    this.saveError = "";
    this.renderConflict();
    this.renderBody();
    this.renderStatus();
  }

  private async restore(): Promise<void> {
    if (this.baselineRaw === null) return;
    try {
      await this.store.ensureFolder();
      const raw = replaceDiaryBody(this.baselineRaw, this.body);
      this.file = await this.app.vault.create(this.file.path, raw);
      this.baselineRaw = raw;
      this.body = getDiaryBody(raw);
      this.deleted = false;
      this.dirty = false;
      this.saveError = "";
      this.store.refresh();
      this.renderConflict();
      this.renderStatus();
      this.renderBody();
    } catch (error) {
      this.saveError = error instanceof Error ? error.message : String(error);
      this.renderStatus();
    }
  }

  private destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  private unloadRenderer(): void {
    this.renderVersion += 1;
    if (this.renderChild) {
      this.view.removeChild(this.renderChild);
      this.renderChild = null;
    }
  }
}
