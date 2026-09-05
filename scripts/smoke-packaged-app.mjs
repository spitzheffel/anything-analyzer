import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const [flavor, rootArg] = process.argv.slice(2);
if (!new Set(["public", "internal"]).has(flavor) || !rootArg) {
  throw new Error("Usage: node scripts/smoke-packaged-app.mjs <public|internal> <package-root>");
}

async function findFiles(directory, wanted) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await findFiles(path, wanted));
    else if (entry.isFile() && wanted(entry.name)) matches.push(path);
  }
  return matches;
}

const archives = await findFiles(resolve(rootArg), (name) => name === "app.asar");
if (archives.length !== 1) throw new Error(`Expected one packaged app below ${rootArg}, found ${archives.length}`);
const resources = dirname(archives[0]);
let executable;
if (process.platform === "darwin") {
  const product = flavor === "internal" ? "Anything Analyzer Internal" : "Anything Analyzer";
  executable = join(dirname(resources), "MacOS", product);
} else if (process.platform === "win32") {
  const product = flavor === "internal" ? "Anything Analyzer Internal.exe" : "Anything Analyzer.exe";
  executable = join(dirname(resources), product);
} else {
  const root = dirname(resources);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && !/^(chrome-sandbox|chrome_crashpad_handler)$/.test(entry.name))
    .map((entry) => join(root, entry.name));
  const ranked = await Promise.all(candidates.map(async (path) => ({
    path,
    size: (await stat(path)).size,
    executable: Boolean((await stat(path)).mode & 0o111),
  })));
  executable = ranked.filter((item) => item.executable).sort((a, b) => b.size - a.size)[0]?.path;
}
if (!executable) throw new Error(`Could not locate ${flavor} packaged executable`);

const temporary = await mkdtemp(join(tmpdir(), `anything-analyzer-${flavor}-smoke-`));
const appArgs = [
  "--aa-packaged-smoke",
  `--aa-smoke-user-data=${join(temporary, "user-data")}`,
  "--no-sandbox",
  "--disable-gpu",
];
const command = process.platform === "linux" ? "xvfb-run" : executable;
const args = process.platform === "linux" ? ["-a", executable, ...appArgs] : appArgs;
const child = spawn(command, args, {
  detached: process.platform !== "win32",
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));

try {
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(timeout), 30_000)),
  ]);
  if (result === timeout) throw new Error(`Packaged app did not complete its smoke shutdown\n${output}`);
  if (result.code !== 0 || result.signal) {
    throw new Error(`Packaged app smoke failed: ${JSON.stringify(result)}\n${output}`);
  }
  console.log(`[package-smoke] ${flavor} initialized and shut down cleanly: ${basename(executable)}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (process.platform !== "win32" && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
