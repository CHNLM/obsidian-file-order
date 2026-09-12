import type { TAbstractFile } from "obsidian";

const escapeRegExp = (input: string) =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Duck-typing guard for Obsidian file/folder objects. Keeps this module free
// of a runtime dependency on the "obsidian" package (pure type import), which
// makes the pure functions directly testable in plain Node.
const isAbstractFile = (
  value: string | TAbstractFile,
): value is TAbstractFile =>
  typeof value !== "string" &&
  value !== null &&
  typeof value === "object" &&
  "name" in value &&
  "path" in value;

export const parseItemNamePieces = (fileName: string, delimiter: string) => {
  if (fileName.match(new RegExp(`^\\d+${escapeRegExp(delimiter)}`))) {
    const index = /^(\d+)/.exec(fileName)![1];
    const numberLength = index.length;
    return {
      index: parseInt(index, 10),
      name: fileName.slice(numberLength + delimiter.length),
    };
  }
  return null;
};

export const parseItemName = (fileName: string, delimiter: string) => {
  const parsed = parseItemNamePieces(fileName, delimiter);
  if (parsed) {
    return parsed.name;
  }
  return fileName;
};

const generateItemName = (
  fileName: string,
  index: number,
  delimiter: string,
  prefixMinLength: number,
) => {
  const prefix = index.toString().padStart(prefixMinLength, "0");
  return `${prefix}${delimiter}${fileName}`;
};

// Reuse a single collator instance instead of allocating one per comparison.
const collator = new Intl.Collator([], { numeric: true });

export const obsidianCompareNames = (
  a: string | TAbstractFile,
  b: string | TAbstractFile,
) => {
  const aName = isAbstractFile(a) ? a.name : a;
  const bName = isAbstractFile(b) ? b.name : b;
  return collator.compare(aName, bName);
};

export const sortByName = <T extends string | TAbstractFile>(items: T[]) => {
  const sorted = [...items];
  sorted.sort(obsidianCompareNames);
  return sorted;
};

export const computeNewNames = (opts: {
  originalItems: string[];
  newOrder: string[];
  prefixMinLength: number;
  delimiter: string;
  originalPrefixMinLength: number;
  originalDelimiter: string;
  startingIndex: number;
  forceStrip?: boolean;
}) => {
  const newOrderTitles = opts.newOrder.map((item) =>
    parseItemName(item, opts.originalDelimiter),
  );

  // Compare full (prefixed) names, NOT the stripped titles. Stripping the
  // prefix can collapse distinct files into the same title (e.g. numbered-only
  // names "01.md"/"02.md" both strip to "md"), which would make a reorder look
  // "identical" and silently drop the user's drag.
  const areIdentical = sortByName(opts.originalItems).every(
    (name, index) => name === opts.newOrder[index],
  );

  if (opts.forceStrip) {
    // "Clear custom ordering": explicitly remove all prefixes,
    // keeping the current (user-dragged) order.
    return newOrderTitles;
  }

  if (opts.prefixMinLength === 0 && areIdentical) {
    // No padding configured and the current order matches the sorted
    // order: keep the original full names so that merely opening and
    // applying the dialog does not destructively strip existing
    // numeric prefixes.
    return opts.originalItems;
  }

  return newOrderTitles.map((item, index) =>
    generateItemName(
      item,
      index + opts.startingIndex,
      opts.delimiter,
      Math.max(opts.prefixMinLength, `${newOrderTitles.length}`.length),
    ),
  );
};

export const inferOrderProperties = (items: string[]) => {
  // A single item carries no ordering information: every character is "shared"
  // with itself, which would make the delimiter inference swallow the whole
  // name (e.g. "01 a.md" -> delimiter " a."). Treat it as undecidable.
  if (items.length < 2) {
    return null;
  }

  const isOrdered = items.every((item) => item.match(/^\d+/));
  if (!isOrdered) {
    return null;
  }
  const numberLength = /^(\d+)/.exec(items[0])![1].length;
  const isActualPrefixLength = items.every((item) =>
    item.match(new RegExp(`^\\d{${String(items.length).length}}[^\\d]`)),
  );

  let delimiter = "";
  for (let i = numberLength; i < items[0].length; i++) {
    const char = items[0][i];
    if (items.every((item) => item[i] === char)) {
      delimiter += char;
    } else {
      break;
    }
  }

  // Common name prefixes (e.g. "Chapter" in "01 Chapter1.md") are also
  // shared by all items and get swept into the delimiter. Strip trailing
  // alphanumeric/CJK characters so the delimiter stays a real separator,
  // preventing names like "01 ChapterChapter1.md" when regenerating.
  delimiter = delimiter.replace(/[a-z0-9\u4e00-\u9fa5]+$/i, "");

  const lowestIndex = items
    .map((item) => parseInt(item.slice(0, numberLength), 10))
    .reduce((acc, item) => Math.min(acc, item), Number.MAX_SAFE_INTEGER);

  return {
    prefixMinLength: !isActualPrefixLength ? numberLength : 0,
    delimiter,
    startingIndex: lowestIndex,
  };
};

export const tryToGetFixedName = (
  items: string[] | undefined,
  brokenName: string,
) => {
  if (!items) {
    return null;
  }

  const properties = inferOrderProperties(
    items.filter((i) => i !== brokenName),
  );
  if (!properties) {
    return null;
  }

  const namePieces = parseItemNamePieces(brokenName, properties.delimiter);
  if (!namePieces) {
    // Pick the next free index as (largest existing index + 1) instead of
    // (items.length + startingIndex), so gaps in the numbering (e.g. 01, 02,
    // 04) can never collide with the file being fixed.
    const maxIndex = items.reduce((acc, item) => {
      const pieces = parseItemNamePieces(item, properties.delimiter);
      return pieces ? Math.max(acc, pieces.index) : acc;
    }, properties.startingIndex);
    const nextIndex = maxIndex + 1;
    return generateItemName(
      parseItemName(brokenName, properties.delimiter),
      nextIndex,
      properties.delimiter,
      Math.max(properties.prefixMinLength, `${nextIndex}`.length),
    );
  }

  return null;
};

/**
 * Detect which entries must be moved to a temporary name first before the
 * batch rename runs. When one entry's target name equals another entry's
 * current name (a swap A->B / B->A, or a rotation A->B, B->C, C->A), renaming
 * straight through would hit an already-taken target and fail mid-way. The
 * returned "current" names are exactly those slots that get overwritten, so
 * moving them aside first frees every target slot and makes the batch safe.
 */
export const findSlotOwnersToFree = (
  renames: Array<{ current: string; target: string }>,
): string[] => {
  const currentSet = new Set(renames.map((r) => r.current));
  const owners = new Set<string>();
  for (const { target } of renames) {
    if (currentSet.has(target)) {
      owners.add(target);
    }
  }
  return [...owners];
};

/**
 * Heuristic for regex patterns prone to catastrophic backtracking (ReDoS),
 * e.g. "^(a+)+$" or "(ab*)*". Such patterns can run exponentially long on a
 * short filename and freeze the plugin's UI. We flag nested repetition — a
 * group containing another quantifier (*, +) that is itself followed by a
 * quantifier. This conservative gate avoids blocking ordinary, safe patterns
 * like "(Chapter|Section) +\d+".
 */
export const isRiskyRegexPattern = (pattern: string): boolean => {
  if (pattern.includes("\u0000")) {
    return true;
  }
  try {
    new RegExp(pattern);
  } catch {
    return true;
  }
  // A quantified group whose body contains its own quantifier.
  return /\([^()]*[+*][^()]*\)[+*?]/.test(pattern);
};
