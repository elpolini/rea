import { copyFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import {
  nodeRuntimeRemediation,
  type NodeVersionPin,
} from "../../../src/domain/runtimeVersion.js";
import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";
import type { TestWorkspace } from "../../support/workspace/workspaceFixture.js";

/** Copy the real dispatcher beside a recording CLI runtime; returns its path. */
const writeDispatcherWorkspace = async (
  workspace: TestWorkspace,
): Promise<string> => {
  const scripts = await workspace.mkdir("scripts");
  await Promise.all([
    copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
    workspace.write(
      "dist/cli-runtime/cli.js",
      'export const cliConfigurationError = () => undefined; export const createCli = () => ({ serve: (args) => process.stdout.write(JSON.stringify({ adapter: "cli", args })) });\n',
    ),
    workspace.write(
      "dist/cli-runtime/cliOutput.js",
      "export const normalizeCliOutputArguments = (args) => args; export const validateCliOutputArguments = () => ({ ok: true }); export const renderCliOutputArgumentError = () => ''; export const renderEmptyFilteredCliOutput = () => undefined;\n",
    ),
    workspace.write(
      "dist/cli-runtime/cliResultOutput.js",
      "export const createCliResultOutput = () => undefined;\n",
    ),
  ]);
  return join(scripts, "rea.mjs");
};

const writePackageJson = (
  workspace: TestWorkspace,
  engines?: string,
): Promise<string> =>
  workspace.write(
    "package.json",
    JSON.stringify({
      type: "module",
      version: "1.0.0",
      ...(engines === undefined ? {} : { engines: { node: engines } }),
    }),
  );

describe("executable dispatcher", () => {
  workspaceCliTest(
    "reserves production MCP routing for bare mode arguments",
    async ({ processes, workspace }) => {
      const dispatcher = await writeDispatcherWorkspace(workspace);
      await Promise.all([
        writePackageJson(workspace),
        workspace.write(
          "dist/mcp/main.js",
          'export const runEntrypoint = () => process.stdout.write(JSON.stringify({ adapter: "mcp" }));\n',
        ),
        workspace.write(
          "dist/cli-runtime/mcpDoctor.js",
          'export const runProductionMcpDoctorCli = (args) => Promise.resolve({ output: JSON.stringify({ adapter: "mcp-doctor", args }), exitCode: 0 });\n',
        ),
      ]);

      const invoke = async (args: readonly string[]): Promise<unknown> => {
        const { exitCode, stdout } = await processes.run(
          process.execPath,
          [dispatcher, ...args],
          { cwd: workspace.root },
        );
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as unknown;
      };

      await expect(invoke(["mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["--mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["mcp", "doctor", "--json"])).resolves.toEqual({
        adapter: "mcp-doctor",
        args: ["--json"],
      });
      await expect(invoke(["mcp", "add"])).resolves.toEqual({
        adapter: "cli",
        args: ["mcp", "add"],
      });
      await expect(invoke(["--mcp", "extra"])).resolves.toEqual({
        adapter: "cli",
        args: ["--mcp", "extra"],
      });
    },
  );

  workspaceCliTest(
    "explains how to restore a missing compiled runtime",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        // Without installed dependencies the runtime notice cannot evaluate
        // engines; an excluded runtime must still reach this explanation.
        writePackageJson(workspace, `>${process.versions.node}`),
      ]);

      for (const args of [["mcp"], ["mcp", "doctor"], ["--help"]]) {
        const result = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(result).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining(
            "REA's compiled runtime is missing. Run `npm ci && npm run build:cached` in",
          ),
        });
        expect(result.stderr).toContain(
          "If this is an installed package, reinstall rea-agents.",
        );
        expect(result).toMatchObject({
          stderr: expect.not.stringContaining("ERR_MODULE_NOT_FOUND"),
        });
      }
    },
  );
});

describe("unsupported Node.js runtime notice", () => {
  workspaceCliTest(
    "names the supported range once and continues without switching runtimes",
    async ({ processes, workspace }) => {
      const dispatcher = await writeDispatcherWorkspace(workspace);
      // The dispatcher evaluates package engines with the installed semver.
      await workspace.mkdir("node_modules");
      await symlink(
        await realpath("node_modules/semver"),
        workspace.path("node_modules/semver"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const unsupported = `>${process.versions.node}`;
      const run = async (engines?: string) => {
        await writePackageJson(workspace, engines);
        return processes.run(process.execPath, [dispatcher, "--version"], {
          cwd: workspace.root,
        });
      };
      const notice = `REA is running on Node.js ${process.versions.node}, outside its supported Node.js range ${unsupported}, and may fail in unexpected ways.`;
      const unchanged = "REA does not install or switch Node.js.\n";
      // The launcher repeats the wording doctor and setup use.
      const hint = (pin?: NodeVersionPin) =>
        nodeRuntimeRemediation({
          release: "a supported release",
          pin,
          nextStep: "restart REA",
        });

      const installed = await run(unsupported);
      expect(installed).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(installed.stdout)).toEqual({
        adapter: "cli",
        args: ["--version"],
      });
      expect(installed.stderr).toBe(`${notice} ${hint()} ${unchanged}`);
      expect(installed.stderr).toContain(
        "Install or select a supported release with your version manager (for example nvm or fnm), make it the `node` on PATH",
      );

      const pin = await workspace.write(".nvmrc", "v24.18.0\n");
      const pinned = { root: workspace.root, path: pin, version: "24.18.0" };
      await expect(run(unsupported)).resolves.toMatchObject({
        exitCode: 0,
        stderr: `${notice} ${hint(pinned)} ${unchanged}`,
      });
      expect(hint(pinned)).toBe(
        `This checkout pins Node.js 24.18.0 in ${pin}; install or select it with your version manager (for example \`nvm install\` or \`fnm use --install-if-missing\` in ${workspace.root}, or \`nvm install 24.18.0\` and \`nvm use 24.18.0\` with nvm-windows), then restart REA.`,
      );

      await workspace.write(".nvmrc", "lts/*\n");
      await expect(run(unsupported)).resolves.toMatchObject({
        stderr: `${notice} ${hint({ ...pinned, version: undefined })} ${unchanged}`,
      });

      for (const engines of [`>=${process.versions.node}`, undefined])
        await expect(run(engines)).resolves.toMatchObject({
          exitCode: 0,
          stderr: "",
        });
    },
  );
});
