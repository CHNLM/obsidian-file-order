import { Modal, Notice, TAbstractFile, TFolder } from "obsidian";
import ReactDOM from "react-dom/client";
import React from "react";
import { FileOrder } from "../fileOrder";
import { FileOrderDialog, FileOrderDialogProps } from "./fileOrderDialog";
import { findSlotOwnersToFree } from "./utils";

// Console-log tag shared across this module, so logs can be filtered together.
const LOG_TAG = "[obsidian-file-order]";
// Prefix for temporary slot names used by the two-phase rename.
const TEMP_NAME_PREFIX = "__fileorder_tmp_";

export class FileOrderModal extends Modal {
  private reactRoot: ReturnType<typeof ReactDOM.createRoot>;

  constructor(
    private plugin: FileOrder,
    private parent: TFolder,
  ) {
    super(plugin.app);
    this.reactRoot = ReactDOM.createRoot(this.contentEl);
    this.titleEl.innerHTML = `重新排序：${parent.path}`;
    this.reactRoot.render(
      <FileOrderDialog
        parent={parent}
        onComplete={this.onComplete}
        defaults={plugin.settings}
      />,
    );
  }

  onComplete: FileOrderDialogProps["onComplete"] = async (newItems) => {
    // Pre-flight collision check: two items mapping to the same target name,
    // or a target name already taken by a sibling that is not being renamed
    // (e.g. a file excluded via the ignore pattern), would make renameFile
    // fail mid-way and leave the folder half-renamed.
    const targetMap = new Map<string, TAbstractFile>();
    const conflicts = new Set<string>();
    for (const { item, name } of newItems) {
      if (targetMap.has(name) && targetMap.get(name) !== item) {
        conflicts.add(`"${name}"`);
      } else {
        targetMap.set(name, item);
      }
    }
    const firstItem = newItems[0]?.item;
    const parent = firstItem?.parent;
    if (parent) {
      const renaming = new Set(newItems.map(({ item }) => item));
      for (const { item, name } of newItems) {
        const occupant = parent.children.find(
          (c) => c.name === name && c !== item && !renaming.has(c),
        );
        if (occupant) {
          conflicts.add(`"${name}"`);
        }
      }
    }
    if (conflicts.size > 0) {
      new Notice(
        `无法重命名：目标名称已存在：${[...conflicts].join(
          ", ",
        )}。未做任何更改。`,
      );
      return;
    }

    // Two-phase rename to survive swaps/rotations (e.g. A->B, B->A). A swap
    // passes the pre-flight collision check (both targets are held by items
    // that ARE being renamed), but renaming straight through would hit a
    // name that still exists. Entries whose current name is some other
    // entry's target are moved aside first to free every target slot.
    const renameBatch = newItems.map(({ item, name }) => ({
      current: item.name,
      target: name,
    }));
    const ownersToFree = new Set(findSlotOwnersToFree(renameBatch));
    const ownerByName = new Map(newItems.map(({ item }) => [item.name, item]));

    let failedCount = 0;
    const performRename = async (item: TAbstractFile, toName: string) => {
      try {
        await this.plugin.app.fileManager.renameFile(
          item,
          `${item.parent.path}/${toName}`,
        );
        return true;
      } catch (error) {
        failedCount += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[obsidian-file-order] Failed to rename "${item.name}" to "${toName}":`,
          error,
        );
        return false;
      }
    };

    const tempOwners: Array<{
      item: TAbstractFile;
      originalName: string;
    }> = [];
    let tmpSeq = 0;
    for (const ownerName of ownersToFree) {
      const item = ownerByName.get(ownerName);
      if (item) {
        const tempName = `${TEMP_NAME_PREFIX}${Date.now()}_${tmpSeq++}_${ownerName}`;
        await performRename(item, tempName);
        tempOwners.push({ item, originalName: ownerName });
      }
    }
    for (const { item, name } of newItems) {
      await performRename(item, name);
    }

    // Roll back temp-moved entries whose final rename failed, so a partial
    // failure does not leave "__fileorder_tmp_*" names behind in the folder.
    // Rollbacks are best-effort and reported separately (not counted as the
    // same "failed" total, to keep the message accurate).
    for (const { item, originalName } of tempOwners) {
      if (item.name !== originalName) {
        try {
          await this.plugin.app.fileManager.renameFile(
            item,
            `${item.parent.path}/${originalName}`,
          );
        } catch {
          // eslint-disable-next-line no-console
          console.warn(
            `${LOG_TAG} Could not restore "${item.name}" to "${originalName}"`,
          );
        }
      }
    }

    if (failedCount > 0) {
      new Notice(`有 ${failedCount} 个条目无法重命名，详情见控制台。`);
    } else {
      this.close();
    }
  };

  onClose() {
    // Unmount the React tree so reopening the dialog does not create a
    // second root on the same container / leak the previous one.
    this.reactRoot?.unmount();
    super.onClose();
  }
}
