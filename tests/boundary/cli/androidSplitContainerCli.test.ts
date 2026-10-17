import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import {
  splitApkBytes,
  writeSplitSet,
} from "../../fixtures/android/splitApk.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const extractionWorkspaces = async (): Promise<string[]> =>
  (await readdir(tmpdir())).filter((name) =>
    name.startsWith("rea-android-input-"),
  );

cliTest.for(["inspect-android-package", "decode-android-resources"])(
  "%s refuses an ambiguous split set before starting its provider",
  async (command, { cli }) => {
    const root = await createTestTempDirectory("rea-split-cli-");
    const base = await splitApkBytes({ packageName: "com.example.app" });
    const path = join(root, "app.apks");
    await writeSplitSet(
      path,
      { "base.apk": base, "standalones/standalone.apk": base },
      "zip",
    );
    const before = await extractionWorkspaces();
    const result = await cli.run({
      arguments: [command, path, "--json"],
      environment: {
        HOME: root,
        REA_APKTOOL_COMMAND: join(root, "missing-apktool"),
        REA_JADX_MCP_JAR: join(root, "missing.jar"),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(
        /2 APKs declare no split name.*base\.apk, standalones\/standalone\.apk/u,
      ),
    });
    expect(await extractionWorkspaces()).toEqual(before);
  },
);

cliTest(
  "names a malformed split container instead of a provider failure",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-split-cli-malformed-");
    const path = join(root, "broken.xapk");
    await writeFile(path, "PK\u0003\u0004not a zip");
    const result = await cli.run({
      arguments: ["inspect-android-package", path, "--json"],
      environment: { HOME: root, REA_JADX_MCP_JAR: join(root, "missing.jar") },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(
        `Split APK container ${path} is unreadable`,
      ),
    });
  },
);
