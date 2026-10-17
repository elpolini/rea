import type { AndroidAnalysisPort } from "./AndroidAnalysisPort.js";
import {
  AndroidInputContainerAdmission,
  type AndroidContainerLease,
} from "./AndroidInputContainerAdmission.js";
import {
  containerCleanupLimitation,
  withContainerCleanup,
  withContainerLease,
  withInputContainer,
} from "./AndroidInputContainerOutcome.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import { parseBinaryTarget } from "../BinaryTargetResolver.js";
import {
  androidRequestSchema,
  type AndroidOperation,
  type AndroidRequest,
} from "../../domain/android/androidAnalysis.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import type { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

interface AndroidObservation {
  readonly target: BinaryTarget;
  readonly execution: AnalysisExecution;
}

/** Shared CLI/MCP admission, execution and Evidence composition for Android. */
export class AndroidAnalysisService {
  constructor(
    readonly provider: AndroidAnalysisPort,
    /** Owns split-container extraction; close it with the provider. */
    readonly inputs: AndroidInputContainerAdmission = new AndroidInputContainerAdmission(),
  ) {}

  /** Inspect a caller-selected APK and retain producing-provider provenance inline. */
  async execute(
    operation: AndroidOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    const request = androidRequestSchema.safeParse({ operation, input });
    if (!request.success)
      return err(new AnalysisInputError(operation, { cause: request.error }));
    const admitted = await this.inputs.admit(request.data.input.path, {
      operation,
      providerId: "jadx",
      signal: options?.signal,
    });
    if (!admitted.ok) return admitted;
    if (admitted.value.kind === "apk") {
      const observed = await this.#observe(
        request.data,
        request.data.input.path,
        undefined,
        options,
      );
      if (!observed.ok) return observed;
      return this.#complete(request.data, observed.value, undefined, options);
    }
    const lease = admitted.value;
    const { outcome, cleanup } = await withContainerLease(lease, () =>
      this.#observe(request.data, lease.apkPath, lease, options),
    );
    if (!outcome.ok)
      return err(withContainerCleanup(outcome.error, cleanup, operation));
    return this.#complete(
      request.data,
      outcome.value,
      { lease, cleanup },
      options,
    );
  }

  /** Analyze one admitted APK file, bound to the digest its admission observed. */
  async #observe(
    request: AndroidRequest,
    apkPath: string,
    lease: AndroidContainerLease | undefined,
    options: ExecutionOptions | undefined,
  ): Promise<Result<AndroidObservation, AnalysisError>> {
    const target = await parseBinaryTarget(
      apkPath,
      options?.signal === undefined ? {} : { signal: options.signal },
    );
    if (!target.ok) return target;
    if (lease !== undefined && target.value.sha256 !== lease.apkSha256)
      return err(
        new AnalysisArtifactChangedError(
          request.operation,
          apkPath,
          `Base APK ${lease.container.base.entry} changed after container admission; retry against a stable container.`,
        ),
      );
    const executed = await this.provider.execute(
      target.value,
      request,
      options,
    );
    if (!executed.ok) return executed;
    return ok({ target: target.value, execution: executed.value });
  }

  /** Compose Evidence; a container binds it to the file the caller selected. */
  #complete(
    request: AndroidRequest,
    { target, execution }: AndroidObservation,
    container:
      | {
          readonly lease: AndroidContainerLease;
          readonly cleanup: ProviderCleanupError | undefined;
        }
      | undefined,
    options: ExecutionOptions | undefined,
  ): Result<Evidence, AnalysisError> {
    const result =
      container === undefined
        ? ok(execution.result)
        : withInputContainer(
            request.operation,
            execution.result,
            container.lease.container,
          );
    if (!result.ok)
      return err(
        withContainerCleanup(
          result.error,
          container?.cleanup,
          request.operation,
        ),
      );
    return completeProviderEvidence(
      createEvidence(
        container?.lease.subject ?? execution.subject ?? target,
        execution.provider,
        {
          operation: request.operation,
          parameters: jsonObjectSchema.parse(request.input),
          result: result.value,
          rawResult: execution.rawResult,
          limitations: [
            ...execution.limitations,
            ...(container?.lease.limitations ?? []),
            ...(container?.cleanup === undefined
              ? []
              : [containerCleanupLimitation(container.cleanup)]),
          ],
          locations: execution.locations,
          confidence:
            request.operation === "inspect_android_method"
              ? "derived"
              : "observed",
        },
      ),
      options?.signal,
    );
  }
}
