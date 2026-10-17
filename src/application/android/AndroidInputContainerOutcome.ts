import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { AndroidInputContainer } from "../../domain/android/androidInputContainer.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { AndroidContainerLease } from "./AndroidInputContainerAdmission.js";

/** Run provider work while a container lease is held, then join its release. */
export const withContainerLease = async <Value>(
  lease: AndroidContainerLease,
  run: () => Promise<Value>,
): Promise<{
  readonly outcome: Value;
  readonly cleanup: ProviderCleanupError | undefined;
}> => {
  let outcome: Value;
  try {
    outcome = await run();
  } catch (cause: unknown) {
    await lease.release();
    throw cause;
  }
  // Joined before completion is classified, so a cancelled caller never
  // receives its result while the owned extraction is still being removed.
  return { outcome, cleanup: await lease.release() };
};

/** Attach the resolved container to a provider's normalized observation. */
export const withInputContainer = (
  operation: string,
  result: JsonValue,
  container: AndroidInputContainer,
): Result<JsonValue, AnalysisError> =>
  result !== null && typeof result === "object" && !Array.isArray(result)
    ? ok({ ...result, input_container: container })
    : err(
        new AnalysisOutputError(
          operation,
          "Provider result is not an object that can carry its input container",
        ),
      );

/** Report retained extraction cleanup on an otherwise completed observation. */
export const containerCleanupLimitation = (
  cleanup: ProviderCleanupError,
): string =>
  `The split APK container workspace could not be removed and stays owned for a cleanup retry: ${cleanup.cleanupResources.join(", ")}`;

/** Preserve a primary failure together with unresolved container cleanup. */
export const withContainerCleanup = (
  error: AnalysisError,
  cleanup: ProviderCleanupError | undefined,
  operation: string,
): AnalysisError =>
  cleanup === undefined
    ? error
    : analysisErrorWithCleanupFailure(
        error,
        cleanup,
        operation,
      ).bindCleanupDependencies([
        cleanup,
        ...(error.cleanupIncomplete ? [error] : []),
      ]);
