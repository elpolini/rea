import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  formatRestoreReport,
  formatRestoreWarnings,
  parseRestoreArguments,
  parseWindowsNativeManifest,
  restoreWindowsNative,
  WindowsNativeRestoreError,
  type ArtifactWriter,
  type GitRunner,
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
const TAG = `rea-agents-${VERSION}`;
const TAG_COMMIT = "0123456789abcdef0123456789abcdef01234567";
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

interface GitFixture {
  /** Fail every command as a missing executable or a non-repository. */
  readonly failure?: "missing_git" | "not_repository";
  /** `git rev-parse --show-prefix` output. */
  readonly prefix?: string;
  readonly tag?: "present" | "missing";
  /** Output of `git diff --name-only`, `git log`, and `git status`. */
  readonly diff?: string;
  readonly log?: string;
  readonly status?: string;
}

/** A git runner answering the comparison commands from fixed facts. */
const fakeGit = (fixture: GitFixture = {}) => {
  const calls: string[][] = [];
  const git: GitRunner = (arguments_) => {
    calls.push([...arguments_]);
    if (fixture.failure === "missing_git")
      return Promise.reject(
        Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
      );
    if (fixture.failure === "not_repository")
      return Promise.reject(
        Object.assign(new Error("Command failed: git rev-parse"), {
          code: 128,
          stderr:
            "fatal: not a git repository (or any of the parent directories): .git\n",
        }),
      );
    const [command, option] = arguments_;
    if (command === "rev-parse" && option === "--show-prefix")
      return Promise.resolve({ stdout: `${fixture.prefix ?? ""}\n` });
    if (command === "rev-parse")
      return fixture.tag === "missing"
        ? Promise.reject(
            Object.assign(new Error("Command failed: git rev-parse"), {
              code: 1,
              stderr: "",
            }),
          )
        : Promise.resolve({ stdout: `${TAG_COMMIT}\n` });
    const output =
      command === "diff"
        ? fixture.diff
        : command === "log"
          ? fixture.log
          : command === "status"
            ? fixture.status
            : undefined;
    if (output === undefined && !["diff", "log", "status"].includes(command!))
      return Promise.reject(new Error(`unexpected git ${command}`));
    return Promise.resolve({ stdout: output ?? "" });
  };
  return { git, calls };
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

const restore = (
  target: Checkout,
  npm: NpmRunner,
  replace = false,
  options: {
    readonly git?: GitRunner;
    readonly write?: ArtifactWriter;
    readonly acceptReleaseArtifact?: boolean;
  } = {},
) =>
  restoreWindowsNative({
    root: target.root,
    npm,
    replace,
    // A checkout whose native source matches its release tag.
    git: fakeGit().git,
    temporaryParent: target.downloads,
    ...options,
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
  it("accepts only --replace, --accept-release-artifact, and --help", () => {
    expect(parseRestoreArguments([])).toEqual({
      help: false,
      replace: false,
      acceptReleaseArtifact: false,
    });
    expect(parseRestoreArguments(["--replace"])).toEqual({
      help: false,
      replace: true,
      acceptReleaseArtifact: false,
    });
    expect(
      parseRestoreArguments(["--accept-release-artifact", "--replace"]),
    ).toEqual({ help: false, replace: true, acceptReleaseArtifact: true });
    expect(parseRestoreArguments(["--help"])).toMatchObject({ help: true });
    for (const arguments_ of [
      ["--force"],
      ["--replace", "--replace"],
      ["--accept-release-artifact", "--accept-release-artifact"],
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

const PATHSPECS = [
  "native/windows/src",
  "src/windows",
  ":(exclude)src/windows/*.test.ts",
];
/** Native source committed after the release tag. */
const AHEAD: GitFixture = {
  diff: "native/windows/src/filesystem.cc\nsrc/windows/WindowsPrivateRuntime.ts\n",
  log: "296589db1\tfix(windows): normalize drive-absolute runtime roots\n5f9ac2c98\tfix(windows): retain primary snapshot failures\n",
};

describe("restore:windows-native release source refusal", () => {
  it("refuses a release addon that predates the checkout's native source before downloading", async () => {
    const target = await checkout();
    const { npm, calls } = fakeNpm(packageFixture().tarball);
    const { git, calls: gitCalls } = fakeGit(AHEAD);
    const refused = restore(target, npm, false, { git });

    await expectFailure(refused, "native_source_differs");
    await expect(refused).rejects.toThrow(
      /differs from rea-agents-1\.2\.3\. package\.json still declares 1\.2\.3 because release-please bumps the version only when it cuts the next release[\s\S]*\n {2}296589db1 fix\(windows\): normalize drive-absolute runtime roots\n {2}5f9ac2c98 fix\(windows\): retain primary snapshot failures\nBuild the addon from this checkout with the Linux\/MinGW lane in native\/windows\/README\.md#build instead\. To install the published 1\.2\.3 addon anyway, rerun with "npm run restore:windows-native -- --accept-release-artifact"\. Nothing was downloaded or written\.$/u,
    );
    await expect(refused).rejects.toMatchObject({
      details: {
        tag: TAG,
        commits: [
          {
            commit: "296589db1",
            subject: "fix(windows): normalize drive-absolute runtime roots",
          },
          {
            commit: "5f9ac2c98",
            subject: "fix(windows): retain primary snapshot failures",
          },
        ],
        files: [
          "native/windows/src/filesystem.cc",
          "src/windows/WindowsPrivateRuntime.ts",
        ],
        uncommitted: [],
      },
    });
    expect(calls).toEqual([]);
    expect(gitCalls).toEqual([
      ["rev-parse", "--show-prefix"],
      ["rev-parse", "--verify", "--quiet", `refs/tags/${TAG}^{commit}`],
      [
        "diff",
        "--name-only",
        "--no-renames",
        TAG_COMMIT,
        "HEAD",
        "--",
        ...PATHSPECS,
      ],
      ["log", "--format=%h%x09%s", `${TAG_COMMIT}..HEAD`, "--", ...PATHSPECS],
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...PATHSPECS],
    ]);
    await expectUntouched(target);
  });

  it.each<[string, GitFixture, RegExp]>([
    [
      "files that differ without commits ahead of the tag",
      { diff: "native/windows/src/addon.cc\n" },
      /\nFiles that differ between rea-agents-1\.2\.3 and HEAD: native\/windows\/src\/addon\.cc\n/u,
    ],
    [
      "uncommitted and untracked native source",
      {
        status:
          " M native/windows/src/addon.cc\n?? native/windows/src/new.cc\n",
      },
      /\nUncommitted changes: M native\/windows\/src\/addon\.cc, \?\? native\/windows\/src\/new\.cc\n/u,
    ],
  ])("refuses %s", async (_case, fixture, message) => {
    const target = await checkout();
    const { npm, calls } = fakeNpm(packageFixture().tarball);
    const refused = restore(target, npm, false, { git: fakeGit(fixture).git });
    await expectFailure(refused, "native_source_differs");
    await expect(refused).rejects.toThrow(message);
    expect(calls).toEqual([]);
    await expectUntouched(target);
  });

  it("bounds the inline commit list and keeps every commit in the details", async () => {
    const target = await checkout();
    const commits = Array.from(
      { length: 25 },
      (_, index) =>
        `c${String(index).padStart(2, "0")}\tfix(windows): change ${index}`,
    );
    const refused = restore(
      target,
      fakeNpm(packageFixture().tarball).npm,
      true,
      {
        git: fakeGit({
          diff: "native/windows/src/addon.cc\n",
          log: commits.join("\n"),
        }).git,
      },
    );
    await expect(refused).rejects.toThrow(
      /c19 fix\(windows\): change 19\n {2}\.\.\.and 5 more \(git log rea-agents-1\.2\.3\.\.HEAD -- native\/windows\/src src\/windows\)\n[\s\S]*"npm run restore:windows-native -- --accept-release-artifact --replace"/u,
    );
    await expect(refused).rejects.not.toThrow(/c20 fix/u);
    await expect(refused).rejects.toMatchObject({
      details: {
        commits: expect.arrayContaining([
          { commit: "c24", subject: "fix(windows): change 24" },
        ]),
      },
    });
  });
});

describe("restore:windows-native release source reporting", () => {
  it("installs the release addon only after an explicit acceptance and warns what it lacks", async () => {
    const target = await checkout();
    const fixture = packageFixture();
    const report = await restore(target, fakeNpm(fixture.tarball).npm, false, {
      git: fakeGit(AHEAD).git,
      acceptReleaseArtifact: true,
    });
    expect(await readFile(join(target.build, "rea-windows-x64.node"))).toEqual(
      fixture.artifact,
    );
    expect(report.sourceComparison).toMatchObject({
      state: "differs",
      tag: TAG,
      commits: [{ commit: "296589db1" }, { commit: "5f9ac2c98" }],
    });
    expect(formatRestoreReport(report)).toContain(
      "Native source:\n  differs from rea-agents-1.2.3; the published addon was accepted with --accept-release-artifact (native/windows/src and src/windows, excluding *.test.ts)\n",
    );
    expect(formatRestoreWarnings(report)).toMatch(
      /^warning: This checkout's native source \(native\/windows\/src and src\/windows, excluding \*\.test\.ts\) differs from rea-agents-1\.2\.3\.[\s\S]*296589db1[\s\S]*The installed addon is the published rea-agents@1\.2\.3 build; build it from this checkout with the Linux\/MinGW lane/u,
    );
  });

  it("reports a matching release tag without warnings", async () => {
    const target = await checkout();
    const report = await restore(target, fakeNpm(packageFixture().tarball).npm);
    expect(report.sourceComparison).toEqual({ state: "matches", tag: TAG });
    expect(formatRestoreReport(report)).toContain(
      "Native source:\n  matches rea-agents-1.2.3 at HEAD with no uncommitted changes (native/windows/src and src/windows, excluding *.test.ts)\n",
    );
    expect(formatRestoreWarnings(report)).toBe("");
  });

  it.each<[string, GitFixture, RegExp]>([
    [
      "git is missing",
      { failure: "missing_git" },
      /^git is not available on PATH$/u,
    ],
    [
      "the checkout is not a Git work tree",
      { failure: "not_repository" },
      /^git could not read this checkout as a work tree \(fatal: not a git repository/u,
    ],
    [
      "the release tag is absent",
      { tag: "missing" },
      /^the tag rea-agents-1\.2\.3 is not present in this checkout \(fetch it with "git fetch origin tag rea-agents-1\.2\.3" to compare\)$/u,
    ],
    [
      "the checkout is a subdirectory of another work tree",
      { prefix: "vendor/rea/" },
      /^the checkout root is the subdirectory vendor\/rea\/ of another Git work tree/u,
    ],
  ])(
    "restores but says explicitly that the source was not compared when %s",
    async (_case, fixture, reason) => {
      const target = await checkout();
      const { npm, calls } = fakeNpm(packageFixture().tarball);
      const report = await restore(target, npm, false, {
        git: fakeGit(fixture).git,
      });
      expect(calls.map(([command]) => command)).toEqual(["view", "pack"]);
      expect(report.sourceComparison).toMatchObject({
        state: "unknown",
        tag: TAG,
        reason: expect.stringMatching(reason),
      });
      expect(formatRestoreReport(report)).toContain(
        "Native source:\n  not compared with rea-agents-1.2.3: ",
      );
      expect(formatRestoreWarnings(report)).toMatch(
        /^warning: Could not compare this checkout's native source \(native\/windows\/src and src\/windows, excluding \*\.test\.ts\) with rea-agents-1\.2\.3: .+\. If this checkout changed it after that release, the installed rea-agents@1\.2\.3 addon does not contain those changes; build it with the Linux\/MinGW lane in native\/windows\/README\.md#build instead\.\n$/u,
      );
    },
  );
});

describe("restore:windows-native release source with Git", () => {
  it("compares the release tag of a real Git checkout", async () => {
    const target = await checkout();
    const git = (...arguments_: string[]) =>
      promisify(execFile)(
        "git",
        [
          "-c",
          "user.name=REA Test",
          "-c",
          "user.email=rea-test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          ...arguments_,
        ],
        { cwd: target.root, windowsHide: true },
      );
    const write = (path: string, text: string) =>
      mkdir(join(target.root, path, ".."), { recursive: true }).then(() =>
        writeFile(join(target.root, path), text),
      );
    await git("init", "--quiet");
    await write("native/windows/src/addon.cc", "// released\n");
    await write("src/windows/WindowsNativeLoader.ts", "export {};\n");
    await git("add", "-A");
    await git("commit", "--quiet", "-m", "chore: release 1.2.3");
    const { npm } = fakeNpm(packageFixture().tarball);
    const run = (acceptReleaseArtifact = false) =>
      restoreWindowsNative({
        root: target.root,
        npm,
        acceptReleaseArtifact,
        temporaryParent: target.downloads,
      });

    expect((await run()).sourceComparison).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining(`the tag ${TAG} is not present`),
    });

    // An annotated tag peels to its commit; test-only changes are excluded.
    await git("tag", "-a", TAG, "-m", "rea-agents 1.2.3");
    await write("src/windows/WindowsNativeLoader.test.ts", "export {};\n");
    await git("add", "-A");
    await git("commit", "--quiet", "-m", "test(windows): cover the loader");
    expect((await run()).sourceComparison).toEqual({
      state: "matches",
      tag: TAG,
    });

    await write("native/windows/src/addon.cc", "// unreleased\n");
    await expect(run()).rejects.toMatchObject({
      code: "native_source_differs",
      details: { commits: [], uncommitted: [" M native/windows/src/addon.cc"] },
    });

    await git("commit", "--quiet", "-am", "fix(windows): change the addon");
    await expect(run()).rejects.toMatchObject({
      code: "native_source_differs",
      message: expect.stringMatching(
        /\n {2}[0-9a-f]{7,} fix\(windows\): change the addon\n/u,
      ),
      details: {
        files: ["native/windows/src/addon.cc"],
        uncommitted: [],
      },
    });
    expect((await run(true)).sourceComparison).toMatchObject({
      state: "differs",
      commits: [{ subject: "fix(windows): change the addon" }],
    });
  });
});

describe("restore:windows-native destination in use", () => {
  /** A checkout holding an earlier addon that the restore must replace. */
  const withPreviousArtifact = async () => {
    const target = await checkout();
    await mkdir(target.build, { recursive: true });
    const previous = packageFixture({
      artifact: Buffer.concat([peImage(), Buffer.from("loaded")]),
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
    return { target, previous };
  };
  const refusing =
    (errno: string, refused: string): ArtifactWriter =>
    (path, bytes) =>
      path.endsWith(refused)
        ? Promise.reject(
            Object.assign(
              new Error(
                `${errno}: operation not permitted, rename -> '${path}'`,
              ),
              { code: errno },
            ),
          )
        : writeFile(path, bytes);

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "maps %s while replacing a loaded addon to destination_in_use",
    async (errno) => {
      const { target, previous } = await withPreviousArtifact();
      const failed = restore(
        target,
        fakeNpm(packageFixture().tarball).npm,
        true,
        {
          write: refusing(errno, "rea-windows-x64.node"),
        },
      );
      await expectFailure(failed, "destination_in_use");
      await expect(failed).rejects.toThrow(
        new RegExp(
          `^Could not write native/windows/build/rea-windows-x64\\.node \\(${errno}\\): another process is using it, or this user cannot write it\\. Windows refuses to replace an addon that a running process has loaded\\. Stop the REA processes of this checkout, including its MCP server and any run-exclusive command such as npm run build:cached, then rerun "npm run restore:windows-native -- --replace"\\. Nothing was written\\.$`,
          "u",
        ),
      );
      await expect(failed).rejects.toMatchObject({
        details: {
          file: "native/windows/build/rea-windows-x64.node",
          errno,
          written: [],
        },
        cause: { code: errno },
      });
      expect(
        await readFile(join(target.build, "rea-windows-x64.node")),
      ).toEqual(previous.artifact);
      expect(await readFile(join(target.build, "manifest.json"))).toEqual(
        previous.manifestBytes,
      );
      await expect(readdir(target.downloads)).resolves.toEqual([]);
    },
  );

  it("names the addon already written when its manifest is refused", async () => {
    const { target } = await withPreviousArtifact();
    const failed = restore(
      target,
      fakeNpm(packageFixture().tarball).npm,
      true,
      {
        write: refusing("EBUSY", "manifest.json"),
      },
    );
    await expectFailure(failed, "destination_in_use");
    await expect(failed).rejects.toThrow(
      /native\/windows\/build\/rea-windows-x64\.node was already written; the loader rejects the mismatched pair until the restore completes\.$/u,
    );
  });

  it("keeps other write failures untagged", async () => {
    const { target } = await withPreviousArtifact();
    const failed = restore(
      target,
      fakeNpm(packageFixture().tarball).npm,
      true,
      {
        write: refusing("ENOSPC", "rea-windows-x64.node"),
      },
    );
    await expect(failed).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(failed).rejects.not.toBeInstanceOf(WindowsNativeRestoreError);
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
    expect(stdout).toContain("--accept-release-artifact");
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
