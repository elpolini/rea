import { expect } from "vitest";
import { z } from "zod";

import {
  binarySessionFullOutputSchema,
  binarySessionSummaryOutputSchema,
} from "../../src/contracts/toolOutputSchemaGroups.js";
import {
  providerCapabilitySet,
  sessionStatusSummaryCore,
} from "../../src/contracts/toolOutputSchemaPrimitives.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

// Both adapters receive the same caller-selected provider environment.
const environment = {
  REA_LOG_LEVEL: "silent",
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};

const cliSummarySchema = sessionStatusSummaryCore.extend({
  open: z.literal(false),
});
const cliFullSchema = z
  .object({
    open: z.literal(false),
    capabilities: z.array(providerCapabilitySet),
    server_identity: z
      .object({ server: z.object({ started_at: z.string() }).passthrough() })
      .passthrough(),
  })
  .passthrough();

/** A one-shot CLI process records its own start time; nothing else may differ. */
const withoutStartTime = (value: unknown): unknown => {
  const parsed = cliFullSchema.parse(value);
  return {
    ...parsed,
    server_identity: {
      ...parsed.server_identity,
      server: { ...parsed.server_identity.server, started_at: "<start>" },
    },
  };
};

cliTest(
  "returns full status by default and the same summary facts through CLI and MCP",
  async ({ cli }) => {
    const run = (arguments_: readonly string[]) =>
      cli.run({ arguments: [...arguments_, "--json"], environment });
    const byDefault = await run(["capabilities"]);
    const summary = await run(["capabilities", "--detail", "summary"]);
    for (const result of [byDefault, summary])
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const complete = cliFullSchema.parse(byDefault.json);
    expect(complete).not.toHaveProperty("detail");
    const cliSummary = cliSummarySchema.parse(summary.json);
    expect(cliSummary.capabilities.counts.providers).toBe(
      complete.capabilities.length,
    );
    expect(summary.stdout.length * 2).toBeLessThan(byDefault.stdout.length);

    const { call } = await connectLocalToolsMcp(environment);
    const mcpFull = binarySessionFullOutputSchema.parse(
      (await call("binary_session", {})).structuredContent,
    ).result;
    const mcpSummary = binarySessionSummaryOutputSchema.parse(
      (await call("binary_session", { detail: "summary" })).structuredContent,
    ).result;
    expect(mcpFull.open).toBe(false);
    // Shared session facts are projected identically by both adapters.
    for (const field of [
      "detail",
      "open",
      "cleanup_pending",
      "analysis_provider_binding",
      "analysis_provider_candidates",
      "analysis_run",
      "analysis_activity",
      "provider_operation_health",
    ] as const)
      expect(mcpSummary[field], field).toEqual(cliSummary[field]);
    for (const field of ["package", "skill", "catalog"] as const)
      expect(mcpSummary.server_identity[field], field).toEqual(
        cliSummary.server_identity[field],
      );
    // CLI adds its auxiliary SQLite capability to the same session route.
    expect(cliSummary.capabilities.unavailable).toEqual(
      expect.arrayContaining(mcpSummary.capabilities.unavailable),
    );
  },
);

cliTest(
  "accepts only complete or summary detail on both CLI status commands and MCP",
  async ({ cli }) => {
    const run = (arguments_: readonly string[]) =>
      cli.run({ arguments: [...arguments_, "--json"], environment });
    const byDefault = await run(["providers"]);
    const full = await run(["providers", "--detail", "complete"]);
    const summary = await run(["providers", "--detail", "summary"]);
    for (const result of [byDefault, full, summary])
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    // An explicit complete request is the default delivery, not another projection.
    expect(withoutStartTime(full.json)).toEqual(
      withoutStartTime(byDefault.json),
    );
    expect(withoutStartTime(full.json)).toMatchObject({
      open: false,
      capabilities: expect.any(Array),
      analysis_provider_candidates: expect.any(Array),
    });
    expect(cliSummarySchema.parse(summary.json).detail).toBe("summary");

    const rejected = await run(["capabilities", "--detail", "full"]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [expect.objectContaining({ path: "detail" })],
    });
    const { call } = await connectLocalToolsMcp(environment);
    const refused = await call("binary_session", { detail: "full" });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(JSON.stringify(refused.content)).toContain(
      "Invalid arguments for tool binary_session",
    );
  },
);
