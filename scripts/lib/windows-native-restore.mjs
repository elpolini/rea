import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { valid } from "semver";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import {
  MalformedPackageTarballError,
  readPackageTarballMembers,
} from "./npm-package-tarball.mjs";
import { execNpm } from "./verify-package-core.mjs";

const PACKAGE_NAME = "rea-agents";
const COMMAND = "npm run restore:windows-native";
const DESTINATION = "native/windows/build";
const MANIFEST = "manifest.json";
const ARTIFACT = "rea-windows-x64.node";
const MEMBERS = {
  packageJson: "package/package.json",
  manifest: `package/${DESTINATION}/${MANIFEST}`,
  artifact: `package/${DESTINATION}/${ARTIFACT}`,
};
/**
 * In-memory bound for the packed tarball and its decompressed tar stream.
 * rea-agents 6.5.0 is 5.6 MB packed and a 26.8 MB tar stream.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** Command-line help for the explicit, manual restore command. */
export const RESTORE_USAGE = `Usage: ${COMMAND} [-- --replace]

Restore ${DESTINATION}/${MANIFEST} and ${DESTINATION}/${ARTIFACT}
from the published ${PACKAGE_NAME} tarball whose version exactly matches this
checkout's package.json. Nothing is written until the registry integrity,
package identity, manifest, architecture and addon SHA-256 are verified.

  --replace  replace existing files that differ from the verified artifact
  --help     show this help
`;

/** Expected restore failure with a stable tag for callers and tests. */
export class WindowsNativeRestoreError extends Error {
  constructor(code, message, details = {}, options = undefined) {
    super(message, options);
    this.name = "WindowsNativeRestoreError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details, options) => {
  throw new WindowsNativeRestoreError(code, message, details, options);
};

const describe = (value) =>
  value instanceof Error ? value.message : JSON.stringify(value);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sha512Integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const issuesText = (error) =>
  error.issues
    .map(({ path, message }) => `${path.join(".") || "(root)"}: ${message}`)
    .join("; ");

/** Parse the command's arguments; only `--replace` changes behavior. */
export const parseRestoreArguments = (arguments_) => {
  let replace = false;
  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h")
      return { help: true, replace: false };
    if (argument === "--replace" && !replace) {
      replace = true;
      continue;
    }
    fail(
      "invalid_arguments",
      `Unknown or repeated argument ${JSON.stringify(argument)}.\n\n${RESTORE_USAGE}`,
    );
  }
  return { help: false, replace };
};

const parseCheckoutIdentity = (value) => {
  const parsed = z
    .object({ name: z.string(), version: z.string() })
    .safeParse(value);
  if (!parsed.success)
    fail(
      "checkout_identity",
      `package.json must declare string name and version fields: ${issuesText(parsed.error)}`,
    );
  const { name, version } = parsed.data;
  if (name !== PACKAGE_NAME)
    fail(
      "checkout_identity",
      `package.json names ${JSON.stringify(name)}; this command restores only a ${PACKAGE_NAME} source checkout.`,
    );
  if (valid(version) !== version)
    fail(
      "checkout_identity",
      `package.json version ${JSON.stringify(version)} is not an exact semantic version; restore never resolves ranges or dist-tags such as latest.`,
    );
  return { name, version };
};

const integritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u);

const parseJsonText = (text, code, what) => {
  try {
    return JSON.parse(text);
  } catch (cause) {
    return fail(code, `${what} is not JSON: ${describe(cause)}`, {}, { cause });
  }
};

const parseRegistryIntegrity = (stdout, identity, spec) => {
  const parsed = z
    .object({
      name: z.literal(identity.name),
      version: z.literal(identity.version),
      "dist.integrity": integritySchema,
    })
    .safeParse(parseJsonText(stdout, "registry_metadata", "npm view output"));
  if (!parsed.success)
    fail(
      "registry_metadata",
      `npm view did not return the identity and sha512 dist.integrity of ${spec}: ${issuesText(parsed.error)}`,
    );
  return parsed.data["dist.integrity"];
};

const parsePackResult = (stdout, identity, spec) => {
  const parsed = z
    .tuple([
      z.object({
        name: z.literal(identity.name),
        version: z.literal(identity.version),
        filename: z.string().regex(/^[^/\\]+\.tgz$/u),
        integrity: integritySchema,
      }),
    ])
    .safeParse(parseJsonText(stdout, "pack_result", "npm pack output"));
  if (!parsed.success)
    fail(
      "pack_result",
      `npm pack did not report exactly one ${spec} tarball in the private destination: ${issuesText(parsed.error)}`,
    );
  return parsed.data[0];
};

const npmErrorSummary = (stdout) => {
  if (typeof stdout !== "string" || stdout.trim() === "") return undefined;
  try {
    const parsed = z
      .object({
        error: z.object({ code: z.string(), summary: z.string().optional() }),
      })
      .safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
};

const runNpm = async (npm, arguments_, spec) => {
  try {
    return (await npm(arguments_)).stdout;
  } catch (cause) {
    const reported = npmErrorSummary(cause?.stdout);
    if (reported?.code === "E404")
      fail(
        "not_published",
        `${spec} is not published to the configured npm registry. Build the artifact with the Linux/MinGW lane in native/windows/README.md instead.`,
        {},
        { cause },
      );
    return fail(
      "npm_failed",
      `npm ${arguments_[0]} ${spec} failed: ${reported?.summary ?? describe(cause)}`,
      {},
      { cause },
    );
  }
};

const readMembers = (tarball) => {
  try {
    return readPackageTarballMembers(
      tarball,
      Object.values(MEMBERS),
      MAX_ARCHIVE_BYTES,
    );
  } catch (cause) {
    if (!(cause instanceof MalformedPackageTarballError)) throw cause;
    return fail(
      "malformed_tarball",
      `The package tarball is malformed: ${cause.message}`,
      {},
      { cause },
    );
  }
};

const requireMember = (members, path) => {
  const data = members.get(path);
  if (data === undefined)
    fail(
      "missing_artifact",
      `The package tarball has no ${path}; this release cannot restore Windows native controls.`,
    );
  return data;
};

const manifestSchema = z.strictObject({
  packageVersion: z.string(),
  platform: z.literal("win32"),
  architecture: z.literal("x64"),
  abiVersion: z.literal(1),
  nodeApiVersion: z.literal(8),
  artifact: z.literal(ARTIFACT),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

/**
 * Admit a packaged manifest with the loader's contract
 * (`windowsNativeManifestSchema`) before any bytes reach the checkout.
 */
export const parseWindowsNativeManifest = (value, version) => {
  if (!isRecord(value))
    fail("manifest_invalid", `${MANIFEST} is not a JSON object.`);
  if (value.packageVersion !== version)
    fail(
      "version_mismatch",
      `${MANIFEST} packageVersion ${describe(value.packageVersion)} does not match ${PACKAGE_NAME}@${version}.`,
    );
  if (value.platform !== "win32" || value.architecture !== "x64")
    fail(
      "architecture_mismatch",
      `${MANIFEST} declares ${describe(value.platform)}/${describe(value.architecture)}; only the win32/x64 addon is restored.`,
    );
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "manifest_invalid",
      `${MANIFEST} does not match the Windows native manifest contract: ${issuesText(parsed.error)}`,
    );
  return parsed.data;
};

const inspectWindowsX64Image = (bytes) => {
  if (bytes.length < 64 || bytes.toString("latin1", 0, 2) !== "MZ")
    fail("artifact_invalid", `${ARTIFACT} is not a PE image.`);
  const offset = bytes.readUInt32LE(0x3c);
  if (
    offset > bytes.length - 26 ||
    bytes.toString("latin1", offset, offset + 4) !== "PE\0\0"
  )
    fail("artifact_invalid", `${ARTIFACT} has no PE header.`);
  const machine = bytes.readUInt16LE(offset + 4);
  const magic = bytes.readUInt16LE(offset + 24);
  if (machine !== 0x8664 || magic !== 0x20b)
    fail(
      "architecture_mismatch",
      `${ARTIFACT} has PE machine 0x${machine.toString(16)} and optional-header magic 0x${magic.toString(16)}; expected an x86-64 PE32+ image (0x8664, 0x20b).`,
    );
  return "x86-64 PE32+";
};

const parsePackedIdentity = (bytes, identity) => {
  const value = parseJsonText(
    bytes.toString("utf8"),
    "package_identity_mismatch",
    MEMBERS.packageJson,
  );
  if (
    !isRecord(value) ||
    value.name !== identity.name ||
    value.version !== identity.version
  )
    fail(
      "package_identity_mismatch",
      `${MEMBERS.packageJson} identifies ${isRecord(value) ? `${describe(value.name)}@${describe(value.version)}` : "no package"}, not ${identity.name}@${identity.version}.`,
    );
};

/** Verify a packed tarball completely before returning bytes to install. */
const verifyTarball = (tarball, identity, registryIntegrity) => {
  const integrity = sha512Integrity(tarball);
  if (integrity !== registryIntegrity)
    fail(
      "integrity_mismatch",
      `The packed tarball integrity ${integrity} does not match the registry dist.integrity ${registryIntegrity}.`,
    );
  const members = readMembers(tarball);
  parsePackedIdentity(requireMember(members, MEMBERS.packageJson), identity);
  const manifestBytes = requireMember(members, MEMBERS.manifest);
  const manifest = parseWindowsNativeManifest(
    parseJsonText(
      manifestBytes.toString("utf8"),
      "manifest_invalid",
      MEMBERS.manifest,
    ),
    identity.version,
  );
  const artifactBytes = requireMember(members, MEMBERS.artifact);
  const artifactSha256 = sha256(artifactBytes);
  if (artifactSha256 !== manifest.artifactSha256)
    fail(
      "digest_mismatch",
      `${ARTIFACT} SHA-256 ${artifactSha256} does not match ${MANIFEST} artifactSha256 ${manifest.artifactSha256}.`,
    );
  const image = inspectWindowsX64Image(artifactBytes);
  return { integrity, manifest, manifestBytes, artifactBytes, image };
};

const lstatIfPresent = (path) =>
  lstat(path).catch((cause) => {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  });

const readArchive = async (path) => {
  const entry = await lstatIfPresent(path);
  if (entry?.isFile() !== true)
    fail("pack_result", `npm pack reported ${path}, but wrote no such file.`);
  const { size } = entry;
  if (size > MAX_ARCHIVE_BYTES)
    fail(
      "malformed_tarball",
      `The package tarball is ${size} bytes, above the ${MAX_ARCHIVE_BYTES}-byte bound.`,
    );
  return readFile(path);
};

const existingState = async (path, expected) => {
  const entry = await lstatIfPresent(path);
  if (entry === undefined) return { state: "absent" };
  if (!entry.isFile()) return { state: "unsafe" };
  const bytes = await readFile(path);
  return bytes.equals(expected)
    ? { state: "identical" }
    : { state: "different", bytes };
};

const describeExisting = ({ file, bytes }) => {
  let version = "";
  if (file === MANIFEST) {
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (isRecord(value) && typeof value.packageVersion === "string")
        version = `packageVersion ${value.packageVersion}, `;
    } catch {
      version = "unparseable JSON, ";
    }
  }
  return `${DESTINATION}/${file} (${version}SHA-256 ${sha256(bytes)})`;
};

const requireDestinationDirectory = async (directory) => {
  const entry = await lstatIfPresent(directory);
  if (entry !== undefined && !entry.isDirectory())
    fail(
      "unsafe_destination",
      `${DESTINATION} exists but is not a plain directory; remove it before restoring.`,
    );
};

const ACTIONS = {
  absent: "created",
  different: "replaced",
  identical: "unchanged",
};

/**
 * Install verified bytes atomically per file. The addon is renamed into place
 * before its manifest, so an interrupted restore leaves a pair the loader
 * rejects by digest or absence rather than a manifest naming other bytes.
 */
const installArtifacts = async (root, verified, identity, replace) => {
  const directory = join(root, ...DESTINATION.split("/"));
  await requireDestinationDirectory(directory);
  const planned = await Promise.all(
    [
      { file: ARTIFACT, expected: verified.artifactBytes },
      { file: MANIFEST, expected: verified.manifestBytes },
    ].map(async (entry) => ({
      ...entry,
      ...(await existingState(join(directory, entry.file), entry.expected)),
    })),
  );
  const unsafe = planned.filter(({ state }) => state === "unsafe");
  if (unsafe.length > 0)
    fail(
      "unsafe_destination",
      `${unsafe.map(({ file }) => `${DESTINATION}/${file}`).join(" and ")} exists but is not a regular file; remove it before restoring. Nothing was written.`,
    );
  const different = planned.filter(({ state }) => state === "different");
  if (different.length > 0 && !replace)
    fail(
      "existing_artifact_differs",
      `${different.map(describeExisting).join(" and ")} ${different.length === 1 ? "differs" : "differ"} from the verified ${identity.name}@${identity.version} files; nothing was written. Rerun with "${COMMAND} -- --replace" to replace them.`,
      { files: different.map(({ file }) => `${DESTINATION}/${file}`) },
    );
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const { file, expected, state } of planned) {
    if (state !== "identical")
      await writeFileAtomic(join(directory, file), expected, { fsync: true });
    files.push({ path: `${DESTINATION}/${file}`, action: ACTIONS[state] });
  }
  return files;
};

const defaultNpm = (root) => (arguments_) =>
  execNpm(arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

const packAndInstall = async (options) => {
  const { identity, registryIntegrity, temporary } = options;
  const spec = `${identity.name}@${identity.version}`;
  const packed = parsePackResult(
    await runNpm(
      options.npm,
      [
        "pack",
        spec,
        "--pack-destination",
        temporary,
        "--ignore-scripts",
        "--json",
      ],
      spec,
    ),
    identity,
    spec,
  );
  const tarball = await readArchive(join(temporary, packed.filename));
  const verified = verifyTarball(tarball, identity, registryIntegrity);
  if (packed.integrity !== verified.integrity)
    fail(
      "integrity_mismatch",
      `npm pack reported integrity ${packed.integrity}, but the packed bytes are ${verified.integrity}.`,
    );
  return {
    spec,
    registryIntegrity,
    tarball: { filename: packed.filename, bytes: tarball.length },
    manifest: verified.manifest,
    artifact: {
      bytes: verified.artifactBytes.length,
      sha256: verified.manifest.artifactSha256,
      image: verified.image,
    },
    files: await installArtifacts(
      options.root,
      verified,
      identity,
      options.replace,
    ),
  };
};

/**
 * Restore the Windows native controls of a source checkout from the published
 * tarball of its exact package.json version. This is a manual command; no
 * other REA workflow calls it.
 */
export const restoreWindowsNative = async ({
  root,
  replace = false,
  npm = defaultNpm(root),
  temporaryParent = tmpdir(),
}) => {
  const identity = parseCheckoutIdentity(
    parseJsonText(
      await readFile(join(root, "package.json"), "utf8"),
      "checkout_identity",
      "package.json",
    ),
  );
  const spec = `${identity.name}@${identity.version}`;
  const registryIntegrity = parseRegistryIntegrity(
    await runNpm(
      npm,
      ["view", spec, "name", "version", "dist.integrity", "--json"],
      spec,
    ),
    identity,
    spec,
  );
  const temporary = await mkdtemp(
    join(temporaryParent, "rea-windows-native-restore-"),
  );
  let report;
  try {
    const options = { root, replace, npm, identity, registryIntegrity };
    report = await packAndInstall({ ...options, temporary });
  } catch (cause) {
    const cleanup = await removeDownload(temporary);
    if (cleanup === undefined) throw cause;
    if (!(cause instanceof WindowsNativeRestoreError))
      throw new AggregateError([cause, cleanup.cause], cleanup.message);
    cause.message += ` ${cleanup.message}`;
    cause.details = { ...cause.details, retainedDownload: temporary };
    throw cause;
  }
  const cleanup = await removeDownload(temporary);
  return cleanup === undefined
    ? report
    : { ...report, retainedDownload: cleanup.message };
};

const removeDownload = (path) =>
  rm(path, { recursive: true, force: true, maxRetries: 3 }).then(
    () => undefined,
    (cause) => ({
      cause,
      message: `The restore download directory ${path} was retained because removing it failed: ${describe(cause)}`,
    }),
  );

/** Describe exactly what was verified and what changed in the checkout. */
export const formatRestoreReport = (report) => {
  const changed = report.files.some(({ action }) => action !== "unchanged");
  const lines = [
    changed
      ? `Restored Windows native controls for ${report.spec}.`
      : `Windows native controls for ${report.spec} are already present; nothing was written.`,
    "Verified:",
    `  checkout version    ${report.manifest.packageVersion} (exact package.json version; dist-tags are never used)`,
    `  registry integrity  ${report.registryIntegrity} (npm view ${report.spec} dist.integrity)`,
    `  tarball integrity   matches registry and npm pack (${report.tarball.filename}, ${report.tarball.bytes} bytes)`,
    `  packed package      ${report.spec}`,
    `  manifest            packageVersion ${report.manifest.packageVersion}, ${report.manifest.platform}/${report.manifest.architecture}, abiVersion ${report.manifest.abiVersion}, nodeApiVersion ${report.manifest.nodeApiVersion}`,
    `  addon SHA-256       ${report.artifact.sha256} matches manifest.artifactSha256 (${report.artifact.bytes} bytes)`,
    `  addon image         ${report.artifact.image}`,
    "Files:",
    ...report.files.map(({ path, action }) => `  ${path}  ${action}`),
  ];
  return `${lines.join("\n")}\n`;
};
