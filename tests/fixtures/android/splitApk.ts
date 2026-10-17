import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";
const NO_INDEX = 0xffff_ffff;

/** One root `<manifest>` attribute compiled into the synthetic document. */
export interface ManifestAttribute {
  readonly name: string;
  readonly value: string | boolean | number;
  /** Compile under the android namespace with this framework resource id. */
  readonly androidResourceId?: number;
  /** Omit the attribute name string, as resource-id-only obfuscation does. */
  readonly anonymous?: boolean;
}

/** Root declarations of a synthetic split APK manifest. */
export interface SplitManifest {
  readonly packageName?: string;
  readonly split?: string;
  readonly configForSplit?: string;
  readonly isFeatureSplit?: boolean;
  readonly versionCode?: number;
}

export const VERSION_CODE_ATTRIBUTE = 0x0101_021b;
export const IS_FEATURE_SPLIT_ATTRIBUTE = 0x0101_055b;

const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};
const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
};
const chunk = (type: number, header: Buffer, body: Buffer): Buffer =>
  Buffer.concat([
    u16(type),
    u16(8 + header.length),
    u32(8 + header.length + body.length),
    header,
    body,
  ]);

const encodeString = (value: string, utf8: boolean): Buffer => {
  if (utf8) {
    const bytes = Buffer.from(value, "utf8");
    if (value.length > 0x7f || bytes.length > 0x7f)
      throw new Error("Fixture UTF-8 strings must stay below 128 bytes");
    return Buffer.concat([
      Buffer.from([value.length, bytes.length]),
      bytes,
      Buffer.from([0]),
    ]);
  }
  return Buffer.concat([
    u16(value.length),
    Buffer.from(value, "utf16le"),
    u16(0),
  ]);
};

const stringPool = (strings: readonly string[], utf8: boolean): Buffer => {
  const encoded = strings.map((value) => encodeString(value, utf8));
  const offsets: number[] = [];
  let offset = 0;
  for (const value of encoded) {
    offsets.push(offset);
    offset += value.length;
  }
  const data = Buffer.concat(encoded);
  const padded = Buffer.concat([
    data,
    Buffer.alloc((4 - (data.length % 4)) % 4),
  ]);
  return chunk(
    0x0001,
    Buffer.concat([
      u32(strings.length),
      u32(0),
      u32(utf8 ? 0x100 : 0),
      u32(28 + strings.length * 4),
      u32(0),
    ]),
    Buffer.concat([...offsets.map(u32), padded]),
  );
};

/**
 * Compile a minimal Android binary XML manifest with the same chunk layout
 * aapt emits: string pool, resource map, namespace, then the root element.
 */
export const compileBinaryManifest = (
  attributes: readonly ManifestAttribute[],
  options: { readonly utf8?: boolean; readonly rootElement?: string } = {},
): Buffer => {
  const mapped = attributes.filter(
    (attribute) => attribute.androidResourceId !== undefined,
  );
  const plain = attributes.filter(
    (attribute) => attribute.androidResourceId === undefined,
  );
  // Resource-mapped attribute names come first so the map indexes align.
  const strings = [
    ...mapped.map((attribute) => (attribute.anonymous ? "" : attribute.name)),
    "android",
    ANDROID_NAMESPACE,
    options.rootElement ?? "manifest",
    ...plain.map((attribute) => attribute.name),
  ];
  const index = (value: string): number => {
    const found = strings.indexOf(value);
    if (found !== -1) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const records = [...mapped, ...plain].map((attribute, position) => {
    const name = position < mapped.length ? position : index(attribute.name);
    const namespace =
      attribute.androidResourceId === undefined
        ? NO_INDEX
        : index(ANDROID_NAMESPACE);
    const { value } = attribute;
    const [raw, type, data] =
      typeof value === "string"
        ? [index(value), 0x03, index(value)]
        : typeof value === "boolean"
          ? [NO_INDEX, 0x12, value ? 0xffff_ffff : 0]
          : [NO_INDEX, 0x10, value];
    return Buffer.concat([
      u32(namespace),
      u32(name),
      u32(raw),
      u16(8),
      Buffer.from([0, type]),
      u32(data),
    ]);
  });
  const prefix = index("android");
  const uri = index(ANDROID_NAMESPACE);
  const element = index(options.rootElement ?? "manifest");
  const node = (line: number) => Buffer.concat([u32(line), u32(NO_INDEX)]);
  const body = Buffer.concat([
    stringPool(strings, options.utf8 ?? false),
    chunk(
      0x0180,
      Buffer.alloc(0),
      Buffer.concat(
        mapped.map((attribute) => u32(attribute.androidResourceId!)),
      ),
    ),
    chunk(0x0100, node(1), Buffer.concat([u32(prefix), u32(uri)])),
    chunk(
      0x0102,
      node(1),
      Buffer.concat([
        u32(NO_INDEX),
        u32(element),
        u16(20),
        u16(20),
        u16(records.length),
        u16(0),
        u16(0),
        u16(0),
        ...records,
      ]),
    ),
    chunk(0x0103, node(2), Buffer.concat([u32(NO_INDEX), u32(element)])),
    chunk(0x0101, node(2), Buffer.concat([u32(prefix), u32(uri)])),
  ]);
  return chunk(0x0003, Buffer.alloc(0), body);
};

/** Compile the root declarations that identify a split APK's role. */
export const compileSplitManifest = (
  manifest: SplitManifest,
  options: { readonly utf8?: boolean } = {},
): Buffer =>
  compileBinaryManifest(
    [
      ...(manifest.versionCode === undefined
        ? []
        : [
            {
              name: "versionCode",
              value: manifest.versionCode,
              androidResourceId: VERSION_CODE_ATTRIBUTE,
            },
          ]),
      ...(manifest.isFeatureSplit === undefined
        ? []
        : [
            {
              name: "isFeatureSplit",
              value: manifest.isFeatureSplit,
              androidResourceId: IS_FEATURE_SPLIT_ATTRIBUTE,
            },
          ]),
      { name: "package", value: manifest.packageName ?? "com.example.split" },
      ...(manifest.split === undefined
        ? []
        : [{ name: "split", value: manifest.split }]),
      ...(manifest.configForSplit === undefined
        ? []
        : [{ name: "configForSplit", value: manifest.configForSplit }]),
    ],
    options,
  );

/** Write real ZIP bytes with caller-selected names and contents. */
export const zipBytes = async (
  entries: readonly {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly store?: boolean;
  }[],
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const entry of entries)
    await writer.add(entry.name, new Uint8ArrayReader(entry.bytes), {
      lastModDate: new Date("2020-01-01T00:00:00Z"),
      level: entry.store === true ? 0 : 6,
    });
  return writer.close();
};

/** A synthetic APK: a ZIP with a compiled root manifest and a DEX placeholder. */
export const splitApkBytes = (
  manifest: SplitManifest | Uint8Array,
): Promise<Uint8Array> =>
  zipBytes([
    {
      name: "AndroidManifest.xml",
      bytes:
        manifest instanceof Uint8Array
          ? manifest
          : compileSplitManifest(manifest),
    },
    { name: "classes.dex", bytes: Buffer.from("dex\n035\0fixture") },
  ]);

/** Write a split set either as one stored ZIP container or as a directory. */
export const writeSplitSet = async (
  path: string,
  members: Readonly<Record<string, Uint8Array>>,
  layout: "zip" | "directory",
  extra: Readonly<Record<string, Uint8Array>> = {},
): Promise<void> => {
  const files = { ...members, ...extra };
  if (layout === "directory") {
    await mkdir(path, { recursive: true });
    for (const [name, bytes] of Object.entries(files))
      await writeFile(join(path, name), bytes);
    return;
  }
  await writeFile(
    path,
    await zipBytes(
      Object.entries(files).map(([name, bytes]) => ({
        name,
        bytes,
        store: true,
      })),
    ),
  );
};
