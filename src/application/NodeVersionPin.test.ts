import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { readNodeVersionPin } from "./NodeVersionPin.js";

it("reads a source checkout's .nvmrc and reports no pin for a package", async () => {
  const root = await createTestTempDirectory("rea-node-version-pin-");
  await expect(readNodeVersionPin(root)).resolves.toBeUndefined();

  await writeFile(join(root, ".nvmrc"), "v24.18.0\n");
  await expect(readNodeVersionPin(root)).resolves.toEqual({
    root,
    path: join(root, ".nvmrc"),
    version: "24.18.0",
  });

  await writeFile(join(root, ".nvmrc"), "lts/*\n");
  await expect(readNodeVersionPin(root)).resolves.toEqual({
    root,
    path: join(root, ".nvmrc"),
    version: undefined,
  });
});

it("reads this checkout's own pin by default", async () => {
  await expect(readNodeVersionPin()).resolves.toMatchObject({
    root: resolve("."),
    path: resolve(".nvmrc"),
  });
});
