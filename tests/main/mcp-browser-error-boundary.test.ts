import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/main/ipc", () => ({
  loadLLMConfig: vi.fn(),
  loadProxyConfig: vi.fn(() => null),
}));

import { BrowserBackendError } from "../../src/main/browser/contracts";
import {
  createMcpServerInstance,
  type MCPServerDeps,
} from "../../src/main/mcp/mcp-server";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("MCP browser error boundary", () => {
  it("keeps BrowserBackendError codes visible to MCP clients", async () => {
    const sessionManager = {
      createSession: vi.fn(() => {
        throw new BrowserBackendError(
          "BACKEND_NOT_AVAILABLE",
          "Browser backend cloak is not available in this build",
          { backendKind: "cloak" },
        );
      }),
    };
    const server = createMcpServerInstance({
      sessionManager,
    } as unknown as MCPServerDeps);
    const client = new Client(
      { name: "browser-error-boundary-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeCallbacks.push(async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "create_session",
      arguments: {
        name: "Unavailable Cloak",
        targetUrl: "https://example.com",
        backend: "cloak",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          "[BACKEND_NOT_AVAILABLE] Browser backend cloak is not available in this build",
      },
    ]);
  });
});
