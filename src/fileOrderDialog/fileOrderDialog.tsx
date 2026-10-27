import { TAbstractFile, TFolder } from "obsidian";
import React, { FC, useCallback, useMemo, useState } from "react";
import { FileOrderDragBox } from "./fileOrderDragBox";
import { shouldIgnoreItem, sortByName } from "./utils";
import { FileOrderSettings } from "../settings";

export interface FileOrderDialogProps {
  parent: TFolder;
  onComplete: (newItems: Array<{ item: TAbstractFile; name: string }>) => void;
  defaults: FileOrderSettings;
}

export const FileOrderDialog: FC<FileOrderDialogProps> = ({
  parent,
  onComplete,
  defaults,
}) => {
  const [newFolderOrder, setNewFolderOrder] = useState<
    Array<{ item: TAbstractFile; name: string }>
  >([]);
  const [newFileOrder, setNewFileOrder] = useState<
    Array<{ item: TAbstractFile; name: string }>
  >([]);
  const shouldInclude = useCallback(
    (item: TAbstractFile) =>
      !shouldIgnoreItem(
        item.name,
        item.parent.name,
        defaults.ignorePattern,
        defaults.ignoreFolderFile,
      ),
    [defaults.ignoreFolderFile, defaults.ignorePattern],
  );
  const originalFolders = useMemo(
    () =>
      sortByName(
        parent.children.filter(
          (item) => item instanceof TFolder && shouldInclude(item),
        ),
      ),
    [parent.children, shouldInclude],
  );
  const originalFiles = useMemo(
    () =>
      sortByName(
        parent.children.filter(
          (item) => !(item instanceof TFolder) && shouldInclude(item),
        ),
      ),
    [parent.children, shouldInclude],
  );

  const onCompleteClick = useCallback(() => {
    onComplete([...newFolderOrder, ...newFileOrder]);
  }, [newFileOrder, newFolderOrder, onComplete]);

  return (
    <div className="file-order-dialog">
      <div className="file-order-dialog-content">
        <FileOrderDragBox
          originalItems={originalFolders}
          onChange={setNewFolderOrder}
          title="文件夹"
          defaults={defaults}
        />
        <FileOrderDragBox
          originalItems={originalFiles}
          onChange={setNewFileOrder}
          title="文件"
          defaults={defaults}
        />
      </div>
      <div className="file-order-dialog-row">
        <div className="file-order-dialog-row-grow" />
        <button type="button" className="mod-cta" onClick={onCompleteClick}>
          应用更改
        </button>
      </div>
    </div>
  );
};
