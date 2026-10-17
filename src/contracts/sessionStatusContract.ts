import { z } from "zod";
import { isAbsolute } from "node:path";

import { localPathStringSchema } from "../domain/localPath.js";

/**
 * Caller-selected session-status delivery shared by MCP binary_session and
 * CLI capabilities/providers. Neither choice changes the observed session.
 */
export const sessionStatusDetailSchema = z
  .enum(["complete", "summary"])
  .default("complete")
  .describe(
    "complete (default) returns the complete status inventory. summary returns open/target state, the selected provider, provider candidate availability, server identity essentials, and capability/tool availability counts naming only unavailable or degraded entries with their remediation; request complete for diagnostics, effects, limitations and candidate capability sets.",
  );
export type SessionStatusDetail = z.output<typeof sessionStatusDetailSchema>;

/** Delivery detail plus optional expectations compared with the live session. */
export const binarySessionInputSchema = z.strictObject({
  detail: sessionStatusDetailSchema,
  expected_package_version: z.string().min(1).optional(),
  expected_catalog_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  expected_server_path: localPathStringSchema
    .refine(isAbsolute, {
      message:
        "expected_server_path must be an absolute local filesystem path (for example /opt/rea/dist/main.js)",
    })
    .describe(
      "Absolute local filesystem path expected for the running server; relative paths are rejected.",
    )
    .optional(),
});
