import { err, ok, type Result } from "../result.js";

/**
 * Root `<manifest>` declarations that establish an APK's role in a split set.
 * Values are read from the compiled binary manifest; `null` means the
 * attribute was absent or its compiled value type does not carry the fact.
 */
export interface AndroidManifestRootDeclarations {
  readonly packageName: string | null;
  /** The `split` attribute; Android treats an empty name as absent (base APK). */
  readonly splitName: string | null;
  readonly configForSplit: string | null;
  readonly isFeatureSplit: boolean | null;
  readonly versionCode: string | null;
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const CHUNK_HEADER_BYTES = 8;
const STRING_POOL_HEADER_BYTES = 28;
const XML_NODE_HEADER_BYTES = 16;
const XML_ATTRIBUTE_EXTENSION_BYTES = 20;
const XML_ATTRIBUTE_BYTES = 20;
const NO_INDEX = 0xffff_ffff;
const UTF8_FLAG = 0x100;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";
/** `android.R.attr.versionCode` and `android.R.attr.isFeatureSplit`. */
const VERSION_CODE_ATTRIBUTE = 0x0101_021b;
const IS_FEATURE_SPLIT_ATTRIBUTE = 0x0101_055b;
/**
 * Package, split and version declarations are short identifiers; package and
 * split names also name installed files. A string pool entry can still span
 * the whole manifest, so a longer declaration is refused instead of being
 * retained and reported for every member of a container.
 */
export const MAX_MANIFEST_DECLARATION_UNITS = 1_024;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF16 = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });

class BinaryManifestFailure extends Error {}

function fail(message: string): never {
  throw new BinaryManifestFailure(message);
}

interface Chunk {
  readonly offset: number;
  readonly type: number;
  readonly headerSize: number;
  readonly size: number;
}

class ManifestBytes {
  readonly #view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #require(offset: number, length: number, limit: number): void {
    if (offset < 0 || offset + length > limit)
      fail(`binary manifest is truncated at byte ${String(offset)}`);
  }

  u8(offset: number, limit: number): number {
    this.#require(offset, 1, limit);
    return this.#view.getUint8(offset);
  }

  u16(offset: number, limit: number): number {
    this.#require(offset, 2, limit);
    return this.#view.getUint16(offset, true);
  }

  u32(offset: number, limit: number): number {
    this.#require(offset, 4, limit);
    return this.#view.getUint32(offset, true);
  }

  chunk(offset: number, limit: number): Chunk {
    const type = this.u16(offset, limit);
    const headerSize = this.u16(offset + 2, limit);
    const size = this.u32(offset + 4, limit);
    if (
      headerSize < CHUNK_HEADER_BYTES ||
      size < headerSize ||
      offset + size > limit
    )
      fail(
        `binary manifest chunk 0x${type.toString(16)} at byte ${String(offset)} has invalid bounds`,
      );
    return { offset, type, headerSize, size };
  }
}

/** Lazily decoded strings of one string-pool chunk. */
class StringPool {
  readonly #strings = new Map<number, string>();
  readonly #count: number;
  readonly #offsets: number;
  readonly #dataStart: number;
  readonly #dataEnd: number;
  readonly #utf8: boolean;

  constructor(
    private readonly bytes: ManifestBytes,
    chunk: Chunk,
  ) {
    if (chunk.headerSize < STRING_POOL_HEADER_BYTES)
      fail("binary manifest string pool header is too small");
    const end = chunk.offset + chunk.size;
    this.#count = bytes.u32(chunk.offset + 8, end);
    const styleCount = bytes.u32(chunk.offset + 12, end);
    const flags = bytes.u32(chunk.offset + 16, end);
    const stringsStart = bytes.u32(chunk.offset + 20, end);
    const stylesStart = bytes.u32(chunk.offset + 24, end);
    this.#offsets = chunk.offset + chunk.headerSize;
    if (
      chunk.headerSize + (this.#count + styleCount) * 4 > chunk.size ||
      stringsStart > chunk.size ||
      (this.#count > 0 && stringsStart === 0)
    )
      fail("binary manifest string pool offsets exceed its chunk");
    this.#utf8 = (flags & UTF8_FLAG) !== 0;
    this.#dataStart = chunk.offset + stringsStart;
    this.#dataEnd =
      styleCount > 0 && stylesStart > stringsStart && stylesStart <= chunk.size
        ? chunk.offset + stylesStart
        : end;
  }

  get(index: number): string {
    const cached = this.#strings.get(index);
    if (cached !== undefined) return cached;
    if (index >= this.#count)
      fail(`binary manifest string index ${String(index)} is out of range`);
    const start =
      this.#dataStart +
      this.bytes.u32(
        this.#offsets + index * 4,
        this.#offsets + this.#count * 4,
      );
    const value = this.#utf8 ? this.#utf8At(start) : this.#utf16At(start);
    this.#strings.set(index, value);
    return value;
  }

  #utf8At(start: number): string {
    const end = this.#dataEnd;
    const [, afterCharacters] = this.#utf8Length(start, end);
    const [byteLength, dataStart] = this.#utf8Length(afterCharacters, end);
    if (dataStart + byteLength >= end)
      fail("binary manifest UTF-8 string exceeds its string pool");
    try {
      return UTF8.decode(
        this.bytes.bytes.subarray(dataStart, dataStart + byteLength),
      );
    } catch {
      return fail("binary manifest string is not valid UTF-8");
    }
  }

  #utf8Length(offset: number, end: number): readonly [number, number] {
    const first = this.bytes.u8(offset, end);
    if ((first & 0x80) === 0) return [first, offset + 1];
    return [((first & 0x7f) << 8) | this.bytes.u8(offset + 1, end), offset + 2];
  }

  #utf16At(start: number): string {
    const end = this.#dataEnd;
    const first = this.bytes.u16(start, end);
    const [units, dataStart] =
      (first & 0x8000) === 0
        ? [first, start + 2]
        : [
            ((first & 0x7fff) << 16) | this.bytes.u16(start + 2, end),
            start + 4,
          ];
    if (dataStart + units * 2 + 2 > end)
      fail("binary manifest UTF-16 string exceeds its string pool");
    try {
      return UTF16.decode(
        this.bytes.bytes.subarray(dataStart, dataStart + units * 2),
      );
    } catch {
      return fail("binary manifest string is not valid UTF-16");
    }
  }
}

type DeclarationKey =
  | "package"
  | "split"
  | "configForSplit"
  | "isFeatureSplit"
  | "versionCode";

const declarationKey = (
  namespace: string | null,
  name: string,
  resourceId: number | undefined,
): DeclarationKey | undefined => {
  if (
    resourceId === VERSION_CODE_ATTRIBUTE ||
    (namespace === ANDROID_NAMESPACE && name === "versionCode")
  )
    return "versionCode";
  if (
    resourceId === IS_FEATURE_SPLIT_ATTRIBUTE ||
    (namespace === ANDROID_NAMESPACE && name === "isFeatureSplit")
  )
    return "isFeatureSplit";
  if (namespace !== null) return undefined;
  if (name === "package" || name === "split" || name === "configForSplit")
    return name;
  return undefined;
};

interface AttributeRecord {
  readonly namespaceIndex: number;
  readonly nameIndex: number;
  readonly rawValue: number;
  readonly dataType: number;
  readonly data: number;
}

const readAttribute = (
  bytes: ManifestBytes,
  offset: number,
  end: number,
): AttributeRecord => {
  bytes.u32(offset + XML_ATTRIBUTE_BYTES - 4, end);
  const nameIndex = bytes.u32(offset + 4, end);
  if (nameIndex === NO_INDEX)
    fail("binary manifest <manifest> attribute has no name");
  return {
    namespaceIndex: bytes.u32(offset, end),
    nameIndex,
    rawValue: bytes.u32(offset + 8, end),
    dataType: bytes.u8(offset + 15, end),
    data: bytes.u32(offset + 16, end),
  };
};

/** Interpret one compiled attribute value for the declaration it carries. */
const declarationValue = (
  key: DeclarationKey,
  { rawValue, dataType, data }: AttributeRecord,
  pool: StringPool,
): string | boolean | null => {
  const text =
    dataType === TYPE_STRING
      ? pool.get(data)
      : rawValue === NO_INDEX
        ? null
        : pool.get(rawValue);
  if (key === "isFeatureSplit")
    return dataType === TYPE_INT_BOOLEAN ? data !== 0 : null;
  if (
    key === "versionCode" &&
    (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX)
  )
    return String(data | 0);
  if (key === "split" && text === null)
    fail("binary manifest split attribute is not a string value");
  if (text !== null && text.length > MAX_MANIFEST_DECLARATION_UNITS)
    fail(
      `binary manifest <manifest> ${key} declaration exceeds ${String(MAX_MANIFEST_DECLARATION_UNITS)} UTF-16 code units`,
    );
  return text;
};

const declarations = (
  values: ReadonlyMap<DeclarationKey, string | boolean | null>,
): AndroidManifestRootDeclarations => {
  const text = (key: DeclarationKey): string | null => {
    const value = values.get(key);
    return typeof value === "string" ? value : null;
  };
  const optionalName = (key: DeclarationKey): string | null => {
    const value = text(key);
    return value === "" ? null : value;
  };
  const featureSplit = values.get("isFeatureSplit");
  return {
    packageName: text("package"),
    splitName: optionalName("split"),
    configForSplit: optionalName("configForSplit"),
    isFeatureSplit: typeof featureSplit === "boolean" ? featureSplit : null,
    versionCode: text("versionCode"),
  };
};

const parseRootElement = (
  bytes: ManifestBytes,
  chunk: Chunk,
  pool: StringPool,
  resourceIds: readonly number[],
): AndroidManifestRootDeclarations => {
  const end = chunk.offset + chunk.size;
  if (chunk.headerSize < XML_NODE_HEADER_BYTES)
    fail("binary manifest element header is too small");
  const extension = chunk.offset + chunk.headerSize;
  bytes.u32(extension + XML_ATTRIBUTE_EXTENSION_BYTES - 4, end);
  const elementName = bytes.u32(extension + 4, end);
  if (elementName === NO_INDEX || pool.get(elementName) !== "manifest")
    fail("binary manifest root element is not <manifest>");
  const attributeStart = bytes.u16(extension + 8, end);
  const attributeSize = bytes.u16(extension + 10, end);
  const attributeCount = bytes.u16(extension + 12, end);
  if (attributeCount > 0 && attributeSize < XML_ATTRIBUTE_BYTES)
    fail("binary manifest attribute records are too small");
  const values = new Map<DeclarationKey, string | boolean | null>();
  for (let index = 0; index < attributeCount; index += 1) {
    const record = readAttribute(
      bytes,
      extension + attributeStart + index * attributeSize,
      end,
    );
    const key = declarationKey(
      record.namespaceIndex === NO_INDEX
        ? null
        : pool.get(record.namespaceIndex),
      pool.get(record.nameIndex),
      resourceIds[record.nameIndex],
    );
    if (key === undefined) continue;
    if (values.has(key))
      fail(`binary manifest <manifest> declares ${key} more than once`);
    values.set(key, declarationValue(key, record, pool));
  }
  return declarations(values);
};

const parseManifest = (input: Uint8Array): AndroidManifestRootDeclarations => {
  const bytes = new ManifestBytes(input);
  if (bytes.u16(0, input.byteLength) !== RES_XML_TYPE)
    fail("file is not an Android binary XML document");
  const document = bytes.chunk(0, input.byteLength);
  const end = document.size;
  let pool: StringPool | undefined;
  let resourceIds: number[] = [];
  for (let offset = document.headerSize; offset < end;) {
    const chunk = bytes.chunk(offset, end);
    if (chunk.type === RES_STRING_POOL_TYPE) {
      if (pool !== undefined)
        fail("binary manifest declares more than one string pool");
      pool = new StringPool(bytes, chunk);
    } else if (chunk.type === RES_XML_RESOURCE_MAP_TYPE) {
      const count = Math.floor((chunk.size - chunk.headerSize) / 4);
      const chunkEnd = chunk.offset + chunk.size;
      resourceIds = Array.from({ length: count }, (_, index) =>
        bytes.u32(chunk.offset + chunk.headerSize + index * 4, chunkEnd),
      );
    } else if (chunk.type === RES_XML_START_ELEMENT_TYPE) {
      if (pool === undefined)
        fail("binary manifest root element precedes its string pool");
      return parseRootElement(bytes, chunk, pool, resourceIds);
    }
    offset += chunk.size;
  }
  return fail("binary manifest has no root element");
};

/**
 * Read the root `<manifest>` declarations of a compiled AndroidManifest.xml.
 * Only the first element is interpreted; every read is bounds-checked and a
 * malformed document reports its reason instead of a partial declaration.
 */
export const parseAndroidManifestRoot = (
  bytes: Uint8Array,
): Result<AndroidManifestRootDeclarations, string> => {
  try {
    return ok(parseManifest(bytes));
  } catch (cause: unknown) {
    if (cause instanceof BinaryManifestFailure) return err(cause.message);
    throw cause;
  }
};
