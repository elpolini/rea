import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  AndroidInputContainerAdmission,
  type AndroidContainerLease,
  type AndroidInputAdmission,
} from "./AndroidInputContainerAdmission.js";
import { AndroidContainerResources } from "./AndroidInputContainerResources.js";
import { ZipArtifactReader } from "../../artifacts/ZipArtifactReader.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../../domain/configurationErrors.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { Result } from "../../domain/result.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import {
  splitApkBytes,
  writeSplitSet,
  zipBytes,
} from "../../../tests/fixtures/android/splitApk.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const PACKAGE = "com.example.app";
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const context = (signal?: AbortSignal) => ({
  operation: "inspect_android_package",
  providerId: "jadx",
  signal,
});

const splitSet = async () => ({
  base: await splitApkBytes({ packageName: PACKAGE, versionCode: 3 }),
  arm64: await splitApkBytes({
    packageName: PACKAGE,
    split: "config.arm64_v8a",
  }),
  xxhdpi: await splitApkBytes({ packageName: PACKAGE, split: "config.xxhdpi" }),
});

const leaseOf = (
  result: Result<AndroidInputAdmission, AnalysisError>,
): AndroidContainerLease => {
  if (!result.ok) throw result.error;
  if (result.value.kind !== "container")
    throw new Error("Expected a resolved split container");
  return result.value;
};

const failureOf = (
  result: Result<AndroidInputAdmission, AnalysisError>,
): AnalysisError => {
  if (result.ok) throw new Error("Expected container admission to fail");
  return result.error;
};

/** Record every extraction workspace an admission allocates. */
const recordWorkspaces = (): string[] => {
  const paths: string[] = [];
  const original = AndroidContainerResources.prototype.workspace;
  const spy = vi
    .spyOn(AndroidContainerResources.prototype, "workspace")
    .mockImplementation(async function (this: AndroidContainerResources) {
      const path = await original.call(this);
      paths.push(path);
      return path;
    });
  onTestFinished(() => spy.mockRestore());
  return paths;
};

const expectRemoved = async (paths: readonly string[]): Promise<void> => {
  for (const path of paths)
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
};

const admission = (): AndroidInputContainerAdmission => {
  const owner = new AndroidInputContainerAdmission();
  onTestFinished(() => owner.close());
  return owner;
};

it("resolves an .apks base by its manifest and reports every split", async () => {
  const root = await createTestTempDirectory("rea-split-apks-");
  const workspaces = recordWorkspaces();
  const { base, arm64, xxhdpi } = await splitSet();
  const path = join(root, "app.apks");
  await writeSplitSet(
    path,
    {
      "split_config.arm64_v8a.apk": arm64,
      "base.apk": base,
      "split_config.xxhdpi.apk": xxhdpi,
    },
    "zip",
  );
  const container = await readFile(path);
  const lease = leaseOf(await admission().admit(path, context()));
  expect(lease.subject).toEqual({
    path,
    sha256: sha256(container),
    format: "zip",
    bytes: container.length,
  });
  expect(lease.container).toMatchObject({
    path,
    kind: "zip",
    sha256: sha256(container),
    bytes: container.length,
    base: {
      entry: "base.apk",
      bytes: base.length,
      sha256: sha256(base),
      package_name: PACKAGE,
      split_name: null,
      version_code: "3",
    },
    splits: [
      {
        entry: "split_config.arm64_v8a.apk",
        sha256: sha256(arm64),
        split_name: "config.arm64_v8a",
        config_qualifier: "arm64_v8a",
      },
      {
        entry: "split_config.xxhdpi.apk",
        split_name: "config.xxhdpi",
        config_qualifier: "xxhdpi",
      },
    ],
    other_entry_count: 0,
  });
  expect(lease.apkSha256).toBe(sha256(base));
  expect(await readFile(lease.apkPath)).toEqual(Buffer.from(base));
  expect(workspaces).toHaveLength(1);
  expect(lease.apkPath.startsWith(workspaces[0]!)).toBe(true);
  expect(lease.limitations[0]).toMatch(
    /^Analyzed only base APK base\.apk .* 2 split APKs were not analyzed/u,
  );
  expect(await lease.release()).toBeUndefined();
  await expectRemoved(workspaces);
});

it("finds a renamed base in an XAPK and counts unanalyzed entries", async () => {
  const root = await createTestTempDirectory("rea-split-xapk-");
  const { base, arm64 } = await splitSet();
  const path = join(root, "app.xapk");
  await writeSplitSet(
    path,
    { "config.arm64_v8a.apk": arm64, [`${PACKAGE}.apk`]: base },
    "zip",
    {
      "manifest.json": Buffer.from('{"package_name":"com.example.app"}'),
      "icon.png": Buffer.from("png"),
      "Android/obb/com.example.app/main.3.com.example.app.obb":
        Buffer.from("obb"),
    },
  );
  const lease = leaseOf(await admission().admit(path, context()));
  expect(lease.container.base.entry).toBe(`${PACKAGE}.apk`);
  expect(lease.container.splits.map((split) => split.entry)).toEqual([
    "config.arm64_v8a.apk",
  ]);
  expect(lease.container.other_entry_count).toBe(3);
  expect(lease.limitations).toContain(
    "3 non-APK container entries were not analyzed.",
  );
  expect(await lease.release()).toBeUndefined();
});

it("resolves a directory in place without an extraction workspace", async () => {
  const root = await createTestTempDirectory("rea-split-directory-");
  const workspaces = recordWorkspaces();
  const { base, xxhdpi } = await splitSet();
  const path = join(root, "pulled");
  await writeSplitSet(
    path,
    { "base.apk": base, "split_config.xxhdpi.apk": xxhdpi },
    "directory",
    { "notes.txt": Buffer.from("not an apk") },
  );
  await mkdir(join(path, "lib"));
  const lease = leaseOf(await admission().admit(path, context()));
  expect(lease.apkPath).toBe(join(path, "base.apk"));
  expect(lease.subject).toEqual({
    path: join(path, "base.apk"),
    sha256: sha256(base),
    format: "apk",
    bytes: base.length,
  });
  expect(lease.container).toMatchObject({
    path,
    kind: "directory",
    sha256: null,
    bytes: null,
    base: { entry: "base.apk" },
    splits: [{ entry: "split_config.xxhdpi.apk" }],
    other_entry_count: 2,
  });
  expect(await lease.release()).toBeUndefined();
  expect(workspaces).toEqual([]);
  expect(await readFile(join(path, "base.apk"))).toEqual(Buffer.from(base));
});

it("passes standalone APKs and unclassified files through unchanged", async () => {
  const root = await createTestTempDirectory("rea-split-passthrough-");
  const workspaces = recordWorkspaces();
  const { base } = await splitSet();
  const owner = admission();
  const apk = join(root, "app.apk");
  const text = join(root, "notes.txt");
  const zip = join(root, "data.zip");
  await writeFile(apk, base);
  await writeFile(text, "not a zip");
  await writeFile(
    zip,
    await zipBytes([{ name: "readme.txt", bytes: Buffer.from("x") }]),
  );
  for (const path of [apk, text, zip, join(root, "missing.apks")])
    expect(await owner.admit(path, context())).toEqual({
      ok: true,
      value: { kind: "apk" },
    });
  expect(workspaces).toEqual([]);
});

it.each([
  [
    "two unsplit APKs",
    async () => {
      const { base } = await splitSet();
      return { "base.apk": base, "standalone.apk": base };
    },
    /2 APKs declare no split name.*base\.apk, standalone\.apk/u,
  ],
  [
    "only split APKs",
    async () => {
      const { arm64, xxhdpi } = await splitSet();
      return { "a.apk": arm64, "b.apk": xxhdpi };
    },
    /No APK declares itself as the base/u,
  ],
  [
    "a member without a manifest",
    async () => ({
      "base.apk": await zipBytes([
        { name: "classes.dex", bytes: Buffer.from("dex") },
      ]),
    }),
    /APK member base\.apk has no root AndroidManifest\.xml/u,
  ],
  [
    "a member with an unreadable manifest",
    async () => ({
      "base.apk": await splitApkBytes(Buffer.from("<manifest/>")),
    }),
    /APK member base\.apk has an unreadable manifest/u,
  ],
  [
    "no APK members",
    async () => ({ "manifest.json": Buffer.from("{}") }),
    /holds no APK members/u,
  ],
  [
    "an unsafe member name",
    async () => ({ "../escape.apk": (await splitSet()).base }),
    /APK member name .* is unsafe/u,
  ],
])(
  "refuses a container with %s and removes its workspace",
  async (_label, members, reason) => {
    const root = await createTestTempDirectory("rea-split-refused-");
    const workspaces = recordWorkspaces();
    const path = join(root, "app.apks");
    await writeSplitSet(path, await members(), "zip");
    const error = failureOf(await admission().admit(path, context()));
    expect(error).toBeInstanceOf(AnalysisInputError);
    expect((error as AnalysisInputError).issues).toEqual([
      expect.objectContaining({
        path: ["path"],
        message: expect.stringMatching(reason),
      }),
    ]);
    await expectRemoved(workspaces);
  },
);

it.each([
  ["truncated ZIP bytes", Buffer.from("PK\u0003\u0004truncated")],
  ["an empty archive", Buffer.from("PK\u0005\u0006")],
])("refuses a split-named file holding %s", async (_label, bytes) => {
  const root = await createTestTempDirectory("rea-split-malformed-");
  const path = join(root, "broken.apks");
  await writeFile(path, bytes);
  const error = failureOf(await admission().admit(path, context()));
  expect(error).toBeInstanceOf(AnalysisInputError);
});

it("refuses a directory that holds no APK files", async () => {
  const root = await createTestTempDirectory("rea-split-empty-dir-");
  await writeFile(join(root, "notes.txt"), "x");
  const error = failureOf(await admission().admit(root, context()));
  expect(error).toBeInstanceOf(AnalysisInputError);
  expect(error.message).toBe(
    "Invalid analysis input for inspect_android_package",
  );
});

/** Rewrite each central-directory record's uncompressed size, as a ZIP bomb declares. */
const declareUncompressedSize = (zip: Uint8Array, size: number): Buffer => {
  const bytes = Buffer.from(zip);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = bytes.readUInt32LE(end + 16);
  while (bytes.readUInt32LE(offset) === 0x0201_4b50) {
    bytes.writeUInt32LE(size, offset + 24);
    offset +=
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  return bytes;
};

it("refuses declared expansion beyond the archive budget before extracting", async () => {
  const root = await createTestTempDirectory("rea-split-bomb-");
  const workspaces = recordWorkspaces();
  const { base } = await splitSet();
  const path = join(root, "bomb.apks");
  await writeFile(
    path,
    declareUncompressedSize(
      await zipBytes([{ name: "base.apk", bytes: base, store: true }]),
      0x7fff_0000,
    ),
  );
  const error = failureOf(await admission().admit(path, context()));
  expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(error.message).toMatch(/decompression budget/u);
  expect(workspaces).toEqual([]);
});

it("bounds the number of APK members it extracts", async () => {
  const root = await createTestTempDirectory("rea-split-many-");
  const workspaces = recordWorkspaces();
  const path = join(root, "many.apks");
  await writeSplitSet(
    path,
    Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [
        `split_${String(index)}.apk`,
        Buffer.from("x"),
      ]),
    ),
    "zip",
  );
  const error = failureOf(await admission().admit(path, context()));
  expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(error).toMatchObject({ reportedLimits: { max_apk_members: 512 } });
  expect(workspaces).toEqual([]);
});

it("returns typed cancellation and removes a partial extraction", async () => {
  const root = await createTestTempDirectory("rea-split-cancel-");
  const workspaces = recordWorkspaces();
  const { base, arm64 } = await splitSet();
  const path = join(root, "app.apks");
  await writeSplitSet(path, { "base.apk": base, "split.apk": arm64 }, "zip");
  const before = new AbortController();
  const reason = new Error("caller stopped before admission");
  before.abort(reason);
  expect(
    failureOf(await admission().admit(path, context(before.signal))),
  ).toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });

  const during = new AbortController();
  const stop = new Error("caller stopped during extraction");
  const original = ZipArtifactReader.prototype.open;
  const open = vi
    .spyOn(ZipArtifactReader.prototype, "open")
    .mockImplementation(function (this: ZipArtifactReader, ...args) {
      const opened = original.apply(this, args);
      during.abort(stop);
      return opened;
    });
  onTestFinished(() => open.mockRestore());
  const error = failureOf(
    await admission().admit(path, context(during.signal)),
  );
  expect(error).toBeInstanceOf(AnalysisCancelledError);
  expect(error.cause).toBe(stop);
  expect(workspaces).toHaveLength(1);
  await expectRemoved(workspaces);
});

it("retains failed workspace removal, blocks admission and retries it", async () => {
  const root = await createTestTempDirectory("rea-split-cleanup-");
  const workspaces = recordWorkspaces();
  const { base, arm64 } = await splitSet();
  const path = join(root, "app.apks");
  await writeSplitSet(path, { "base.apk": base, "split.apk": arm64 }, "zip");
  const owner = admission();
  const denied = new Error("workspace removal denied");
  const close = vi
    .spyOn(PrivateRuntimeRoot.prototype, "close")
    .mockRejectedValueOnce(denied)
    .mockRejectedValueOnce(denied);
  onTestFinished(() => close.mockRestore());
  const lease = leaseOf(await owner.admit(path, context()));
  const cleanup = await lease.release();
  expect(cleanup).toBeInstanceOf(ProviderCleanupError);
  expect(cleanup?.cleanupIncomplete).toBe(true);
  expect(cleanup?.cleanupResources).toEqual([workspaces[0]]);
  await expect(access(workspaces[0]!)).resolves.toBeUndefined();

  // The retained owner is retried first; while it still fails, admission stays blocked.
  const blocked = failureOf(await owner.admit(path, context()));
  expect(blocked).toBeInstanceOf(ProviderCleanupError);
  expect(blocked.cleanupResources).toEqual([workspaces[0]]);
  expect(cleanup?.cleanupIncomplete).toBe(true);

  const next = leaseOf(await owner.admit(path, context()));
  expect(cleanup?.cleanupIncomplete).toBe(false);
  await expectRemoved(workspaces.slice(0, 1));
  expect(await next.release()).toBeUndefined();
  await expectRemoved(workspaces);
});

it("joins outstanding leases on close and refuses later admission", async () => {
  const root = await createTestTempDirectory("rea-split-close-");
  const workspaces = recordWorkspaces();
  const { base } = await splitSet();
  const path = join(root, "app.apks");
  await writeSplitSet(path, { "base.apk": base }, "zip");
  const owner = new AndroidInputContainerAdmission();
  const lease = leaseOf(await owner.admit(path, context()));
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  await expect(access(lease.apkPath)).resolves.toBeUndefined();
  expect(await lease.release()).toBeUndefined();
  await closing;
  await expectRemoved(workspaces);
  expect(failureOf(await owner.admit(path, context()))).toBeInstanceOf(
    AnalysisCancelledError,
  );
});

it("reports a directory member removed before it is opened as a target failure", async () => {
  const root = await createTestTempDirectory("rea-split-removed-");
  const { base, xxhdpi } = await splitSet();
  await writeSplitSet(
    root,
    { "base.apk": base, "split_config.xxhdpi.apk": xxhdpi },
    "directory",
  );
  const original = AndroidContainerResources.prototype.open;
  const open = vi
    .spyOn(AndroidContainerResources.prototype, "open")
    .mockImplementationOnce(async function (
      this: AndroidContainerResources,
      path,
      signal,
    ) {
      await rm(path);
      return original.call(this, path, signal);
    });
  onTestFinished(() => open.mockRestore());
  const error = failureOf(await admission().admit(root, context()));
  expect(error).toBeInstanceOf(BinaryTargetError);
  expect(error.message).toMatch(/does not exist/u);
});

it("refuses a directory member that changes while it is read", async () => {
  const root = await createTestTempDirectory("rea-split-changed-");
  const { base, xxhdpi } = await splitSet();
  await writeSplitSet(
    root,
    { "base.apk": base, "split_config.xxhdpi.apk": xxhdpi },
    "directory",
  );
  const original = ZipArtifactReader.prototype.close;
  const close = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementationOnce(async function (this: ZipArtifactReader) {
      await original.call(this);
      await appendFile(join(root, "base.apk"), "changed");
    });
  onTestFinished(() => close.mockRestore());
  const error = failureOf(await admission().admit(root, context()));
  expect(error).toBeInstanceOf(AnalysisArtifactChangedError);
  expect(error).toMatchObject({ path: join(root, "base.apk") });
});
