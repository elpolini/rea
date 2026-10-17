/** Close split-container admission and its provider, attempting both. */
export const closeAndroidAnalysis = async (
  inputs: { close(): Promise<void> },
  provider: { close(): Promise<void> },
): Promise<void> => {
  const results = await Promise.allSettled([inputs.close(), provider.close()]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Android analysis cleanup failed");
};
