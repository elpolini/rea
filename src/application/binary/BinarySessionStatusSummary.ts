import {
  lifecycleTargetStateSchema,
  sessionStatusFactsSchema,
  type ClientFeatureAvailability,
  type LifecycleTargetState,
  type ProviderCapabilitySet,
  type SessionStatusFacts,
  type SessionStatusSummaryCore,
  type ToolAvailabilityInventory,
  type ToolAvailabilityMode,
  type ToolAvailabilitySummary,
} from "../../contracts/toolOutputSchemaPrimitives.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";

/** Bounded orientation status; MCP adds tool and client-feature availability. */
export type SessionStatusSummary = LifecycleTargetState &
  SessionStatusSummaryCore & {
    readonly tool_availability?: ToolAvailabilitySummary;
    readonly client_features?: ClientFeatureAvailability;
  };

type UnavailableToolMode = Extract<ToolAvailabilityMode, { available: false }>;
type CapabilityUnavailability =
  SessionStatusSummaryCore["capabilities"]["unavailable"][number];
type ToolUnavailability = ToolAvailabilitySummary["unavailable"][number];
type ToolDegradation = ToolAvailabilitySummary["degraded"][number];

/**
 * Project one complete adapter status into the summary both adapters return.
 * The summary is derived only from facts already present in the complete
 * status, so detail complete remains the reachable source for every omitted fact.
 */
export const summarizeSessionStatus = (
  status: JsonValue,
): SessionStatusSummary => {
  const facts = sessionStatusFactsSchema.parse(status);
  const target = lifecycleTargetStateSchema.parse(status);
  return {
    detail: "summary",
    ...target,
    cleanup_pending: facts.cleanup_pending,
    capabilities: capabilitySummary(facts.capabilities),
    analysis_provider_binding:
      facts.analysis_provider_binding === null
        ? null
        : {
            provider: facts.analysis_provider_binding.provider,
            selection_source: facts.analysis_provider_binding.selection_source,
            analysis_profile_digest:
              facts.analysis_provider_binding.analysis_profile.digest,
          },
    analysis_provider_candidates:
      facts.analysis_provider_candidates.map(candidateSummary),
    analysis_run: analysisRunSummary(facts.analysis_run),
    analysis_activity: facts.analysis_activity,
    provider_operation_health: facts.provider_operation_health,
    ...(facts.tool_availability === undefined
      ? {}
      : {
          tool_availability: toolAvailabilitySummary(facts.tool_availability),
        }),
    ...(facts.client_features === undefined
      ? {}
      : { client_features: facts.client_features }),
    server_identity: serverIdentitySummary(facts.server_identity),
  };
};

const operationCounts = (sets: readonly ProviderCapabilitySet[]) => {
  let total = 0;
  let available = 0;
  for (const group of sets.flatMap(({ groups }) => groups)) {
    total += group.operations.length;
    if (group.available) available += group.operations.length;
  }
  return { total, available };
};

const capabilitySummary = (
  sets: readonly ProviderCapabilitySet[],
): SessionStatusSummaryCore["capabilities"] => {
  const unavailable: CapabilityUnavailability[] = [];
  for (const set of sets) {
    // Effects and limitations stay in detail complete; merge only equal states.
    const states = new Map<string, CapabilityUnavailability>();
    for (const group of set.groups) {
      if (group.available) continue;
      const key = JSON.stringify([group.reason, group.availability_code]);
      const existing = states.get(key);
      if (existing === undefined)
        states.set(key, {
          provider: set.provider,
          operations: [...group.operations],
          reason: group.reason,
          availability_code: group.availability_code,
        });
      else existing.operations.push(...group.operations);
    }
    for (const state of states.values()) {
      state.operations.sort(compareUnicodeCodePoints);
      unavailable.push(state);
    }
  }
  const { total, available } = operationCounts(sets);
  return {
    counts: {
      providers: sets.length,
      operations: total,
      available,
      unavailable: total - available,
    },
    unavailable,
  };
};

const candidateSummary = (
  candidate: SessionStatusFacts["analysis_provider_candidates"][number],
): SessionStatusSummaryCore["analysis_provider_candidates"][number] => {
  const { diagnostics: _availabilityDiagnostics, ...availability } =
    candidate.availability;
  const { diagnostics: _supportDiagnostics, ...targetSupport } =
    candidate.target_support;
  return {
    provider: candidate.provider,
    availability,
    target_support: targetSupport,
    selected: candidate.selected,
    operations: operationCounts(candidate.capabilities),
  };
};

const analysisRunSummary = (
  run: SessionStatusFacts["analysis_run"],
): SessionStatusSummaryCore["analysis_run"] => {
  if (run === null) return null;
  if (run.process_lineage.status === "not_observed")
    return {
      run_id: run.run_id,
      process_lineage: { status: "not_observed", verified: 0, unavailable: [] },
    };
  const { snapshots } = run.process_lineage;
  return {
    run_id: run.run_id,
    process_lineage: {
      status: "snapshots",
      verified: snapshots.filter(
        ({ observation }) => observation.status === "verified",
      ).length,
      unavailable: snapshots.flatMap(({ provider, observation }) =>
        observation.status === "unavailable"
          ? [{ provider, reason: observation.reason }]
          : [],
      ),
    },
  };
};

const toolAvailabilitySummary = (
  inventory: ToolAvailabilityInventory,
): ToolAvailabilitySummary => {
  let tools = 0;
  let available = 0;
  const unavailable = new Map<string, ToolUnavailability>();
  const degraded = new Map<string, ToolDegradation>();
  for (const group of inventory.groups) {
    tools += group.names.length;
    if (!group.available) {
      const key = JSON.stringify([group.reason, group.remediation]);
      const existing = unavailable.get(key);
      if (existing === undefined)
        unavailable.set(key, {
          reason: group.reason,
          remediation: group.remediation,
          names: [...group.names],
        });
      else existing.names.push(...group.names);
      continue;
    }
    available += group.names.length;
    const requirements =
      group.client_requirements ?? inventory.client_requirements;
    const unavailableModes = (group.modes ?? []).filter(
      (mode): mode is UnavailableToolMode => !mode.available,
    );
    if (
      group.default_mode_available !== false &&
      unavailableModes.length === 0 &&
      requirements.missing_optional.length === 0
    )
      continue;
    const facts = {
      // A tool without mode facts is callable through its default mode.
      default_mode_available: group.default_mode_available ?? true,
      unavailable_modes: unavailableModes,
      missing_optional_client_features: [...requirements.missing_optional],
    };
    const key = JSON.stringify(facts);
    const existing = degraded.get(key);
    if (existing === undefined)
      degraded.set(key, { names: [...group.names], ...facts });
    else existing.names.push(...group.names);
  }
  const unavailableEntries = [...unavailable.values()];
  const degradedEntries = [...degraded.values()];
  for (const entry of [...unavailableEntries, ...degradedEntries])
    entry.names.sort(compareUnicodeCodePoints);
  return {
    counts: {
      tools,
      available,
      unavailable: tools - available,
      degraded: degradedEntries.reduce(
        (count, entry) => count + entry.names.length,
        0,
      ),
    },
    unavailable: unavailableEntries,
    degraded: degradedEntries,
  };
};

const serverIdentitySummary = (
  identity: SessionStatusFacts["server_identity"],
): SessionStatusSummaryCore["server_identity"] => ({
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
