// Unit tests for the pure functions in src/fileOrderDialog/utils.ts.
//
// Runs with plain Node (>= 22.6, type-stripping enabled), no test framework
// or compiled output required:
//   node --experimental-strip-types --test tests/utils.test.ts
//
// Because utils.ts only type-imports "obsidian" (duck-typing guard), it can
// be loaded directly by Node without mocking the Obsidian API.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeNewNames,
  findSlotOwnersToFree,
  inferOrderProperties,
  isRiskyRegexPattern,
  nameCollisionKey,
  obsidianCompareNames,
  parseItemName,
  parseItemNamePieces,
  safeMatch,
  shouldIgnoreItem,
  sortByName,
  tryToGetFixedName,
} from "../src/fileOrderDialog/utils.ts";

// ---- parseItemNamePieces / parseItemName ----

test("parses a plain numbered name with a space delimiter", () => {
  assert.deepEqual(parseItemNamePieces("01 a.md", " "), {
    index: 1,
    name: "a.md",
  });
});

test("returns null when the name has no number prefix", () => {
  assert.equal(parseItemNamePieces("a.md", " "), null);
});

test("escapes regex metacharacters in the delimiter (open paren)", () => {
  assert.deepEqual(parseItemNamePieces("01(a).md", "("), {
    index: 1,
    name: "a).md",
  });
});

test("does not mis-parse a space+paren name when delimiter is just the paren", () => {
  assert.equal(parseItemNamePieces("01 (a).md", "("), null);
});

test("escapes dot delimiter", () => {
  assert.deepEqual(parseItemNamePieces("01.a.md", "."), {
    index: 1,
    name: "a.md",
  });
});

test("handles full-width space delimiter", () => {
  assert.deepEqual(parseItemNamePieces("01　标题.md", "　"), {
    index: 1,
    name: "标题.md",
  });
});

test("parseItemName falls back to the raw name", () => {
  assert.equal(parseItemName("plain.md", " "), "plain.md");
});

// ---- computeNewNames ----

const applyOpts = (overrides = {}) => ({
  originalItems: ["01 a.md", "02 b.md"],
  newOrder: ["01 a.md", "02 b.md"],
  prefixMinLength: 0,
  delimiter: " ",
  originalPrefixMinLength: 0,
  originalDelimiter: " ",
  startingIndex: 0,
  ...overrides,
});

test("apply without changes keeps original names (no prefix stripping)", () => {
  assert.deepEqual(computeNewNames(applyOpts()), ["01 a.md", "02 b.md"]);
});

test("forceStrip removes prefixes (clear custom ordering)", () => {
  assert.deepEqual(
    computeNewNames(applyOpts({ forceStrip: true })),
    ["a.md", "b.md"]
  );
});

test("reordering regenerates prefixes preserving inferred style", () => {
  assert.deepEqual(
    computeNewNames(
      applyOpts({
        newOrder: ["02 b.md", "01 a.md"],
        prefixMinLength: 2,
        originalPrefixMinLength: 2,
        startingIndex: 1,
      })
    ),
    ["01 b.md", "02 a.md"]
  );
});

test("respects the configured minimum prefix length", () => {
  assert.deepEqual(
    computeNewNames(
      applyOpts({
        newOrder: ["02 b.md", "01 a.md"],
        prefixMinLength: 3,
        originalPrefixMinLength: 2,
        startingIndex: 1,
      })
    ),
    ["001 b.md", "002 a.md"]
  );
});

test("names without prefixes and unchanged order stay untouched", () => {
  assert.deepEqual(
    computeNewNames(
      applyOpts({
        originalItems: ["a.md", "b.md", "c.md"],
        newOrder: ["a.md", "b.md", "c.md"],
      })
    ),
    ["a.md", "b.md", "c.md"]
  );
});

test("dragging unpadded items generates prefixes", () => {
  assert.deepEqual(
    computeNewNames(
      applyOpts({
        originalItems: ["a.md", "b.md", "c.md"],
        newOrder: ["c.md", "a.md", "b.md"],
      })
    ),
    ["0 c.md", "1 a.md", "2 b.md"]
  );
});

test("prefix length grows with the number of items", () => {
  const items = Array.from({ length: 12 }, (_, i) => `${i} f${i}.md`);
  const names = computeNewNames(
    applyOpts({ originalItems: items, newOrder: [...items].reverse() })
  );
  assert.equal(names.length, 12);
  // 12 items -> 2-digit prefixes (00-11)
  assert.ok(names.every((n) => /^\d{2} /.test(n)));
});

test("prefix width accounts for the largest index, not just the count", () => {
  // 9 items starting at 5 end at 13, which needs 2 digits (05..13).
  const items = Array.from({ length: 9 }, (_, i) => `${5 + i} f${i}.md`);
  const names = computeNewNames(
    applyOpts({
      originalItems: items,
      newOrder: [...items].reverse(),
      startingIndex: 5,
      originalStartingIndex: 5,
    })
  );
  assert.ok(names.every((n) => /^\d{2} /.test(n)));
  assert.equal(names[0], "05 f8.md");
  assert.equal(names[8], "13 f0.md");
});

test("keeps names when config changes but some items are unprefixed", () => {
  assert.deepEqual(
    computeNewNames(
      applyOpts({
        originalItems: ["1 a.md", "b.md"],
        newOrder: ["1 a.md", "b.md"],
        delimiter: "-",
        prefixMinLength: 0,
        originalPrefixMinLength: 0,
        startingIndex: 1,
        originalStartingIndex: 1,
      })
    ),
    ["1 a.md", "b.md"]
  );
});

test("applies delimiter changes without a drag when every item is numbered",
  () => {
    assert.deepEqual(
      computeNewNames(
        applyOpts({
          originalItems: ["1 a.md", "2 b.md"],
          newOrder: ["1 a.md", "2 b.md"],
          delimiter: "-",
          prefixMinLength: 0,
          originalPrefixMinLength: 0,
          startingIndex: 1,
        })
      ),
      ["1-a.md", "2-b.md"]
    );
  }
);

test("keeps unprefixed names when only the config changes", () => {
  assert.deepEqual(
    computeNewNames(
      applyOpts({
        originalItems: ["a.md", "b.md"],
        newOrder: ["a.md", "b.md"],
        delimiter: "-",
        prefixMinLength: 0,
        originalPrefixMinLength: 0,
        startingIndex: 1,
      })
    ),
    ["a.md", "b.md"]
  );
});

test("never adds prefixes without a drag even when a minimum length is set",
  () => {
    assert.deepEqual(
      computeNewNames(
        applyOpts({
          originalItems: ["a.md", "b.md"],
          newOrder: ["a.md", "b.md"],
          prefixMinLength: 3,
          originalPrefixMinLength: 0,
          startingIndex: 0,
        })
      ),
      ["a.md", "b.md"]
    );
  }
);

test("applies a starting-index change without a drag when all items are numbered",
  () => {
    assert.deepEqual(
      computeNewNames(
        applyOpts({
          originalItems: ["1 a.md", "2 b.md"],
          newOrder: ["1 a.md", "2 b.md"],
          prefixMinLength: 0,
          originalPrefixMinLength: 0,
          startingIndex: 5,
          originalStartingIndex: 1,
        })
      ),
      ["5 a.md", "6 b.md"]
    );
  }
);

// ---- inferOrderProperties ----

test("infers properties for a shared-prefix folder", () => {
  assert.deepEqual(
    inferOrderProperties(["01 Chapter1.md", "02 Chapter2.md"]),
    { prefixMinLength: 2, delimiter: " ", startingIndex: 1 }
  );
});

test("infers padded prefixes (001)", () => {
  assert.deepEqual(
    inferOrderProperties(["001 a.md", "002 b.md", "003 c.md"]),
    { prefixMinLength: 3, delimiter: " ", startingIndex: 1 }
  );
});

test("single-digit prefixes that exactly fit are left unpadded", () => {
  assert.deepEqual(inferOrderProperties(["1 a.md", "2 b.md"]), {
    prefixMinLength: 0,
    delimiter: " ",
    startingIndex: 1,
  });
});

test("infers properties for Chinese titles", () => {
  assert.deepEqual(inferOrderProperties(["01 标题.md", "02 内容.md"]), {
    prefixMinLength: 2,
    delimiter: " ",
    startingIndex: 1,
  });
});

test("returns null for empty or unordered lists", () => {
  assert.equal(inferOrderProperties([]), null);
  assert.equal(inferOrderProperties(["a.md", "b.md"]), null);
});

test("infers the delimiter when prefix widths differ", () => {
  assert.deepEqual(
    inferOrderProperties(["1 a.md", "2 b.md", "10 c.md"]),
    { prefixMinLength: 1, delimiter: " ", startingIndex: 1 }
  );
});

// ---- tryToGetFixedName ----

test("fixes a new file with the next free index (max+1)", () => {
  // Items are 01, 02, 03 -> next is 04 (old bug would use items.length+start).
  const items = ["01 a.md", "02 b.md", "03 c.md"];
  assert.equal(tryToGetFixedName(items, "new.md"), "04 new.md");
});

test("skips gaps when computing the next index (01, 02, 04 -> 05)", () => {
  const items = ["01 a.md", "02 b.md", "04 d.md"];
  assert.equal(tryToGetFixedName(items, "new.md"), "05 new.md");
});

test("returns null when the name already follows the convention", () => {
  // brokenName is not among the siblings; it is already convention-compliant
  // (has a parseable number prefix), so no fix is offered.
  assert.equal(
    tryToGetFixedName(["01 a.md", "03 c.md"], "02 b.md"),
    null
  );
});

test("returns null for unordered folders", () => {
  assert.equal(tryToGetFixedName(["a.md", "b.md"], "c.md"), null);
});

test("returns null when there is only one numbered sibling to infer from",
  () => {
    assert.equal(tryToGetFixedName(["01 a.md"], "new.md"), null);
  }
);

// ---- obsidianCompareNames / sortByName ----

test("sorts names with numeric collation (2 < 10)", () => {
  assert.deepEqual(sortByName(["10 b", "2 a"]), ["2 a", "10 b"]);
});

test("obsidianCompareNames accepts strings and TAbstractFile-like objects", () => {
  const folder = { name: "02 folder", path: "/02 folder" };
  const file = { name: "01 file", path: "/01 file" };
  assert.ok(obsidianCompareNames(file, folder) < 0);
  assert.equal(obsidianCompareNames("same", "same"), 0);
});

// ---- findSlotOwnersToFree ----

test("frees both names on a swap (A->B, B->A)", () => {
  assert.deepEqual(
    findSlotOwnersToFree([
      { current: "a.md", target: "b.md" },
      { current: "b.md", target: "a.md" },
    ]),
    ["b.md", "a.md"],
  );
});

test("frees the overwritten slots on a rotation (A->B, B->C)", () => {
  assert.deepEqual(
    findSlotOwnersToFree([
      { current: "a.md", target: "b.md" },
      { current: "b.md", target: "c-new.md" },
    ]),
    ["b.md"],
  );
});

test("returns empty when no target collides with a current name", () => {
  assert.deepEqual(
    findSlotOwnersToFree([
      { current: "a.md", target: "b-new.md" },
      { current: "c.md", target: "d-new.md" },
    ]),
    [],
  );
});

test("frees slots when a target differs only in case (case-insensitive FS)",
  () => {
    const batch = [
      { current: "01 A.md", target: "02 A.md" },
      { current: "02 a.md", target: "03 a.md" },
    ];
    // Exact matching misses the collision, which breaks the rename on
    // Windows/macOS/iOS where the two names refer to the same slot.
    assert.deepEqual(findSlotOwnersToFree(batch), []);
    // The slot belongs to the item currently named "02 a.md".
    assert.deepEqual(findSlotOwnersToFree(batch, true), ["02 a.md"]);
  }
);

// ---- findSlotOwnersToFree output feeds the two-phase rename ----

test("computeNewNames reorders numbered-only names (stripped titles collapse)",
  () => {
    // "01.md"/"02.md" both strip to "md", so comparing stripped titles would
    // report "identical" and drop the drag. Compare full names instead.
    assert.deepEqual(
      computeNewNames(
        applyOpts({
          originalItems: ["01.md", "02.md"],
          newOrder: ["02.md", "01.md"],
          delimiter: ".",
          originalDelimiter: ".",
          prefixMinLength: 0,
          originalPrefixMinLength: 0,
          startingIndex: 1,
        })
      ),
      ["1.md", "2.md"]
    );
  }
);

test("computeNewNames keeps names when reorder leaves full order unchanged",
  () => {
    assert.deepEqual(
      computeNewNames(
        applyOpts({
          originalItems: ["01.md", "02.md"],
          newOrder: ["01.md", "02.md"],
          delimiter: ".",
          originalDelimiter: ".",
          prefixMinLength: 0,
          originalPrefixMinLength: 0,
          startingIndex: 1,
        })
      ),
      ["01.md", "02.md"]
    );
  }
);

// ---- isRiskyRegexPattern ----

test("flags nested-repetition ReDoS patterns", () => {
  assert.equal(isRiskyRegexPattern("^(a+)+$"), true);
  assert.equal(isRiskyRegexPattern("(ab*)*"), true);
  assert.equal(isRiskyRegexPattern("(a|b)*"), false);
});

test("accepts ordinary safe patterns", () => {
  assert.equal(isRiskyRegexPattern("^index\\.md$"), false);
  assert.equal(isRiskyRegexPattern("(Chapter|Section) \\d+"), false);
  assert.equal(isRiskyRegexPattern("^\\.(?!obsidian).*"), false);
});

test("treats invalid or null-byte patterns as risky", () => {
  assert.equal(isRiskyRegexPattern("(unterminated"), true);
  assert.equal(isRiskyRegexPattern("a\u0000b"), true);
});

// ---- safeMatch / shouldIgnoreItem ----

test("safeMatch never throws on invalid or risky patterns", () => {
  assert.equal(safeMatch("index.md", "("), false);
  assert.equal(safeMatch("index.md", "^(a+)+$"), false);
  assert.equal(safeMatch("index.md", "^index\\.md$"), true);
});

test("shouldIgnoreItem applies the folder-note and regex rules", () => {
  assert.equal(shouldIgnoreItem("第一章.md", "第一章", "", true), true);
  assert.equal(
    shouldIgnoreItem("index.md", "第一章", "^index\\.md$", false),
    true,
  );
  assert.equal(
    shouldIgnoreItem("01 a.md", "第一章", "^index\\.md$", true),
    false,
  );
  assert.equal(shouldIgnoreItem("a.md", "第一章", "", false), false);
});

// ---- nameCollisionKey ----

test("nameCollisionKey lowercases only on case-insensitive platforms", () => {
  assert.equal(nameCollisionKey("01 A.MD", true), "01 a.md");
  assert.equal(nameCollisionKey("01 A.MD", false), "01 A.MD");
});
