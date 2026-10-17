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
  | "existing_artifact_differs";

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

/** Parse the command's arguments; only `--replace` changes behavior. */
export function parseRestoreArguments(arguments_: readonly string[]): {
  readonly help: boolean;
  readonly replace: boolean;
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
}

/** Restore a source checkout's Windows native controls from its exact release. */
export function restoreWindowsNative(options: {
  readonly root: string;
  readonly replace?: boolean;
  readonly npm?: NpmRunner;
  readonly temporaryParent?: string;
}): Promise<WindowsNativeRestoreReport>;

/** Describe exactly what was verified and what changed in the checkout. */
export function formatRestoreReport(report: WindowsNativeRestoreReport): string;
