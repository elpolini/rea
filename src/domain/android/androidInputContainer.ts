import { z } from "zod";

import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { err, ok, type Result } from "../result.js";
import type { AndroidManifestRootDeclarations } from "./androidBinaryManifest.js";

const containerMemberSchema = z.strictObject({
  entry: z
    .string()
    .min(1)
    .describe("ZIP member path, or file name inside the selected directory"),
  bytes: z.number().int().nonnegative(),
  sha256: digestSchema,
  package_name: z.string().nullable(),
  split_name: z
    .string()
    .nullable()
    .describe(
      "Declared root manifest split name; null identifies the base APK",
    ),
  config_for_split: z.string().nullable(),
  is_feature_split: z
    .boolean()
    .nullable()
    .describe("Declared android:isFeatureSplit; null when undeclared"),
  version_code: z.string().nullable(),
  config_qualifier: z
    .string()
    .nullable()
    .describe(
      "Text after `config.` in the declared split name (bundletool naming); not read from the split's resource table",
    ),
});

/**
 * A split APK set REA resolved from one caller-selected container. Only the
 * base APK is analyzed; every split is reported with observed identity and
 * manifest declarations.
 */
export const androidInputContainerSchema = z
  .strictObject({
    path: localPathStringSchema,
    kind: z.enum(["zip", "directory"]),
    sha256: digestSchema
      .nullable()
      .describe("Digest of a ZIP container; null for a directory"),
    bytes: z.number().int().nonnegative().nullable(),
    base: containerMemberSchema,
    splits: z.array(containerMemberSchema),
    other_entry_count: z
      .number()
      .int()
      .nonnegative()
      .describe("Non-APK container entries that were not analyzed"),
  })
  .describe(
    "Present only when the selected path was a split APK container; the result describes its base APK",
  );

/** Reported identity and declarations of one APK in a container. */
export type AndroidContainerMember = z.infer<typeof containerMemberSchema>;
/** Reported split APK container facts. */
export type AndroidInputContainer = z.infer<typeof androidInputContainerSchema>;

/** Observed bytes and manifest declarations for one APK member. */
export interface AndroidContainerMemberObservation {
  readonly entry: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly manifest: AndroidManifestRootDeclarations;
}

/** Why no single base APK could be identified from member manifests. */
export interface AndroidContainerBaseFailure {
  readonly reason: "missing_base" | "multiple_bases";
  readonly message: string;
}

/** ZIP suffixes conventionally used for split APK sets and their backups. */
const SPLIT_CONTAINER_SUFFIXES = [".apks", ".xapk", ".apkm"] as const;

/** Whether a path's suffix names a split APK container family. */
export const hasAndroidSplitContainerSuffix = (path: string): boolean => {
  const lower = path.toLowerCase();
  return SPLIT_CONTAINER_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/** Whether a container member name denotes an APK file. */
export const isAndroidApkMemberName = (name: string): boolean =>
  name.toLowerCase().endsWith(".apk");

const CONFIG_SEGMENT = "config.";

/**
 * Bundletool names configuration splits `config.<qualifier>` or
 * `<feature>.config.<qualifier>`. Scanned linearly: split names are
 * target-controlled text.
 */
const configQualifier = (splitName: string | null): string | null => {
  if (splitName === null) return null;
  let start = 0;
  if (!splitName.startsWith(CONFIG_SEGMENT)) {
    const nested = splitName.indexOf(`.${CONFIG_SEGMENT}`);
    if (nested === -1) return null;
    start = nested + 1;
  }
  const qualifier = splitName.slice(start + CONFIG_SEGMENT.length);
  return qualifier === "" ? null : qualifier;
};

const reportMember = (
  member: AndroidContainerMemberObservation,
): AndroidContainerMember => ({
  entry: member.entry,
  bytes: member.bytes,
  sha256: member.sha256,
  package_name: member.manifest.packageName,
  split_name: member.manifest.splitName,
  config_for_split: member.manifest.configForSplit,
  is_feature_split: member.manifest.isFeatureSplit,
  version_code: member.manifest.versionCode,
  config_qualifier: configQualifier(member.manifest.splitName),
});

/**
 * Identify the base APK as the only member whose manifest declares no split
 * name. File names are never consulted, so a renamed base is still found and a
 * second unsplit APK makes the selection ambiguous instead of guessed.
 */
export const selectAndroidContainerBase = (
  members: readonly AndroidContainerMemberObservation[],
): Result<
  {
    readonly base: AndroidContainerMember;
    readonly splits: readonly AndroidContainerMember[];
  },
  AndroidContainerBaseFailure
> => {
  const bases = members.filter((member) => member.manifest.splitName === null);
  if (bases.length === 0)
    return err({
      reason: "missing_base",
      message: `No APK declares itself as the base: all ${String(members.length)} APK members declare a split name (${members
        .slice(0, 8)
        .map((member) => member.entry)
        .join(", ")}${members.length > 8 ? ", ..." : ""}).`,
    });
  if (bases.length > 1)
    return err({
      reason: "multiple_bases",
      message: `${String(bases.length)} APKs declare no split name, so the base is ambiguous: ${bases
        .slice(0, 8)
        .map((member) => member.entry)
        .join(
          ", ",
        )}${bases.length > 8 ? ", ..." : ""}. Select one APK file directly.`,
    });
  const [base] = bases;
  return ok({
    base: reportMember(base!),
    splits: members.filter((member) => member !== base).map(reportMember),
  });
};

/** Explicit coverage limits for an analysis of a container's base APK. */
export const androidInputContainerLimitations = (
  container: AndroidInputContainer,
): readonly string[] => {
  const { base, splits } = container;
  const source =
    container.kind === "zip"
      ? `split APK container ${container.path}`
      : `split APK directory ${container.path}`;
  const features = splits.filter((split) => split.is_feature_split === true);
  const foreign = splits.filter(
    (split) =>
      split.package_name !== null &&
      base.package_name !== null &&
      split.package_name !== base.package_name,
  );
  return [
    splits.length === 0
      ? `Analyzed base APK ${base.entry} (sha256 ${base.sha256}) from ${source}; the container holds no split APKs.`
      : `Analyzed only base APK ${base.entry} (sha256 ${base.sha256}) from ${source}; ${String(splits.length)} split APK${splits.length === 1 ? " was" : "s were"} not analyzed, so their code, resources and native libraries are absent from this result.`,
    ...(splits.length === 0
      ? []
      : [
          "The manifest and any entry_points or deep links derived from it come only from the base APK manifest; components declared in split manifests are absent.",
        ]),
    ...(features.length === 0
      ? []
      : [
          `Feature splits carry separately loaded code and resources that were not analyzed: ${features.map((split) => split.entry).join(", ")}.`,
        ]),
    ...foreign.map(
      (split) =>
        `Split ${split.entry} declares package ${String(split.package_name)}, not the base package ${String(base.package_name)}.`,
    ),
    ...(container.other_entry_count === 0
      ? []
      : [
          `${String(container.other_entry_count)} non-APK container entr${container.other_entry_count === 1 ? "y was" : "ies were"} not analyzed.`,
        ]),
    "Split membership is read from manifest declarations; APK signatures and split install compatibility were not verified.",
  ];
};
