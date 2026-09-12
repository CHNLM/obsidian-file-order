import React, { FC, useId, useRef } from "react";

interface FileOrderDragBoxConfigProps {
  prefixLen: number;
  setPrefixLen: (val: number) => void;
  delim: string;
  setDelim: (val: string) => void;
  startingIndex: number;
  setStartingIndex: (val: number) => void;
  expanded: boolean;
}

export const FileOrderDragBoxConfig: FC<FileOrderDragBoxConfigProps> = ({
  delim,
  setDelim,
  setStartingIndex,
  startingIndex,
  prefixLen,
  setPrefixLen,
  expanded,
}) => {
  const configElementRef = useRef<HTMLDivElement>(null);

  const prefixLenId = useId();
  const delimiterId = useId();
  const startingIndexId = useId();
  return (
    <div
      ref={configElementRef}
      className={[
        "file-order-dialog-items-config",
        expanded ? "file-order-expanded" : "file-order-hidden",
      ].join(" ")}
      style={{
        maxHeight: expanded ? configElementRef.current?.scrollHeight : 0,
      }}
    >
      <div className="file-order-field">
        <label htmlFor={prefixLenId}>前缀最小长度</label>
        <input
          id={prefixLenId}
          type="number"
          min={0}
          placeholder="123"
          style={{ width: "30px" }}
          value={prefixLen}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            setPrefixLen(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
          }}
        />
      </div>

      <div
        className="file-order-field"
        title={
          delim.split("").every((c) => c === " ")
            ? `${delim.length} space${delim.length > 1 ? "s" : ""}`
            : ""
        }
      >
        <label htmlFor={delimiterId}>分隔符</label>
        <input
          id={delimiterId}
          type="text"
          placeholder="x"
          style={{ width: "40px" }}
          value={delim}
          onChange={(e) => {
            setDelim(e.target.value);
          }}
        />
      </div>

      <div className="file-order-field">
        <label htmlFor={startingIndexId}>起始编号</label>
        <input
          id={startingIndexId}
          type="number"
          placeholder="0"
          style={{ width: "30px" }}
          value={startingIndex}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            setStartingIndex(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
          }}
        />
      </div>
    </div>
  );
};
