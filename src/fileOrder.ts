import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, FileOrderSettings } from "./settings";
import { FileOrderSettingTab } from "./fileOrderSettingTab";
import { FileOrderModal } from "./fileOrderDialog/fileOrderModal";
import { shouldIgnoreItem, tryToGetFixedName } from "./fileOrderDialog/utils";

// Stable command identifier: changing it breaks existing user hotkeys.
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

        // Skip the same items the reorder dialog ignores, otherwise an ignored
        // unprefixed sibling (typically a folder note) would make inference
        // fail and hide the fix action. An ignored item itself must not offer
        // the fix either, since renaming it would pull it back into the order.
        const parent = file?.parent;
        const ignoredTarget =
          !parent ||
          shouldIgnoreItem(
            file.name,
            parent.name,
            this.settings.ignorePattern,
            this.settings.ignoreFolderFile,
          );
        const siblingNames = parent?.children
          .filter(
            (child) =>
              !shouldIgnoreItem(
                child.name,
                parent.name,
                this.settings.ignorePattern,
                this.settings.ignoreFolderFile,
              ),
          )
          .map((child) => child.name);
        const fixedName =
          siblingNames && !ignoredTarget
            ? tryToGetFixedName(siblingNames, file.name)
            : null;

        if (fixedName) {
          menu.addItem((item) => {
            item
              .setTitle("按排序规范修复名称")
              .setIcon("check")
              .onClick(async () => {
                await this.app.fileManager.renameFile(
                  file,
                  normalizePath(`${parent!.path}/${fixedName}`),
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
