import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CATALOG_IDENTITY } from "../../../src/catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  readInstalledSkillIdentity,
} from "../../../src/application/SetupSkill.js";
import {
  inspectSkillBundle,
  type SkillBundleSource,
} from "../../../src/application/SkillBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const SKILL = "reverse-engineer-anything";
const generatedBundle = resolve("skills", SKILL);
const expected = {
  version: PRODUCT_IDENTITY.skillVersion,
  toolCount: CATALOG_IDENTITY.counts.mcp_tools,
};

/** A package root with optional authored source and generated bundle. */
const packageRoot = async (input: {
  readonly sourceCheckout: boolean;
  readonly generated: boolean;
}): Promise<string> => {
  const root = await createTestTempDirectory("rea-skill-bundle-");
  if (input.sourceCheckout) {
    const authored = join(root, ".agents/skills", SKILL, "SKILL.md");
    await mkdir(dirname(authored), { recursive: true });
    await writeFile(authored, "---\nname: reverse-engineer-anything\n---\n");
  }
  if (input.generated)
    await cp(generatedBundle, join(root, "skills", SKILL), { recursive: true });
  return root;
};

const source = (
  root: string,
  platform: NodeJS.Platform = "linux",
): SkillBundleSource => ({ packageRoot: root, platform, expected });

const unavailable = async (bundleSource: SkillBundleSource) => {
  const inspection = await inspectSkillBundle(bundleSource);
  if (inspection.ok) throw new Error("Expected an unavailable skill bundle");
  return inspection.error;
};

describe("skill bundle ownership", () => {
  it("names the checkout build for a missing generated bundle", async () => {
    const root = await packageRoot({ sourceCheckout: true, generated: false });
    const manifest = join(root, "skills", SKILL, "SKILL.md");

    const linux = await unavailable(source(root));
    expect(linux).toMatchObject({
      _tag: "SkillBundleUnavailableError",
      state: "missing",
      installation: "source_checkout",
      path: manifest,
    });
    expect(linux.remediation).toBe(
      `The generated REA skill bundle is missing: ${manifest} does not exist. Regenerate it from .agents/skills/${SKILL}: run \`npm run build:cached\` in the source checkout ${root}, then run setup again.`,
    );

    // Windows run-exclusive builds need the native Job Object owner; the
    // generator itself does not, so the direct commands remain available.
    const windows = await unavailable(source(root, "win32"));
    expect(windows.remediation).toContain(
      "without them, run `npm run compile` and then `npm run artifacts:skills` in the checkout instead",
    );
  });

  it("names a reinstall for a package without its bundle", async () => {
    const root = await packageRoot({ sourceCheckout: false, generated: false });
    const error = await unavailable(source(root));
    expect(error).toMatchObject({ state: "missing", installation: "package" });
    expect(error.remediation).toContain(
      `Reinstall ${PRODUCT_IDENTITY.registrationPackageSpecifier} with the package manager that owns ${root}, then run setup again.`,
    );
    expect(error.remediation).not.toContain("npm run build:cached");
  });

  it("accepts only a complete bundle generated for this runtime", async () => {
    const root = await packageRoot({ sourceCheckout: true, generated: true });
    const manifest = join(root, "skills", SKILL, "SKILL.md");

    const current = await inspectSkillBundle(source(root));
    if (!current.ok) throw current.error;
    expect(current.value).toEqual({
      installation: "source_checkout",
      updateAction: `Run setup from the source checkout to update the installed REA skill: node "${join(root, "scripts", "rea.mjs")}" setup.`,
    });

    const otherCatalog = await unavailable({
      ...source(root),
      expected: { ...expected, toolCount: expected.toolCount + 1 },
    });
    expect(otherCatalog).toMatchObject({ state: "stale", path: manifest });
    expect(otherCatalog.detail).toBe(
      `${manifest} declares skill version ${expected.version} with tool_count ${String(expected.toolCount)}, but this REA runtime expects version ${expected.version} with tool_count ${String(expected.toolCount + 1)}`,
    );

    const reference = join(
      root,
      "skills",
      SKILL,
      "references/evidence-workflows.md",
    );
    await rm(reference);
    expect(await unavailable(source(root))).toMatchObject({
      state: "missing",
      path: reference,
    });

    await writeFile(reference, "restored reference\n");
    await writeFile(manifest, "---\nname: another-skill\n---\n");
    expect(await unavailable(source(root))).toMatchObject({
      state: "stale",
      detail: `${manifest} does not declare the ${SKILL} skill`,
    });
  });

  it("reports an unreadable bundle file without treating it as missing", async () => {
    const root = await packageRoot({ sourceCheckout: false, generated: true });
    const manifest = join(root, "skills", SKILL, "SKILL.md");
    await rm(manifest);
    await mkdir(manifest);
    const error = await unavailable(source(root));
    expect(error).toMatchObject({ state: "unreadable", path: manifest });
    expect(error.detail).toContain(`${manifest} could not be read`);
  });

  it("keeps installed copies inspectable and untouched without a bundle", async () => {
    const home = await createTestTempDirectory("rea-skill-bundle-home-");
    const missing = source(
      await packageRoot({ sourceCheckout: true, generated: false }),
    );
    const installed = join(home, ".agents/skills", SKILL);
    expect(await installCanonicalSkill(home)).toMatchObject({
      ok: true,
      value: "installed",
    });
    const before = await readdir(installed, { recursive: true });

    // Doctor previously failed with ENOENT while comparing with the bundle.
    expect(
      await readInstalledSkillIdentity(
        home,
        undefined,
        {},
        process.platform,
        undefined,
        missing,
      ),
    ).toEqual({ ...expected, canonical: false });
    expect(
      await canonicalSkillNeedsInstall(
        home,
        [],
        {},
        process.platform,
        undefined,
        missing,
      ),
    ).toBe(true);

    const result = await installCanonicalSkill(
      home,
      [],
      {},
      process.platform,
      {
        mkdir: () => Promise.reject(new Error("must not prepare a directory")),
        backup: () => Promise.reject(new Error("must not back up a file")),
        write: () => Promise.reject(new Error("must not write a file")),
        remove: () => Promise.reject(new Error("must not remove a file")),
      },
      undefined,
      missing,
    );
    if (result.ok) throw new Error("Expected the missing bundle to block");
    expect(result.error).toMatchObject({
      _tag: "SkillBundleUnavailableError",
      state: "missing",
    });
    expect(await readdir(installed, { recursive: true })).toEqual(before);
    expect(await readFile(join(installed, "SKILL.md"))).toEqual(
      await readFile(join(generatedBundle, "SKILL.md")),
    );
  });
});
