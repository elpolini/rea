import { gunzipSync } from "node:zlib";

const TAR_BLOCK = 512;

/** A package tarball that is not a well-formed gzip-compressed ustar stream. */
export class MalformedPackageTarballError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "MalformedPackageTarballError";
  }
}

const malformed = (message) => {
  throw new MalformedPackageTarballError(message);
};

const tarField = (block, start, length) => {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString("utf8");
};

const tarOctal = (block, start, length, what) => {
  if (((block[start] ?? 0) & 0x80) !== 0)
    malformed(`${what} uses an unsupported base-256 encoding`);
  const text = tarField(block, start, length).trim();
  if (!/^[0-7]+$/u.test(text)) malformed(`${what} is not an octal number`);
  return Number.parseInt(text, 8);
};

const tarChecksum = (block) => {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index++)
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  return sum;
};

const paxRecords = (data) => {
  const records = new Map();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = space === -1 ? "" : data.toString("latin1", offset, space);
    if (!/^[1-9][0-9]*$/u.test(length)) malformed("pax record has no length");
    const end = offset + Number(length);
    if (end > data.length || data[end - 1] !== 0x0a)
      malformed("pax record exceeds its header");
    const record = data.toString("utf8", space + 1, end - 1);
    const equals = record.indexOf("=");
    if (equals <= 0) malformed("pax record has no keyword");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return records;
};

const tarHeaderPath = (header) => {
  const name = tarField(header, 0, 100);
  // POSIX ustar splits long names; GNU tar uses these bytes for other fields.
  const prefix =
    header.toString("latin1", 257, 263) === "ustar\0"
      ? tarField(header, 345, 155)
      : "";
  return prefix === "" ? name : `${prefix}/${name}`;
};

const tarEntrySize = (header, pax) => {
  const override = pax?.get("size");
  if (override === undefined) return tarOctal(header, 124, 12, "entry size");
  if (!/^(0|[1-9][0-9]*)$/u.test(override)) malformed("pax size is invalid");
  return Number(override);
};

const readTarHeader = (tar, offset) => {
  if (offset + TAR_BLOCK > tar.length)
    malformed("tar stream ends without an end-of-archive block");
  const header = tar.subarray(offset, offset + TAR_BLOCK);
  if (header.every((byte) => byte === 0)) return undefined;
  if (!header.toString("latin1", 257, 262).startsWith("ustar"))
    malformed(`tar header at offset ${offset} is not ustar`);
  if (tarChecksum(header) !== tarOctal(header, 148, 8, "header checksum"))
    malformed(`tar header at offset ${offset} has an invalid checksum`);
  return header;
};

const readTarMembers = (tar, wanted) => {
  const found = new Map();
  let offset = 0;
  let pax;
  for (;;) {
    const header = readTarHeader(tar, offset);
    if (header === undefined) break;
    const type = String.fromCharCode(header[156] ?? 0);
    const size = tarEntrySize(
      header,
      type === "x" || type === "g" ? undefined : pax,
    );
    const start = offset + TAR_BLOCK;
    if (start + size > tar.length) malformed("tar member data is truncated");
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === "g") continue;
    if (type === "x") {
      if (pax !== undefined) malformed("consecutive pax headers");
      pax = paxRecords(data);
      continue;
    }
    if (type === "L" || type === "K")
      malformed("GNU long-name members are not used by npm package tarballs");
    const path = pax?.get("path") ?? tarHeaderPath(header);
    pax = undefined;
    if (!wanted.includes(path)) continue;
    if (type !== "0" && type !== "\0")
      malformed(`${path} is not a regular file`);
    if (found.has(path)) malformed(`${path} appears more than once`);
    found.set(path, data);
  }
  if (pax !== undefined) malformed("pax header has no member");
  return found;
};

/**
 * Read selected regular-file members of an npm package tarball in memory,
 * without extracting anything. Every header checksum is verified; a member
 * that is duplicated or not a regular file is rejected rather than chosen.
 * `maxBytes` bounds the decompressed tar stream before it is allocated.
 */
export const readPackageTarballMembers = (tarball, wanted, maxBytes) => {
  let tar;
  try {
    tar = gunzipSync(tarball, { maxOutputLength: maxBytes });
  } catch (cause) {
    throw new MalformedPackageTarballError(
      `not a gzip stream within ${maxBytes} bytes: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return readTarMembers(tar, wanted);
};
