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
    containerEl.createEl("h2", { text: "文件排序 默认设置" });
    containerEl.createEl("p", {
      text: "要对文件排序，请在文件浏览器中右键任意文件或文件夹，然后点击「重新排序」。",
    });
    containerEl.createEl("p", {
      text: "以下设置为某个文件夹首次整理时的默认值。该文件夹之后的整理会沿用自身的设置（也可在排序对话框中点击「文件」/「文件夹」标题旁的下拉箭头，按文件夹单独调整）。",
    });

    new Setting(containerEl)
      .setName("前缀数字最小长度")
      .setDesc(
        "前缀数字不足该位数时将补零，例如 001 而非 1。设为 0 表示按实际位数。",
      )
      .addText((text) =>
        text
          .setValue(`${this.plugin.settings.prefixMinLength}`)
          .onChange(async (value) => {
            const parsedValue = parseInt(value, 10);
            if (Number.isNaN(parsedValue) || parsedValue < 0) {
              new Notice("前缀最小长度必须为不小于 0 的数字。");
              text.setValue(`${this.plugin.settings.prefixMinLength}`);
              return;
            }
            this.plugin.settings.prefixMinLength = parseInt(value, 10);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("分隔符")
      .setDesc("前缀数字与标题之间的分隔符，可以是任意字符（包括多个字符）。")
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
      .setDesc("前缀数字的起始值，默认 0。")
      .addText((text) =>
        text
          .setValue(`${this.plugin.settings.startingIndex}`)
          .onChange(async (value) => {
            const parsedValue = parseInt(value, 10);
            if (Number.isNaN(parsedValue) || parsedValue < 0) {
              new Notice("起始编号必须为不小于 0 的数字。");
              text.setValue(`${this.plugin.settings.startingIndex}`);
              return;
            }
            this.plugin.settings.startingIndex = parseInt(value, 10);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("忽略规则")
      .setDesc(
        "要忽略的文件/文件夹的正则表达式。例如 ^index\\.md$ 忽略 index.md。",
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
              text.setValue(this.plugin.settings.ignorePattern);
              return;
            }
            if (isRiskyRegexPattern(value)) {
              new Notice(
                `该正则过于复杂，可能在使用时卡顿，已拒绝："${value}"`,
              );
              text.setValue(this.plugin.settings.ignorePattern);
              return;
            }
            this.plugin.settings.ignorePattern = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("忽略同名文件夹说明文件")
      .setDesc(
        "开启后，文件夹 MyFolderName 下的同名说明文件 MyFolderName.md 会被忽略",
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
