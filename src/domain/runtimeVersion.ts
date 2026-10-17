import { satisfies } from "semver";

/** Supported runtime range, kept in sync with the published package engines. */
export const SUPPORTED_NODE_VERSION_RANGE = "^22.19.0 || ^24.11.0 || >=26.0.0";

/** Human-readable form of {@link SUPPORTED_NODE_VERSION_RANGE} for remediation. */
export const SUPPORTED_NODE_VERSION_PROSE =
  "Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+";

/** A source checkout's development runtime pin, read from its `.nvmrc`. */
export interface NodeVersionPin {
  /** Checkout directory where a version manager reads the pin. */
  readonly root: string;
  /** Path of the `.nvmrc` file. */
  readonly path: string;
  /**
   * Numeric version the pin names, without a leading `v`; `undefined` when it
   * names an alias such as `lts/*` that only the version manager resolves.
   */
  readonly version: string | undefined;
}

/** Keep a numeric `.nvmrc` version; leave aliases to the version manager. */
export const pinnedNodeVersion = (text: string): string | undefined => {
  const pin = text.trim();
  return /^v?\d+(?:\.\d+){0,2}$/u.test(pin)
    ? pin.replace(/^v/u, "")
    : undefined;
};

/**
 * How to recover from a runtime outside the supported range: install or
 * select a release, naming the checkout's `.nvmrc` pin when there is one.
 * The launcher notice in `scripts/rea.mjs`, which runs before compiled code can
 * load, uses the same wording; its boundary test compares them.
 */
export const nodeRuntimeRemediation = (input: {
  /** What to install or select when no pin applies. */
  readonly release: string;
  readonly pin?: NodeVersionPin | undefined;
  /** What to do after switching, such as "restart REA". */
  readonly nextStep: string;
}): string => {
  const { pin, nextStep } = input;
  if (pin === undefined)
    return `Install or select ${input.release} with your version manager (for example nvm or fnm), make it the \`node\` on PATH for this shell or for the agent client that starts REA, then ${nextStep}.`;
  const managers = `\`nvm install\` or \`fnm use --install-if-missing\` in ${pin.root}`;
  return pin.version === undefined
    ? `This checkout pins its Node.js version in ${pin.path}; install or select it with your version manager (for example ${managers}), then ${nextStep}.`
    : `This checkout pins Node.js ${pin.version} in ${pin.path}; install or select it with your version manager (for example ${managers}, or \`nvm install ${pin.version}\` and \`nvm use ${pin.version}\` with nvm-windows), then ${nextStep}.`;
};

/** Return whether a Node.js version satisfies REA's tested runtime families. */
export const supportsNodeVersion = (version: string): boolean =>
  satisfies(version, SUPPORTED_NODE_VERSION_RANGE);

/** JavaScript runtime executing REA. Bun also reports a Node.js compatibility version. */
export type JavaScriptRuntime =
  | { readonly id: "node"; readonly version: string }
  | {
      readonly id: "bun";
      readonly version: string;
      readonly nodeCompatibilityVersion: string;
    };

/** Identify the runtime from `process.versions`; only Bun reports `bun`. */
export const javaScriptRuntime = (versions: {
  readonly node: string;
  readonly bun?: string | undefined;
}): JavaScriptRuntime =>
  versions.bun === undefined
    ? { id: "node", version: versions.node }
    : {
        id: "bun",
        version: versions.bun,
        nodeCompatibilityVersion: versions.node,
      };
