import { expect, it } from "vitest";

import {
  MAX_MANIFEST_DECLARATION_UNITS,
  parseAndroidManifestRoot,
} from "./androidBinaryManifest.js";
import {
  compileBinaryManifest,
  compileSplitManifest,
  IS_FEATURE_SPLIT_ATTRIBUTE,
  VERSION_CODE_ATTRIBUTE,
} from "../../../tests/fixtures/android/splitApk.js";

const parsed = (bytes: Uint8Array) => {
  const result = parseAndroidManifestRoot(bytes);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const refusal = (bytes: Uint8Array): string => {
  const result = parseAndroidManifestRoot(bytes);
  if (result.ok) throw new Error("Expected a malformed manifest refusal");
  return result.error;
};

it.each([false, true])(
  "reads base declarations from a %s-encoded string pool",
  (utf8) => {
    expect(
      parsed(
        compileSplitManifest(
          { packageName: "com.example.app", versionCode: 44 },
          { utf8 },
        ),
      ),
    ).toEqual({
      packageName: "com.example.app",
      splitName: null,
      configForSplit: null,
      isFeatureSplit: null,
      versionCode: "44",
    });
  },
);

it("reads config and feature split declarations", () => {
  expect(
    parsed(
      compileSplitManifest(
        {
          packageName: "com.example.app",
          split: "feature_camera.config.arm64_v8a",
          configForSplit: "feature_camera",
          versionCode: 7,
        },
        { utf8: true },
      ),
    ),
  ).toMatchObject({
    splitName: "feature_camera.config.arm64_v8a",
    configForSplit: "feature_camera",
    isFeatureSplit: null,
  });
  expect(
    parsed(
      compileSplitManifest({
        packageName: "com.example.app",
        split: "feature_camera",
        isFeatureSplit: true,
      }),
    ),
  ).toMatchObject({ splitName: "feature_camera", isFeatureSplit: true });
});

it("recognizes framework attributes by resource id when names are stripped", () => {
  expect(
    parsed(
      compileBinaryManifest([
        {
          name: "versionCode",
          value: 12,
          androidResourceId: VERSION_CODE_ATTRIBUTE,
          anonymous: true,
        },
        {
          name: "isFeatureSplit",
          value: false,
          androidResourceId: IS_FEATURE_SPLIT_ATTRIBUTE,
          anonymous: true,
        },
        { name: "package", value: "com.example.app" },
        { name: "split", value: "config.en" },
      ]),
    ),
  ).toMatchObject({
    versionCode: "12",
    isFeatureSplit: false,
    splitName: "config.en",
  });
});

it("treats an empty split name as absent, as Android does", () => {
  expect(
    parsed(compileSplitManifest({ split: "", configForSplit: "" })),
  ).toMatchObject({ splitName: null, configForSplit: null });
});

it.each([
  ["not binary XML", Buffer.from("<manifest/>"), /not an Android binary XML/u],
  ["empty", Buffer.alloc(0), /truncated/u],
  [
    "a truncated document",
    compileSplitManifest({ split: "config.en" }).subarray(0, 60),
    /invalid bounds|truncated/u,
  ],
  [
    "another root element",
    compileBinaryManifest([{ name: "package", value: "x" }], {
      rootElement: "application",
    }),
    /root element is not <manifest>/u,
  ],
  [
    "a duplicated split declaration",
    compileBinaryManifest([
      { name: "split", value: "config.en" },
      { name: "split", value: "config.de" },
    ]),
    /declares split more than once/u,
  ],
  [
    "a non-string split declaration",
    compileBinaryManifest([{ name: "split", value: true }]),
    /split attribute is not a string/u,
  ],
  [
    "an oversized split declaration",
    compileSplitManifest({
      split: `config.${"x".repeat(MAX_MANIFEST_DECLARATION_UNITS)}`,
    }),
    /split declaration exceeds 1024 UTF-16 code units/u,
  ],
  [
    "an oversized string version code",
    compileBinaryManifest([
      {
        name: "versionCode",
        value: "9".repeat(MAX_MANIFEST_DECLARATION_UNITS + 1),
        androidResourceId: VERSION_CODE_ATTRIBUTE,
      },
    ]),
    /versionCode declaration exceeds/u,
  ],
])("refuses %s", (_label, bytes, reason) => {
  expect(refusal(bytes)).toMatch(reason);
});

it("accepts declarations up to the identifier bound", () => {
  const split = `config.${"x".repeat(MAX_MANIFEST_DECLARATION_UNITS - 7)}`;
  expect(parsed(compileSplitManifest({ split })).splitName).toBe(split);
});

it("refuses string indexes and chunk sizes outside the document", () => {
  const manifest = compileSplitManifest({ split: "config.en" });
  const outOfRange = Buffer.from(manifest);
  // The root element's name index sits after the 16-byte node header and namespace.
  const element = outOfRange.indexOf(Buffer.from([0x02, 0x01, 0x10, 0x00]));
  outOfRange.writeUInt32LE(0x7fff_ffff, element + 20);
  expect(refusal(outOfRange)).toMatch(/string index .* out of range/u);

  const oversized = Buffer.from(manifest);
  oversized.writeUInt32LE(manifest.length + 1, 4);
  expect(refusal(oversized)).toMatch(/invalid bounds/u);
});
