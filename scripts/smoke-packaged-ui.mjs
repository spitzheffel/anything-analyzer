import { _electron as electron } from "playwright-core";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const [flavor, rootArg] = process.argv.slice(2);
if (process.platform !== "win32") {
  throw new Error("Packaged UI smoke currently supports Windows only");
}
if (!new Set(["public", "internal"]).has(flavor) || !rootArg) {
  throw new Error(
    "Usage: node scripts/smoke-packaged-ui.mjs <public|internal> <package-root>",
  );
}

async function findFiles(directory, wanted) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await findFiles(path, wanted)));
    else if (entry.isFile() && wanted(entry.name)) matches.push(path);
  }
  return matches;
}

async function nativeViewBounds(application) {
  return application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return [];
    return window.contentView.children.map((view) => view.getBounds());
  });
}

async function waitForNativeVisibility(application, expectedVisible, label) {
  const deadline = Date.now() + 10_000;
  let bounds = [];
  while (Date.now() < deadline) {
    bounds = await nativeViewBounds(application);
    const visible = bounds.some((item) => item.width > 0 && item.height > 0);
    if (visible === expectedVisible) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `${label}: expected native view visible=${expectedVisible}, got ${JSON.stringify(bounds)}`,
  );
}

const archives = await findFiles(resolve(rootArg), (name) => name === "app.asar");
if (archives.length !== 1) {
  throw new Error(`Expected one packaged app below ${rootArg}, found ${archives.length}`);
}
const product =
  flavor === "internal" ? "Anything Analyzer Internal.exe" : "Anything Analyzer.exe";
const executable = join(dirname(dirname(archives[0])), product);
await access(executable);

const temporary = await mkdtemp(join(tmpdir(), `anything-analyzer-${flavor}-ui-`));
const userData = join(temporary, "user-data");
await mkdir(userData, { recursive: true });
let application;
const rendererErrors = [];

try {
  application = await electron.launch({
    args: [
      archives[0],
      "--aa-packaged-ui-smoke",
      `--aa-smoke-user-data=${userData}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 30_000,
  });

  const page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });

  const createSessionButton = page.getByRole("button", {
    name: "+ 新建会话",
    exact: true,
  });
  await createSessionButton.waitFor();
  await waitForNativeVisibility(application, false, "empty screen");

  await page.getByText("⚙ 设置", { exact: true }).click();
  await page.getByText("通用", { exact: true }).waitFor();
  await waitForNativeVisibility(application, false, "settings without Session");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "检查器", exact: true }).click();
  await page.getByRole("button", { name: "AI 报告", exact: true }).click();
  await page.getByRole("button", { name: "浏览器", exact: true }).click();

  await createSessionButton.click();
  await page.getByPlaceholder("输入会话名称").fill("Packaged UI Smoke");
  await page.getByPlaceholder("https://example.com").fill("about:blank");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const sessionItem = page
    .locator('[class*="sessionName"]')
    .filter({ hasText: "Packaged UI Smoke" });
  await sessionItem.waitFor();
  await waitForNativeVisibility(application, true, "Electron browser");

  await page.getByRole("button", { name: /开始/ }).first().click();
  await page.getByText("运行中", { exact: true }).waitFor();
  await page.getByRole("button", { name: /暂停/ }).first().click();
  await page.getByText("已暂停", { exact: true }).waitFor();
  await page.getByRole("button", { name: /停止/ }).first().click();
  await page.getByText("已停止", { exact: true }).waitFor();

  await page.getByRole("button", { name: "检查器", exact: true }).click();
  await waitForNativeVisibility(application, false, "Inspector");
  await page.getByRole("button", { name: "浏览器", exact: true }).click();
  await waitForNativeVisibility(application, true, "Browser after Inspector");

  await page.getByTitle("切换主题").click();
  await page.getByText("亮色清爽", { exact: true }).waitFor();
  await waitForNativeVisibility(application, false, "theme popover");
  await page.getByText("亮色清爽", { exact: true }).click();
  await waitForNativeVisibility(application, true, "theme popover closed");

  await page.getByText("⚙ 设置", { exact: true }).click();
  await waitForNativeVisibility(application, false, "settings with Electron Session");
  await page.keyboard.press("Escape");
  await waitForNativeVisibility(application, true, "settings closed");

  await sessionItem.hover();
  await page.locator('[class*="deleteBtn"]').click();
  await page.getByText("Delete session", { exact: true }).waitFor();
  await waitForNativeVisibility(application, false, "delete confirmation");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitForNativeVisibility(application, true, "delete confirmation closed");

  if (rendererErrors.length > 0) {
    throw new Error(`Renderer errors:\n${rendererErrors.join("\n")}`);
  }
  console.log(
    `[package-ui-smoke] ${flavor} clicks and native-view visibility OK: ${basename(executable)}`,
  );
} catch (error) {
  const logPath = join(userData, "logs", "main.log");
  const logText = await readFile(logPath, "utf8").catch(() => "<main.log unavailable>");
  console.error(`[package-ui-smoke] application log:\n${logText}`);
  throw error;
} finally {
  await application?.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
