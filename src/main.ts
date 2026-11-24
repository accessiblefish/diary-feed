import { Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  DiaryFeedSettingTab,
  type DiaryFeedSettings,
} from "./settings";
import { DiaryStore } from "./store";
import { DIARY_FEED_VIEW_TYPE, DiaryFeedView } from "./view";

export default class DiaryFeedPlugin extends Plugin {
  settings: DiaryFeedSettings = { ...DEFAULT_SETTINGS };
  private store!: DiaryStore;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new DiaryStore(this.app, () => this.settings);
    this.store.refresh();

    this.registerView(
      DIARY_FEED_VIEW_TYPE,
      (leaf) => new DiaryFeedView(leaf, this.store),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.store.handleCreate(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.store.handleModify(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.store.handleDelete(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.store.handleRename(file, oldPath);
      }),
    );

    this.addRibbonIcon("calendar-days", "打开日记流", () => {
      void this.activateView();
    });
    this.addCommand({
      id: "open-diary-feed",
      name: "打开日记流",
      callback: () => void this.activateView(),
    });
    this.addSettingTab(new DiaryFeedSettingTab(this.app, this));
  }

  async updateSettings(settings: Partial<DiaryFeedSettings>): Promise<void> {
    this.settings = { ...this.settings, ...settings };
    await this.saveData(this.settings);
    this.store.refresh();
  }

  private async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<DiaryFeedSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DIARY_FEED_VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DIARY_FEED_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
