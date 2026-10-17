#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while the MCP runtime serves the stdio tool catalog.
const args = process.argv.slice(2);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Read the manifest as text: older, unsupported Node.js releases reject JSON
// import attributes before the runtime notice below could explain why.
const packageJson = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
process.env.REA_PACKAGE_VERSION = packageJson.version;
await reportUnsupportedNode(packageJson.engines?.node);
const isMcpMode =
  args.length === 1 && (args[0] === "--mcp" || args[0] === "mcp");
const isMcpDoctorMode = args[0] === "mcp" && args[1] === "doctor";
/** Exit status of a writer terminated by SIGPIPE (128 + 13). */
const SIGPIPE_EXIT_STATUS = 141;
// Set once the reader of CLI output has closed the pipe.
let stdoutClosed = false;

// Windows home lookup throws for an empty USERPROFILE. Dependencies resolve
// home during import, before REA's own resolver can apply its account fallback.
if (process.platform === "win32" && process.env.USERPROFILE === "") {
  delete process.env.USERPROFILE;
}

// Playwright's registry assumes one of its three desktop host platforms when
// it chooses the browser cache directory. Termux reports `android`, although
// its Node runtime and filesystem are POSIX-compatible. Keep the cache path
// explicit so REA can start on Termux. Browser launch still requires a
// caller-supplied Android-compatible Chromium executable.
if (
  process.platform === "android" &&
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
) {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache");
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, "ms-playwright");
}

const runtimeFiles = isMcpMode
  ? ["dist/mcp/main.js"]
  : isMcpDoctorMode
    ? ["dist/mcp/main.js", "dist/cli-runtime/mcpDoctor.js"]
    : [
        "dist/cli-runtime/cli.js",
        "dist/cli-runtime/cliOutput.js",
        "dist/cli-runtime/cliResultOutput.js",
      ];

if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exitCode = 1;
} else if (isMcpMode) {
  const { runEntrypoint } = await import("../dist/mcp/main.js");
  await runEntrypoint();
} else if (isMcpDoctorMode) {
  guardClosedStdout();
  const { runProductionMcpDoctorCli } =
    await import("../dist/cli-runtime/mcpDoctor.js");
  const result = await runProductionMcpDoctorCli(args.slice(2), {
    dispatcherPath: fileURLToPath(import.meta.url),
    packageRoot,
  });
  writeStdout(result.output);
  process.exitCode = result.exitCode;
} else {
  const { cliConfigurationError, createCli } =
    await import("../dist/cli-runtime/cli.js");
  const { createCliResultOutput } =
    await import("../dist/cli-runtime/cliResultOutput.js");
  const {
    normalizeCliOutputArguments,
    renderCliOutputArgumentError,
    renderEmptyFilteredCliOutput,
    validateCliOutputArguments,
  } = await import("../dist/cli-runtime/cliOutput.js");
  guardClosedStdout();
  const cliArgs = normalizeCliOutputArguments(args);
  const outputArguments = validateCliOutputArguments(cliArgs);
  const configurationError = cliConfigurationError(process.env);
  if (configurationError !== undefined) {
    process.stderr.write(`${configurationError}\n`);
    process.exitCode = 1;
  } else if (!outputArguments.ok) {
    writeStdout(renderCliOutputArgumentError(outputArguments));
    process.exitCode = 1;
  } else {
    let wroteOutput = false;
    const resultOutput = createCliResultOutput(cliArgs, process.stdout);
    await createCli(process.env, resultOutput).serve(cliArgs, {
      stdout: (output) => {
        if (resultOutput?.handled) {
          if (resultOutput.failed && !stdoutClosed)
            process.stderr.write(output);
          return;
        }
        if (output.length > 0) wroteOutput = true;
        writeStdout(output);
      },
      // A command failure caused by the closed pipe keeps the pipe's status.
      exit: (code) => process.exit(stdoutClosed ? SIGPIPE_EXIT_STATUS : code),
    });
    if (!wroteOutput && !resultOutput?.handled)
      writeStdout(renderEmptyFilteredCliOutput(cliArgs) ?? "");
  }
}

/**
 * Name the supported range once, on stderr, when this runtime is outside
 * package.json#engines.node. REA continues so `rea doctor` can still report
 * its failed `node` check; setup refuses on its own. REA never installs or
 * switches Node.js.
 */
async function reportUnsupportedNode(range) {
  if (typeof range !== "string") return;
  let satisfies;
  try {
    ({ satisfies } = await import("semver"));
  } catch (cause) {
    // Without installed dependencies, the compiled-runtime check below
    // already explains how to install and build REA.
    if (cause?.code === "ERR_MODULE_NOT_FOUND") return;
    throw cause;
  }
  const version = process.versions.node;
  if (satisfies(version, range)) return;
  const runtime =
    process.versions.bun === undefined
      ? `Node.js ${version}`
      : `Bun ${process.versions.bun} (Node.js ${version} compatibility)`;
  process.stderr.write(
    `REA is running on ${runtime}, outside its supported Node.js range ${range}, and may fail in unexpected ways. ${await nodeSelectionHint()} REA does not install or switch Node.js.\n`,
  );
}

/** A source checkout pins its development runtime in .nvmrc; packages do not. */
async function nodeSelectionHint() {
  const pinPath = join(packageRoot, ".nvmrc");
  let pin;
  try {
    pin = (await readFile(pinPath, "utf8")).trim();
  } catch (cause) {
    // A missing or unreadable pin leaves the general version-manager advice.
    void cause;
    return "Install or select a supported release with your version manager (for example nvm or fnm), make it the `node` on PATH for this shell or for the agent client that starts REA, then restart REA.";
  }
  // Managers such as nvm-windows take the version as an argument, so name a
  // well-formed pin explicitly; any other content is left to the manager.
  const pinned = /^v?\d+(?:\.\d+){0,2}$/u.test(pin)
    ? pin.replace(/^v/u, "")
    : undefined;
  return pinned === undefined
    ? `This checkout pins its Node.js version in ${pinPath}; select it with your version manager (for example \`nvm use\` or \`fnm use\` in ${packageRoot}), then restart REA.`
    : `This checkout pins Node.js ${pinned} in ${pinPath}; select it with your version manager (for example \`nvm use\` or \`fnm use\` in ${packageRoot}, or \`nvm use ${pinned}\` with nvm-windows), then restart REA.`;
}

/**
 * A reader that closes the pipe early, as `rea ... | head` does, has declined
 * the rest of the output. Stop writing without reporting a failure, and exit
 * with the status a SIGPIPE-terminated writer reports. MCP stdio keeps its own
 * client lifecycle.
 */
function guardClosedStdout() {
  process.stdout.on("error", (cause) => {
    if (cause?.code === "EPIPE") {
      stdoutClosed = true;
      process.exitCode = SIGPIPE_EXIT_STATUS;
      return;
    }
    // Other failures stay unhandled unless a pending JSON write reports them.
    if (process.stdout.listenerCount("error") === 1) throw cause;
  });
}

function writeStdout(output) {
  if (!stdoutClosed) process.stdout.write(output);
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
