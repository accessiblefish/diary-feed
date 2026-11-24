import {
  App,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import type DiaryFeedPlugin from "./main";

export interface DiaryFeedSettings {
  folder: string;
}

export const DEFAULT_SETTINGS: DiaryFeedSettings = {
  folder: "Diary",
};

export class DiaryFeedSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly diaryPlugin: DiaryFeedPlugin,
  ) {
    super(app, diaryPlugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "日记文件夹",
        desc: "只读取此文件夹直接子级中的 YYYY-MM-DD.md 文件，不递归读取子文件夹。",
        control: {
          type: "folder",
          key: "folder",
          placeholder: "Diary",
          defaultValue: DEFAULT_SETTINGS.folder,
          validate: (value) => (value.trim() ? undefined : "日记文件夹不能为空"),
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return key === "folder" ? this.diaryPlugin.settings.folder : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "folder" && typeof value === "string") {
      await this.diaryPlugin.updateSettings({ folder: value });
    }
  }
}
