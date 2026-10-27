#!/usr/bin/env node
/**
 * 真实 Obsidian 宿主验证（手动运行，不属于 CI 门禁）。
 *
 * 用法：
 *   npm run build && npm run test:host
 *   npm run test:host -- --keep      # 保留临时测试仓库，便于排查
 *
 * 配置可执行文件：环境变量 OBSIDIAN_EXE
 *
 * 脚本会：
 *   1. 在系统临时目录创建独立测试仓库并复制 tests/host/fixtures；
 *   2. 把 dist/ 产物装入测试仓库的插件目录并启用插件；
 *   3. 备份 %APPDATA%/obsidian/obsidian.json，临时注册测试仓库；
 *   4. 以 --remote-debugging-port 启动 Obsidian，通过 CDP 在真实宿主中执行断言；
 *   5. 关闭 Obsidian，还原配置，输出结果并写入 tests/host/last-run.json。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "../..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const VAULT_DIR = path.join(os.tmpdir(), "obsidian-file-order-host-vault");
const PLUGIN_ID = "obsidian-file-order";
const CDP_PORT = 9222;
const KEEP_VAULT = process.argv.includes("--keep");
const DIST_FILES = ["main.js", "manifest.json", "styles.css"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (...args) => console.log(...args);

const getObsidianConfigPath = () => {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? "", "obsidian", "obsidian.json");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "obsidian",
      "obsidian.json",
    );
  }
  return path.join(os.homedir(), ".config", "obsidian", "obsidian.json");
};

const findObsidianExe = () => {
  const candidates = [
    process.env.OBSIDIAN_EXE,
    process.platform === "win32" &&
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Obsidian",
        "Obsidian.exe",
      ),
    process.platform === "win32" &&
      path.join(process.env.LOCALAPPDATA ?? "", "Obsidian", "Obsidian.exe"),
    process.platform === "win32" &&
      path.join(process.env.ProgramFiles ?? "", "Obsidian", "Obsidian.exe"),
    process.platform === "win32" &&
      path.join(
        process.env["ProgramFiles(x86)"] ?? "",
        "Obsidian",
        "Obsidian.exe",
      ),
    process.platform === "darwin" &&
      "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    process.platform === "linux" && "/usr/bin/obsidian",
    process.platform === "linux" && "/opt/Obsidian/obsidian",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const isObsidianRunning = () => {
  if (process.platform !== "win32") return false;
  const result = spawnSync(
    "tasklist",
    ["/FI", "IMAGENAME eq Obsidian.exe"],
    { encoding: "utf8" },
  );
  return (result.stdout ?? "").includes("Obsidian.exe");
};

const copyDirContents = (sourceDir, targetDir) => {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    cpSync(src, dest, { recursive: true });
  }
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
        return;
      }
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, (message) => {
        if (message.error) {
          reject(new Error(`${method}: ${message.error.message}`));
          return;
        }
        resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(detail);
    }
    return result.result.value;
  }

  async tryEvaluate(expression) {
    try {
      return await this.evaluate(expression);
    } catch {
      return undefined;
    }
  }

  async waitFor(expression, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await this.tryEvaluate(expression);
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
  }

  close() {
    this.ws.close();
  }
}

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    log(`PASS  ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    log(`FAIL  ${name}\n      ${detail}`);
  }
};

const triggerMenuExpression = (targetExpression) => `(() => {
  window.__foMenuItems = [];
  const menu = {
    addItem: (callback) => {
      const item = {
        title: null,
        icon: null,
        click: null,
        setTitle(value) { this.title = value; return this; },
        setIcon(value) { this.icon = value; return this; },
        onClick(handler) { this.click = handler; return this; },
      };
      callback(item);
      window.__foMenuItems.push(item);
      return item;
    },
  };
  const target = ${targetExpression};
  app.workspace.trigger("file-menu", menu, target);
  return window.__foMenuItems.map((item) => item.title);
})()`;

const clickMenuItemExpression = (title) => `(() => {
  const item = window.__foMenuItems.find((entry) => entry.title === ${JSON.stringify(title)});
  if (!item) throw new Error("菜单项不存在: " + ${JSON.stringify(title)});
  item.click();
  return true;
})()`;

const dialogInfoExpression = `(() => {
  const dialog = document.querySelector(".file-order-dialog");
  if (!dialog) return null;
  return {
    bodyText: document.body.innerText,
    groups: Array.from(dialog.querySelectorAll(".file-order-dialog-h2")).map((el) => el.textContent),
    items: Array.from(dialog.querySelectorAll(".file-order-item-name")).map((el) => el.textContent),
    fields: Array.from(dialog.querySelectorAll(".file-order-field")).map((field) => ({
      label: field.querySelector("label")?.textContent ?? "",
      value: field.querySelector("input")?.value ?? "",
      title: field.getAttribute("title") ?? "",
    })),
    buttons: Array.from(dialog.querySelectorAll(".file-order-dialog-h2-container button")).map(
      (button) => (button.textContent ?? "").trim() || button.getAttribute("title") || "",
    ),
  };
})()`;

const setDialogFieldExpression = (label, value) => `(() => {
  const dialogs = document.querySelectorAll(".file-order-dialog");
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) throw new Error("排序对话框未打开");
  const field = Array.from(dialog.querySelectorAll(".file-order-field")).find(
    (entry) => (entry.querySelector("label")?.textContent ?? "").includes(${JSON.stringify(label)}),
  );
  if (!field) throw new Error("配置项不存在: " + ${JSON.stringify(label)});
  const input = field.querySelector("input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(String(value))});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value;
})()`;

const clickButtonExpression = (text) => `(() => {
  const button = Array.from(document.querySelectorAll("button")).find(
    (entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(text)},
  );
  if (!button) throw new Error("按钮不存在: " + ${JSON.stringify(text)});
  button.click();
  return true;
})()`;

const setSettingInputExpression = (name, value) => `(() => {
  const rows = Array.from(document.querySelectorAll(".vertical-tab-content .setting-item"));
  const row = rows.find(
    (entry) => (entry.querySelector(".setting-item-name")?.textContent ?? "") === ${JSON.stringify(name)},
  );
  if (!row) throw new Error("设置项不存在: " + ${JSON.stringify(name)});
  const input = row.querySelector("input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value;
})()`;

const main = async () => {
  const exe = findObsidianExe();
  if (!exe) {
    log("SKIP  未找到 Obsidian 桌面端，请安装后重试或用 OBSIDIAN_EXE 指定路径。");
    process.exit(0);
  }
  log(`使用 Obsidian：${exe}`);

  const missing = DIST_FILES.filter(
    (file) => !existsSync(path.join(PROJECT_DIR, "dist", file)),
  );
  if (missing.length > 0) {
    log(`请先执行 npm run build（缺少 dist/${missing.join(", dist/")}）`);
    process.exit(1);
  }

  if (isObsidianRunning()) {
    log("检测到 Obsidian 正在运行，请先完全退出 Obsidian 再执行宿主验证。");
    process.exit(1);
  }

  const configPath = getObsidianConfigPath();
  const configBackup = existsSync(configPath)
    ? readFileSync(configPath)
    : null;
  let child = null;
  let cdp = null;
  const consoleLines = [];
  const startedAt = new Date().toISOString();

  try {
    // ---- 测试仓库与插件 ----
    rmSync(VAULT_DIR, { recursive: true, force: true });
    mkdirSync(VAULT_DIR, { recursive: true });
    copyDirContents(path.join(FIXTURES_DIR, "root-files"), VAULT_DIR);
    copyDirContents(path.join(FIXTURES_DIR, "folders"), VAULT_DIR);
    mkdirSync(path.join(VAULT_DIR, "空"), { recursive: true });

    const pluginDir = path.join(
      VAULT_DIR,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
    );
    mkdirSync(pluginDir, { recursive: true });
    for (const file of DIST_FILES) {
      copyFileSync(path.join(PROJECT_DIR, "dist", file), path.join(pluginDir, file));
    }
    writeFileSync(
      path.join(VAULT_DIR, ".obsidian", "community-plugins.json"),
      JSON.stringify([PLUGIN_ID]),
    );
    writeFileSync(
      path.join(VAULT_DIR, ".obsidian", "app.json"),
      JSON.stringify({ safeMode: false, alwaysUpdateLinks: true }),
    );
    writeFileSync(
      path.join(pluginDir, "data.json"),
      JSON.stringify({
        delimiter: " ",
        prefixMinLength: 0,
        startingIndex: 0,
        ignorePattern: "^index\\.md$",
        ignoreFolderFile: true,
      }),
    );

    // ---- 临时注册测试仓库 ----
    const config = configBackup
      ? JSON.parse(configBackup.toString("utf8"))
      : { vaults: {} };
    const vaults = {};
    for (const [id, entry] of Object.entries(config.vaults ?? {})) {
      vaults[id] = { ...entry, open: false };
    }
    vaults["f0f0f0f0f0f0f0f0"] = {
      path: VAULT_DIR,
      ts: Date.now(),
      open: true,
    };
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, vaults }),
    );

    // ---- 启动 Obsidian ----
    child = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], {
      cwd: VAULT_DIR,
      stdio: "ignore",
    });

    let target = null;
    for (let attempt = 0; attempt < 120 && !target; attempt += 1) {
      await sleep(500);
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
        ).json();
        target = targets.find(
          (entry) =>
            entry.type === "page" && entry.url.startsWith("app://obsidian.md"),
        );
      } catch {
        // 端口尚未就绪，继续轮询。
      }
    }
    if (!target) throw new Error("CDP 端口未就绪，Obsidian 可能启动失败");

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args ?? [])
        .map(
          (arg) =>
            arg.value ?? arg.description ?? arg.preview?.description ?? "",
        )
        .join(" ");
      consoleLines.push({ type: params.type, text });
    });
    cdp.on("Log.entryAdded", (params) => {
      consoleLines.push({ type: params.entry.level, text: params.entry.text });
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    try {
      await cdp.waitFor(
        `!!(window.app && app.workspace.layoutReady && app.plugins.plugins[${JSON.stringify(
          PLUGIN_ID,
        )}])`,
        120000,
        "Obsidian 就绪并加载插件",
      );
    } catch (error) {
      const state = await cdp.tryEvaluate(`JSON.stringify({
        vault: window.app?.vault?.getName?.(),
        layoutReady: window.app?.workspace?.layoutReady ?? null,
        enabled: window.app?.plugins?.enabledPlugins
          ? Array.from(window.app.plugins.enabledPlugins)
          : null,
        loaded: !!window.app?.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}],
        bodyText: (document.body?.innerText ?? "").slice(-500),
      })`);
      throw new Error(`${error.message}; 状态=${state}`);
    }

    // ---- 辅助函数 ----
    const closeAnyModal = async () => {
      await cdp.tryEvaluate(
        `(() => { const buttons = document.querySelectorAll(".modal-close-button"); if (buttons.length > 0) { buttons[buttons.length - 1].click(); return true; } return false; })()`,
      );
      await sleep(400);
      if (await cdp.tryEvaluate(`!!document.querySelector(".file-order-dialog")`)) {
        await cdp.evaluate(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }))`,
        );
        await sleep(400);
      }
    };

    const readNames = (relDir = "") =>
      readdirSync(path.join(VAULT_DIR, relDir)).sort();
    const exists = (relPath) => existsSync(path.join(VAULT_DIR, relPath));
    const readVaultFile = (relPath) =>
      readFileSync(path.join(VAULT_DIR, relPath), "utf8");
    const waitForFileContent = async (
      relPath,
      predicate,
      timeoutMs = 5000,
    ) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          const content = readVaultFile(relPath);
          if (predicate(content)) return content;
        } catch {
          // 文件可能仍在重命名，继续轮询。
        }
        await sleep(150);
      }
      throw new Error(`等待文件内容超时：${relPath}`);
    };

    const openDialog = async (targetExpression, expectedTitle) => {
      await closeAnyModal();
      const titles = await cdp.evaluate(triggerMenuExpression(targetExpression));
      if (!titles.includes("重新排序")) {
        throw new Error(`右键菜单缺少「重新排序」，实际: ${titles.join(", ")}`);
      }
      await cdp.evaluate(clickMenuItemExpression("重新排序"));
      await cdp.waitFor(
        `!!document.querySelector(".file-order-dialog")`,
        10000,
        "排序对话框打开",
      );
      const info = await cdp.evaluate(dialogInfoExpression);
      if (expectedTitle && !info.bodyText.includes(expectedTitle)) {
        throw new Error(`对话框标题缺少「${expectedTitle}」`);
      }
      return info;
    };

    const applyAndWait = async () => {
      await cdp.evaluate(clickButtonExpression("应用更改"));
      await cdp.waitFor(
        `!document.querySelector(".file-order-dialog")`,
        20000,
        "应用后对话框关闭",
      );
    };

    const dialogItemPointExpression = (text, offsetY = 0) => `(() => {
      const dialogs = document.querySelectorAll(".file-order-dialog");
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) throw new Error("排序对话框未打开");
      const element = Array.from(
        dialog.querySelectorAll(".file-order-item-name"),
      ).find((entry) => entry.textContent === ${JSON.stringify(text)});
      if (!element) throw new Error("条目不存在: " + ${JSON.stringify(text)});
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2 + ${offsetY},
      };
    })()`;

    const dragDialogItem = async (sourceText, targetText) => {
      // Let the modal open animation settle before measuring coordinates.
      await sleep(300);
      const source = await cdp.evaluate(
        dialogItemPointExpression(sourceText),
      );
      const target = await cdp.evaluate(
        dialogItemPointExpression(targetText, 12),
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: source.x,
        y: source.y,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: source.x,
        y: source.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      const steps = 8;
      for (let step = 1; step <= steps; step += 1) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: source.x + ((target.x - source.x) * step) / steps,
          y: source.y + ((target.y - source.y) * step) / steps,
          button: "left",
          buttons: 1,
        });
        await sleep(25);
      }
      await sleep(100);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await sleep(500);
    };

    const openSettings = async () => {
      await cdp.evaluate(
        `(app.setting.open(), app.setting.openTabById(${JSON.stringify(
          PLUGIN_ID,
        )}), true)`,
      );
      await cdp.waitFor(
        `!!document.querySelector(".vertical-tab-content")`,
        10000,
        "插件设置页打开",
      );
    };

    const closeSettings = async () => {
      await cdp.tryEvaluate(`(app.setting?.close?.(), true)`);
      await sleep(300);
    };

    // ---- 1. 插件加载与命令 ----
    await check("插件在真实 Obsidian 中加载并注册根目录命令", async () => {
      const state = await cdp.evaluate(`({
        enabled: Array.from(app.plugins.enabledPlugins ?? []).includes(${JSON.stringify(
          PLUGIN_ID,
        )}),
        loaded: !!app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}],
        command: !!app.commands.commands[${JSON.stringify(
          `${PLUGIN_ID}:obsidian-file-order-reorder-top-folder`,
        )}],
      })`);
      if (!state.enabled) throw new Error("插件未启用");
      if (!state.loaded) throw new Error("插件未加载");
      if (!state.command) throw new Error("根目录排序命令未注册");
    });

    // ---- 2. 设置页文案与忽略规则输入 ----
    await check("设置页文案与默认值展示正确", async () => {
      await openSettings();
      const rows = await cdp.evaluate(`(() => {
        return Array.from(
          document.querySelectorAll(".vertical-tab-content .setting-item"),
        ).map((row) => ({
          name: row.querySelector(".setting-item-name")?.textContent ?? "",
          desc: row.querySelector(".setting-item-description")?.textContent ?? "",
          value: row.querySelector("input[type=text]")?.value ?? "",
          enabled:
            row
              .querySelector(".checkbox-container")
              ?.classList.contains("is-enabled") ?? null,
        }));
      })()`);
      const byName = new Map(rows.map((row) => [row.name, row]));
      for (const name of [
        "数字前缀最小长度",
        "分隔符",
        "起始编号",
        "忽略规则",
        "忽略同名文件夹说明文件",
      ]) {
        if (!byName.has(name)) throw new Error(`缺少设置项：${name}`);
      }
      const heading = await cdp.evaluate(
        `document.querySelector(".vertical-tab-content h2")?.textContent ?? ""`,
      );
      if (heading !== "File Order 默认设置") {
        throw new Error(`设置页标题错误: ${JSON.stringify(heading)}`);
      }
      const intro = await cdp.evaluate(
        `document.querySelector(".vertical-tab-content")?.innerText ?? ""`,
      );
      if (!intro.includes("回退默认值")) {
        throw new Error("设置页未说明默认值的回退语义");
      }
      if (byName.get("分隔符").value !== "[1 个空格]") {
        throw new Error(
          `分隔符展示应为 [1 个空格]，实际: ${byName.get("分隔符").value}`,
        );
      }
      if (byName.get("忽略同名文件夹说明文件").enabled !== true) {
        throw new Error("忽略同名文件夹说明文件未按配置开启");
      }
    });

    await check("忽略规则中间态非法输入不会被清空，合法值才会保存", async () => {
      await openSettings();
      await cdp.evaluate(setSettingInputExpression("忽略规则", "^index\\"));
      await sleep(900);
      const kept = await cdp.evaluate(`(() => {
        const rows = Array.from(
          document.querySelectorAll(".vertical-tab-content .setting-item"),
        );
        const row = rows.find(
          (entry) => entry.querySelector(".setting-item-name")?.textContent === "忽略规则",
        );
        return row?.querySelector("input")?.value ?? null;
      })()`);
      if (kept !== "^index\\") {
        throw new Error(`非法输入被改写，实际: ${JSON.stringify(kept)}`);
      }
      await cdp.evaluate(setSettingInputExpression("忽略规则", "^index\\.md$"));
      await sleep(900);
      const saved = await cdp.evaluate(
        `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].settings.ignorePattern`,
      );
      if (saved !== "^index\\.md$") {
        throw new Error(`合法输入未保存，实际: ${JSON.stringify(saved)}`);
      }
      await closeSettings();
    });

    // ---- 3. 文件夹对话框、忽略规则与无操作应用 ----
    await check("文件夹对话框正确渲染、推断配置并应用忽略规则", async () => {
      const info = await openDialog(
        `app.vault.getAbstractFileByPath("第一章")`,
        "重新排序：第一章",
      );
      if (!info.groups.includes("文件")) throw new Error("缺少「文件」分组");
      const expectedItems = ["01 A.md", "02 B.md"];
      if (JSON.stringify(info.items) !== JSON.stringify(expectedItems)) {
        throw new Error(
          `条目应忽略 index.md 与文件夹说明文件，实际: ${info.items.join(", ")}`,
        );
      }
      const fields = new Map(info.fields.map((field) => [field.label, field]));
      if (fields.get("数字前缀最小长度")?.value !== "2") {
        throw new Error("数字前缀最小长度推断错误");
      }
      if (fields.get("分隔符")?.value !== " ") {
        throw new Error("分隔符推断错误");
      }
      if (fields.get("起始编号")?.value !== "1") {
        throw new Error("起始编号推断错误");
      }
    });

    await check("顺序未变时应用不会重命名任何文件", async () => {
      const before = readNames("第一章");
      await applyAndWait();
      const after = readNames("第一章");
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(
          `无操作应用改变了文件：${before.join(", ")} -> ${after.join(", ")}`,
        );
      }
    });

    // ---- 4. 无补零文件夹仅改配置 + 撤销 ----
    await check("撤销更改恢复打开对话框时的顺序与配置", async () => {
      await openDialog(`app.vault.getAbstractFileByPath("无补零")`, "重新排序：无补零");
      await cdp.evaluate(setDialogFieldExpression("分隔符", "-"));
      await sleep(200);
      let names = (await cdp.evaluate(dialogInfoExpression)).items;
      if (JSON.stringify(names) !== JSON.stringify(["1-a.md", "2-b.md"])) {
        throw new Error(`预览名称错误: ${names.join(", ")}`);
      }
      await cdp.evaluate(clickButtonExpression("撤销更改"));
      await sleep(200);
      const info = await cdp.evaluate(dialogInfoExpression);
      if (JSON.stringify(info.items) !== JSON.stringify(["1 a.md", "2 b.md"])) {
        throw new Error(`撤销后顺序未恢复: ${info.items.join(", ")}`);
      }
      const fields = new Map(info.fields.map((field) => [field.label, field]));
      if (fields.get("分隔符")?.value !== " ") {
        throw new Error("撤销后分隔符未恢复");
      }
    });

    await check("全前缀文件夹仅改分隔符即可生效（无需拖拽）", async () => {
      await cdp.evaluate(setDialogFieldExpression("分隔符", "-"));
      await sleep(200);
      await applyAndWait();
      const names = readNames("无补零");
      if (JSON.stringify(names) !== JSON.stringify(["1-a.md", "2-b.md"])) {
        throw new Error(`重命名结果错误: ${names.join(", ")}`);
      }
    });

    await check("清除自定义排序会移除全部数字前缀", async () => {
      const info = await openDialog(
        `app.vault.getAbstractFileByPath("无补零")`,
        "重新排序：无补零",
      );
      const fields = new Map(info.fields.map((field) => [field.label, field]));
      if (fields.get("分隔符")?.value !== "-") {
        throw new Error("重新打开后未推断出分隔符 -");
      }
      await cdp.evaluate(clickButtonExpression("清除自定义排序"));
      await sleep(200);
      await applyAndWait();
      const names = readNames("无补零");
      if (JSON.stringify(names) !== JSON.stringify(["a.md", "b.md"])) {
        throw new Error(`清除排序结果错误: ${names.join(", ")}`);
      }
    });

    // ---- 5. 混合位数推断 ----
    await check("数字位数不一致时仍能推断出分隔符", async () => {
      const info = await openDialog(`app.vault.getAbstractFileByPath("混合")`, "重新排序：混合");
      const fields = new Map(info.fields.map((field) => [field.label, field]));
      if (fields.get("分隔符")?.value !== " ") {
        throw new Error(
          `分隔符推断错误，实际: ${JSON.stringify(fields.get("分隔符")?.value)}`,
        );
      }
      if (fields.get("数字前缀最小长度")?.value !== "1") {
        throw new Error("混合位数前缀长度推断错误");
      }
    });

    // ---- 6. 交换/临时名两阶段重命名 ----
    await check("交换目标槽位时两阶段重命名成功且不产生回滚警告", async () => {
      const logsBefore = consoleLines.length;
      await openDialog(`app.vault.getAbstractFileByPath("交换")`, "重新排序：交换");
      await cdp.evaluate(setDialogFieldExpression("起始编号", "0"));
      await sleep(200);
      await applyAndWait();
      const names = readNames("交换");
      if (JSON.stringify(names) !== JSON.stringify(["0 a.md", "1 a.md"])) {
        throw new Error(`交换结果错误: ${names.join(", ")}`);
      }
      if (names.some((name) => name.startsWith("__fileorder_tmp_"))) {
        throw new Error("残留临时名文件");
      }
      const newLogs = consoleLines.slice(logsBefore);
      const noisy = newLogs.filter((line) =>
        /Could not restore|Failed to rename/.test(line.text),
      );
      if (noisy.length > 0) {
        throw new Error(`出现重命名回滚/失败日志: ${noisy[0].text}`);
      }
    });

    // ---- 7. 忽略项不阻断「按排序规范修复名称」 ----
    await check("文件夹说明文件被忽略时仍能修复名称", async () => {
      const titles = await cdp.evaluate(
        triggerMenuExpression(
          `app.vault.getAbstractFileByPath("修复/new.md")`,
        ),
      );
      if (!titles.includes("按排序规范修复名称")) {
        throw new Error(`菜单缺少修复项，实际: ${titles.join(", ")}`);
      }
      await cdp.evaluate(clickMenuItemExpression("按排序规范修复名称"));
      await cdp.waitFor(
        `!!app.vault.getAbstractFileByPath("修复/03 new.md")`,
        10000,
        "修复名称生成 03 new.md",
      );
    });

    // ---- 8. 根目录修复（路径归一化） ----
    await check("根目录条目重命名路径正确（normalizePath）", async () => {
      await cdp.evaluate(
        `(app.plugins.plugins[${JSON.stringify(
          PLUGIN_ID,
        )}].settings.ignorePattern = "^(\\\\.obsidian|第一章|无补零|交换|修复|混合|拖拽|分组|轮转|大小写|失败|空|槽位|links)$", true)`,
      );
      const titles = await cdp.evaluate(
        triggerMenuExpression(`app.vault.getAbstractFileByPath("普通.md")`),
      );
      if (!titles.includes("按排序规范修复名称")) {
        throw new Error(`根目录菜单缺少修复项，实际: ${titles.join(", ")}`);
      }
      await cdp.evaluate(clickMenuItemExpression("按排序规范修复名称"));
      await cdp.waitFor(
        `!!app.vault.getAbstractFileByPath("3 普通.md")`,
        10000,
        "根目录修复生成 3 普通.md",
      );
      await cdp.evaluate(
        `(app.plugins.plugins[${JSON.stringify(
          PLUGIN_ID,
        )}].settings.ignorePattern = "^index\\\\.md$", true)`,
      );
    });

    // ---- 9. 被忽略条目不应出现修复菜单 ----
    await check("被忽略的条目不显示「按排序规范修复名称」", async () => {
      const indexTitles = await cdp.evaluate(
        triggerMenuExpression(
          `app.vault.getAbstractFileByPath("第一章/index.md")`,
        ),
      );
      if (indexTitles.includes("按排序规范修复名称")) {
        throw new Error("被正则忽略的文件仍显示修复菜单");
      }
      const noteTitles = await cdp.evaluate(
        triggerMenuExpression(
          `app.vault.getAbstractFileByPath("第一章/第一章.md")`,
        ),
      );
      if (noteTitles.includes("按排序规范修复名称")) {
        throw new Error("文件夹说明文件仍显示修复菜单");
      }
    });

    // ---- 10. 实际拖拽（文件组）+ 撤销 ----
    await check("拖拽文件排序、撤销后重新拖拽并应用重命名", async () => {
      const info = await openDialog(
        `app.vault.getAbstractFileByPath("拖拽")`,
        "重新排序：拖拽",
      );
      if (JSON.stringify(info.items) !== JSON.stringify(["a.md", "b.md", "c.md"])) {
        throw new Error(`拖拽前顺序错误: ${info.items.join(", ")}`);
      }
      await dragDialogItem("b.md", "a.md");
      const preview = (await cdp.evaluate(dialogInfoExpression)).items;
      if (
        JSON.stringify(preview) !==
        JSON.stringify(["0 b.md", "1 a.md", "2 c.md"])
      ) {
        throw new Error(`拖拽后预览顺序错误: ${preview.join(", ")}`);
      }
      await cdp.evaluate(clickButtonExpression("撤销更改"));
      await sleep(250);
      const restored = (await cdp.evaluate(dialogInfoExpression)).items;
      if (JSON.stringify(restored) !== JSON.stringify(["a.md", "b.md", "c.md"])) {
        throw new Error(`拖拽后撤销未恢复原顺序: ${restored.join(", ")}`);
      }
      await dragDialogItem("b.md", "a.md");
      await applyAndWait();
      const names = readNames("拖拽");
      if (
        JSON.stringify(names) !==
        JSON.stringify(["0 b.md", "1 a.md", "2 c.md"])
      ) {
        throw new Error(`拖拽重命名结果错误: ${names.join(", ")}`);
      }
    });

    // ---- 11. 实际拖拽（文件夹组） ----
    await check("拖拽文件夹排序并保留子内容", async () => {
      const info = await openDialog(
        `app.vault.getAbstractFileByPath("分组")`,
        "重新排序：分组",
      );
      if (!info.groups.includes("文件夹")) {
        throw new Error("缺少「文件夹」分组");
      }
      if (JSON.stringify(info.items) !== JSON.stringify(["a", "b"])) {
        throw new Error(`文件夹顺序错误: ${info.items.join(", ")}`);
      }
      await dragDialogItem("b", "a");
      const preview = (await cdp.evaluate(dialogInfoExpression)).items;
      if (JSON.stringify(preview) !== JSON.stringify(["0 b", "1 a"])) {
        throw new Error(`文件夹拖拽预览错误: ${preview.join(", ")}`);
      }
      await applyAndWait();
      const names = readNames("分组");
      if (JSON.stringify(names) !== JSON.stringify(["0 b", "1 a"])) {
        throw new Error(`文件夹重命名结果错误: ${names.join(", ")}`);
      }
      if (!exists(path.join("分组", "0 b", "内部.md"))) {
        throw new Error("重命名后子文件丢失（0 b/内部.md）");
      }
      if (!exists(path.join("分组", "1 a", "内部.md"))) {
        throw new Error("重命名后子文件丢失（1 a/内部.md）");
      }
    });

    // ---- 12. 三文件轮转 / 多临时槽位 ----
    await check("三个同名标题轮转时临时槽位全部释放", async () => {
      const logsBefore = consoleLines.length;
      await openDialog(
        `app.vault.getAbstractFileByPath("轮转")`,
        "重新排序：轮转",
      );
      await cdp.evaluate(setDialogFieldExpression("起始编号", "0"));
      await sleep(200);
      await applyAndWait();
      const names = readNames("轮转");
      if (
        JSON.stringify(names) !==
        JSON.stringify(["0 a.md", "1 a.md", "2 a.md"])
      ) {
        throw new Error(`轮转结果错误: ${names.join(", ")}`);
      }
      if (names.some((name) => name.startsWith("__fileorder_tmp_"))) {
        throw new Error("轮转后残留临时名文件");
      }
      const noisy = consoleLines
        .slice(logsBefore)
        .filter((line) => /Could not restore|Failed to rename/.test(line.text));
      if (noisy.length > 0) {
        throw new Error(`轮转出现回滚/失败日志: ${noisy[0].text}`);
      }
    });

    // ---- 12b. 大小写不同的目标槽位 ----
    await check("大小写不同的目标槽位也能正确腾出（两阶段重命名）", async () => {
      const logsBefore = consoleLines.length;
      await openDialog(
        `app.vault.getAbstractFileByPath("槽位")`,
        "重新排序：槽位",
      );
      await cdp.evaluate(setDialogFieldExpression("起始编号", "2"));
      await sleep(200);
      const preview = (await cdp.evaluate(dialogInfoExpression)).items;
      if (
        JSON.stringify(preview) !==
        JSON.stringify(["02 A.md", "03 a.md"])
      ) {
        throw new Error(`槽位预览错误: ${preview.join(", ")}`);
      }
      await applyAndWait();
      const names = readNames("槽位");
      if (
        JSON.stringify(names) !== JSON.stringify(["02 A.md", "03 a.md"])
      ) {
        throw new Error(`槽位重命名结果错误: ${names.join(", ")}`);
      }
      if (names.some((name) => name.startsWith("__fileorder_tmp_"))) {
        throw new Error("槽位重命名后残留临时名文件");
      }
      const noisy = consoleLines
        .slice(logsBefore)
        .filter((line) => /Could not restore|Failed to rename/.test(line.text));
      if (noisy.length > 0) {
        throw new Error(`槽位重命名出现失败日志: ${noisy[0].text}`);
      }
    });

    // ---- 12c. 链接同步 ----
    await check("重命名后 Obsidian 按设置同步更新内部链接", async () => {
      const info = await openDialog(
        `app.vault.getAbstractFileByPath("links")`,
        "重新排序：links",
      );
      if (
        JSON.stringify(info.items) !==
        JSON.stringify(["reference.md", "target.md"])
      ) {
        throw new Error(`links 初始顺序错误: ${info.items.join(", ")}`);
      }
      await dragDialogItem("target.md", "reference.md");
      const preview = (await cdp.evaluate(dialogInfoExpression)).items;
      if (
        JSON.stringify(preview) !==
        JSON.stringify(["0 target.md", "1 reference.md"])
      ) {
        throw new Error(`links 拖拽预览错误: ${preview.join(", ")}`);
      }
      await applyAndWait();
      if (!exists(path.join("links", "0 target.md"))) {
        throw new Error("links 重命名后缺少 0 target.md");
      }
      const content = await waitForFileContent(
        path.join("links", "1 reference.md"),
        (text) => text.includes("0 target"),
      );
      if (content.includes("[[target]]")) {
        throw new Error(`内部链接未同步，内容: ${content.trim()}`);
      }
    });

    // ---- 13. 大小写冲突预检 ----
    await check("大小写不敏感平台正确拦截目标名冲突", async () => {
      if (process.platform !== "win32" && process.platform !== "darwin") {
        log("SKIP  当前文件系统区分大小写，跳过该用例");
        return;
      }
      const ciPattern = "^(01 A\\.md|index\\.md)$";
      await cdp.evaluate(
        `(app.plugins.plugins[${JSON.stringify(
          PLUGIN_ID,
        )}].settings.ignorePattern = ${JSON.stringify(ciPattern)}, true)`,
      );
      try {
        const info = await openDialog(
          `app.vault.getAbstractFileByPath("大小写")`,
          "重新排序：大小写",
        );
        if (
          JSON.stringify(info.items) !==
          JSON.stringify(["02 a.md", "03 b.md"])
        ) {
          throw new Error(`忽略规则未生效: ${info.items.join(", ")}`);
        }
        await cdp.evaluate(setDialogFieldExpression("起始编号", "1"));
        await sleep(200);
        const before = readNames("大小写");
        await cdp.evaluate(clickButtonExpression("应用更改"));
        await sleep(900);
        const stillOpen = await cdp.evaluate(
          `!!document.querySelector(".file-order-dialog")`,
        );
        if (!stillOpen) {
          throw new Error("大小写冲突未被预检拦截（对话框已关闭）");
        }
        const body = await cdp.evaluate(`document.body.innerText`);
        if (!body.includes("目标名称已存在")) {
          throw new Error("缺少目标名称冲突提示");
        }
        const after = readNames("大小写");
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          throw new Error(
            `冲突后文件被改动: ${before.join(", ")} -> ${after.join(", ")}`,
          );
        }
        await closeAnyModal();
      } finally {
        await cdp.evaluate(
          `(app.plugins.plugins[${JSON.stringify(
            PLUGIN_ID,
          )}].settings.ignorePattern = "^index\\\\.md$", true)`,
        );
      }
    });

    // ---- 14. 重命名失败处理 ----
    await check("重命名失败时保持对话框、提示且不残留临时名", async () => {
      await openDialog(
        `app.vault.getAbstractFileByPath("失败")`,
        "重新排序：失败",
      );
      await cdp.evaluate(setDialogFieldExpression("分隔符", "/"));
      await sleep(200);
      await cdp.evaluate(clickButtonExpression("应用更改"));
      await sleep(1200);
      const stillOpen = await cdp.evaluate(
        `!!document.querySelector(".file-order-dialog")`,
      );
      if (!stillOpen) {
        throw new Error("重命名失败后对话框不应关闭");
      }
      const body = await cdp.evaluate(`document.body.innerText`);
      if (!body.includes("无法重命名")) {
        throw new Error("缺少重命名失败提示");
      }
      const names = readNames("失败");
      if (JSON.stringify(names) !== JSON.stringify(["1 a.md", "2 b.md"])) {
        throw new Error(`失败后文件被改动: ${names.join(", ")}`);
      }
      if (names.some((name) => name.startsWith("__fileorder_tmp_"))) {
        throw new Error("失败后残留临时名文件");
      }
      await closeAnyModal();
    });

    // ---- 15. 空文件夹 ----
    await check("空文件夹对话框可正常打开并应用", async () => {
      const info = await openDialog(
        `app.vault.getAbstractFileByPath("空")`,
        "重新排序：空",
      );
      if (info.items.length !== 0) {
        throw new Error(`空文件夹不应有条目，实际: ${info.items.join(", ")}`);
      }
      await applyAndWait();
      if (readNames("空").length !== 0) {
        throw new Error("空文件夹应用后发生了变化");
      }
    });

    // ---- 16. 设置页数值校验 ----
    await check("设置页拒绝非法数值并恢复原值", async () => {
      await closeAnyModal();
      await openSettings();
      const before = await cdp.evaluate(
        `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].settings.prefixMinLength`,
      );
      for (const invalid of ["-1", "12abc"]) {
        await cdp.evaluate(
          setSettingInputExpression("数字前缀最小长度", invalid),
        );
        await sleep(900);
        const after = await cdp.evaluate(
          `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].settings.prefixMinLength`,
        );
        const inputValue = await cdp.evaluate(`(() => {
          const rows = Array.from(
            document.querySelectorAll(".vertical-tab-content .setting-item"),
          );
          const row = rows.find(
            (entry) =>
              entry.querySelector(".setting-item-name")?.textContent ===
              "数字前缀最小长度",
          );
          return row?.querySelector("input")?.value ?? null;
        })()`);
        if (after !== before) {
          throw new Error(`非法数值被保存: ${before} -> ${after}`);
        }
        if (inputValue !== String(before)) {
          throw new Error(
            `非法数值 ${JSON.stringify(invalid)} 未恢复: ${JSON.stringify(
              inputValue,
            )}`,
          );
        }
      }
      await closeSettings();
    });

    // ---- 17. 根目录命令与对话框 ----
    await check("根目录排序命令打开根目录对话框", async () => {
      await closeAnyModal();
      await cdp.evaluate(
        `app.commands.executeCommandById(${JSON.stringify(
          `${PLUGIN_ID}:obsidian-file-order-reorder-top-folder`,
        )})`,
      );
      await cdp.waitFor(
        `!!document.querySelector(".file-order-dialog")`,
        10000,
        "根目录对话框打开",
      );
      const info = await cdp.evaluate(dialogInfoExpression);
      if (!info.bodyText.includes("重新排序：/")) {
        throw new Error("根目录对话框标题错误");
      }
      for (const name of ["1 roota.md", "2 rootb.md"]) {
        if (!info.items.includes(name)) {
          throw new Error(`根目录对话框缺少条目 ${name}`);
        }
      }
    });

    await closeAnyModal();
    await closeSettings();
    cdp.close();
  } catch (error) {
    results.push({
      name: "宿主验证执行",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    log(`FAIL  宿主验证执行: ${error instanceof Error ? error.message : error}`);
  } finally {
    if (cdp) cdp.close();
    if (child?.pid) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
      await sleep(1500);
    }
    if (configBackup) {
      try {
        writeFileSync(configPath, configBackup);
      } catch (error) {
        log(`警告：还原 Obsidian 配置失败，请手动恢复 ${configPath}`, error);
      }
    } else {
      rmSync(configPath, { force: true });
    }
    if (!KEEP_VAULT) {
      rmSync(VAULT_DIR, { recursive: true, force: true });
    }
  }

  const finishedAt = new Date().toISOString();
  const failed = results.filter((result) => !result.ok);
  const summary = {
    startedAt,
    finishedAt,
    vault: KEEP_VAULT ? VAULT_DIR : "(已删除)",
    results,
    console: consoleLines.filter(
      (line) => line.type === "error" || line.type === "warning",
    ),
    notes:
      "console 中的「Failed to rename」日志来自「重命名失败处理」用例，属于预期行为。",
  };
  writeFileSync(
    path.join(__dirname, "last-run.json"),
    JSON.stringify(summary, null, 2),
  );

  log("");
  log(
    `结果：${results.length - failed.length} 通过 / ${failed.length} 失败（${results.length} 项）`,
  );
  log(`详细结果：${path.join(__dirname, "last-run.json")}`);
  process.exit(failed.length > 0 ? 1 : 0);
};

main();
