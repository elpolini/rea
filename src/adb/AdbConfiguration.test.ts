import { describe, expect, it } from "vitest";

import {
  ADB_BINARY_ENV,
  adbRegistrationEnvironment,
  parseAdbVersionOutput,
  resolveAdbBinary,
} from "./AdbConfiguration.js";

describe("resolveAdbBinary", () => {
  it("prefers an absolute REA_ADB_PATH", () => {
    expect(resolveAdbBinary({ [ADB_BINARY_ENV]: "/opt/tools/adb" })).toEqual({
      binary: "/opt/tools/adb",
      pathSource: "environment",
    });
  });

  it("falls back to PATH resolution without the environment key", () => {
    expect(resolveAdbBinary({})).toEqual({
      binary: "adb",
      pathSource: "path",
    });
    expect(resolveAdbBinary({ [ADB_BINARY_ENV]: "  " })).toEqual({
      binary: "adb",
      pathSource: "path",
    });
  });

  it("rejects a relative environment path explicitly", () => {
    expect(() => resolveAdbBinary({ [ADB_BINARY_ENV]: "tools/adb" })).toThrow(
      /must be an absolute path/u,
    );
  });
});

describe("adbRegistrationEnvironment", () => {
  const ambient = { PATH: "/ambient/bin", TEMP: "/ambient/temp" };

  it("publishes only the explicit binary, exactly as selected", () => {
    expect(
      adbRegistrationEnvironment({
        ...ambient,
        [ADB_BINARY_ENV]: "/opt/platform-tools/adb",
      }),
    ).toEqual({ [ADB_BINARY_ENV]: "/opt/platform-tools/adb" });
  });

  it.each([
    { name: "an unset selection", value: undefined },
    { name: "an empty selection", value: "" },
    { name: "a blank selection", value: "  " },
    { name: "a relative path", value: "platform-tools/adb" },
  ])(
    "publishes nothing for $name, including the PATH that would resolve it",
    ({ value }) => {
      expect(
        adbRegistrationEnvironment({ ...ambient, [ADB_BINARY_ENV]: value }),
      ).toEqual({});
    },
  );
});

describe("parseAdbVersionOutput", () => {
  it("reads the build version and install path from real output", () => {
    expect(
      parseAdbVersionOutput(
        [
          "Android Debug Bridge version 1.0.41",
          "Version 34.0.5-debian",
          "Installed as /usr/lib/android-sdk/platform-tools/adb",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      version: "34.0.5-debian",
      installedPath: "/usr/lib/android-sdk/platform-tools/adb",
    });
  });

  it("reports null identity fields when the named lines are absent", () => {
    expect(parseAdbVersionOutput("unexpected output")).toEqual({
      version: null,
      installedPath: null,
    });
  });

  it("does not accept arbitrary successful output as an adb version", () => {
    expect(
      parseAdbVersionOutput(
        "Android Debug Bridge version tomorrow\nVersion unknown\n",
      ),
    ).toMatchObject({ version: null });
  });
});
