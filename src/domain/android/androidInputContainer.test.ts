import { expect, it } from "vitest";

import {
  androidInputContainerLimitations,
  androidInputContainerSchema,
  hasAndroidSplitContainerSuffix,
  selectAndroidContainerBase,
  type AndroidContainerMemberObservation,
} from "./androidInputContainer.js";

const member = (
  entry: string,
  manifest: Partial<AndroidContainerMemberObservation["manifest"]> = {},
): AndroidContainerMemberObservation => ({
  entry,
  bytes: entry.length,
  sha256: "a".repeat(64),
  manifest: {
    packageName: "com.example.app",
    splitName: null,
    configForSplit: null,
    isFeatureSplit: null,
    versionCode: "3",
    ...manifest,
  },
});

it("identifies the base from manifests rather than file names", () => {
  const selected = selectAndroidContainerBase([
    member("base.apk", { splitName: "config.xxhdpi" }),
    member("com.example.app.apk"),
    member("split_feature.apk", {
      splitName: "feature_camera",
      isFeatureSplit: true,
    }),
    member("split_feature_config.apk", {
      splitName: "feature_camera.config.arm64_v8a",
      configForSplit: "feature_camera",
    }),
  ]);
  if (!selected.ok) throw new Error(selected.error.message);
  expect(selected.value.base).toMatchObject({
    entry: "com.example.app.apk",
    split_name: null,
    config_qualifier: null,
  });
  expect(
    selected.value.splits.map((split) => [split.entry, split.config_qualifier]),
  ).toEqual([
    ["base.apk", "xxhdpi"],
    ["split_feature.apk", null],
    ["split_feature_config.apk", "arm64_v8a"],
  ]);
});

it.each([
  ["config.de", "de"],
  ["feature.config.xxhdpi", "xxhdpi"],
  ["config.", null],
  ["feature.config.", null],
  ["configurable", null],
  ["feature_config.de", null],
  // Target-controlled text is reported as declared after one linear scan.
  ["config.config.config.\n", "config.config.\n"],
])("derives the bundletool qualifier of split %j", (splitName, qualifier) => {
  const selected = selectAndroidContainerBase([
    member("base.apk"),
    member("split.apk", { splitName }),
  ]);
  if (!selected.ok) throw new Error(selected.error.message);
  expect(selected.value.splits[0]?.config_qualifier).toBe(qualifier);
});

it("refuses a container without exactly one unsplit APK", () => {
  expect(
    selectAndroidContainerBase([
      member("a.apk", { splitName: "config.en" }),
      member("b.apk", { splitName: "config.de" }),
    ]),
  ).toMatchObject({
    ok: false,
    error: {
      reason: "missing_base",
      message: expect.stringContaining("a.apk"),
    },
  });
  expect(
    selectAndroidContainerBase([
      member("base.apk"),
      member("standalones/standalone-arm64_v8a.apk"),
    ]),
  ).toMatchObject({
    ok: false,
    error: {
      reason: "multiple_bases",
      message: expect.stringContaining("standalones/standalone-arm64_v8a.apk"),
    },
  });
});

it("states what the base-only analysis leaves unobserved", () => {
  const selected = selectAndroidContainerBase([
    member("base.apk"),
    member("split_feature.apk", {
      splitName: "feature_camera",
      isFeatureSplit: true,
    }),
    member("split_other.apk", {
      splitName: "config.en",
      packageName: "com.other",
    }),
  ]);
  if (!selected.ok) throw new Error(selected.error.message);
  const container = androidInputContainerSchema.parse({
    path: "/targets/app.apks",
    kind: "zip",
    sha256: "b".repeat(64),
    bytes: 99,
    base: selected.value.base,
    splits: selected.value.splits,
    other_entry_count: 2,
  });
  const limitations = androidInputContainerLimitations(container);
  expect(limitations).toEqual([
    expect.stringMatching(
      /^Analyzed only base APK base\.apk .* 2 split APKs were not analyzed/u,
    ),
    expect.stringContaining("split_feature.apk"),
    "Split split_other.apk declares package com.other, not the base package com.example.app.",
    "2 non-APK container entries were not analyzed.",
    expect.stringContaining("signatures"),
  ]);
});

it.each([
  ["/x/app.apks", true],
  ["/x/APP.XAPK", true],
  ["/x/app.apkm", true],
  ["/x/app.apk", false],
  ["/x/app.zip", false],
])("classifies the container suffix of %s", (path, expected) => {
  expect(hasAndroidSplitContainerSuffix(path)).toBe(expected);
});
