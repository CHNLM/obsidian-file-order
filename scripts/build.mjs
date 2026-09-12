#!/usr/bin/env node
/**
 * 一键构建脚本（Node ESM，Windows / Linux / macOS 通用）
 *
 * 用法：
 *   node scripts/build.mjs                 # 安装依赖 + 构建 + 校验产物到 dist/
 *   node scripts/build.mjs /path/to/vault  # 构建后额外复制到该 Obsidian 库的插件目录
 *
 * 产物：dist/{main.js,manifest.json,styles.css}
 *       复制到 vault 后即：<vault>/.obsidian/plugins/obsidian-file-order/
 *
 * 依赖：Node.js >= 22 与 npm（本项目以 npm 作为包管理器）。
 * 说明：跨平台（Windows / Linux / macOS）一致，无需额外安装 bash，也便于 CI 调用。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "obsidian-file-order";
const DIST_FILES = ["dist/main.js", "dist/manifest.json", "dist/styles.css"];

const vaultArg = process.argv[2];

const fail = (message) => {
  console.error(`错误: ${message}`);
  process.exit(1);
};

// 清空 NODE_OPTIONS，避免开发环境的钩子脚本改写干扰 npm 子进程。
process.env.NODE_OPTIONS = "";

// Windows 的 npm.cmd 需经 shell 才能启动。这里传给 shell 的 argv 全部是
// 固定常量（install / run build / --version），无用户可控输入，无注入风险。
// Node 会对如此调用打印一条无害的 DeprecationWarning（DEP0190），属已知提示。
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    shell: true,
  });
  if (result.error) {
    throw new Error(`无法执行 ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败（退出码 ${result.status}）`);
  }
  return result;
};

try {
  // 1. 检查 Node 与 npm
  console.log("==> [1/3] 检查 Node.js 与 npm");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    fail(`Node ${process.versions.node} 过旧，需要 >= 22`);
  }
  const npmInfo = spawnSync("npm", ["--version"], {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    shell: true,
  });
  const npmVer = npmInfo.status === 0 ? npmInfo.stdout.trim() : "未知";
  console.log(`    node ${process.versions.node}  /  npm ${npmVer}`);

  // 2. 安装依赖
  console.log("==> [2/3] 安装依赖");
  run("npm", ["install"]);

  // 3. 构建
  console.log("==> [3/3] 构建插件");
  run("npm", ["run", "build"]);

  // 4. 校验产物
  console.log("==> 校验构建产物");
  for (const f of DIST_FILES) {
    const abs = resolve(PROJECT_DIR, f);
    if (!existsSync(abs)) {
      fail(`构建产物缺失: ${f}`);
    }
    console.log(`    - ${f} (${statSync(abs).size} bytes)`);
  }
} catch (error) {
  fail(error.message);
}

console.log("==============================================================");
console.log(" 构建成功！");
console.log("==============================================================");

// 可选：复制到 Obsidian vault
if (vaultArg) {
  try {
    const dest = resolve(vaultArg, ".obsidian", "plugins", PLUGIN_ID);
    console.log(`==> 复制产物到 ${dest}`);
    mkdirSync(dest, { recursive: true });
    for (const f of DIST_FILES) {
      copyFileSync(resolve(PROJECT_DIR, f), resolve(dest, f));
    }
    console.log(`    已复制。在 Obsidian 设置 > 第三方插件 中启用 ${PLUGIN_ID} 即可。`);
  } catch (error) {
    fail(`复制产物到 vault 失败: ${error.message}`);
  }
}