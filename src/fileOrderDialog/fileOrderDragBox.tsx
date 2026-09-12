import React, { FC, useState } from "react";
import { TAbstractFile, TFolder } from "obsidian";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { VscChevronDown, VscChevronUp } from "react-icons/vsc";
import { FileOrderItem } from "./fileOrderItem";
import { FileOrderSettings } from "../settings";
import { useFileOrderDragBox } from "./useFileOrderDragBox";
import { FileOrderDragBoxConfig } from "./fileOrderDragBoxConfig";

export interface FileOrderDragBoxProps {
  originalItems: TAbstractFile[];
  onChange: (newOrder: Array<{ item: TAbstractFile; name: string }>) => void;
  title: string;
  defaults: FileOrderSettings;
}

const SortableItem: FC<{
  item: TAbstractFile;
  newName: string;
  isFolder: boolean;
}> = ({ item, newName, isFolder }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.name });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div
      className={isDragging ? "file-order-dragging" : ""}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <FileOrderItem file={item} isFolder={isFolder} newName={newName} />
    </div>
  );
};

export const FileOrderDragBox: FC<FileOrderDragBoxProps> = (props) => {
  const { originalItems, title } = props;
  const {
    onUndoClick,
    clearCustomOrderingClick,
    currentItems,
    setCurrentItems,
    newNames,
    ...dragBoxConfigProps
  } = useFileOrderDragBox(props);
  const [expanded, setExpanded] = useState(false);
  // Touch-friendly sensors: pointer drag on desktop, tap-and-hold on mobile
  // (matches the plugin's isDesktopOnly: false declaration).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
  );

  if (originalItems.length === 0) {
    return null;
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = currentItems.findIndex((i) => i.name === active.id);
    const newIndex = currentItems.findIndex((i) => i.name === over.id);
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    setCurrentItems(arrayMove(currentItems, oldIndex, newIndex));
  };

  return (
    <>
      <div className="file-order-dialog-h2-container">
        <h2 className="file-order-dialog-h2">{title}</h2>
        <button type="button" onClick={onUndoClick}>
          撤销更改
        </button>
        <button type="button" onClick={clearCustomOrderingClick}>
          清除自定义排序
        </button>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          title="更多选项"
        >
          {expanded ? <VscChevronUp /> : <VscChevronDown />}
        </button>
      </div>
      <FileOrderDragBoxConfig expanded={expanded} {...dragBoxConfigProps} />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={currentItems.map((item) => item.name)}
          strategy={verticalListSortingStrategy}
        >
          {currentItems.map((item, index) => (
            <SortableItem
              key={item.name}
              item={item}
              isFolder={item instanceof TFolder}
              newName={newNames[index]}
            />
          ))}
        </SortableContext>
      </DndContext>
    </>
  );
};
