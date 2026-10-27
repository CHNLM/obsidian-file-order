import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { FileOrder } from "./fileOrder";
import { isRiskyRegexPattern } from "./fileOrderDialog/utils";

export class FileOrderSettingTab extends PluginSettingTab {
  plugin: FileOrder;

  constructor(app: App, plugin: FileOrder) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "File Order 默认设置" });
    containerEl.createEl("p", {
      text: "要对文件排序，请在文件浏览器中右键任意文件或文件夹，然后点击「重新排序」。",
    });
    containerEl.createEl("p", {
      text: "以下设置仅在无法从文件名推断出排序信息时作为回退默认值；插件不保存文件夹级设置，排序对话框中的调整只对本次排序生效。",
    });

    new Setting(containerEl)
      .setName("数字前缀最小长度")
      .setDesc(
        "数字前缀不足该位数时会补零，例如 001 而非 1。设为 0 表示不指定最小位数，自动按最大编号所需位数补零。",
      )
      .addText((text) =>
        text
          .setValue(`${this.plugin.settings.prefixMinLength}`)
          .onChange(async (value) => {
            const parsedValue = /^\d+$/.test(value)
              ? Number(value)
              : Number.NaN;
            if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
              new Notice("数字前缀最小长度必须为不小于 0 的整数。");
              text.setValue(`${this.plugin.settings.prefixMinLength}`);
              return;
            }
            this.plugin.settings.prefixMinLength = parsedValue;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("分隔符")
      .setDesc(
        "数字前缀与标题之间的分隔符，可以是任意字符（包括多个字符），也可留空表示前缀直接接标题。建议使用空格、-、_、. 等非字母数字字符，便于从文件名自动推断。",
      )
      .addText((text) => {
        text.setValue(this.getDelLabel()).onChange(async (value) => {
          // Only ignore echoes of the "[N 个空格]" placeholder label. A real
          // delimiter may legitimately start with "[", so match the whole
          // label instead of trimming on the leading "[" character.
          if (/^\[\d+ 个空格\]$/.test(value)) {
            return;
          }
          this.plugin.settings.delimiter = value;
          await this.plugin.saveSettings();
        });
        // eslint-disable-next-line no-param-reassign
        text.inputEl.onfocus = () => {
          text.setValue(this.plugin.settings.delimiter);
        };
        // eslint-disable-next-line no-param-reassign
        text.inputEl.onblur = () => {
          text.setValue(this.getDelLabel());
        };
      });

    new Setting(containerEl)
      .setName("起始编号")
      .setDesc("第一个条目的编号，默认 0。")
      .addText((text) =>
        text
          .setValue(`${this.plugin.settings.startingIndex}`)
          .onChange(async (value) => {
            const parsedValue = /^\d+$/.test(value)
              ? Number(value)
              : Number.NaN;
            if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
              new Notice("起始编号必须为不小于 0 的整数。");
              text.setValue(`${this.plugin.settings.startingIndex}`);
              return;
            }
            this.plugin.settings.startingIndex = parsedValue;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("忽略规则")
      .setDesc(
        "匹配后不参与排序的文件/文件夹正则表达式。例如 ^index\\.md$ 忽略 index.md。",
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.ignorePattern)
          .onChange(async (value) => {
            if (value === "") {
              this.plugin.settings.ignorePattern = "";
              await this.plugin.saveSettings();
              return;
            }
            try {
              // Validate the regex before persisting, so an invalid
              // pattern cannot crash the reorder dialog later.
              new RegExp(value);
            } catch {
              new Notice(`无效的正则表达式："${value}"`);
              // Keep the user's input so an unfinished escape sequence (e.g.
              // typing "\." one character at a time) is not wiped; only valid
              // patterns are persisted.
              return;
            }
            if (isRiskyRegexPattern(value)) {
              new Notice(
                `该正则过于复杂，可能在使用时卡顿，已拒绝保存："${value}"`,
              );
              // Same as above: report the rejection without destroying input.
              return;
            }
            this.plugin.settings.ignorePattern = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("忽略同名文件夹说明文件")
      .setDesc(
        "开启后，文件夹 MyFolderName 中的同名说明文件 MyFolderName.md 会被自动忽略。",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.ignoreFolderFile)
          .onChange(async (value) => {
            this.plugin.settings.ignoreFolderFile = value;
            await this.plugin.saveSettings();
          });
      });
  }

  getDelLabel() {
    const currentValue = this.plugin.settings.delimiter;
    if (currentValue.split("").every((c) => c === " ")) {
      return `[${currentValue.length} 个空格]`;
    }
    return currentValue;
  }
}
