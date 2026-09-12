import { Notice, Plugin, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, FileOrderSettings } from "./settings";
import { FileOrderSettingTab } from "./fileOrderSettingTab";
import { FileOrderModal } from "./fileOrderDialog/fileOrderModal";
import { tryToGetFixedName } from "./fileOrderDialog/utils";

// Command identifier; matched by settings/README and must stay stable.
const REORDER_ROOT_COMMAND_ID = "obsidian-file-order-reorder-top-folder";

export class FileOrder extends Plugin {
  settings: FileOrderSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new FileOrderSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle("重新排序")
            .setIcon("arrow-up-down")
            .onClick(async () => {
              const fileItem = file ?? this.app.vault.getRoot();
              const parent = (
                fileItem instanceof TFile ? fileItem.parent : fileItem
              ) as TFolder;
              new FileOrderModal(this, parent).open();
            });
        });

        const fixedName = file?.parent
          ? tryToGetFixedName(
              file.parent.children.map((i) => i.name),
              file.name,
            )
          : null;

        if (fixedName) {
          menu.addItem((item) => {
            item
              .setTitle("按排序规范修复名称")
              .setIcon("check")
              .onClick(async () => {
                await this.app.fileManager.renameFile(
                  file,
                  `${file.parent.path}/${fixedName}`,
                );
                new Notice(`已将名称修复为："${fixedName}"`);
              });
          });
        }
      }),
    );

    this.addCommand({
      id: REORDER_ROOT_COMMAND_ID,
      name: "重新排序根目录条目",
      callback: () => {
        new FileOrderModal(this, this.app.vault.getRoot()).open();
      },
    });
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
