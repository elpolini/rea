import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { createWriteStream } from "node:fs";
import { chmod, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../../artifacts/ArtifactReader.js";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import { ZipArtifactReader } from "../../artifacts/ZipArtifactReader.js";
import {
  parseAndroidManifestRoot,
  type AndroidManifestRootDeclarations,
} from "../../domain/android/androidBinaryManifest.js";
import {
  hasAndroidSplitContainerSuffix,
  isAndroidApkMemberName,
  type AndroidContainerMemberObservation,
} from "../../domain/android/androidInputContainer.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
  type ZipPackageFormat,
} from "../../domain/zipPackageFormat.js";
import {
  assertRegularFileActive,
  RegularFileChangedError,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import type {
  AdmittedContainerFile,
  AndroidContainerResources,
} from "./AndroidInputContainerResources.js";

/** Bound each ZIP central-directory read before allocating it. */
export const CONTAINER_METADATA_READ_MAX_BYTES = 16 * 1024 * 1024;
/** Compiled manifests are far smaller; larger members are refused unread. */
const MEMBER_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
/** Each APK member is extracted, hashed and opened; bound that work. */
const MAX_CONTAINER_APK_MEMBERS = 512;
/** Directory inputs are scanned without recursion up to this many entries. */
const MAX_CONTAINER_DIRECTORY_ENTRIES = 10_000;
const HASH_CHUNK_BYTES = 64 * 1024;
const ROOT_MANIFEST = "AndroidManifest.xml";

/** A caller-correctable or bounded refusal of one container. */
export class AndroidContainerRefusal extends Error {
  constructor(
    readonly kind: "input" | "limit",
    message: string,
    readonly limits: Readonly<Record<string, number>> = {},
  ) {
    super(message);
    this.name = "AndroidContainerRefusal";
  }
}

/** One APK member with the local file that holds its admitted bytes. */
export interface ResolvedContainerMember extends AndroidContainerMemberObservation {
  readonly localPath: string;
}

/** Observed container identity and its APK members, before base selection. */
export interface ResolvedAndroidContainer {
  readonly kind: "zip" | "directory";
  readonly path: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly format: ZipPackageFormat | null;
  readonly members: readonly ResolvedContainerMember[];
  readonly otherEntryCount: number;
}

interface ReadContext {
  readonly resources: AndroidContainerResources;
  readonly signal: AbortSignal | undefined;
}

function refuse(message: string): never {
  throw new AndroidContainerRefusal("input", message);
}

/** Hash an admitted descriptor up to its admitted size; truncation is a change. */
const hashAdmittedFile = async (
  file: AdmittedContainerFile,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  while (position < file.initial.size) {
    assertRegularFileActive(signal);
    const read = await file.handle.read(
      chunk,
      0,
      Math.min(chunk.length, file.initial.size - position),
      position,
    );
    if (read.bytesRead === 0) throw new RegularFileChangedError(path);
    hash.update(chunk.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  assertRegularFileActive(signal);
  return hash.digest("hex");
};

/** Bind every read of one descriptor to the state admitted before reading. */
const verifyUnchanged = async (
  file: AdmittedContainerFile,
  path: string,
): Promise<void> => {
  const [opened, named] = await Promise.all([file.handle.stat(), stat(path)]);
  if (
    !sameRegularFileState(file.initial, opened) ||
    !sameRegularFileState(file.initial, named)
  )
    throw new RegularFileChangedError(path);
};

const readEntryBytes = async (
  stream: Readable,
  declaredSize: number,
): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > declaredSize)
      throw new ArtifactReaderFailure(
        "integrity",
        "ZIP member produced more bytes than it declared",
      );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
};

/** Read and interpret the root binary manifest of one admitted APK file. */
const readMemberManifest = async (
  file: AdmittedContainerFile,
  path: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<AndroidManifestRootDeclarations> => {
  const reader = new ZipArtifactReader(
    path,
    "apk",
    CONTAINER_METADATA_READ_MAX_BYTES,
    { handle: file.handle, initial: file.initial },
  );
  try {
    const manifests: ArtifactEntry[] = [];
    for await (const entry of reader.entries(signal))
      if (entry.path === ROOT_MANIFEST) manifests.push(entry);
    const manifest = manifests[0];
    if (manifest === undefined || manifests.length > 1)
      refuse(
        `APK member ${label} has ${manifest === undefined ? "no" : "more than one"} root ${ROOT_MANIFEST}`,
      );
    if (manifest.kind !== "file" || manifest.encrypted)
      refuse(`APK member ${label} has an unreadable root ${ROOT_MANIFEST}`);
    const declared = manifest.declaredSize ?? Number.POSITIVE_INFINITY;
    if (declared > MEMBER_MANIFEST_MAX_BYTES)
      throw new AndroidContainerRefusal(
        "limit",
        `APK member ${label} declares a ${String(declared)}-byte ${ROOT_MANIFEST}, above the ${String(MEMBER_MANIFEST_MAX_BYTES)}-byte manifest budget`,
        { max_manifest_bytes: MEMBER_MANIFEST_MAX_BYTES },
      );
    const parsed = parseAndroidManifestRoot(
      await readEntryBytes(await reader.open(manifest, signal), declared),
    );
    if (!parsed.ok)
      refuse(`APK member ${label} has an unreadable manifest: ${parsed.error}`);
    return parsed.value;
  } finally {
    await reader.close();
  }
};

/** Extract one ZIP member to an exclusive private file while hashing it. */
const extractMember = async (
  reader: ZipArtifactReader,
  entry: ArtifactEntry,
  destination: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const declared = entry.declaredSize;
  if (declared === null) refuse(`APK member ${entry.path} has no size`);
  const hash = createHash("sha256");
  let bytes = 0;
  const digest = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      done: TransformCallback,
    ) {
      bytes += chunk.length;
      if (bytes > declared) {
        done(
          new ArtifactReaderFailure(
            "integrity",
            `ZIP member ${entry.path} produced more bytes than it declared`,
          ),
        );
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(
    await reader.open(entry, signal),
    digest,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    signal === undefined ? {} : { signal },
  );
  if (bytes !== declared)
    throw new ArtifactReaderFailure(
      "integrity",
      `ZIP member ${entry.path} produced ${String(bytes)} of ${String(declared)} declared bytes`,
    );
  await chmod(destination, 0o400);
  return { sha256: hash.digest("hex"), bytes };
};

interface ZipScan {
  readonly rootManifest: boolean;
  readonly apkEntries: readonly ArtifactEntry[];
  readonly otherEntryCount: number;
}

/** Classify a ZIP by its own entries: an APK has a root manifest. */
const scanZip = async (
  reader: ZipArtifactReader,
  signal: AbortSignal | undefined,
): Promise<ZipScan> => {
  const apkEntries: ArtifactEntry[] = [];
  let otherEntryCount = 0;
  for await (const entry of reader.entries(signal)) {
    if (entry.path === ROOT_MANIFEST)
      return { rootManifest: true, apkEntries, otherEntryCount };
    if (entry.kind === "directory") continue;
    if (isAndroidApkMemberName(entry.path)) apkEntries.push(entry);
    else otherEntryCount += 1;
  }
  return { rootManifest: false, apkEntries, otherEntryCount };
};

const admitApkEntries = (entries: readonly ArtifactEntry[]): void => {
  if (entries.length > MAX_CONTAINER_APK_MEMBERS)
    throw new AndroidContainerRefusal(
      "limit",
      `The container holds ${String(entries.length)} APK members, above the ${String(MAX_CONTAINER_APK_MEMBERS)}-member bound`,
      { max_apk_members: MAX_CONTAINER_APK_MEMBERS },
    );
  const names = new Set<string>();
  for (const entry of entries) {
    try {
      normalizeArtifactPath(entry.path);
    } catch {
      refuse(`APK member name ${JSON.stringify(entry.path)} is unsafe`);
    }
    if (entry.kind !== "file")
      refuse(`APK member ${entry.path} is not a regular file`);
    if (entry.encrypted) refuse(`APK member ${entry.path} is encrypted`);
    if (names.has(entry.path))
      refuse(`APK member ${entry.path} appears more than once`);
    names.add(entry.path);
  }
};

/** Extract and interpret every APK member of a classified split container. */
const readZipMembers = async (
  source: {
    readonly reader: ZipArtifactReader;
    readonly container: AdmittedContainerFile;
    readonly path: string;
  },
  scan: ZipScan,
  { resources, signal }: ReadContext,
): Promise<{
  readonly sha256: string;
  readonly members: ResolvedContainerMember[];
}> => {
  const { reader, container, path } = source;
  admitApkEntries(scan.apkEntries);
  const sha256 = await hashAdmittedFile(container, path, signal);
  const workspace = await resources.workspace();
  const members: ResolvedContainerMember[] = [];
  for (const [index, entry] of scan.apkEntries.entries()) {
    const localPath = join(workspace, `member-${String(index)}.apk`);
    const extracted = await extractMember(reader, entry, localPath, signal);
    const file = await resources.open(localPath, signal);
    const manifest = await readMemberManifest(
      file,
      localPath,
      entry.path,
      signal,
    );
    await resources.close(file);
    members.push({ entry: entry.path, ...extracted, manifest, localPath });
  }
  await verifyUnchanged(container, path);
  return { sha256, members };
};

/**
 * Resolve a regular file. Returns undefined when the file is not a split
 * container (including a standalone APK), so the provider admits it as before.
 */
export const readZipContainer = async (
  candidate: string,
  context: ReadContext,
): Promise<ResolvedAndroidContainer | undefined> => {
  const { resources, signal } = context;
  const path = await realpath(candidate);
  const container = await resources.open(path, signal);
  const prefix = Buffer.alloc(4);
  const { bytesRead } = await container.handle.read(prefix, 0, 4, 0);
  if (!hasZipSignature(prefix.subarray(0, bytesRead))) return undefined;
  const named = hasAndroidSplitContainerSuffix(path);
  const format = zipPackageFormatForPath(path) ?? "zip";
  const reader = new ZipArtifactReader(
    path,
    format,
    CONTAINER_METADATA_READ_MAX_BYTES,
    { handle: container.handle, initial: container.initial },
  );
  let resolved: ResolvedAndroidContainer | undefined;
  try {
    let scan: ZipScan;
    try {
      scan = await scanZip(reader, signal);
    } catch (cause: unknown) {
      // Keep pre-existing APK admission for ZIPs not named as split sets.
      if (
        !named &&
        cause instanceof ArtifactReaderFailure &&
        cause.reason !== "cancelled"
      )
        return undefined;
      throw cause;
    }
    if (scan.rootManifest) return undefined;
    if (scan.apkEntries.length === 0) {
      if (!named) return undefined;
      refuse(`Split APK container ${path} holds no APK members`);
    }
    const { sha256, members } = await readZipMembers(
      { reader, container, path },
      scan,
      context,
    );
    resolved = {
      kind: "zip",
      path,
      sha256,
      bytes: container.initial.size,
      format,
      members,
      otherEntryCount: scan.otherEntryCount,
    };
  } finally {
    await reader.close();
  }
  // Release the container descriptor before its members are analyzed.
  await resources.close(container);
  return resolved;
};

const listDirectoryApks = async (
  path: string,
  { resources, signal }: ReadContext,
): Promise<{ readonly names: string[]; readonly otherEntryCount: number }> => {
  const directory = await resources.openDirectory(path);
  const names: string[] = [];
  let otherEntryCount = 0;
  for (let seen = 0; ; seen += 1) {
    assertRegularFileActive(signal);
    const entry = await directory.handle.read();
    if (entry === null) break;
    if (seen >= MAX_CONTAINER_DIRECTORY_ENTRIES)
      throw new AndroidContainerRefusal(
        "limit",
        `Directory ${path} has more than ${String(MAX_CONTAINER_DIRECTORY_ENTRIES)} entries`,
        { max_directory_entries: MAX_CONTAINER_DIRECTORY_ENTRIES },
      );
    if (!isAndroidApkMemberName(entry.name)) {
      otherEntryCount += 1;
      continue;
    }
    if (!entry.isFile())
      refuse(`APK member ${entry.name} in ${path} is not a regular file`);
    names.push(entry.name);
    if (names.length > MAX_CONTAINER_APK_MEMBERS)
      throw new AndroidContainerRefusal(
        "limit",
        `Directory ${path} holds more than ${String(MAX_CONTAINER_APK_MEMBERS)} APK files`,
        { max_apk_members: MAX_CONTAINER_APK_MEMBERS },
      );
  }
  await resources.closeDirectory(directory);
  return { names: names.sort(compareUnicodeCodePoints), otherEntryCount };
};

/** Resolve the APK files directly inside a directory, without recursion. */
export const readDirectoryContainer = async (
  candidate: string,
  context: ReadContext,
): Promise<ResolvedAndroidContainer> => {
  const { resources, signal } = context;
  const path = await realpath(candidate);
  const { names, otherEntryCount } = await listDirectoryApks(path, context);
  if (names.length === 0) refuse(`Directory ${path} holds no APK files`);
  const members: ResolvedContainerMember[] = [];
  for (const name of names) {
    const localPath = join(path, name);
    const file = await resources.open(localPath, signal);
    const sha256 = await hashAdmittedFile(file, localPath, signal);
    const manifest = await readMemberManifest(file, localPath, name, signal);
    await verifyUnchanged(file, localPath);
    await resources.close(file);
    members.push({
      entry: name,
      bytes: file.initial.size,
      sha256,
      manifest,
      localPath,
    });
  }
  return {
    kind: "directory",
    path,
    sha256: null,
    bytes: null,
    format: null,
    members,
    otherEntryCount,
  };
};

/** Whether a selected path's metadata can name a container at all. */
export const containerCandidateKind = async (
  candidate: string,
): Promise<"file" | "directory" | undefined> => {
  let metadata: Stats;
  try {
    metadata = await stat(candidate);
  } catch {
    // The provider's own admission reports missing or unreadable selections.
    return undefined;
  }
  if (metadata.isDirectory()) return "directory";
  return metadata.isFile() ? "file" : undefined;
};
