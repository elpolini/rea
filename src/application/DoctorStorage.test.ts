import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  observeTemporaryStorage,
  systemStorageStatistics,
  TEMPORARY_SPACE_WARNING_BYTES,
  temporaryStorageCheck,
  type StorageStatisticsReader,
} from "./DoctorStorage.js";

const PATH = "/fixture/tmp";

const statistics =
  (bsize: bigint | number, bavail: bigint | number): StorageStatisticsReader =>
  () =>
    Promise.resolve({ bsize, bavail });

const failing =
  (cause: unknown): StorageStatisticsReader =>
  () =>
    Promise.reject(cause);

const errno = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const checkFor = async (reader: StorageStatisticsReader | undefined) =>
  temporaryStorageCheck(await observeTemporaryStorage(PATH, reader));

describe("temporary directory free space classification", () => {
  it.each([
    { bavail: 0, classification: "warning" },
    { bavail: TEMPORARY_SPACE_WARNING_BYTES - 1, classification: "warning" },
    { bavail: TEMPORARY_SPACE_WARNING_BYTES, classification: "healthy" },
    { bavail: TEMPORARY_SPACE_WARNING_BYTES + 1, classification: "healthy" },
  ])(
    "classifies $bavail available bytes as $classification without failing readiness",
    async ({ bavail, classification }) => {
      const check = await checkFor(statistics(1, bavail));

      expect(check).toMatchObject({
        name: "temporary-space",
        ok: true,
        classification,
        details: {
          path: PATH,
          available_bytes: bavail,
          warning_threshold_bytes: 1024 ** 3,
        },
      });
      expect(check.remediation === undefined).toBe(
        classification === "healthy",
      );
    },
  );

  it("multiplies available blocks by the block size at the threshold boundary", async () => {
    const blocks = BigInt(TEMPORARY_SPACE_WARNING_BYTES) / 4096n;

    await expect(checkFor(statistics(4096n, blocks))).resolves.toMatchObject({
      classification: "healthy",
      detail: `1 GiB available in ${PATH}.`,
    });
    await expect(
      checkFor(statistics(4096n, blocks - 1n)),
    ).resolves.toMatchObject({ classification: "warning" });
  });

  it("explains low space with the measured amount and how to recover", async () => {
    const check = await checkFor(statistics(4096n, 20_480n));

    expect(check).toEqual({
      name: "temporary-space",
      ok: true,
      classification: "warning",
      detail: `Only 80 MiB available in ${PATH}; REA providers create their workspaces there and warn below 1 GiB.`,
      details: {
        path: PATH,
        available_bytes: 80 * 1024 ** 2,
        warning_threshold_bytes: 1024 ** 3,
      },
      remediation: `Free space on the volume that holds ${PATH}, or point TMPDIR (TEMP and TMP on Windows) at a directory on a volume with at least 1 GiB available, then restart REA or the agent client that starts it.`,
    });
  });

  it("keeps exact counters for volumes beyond the safe integer range", async () => {
    const check = await checkFor(statistics(4096n, 2n ** 50n));

    expect(check).toMatchObject({
      classification: "healthy",
      detail: `4294967296 GiB available in ${PATH}.`,
      details: { available_bytes: 2 ** 62 },
    });
  });

  it.each([
    { bsize: 1, bavail: 512, detail: "Only 512 bytes available" },
    {
      bsize: 1,
      bavail: 1024 ** 3 + 1024 ** 3 / 2,
      detail: "1.5 GiB available",
    },
  ])("reports $detail", async ({ bsize, bavail, detail }) => {
    await expect(checkFor(statistics(bsize, bavail))).resolves.toMatchObject({
      detail: expect.stringContaining(detail),
    });
  });
});

describe("temporary directory free space failures", () => {
  it("reports unknown, not healthy, when statfs fails", async () => {
    const check = await checkFor(
      failing(errno("ENOENT", "ENOENT: no such file or directory, statfs")),
    );

    expect(check).toEqual({
      name: "temporary-space",
      ok: true,
      classification: "unknown",
      detail: `Available space in ${PATH} could not be read (ENOENT).`,
      details: {
        path: PATH,
        reason: "statfs_failed",
        code: "ENOENT",
        message: "ENOENT: no such file or directory, statfs",
        warning_threshold_bytes: 1024 ** 3,
      },
      remediation: `Check that ${PATH} exists and is accessible, or point TMPDIR (TEMP and TMP on Windows) at an existing directory, then rerun rea doctor.`,
    });
  });

  it("preserves a failure without an errno code", async () => {
    await expect(
      observeTemporaryStorage(PATH, failing("controlled refusal")),
    ).resolves.toEqual({
      path: PATH,
      space: {
        ok: false,
        error: { reason: "statfs_failed", message: "controlled refusal" },
      },
    });
  });

  it.each([
    ["a runtime without fs.statfs", undefined],
    ["ENOSYS", failing(errno("ENOSYS", "function not implemented"))],
    [
      "ERR_METHOD_NOT_IMPLEMENTED",
      failing(errno("ERR_METHOD_NOT_IMPLEMENTED", "statfs is unavailable")),
    ],
  ])(
    "reports unknown when statfs is unavailable (%s)",
    async (_label, reader) => {
      const check = await checkFor(reader);

      expect(check).toMatchObject({
        ok: true,
        classification: "unknown",
        details: { reason: "statfs_unavailable" },
        remediation: `Check the free space of ${PATH} with operating system tools; REA providers need about 1 GiB there for typical targets.`,
      });
    },
  );

  it.each([
    ["a zero block size", { bsize: 0, bavail: 10 }],
    ["a negative available count", { bsize: 4096n, bavail: -1n }],
    ["a fractional block size", { bsize: 4096.5, bavail: 10 }],
    ["a missing available count", { bsize: 4096 }],
    ["string counters", { bsize: "4096", bavail: "10" }],
    ["a non-object result", null],
  ])("rejects malformed statfs output with %s", async (_label, value) => {
    const reader = (() =>
      Promise.resolve(value)) as unknown as StorageStatisticsReader;
    const observation = await observeTemporaryStorage(PATH, reader);

    expect(observation.space).toMatchObject({
      ok: false,
      error: {
        reason: "statfs_invalid",
        message: expect.stringContaining(
          "statfs returned unusable block counts",
        ),
      },
    });
    expect(temporaryStorageCheck(observation)).toMatchObject({
      ok: true,
      classification: "unknown",
    });
  });
});

describe("temporary directory free space on this host", () => {
  it("reads the real temporary volume without changing it", async () => {
    const observation = await observeTemporaryStorage(
      tmpdir(),
      systemStorageStatistics,
    );

    expect(systemStorageStatistics).toBeDefined();
    expect(observation).toMatchObject({ path: tmpdir(), space: { ok: true } });
    if (observation.space.ok)
      expect(observation.space.value.availableBytes).toBeGreaterThan(0n);
  });

  it("reports a missing temporary directory through the real statfs", async () => {
    const missing = join(
      await createTestTempDirectory("rea-doctor-storage-"),
      "missing",
    );

    const check = temporaryStorageCheck(
      await observeTemporaryStorage(missing, systemStorageStatistics),
    );

    expect(check).toMatchObject({
      ok: true,
      classification: "unknown",
      details: { path: missing, reason: "statfs_failed", code: "ENOENT" },
    });
  });
});
