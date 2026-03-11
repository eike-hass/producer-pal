// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import Max from "max-api";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../create-mcp-server.ts";

// Mock listen-handler to avoid real API calls
vi.mock(import("../listen-handler.ts"), () => ({
  handleListen: vi.fn(),
}));

type MockMax = typeof Max & {
  handlers: Map<string, (...args: unknown[]) => void>;
};
const mockMax = Max as MockMax;

describe("createMcpServer with ENABLE_LISTEN", () => {
  it("registers ppal-listen tool when ENABLE_LISTEN is true and calls handler", async () => {
    process.env.ENABLE_LISTEN = "true";
    const server = createMcpServer(() => Promise.resolve([]), {});
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => unknown }
        >;
      }
    )._registeredTools;

    expect(tools["ppal-listen"]).toBeDefined();
    await tools["ppal-listen"]!.handler({});
    delete process.env.ENABLE_LISTEN;
  });

  it("does not register ppal-listen tool when ENABLE_LISTEN is not set", () => {
    delete process.env.ENABLE_LISTEN;
    const server = createMcpServer(() => Promise.resolve([]), {});
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, unknown>;
      }
    )._registeredTools;

    expect(tools["ppal-listen"]).toBeUndefined();
  });
});

describe("createExpressApp listen handlers", () => {
  beforeAll(async () => {
    await import("../create-express-app.ts");
  });

  it("should invoke geminiKey handler without throwing", () => {
    const handler = mockMax.handlers.get("geminiKey");

    expect(handler).toBeDefined();
    expect(() => handler!("my-api-key")).not.toThrow();
    expect(() => handler!("bang")).not.toThrow();
  });

  it("should invoke geminiModel handler without throwing", () => {
    const handler = mockMax.handlers.get("geminiModel");

    expect(handler).toBeDefined();
    expect(() => handler!("gemini-2.5-flash")).not.toThrow();
    expect(() => handler!("bang")).not.toThrow();
  });
});
