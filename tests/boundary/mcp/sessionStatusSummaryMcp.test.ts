import { realpath, rm } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import {
  binarySessionFullOutputSchema,
  binarySessionSummaryOutputSchema,
} from "../../../src/contracts/toolOutputSchemaGroups.js";
import {
  expandProviderCapabilities,
  expandToolAvailability,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { createSessionMcpHarness } from "./sessionMcpHarness.js";

type FullStatus = z.output<typeof binarySessionFullOutputSchema>["result"];
type SummaryStatus = z.output<
  typeof binarySessionSummaryOutputSchema
>["result"];

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const identity = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
};

const capability = (
  operation: CapabilityDescriptor["operation"],
  availability:
    | { readonly available: true; readonly reason: null }
    | {
        readonly available: false;
        readonly reason: string;
        readonly availabilityCode: "not_configured";
      },
): CapabilityDescriptor => ({
  provider: identity,
  operation,
  ...availability,
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: ["Fixture limitation."],
});

const provider = (closed: string[]): AnalysisProvider => ({
  identity: () => identity,
  capabilities: () => [
    capability("current_document", { available: true, reason: null }),
    capability("list_strings", {
      available: false,
      reason: "Fixture strings require a configured engine.",
      availabilityCode: "not_configured",
    }),
  ],
  createClient: (target) => ({
    execute: (name) =>
      Promise.resolve(ok(name === "current_document" ? target.path : null)),
    close: () => {
      closed.push(target.path);
      return Promise.resolve(resultOk(null));
    },
  }),
});

const callStatus = (
  mcp: Client,
  arguments_: Record<string, unknown>,
): Promise<CallToolResult> =>
  mcp.callTool({ name: "binary_session", arguments: arguments_ });

const serializedBytes = (result: CallToolResult): number =>
  Buffer.byteLength(JSON.stringify(result), "utf8");

/** Every summary fact must be derivable from the complete status it replaces. */
const expectSummaryOf = (full: FullStatus, summary: SummaryStatus): void => {
  expect(summary.detail).toBe("summary");
  expect(summary.open).toBe(full.open);
  if (full.open && summary.open)
    for (const field of ["path", "format", "kind", "sha256", "architecture"])
      expect(summary).toHaveProperty(field, Reflect.get(full, field));
  expect(summary).toMatchObject({
    cleanup_pending: full.cleanup_pending,
    analysis_activity: full.analysis_activity,
    provider_operation_health: full.provider_operation_health,
    client_features: full.client_features,
  });
  expect(summary.analysis_run?.run_id).toBe(full.analysis_run?.run_id);
  expect(summary.analysis_provider_binding).toEqual(
    full.analysis_provider_binding === null
      ? null
      : {
          provider: full.analysis_provider_binding.provider,
          selection_source: full.analysis_provider_binding.selection_source,
          analysis_profile_digest:
            full.analysis_provider_binding.analysis_profile.digest,
        },
  );
  expect(
    summary.analysis_provider_candidates.map(
      ({ provider, availability, target_support, selected }) => ({
        provider,
        availability,
        target_support,
        selected,
      }),
    ),
  ).toEqual(
    full.analysis_provider_candidates.map((candidate) => ({
      provider: candidate.provider,
      availability: {
        status: candidate.availability.status,
        code: candidate.availability.code,
        reason: candidate.availability.reason,
      },
      target_support: {
        status: candidate.target_support.status,
        code: candidate.target_support.code,
        reason: candidate.target_support.reason,
      },
      selected: candidate.selected,
    })),
  );

  const capabilities = expandProviderCapabilities(full.capabilities);
  expect(summary.capabilities.counts).toEqual({
    providers: full.capabilities.length,
    operations: capabilities.length,
    available: capabilities.filter(({ available }) => available).length,
    unavailable: capabilities.filter(({ available }) => !available).length,
  });
  const unavailableCapability = ({
    provider,
    operation,
    reason,
    availability_code,
  }: {
    readonly provider: { readonly id: string };
    readonly operation: string;
    readonly reason: string | null;
    readonly availability_code: string | null;
  }) => JSON.stringify([provider.id, operation, reason, availability_code]);
  expect(
    summary.capabilities.unavailable
      .flatMap((entry) =>
        entry.operations.map((operation) =>
          unavailableCapability({ ...entry, operation }),
        ),
      )
      .sort(),
  ).toEqual(
    capabilities
      .filter(({ available }) => !available)
      .map(unavailableCapability)
      .sort(),
  );

  const tools = expandToolAvailability(full.tool_availability);
  const available = tools.filter((tool) => tool.available);
  expect(summary.tool_availability.counts).toMatchObject({
    tools: tools.length,
    available: available.length,
    unavailable: tools.length - available.length,
  });
  expect(
    summary.tool_availability.unavailable
      .flatMap(({ names, reason, remediation }) =>
        names.map((name) => JSON.stringify([name, reason, remediation])),
      )
      .sort(),
  ).toEqual(
    tools
      .filter((tool) => !tool.available)
      .map(({ name, reason, remediation }) =>
        JSON.stringify([name, reason, remediation]),
      )
      .sort(),
  );
  const degraded = summary.tool_availability.degraded.flatMap(
    ({ names }) => names,
  );
  expect(summary.tool_availability.counts.degraded).toBe(degraded.length);
  expect(degraded.sort()).toEqual(
    available
      .filter(
        (tool) =>
          tool.default_mode_available === false ||
          (tool.modes ?? []).some((mode) => !mode.available) ||
          tool.client_requirements.missing_optional.length > 0,
      )
      .map(({ name }) => name)
      .sort(),
  );

  const { server_identity: identity } = full;
  expect(summary.server_identity).toEqual({
    package: {
      name: identity.package.name,
      version: identity.package.version,
      build_commit: identity.package.build_commit,
    },
    server: {
      name: identity.server.name,
      started_at: identity.server.started_at,
      command_path: identity.server.command_path,
    },
    negotiated_protocol_version: identity.negotiated_protocol_version,
    client: identity.client,
    skill: identity.skill,
    catalog: {
      counts: identity.catalog.counts,
      combined_sha256: identity.catalog.digests.combined_sha256,
    },
    alignment: identity.alignment,
  });
};

describe("binary_session detail", () => {
  it("summarizes the same target-free and open status that full returns", async () => {
    directory = await createTestTempDirectory("rea-mcp-session-summary-");
    const { mcp, first } = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );
    const tool = (await mcp.listTools()).tools.find(
      ({ name }) => name === "binary_session",
    );
    if (tool?.outputSchema === undefined)
      throw new Error("binary_session was not advertised with an output");
    expect(tool.inputSchema.properties?.detail).toMatchObject({
      enum: ["complete", "summary"],
      default: "complete",
    });
    const validateOutput = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(z.record(z.string(), z.unknown()).parse(tool.outputSchema));

    for (const opened of [false, true]) {
      if (opened)
        expect(
          (
            await mcp.callTool({
              name: "open_binary",
              arguments: { path: first },
            })
          ).isError,
        ).not.toBe(true);
      const defaultReply = await callStatus(mcp, {});
      const fullReply = await callStatus(mcp, { detail: "complete" });
      const summaryReply = await callStatus(mcp, { detail: "summary" });
      for (const reply of [defaultReply, fullReply, summaryReply]) {
        expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
        expect(validateOutput(reply.structuredContent)).toBe(true);
      }
      expect(fullReply.structuredContent).toEqual(
        defaultReply.structuredContent,
      );
      const full = binarySessionFullOutputSchema.parse(
        defaultReply.structuredContent,
      ).result;
      const summary = binarySessionSummaryOutputSchema.parse(
        summaryReply.structuredContent,
      ).result;
      expect(
        binarySessionSummaryOutputSchema.safeParse(
          defaultReply.structuredContent,
        ).success,
      ).toBe(false);
      expect(
        binarySessionFullOutputSchema.safeParse(summaryReply.structuredContent)
          .success,
      ).toBe(false);
      expectSummaryOf(full, summary);
      expect(serializedBytes(summaryReply) * 2).toBeLessThan(
        serializedBytes(defaultReply),
      );
      if (opened) {
        expect(summary).toMatchObject({
          open: true,
          path: await realpath(first),
          analysis_provider_binding: { provider: identity },
          capabilities: {
            unavailable: [
              {
                provider: identity,
                operations: ["list_strings"],
                reason: "Fixture strings require a configured engine.",
                availability_code: "not_configured",
              },
            ],
          },
        });
        expect(JSON.stringify(summary)).not.toContain("Fixture limitation.");
      } else expect(summary).not.toHaveProperty("path");
    }

    // Summary delivery observes the session without changing it.
    const after = binarySessionFullOutputSchema.parse(
      (await callStatus(mcp, {})).structuredContent,
    ).result;
    expect(after).toMatchObject({ open: true, path: await realpath(first) });
  });

  it("keeps caller identity expectations in the summary", async () => {
    directory = await createTestTempDirectory("rea-mcp-session-summary-");
    const { mcp } = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );
    const summary = binarySessionSummaryOutputSchema.parse(
      (
        await callStatus(mcp, {
          detail: "summary",
          expected_package_version: "0.0.0-not-running",
        })
      ).structuredContent,
    ).result;
    expect(summary.server_identity.alignment).toMatchObject({
      state: "mcp_server_restart_required",
      reasons: ["package_version_mismatch"],
    });
  });

  it.each([["full"], ["SUMMARY"], [""], [1], [null], [["summary"]]])(
    "rejects malformed detail %j at the input boundary",
    async (detail) => {
      directory ??= await createTestTempDirectory("rea-mcp-session-summary-");
      const { mcp } = await createSessionMcpHarness(
        directory,
        provider,
        resources,
      );
      const rejected = await callStatus(mcp, { detail });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      const message = JSON.stringify(rejected.content);
      expect(message).toContain(
        "Input validation error: Invalid arguments for tool binary_session",
      );
      expect(message).toContain("detail");
    },
  );
});
