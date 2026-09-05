import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const vitest = require.resolve("vitest/vitest.mjs");
const testFiles = process.argv.slice(2);
if (testFiles.length === 0) throw new Error("Pass at least one Vitest file");

const child = spawn(electron, [vitest, "run", ...testFiles], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) console.error(`Electron Vitest terminated by ${signal}`);
  process.exitCode = code ?? 1;
});
