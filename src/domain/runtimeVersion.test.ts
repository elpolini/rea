import { describe, expect, it } from "vitest";

import {
  javaScriptRuntime,
  nodeRuntimeRemediation,
  pinnedNodeVersion,
  supportsNodeVersion,
} from "./runtimeVersion.js";

describe("supported Node.js versions", () => {
  it.each([
    ["20.0.0", false],
    ["22.18.9", false],
    ["22.19.0", true],
    ["22.99.0", true],
    ["23.0.0", false],
    ["24.10.9", false],
    ["24.11.0", true],
    ["24.99.0", true],
    ["25.1.0", false],
    ["26.0.0", true],
    ["27.0.0", true],
    ["24.11.0-rc.1", false],
    ["26.0.0-nightly.20261001", false],
    ["24.11", false],
    ["24.11.invalid", false],
    ["invalid", false],
  ])("classifies %s as supported=%s", (version, expected) => {
    expect(supportsNodeVersion(version)).toBe(expected);
  });
});

describe("JavaScript runtime identity", () => {
  it("distinguishes Bun from Node.js by its own version", () => {
    expect(javaScriptRuntime({ node: "24.18.0" })).toEqual({
      id: "node",
      version: "24.18.0",
    });
    expect(javaScriptRuntime({ node: "26.3.0", bun: "1.4.2" })).toEqual({
      id: "bun",
      version: "1.4.2",
      nodeCompatibilityVersion: "26.3.0",
    });
  });
});

describe("Node.js version pins", () => {
  it.each([
    ["24.18.0\n", "24.18.0"],
    ["v24.18.0", "24.18.0"],
    [" v24 \r\n", "24"],
    ["lts/*", undefined],
    ["node", undefined],
    ["24.18.0.1", undefined],
    ["", undefined],
  ])("reads .nvmrc %j as version %s", (text, version) => {
    expect(pinnedNodeVersion(text)).toBe(version);
  });

  it("words recovery the same way with and without a checkout pin", () => {
    expect(
      nodeRuntimeRemediation({
        release: "Node.js 24.x",
        nextStep: "restart REA",
      }),
    ).toBe(
      "Install or select Node.js 24.x with your version manager (for example nvm or fnm), make it the `node` on PATH for this shell or for the agent client that starts REA, then restart REA.",
    );
    const pin = { root: "/r", path: "/r/.nvmrc", version: "24.18.0" };
    expect(
      nodeRuntimeRemediation({
        release: "Node.js 24.x",
        pin,
        nextStep: "rerun setup",
      }),
    ).toBe(
      "This checkout pins Node.js 24.18.0 in /r/.nvmrc; install or select it with your version manager (for example `nvm install` or `fnm use --install-if-missing` in /r, or `nvm install 24.18.0` and `nvm use 24.18.0` with nvm-windows), then rerun setup.",
    );
    expect(
      nodeRuntimeRemediation({
        release: "Node.js 24.x",
        pin: { ...pin, version: undefined },
        nextStep: "restart REA",
      }),
    ).toBe(
      "This checkout pins its Node.js version in /r/.nvmrc; install or select it with your version manager (for example `nvm install` or `fnm use --install-if-missing` in /r), then restart REA.",
    );
  });
});
