import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Cli } from "incur";
import pino from "pino";
import { expect, it, onTestFinished } from "vitest";

import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { presentOmittableDefaults } from "../../../src/cli/omittableDefaults.js";
import type { ApktoolRequest } from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { assertAdvertisedMcpContracts } from "./mcpContractHarness.js";

const identity = { id: "apktool", name: "Apktool", version: "2.7.0-dirty" };

const clientIdentity = {
  command: "/usr/bin/apktool",
  command_source: "path",
  apktool_version: "2.7.0-dirty",
};

const results: Readonly<Record<string, unknown>> = {
  inspect_apktool_client: { client: clientIdentity },
  decode_android_resources: {
    client: clientIdentity,
    target: {
      path: "/targets/probe.apk",
      bytes: 8524,
      sha256: "a".repeat(64),
    },
    metadata: {
      version_name: "1.2.3",
      version_code: "7",
      min_sdk_version: "24",
      target_sdk_version: "34",
      package_name: "com.rea.apktool.probe",
    },
    manifest:
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.rea.apktool.probe"/>',
    entry_points: {
      components: [
        {
          kind: "activity",
          name: "com.rea.apktool.probe.MainActivity",
          target_activity: null,
          exported: true,
          exported_reference: null,
          enabled: null,
          enabled_reference: "@bool/probe_enabled",
          permission: null,
          launcher: false,
          intent_filters: [
            {
              actions: ["android.intent.action.VIEW"],
              categories: ["android.intent.category.BROWSABLE"],
              auto_verify: true,
              auto_verify_reference: null,
              data: [
                {
                  scheme: "https",
                  host: "probe.example",
                  port: null,
                  path: null,
                  path_prefix: "/item",
                  path_pattern: null,
                  path_advanced_pattern: null,
                  path_suffix: null,
                  mime_type: null,
                },
              ],
            },
          ],
        },
      ],
      deep_links: [
        {
          component: "com.rea.apktool.probe.MainActivity",
          filter_index: 0,
          unprojected: [],
          scheme: "https",
          host: "probe.example",
          port: null,
          path: "/item",
          path_kind: "prefix",
          browsable: true,
          auto_verify: true,
          uri: "https://probe.example/item*",
        },
      ],
    },
    strings: [{ name: "app_name", value: "ApktoolProbe" }],
    locale: null,
    locales: ["de"],
    decoded_file_count: 5,
    coverage: "complete",
  },
};

it("advertises exact valid Apktool schemas and records inline evidence through MCP", async () => {
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      return ok(createAnalysisExecution(results[request.operation], identity));
    },
  };
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { apktoolAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "apktool-boundary", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const operationNames = [
    "inspect_apktool_client",
    "decode_android_resources",
  ] as const;
  for (const name of operationNames) expect(names, name).toContain(name);

  assertAdvertisedMcpContracts(operationNames, tools);

  const decoded = await client.callTool({
    name: "decode_android_resources",
    arguments: { path: "/targets/probe.apk" },
  });
  expect(decoded.isError).not.toBe(true);
  const text = (decoded.content as { readonly text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  const evidence = parseEvidence(JSON.parse(text));
  expect(evidence.provider.id).toBe("apktool");
  expect(evidence.normalized_result).toMatchObject({
    metadata: { package_name: "com.rea.apktool.probe", version_name: "1.2.3" },
    entry_points: (results.decode_android_resources as Record<string, unknown>)
      .entry_points,
    coverage: "complete",
  });
});

/** A provider that honors include_manifest and records each request. */
const manifestAwareProvider = (
  requests: ApktoolRequest[],
): ApktoolResourceAnalysisPort => ({
  async inspectAvailability() {
    return { status: "available", code: null, reason: null, diagnostics: {} };
  },
  async close() {},
  async execute(request) {
    requests.push(request);
    if (request.operation !== "decode_android_resources")
      return ok(createAnalysisExecution(results[request.operation], identity));
    const decoded = results.decode_android_resources as Record<string, unknown>;
    return ok(
      createAnalysisExecution(
        request.input.include_manifest
          ? decoded
          : { ...decoded, manifest: null },
        identity,
        {
          limitations: request.input.include_manifest
            ? []
            : [
                "manifest text was omitted by request (include_manifest false); the decoded AndroidManifest.xml was still read for package_name and entry_points",
              ],
        },
      ),
    );
  },
});

const mcpDecode = async (
  provider: ApktoolResourceAnalysisPort,
  input: Record<string, unknown>,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { apktoolAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "apktool-parity", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: "decode_android_resources",
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  return parseEvidence(
    JSON.parse(
      (response.content as { readonly text?: string }[])
        .map((part) => part.text ?? "")
        .join(""),
    ),
  );
};

const cliDecode = async (
  provider: ApktoolResourceAnalysisPort,
  argv: readonly string[],
) => {
  const cli = Cli.create("rea", { sync: false });
  registerApktoolCommands(cli, pino({ level: "silent" }), {}, provider);
  presentOmittableDefaults(cli);
  let stdout = "";
  let exitCode = 0;
  await cli.serve(["decode-android-resources", ...argv, "--json"], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  expect(exitCode).toBe(0);
  return parseEvidence(JSON.parse(stdout));
};

it("omits the manifest text identically through CLI --no-manifest and MCP include_manifest", async () => {
  const mcpRequests: ApktoolRequest[] = [];
  const cliRequests: ApktoolRequest[] = [];
  const viaMcp = await mcpDecode(manifestAwareProvider(mcpRequests), {
    path: "/targets/probe.apk",
    include_manifest: false,
  });
  const viaCli = await cliDecode(manifestAwareProvider(cliRequests), [
    "/targets/probe.apk",
    "--no-manifest",
  ]);

  const request = {
    operation: "decode_android_resources",
    input: {
      path: "/targets/probe.apk",
      include_strings: true,
      include_manifest: false,
    },
  };
  expect(mcpRequests).toEqual([request]);
  expect(cliRequests).toEqual([request]);
  expect(viaMcp.parameters).toEqual(request.input);
  expect(viaMcp.normalized_result).toMatchObject({
    manifest: null,
    entry_points: (results.decode_android_resources as Record<string, unknown>)
      .entry_points,
  });
  expect(viaMcp.limitations).toContain(
    "manifest text was omitted by request (include_manifest false); the decoded AndroidManifest.xml was still read for package_name and entry_points",
  );
  // Both adapters produce the same Evidence for the same selection.
  expect(viaCli).toEqual(viaMcp);

  // The default keeps the manifest text through both adapters.
  const kept = await mcpDecode(manifestAwareProvider([]), {
    path: "/targets/probe.apk",
  });
  expect(kept.parameters).toEqual({
    path: "/targets/probe.apk",
    include_strings: true,
    include_manifest: true,
  });
  expect(kept.normalized_result).toMatchObject({
    manifest: (results.decode_android_resources as Record<string, unknown>)
      .manifest,
  });
  expect(
    await cliDecode(manifestAwareProvider([]), ["/targets/probe.apk"]),
  ).toEqual(kept);
});
