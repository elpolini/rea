import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pinnedNodeVersion,
  type NodeVersionPin,
} from "../domain/runtimeVersion.js";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Read the development runtime a source checkout pins in `.nvmrc`. Installed
 * packages do not ship one; a missing or unreadable pin leaves the general
 * version-manager advice, as the launcher does.
 */
export const readNodeVersionPin = async (
  packageRoot: string = PACKAGE_ROOT,
): Promise<NodeVersionPin | undefined> => {
  const path = join(packageRoot, ".nvmrc");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause: unknown) {
    void cause;
    return undefined;
  }
  return { root: packageRoot, path, version: pinnedNodeVersion(text) };
};
