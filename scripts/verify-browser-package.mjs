import asar from "@electron/asar";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [flavor, rootArg] = process.argv.slice(2);
if (!new Set(["public", "internal"]).has(flavor) || !rootArg) {
  throw new Error("Usage: node scripts/verify-browser-package.mjs <public|internal> <package-root>");
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
if (archives.length !== 1) {
  throw new Error(`Expected exactly one app.asar below ${rootArg}, found ${archives.length}: ${archives.join(", ")}`);
}

const archive = archives[0];
const paths = asar.listPackage(archive).map((path) => `/${path.replaceAll("\\", "/").replace(/^\/+/, "")}`);
const has = (pattern) => paths.some((path) => pattern.test(path));
const packageJson = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
const expectedMain = flavor === "public" ? "./out/main/index.js" : "./out-internal/main/index.js";
if (packageJson.main !== expectedMain) {
  throw new Error(`${flavor} package main must be ${expectedMain}, got ${packageJson.main}`);
}

const cloakPackage = /^\/node_modules\/cloakbrowser(?:\/|$)/i;
const playwrightPackage = /^\/node_modules\/playwright-core(?:\/|$)/i;
const cloakChunk = /^\/(?:out|out-internal)\/main\/cloak-backend(?:-[^/]+)?\.js$/i;
const sensitive = [
  ["Cloak cache", /(^|\/)\.cloakbrowser(?:\/|$)/i],
  ["Cloak profile", /(^|\/)browser-profiles\/cloak(?:\/|$)/i],
  ["license key", /(^|\/)license\.key$/i],
  ["license cache", /(^|\/)\.license_cache$/i],
  ["browser binary", /(^|\/)chromium-[0-9][^/]*(?:\/|$)/i],
  ["partial browser download", /(^|\/)_download_[^/]*\.(?:zip|tar\.gz)$/i],
];

for (const [label, pattern] of sensitive) {
  const match = paths.find((path) => pattern.test(path));
  if (match) throw new Error(`${flavor} package contains forbidden ${label}: ${match}`);
}

if (flavor === "public") {
  for (const [label, pattern] of [
    ["cloakbrowser runtime", cloakPackage],
    ["playwright-core runtime", playwrightPackage],
    ["Cloak backend chunk", cloakChunk],
  ]) {
    const match = paths.find((path) => pattern.test(path));
    if (match) throw new Error(`Public package contains forbidden ${label}: ${match}`);
  }
} else {
  for (const [label, pattern] of [
    ["cloakbrowser wrapper", cloakPackage],
    ["playwright-core runtime", playwrightPackage],
    ["Cloak backend chunk", cloakChunk],
  ]) {
    if (!has(pattern)) throw new Error(`Internal package is missing ${label}`);
  }
}

console.log(`[package-check] ${flavor} OK: ${basename(archive)} (${paths.length} entries)`);
