import type { ApktoolResourceAnalysisPort } from "./ApktoolResourceAnalysisPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import {
  AndroidInputContainerAdmission,
  type AndroidContainerLease,
} from "../android/AndroidInputContainerAdmission.js";
import {
  containerCleanupLimitation,
  withContainerCleanup,
  withContainerLease,
} from "../android/AndroidInputContainerOutcome.js";
import {
  apktoolRequestSchema,
  apktoolResultSchemas,
  type ApktoolOperation,
} from "../../domain/apktool/apktoolResourceAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import type { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  completeProviderEvidence,
  executeProviderOperation,
} from "../ProviderOperationExecution.js";

const DECODE = "decode_android_resources";

/** Shared CLI/MCP admission, execution, and Evidence composition for Apktool. */
export class ApktoolResourceAnalysisService {
  constructor(
    readonly provider: ApktoolResourceAnalysisPort,
    /** Owns split-container extraction; close it with the provider. */
    readonly inputs: AndroidInputContainerAdmission = new AndroidInputContainerAdmission(),
  ) {}

  /** Run one caller-selected Apktool request and retain target identity inline. */
  async execute(
    operation: ApktoolOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const direct = () =>
      executeProviderOperation(
        operation,
        input,
        options,
        apktoolRequestSchema,
        this.provider,
        "observed",
      );
    if (operation !== DECODE) return direct();
    if (options?.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    const request = apktoolRequestSchema.safeParse({ operation, input });
    if (!request.success)
      return err(new AnalysisInputError(operation, { cause: request.error }));
    if (request.data.operation !== DECODE) return direct();
    const admitted = await this.inputs.admit(request.data.input.path, {
      operation,
      providerId: "apktool",
      signal: options?.signal,
    });
    if (!admitted.ok) return admitted;
    if (admitted.value.kind === "apk") return direct();
    const lease = admitted.value;
    const selected = request.data.input;
    const { outcome, cleanup } = await withContainerLease(lease, () =>
      this.provider.execute(
        { operation: DECODE, input: { ...selected, path: lease.apkPath } },
        options,
      ),
    );
    const composed = outcome.ok
      ? bindDecodedContainer(outcome.value, lease, cleanup)
      : outcome;
    if (!composed.ok)
      return err(withContainerCleanup(composed.error, cleanup, operation));
    const execution = composed.value;
    // The file REA admitted is the subject, as in the JADX family: the ZIP
    // container, or the base APK file inside a selected directory.
    return completeProviderEvidence(
      createEvidence(lease.subject, execution.provider, {
        operation,
        parameters: jsonObjectSchema.parse(selected),
        result: execution.result,
        rawResult: execution.rawResult,
        limitations: execution.limitations,
        locations: execution.locations,
        confidence: "observed",
      }),
      options?.signal,
    );
  }
}

/**
 * Report the decode of a container's base APK against the file the caller
 * selected. The provider read REA's admitted base bytes; its digest must match
 * the member the container resolution observed.
 */
const bindDecodedContainer = (
  execution: AnalysisExecution,
  lease: AndroidContainerLease,
  cleanup: ProviderCleanupError | undefined,
): Result<AnalysisExecution, AnalysisError> => {
  const decoded = apktoolResultSchemas[DECODE].safeParse(execution.result);
  if (!decoded.success)
    return err(
      new AnalysisOutputError(
        DECODE,
        "Apktool decode result violated its contract",
        { cause: decoded.error },
      ),
    );
  if (decoded.data.target.sha256 !== lease.apkSha256)
    return err(
      new AnalysisArtifactChangedError(
        DECODE,
        lease.apkPath,
        `Base APK ${lease.container.base.entry} changed after container admission; retry against a stable container.`,
      ),
    );
  return ok({
    ...execution,
    result: {
      ...decoded.data,
      target: {
        path: lease.subject.path,
        bytes: lease.subject.bytes,
        sha256: lease.subject.sha256,
      },
      input_container: lease.container,
    },
    limitations: [
      ...execution.limitations,
      ...lease.limitations,
      ...(cleanup === undefined ? [] : [containerCleanupLimitation(cleanup)]),
    ],
  });
};
