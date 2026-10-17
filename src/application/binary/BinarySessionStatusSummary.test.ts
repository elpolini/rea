import { expect, it } from "vitest";
import { z } from "zod";

import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { createServerIdentity } from "../../serverIdentity.js";
import {
  binarySessionFullOutputSchema,
  binarySessionSummaryOutputSchema,
} from "../../contracts/toolOutputSchemaGroups.js";
import { sessionStatusSummaryCore } from "../../contracts/toolOutputSchemaPrimitives.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { summarizeSessionStatus } from "./BinarySessionStatusSummary.js";

const fixture = { id: "fixture", name: "Fixture provider", version: "1" };
const other = { id: "other", name: "Other provider", version: null };
const profile = createAnalysisProfile(fixture, { mode: "fixture" });
const runId = "8f0b4f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

const capabilityGroup = (
  operation: string,
  state:
    | { readonly available: true }
    | { readonly reason: string; readonly code: string },
): JsonValue => ({
  operations: [operation],
  effects: [],
  limitations: ["Group limitation."],
  ...("reason" in state
    ? { available: false, reason: state.reason, availability_code: state.code }
    : { available: true, reason: null, availability_code: null }),
});

const capabilitySets: JsonValue = [
  {
    provider: fixture,
    shared_limitations: ["Shared limitation."],
    groups: [
      capabilityGroup("list_strings", { available: true }),
      capabilityGroup("xrefs", {
        reason: "Engine missing.",
        code: "not_configured",
      }),
      capabilityGroup("list_names", {
        reason: "Engine missing.",
        code: "not_configured",
      }),
      capabilityGroup("read_bytes", {
        reason: "Host unsupported.",
        code: "unsupported_host",
      }),
    ],
  },
];

const candidates: JsonValue = [
  {
    provider: fixture,
    availability: {
      status: "available",
      code: null,
      reason: null,
      diagnostics: { version: "1" },
    },
    target_support: {
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    },
    selected: true,
    capabilities: capabilitySets,
  },
  {
    provider: other,
    availability: {
      status: "unavailable",
      code: "not_configured",
      reason: "Set OTHER_HOME.",
      diagnostics: { checks: [{ name: "home", ok: false }] },
    },
    target_support: {
      status: "unsupported",
      code: "target_kind_unsupported",
      reason: "Other supports databases only.",
      diagnostics: {},
    },
    selected: false,
    capabilities: [],
  },
];

const lineageSnapshots: JsonValue = [
  {
    provider: fixture,
    observation: {
      status: "verified",
      observed_at: "2026-10-17T00:00:00.000Z",
      launcher_pid: 10,
      launcher_parent_pid: 1,
      process_group_id: 10,
      descendants: [{ pid: 11, parent_pid: 10, process_group_id: 10 }],
    },
  },
  {
    provider: other,
    observation: {
      status: "unavailable",
      observed_at: "2026-10-17T00:00:01.000Z",
      launcher_pid: 20,
      process_group_id: 20,
      reason: "Process start identity changed.",
    },
  },
];

const clientRequirements = (
  required: readonly string[],
  optional: readonly string[],
): JsonValue => ({
  required: [...required],
  optional: [...optional],
  missing_required: [...required],
  missing_optional: [...optional],
});

const tool = (
  names: readonly string[],
  facts: Record<string, JsonValue>,
): JsonValue => ({
  names: [...names],
  surface: "session",
  effects: [],
  annotations: ["read_only"],
  ...("remediation" in facts
    ? { available: false }
    : { available: true, reason: "available", remediation: null }),
  ...facts,
});

const nativeResolution = {
  name: "native-literal-resolution",
  available: false,
  missing_operations: ["native-module-resolver"],
  remediation: "Provide a browser.",
};

const toolAvailability: JsonValue = {
  client_requirements: clientRequirements([], []),
  groups: [
    tool(["zeta_tool", "alpha_tool"], {}),
    tool(["xrefs"], {
      reason: "provider_missing",
      remediation: "Configure a provider for xrefs.",
    }),
    tool(["trace_web_module_imports"], {
      default_mode_available: false,
      modes: [
        {
          name: "sources-without-literal-imports",
          available: true,
          missing_operations: [],
          remediation: null,
        },
        nativeResolution,
      ],
    }),
    // Different effects keep a separate full group with the same remediation.
    tool(["list_names"], {
      effects: ["idempotent"],
      reason: "provider_missing",
      remediation: "Configure a provider for xrefs.",
    }),
    tool(["capture_browser_scenario"], {
      client_requirements: clientRequirements([], ["elicitation_form"]),
    }),
    tool(["sampled_tool"], {
      client_requirements: clientRequirements(["sampling"], []),
      reason: "client_capability_missing",
      remediation: "Use an MCP client that supports: sampling.",
    }),
  ],
};

const serverIdentity = () =>
  createServerIdentity({
    startedAt: "2026-10-17T00:00:00.000Z",
    commandPath: "/opt/rea/dist/main.js",
    client: { name: "fixture-client", version: "2" },
    protocolVersion: "2025-11-25",
    expected: { package_version: "0.0.0-mismatch" },
  });

const activity: JsonValue = {
  status: "busy",
  providers: [
    {
      provider: fixture,
      active: {
        request_id: 3,
        operation: "xrefs",
        elapsed_ms: 40,
        caller_state: "waiting",
      },
      queued_requests: 1,
    },
  ],
};
const health: JsonValue = {
  state: "busy",
  stage: "analysis",
  retry_action: "wait",
  exit_code: null,
  requests: [{ request_id: 3, operation: "xrefs", stage: "analysis" }],
};
const clientFeatures = {
  elicitation_form: false,
  elicitation_url: false,
  roots: true,
  sampling: false,
};
const rawTarget = {
  path: "/tmp/firmware.bin",
  format: "raw-binary",
  kind: "executable",
  sha256: "a".repeat(64),
  architecture: "arm",
  entry_point: "0x8000",
};

/** Complete MCP status for an open raw target with every summarized fact kind. */
const completeStatus = (): Record<string, JsonValue> => ({
  open: true,
  cleanup_pending: true,
  capabilities: capabilitySets,
  analysis_provider_binding: {
    provider: fixture,
    selection_source: "request",
    analysis_profile: profile,
  },
  analysis_provider_candidates: candidates,
  analysis_run: {
    run_id: runId,
    process_lineage: { status: "snapshots", snapshots: lineageSnapshots },
  },
  analysis_activity: activity,
  provider_operation_health: health,
  ...rawTarget,
  tool_availability: toolAvailability,
  client_features: clientFeatures,
  server_identity: serverIdentity(),
});

const expectedCapabilities = {
  counts: { providers: 1, operations: 4, available: 1, unavailable: 3 },
  unavailable: [
    {
      provider: fixture,
      operations: ["list_names", "xrefs"],
      reason: "Engine missing.",
      availability_code: "not_configured",
    },
    {
      provider: fixture,
      operations: ["read_bytes"],
      reason: "Host unsupported.",
      availability_code: "unsupported_host",
    },
  ],
};

const expectedCandidates = [
  {
    provider: fixture,
    availability: { status: "available", code: null, reason: null },
    target_support: { status: "supported", code: null, reason: null },
    selected: true,
    operations: { total: 4, available: 1 },
  },
  {
    provider: other,
    availability: {
      status: "unavailable",
      code: "not_configured",
      reason: "Set OTHER_HOME.",
    },
    target_support: {
      status: "unsupported",
      code: "target_kind_unsupported",
      reason: "Other supports databases only.",
    },
    selected: false,
    operations: { total: 0, available: 0 },
  },
];

const expectedToolAvailability = {
  counts: { tools: 7, available: 4, unavailable: 3, degraded: 2 },
  unavailable: [
    {
      reason: "provider_missing",
      remediation: "Configure a provider for xrefs.",
      names: ["list_names", "xrefs"],
    },
    {
      reason: "client_capability_missing",
      remediation: "Use an MCP client that supports: sampling.",
      names: ["sampled_tool"],
    },
  ],
  degraded: [
    {
      names: ["trace_web_module_imports"],
      default_mode_available: false,
      unavailable_modes: [nativeResolution],
      missing_optional_client_features: [],
    },
    {
      names: ["capture_browser_scenario"],
      default_mode_available: true,
      unavailable_modes: [],
      missing_optional_client_features: ["elicitation_form"],
    },
  ],
};

const expectedServerIdentity = () => {
  const identity = serverIdentity();
  return {
    package: {
      name: identity.package.name,
      version: identity.package.version,
      build_commit: identity.package.build_commit,
    },
    server: {
      name: identity.server.name,
      started_at: "2026-10-17T00:00:00.000Z",
      command_path: identity.server.command_path,
    },
    negotiated_protocol_version: "2025-11-25",
    client: { name: "fixture-client", version: "2" },
    skill: identity.skill,
    catalog: {
      counts: identity.catalog.counts,
      combined_sha256: identity.catalog.digests.combined_sha256,
    },
    alignment: {
      state: "mcp_server_restart_required",
      reasons: ["package_version_mismatch"],
      remediation: identity.alignment.remediation,
    },
  };
};

it("keeps orientation facts and names only unavailable or degraded entries", () => {
  const complete = completeStatus();
  expect(
    binarySessionFullOutputSchema.safeParse({ result: complete }).success,
  ).toBe(true);
  const summary = summarizeSessionStatus(complete);
  expect(
    binarySessionSummaryOutputSchema.parse({ result: summary }).result,
  ).toEqual(summary);
  expect(summary).toEqual({
    detail: "summary",
    open: true,
    ...rawTarget,
    cleanup_pending: true,
    capabilities: expectedCapabilities,
    analysis_provider_binding: {
      provider: fixture,
      selection_source: "request",
      analysis_profile_digest: profile.digest,
    },
    analysis_provider_candidates: expectedCandidates,
    analysis_run: {
      run_id: runId,
      process_lineage: {
        status: "snapshots",
        verified: 1,
        unavailable: [
          { provider: other, reason: "Process start identity changed." },
        ],
      },
    },
    analysis_activity: activity,
    provider_operation_health: health,
    tool_availability: expectedToolAvailability,
    client_features: clientFeatures,
    server_identity: expectedServerIdentity(),
  });
  // Diagnostics, effects, limitations and SDK identity remain in detail complete.
  const serialized = JSON.stringify(summary);
  for (const omitted of ["diagnostics", "limitations", "effects", "sdk"])
    expect(serialized).not.toContain(`"${omitted}"`);
});

it("summarizes CLI status without inventing MCP tool or client facts", () => {
  const {
    tool_availability: _tools,
    client_features: _features,
    ...cliStatus
  } = completeStatus();
  const summary = summarizeSessionStatus({
    ...cliStatus,
    open: false,
    analysis_provider_binding: null,
    analysis_run: null,
  });
  for (const absent of [
    "tool_availability",
    "client_features",
    "path",
    "entry_point",
  ])
    expect(summary).not.toHaveProperty(absent);
  expect(
    sessionStatusSummaryCore.extend({ open: z.literal(false) }).parse(summary),
  ).toEqual(summary);
  expect(summary).toMatchObject({
    open: false,
    analysis_provider_binding: null,
    analysis_run: null,
  });
});

it("reports an observed run before any provider lineage", () => {
  const summary = summarizeSessionStatus({
    ...completeStatus(),
    analysis_run: {
      run_id: runId,
      process_lineage: { status: "not_observed" },
    },
  });
  expect(summary.analysis_run).toEqual({
    run_id: runId,
    process_lineage: { status: "not_observed", verified: 0, unavailable: [] },
  });
});

it.each([
  ["missing capabilities", { capabilities: undefined }],
  [
    "malformed candidate availability",
    { analysis_provider_candidates: [{ provider: other, availability: {} }] },
  ],
  ["an open status without a target", { path: undefined }],
  ["an unknown target format", { format: "not-a-format" }],
  ["a malformed tool inventory", { tool_availability: { groups: [{}] } }],
])("rejects %s instead of summarizing partial facts", (_name, change) => {
  const malformed: Record<string, JsonValue> = completeStatus();
  for (const [key, value] of Object.entries(change))
    if (value === undefined) delete malformed[key];
    else malformed[key] = value;
  expect(() => summarizeSessionStatus(malformed)).toThrow();
});
