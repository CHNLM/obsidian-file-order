import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "obsidian";
import {
  computeNewNames,
  inferOrderProperties,
  obsidianCompareNames,
  parseItemName,
} from "./utils";
import { FileOrderDragBoxProps } from "./fileOrderDragBox";

export const useFileOrderDragBox = ({
  originalItems,
  defaults,
  onChange,
}: FileOrderDragBoxProps) => {
  const [currentItems, setCurrentItems] = useState(originalItems);
  const [originalDelim, setOriginalDelim] = useState(defaults.delimiter);
  const [originalPrefixLen, setOriginalPrefixLen] = useState(
    defaults.prefixMinLength,
  );
  const [originalStartingIndex, setOriginalStartingIndex] = useState(
    defaults.startingIndex,
  );
  const [delim, setDelim] = useState(defaults.delimiter);
  const [prefixLen, setPrefixLen] = useState(defaults.prefixMinLength);
  const [startingIndex, setStartingIndex] = useState(defaults.startingIndex);
  const [forceStrip, setForceStrip] = useState(false);

  // Keep the dragged list in sync with the underlying file tree. The folder
  // snapshot (originalItems) can change while the modal is open (e.g. a file
  // is created/renamed in Obsidian); resetting to the fresh snapshot is the
  // correct behavior for a short-lived modal. Just surface a lightweight hint
  // when that reset discards user-entered ordering, so it is not silent.
  const currentNamesRef = useRef(currentItems.map((i) => i.name));
  currentNamesRef.current = currentItems.map((i) => i.name);

  useEffect(() => {
    const wasModified = currentNamesRef.current.some(
      (name, index) => name !== originalItems[index]?.name,
    );
    if (wasModified) {
      new Notice("文件列表已更新，已重置已拖拽的顺序与排序配置。");
    }
    setCurrentItems(originalItems);
  }, [originalItems]);

  const newNames = useMemo(
    () =>
      computeNewNames({
        originalItems: originalItems.map((item) => item.name),
        newOrder: currentItems.map((item) => item.name),
        delimiter: delim,
        prefixMinLength: prefixLen,
        originalDelimiter: originalDelim,
        originalPrefixMinLength: originalPrefixLen,
        startingIndex,
        forceStrip,
      }),
    [
      currentItems,
      delim,
      forceStrip,
      originalDelim,
      originalItems,
      originalPrefixLen,
      prefixLen,
      startingIndex,
    ],
  );

  useEffect(() => {
    const properties = inferOrderProperties(
      originalItems.map((item) => item.name),
    );
    if (properties) {
      setDelim(properties.delimiter);
      setOriginalDelim(properties.delimiter);
      setPrefixLen(properties.prefixMinLength);
      setOriginalPrefixLen(properties.prefixMinLength);
      setStartingIndex(properties.startingIndex);
      setOriginalStartingIndex(properties.startingIndex);
    }
  }, [originalItems]);

  useEffect(() => {
    const newItems = currentItems
      .map((item, index) => ({
        item,
        name: newNames[index],
      }))
      .filter(({ name, item }) => name !== item.name);
    onChange(newItems);
  }, [currentItems, newNames, onChange]);

  const onUndoClick = useCallback(() => {
    setCurrentItems(originalItems);
    setDelim(originalDelim);
    setPrefixLen(originalPrefixLen);
    setStartingIndex(originalStartingIndex);
    setForceStrip(false);
  }, [originalDelim, originalItems, originalPrefixLen, originalStartingIndex]);

  const clearCustomOrderingClick = useCallback(() => {
    setPrefixLen(0);
    const items = [...currentItems];
    items.sort((a, b) =>
      obsidianCompareNames(
        parseItemName(a.name, delim),
        parseItemName(b.name, delim),
      ),
    );
    setCurrentItems(items);
    setForceStrip(true);
  }, [currentItems, delim]);

  return {
    onUndoClick,
    clearCustomOrderingClick,
    prefixLen,
    setPrefixLen,
    delim,
    setDelim,
    startingIndex,
    setStartingIndex,
    currentItems,
    setCurrentItems,
    newNames,
  };
};
