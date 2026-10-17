import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CATALOG_IDENTITY } from "../catalogIdentity.js";
import { err, ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";

/** Files setup installs from the bundle, relative to a skill root. */
export const MANAGED_SKILL_FILES = [
  "SKILL.md",
  "references/connection-and-recovery.md",
  "references/native-and-artifacts.md",
  "references/javascript-applications.md",
  "references/android-applications.md",
  "references/runtime-observation.md",
  "references/evidence-workflows.md",
] as const;

export const isManagedSkillManifest = (content: string): boolean =>
  content.startsWith(`---\nname: ${PRODUCT_IDENTITY.skillName}\n`) ||
  content.startsWith(`---\r\nname: ${PRODUCT_IDENTITY.skillName}\r\n`);

/** Version and catalog metadata declared by a managed skill manifest. */
export const skillManifestIdentity = (
  content: string,
): { readonly version: string | null; readonly toolCount: number | null } => {
  const toolCount = /^\s{2}tool_count:\s*(\d+)\s*$/mu.exec(content)?.[1];
  return {
    version: /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null,
    toolCount: toolCount === undefined ? null : Number.parseInt(toolCount, 10),
  };
};

/**
 * How the running package owns its generated skill bundle. A source checkout
 * carries the authored skill that `npm run build:cached` generates `skills/`
 * from; an installed package carries only the generated bundle.
 */
export type SkillBundleInstallation = "source_checkout" | "package" | "unknown";

/** The generated skill bundle that setup installs and doctor compares against. */
export interface SkillBundleSource {
  /** Package root containing `skills/<name>/`. */
  readonly packageRoot: string;
  readonly platform: NodeJS.Platform;
  /** Skill identity this runtime expects the bundle to declare. */
  readonly expected: {
    readonly version: string;
    readonly toolCount: number;
  };
}

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GENERATED_SKILL_DIRECTORY = join("skills", PRODUCT_IDENTITY.skillName);
const AUTHORED_SKILL_DIRECTORY = join(
  ".agents",
  "skills",
  PRODUCT_IDENTITY.skillName,
);
const AUTHORED_SKILL_DISPLAY = AUTHORED_SKILL_DIRECTORY.replaceAll("\\", "/");

/** The bundle shipped with, or generated for, this REA runtime. */
export const packagedSkillBundleSource = (
  platform: NodeJS.Platform = process.platform,
): SkillBundleSource => ({
  packageRoot: PACKAGE_ROOT,
  platform,
  expected: {
    version: PRODUCT_IDENTITY.skillVersion,
    toolCount: CATALOG_IDENTITY.counts.mcp_tools,
  },
});

/** Expected failure: the bundle setup would install cannot be used as-is. */
export class SkillBundleUnavailableError extends Error {
  readonly _tag = "SkillBundleUnavailableError";
  readonly state: "missing" | "stale" | "unreadable";
  readonly installation: SkillBundleInstallation;
  readonly path: string;
  readonly detail: string;
  /** Command or reinstall that restores the bundle for this installation. */
  readonly action: string;

  constructor(input: {
    readonly state: "missing" | "stale" | "unreadable";
    readonly installation: SkillBundleInstallation;
    readonly path: string;
    readonly detail: string;
    readonly action: string;
    readonly cause?: unknown;
  }) {
    super(
      `The ${input.installation === "source_checkout" ? "generated" : "packaged"} REA skill bundle is ${input.state}: ${input.detail}.`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.state = input.state;
    this.installation = input.installation;
    this.path = input.path;
    this.detail = input.detail;
    this.action = input.action;
  }

  get remediation(): string {
    return `${this.message} ${this.action}`;
  }
}

/** A usable bundle, with the command that refreshes installed copies from it. */
export interface SkillBundleReadiness {
  readonly installation: SkillBundleInstallation;
  readonly updateAction: string;
}

export type SkillBundleInspection = Result<
  SkillBundleReadiness,
  SkillBundleUnavailableError
>;

/** Every managed file of a verified bundle, read once for comparison or install. */
export interface CanonicalSkillBundle extends SkillBundleReadiness {
  readonly files: ReadonlyMap<string, Buffer>;
}

const isMissingPath = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const causeReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const skillBundleInstallation = async (
  packageRoot: string,
): Promise<SkillBundleInstallation> => {
  try {
    await access(join(packageRoot, AUTHORED_SKILL_DIRECTORY, "SKILL.md"));
    return "source_checkout";
  } catch (cause: unknown) {
    return isMissingPath(cause) ? "package" : "unknown";
  }
};

/**
 * `run-exclusive` builds need native Job Object ownership on Windows. Restoring
 * or building the artifacts keeps the locked build; the unlocked generators
 * remain the fallback.
 */
const windowsCheckoutBuildNote = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? " On Windows, `npm run build:cached` needs the native artifacts in native/windows/build: run `npm run restore:windows-native` (or build them with the Linux/MinGW lane in native/windows/README.md), then `npm run build:cached`. Without them, `npm run compile` and then `npm run artifacts:skills` also regenerate the bundle, but without the build lock, so run them only while no other build is running."
    : "";

const skillBundleAction = (
  source: SkillBundleSource,
  installation: SkillBundleInstallation,
): string => {
  const reinstall = `${PRODUCT_IDENTITY.registrationPackageSpecifier} with the package manager that owns ${source.packageRoot}`;
  switch (installation) {
    case "source_checkout":
      return `Regenerate it from ${AUTHORED_SKILL_DISPLAY}: run \`npm run build:cached\` in the source checkout ${source.packageRoot}, then run setup again.${windowsCheckoutBuildNote(source.platform)}`;
    case "package":
      return `Reinstall ${reinstall}, then run setup again.`;
    case "unknown":
      return `If ${source.packageRoot} is a source checkout, run \`npm run build:cached\` there to regenerate it from ${AUTHORED_SKILL_DISPLAY}; otherwise reinstall ${reinstall}. Then run setup again.${windowsCheckoutBuildNote(source.platform)}`;
  }
};

const skillUpdateAction = (
  source: SkillBundleSource,
  installation: SkillBundleInstallation,
): string =>
  installation === "source_checkout"
    ? `Run setup from the source checkout to update the installed REA skill: node "${join(source.packageRoot, "scripts", "rea.mjs")}" setup.`
    : "Run rea setup to update the installed REA skill.";

/** Read every managed file of the bundle and verify it belongs to this runtime. */
export const loadCanonicalSkillBundle = async (
  source: SkillBundleSource,
): Promise<Result<CanonicalSkillBundle, SkillBundleUnavailableError>> => {
  const installation = await skillBundleInstallation(source.packageRoot);
  const unavailable = (input: {
    readonly state: "missing" | "stale" | "unreadable";
    readonly path: string;
    readonly detail: string;
    readonly cause?: unknown;
  }) =>
    err(
      new SkillBundleUnavailableError({
        ...input,
        installation,
        action: skillBundleAction(source, installation),
      }),
    );
  const root = join(source.packageRoot, GENERATED_SKILL_DIRECTORY);
  const files = new Map<string, Buffer>();
  for (const relativePath of MANAGED_SKILL_FILES) {
    const path = join(root, relativePath);
    try {
      files.set(relativePath, await readFile(path));
    } catch (cause: unknown) {
      return isMissingPath(cause)
        ? unavailable({
            state: "missing",
            path,
            detail: `${path} does not exist`,
            cause,
          })
        : unavailable({
            state: "unreadable",
            path,
            detail: `${path} could not be read (${causeReason(cause)})`,
            cause,
          });
    }
  }
  const manifestPath = join(root, "SKILL.md");
  const manifest = files.get("SKILL.md")?.toString("utf8") ?? "";
  if (!isManagedSkillManifest(manifest))
    return unavailable({
      state: "stale",
      path: manifestPath,
      detail: `${manifestPath} does not declare the ${PRODUCT_IDENTITY.skillName} skill`,
    });
  const declared = skillManifestIdentity(manifest);
  if (
    declared.version !== source.expected.version ||
    declared.toolCount !== source.expected.toolCount
  )
    return unavailable({
      state: "stale",
      path: manifestPath,
      detail: `${manifestPath} declares skill version ${declared.version ?? "none"} with tool_count ${declared.toolCount ?? "none"}, but this REA runtime expects version ${source.expected.version} with tool_count ${String(source.expected.toolCount)}`,
    });
  return ok({
    installation,
    updateAction: skillUpdateAction(source, installation),
    files,
  });
};

/** One managed file of a loaded bundle. */
export const canonicalBundleFile = (
  bundle: CanonicalSkillBundle,
  relativePath: string,
): Buffer => {
  const content = bundle.files.get(relativePath);
  // The loader reads every managed file before returning a bundle.
  if (content === undefined)
    throw new TypeError(`Canonical skill bundle omitted ${relativePath}`);
  return content;
};

/**
 * Check the bundle setup would install before any setup mutation, and name
 * the owner-specific command that restores it.
 */
export const inspectSkillBundle = async (
  source: SkillBundleSource = packagedSkillBundleSource(),
): Promise<SkillBundleInspection> => {
  const bundle = await loadCanonicalSkillBundle(source);
  return bundle.ok
    ? ok({
        installation: bundle.value.installation,
        updateAction: bundle.value.updateAction,
      })
    : bundle;
};
