import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import type { AndroidAnalysisPort } from "./AndroidAnalysisPort.js";
import { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import { inspectAndroidPackage } from "./AndroidPackageInspection.js";
import { AndroidContainerResources } from "./AndroidInputContainerResources.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { toolContract } from "../../contracts/toolContracts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { parseEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok } from "../../domain/result.js";
import {
  splitApkBytes,
  writeSplitSet,
} from "../../../tests/fixtures/android/splitApk.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const PACKAGE = "com.example.app";
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const identity = { id: "jadx", name: "JADX headless", version: "0.7.1" };
const packageResult = {
  engine: {
    name: "jadx-headless-mcp",
    version: "0.7.1",
    artifact_sha256: "c".repeat(64),
    source_revision: null,
    worker_count: 1,
    heap_limit_mib: null,
  },
  package_name: PACKAGE,
  version_name: null,
  version_code: "3",
  min_sdk: null,
  target_sdk: null,
  permissions: [],
  manifest: {
    status: "complete",
    text: "<manifest/>",
    reported_total_bytes: 11,
  },
  class_count: 1,
  resource_count: 0,
  signature_verification: "not_performed",
};

/** Records each admitted APK and requires its bytes to stay readable during execution. */
const recordingPort = (
  respond: (
    target: BinaryTarget,
  ) => ReturnType<AndroidAnalysisPort["execute"]> = async (target) =>
    ok(
      createAnalysisExecution(packageResult, identity, {
        subject: target,
        limitations: ["Decompiled source is derived"],
        locations: [{ kind: "artifact-path", path: "AndroidManifest.xml" }],
      }),
    ),
) => {
  const calls: { target: BinaryTarget; bytes: Buffer; path: string }[] = [];
  const port: AndroidAnalysisPort = {
    inspectAvailability: () => {
      throw new Error("must not probe");
    },
    close: async () => {},
    async execute(target, request) {
      calls.push({
        target,
        bytes: await readFile(target.path),
        path: request.input.path,
      });
      return respond(target);
    },
  };
  return { port, calls };
};

const containerFixture = async () => {
  const root = await createTestTempDirectory("rea-android-service-");
  const base = await splitApkBytes({ packageName: PACKAGE, versionCode: 3 });
  const split = await splitApkBytes({
    packageName: PACKAGE,
    split: "config.arm64_v8a",
  });
  const path = join(root, "app.apks");
  await writeSplitSet(
    path,
    { "base.apk": base, "split_config.arm64_v8a.apk": split },
    "zip",
  );
  const workspaces: string[] = [];
  const original = AndroidContainerResources.prototype.workspace;
  const spy = vi
    .spyOn(AndroidContainerResources.prototype, "workspace")
    .mockImplementation(async function (this: AndroidContainerResources) {
      const workspace = await original.call(this);
      workspaces.push(workspace);
      return workspace;
    });
  onTestFinished(() => spy.mockRestore());
  return { root, base, path, workspaces };
};

const serviceOver = (port: AndroidAnalysisPort): AndroidAnalysisService => {
  const service = new AndroidAnalysisService(port);
  onTestFinished(() => service.inputs.close());
  return service;
};

const removed = async (paths: readonly string[]): Promise<void> => {
  expect(paths).not.toHaveLength(0);
  for (const path of paths)
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
};

it("analyzes a container's base APK and binds Evidence to the selected file", async () => {
  const { base, path, workspaces } = await containerFixture();
  const { port, calls } = recordingPort();
  const result = await serviceOver(port).execute("inspect_android_package", {
    path,
  });
  if (!result.ok) throw result.error;
  expect(calls).toHaveLength(1);
  expect(calls[0]!.target).toMatchObject({
    format: "apk",
    sha256: sha256(base),
  });
  expect(calls[0]!.bytes).toEqual(Buffer.from(base));
  expect(calls[0]!.path).toBe(path);
  const evidence = parseEvidence(result.value);
  const container = await readFile(path);
  expect(evidence.subject).toMatchObject({
    local_path: path,
    format: "zip",
    digest: { sha256: sha256(container) },
  });
  expect(evidence.parameters).toEqual({ path });
  expect(evidence.normalized_result).toMatchObject({
    package_name: PACKAGE,
    input_container: {
      kind: "zip",
      base: { entry: "base.apk", sha256: sha256(base) },
      splits: [
        { entry: "split_config.arm64_v8a.apk", config_qualifier: "arm64_v8a" },
      ],
    },
  });
  expect(evidence.limitations).toEqual([
    "Decompiled source is derived",
    expect.stringMatching(/^Analyzed only base APK base\.apk/u),
    expect.stringContaining("signatures"),
  ]);
  expect(
    toolContract("inspect_android_package").outputSchema.safeParse(evidence)
      .success,
  ).toBe(true);
  await removed(workspaces);
});

it("leaves a standalone APK observation unchanged", async () => {
  const root = await createTestTempDirectory("rea-android-service-apk-");
  const apk = join(root, "app.apk");
  await writeFile(apk, await splitApkBytes({ packageName: PACKAGE }));
  const { port } = recordingPort();
  const result = await serviceOver(port).execute("inspect_android_package", {
    path: apk,
  });
  if (!result.ok) throw result.error;
  expect(result.value.subject).toMatchObject({
    local_path: apk,
    format: "apk",
  });
  expect(result.value.normalized_result).not.toHaveProperty("input_container");
  expect(result.value.limitations).toEqual(["Decompiled source is derived"]);
});

it("removes the extraction after a provider failure or rejection", async () => {
  const { path, workspaces } = await containerFixture();
  const failure = new AnalysisOutputError(
    "inspect_android_package",
    "fixture provider failure",
  );
  const failed = await serviceOver(
    recordingPort(async () => err(failure)).port,
  ).execute("inspect_android_package", { path });
  expect(failed).toEqual({ ok: false, error: failure });
  await removed(workspaces);

  const thrown = new Error("fixture provider defect");
  await expect(
    serviceOver(
      recordingPort(async () => {
        throw thrown;
      }).port,
    ).execute("inspect_android_package", { path }),
  ).rejects.toBe(thrown);
  expect(workspaces).toHaveLength(2);
  await removed(workspaces);
});

it("retains a completed observation when cancellation races provider completion", async () => {
  const { path, workspaces } = await containerFixture();
  const controller = new AbortController();
  const reason = new Error("caller stopped after provider completion");
  const { port } = recordingPort(async (target) => {
    controller.abort(reason);
    return ok(
      createAnalysisExecution(packageResult, identity, { subject: target }),
    );
  });
  const result = await serviceOver(port).execute(
    "inspect_android_package",
    { path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  const error: AnalysisError = result.error;
  expect(error).toBeInstanceOf(AnalysisCancelledError);
  expect(error.cause).toBe(reason);
  expect(
    parseEvidence(error.partialObservation).normalized_result,
  ).toHaveProperty("input_container");
  await removed(workspaces);
});

it("keeps the resolved container in a retained package summary", async () => {
  const { path, workspaces } = await containerFixture();
  const records = new Map<string, Evidence>();
  const summary = await inspectAndroidPackage(
    serviceOver(recordingPort().port),
    { path, detail: "summary" },
    {
      recordEvidence: (evidence) => {
        records.set(evidence.evidence_id, evidence);
        return ok("added");
      },
      evidenceById: (id) => records.get(id),
    },
  );
  if (!summary.ok) throw summary.error;
  expect(summary.value.normalized_result).toMatchObject({
    kind: "summary",
    artifact: { path },
    summary: {
      manifest: { text_included: false },
      input_container: { base: { entry: "base.apk" } },
    },
  });
  expect(
    toolContract("inspect_android_package").outputSchema.safeParse(
      summary.value,
    ).success,
  ).toBe(true);
  await removed(workspaces);
});
