import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  formatRestoreReport,
  parseRestoreArguments,
  parseWindowsNativeManifest,
  restoreWindowsNative,
  type NpmRunner,
  type WindowsNativeRestoreErrorCode,
} from "../../../scripts/lib/windows-native-restore.mjs";
import {
  loadWindowsNativeAuthority,
  windowsNativeManifestSchema,
} from "../../../src/windows/WindowsNativeLoader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const VERSION = "1.2.3";
const SPEC = `rea-agents@${VERSION}`;
const TARBALL = `rea-agents-${VERSION}.tgz`;
const MANIFEST_MEMBER = "package/native/windows/build/manifest.json";
const ARTIFACT_MEMBER = "package/native/windows/build/rea-windows-x64.node";

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes: Buffer): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const peImage = (machine = 0x8664, magic = 0x20b): Buffer => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "latin1");
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(magic, 88);
  return bytes;
};

interface Member {
  readonly path: string;
  readonly data: Buffer;
  readonly type?: string;
  readonly prefix?: string;
}

const tarHeader = ({ path, data, type = "0", prefix = "" }: Member): Buffer => {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.fill(0x20, 148, 156);
  header.write(type, 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.write(prefix, 345, 155, "utf8");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
};

const tarStream = (members: readonly Member[], end = true): Buffer =>
  Buffer.concat([
    ...members.flatMap((member) => [
      tarHeader(member),
      member.data,
      Buffer.alloc((512 - (member.data.length % 512)) % 512),
    ]),
    Buffer.alloc(end ? 1024 : 0),
  ]);

const paxMember = (records: Readonly<Record<string, string>>): Member => ({
  path: "PaxHeader",
  type: "x",
  data: Buffer.from(
    Object.entries(records)
      .map(([key, value]) => {
        const body = ` ${key}=${value}\n`;
        let length = body.length;
        while (`${length}${body}`.length !== length)
          length = `${length}${body}`.length;
        return `${length}${body}`;
      })
      .join(""),
  ),
});

interface PackageOptions {
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly artifact?: Buffer;
  readonly packageJson?: unknown;
  readonly members?: (defaults: Member[]) => Member[];
  readonly tar?: (stream: Buffer) => Buffer;
}

const packageFixture = (options: PackageOptions = {}) => {
  const artifact = options.artifact ?? peImage();
  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        packageVersion: VERSION,
        platform: "win32",
        architecture: "x64",
        abiVersion: 1,
        nodeApiVersion: 8,
        artifact: "rea-windows-x64.node",
        artifactSha256: sha256(artifact),
        ...options.manifest,
      },
      null,
      2,
    )}\n`,
  );
  const defaults: Member[] = [
    {
      path: "package/package.json",
      data: Buffer.from(
        JSON.stringify(
          options.packageJson ?? { name: "rea-agents", version: VERSION },
        ),
      ),
    },
    { path: "package/README.md", data: Buffer.from("fixture\n") },
    { path: MANIFEST_MEMBER, data: manifestBytes },
    { path: ARTIFACT_MEMBER, data: artifact },
  ];
  const stream = tarStream(options.members?.(defaults) ?? defaults);
  return {
    tarball: gzipSync(options.tar?.(stream) ?? stream),
    manifestBytes,
    artifact,
  };
};

const fakeNpm = (
  tarball: Buffer,
  overrides: {
    readonly registryIntegrity?: string;
    readonly packIntegrity?: string;
    readonly view?: () => Promise<{ stdout: string }>;
    readonly pack?: (destination: string) => Promise<{ stdout: string }>;
  } = {},
) => {
  const calls: string[][] = [];
  const npm: NpmRunner = async (arguments_) => {
    calls.push([...arguments_]);
    if (arguments_[0] === "view")
      return (
        overrides.view?.() ?? {
          stdout: JSON.stringify({
            name: "rea-agents",
            version: VERSION,
            "dist.integrity": overrides.registryIntegrity ?? integrity(tarball),
          }),
        }
      );
    const destination =
      arguments_[arguments_.indexOf("--pack-destination") + 1];
    if (destination === undefined) throw new Error("missing pack destination");
    if (overrides.pack !== undefined) return overrides.pack(destination);
    await writeFile(join(destination, TARBALL), tarball);
    return {
      stdout: JSON.stringify([
        {
          name: "rea-agents",
          version: VERSION,
          filename: TARBALL,
          integrity: overrides.packIntegrity ?? integrity(tarball),
          files: [],
        },
      ]),
    };
  };
  return { npm, calls };
};

const checkout = async (
  packageJson: unknown = { name: "rea-agents", version: VERSION },
) => {
  const root = await createTestTempDirectory("rea-native-restore-root-");
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
  const downloads = await createTestTempDirectory(
    "rea-native-restore-downloads-",
  );
  return { root, downloads, build: join(root, "native", "windows", "build") };
};

type Checkout = Awaited<ReturnType<typeof checkout>>;

const restore = (target: Checkout, npm: NpmRunner, replace = false) =>
  restoreWindowsNative({
    root: target.root,
    npm,
    replace,
    temporaryParent: target.downloads,
  });

const expectFailure = async (
  promise: Promise<unknown>,
  code: WindowsNativeRestoreErrorCode,
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    name: "WindowsNativeRestoreError",
    code,
  });
};

/** A rejected restore writes nothing and removes its private download. */
const expectUntouched = async (target: Checkout): Promise<void> => {
  await expect(readdir(target.downloads)).resolves.toEqual([]);
  await expect(readdir(target.build)).rejects.toMatchObject({
    code: "ENOENT",
  });
};

describe("restore:windows-native installation", () => {
  it("restores the exact-version artifact after verifying every published fact", async () => {
    const target = await checkout();
    const fixture = packageFixture();
    const { npm, calls } = fakeNpm(fixture.tarball);
    const report = await restore(target, npm);

    expect(calls).toEqual([
      ["view", SPEC, "name", "version", "dist.integrity", "--json"],
      [
        "pack",
        SPEC,
        "--pack-destination",
        expect.stringContaining("rea-windows-native-restore-"),
        "--ignore-scripts",
        "--json",
      ],
    ]);
    expect(calls.flat().join(" ")).not.toContain("latest");
    expect((await readdir(target.build)).sort()).toEqual([
      "manifest.json",
      "rea-windows-x64.node",
    ]);
    expect(await readFile(join(target.build, "rea-windows-x64.node"))).toEqual(
      fixture.artifact,
    );
    expect(await readFile(join(target.build, "manifest.json"))).toEqual(
      fixture.manifestBytes,
    );
    expect(report).toMatchObject({
      spec: SPEC,
      registryIntegrity: integrity(fixture.tarball),
      tarball: { filename: TARBALL, bytes: fixture.tarball.length },
      artifact: { sha256: sha256(fixture.artifact), image: "x86-64 PE32+" },
      files: [
        {
          path: "native/windows/build/rea-windows-x64.node",
          action: "created",
        },
        { path: "native/windows/build/manifest.json", action: "created" },
      ],
    });
    expect(report).not.toHaveProperty("retainedDownload");
    expect(formatRestoreReport(report)).toMatch(
      new RegExp(
        `^Restored Windows native controls for ${SPEC}\\.[\\s\\S]*${sha256(fixture.artifact)} matches manifest\\.artifactSha256`,
        "u",
      ),
    );
    await expect(readdir(target.downloads)).resolves.toEqual([]);
  });

  it("keeps identical files and completes a partial restore without --replace", async () => {
    const target = await checkout();
    const { npm } = fakeNpm(packageFixture().tarball);
    await restore(target, npm);
    await writeFile(join(target.build, "manifest.json"), "", { flag: "w" });
    await expectFailure(restore(target, npm), "existing_artifact_differs");

    await rm(join(target.build, "manifest.json"));
    const partial = await restore(target, npm);
    expect(partial.files.map(({ action }) => action)).toEqual([
      "unchanged",
      "created",
    ]);
    const repeated = await restore(target, npm);
    expect(repeated.files.map(({ action }) => action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(formatRestoreReport(repeated)).toContain(
      "are already present; nothing was written.",
    );
  });

  it("refuses a different existing artifact unless --replace is given", async () => {
    const target = await checkout();
    await mkdir(target.build, { recursive: true });
    const previous = packageFixture({
      artifact: Buffer.concat([peImage(), Buffer.from("older")]),
      manifest: { packageVersion: "1.2.2" },
    });
    await writeFile(
      join(target.build, "manifest.json"),
      previous.manifestBytes,
    );
    await writeFile(
      join(target.build, "rea-windows-x64.node"),
      previous.artifact,
    );
    const fixture = packageFixture();
    const { npm } = fakeNpm(fixture.tarball);

    const refused = restore(target, npm);
    await expectFailure(refused, "existing_artifact_differs");
    await expect(refused).rejects.toThrow(
      /packageVersion 1\.2\.2.*nothing was written.*npm run restore:windows-native -- --replace/u,
    );
    expect(await readFile(join(target.build, "manifest.json"))).toEqual(
      previous.manifestBytes,
    );
    expect(await readFile(join(target.build, "rea-windows-x64.node"))).toEqual(
      previous.artifact,
    );

    const replaced = await restore(target, npm, true);
    expect(replaced.files.map(({ action }) => action)).toEqual([
      "replaced",
      "replaced",
    ]);
    expect(await readFile(join(target.build, "manifest.json"))).toEqual(
      fixture.manifestBytes,
    );
    expect(await readFile(join(target.build, "rea-windows-x64.node"))).toEqual(
      fixture.artifact,
    );
    await expect(readdir(target.downloads)).resolves.toEqual([]);
  });

  it("never writes through a destination that is not a regular file", async () => {
    const target = await checkout();
    await mkdir(join(target.build, "manifest.json"), { recursive: true });
    const { npm } = fakeNpm(packageFixture().tarball);
    await expectFailure(restore(target, npm, true), "unsafe_destination");
    await expect(readdir(target.build)).resolves.toEqual(["manifest.json"]);
    await expect(readdir(target.downloads)).resolves.toEqual([]);
  });

  it("never replaces a build path that is not a directory", async () => {
    const target = await checkout();
    await mkdir(join(target.root, "native", "windows"), { recursive: true });
    await writeFile(target.build, "not a directory");
    const { npm } = fakeNpm(packageFixture().tarball);
    await expectFailure(restore(target, npm, true), "unsafe_destination");
    expect(await readFile(target.build, "utf8")).toBe("not a directory");
    await expect(readdir(target.downloads)).resolves.toEqual([]);
  });
});

describe("restore:windows-native published-fact verification", () => {
  it.each([
    ["registry", { registryIntegrity: integrity(Buffer.from("other")) }],
    ["npm pack", { packIntegrity: integrity(Buffer.from("other")) }],
  ] as const)(
    "rejects a tarball whose integrity differs from the %s report",
    async (_source, override) => {
      const target = await checkout();
      const { npm } = fakeNpm(packageFixture().tarball, override);
      await expectFailure(restore(target, npm), "integrity_mismatch");
      await expectUntouched(target);
    },
  );

  it.each<[string, PackageOptions, WindowsNativeRestoreErrorCode]>([
    [
      "manifest for another version",
      { manifest: { packageVersion: "1.2.2" } },
      "version_mismatch",
    ],
    [
      "tarball package.json for another version",
      { packageJson: { name: "rea-agents", version: "1.2.2" } },
      "package_identity_mismatch",
    ],
    [
      "tarball package.json for another package",
      { packageJson: { name: "other", version: VERSION } },
      "package_identity_mismatch",
    ],
    [
      "addon digest that differs from the manifest",
      { manifest: { artifactSha256: "0".repeat(64) } },
      "digest_mismatch",
    ],
    [
      "manifest for another architecture",
      { manifest: { architecture: "arm64" } },
      "architecture_mismatch",
    ],
    [
      "manifest for another platform",
      { manifest: { platform: "linux" } },
      "architecture_mismatch",
    ],
    [
      "digest-consistent ARM64 image",
      { artifact: peImage(0xaa64) },
      "architecture_mismatch",
    ],
    [
      "digest-consistent PE32 image",
      { artifact: peImage(0x8664, 0x10b) },
      "architecture_mismatch",
    ],
    [
      "addon that is not a PE image",
      { artifact: Buffer.alloc(128) },
      "artifact_invalid",
    ],
    [
      "manifest with another ABI",
      { manifest: { abiVersion: 2 } },
      "manifest_invalid",
    ],
    [
      "manifest with an extra field",
      { manifest: { extra: true } },
      "manifest_invalid",
    ],
    [
      "package without the addon",
      {
        members: (defaults) =>
          defaults.filter(({ path }) => path !== ARTIFACT_MEMBER),
      },
      "missing_artifact",
    ],
  ])("rejects a %s before writing", async (_case, options, code) => {
    const target = await checkout();
    const { npm } = fakeNpm(packageFixture(options).tarball);
    await expectFailure(restore(target, npm), code);
    await expectUntouched(target);
  });
});

describe("restore:windows-native tarball parsing", () => {
  it.each<[string, (stream: Buffer) => Buffer]>([
    ["truncated member data", (stream) => stream.subarray(0, 512 + 4)],
    ["missing end-of-archive block", (stream) => stream.subarray(0, -1024)],
    [
      "corrupted header checksum",
      (stream) => {
        const copy = Buffer.from(stream);
        copy[100] = 0x37;
        return copy;
      },
    ],
  ])("rejects a tar stream with %s", async (_case, tar) => {
    const target = await checkout();
    const { npm } = fakeNpm(packageFixture({ tar }).tarball);
    await expectFailure(restore(target, npm), "malformed_tarball");
    await expectUntouched(target);
  });

  it.each<[string, (defaults: Member[]) => Member[]]>([
    [
      "a duplicate manifest",
      (defaults) => [
        ...defaults,
        { path: MANIFEST_MEMBER, data: Buffer.from("{}") },
      ],
    ],
    [
      "a symbolic-link addon",
      (defaults) =>
        defaults.map((member) =>
          member.path === ARTIFACT_MEMBER ? { ...member, type: "2" } : member,
        ),
    ],
    [
      "a GNU long-name member",
      (defaults) => [
        { path: "././@LongLink", type: "L", data: Buffer.from("x") },
        ...defaults,
      ],
    ],
    [
      "a trailing pax header",
      (defaults) => [...defaults, paxMember({ path: "x" })],
    ],
  ])("rejects a package with %s", async (_case, members) => {
    const target = await checkout();
    const { npm } = fakeNpm(packageFixture({ members }).tarball);
    await expectFailure(restore(target, npm), "malformed_tarball");
    await expectUntouched(target);
  });

  it("rejects bytes that are not a gzip stream", async () => {
    const target = await checkout();
    const { npm } = fakeNpm(Buffer.from("not a gzip stream"));
    await expectFailure(restore(target, npm), "malformed_tarball");
    await expectUntouched(target);
  });

  it("reads members named by ustar prefixes and pax path records", async () => {
    const target = await checkout();
    const fixture = packageFixture({
      members: (defaults) =>
        defaults.flatMap((member) =>
          member.path === ARTIFACT_MEMBER
            ? [
                {
                  ...member,
                  path: "rea-windows-x64.node",
                  prefix: "package/native/windows/build",
                },
              ]
            : member.path === MANIFEST_MEMBER
              ? [
                  paxMember({ path: MANIFEST_MEMBER }),
                  { ...member, path: "package/truncated-name" },
                ]
              : [member],
        ),
    });
    const { npm } = fakeNpm(fixture.tarball);
    await restore(target, npm);
    expect(await readFile(join(target.build, "manifest.json"))).toEqual(
      fixture.manifestBytes,
    );
    expect(await readFile(join(target.build, "rea-windows-x64.node"))).toEqual(
      fixture.artifact,
    );
  });
});

describe("restore:windows-native checkout and npm boundaries", () => {
  it.each([
    ["a range", { name: "rea-agents", version: `^${VERSION}` }],
    ["a dist-tag", { name: "rea-agents", version: "latest" }],
    ["a prefixed version", { name: "rea-agents", version: `v${VERSION}` }],
    ["another package", { name: "other", version: VERSION }],
    ["no version", { name: "rea-agents" }],
  ])(
    "refuses %s in package.json before calling npm",
    async (_case, packageJson) => {
      const target = await checkout(packageJson);
      const { npm, calls } = fakeNpm(packageFixture().tarball);
      await expectFailure(restore(target, npm), "checkout_identity");
      expect(calls).toEqual([]);
      await expectUntouched(target);
    },
  );

  it("reports an unpublished version without packing it", async () => {
    const target = await checkout();
    const { npm, calls } = fakeNpm(packageFixture().tarball, {
      view: () =>
        Promise.reject(
          Object.assign(new Error("Command failed: npm view"), {
            code: 1,
            stdout: JSON.stringify({
              error: { code: "E404", summary: "No match found for version" },
            }),
          }),
        ),
    });
    const failed = restore(target, npm);
    await expectFailure(failed, "not_published");
    await expect(failed).rejects.toThrow(/Linux\/MinGW lane/u);
    expect(calls.map(([command]) => command)).toEqual(["view"]);
    await expectUntouched(target);
  });

  it("preserves the npm summary of other npm failures", async () => {
    const target = await checkout();
    const { npm } = fakeNpm(packageFixture().tarball, {
      pack: () =>
        Promise.reject(
          Object.assign(new Error("Command failed: npm pack"), {
            stdout: JSON.stringify({
              error: { code: "ECONNRESET", summary: "socket hang up" },
            }),
          }),
        ),
    });
    const failed = restore(target, npm);
    await expectFailure(failed, "npm_failed");
    await expect(failed).rejects.toThrow(
      /npm pack rea-agents@1\.2\.3 failed: socket hang up/u,
    );
    await expectUntouched(target);
  });

  it.each<[string, string, WindowsNativeRestoreErrorCode]>([
    ["non-JSON metadata", "not json", "registry_metadata"],
    [
      "metadata for another version",
      JSON.stringify({
        name: "rea-agents",
        version: "1.2.4",
        "dist.integrity": integrity(Buffer.from("x")),
      }),
      "registry_metadata",
    ],
    [
      "a sha1 integrity",
      JSON.stringify({
        name: "rea-agents",
        version: VERSION,
        "dist.integrity": "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      }),
      "registry_metadata",
    ],
  ])("rejects npm view %s", async (_case, stdout, code) => {
    const target = await checkout();
    const { npm, calls } = fakeNpm(packageFixture().tarball, {
      view: () => Promise.resolve({ stdout }),
    });
    await expectFailure(restore(target, npm), code);
    expect(calls).toHaveLength(1);
    await expectUntouched(target);
  });

  it.each<[string, (tarball: Buffer) => unknown[]]>([
    [
      "two tarballs",
      (tarball) => [
        {
          name: "rea-agents",
          version: VERSION,
          filename: TARBALL,
          integrity: integrity(tarball),
        },
        {
          name: "rea-agents",
          version: VERSION,
          filename: TARBALL,
          integrity: integrity(tarball),
        },
      ],
    ],
    [
      "a filename outside the destination",
      (tarball) => [
        {
          name: "rea-agents",
          version: VERSION,
          filename: `../${TARBALL}`,
          integrity: integrity(tarball),
        },
      ],
    ],
    [
      "a filename that was not written",
      (tarball) => [
        {
          name: "rea-agents",
          version: VERSION,
          filename: "absent.tgz",
          integrity: integrity(tarball),
        },
      ],
    ],
  ])("rejects npm pack output naming %s", async (_case, report) => {
    const target = await checkout();
    const { tarball } = packageFixture();
    const { npm } = fakeNpm(tarball, {
      pack: async (destination) => {
        await writeFile(join(destination, TARBALL), tarball);
        return { stdout: JSON.stringify(report(tarball)) };
      },
    });
    await expectFailure(restore(target, npm), "pack_result");
    await expectUntouched(target);
  });
});

describe("restore:windows-native arguments and manifest contract", () => {
  it("accepts only --replace and --help", () => {
    expect(parseRestoreArguments([])).toEqual({ help: false, replace: false });
    expect(parseRestoreArguments(["--replace"])).toEqual({
      help: false,
      replace: true,
    });
    expect(parseRestoreArguments(["--help"])).toMatchObject({ help: true });
    for (const arguments_ of [
      ["--force"],
      ["--replace", "--replace"],
      ["latest"],
    ])
      expect(() => parseRestoreArguments(arguments_)).toThrow(
        expect.objectContaining({ code: "invalid_arguments" }),
      );
  });

  it("admits exactly the manifests the native loader admits", () => {
    const valid = {
      packageVersion: "1.0.0",
      platform: "win32",
      architecture: "x64",
      abiVersion: 1,
      nodeApiVersion: 8,
      artifact: "rea-windows-x64.node",
      artifactSha256: "a".repeat(64),
    };
    const { artifactSha256: _omitted, ...withoutDigest } = valid;
    const candidates: unknown[] = [
      valid,
      withoutDigest,
      { ...valid, extra: true },
      { ...valid, abiVersion: 2 },
      { ...valid, nodeApiVersion: 9 },
      { ...valid, artifact: "other.node" },
      { ...valid, artifactSha256: "A".repeat(64) },
      { ...valid, artifactSha256: "a".repeat(63) },
      { ...valid, platform: "linux" },
      { ...valid, architecture: "arm64" },
      { ...valid, packageVersion: 1 },
      [valid],
      null,
    ];
    for (const candidate of candidates) {
      let admitted = true;
      try {
        parseWindowsNativeManifest(candidate, "1.0.0");
      } catch {
        admitted = false;
      }
      expect(admitted, JSON.stringify(candidate)).toBe(
        windowsNativeManifestSchema.safeParse(candidate).success,
      );
    }
  });

  it("admits exactly the addon images the native loader admits", async () => {
    const valid = peImage();
    const withHeaderAt = (offset: number, signature = "PE\0\0"): Buffer => {
      const bytes = Buffer.alloc(128);
      bytes.write("MZ", 0, "latin1");
      bytes.writeUInt32LE(offset, 0x3c);
      if (offset <= bytes.length - 26) {
        bytes.write(signature, offset, "latin1");
        bytes.writeUInt16LE(0x8664, offset + 4);
        bytes.writeUInt16LE(0x20b, offset + 24);
      }
      return bytes;
    };
    const candidates: [string, Buffer][] = [
      ["x86-64 PE32+", valid],
      ["header at the last admissible offset", withHeaderAt(128 - 26)],
      ["header past the admissible offset", withHeaderAt(128 - 25)],
      ["e_lfanew beyond the image", withHeaderAt(0xffff_ffff)],
      ["corrupt PE signature", withHeaderAt(64, "PE\0\u0001")],
      ["ARM64 machine", peImage(0xaa64)],
      ["PE32 optional header", peImage(0x8664, 0x10b)],
      ["missing MZ", Buffer.alloc(128)],
      ["image shorter than a DOS header", valid.subarray(0, 63)],
    ];
    for (const [label, image] of candidates) {
      const target = await checkout();
      const { npm } = fakeNpm(packageFixture({ artifact: image }).tarball);
      let restored = true;
      try {
        await restore(target, npm);
      } catch (cause) {
        restored = false;
        expect(cause, label).toMatchObject({
          code: expect.stringMatching(
            /^(artifact_invalid|architecture_mismatch)$/u,
          ),
        });
      }
      let loads = 0;
      loadWindowsNativeAuthority({
        platform: "win32",
        architecture: "x64",
        nodeApiVersion: "8",
        packageVersion: VERSION,
        readManifest: () => ({
          packageVersion: VERSION,
          platform: "win32",
          architecture: "x64",
          abiVersion: 1,
          nodeApiVersion: 8,
          artifact: "rea-windows-x64.node",
          artifactSha256: sha256(image),
        }),
        readArtifact: () => image,
        loadArtifact: () => {
          loads++;
          throw new Error("fixture stops after admission");
        },
      });
      expect(restored, label).toBe(loads === 1);
    }
  });
});

describe("restore:windows-native entry point", () => {
  const command = (arguments_: readonly string[]) =>
    promisify(execFile)(process.execPath, [
      "scripts/restore-windows-native.mjs",
      ...arguments_,
    ]);

  it("prints help without contacting npm", async () => {
    const { stdout } = await command(["--help"]);
    expect(stdout).toContain("Usage: npm run restore:windows-native");
  });

  it("fails with the tagged reason for an unknown argument", async () => {
    await expect(command(["--latest"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        'restore:windows-native failed (invalid_arguments): Unknown or repeated argument "--latest"',
      ),
    });
  });
});
