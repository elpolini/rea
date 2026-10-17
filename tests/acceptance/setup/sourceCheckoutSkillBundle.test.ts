import { access, copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect } from "vitest";

import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const SKILL = "reverse-engineer-anything";

/**
 * A package root that runs this checkout's compiled runtime and dependencies
 * but has no generated `skills/` output, as after a source checkout's
 * `npm ci` without `npm run build:cached`.
 */
const packageRootWithoutBundle = async (sourceCheckout: boolean) => {
  const root = await createTestTempDirectory("rea-skill-bundle-cli-");
  const link = process.platform === "win32" ? "junction" : "dir";
  await mkdir(join(root, "scripts"));
  await copyFile(resolve("package.json"), join(root, "package.json"));
  await copyFile(resolve("scripts/rea.mjs"), join(root, "scripts/rea.mjs"));
  await symlink(resolve("dist"), join(root, "dist"), link);
  await symlink(resolve("node_modules"), join(root, "node_modules"), link);
  if (sourceCheckout) {
    await mkdir(join(root, ".agents/skills", SKILL), { recursive: true });
    await copyFile(
      resolve(".agents/skills", SKILL, "SKILL.md"),
      join(root, ".agents/skills", SKILL, "SKILL.md"),
    );
  }
  const home = join(root, "home");
  await mkdir(home);
  return { root, home };
};

/** Run the copied launcher; preserved links keep its package root in the copy. */
const runRea = async (
  processes: TestProcesses,
  { root, home }: { readonly root: string; readonly home: string },
  arguments_: readonly string[],
) => {
  const result = await processes.run(
    process.execPath,
    [
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      join(root, "scripts/rea.mjs"),
      ...arguments_,
      "--json",
    ],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        ...(process.platform === "win32"
          ? {
              SystemRoot: process.env.SystemRoot,
              TEMP: tmpdir(),
              TMP: tmpdir(),
            }
          : {}),
      },
    },
  );
  return { ...result, json: JSON.parse(result.stdout) as unknown };
};

processTest(
  "source checkout setup names the skill build before changing any client",
  async ({ processes }) => {
    const checkout = await packageRootWithoutBundle(true);
    const manifest = join(checkout.root, "skills", SKILL, "SKILL.md");
    for (const mode of ["--dry-run", "--yes"]) {
      const setup = await runRea(processes, checkout, [
        "setup",
        "--client",
        "claude_code",
        mode,
      ]);
      expect(setup.exitCode, setup.stdout).toBe(1);
      expect(setup.json).toMatchObject({
        status: "needs_human",
        code: "skill_install_failed",
        appliedActions: [],
        clients: {},
      });
      const { remediation } = setup.json as { readonly remediation: string };
      expect(remediation).toContain(
        `The generated REA skill bundle is missing: ${manifest} does not exist.`,
      );
      expect(remediation).toContain(
        `run \`npm run build:cached\` in the source checkout ${checkout.root}`,
      );
      expect(remediation).toContain("rerun setup with --skill=false");
      if (process.platform === "win32")
        expect(remediation).toContain("npm run artifacts:skills");
    }
    await expect(
      access(join(checkout.home, ".claude.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(checkout.home, ".claude/skills", SKILL)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const registrationOnly = await runRea(processes, checkout, [
      "setup",
      "--client",
      "claude_code",
      "--skill=false",
      "--dry-run",
    ]);
    expect(registrationOnly.exitCode, registrationOnly.stdout).toBe(0);
    expect(registrationOnly.json).toMatchObject({ status: "planned" });
  },
);

processTest(
  "source checkout doctor reports an unverifiable skill with the checkout build",
  async ({ processes }) => {
    const checkout = await packageRootWithoutBundle(true);
    // A copy installed from an earlier build: current metadata, no bundle.
    await cp(
      resolve("skills", SKILL),
      join(checkout.home, ".claude/skills", SKILL),
      { recursive: true },
    );
    const doctor = await runRea(processes, checkout, [
      "doctor",
      "--client",
      "claude_code",
      "--skill",
    ]);
    expect(doctor.exitCode, doctor.stdout).toBe(1);
    expect(doctor.json).toMatchObject({
      healthy: false,
      identity: {
        skill: {
          state: "unknown",
          installed_version: PRODUCT_IDENTITY.skillVersion,
        },
      },
    });
    const { identity } = doctor.json as {
      readonly identity: { readonly skill: { readonly remediation: string } };
    };
    expect(identity.skill.remediation).toContain(
      `run \`npm run build:cached\` in the source checkout ${checkout.root}`,
    );
    expect(identity.skill.remediation).not.toContain("Run rea setup");
  },
);

processTest(
  "installed package setup names a reinstall for a missing skill bundle",
  async ({ processes }) => {
    const installed = await packageRootWithoutBundle(false);
    const setup = await runRea(processes, installed, [
      "setup",
      "--skill-client",
      "claude_code",
      "--dry-run",
    ]);
    expect(setup.exitCode, setup.stdout).toBe(1);
    expect(setup.json).toMatchObject({
      status: "needs_human",
      code: "skill_install_failed",
    });
    const { remediation } = setup.json as { readonly remediation: string };
    expect(remediation).toContain(
      `Reinstall ${PRODUCT_IDENTITY.registrationPackageSpecifier} with the package manager that owns ${installed.root}`,
    );
    expect(remediation).not.toContain("npm run build:cached");
    expect(remediation).not.toContain("--skill=false");
  },
);
