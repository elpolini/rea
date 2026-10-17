import * as fileSystem from "node:fs/promises";

import { z } from "zod";

import { err, ok, type Result } from "../domain/result.js";
import type { DoctorCheck } from "./Doctor.js";

/** Doctor check name for the temporary directory's free space. */
export const TEMPORARY_SPACE_CHECK = "temporary-space";

/**
 * Free space below which doctor warns about the temporary directory: 1 GiB.
 *
 * REA providers create their working state under `os.tmpdir()`. JADX and
 * Apktool first copy the APK there, and Apktool then decodes it beside that
 * copy with `--no-src`, keeping dex files raw, so a decode needs roughly two to
 * three times the APK size. Ghidra keeps its session project and redirected
 * cache there, and artifact extraction defaults there. One GiB covers those
 * runs for typical targets of a few hundred MiB and matches the reserve REA's
 * large-output verification requires. Larger targets need proportionally more,
 * so the warning is an early signal, not a guarantee.
 */
export const TEMPORARY_SPACE_WARNING_BYTES = 1024 ** 3;

/** The `statfs` fields doctor reads; `bavail` counts blocks the caller may use. */
interface StorageStatistics {
  readonly bsize: bigint | number;
  readonly bavail: bigint | number;
}

/** Read volume statistics for a path, as `fs.statfs` does. */
export type StorageStatisticsReader = (
  path: string,
) => Promise<StorageStatistics>;

/** Why the available space of a location could not be established. */
interface StorageSpaceFailure {
  readonly reason: "statfs_unavailable" | "statfs_failed" | "statfs_invalid";
  readonly code?: string;
  readonly message: string;
}

/** Read-only free-space observation for the temporary directory. */
export interface TemporaryStorageObservation {
  readonly path: string;
  readonly space: Result<
    { readonly availableBytes: bigint },
    StorageSpaceFailure
  >;
}

// Some runtimes that implement Node.js APIs omit statfs; reading the
// namespace keeps that absence observable instead of failing module linking.
const runtimeStatfs = (fileSystem as Partial<typeof fileSystem>).statfs;

/** The runtime's `fs.statfs` with exact counters, when the runtime has one. */
export const systemStorageStatistics: StorageStatisticsReader | undefined =
  runtimeStatfs === undefined
    ? undefined
    : (path) => runtimeStatfs(path, { bigint: true });

const UNAVAILABLE_CODES = new Set([
  "ENOSYS",
  "ENOTSUP",
  "ERR_METHOD_NOT_IMPLEMENTED",
  "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
]);

const blockCount = z
  .union([z.bigint().nonnegative(), z.number().int().nonnegative()])
  .transform((value) => BigInt(value));

const storageStatisticsSchema = z.object({
  bsize: blockCount.refine(
    (value) => value > 0n,
    "block size must be positive",
  ),
  bavail: blockCount,
});

/** Observe free space without creating, opening, or changing any file. */
export const observeTemporaryStorage = async (
  path: string,
  readStatistics: StorageStatisticsReader | undefined,
): Promise<TemporaryStorageObservation> => {
  if (readStatistics === undefined)
    return {
      path,
      space: err({
        reason: "statfs_unavailable",
        message: "This JavaScript runtime does not provide fs.statfs.",
      }),
    };
  let statistics: unknown;
  try {
    statistics = await readStatistics(path);
  } catch (cause: unknown) {
    const code = errorCode(cause);
    return {
      path,
      space: err({
        reason:
          code !== undefined && UNAVAILABLE_CODES.has(code)
            ? "statfs_unavailable"
            : "statfs_failed",
        ...(code === undefined ? {} : { code }),
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    };
  }
  const parsed = storageStatisticsSchema.safeParse(statistics);
  if (!parsed.success)
    return {
      path,
      space: err({
        reason: "statfs_invalid",
        message: `statfs returned unusable block counts: ${parsed.error.issues
          .map(
            ({ path: field, message }) =>
              `${field.length === 0 ? "result" : field.map(String).join(".")}: ${message}`,
          )
          .join("; ")}`,
      }),
    };
  return {
    path,
    space: ok({ availableBytes: parsed.data.bavail * parsed.data.bsize }),
  };
};

/**
 * Classify the temporary directory's free space. The check never fails
 * readiness: low space is a `warning` and an unreadable volume stays `unknown`.
 */
export const temporaryStorageCheck = ({
  path,
  space,
}: TemporaryStorageObservation): DoctorCheck => {
  const threshold = formatBytes(BigInt(TEMPORARY_SPACE_WARNING_BYTES));
  if (!space.ok) {
    const { reason, code, message } = space.error;
    return {
      name: TEMPORARY_SPACE_CHECK,
      ok: true,
      classification: "unknown",
      detail: `Available space in ${path} could not be read (${code ?? reason}).`,
      details: {
        path,
        reason,
        ...(code === undefined ? {} : { code }),
        message,
        warning_threshold_bytes: TEMPORARY_SPACE_WARNING_BYTES,
      },
      remediation:
        reason === "statfs_failed"
          ? `Check that ${path} exists and is accessible, or point TMPDIR (TEMP and TMP on Windows) at an existing directory, then rerun rea doctor.`
          : `Check the free space of ${path} with operating system tools; REA providers need about ${threshold} there for typical targets.`,
    };
  }
  const available = space.value.availableBytes;
  const details = {
    path,
    available_bytes: Number(available),
    warning_threshold_bytes: TEMPORARY_SPACE_WARNING_BYTES,
  };
  if (available >= BigInt(TEMPORARY_SPACE_WARNING_BYTES))
    return {
      name: TEMPORARY_SPACE_CHECK,
      ok: true,
      classification: "healthy",
      detail: `${formatBytes(available)} available in ${path}.`,
      details,
    };
  return {
    name: TEMPORARY_SPACE_CHECK,
    ok: true,
    classification: "warning",
    detail: `Only ${formatBytes(available)} available in ${path}; REA providers create their workspaces there and warn below ${threshold}.`,
    details,
    remediation: `Free space on the volume that holds ${path}, or point TMPDIR (TEMP and TMP on Windows) at a directory on a volume with at least ${threshold} available, then restart REA or the agent client that starts it.`,
  };
};

const KIBIBYTE = 1024n;
const MEBIBYTE = KIBIBYTE ** 2n;
const GIBIBYTE = KIBIBYTE ** 3n;

/** Round down so a reported amount never overstates the available space. */
const formatBytes = (bytes: bigint): string => {
  if (bytes < MEBIBYTE) return `${String(bytes)} bytes`;
  if (bytes < GIBIBYTE) return `${String(bytes / MEBIBYTE)} MiB`;
  const tenths = (bytes * 10n) / GIBIBYTE;
  return tenths % 10n === 0n
    ? `${String(tenths / 10n)} GiB`
    : `${String(tenths / 10n)}.${String(tenths % 10n)} GiB`;
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;
