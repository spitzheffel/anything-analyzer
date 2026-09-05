import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

function readWorkspaceFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("macOS 发布工作流", () => {
  it("应该使用 Node 24 运行时兼容的 Actions 主版本", () => {
    const workflow = readWorkspaceFile(".github/workflows/build.yml");

    expect(workflow).toContain("uses: actions/checkout@v6");
    expect(workflow).toContain("uses: pnpm/action-setup@v6");
    expect(workflow).toContain("uses: actions/setup-node@v6");
    expect(workflow).toContain("uses: actions/upload-artifact@v7");
    expect(workflow).toContain("uses: actions/download-artifact@v6");
    expect(workflow).toContain("uses: softprops/action-gh-release@v3");
  });

  it("应该分别在 Intel 和 Apple Silicon runner 上构建 macOS x64 与 arm64 包", () => {
    const workflow = readWorkspaceFile(".github/workflows/build.yml");

    expect(workflow).toContain("platform: mac");
    expect(workflow).toContain("os: macos-15-intel");
    expect(workflow).toContain("arch: x64");
    expect(workflow).toContain("os: macos-15");
    expect(workflow).toContain("arch: arm64");
    expect(workflow).toContain("npx electron-builder --mac --${{ matrix.arch }} --publish never");
    expect(workflow).not.toContain("npx electron-builder --mac --x64 --arm64 --publish never");
  });

  it("应该在发布前校验 better-sqlite3 原生模块与 macOS 目标架构一致", () => {
    const workflow = readWorkspaceFile(".github/workflows/build.yml");

    expect(workflow).toContain("better-sqlite3/build/Release/better_sqlite3.node");
    expect(workflow).toContain("file \"$native_module\" | tee \"dist/better-sqlite3-${{ matrix.arch }}.txt\"");
    expect(workflow).toContain("grep -Eq \"x86_64|x86_64h\" \"dist/better-sqlite3-${{ matrix.arch }}.txt\"");
    expect(workflow).toContain("grep -q \"arm64\" \"dist/better-sqlite3-${{ matrix.arch }}.txt\"");
  });

  it("应该将拆分构建后的 macOS 更新元数据合并为 latest-mac.yml", () => {
    const workflow = readWorkspaceFile(".github/workflows/build.yml");

    expect(workflow).toContain("mv \"dist/latest-mac.yml\" \"dist/latest-mac-${{ matrix.arch }}.yml\"");
    expect(workflow).toContain("Merge macOS update metadata");
    expect(workflow).toContain("artifacts/latest-mac.yml");
  });

  it("应该仅在 macOS 代码签名 secrets 存在时注入并校验签名", () => {
    const workflow = readWorkspaceFile(".github/workflows/build.yml");

    expect(workflow).toContain("SIGNING_CSC_LINK: ${{ secrets.CSC_LINK }}");
    expect(workflow).toContain('if [ -n "$SIGNING_CSC_LINK" ]; then');
    expect(workflow).toContain('echo "CSC_LINK=$SIGNING_CSC_LINK" >> "$GITHUB_ENV"');
    expect(workflow).toContain('echo "MAC_SIGNING_ENABLED=true" >> "$GITHUB_ENV"');
    expect(workflow).toContain('echo "MAC_SIGNING_ENABLED=false" >> "$GITHUB_ENV"');
    expect(workflow).toContain('if [ "$MAC_SIGNING_ENABLED" != "true" ]; then');
    expect(workflow).toContain("codesign --verify --deep --strict --verbose=2");
  });

  it("应该为 macOS 构建启用 hardened runtime 和 entitlements", () => {
    const builderConfig = readWorkspaceFile("electron-builder.yml");

    expect(builderConfig).toContain("hardenedRuntime: true");
    expect(builderConfig).toContain("gatekeeperAssess: false");
    expect(builderConfig).toContain("type: distribution");
    expect(builderConfig).toContain("entitlements: resources/entitlements.mac.plist");
    expect(builderConfig).toContain("entitlementsInherit: resources/entitlements.mac.plist");
  });

  it("应该提供 Electron 所需的 macOS entitlements", () => {
    const entitlements = readWorkspaceFile("resources/entitlements.mac.plist");

    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(entitlements).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("应该将 Cloak 运行时限制在独立 Internal 构建", () => {
    const publicBuilder = readWorkspaceFile("electron-builder.yml");
    const internalBuilder = readWorkspaceFile("electron-builder.internal.yml");
    const packageJson = readWorkspaceFile("package.json");
    const mainEntry = readWorkspaceFile("src/main/index.ts");
    const viteConfig = readWorkspaceFile("electron.vite.config.ts");

    // These globs exclude both a hoisted package and pnpm's nested physical copy.
    expect(publicBuilder).toContain("!**/node_modules/cloakbrowser{,/**}");
    expect(publicBuilder).toContain("!**/node_modules/playwright-core{,/**}");
    expect(publicBuilder).toContain("!**/node_modules/mmdb-lib{,/**}");
    expect(publicBuilder).toContain("!**/node_modules/socks-proxy-agent{,/**}");
    expect(publicBuilder).toContain("!**/node_modules/tar{,/**}");
    expect(publicBuilder).toContain("!**/node_modules/chownr{,/**}");
    expect(publicBuilder).toContain("!**/.cloakbrowser{,/**}");
    expect(internalBuilder).not.toContain("!**/node_modules/cloakbrowser");
    expect(internalBuilder).not.toContain("!**/node_modules/playwright-core");
    expect(internalBuilder).toContain("!**/.cloakbrowser{,/**}");

    expect(publicBuilder).toContain("'out{,/**}'");
    expect(internalBuilder).toContain("'out-internal{,/**}'");
    expect(internalBuilder).toContain("main: ./out-internal/main/index.js");
    expect(viteConfig).toContain(
      "const outputRoot = buildChannel === 'internal' ? 'out-internal' : 'out'",
    );

    for (const builderConfig of [publicBuilder, internalBuilder]) {
      expect(builderConfig).toContain("'package.json'");
      expect(builderConfig).toContain("from: resources");
      expect(builderConfig).toContain("to: resources");
      expect(builderConfig).toContain("- icon.png");
      expect(builderConfig).toContain("!src{,/**}");
      expect(builderConfig).toContain("!tests{,/**}");
      expect(builderConfig).toContain("!**/tests{,/**}");
      expect(builderConfig).toContain("!**/__tests__{,/**}");
      expect(builderConfig).toContain("!dist{,/**}");
      expect(builderConfig).toContain("!dist-internal{,/**}");
      expect(builderConfig).toContain("!output{,/**}");
      expect(builderConfig).toContain("!**/browser-profiles/cloak{,/**}");
      expect(builderConfig).toContain("!**/license.key");
      expect(builderConfig).toContain("!**/.license_cache");
      expect(builderConfig).toContain("!**/chromium-[0-9]*{,/**}");
      expect(builderConfig).toContain("!**/_download_*.{zip,tar.gz}");
    }

    expect(publicBuilder).toMatch(/^appId: com\.anything\.analyzer\r?$/m);
    expect(publicBuilder).toMatch(/^productName: Anything Analyzer\r?$/m);
    expect(internalBuilder).toContain("appId: com.anything.analyzer.internal");
    expect(internalBuilder).toContain("productName: Anything Analyzer Internal");
    expect(internalBuilder).toContain("output: dist-internal");
    expect(internalBuilder).toContain(
      'artifactName: "Anything-Analyzer-Internal-Setup-${version}.${ext}"',
    );
    expect(internalBuilder).toContain(
      'artifactName: "Anything-Analyzer-Internal-${version}-${arch}.${ext}"',
    );
    expect(internalBuilder).toContain(
      'artifactName: "Anything-Analyzer-Internal-${version}.${ext}"',
    );
    expect(internalBuilder).toContain("publish: null");
    expect(mainEntry).toContain('if (BUILD_CHANNEL === "internal")');
    expect(mainEntry).toContain('app.setName("Anything Analyzer Internal")');
    expect(mainEntry).toContain(
      'app.setPath("userData", join(app.getPath("appData"), "Anything Analyzer Internal"))',
    );

    expect(packageJson).toContain('"cloakbrowser": "0.5.10"');
    expect(packageJson).toContain('"playwright-core": "1.62.1"');
    expect(packageJson).toContain('"build:internal": "electron-vite build --mode internal"');
    expect(packageJson).toContain(
      '"dev:internal": "electron-vite dev --mode internal --entry out-internal/main/index.js"',
    );
    expect(packageJson).toContain(
      '"preview:internal": "electron-vite preview --mode internal --entry out-internal/main/index.js"',
    );
    expect(packageJson).toContain(
      '"package:internal": "pnpm build:internal && electron-builder --config electron-builder.internal.yml --publish never"',
    );
  });
});
