/** Stable failure tags reported by the Windows native restore command. */
export type WindowsNativeRestoreErrorCode =
  | "invalid_arguments"
  | "checkout_identity"
  | "not_published"
  | "npm_failed"
  | "registry_metadata"
  | "pack_result"
  | "integrity_mismatch"
  | "malformed_tarball"
  | "package_identity_mismatch"
  | "missing_artifact"
  | "manifest_invalid"
  | "version_mismatch"
  | "architecture_mismatch"
  | "digest_mismatch"
  | "artifact_invalid"
  | "unsafe_destination"
  | "existing_artifact_differs"
  | "native_source_differs"
  | "destination_in_use";

/** Expected restore failure with a stable tag for callers and tests. */
export class WindowsNativeRestoreError extends Error {
  readonly code: WindowsNativeRestoreErrorCode;
  details: Readonly<Record<string, unknown>>;
  constructor(
    code: WindowsNativeRestoreErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  );
}

/** Command-line help for the explicit, manual restore command. */
export const RESTORE_USAGE: string;

/** Parse the command's arguments; each flag may appear once. */
export function parseRestoreArguments(arguments_: readonly string[]): {
  readonly help: boolean;
  readonly replace: boolean;
  readonly acceptReleaseArtifact: boolean;
};

/** The manifest contract shared with `windowsNativeManifestSchema`. */
export interface WindowsNativeManifest {
  readonly packageVersion: string;
  readonly platform: "win32";
  readonly architecture: "x64";
  readonly abiVersion: 1;
  readonly nodeApiVersion: 8;
  readonly artifact: "rea-windows-x64.node";
  readonly artifactSha256: string;
}

/** Admit a packaged manifest with the loader's contract. */
export function parseWindowsNativeManifest(
  value: unknown,
  version: string,
): WindowsNativeManifest;

/** Runs one npm command and resolves with its standard output. */
export type NpmRunner = (
  arguments_: readonly string[],
) => Promise<{ readonly stdout: string }>;

/**
 * Runs one git command in the checkout root and resolves with its standard
 * output. A rejection carries the exit status or spawn errno in `code` and
 * git's diagnostic in `stderr`.
 */
export type GitRunner = (
  arguments_: readonly string[],
) => Promise<{ readonly stdout: string }>;

/** Writes one verified file into place atomically. */
export type ArtifactWriter = (path: string, bytes: Buffer) => Promise<void>;

/** One commit that changed the compared native source after the release tag. */
export interface NativeSourceCommit {
  readonly commit: string;
  readonly subject: string;
}

/**
 * How this checkout's native source compares with the release tag of its
 * package.json version. `unknown` keeps the reason Git could not establish it.
 */
export type NativeSourceComparison =
  | { readonly state: "matches"; readonly tag: string }
  | {
      readonly state: "differs";
      readonly tag: string;
      readonly commits: readonly NativeSourceCommit[];
      /** Files that differ between the tag and HEAD. */
      readonly files: readonly string[];
      /** `git status --porcelain` lines for uncommitted changes. */
      readonly uncommitted: readonly string[];
    }
  | {
      readonly state: "unknown";
      readonly tag: string;
      readonly reason: string;
    };

/** Compare the checkout's native source with `rea-agents-<version>`. */
export function compareNativeSourceWithRelease(
  git: GitRunner,
  version: string,
): Promise<NativeSourceComparison>;

/** What the restore verified and what it changed in the checkout. */
export interface WindowsNativeRestoreReport {
  readonly spec: string;
  readonly registryIntegrity: string;
  readonly tarball: { readonly filename: string; readonly bytes: number };
  readonly manifest: WindowsNativeManifest;
  readonly artifact: {
    readonly bytes: number;
    readonly sha256: string;
    readonly image: string;
  };
  readonly files: readonly {
    readonly path: string;
    readonly action: "created" | "replaced" | "unchanged";
  }[];
  /** Present when the private download directory could not be removed. */
  readonly retainedDownload?: string;
  /** Native source comparison established before the download. */
  readonly sourceComparison: NativeSourceComparison;
}

/** Restore a source checkout's Windows native controls from its exact release. */
export function restoreWindowsNative(options: {
  readonly root: string;
  readonly replace?: boolean;
  /** Install the release addon even when the checkout's native source differs. */
  readonly acceptReleaseArtifact?: boolean;
  readonly npm?: NpmRunner;
  readonly git?: GitRunner;
  readonly write?: ArtifactWriter;
  readonly temporaryParent?: string;
}): Promise<WindowsNativeRestoreReport>;

/** Describe exactly what was verified and what changed in the checkout. */
export function formatRestoreReport(report: WindowsNativeRestoreReport): string;

/** `warning:` lines for an accepted or unknown comparison and a retained download. */
export function formatRestoreWarnings(
  report: WindowsNativeRestoreReport,
): string;
