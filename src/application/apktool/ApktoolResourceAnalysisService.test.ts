import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ApktoolResourceAnalysisService } from "./ApktoolResourceAnalysisService.js";
import type { ApktoolResourceAnalysisPort } from "./ApktoolResourceAnalysisPort.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AndroidEntryPoints } from "../../domain/apktool/apktoolResourceAnalysis.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { toolContract } from "../../contracts/toolContracts.js";
import {
  splitApkBytes,
  writeSplitSet,
} from "../../../tests/fixtures/android/splitApk.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const identity = { id: "apktool", name: "Apktool", version: null };

const execution = createAnalysisExecution(
  {
    client: {
      command: "/usr/bin/apktool",
      command_source: "path",
      apktool_version: "2.7.0-dirty",
    },
  },
  identity,
);

const refusedPort: ApktoolResourceAnalysisPort = {
  async inspectAvailability() {
    throw new Error("must not probe");
  },
  async close() {},
  async execute() {
    throw new Error("must not execute");
  },
};

it.each([
  [{ path: "/targets/app.apk", include_strings: "yes" }],
  [{ path: "/targets/app.apk", locale: "not a locale" }],
  [{ path: "/targets/app.apk", extra: true }],
])("rejects invalid decode selection before any effect: %j", async (input) => {
  const service = new ApktoolResourceAnalysisService(refusedPort);
  expect(
    await service.execute("decode_android_resources", input),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("composes observed Evidence with the caller parameters inline", async () => {
  const port: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      expect(request).toEqual({
        operation: "decode_android_resources",
        input: {
          path: "/targets/app.apk",
          include_strings: true,
          include_manifest: true,
        },
      });
      return ok(execution);
    },
  };
  const result = await new ApktoolResourceAnalysisService(port).execute(
    "decode_android_resources",
    { path: "/targets/app.apk", include_strings: true },
  );
  if (!result.ok) throw new Error(result.error.message);
  const evidence = parseEvidence(result.value);
  expect(evidence.provider).toEqual(identity);
  expect(evidence.operation).toBe("decode_android_resources");
  expect(evidence.parameters).toEqual({
    path: "/targets/app.apk",
    include_strings: true,
    include_manifest: true,
  });
  expect(evidence.confidence).toBe("observed");
});

it("preserves cancellation before execution", async () => {
  const controller = new AbortController();
  controller.abort();
  const service = new ApktoolResourceAnalysisService(refusedPort);
  const result = await service.execute(
    "decode_android_resources",
    { path: "/targets/app.apk", include_strings: true },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});

it("preserves a cancellation that races a completed observation", async () => {
  const controller = new AbortController();
  const racingPort: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      // The provider may finish its work before the abort is delivered, so a
      // successful result is not by itself proof the caller still wants it.
      controller.abort();
      return ok(execution);
    },
  };
  const result = await new ApktoolResourceAnalysisService(racingPort).execute(
    "decode_android_resources",
    { path: "/targets/app.apk", include_strings: true },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  // The observation the provider completed is retained on the cancellation, so
  // a session still records the Evidence instead of losing finished work.
  const retained = parseEvidence(result.error.partialObservation);
  expect(retained.operation).toBe("decode_android_resources");
  expect(retained.provider).toEqual(identity);
  expect(retained.parameters).toEqual({
    path: "/targets/app.apk",
    include_strings: true,
    include_manifest: true,
  });
  expect(retained.confidence).toBe("observed");
});

const decodeResult = (path: string, bytes: number, sha256: string) => ({
  client: {
    command: "/usr/bin/apktool",
    command_source: "path",
    apktool_version: "2.7.0-dirty",
  },
  target: { path, bytes, sha256 },
  metadata: {
    version_name: "1.0",
    version_code: "3",
    min_sdk_version: "24",
    target_sdk_version: "34",
    package_name: "com.example.app",
  },
  manifest: "<manifest/>",
  entry_points: { components: [], deep_links: [] },
  strings: [],
  locale: null,
  locales: [],
  decoded_file_count: 2,
  coverage: "complete",
});

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** What a decoding port reports besides the identity of the bytes it read. */
interface DecodedFacts {
  readonly result?: {
    readonly entry_points?: AndroidEntryPoints;
    readonly coverage?: "complete" | "partial";
  };
  readonly limitations?: readonly string[];
}

/** A decoding port that reports the digest of the bytes it was given. */
const decodingPort = (
  calls: {
    readonly path: string;
    readonly locale?: string | undefined;
    readonly include_manifest?: boolean;
  }[],
  reported: (bytes: Buffer) => string = digest,
  facts: DecodedFacts = {},
): ApktoolResourceAnalysisPort => ({
  async inspectAvailability() {
    throw new Error("must not probe");
  },
  async close() {},
  async execute(request) {
    if (request.operation !== "decode_android_resources")
      throw new Error("unexpected operation");
    calls.push({
      path: request.input.path,
      locale: request.input.locale,
      include_manifest: request.input.include_manifest,
    });
    const bytes = await readFile(request.input.path);
    return ok(
      createAnalysisExecution(
        {
          ...decodeResult(request.input.path, bytes.length, reported(bytes)),
          ...facts.result,
        },
        identity,
        {
          limitations: [
            "Decoding skips smali (--no-src)",
            ...(facts.limitations ?? []),
          ],
        },
      ),
    );
  },
});

const writeContainer = async () => {
  const root = await createTestTempDirectory("rea-apktool-container-");
  const base = await splitApkBytes({ packageName: "com.example.app" });
  const split = await splitApkBytes({
    packageName: "com.example.app",
    split: "config.de",
  });
  const path = join(root, "app.xapk");
  await writeSplitSet(
    path,
    { "base.apk": base, "config.de.apk": split },
    "zip",
    {
      "manifest.json": Buffer.from("{}"),
    },
  );
  return { path, base, container: await readFile(path) };
};

it("decodes a split container's base APK and reports the selected container", async () => {
  const { path, base, container } = await writeContainer();
  const calls: { path: string; locale?: string | undefined }[] = [];
  const service = new ApktoolResourceAnalysisService(decodingPort(calls));
  const result = await service.execute("decode_android_resources", {
    path,
    locale: "de",
  });
  if (!result.ok) throw result.error;
  expect(calls).toHaveLength(1);
  expect(calls[0]!.path).not.toBe(path);
  expect(calls[0]!.locale).toBe("de");
  await expect(access(calls[0]!.path)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const evidence = parseEvidence(result.value);
  expect(evidence.parameters).toEqual({
    path,
    include_strings: true,
    include_manifest: true,
    locale: "de",
  });
  expect(evidence.normalized_result).toMatchObject({
    target: { path, bytes: container.length, sha256: digest(container) },
    input_container: {
      path,
      kind: "zip",
      base: { entry: "base.apk", sha256: digest(base) },
      splits: [{ entry: "config.de.apk", split_name: "config.de" }],
      other_entry_count: 1,
    },
  });
  // The admitted container is the subject, as in the JADX family.
  expect(evidence.subject).toMatchObject({
    name: "app.xapk",
    digest: { sha256: digest(container) },
    local_path: path,
  });
  expect(evidence.limitations).toEqual([
    "Decoding skips smali (--no-src)",
    expect.stringMatching(/^Analyzed only base APK base\.apk/u),
    "The manifest and any entry_points or deep links derived from it come only from the base APK manifest; components declared in split manifests are absent.",
    "1 non-APK container entry was not analyzed.",
    expect.stringContaining("signatures"),
  ]);
  expect(
    toolContract("decode_android_resources").outputSchema.safeParse(evidence)
      .success,
  ).toBe(true);
  await service.inputs.close();
});

it("passes a container's entry points and coverage through unchanged", async () => {
  const { path } = await writeContainer();
  const entryPoints = {
    components: [
      {
        kind: "activity" as const,
        name: "com.example.app.LinkActivity",
        target_activity: null,
        exported: null,
        exported_reference: "@bool/link_exported",
        enabled: true,
        enabled_reference: null,
        permission: null,
        launcher: false,
        intent_filters: [
          {
            actions: ["android.intent.action.VIEW"],
            categories: ["android.intent.category.BROWSABLE"],
            auto_verify: true,
            auto_verify_reference: null,
            data: [
              {
                scheme: "https",
                host: "app.example",
                port: null,
                path: null,
                path_prefix: "/item",
                path_pattern: null,
                path_advanced_pattern: null,
                path_suffix: null,
                mime_type: null,
              },
            ],
          },
        ],
      },
    ],
    deep_links: [
      {
        component: "com.example.app.LinkActivity",
        filter_index: 0,
        unprojected: ["sspPrefix"],
        scheme: "https",
        host: "app.example",
        port: null,
        path: "/item",
        path_kind: "prefix" as const,
        browsable: true,
        auto_verify: true,
        uri: "https://app.example/item*",
      },
    ],
  };
  const entryPointLimitations = [
    "entry_points does not project <data> attribute(s) sspPrefix; deep_links omit those constraints",
    "entry_points leaves 1 resource reference(s) or non-literal value(s) unresolved: text keeps the declared value and booleans report null: exported=@bool/link_exported (1)",
  ];
  const service = new ApktoolResourceAnalysisService(
    decodingPort([], digest, {
      result: { entry_points: entryPoints, coverage: "partial" },
      limitations: entryPointLimitations,
    }),
  );
  const result = await service.execute("decode_android_resources", { path });
  if (!result.ok) throw result.error;
  const evidence = parseEvidence(result.value);
  const decoded = evidence.normalized_result as Record<string, unknown>;
  expect(decoded.entry_points).toEqual(entryPoints);
  expect(decoded.coverage).toBe("partial");
  // Provider limitations, including the manifest projection's, come first.
  expect(evidence.limitations).toEqual([
    "Decoding skips smali (--no-src)",
    ...entryPointLimitations,
    expect.stringMatching(/^Analyzed only base APK base\.apk/u),
    expect.stringMatching(/^The manifest .* only from the base APK manifest/u),
    "1 non-APK container entry was not analyzed.",
    expect.stringContaining("signatures"),
  ]);
  expect(
    toolContract("decode_android_resources").outputSchema.safeParse(evidence)
      .success,
  ).toBe(true);
  await service.inputs.close();
});

it("binds a split directory decode to the base APK file it admitted", async () => {
  const root = await createTestTempDirectory("rea-apktool-directory-");
  const base = await splitApkBytes({ packageName: "com.example.app" });
  const split = await splitApkBytes({
    packageName: "com.example.app",
    split: "config.xxhdpi",
  });
  const path = join(root, "com.example.app");
  await writeSplitSet(
    path,
    { "base.apk": base, "split_config.xxhdpi.apk": split },
    "directory",
  );
  const calls: { path: string; include_manifest?: boolean }[] = [];
  const service = new ApktoolResourceAnalysisService(decodingPort(calls));
  const result = await service.execute("decode_android_resources", {
    path,
    include_manifest: false,
  });
  if (!result.ok) throw result.error;
  // The caller selection reaches the provider unchanged, beside the base path.
  expect(calls).toEqual([
    {
      path: join(path, "base.apk"),
      locale: undefined,
      include_manifest: false,
    },
  ]);
  const evidence = parseEvidence(result.value);
  expect(evidence.parameters).toEqual({
    path,
    include_strings: true,
    include_manifest: false,
  });
  expect(evidence.subject).toMatchObject({
    name: "base.apk",
    format: "apk",
    digest: { sha256: digest(base) },
    local_path: join(path, "base.apk"),
  });
  expect(evidence.normalized_result).toMatchObject({
    target: { path: join(path, "base.apk"), sha256: digest(base) },
    input_container: { kind: "directory", sha256: null },
  });
  await service.inputs.close();
});

it("refuses a decode whose bytes differ from the admitted base", async () => {
  const { path } = await writeContainer();
  const calls: { path: string }[] = [];
  const service = new ApktoolResourceAnalysisService(
    decodingPort(calls, () => "0".repeat(64)),
  );
  const result = await service.execute("decode_android_resources", { path });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisArtifactChangedError" },
  });
  await expect(access(calls[0]!.path)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await service.inputs.close();
});
