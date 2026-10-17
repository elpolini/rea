import { writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";
import { createGhidraTargetSnapshot } from "../../../src/ghidra/GhidraTargetSnapshot.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const ambiguous = {
  code: "ERR_REA_WINDOWS_NATIVE",
  constraint: "Ambiguous Windows path component is unsupported",
  win32Code: 50,
};

const withRuntime = async <T>(
  parent: string,
  use: (root: PrivateRuntimeRoot) => Promise<T>,
): Promise<T> => {
  const root = await PrivateRuntimeRoot.create({
    parent,
    prefix: "rea-admission-",
  });
  try {
    return await use(root);
  } finally {
    await root.close();
  }
};

// The native walker opens every component literally and rejects empty ones.
// These cases run that real walker so each TypeScript path owner is shown to
// hand it the single drive spelling Win32 resolves (#4707).
describe.runIf(process.platform === "win32")(
  "Windows native path admission",
  () => {
    it("admits one file for every drive spelling of a selected target", async () => {
      const directory = await createTestTempDirectory("rea-win-target-");
      const path = join(directory, "image.exe");
      await writeFile(path, pe(0x8664));
      const spellings = [
        path,
        path.replaceAll("\\", "/"),
        path.replaceAll("\\", "\\\\"),
        path.replaceAll("\\", "//"),
      ];
      const fileIds = new Set<unknown>();
      for (const spelling of spellings) {
        const target = await parseBinaryTarget(spelling);
        if (!target.ok) throw target.error;
        expect(target.value.sourcePath, spelling).toBe(path);
        const admission = await withRuntime(directory, async (root) => {
          const snapshot = await createGhidraTargetSnapshot(
            target.value.sourcePath ?? target.value.path,
            root.path,
            target.value.sha256,
            { platform: "win32" },
          );
          return snapshot.admission;
        });
        expect(admission, spelling).toMatchObject({
          source: { requestedPath: path, directory: false },
        });
        fileIds.add(
          (admission as { source: { fileId: string } }).source.fileId,
        );
      }
      expect(fileIds.size).toBe(1);
    });

    it("keeps repeated separators, trailing dots and UNC paths rejected at native admission", async () => {
      const directory = await createTestTempDirectory("rea-win-rejected-");
      const path = join(directory, "image.exe");
      await writeFile(path, pe(0x8664));
      const target = await parseBinaryTarget(path);
      if (!target.ok) throw target.error;
      const unc = `\\\\localhost\\${path.slice(0, 1)}$${path.slice(2)}`;
      for (const [spelling, constraint] of [
        [path.replaceAll("\\", "\\\\"), ambiguous],
        [`${path}.`, ambiguous],
        [
          unc,
          {
            code: "ERR_REA_WINDOWS_NATIVE",
            constraint: "Only absolute local NTFS drive paths are supported",
          },
        ],
      ] as const)
        await withRuntime(directory, async (root) => {
          await expect(
            createGhidraTargetSnapshot(
              spelling,
              root.path,
              target.value.sha256,
              { platform: "win32" },
            ),
            spelling,
          ).rejects.toMatchObject(constraint);
        });
    });

    it("creates private runtimes under each drive spelling of an inherited parent", async () => {
      const directory = await createTestTempDirectory("rea-win-parent-");
      for (const parent of [
        directory.replaceAll("\\", "/"),
        directory.replaceAll("\\", "\\\\"),
        directory.replaceAll("\\", "//"),
        `${directory}\\.\\`,
      ])
        await withRuntime(parent, (root) => {
          expect(win32.dirname(root.path), parent).toBe(directory);
          return Promise.resolve();
        });
      await expect(
        PrivateRuntimeRoot.create({
          parent: `${directory}.`,
          prefix: "rea-admission-",
        }),
      ).rejects.toMatchObject(ambiguous);
    });
  },
);
