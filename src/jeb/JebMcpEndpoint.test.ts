import { describe, expect, it } from "vitest";

import {
  jebRegistrationEnvironment,
  parseJebMcpEndpoint,
} from "./JebMcpEndpoint.js";

describe("JEB MCP endpoint", () => {
  it("rejects an explicit empty query or fragment instead of dropping it", () => {
    expect(parseJebMcpEndpoint("http://127.0.0.1:8425/mcp").ok).toBe(true);
    expect(parseJebMcpEndpoint("http://127.0.0.1:8425/mcp/").ok).toBe(true);
    for (const value of [
      "http://127.0.0.1:8425/mcp?",
      "http://127.0.0.1:8425/mcp#",
      "http://127.0.0.1:8425/mcp?#",
    ])
      expect(parseJebMcpEndpoint(value).ok, value).toBe(false);
  });

  it("accepts only the declared MCP route", () => {
    expect(parseJebMcpEndpoint("http://127.0.0.1:8425/mcp").ok).toBe(true);
    for (const path of ["/mcp/extra", "/not-mcp", "/"])
      expect(parseJebMcpEndpoint(`http://127.0.0.1:8425${path}`).ok, path).toBe(
        false,
      );
  });
});

describe("JEB registration environment", () => {
  it("publishes only an explicit, valid endpoint exactly as selected", () => {
    expect(
      jebRegistrationEnvironment({
        PATH: "/ambient/bin",
        REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp/",
      }),
    ).toEqual({ REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp/" });
    // An empty selection means the default endpoint, which is not a caller
    // selection; malformed and non-loopback endpoints are refused.
    for (const value of [
      undefined,
      "",
      "not a url",
      "https://example.com/mcp",
      "http://127.0.0.1:8425/mcp?",
    ])
      expect(
        jebRegistrationEnvironment({ REA_JEB_MCP_URL: value }),
        String(value),
      ).toEqual({});
  });
});
