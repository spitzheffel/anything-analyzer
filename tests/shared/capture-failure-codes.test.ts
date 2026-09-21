/**
 * 缺口的细分原因是从 router 的失败原文分类出来的，而原文里有 URL 和 targetId，
 * 不能原样存（面板承诺不含这些）。分类靠前缀匹配，所以原文一改就会静默退化成
 * 'other' —— 这里直接读 router 源码，把每条 reportFailure 的字面量都过一遍。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCaptureFailure } from "../../src/shared/capture-protocol";

const routerSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/main/browser/cloak-realm-router.ts"),
  "utf8",
);

/** 取出每个 reportFailure(`...`) 的完整骨架：插值换成占位符，多行拼成一行 */
function reportedMessages(source: string): string[] {
  const messages: string[] = [];
  const marker = /reportFailure\(\s*`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    const skeleton = match[1].replace(/\$\{[^}]*\}/g, "<id>").replace(/\s+/g, " ").trim();
    if (skeleton) messages.push(skeleton);
  }
  return messages;
}

describe("classifyCaptureFailure covers what the router actually reports", () => {
  const messages = reportedMessages(routerSource);

  it("finds the router's failure messages at all", () => {
    // 正则失效时下面那条会全绿地骗人
    expect(messages.length).toBeGreaterThan(10);
  });

  it.each(messages)("classifies %s", (message) => {
    expect(classifyCaptureFailure(message)).not.toBe("other");
  });

  it("returns a code and never the original text", () => {
    const withSecrets =
      "Worker entry script was not rewritten for TARGET-ABC (https://secret.example.com/w.js); "
      + "its first statements ran without instrumentation";
    expect(classifyCaptureFailure(withSecrets)).toBe("worker-entry-script-rewrite-failed");

    expect(classifyCaptureFailure("CDP WebSocket disconnected; realm coverage is unavailable"))
      .toBe("cdp-websocket-disconnected");
    expect(classifyCaptureFailure("something nobody wrote a rule for")).toBe("other");
  });
});
