// Static consistency checks for project metadata and documented npm scripts.
// Runs with plain Node (>= 22.6, type-stripping enabled) and no extra deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readJson = (relativePath: string) =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));

const manifest = readJson("../manifest.json");
const pkg = readJson("../package.json");
const versions = readJson("../versions.json");

test("manifest, package and versions metadata agree", () => {
  assert.equal(manifest.id, "obsidian-file-order");
  assert.equal(manifest.name, "File Order");
  assert.equal(manifest.version, pkg.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.equal(manifest.isDesktopOnly, false);
  assert.equal(pkg.main, "dist/main.js");
});

test("documented npm scripts are present", () => {
  const scripts = [
    "build",
    "build:all",
    "dev",
    "lint",
    "lint:fix",
    "test",
    "test:host",
    "typecheck",
    "release",
  ];
  for (const script of scripts) {
    assert.equal(
      typeof pkg.scripts[script],
      "string",
      `missing script: ${script}`,
    );
  }
  assert.match(pkg.scripts.test, /--experimental-strip-types/);
});

test(".nvmrc supports the documented Node baseline", () => {
  const nvmrc = readFileSync(
    new URL("../.nvmrc", import.meta.url),
    "utf8",
  ).trim();
  const major = Number(nvmrc.split(".")[0]);
  assert.ok(major >= 22, `.nvmrc must be >= 22, got ${nvmrc}`);
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
});
