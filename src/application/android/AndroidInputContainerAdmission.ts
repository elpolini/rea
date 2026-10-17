import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { classifyBinaryTargetFilesystemFailure } from "../BinaryTargetResolver.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  androidInputContainerLimitations,
  selectAndroidContainerBase,
  type AndroidInputContainer,
} from "../../domain/android/androidInputContainer.js";
import type { EvidenceSubjectTarget } from "../../domain/evidence.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { regularFileCancellation } from "../../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../../filesystem/RegularFile.js";
import { PrivateRuntimeRootUnavailableError } from "../../process/PrivateRuntimeRootUnavailableError.js";
import {
  AndroidContainerRefusal,
  CONTAINER_METADATA_READ_MAX_BYTES,
  containerCandidateKind,
  readDirectoryContainer,
  readZipContainer,
  type ResolvedAndroidContainer,
} from "./AndroidInputContainerReader.js";
import {
  AndroidContainerResources,
  type ContainerCleanupFailure,
} from "./AndroidInputContainerResources.js";

/** Caller operation and provider family that own a container admission. */
export interface AndroidInputAdmissionContext {
  readonly operation: string;
  readonly providerId: string;
  readonly signal?: AbortSignal | undefined;
}

/** Local identity of the file REA admitted for a resolved container. */
export interface AndroidContainerSubject extends EvidenceSubjectTarget {
  readonly bytes: number;
}

/**
 * A resolved split container whose base APK a provider may analyze until the
 * lease is released. The base file is either REA's private extraction or the
 * caller's own file inside a selected directory.
 */
export interface AndroidContainerLease {
  readonly kind: "container";
  readonly apkPath: string;
  readonly apkSha256: string;
  /** The ZIP container, or the base APK file inside a selected directory. */
  readonly subject: AndroidContainerSubject;
  readonly container: AndroidInputContainer;
  readonly limitations: readonly string[];
  /** Remove owned extraction; a failure stays retained for close(). */
  release(): Promise<ProviderCleanupError | undefined>;
}

/** Either an input the provider admits unchanged, or a resolved container. */
export type AndroidInputAdmission =
  | { readonly kind: "apk" }
  | AndroidContainerLease;

const errorCode = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const code: unknown = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
};

const pathIssue = (
  operation: string,
  message: string,
  cause: unknown,
): AnalysisInputError =>
  new AnalysisInputError(operation, { cause, userMessage: message }, [
    { path: ["path"], reason: "invalid_value", message },
  ]);

/** Map one container failure to the shared typed error algebra. */
const containerFailure = (
  cause: unknown,
  path: string,
  { operation, providerId, signal }: AndroidInputAdmissionContext,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const cancellation = regularFileCancellation(cause);
  if (cancellation !== undefined)
    return new AnalysisCancelledError(operation, {
      cause: cancellation.reason,
    });
  if (
    signal?.aborted === true ||
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
  )
    return new AnalysisCancelledError(operation, {
      cause: signal?.reason ?? cause,
    });
  if (cause instanceof AndroidContainerRefusal)
    return cause.kind === "limit"
      ? new AnalysisResourceConstraintError(
          operation,
          "capacity",
          cause.message,
          cause.limits,
          { cause },
        )
      : pathIssue(operation, cause.message, cause);
  if (cause instanceof ArtifactReaderFailure)
    return cause.reason === "limit"
      ? new AnalysisResourceConstraintError(
          operation,
          "memory",
          cause.message,
          { max_metadata_read_bytes: CONTAINER_METADATA_READ_MAX_BYTES },
          { cause },
        )
      : pathIssue(
          operation,
          `Split APK container ${path} is unreadable: ${cause.message}`,
          cause,
        );
  if (cause instanceof RegularFileChangedError)
    return new AnalysisArtifactChangedError(
      operation,
      cause.path,
      cause.message,
      {
        cause,
      },
    );
  if (cause instanceof NonRegularFileReadError)
    return pathIssue(operation, cause.message, cause);
  if (cause instanceof PrivateRuntimeRootUnavailableError)
    return new AnalysisCapabilityUnavailableError(
      providerId,
      operation,
      cause.message,
      { cause, retryable: cause.retryable },
    );
  return (
    filesystemFailure(cause, path, operation) ??
    new AnalysisProtocolError(
      `Split APK container admission failed for ${path}`,
      { cause },
    )
  );
};

/** Classify a host filesystem failure while reading or extracting a container. */
const filesystemFailure = (
  cause: unknown,
  path: string,
  operation: string,
): AnalysisError | undefined => {
  const code = errorCode(cause);
  if (code === undefined || code.startsWith("ERR_")) return undefined;
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(operation, path, code, { cause });
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG")
    return new AnalysisResourceConstraintError(
      operation,
      "file-size",
      `Split APK container extraction failed (${code}): ${(cause as Error).message}`,
      { system_code: code },
      { cause },
    );
  // A selected file or member that disappears or cannot be read is reported as
  // the target resolver reports it for a standalone APK.
  return classifyBinaryTargetFilesystemFailure(path, cause);
};

const reportContainer = (
  resolved: ResolvedAndroidContainer,
  operation: string,
): Result<
  { readonly container: AndroidInputContainer; readonly basePath: string },
  AnalysisError
> => {
  const selected = selectAndroidContainerBase(resolved.members);
  if (!selected.ok)
    return err(
      pathIssue(
        operation,
        `${selected.error.message} Container: ${resolved.path}`,
        undefined,
      ),
    );
  const { base, splits } = selected.value;
  const basePath = resolved.members.find(
    (member) => member.entry === base.entry,
  )!.localPath;
  return ok({
    basePath,
    container: {
      path: resolved.path,
      kind: resolved.kind,
      sha256: resolved.sha256,
      bytes: resolved.bytes,
      base,
      splits: [...splits],
      other_entry_count: resolved.otherEntryCount,
    },
  });
};

/**
 * Resolves split APK containers (.apks/.xapk ZIPs and directories of base and
 * split APKs) at the Android input-admission boundary. A standalone APK, or
 * anything this owner cannot classify as a container, passes through to the
 * provider unchanged. Extraction workspaces are owned here; cleanup that
 * cannot be confirmed is retained, blocks later admission, and is retried on
 * the next admission and on close.
 */
export class AndroidInputContainerAdmission {
  readonly #retained = new Map<
    AndroidContainerResources,
    ProviderCleanupError
  >();
  readonly #active = new Set<Promise<unknown>>();
  #closing = false;

  /** Resolve one caller-selected path; the caller must release a lease. */
  admit(
    path: string,
    context: AndroidInputAdmissionContext,
  ): Promise<Result<AndroidInputAdmission, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(new AnalysisCancelledError(context.operation)),
      );
    return this.#track(this.#admit(path, context));
  }

  /** Join active admissions and leases, then retry retained cleanup. */
  async close(): Promise<void> {
    this.#closing = true;
    while (this.#active.size > 0) await Promise.all(this.#active);
    const unresolved = await this.#retryRetained();
    if (unresolved !== undefined) throw unresolved;
  }

  async #admit(
    path: string,
    context: AndroidInputAdmissionContext,
  ): Promise<Result<AndroidInputAdmission, AnalysisError>> {
    const { operation, signal } = context;
    if (signal?.aborted === true)
      return err(
        new AnalysisCancelledError(operation, { cause: signal.reason }),
      );
    const candidate = absoluteCallerPath(path);
    const kind = await containerCandidateKind(candidate);
    if (kind === undefined) return ok({ kind: "apk" });
    const blocked = await this.#retryRetained();
    if (blocked !== undefined) return err(blocked);
    const resources = new AndroidContainerResources();
    let outcome: Result<AndroidInputAdmission, AnalysisError>;
    try {
      const resolved =
        kind === "directory"
          ? await readDirectoryContainer(candidate, { resources, signal })
          : await readZipContainer(candidate, { resources, signal });
      if (resolved === undefined) outcome = ok({ kind: "apk" });
      else {
        const reported = reportContainer(resolved, operation);
        if (reported.ok)
          return ok(this.#lease(resolved, reported.value, resources, context));
        outcome = reported;
      }
    } catch (cause: unknown) {
      outcome = err(containerFailure(cause, candidate, context));
    }
    const cleanup = await this.#release(resources, context);
    if (cleanup === undefined) return outcome;
    if (outcome.ok) return err(cleanup);
    return err(
      analysisErrorWithCleanupFailure(
        outcome.error,
        cleanup,
        operation,
      ).bindCleanupDependencies([cleanup]),
    );
  }

  #lease(
    resolved: ResolvedAndroidContainer,
    reported: {
      readonly container: AndroidInputContainer;
      readonly basePath: string;
    },
    resources: AndroidContainerResources,
    context: AndroidInputAdmissionContext,
  ): AndroidContainerLease {
    const { container, basePath } = reported;
    let releasing: Promise<ProviderCleanupError | undefined> | undefined;
    let finish: () => void = () => {};
    // The lease stays active until its owner releases it.
    void this.#track(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    return {
      kind: "container",
      apkPath: basePath,
      apkSha256: container.base.sha256,
      subject:
        resolved.kind === "zip"
          ? {
              path: resolved.path,
              sha256: resolved.sha256!,
              format: resolved.format ?? "zip",
              bytes: resolved.bytes!,
            }
          : {
              path: basePath,
              sha256: container.base.sha256,
              format: "apk",
              bytes: container.base.bytes,
            },
      container,
      limitations: androidInputContainerLimitations(container),
      release: () => {
        releasing ??= this.#release(resources, context).finally(finish);
        return releasing;
      },
    };
  }

  async #release(
    resources: AndroidContainerResources,
    { operation, providerId }: AndroidInputAdmissionContext,
  ): Promise<ProviderCleanupError | undefined> {
    const failure = await resources.release();
    if (failure === undefined) return undefined;
    const error = cleanupError(providerId, operation, failure);
    this.#retained.set(resources, error);
    return error;
  }

  /** Retry retained cleanup; resolve each originating error on success. */
  async #retryRetained(): Promise<ProviderCleanupError | undefined> {
    const failures: ContainerCleanupFailure[] = [];
    let operation = "close";
    let providerId = "rea";
    for (const [resources, original] of this.#retained) {
      const failure = await resources.release();
      if (failure === undefined) {
        this.#retained.delete(resources);
        original.resolveCleanup();
        continue;
      }
      failures.push(failure);
      operation = original.operation;
      providerId = original.providerId;
    }
    if (failures.length === 0) return undefined;
    return cleanupError(providerId, operation, {
      resources: failures.flatMap((failure) => failure.resources),
      reason: failures.map((failure) => failure.reason).join("; "),
      causes: failures.flatMap((failure) => failure.causes),
    });
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#active.add(settled);
    void settled.then(() => this.#active.delete(settled));
    return operation;
  }
}

const cleanupError = (
  providerId: string,
  operation: string,
  failure: ContainerCleanupFailure,
): ProviderCleanupError =>
  new ProviderCleanupError(
    providerId,
    failure.resources,
    { reason: `Split APK container cleanup failed: ${failure.reason}` },
    {
      operation,
      cause: new AggregateError(
        failure.causes,
        "Split APK container cleanup failed",
      ),
      remediationAction:
        "Close the files named in the cleanup resources, then retry; REA retries the removal on the next Android admission and on close.",
    },
  );
