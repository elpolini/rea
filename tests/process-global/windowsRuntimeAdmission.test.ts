import { beforeEach, expect, it, vi } from "vitest";
import { WindowsPrivateRuntime } from "../../src/windows/WindowsPrivateRuntime.js";
import { PrivateRuntimeRootUnavailableError } from "../../src/process/PrivateRuntimeRootUnavailableError.js";

const { nativeCall } = vi.hoisted(() => ({ nativeCall: vi.fn() }));
vi.mock("../../src/windows/WindowsNativeLoader.js", async (original) => ({
  ...(await original<
    typeof import("../../src/windows/WindowsNativeLoader.js")
  >()),
  requireWindowsNativeAuthority: () => ({ call: nativeCall }),
}));
beforeEach(() => {
  nativeCall.mockReset();
});

it.each([
  {
    label: "sharing conflict before allocation",
    win32Code: 32,
    runtimeAllocation: "not-started",
    retryable: true,
  },
  {
    label: "lock conflict before allocation",
    win32Code: 33,
    runtimeAllocation: "not-started",
    retryable: true,
  },
  { label: "unknown allocation", win32Code: 32, retryable: false },
  {
    label: "possible allocation",
    win32Code: 32,
    runtimeAllocation: "started",
    retryable: false,
  },
  {
    label: "permission failure",
    win32Code: 5,
    runtimeAllocation: "not-started",
    retryable: false,
  },
  {
    label: "string code",
    win32Code: "32",
    runtimeAllocation: "not-started",
    retryable: false,
  },
  {
    label: "inconsistent error code",
    win32Code: 32,
    code: "EACCES",
    runtimeAllocation: "not-started",
    retryable: false,
  },
])(
  "retains $label without guessing runtime ownership",
  ({ retryable, label: _label, ...facts }) => {
    const cause = Object.assign(new Error("Selected native diagnostic"), {
      code: "ERR_REA_WINDOWS_NATIVE",
      ...facts,
    });
    nativeCall.mockImplementation(() => {
      throw cause;
    });
    let observed: unknown;
    try {
      WindowsPrivateRuntime.create("D:/selected parent", "selected-prefix-");
    } catch (failure: unknown) {
      observed = failure;
    }
    expect(nativeCall).toHaveBeenCalledTimes(1);
    expect(nativeCall).toHaveBeenCalledWith("runtime_create", [
      "D:\\selected parent",
      "selected-prefix-",
    ]);
    if (retryable) {
      expect(observed).toBeInstanceOf(PrivateRuntimeRootUnavailableError);
      expect(observed).toMatchObject({
        message: cause.message,
        cause,
        retryable: true,
      });
    } else expect(observed).toBe(cause);
  },
);

const nativeRuntimeParent = (parent: string): unknown => {
  const declined = new Error("parent recorded");
  nativeCall.mockReset();
  nativeCall.mockImplementation(() => {
    throw declined;
  });
  expect(() =>
    WindowsPrivateRuntime.create(parent, "selected-prefix-"),
  ).toThrow(declined);
  expect(nativeCall).toHaveBeenCalledTimes(1);
  return nativeCall.mock.calls[0]?.[1]?.[0];
};

// An inherited TEMP reaches os.tmpdir() verbatim. The native walker rejects
// empty, `.` and `..` components that Win32 resolves to the same directory,
// so runtimes failed with "Ambiguous Windows path component" (#4707).
it.each([
  ["forward separators", "D:/Users/u/AppData/Local/Temp"],
  ["repeated separators", "D:\\\\Users\\\\u\\\\AppData\\\\Local\\\\Temp"],
  ["repeated forward separators", "D://Users//u//AppData//Local//Temp"],
  ["mixed separators", "D:/Users\\u//AppData\\\\Local/Temp"],
  ["dot components", "D:\\Users\\u\\.\\AppData\\Roaming\\..\\Local\\Temp\\"],
])(
  "admits a drive parent with %s as the directory Win32 resolves",
  (_label, parent) => {
    expect(nativeRuntimeParent(parent)).toBe(
      "D:\\Users\\u\\AppData\\Local\\Temp",
    );
  },
);

it.each([
  ["a relative parent", "Temp"],
  ["a root-relative parent", "\\Temp"],
  ["a drive-relative parent", "D:Temp"],
  ["a UNC parent", "\\\\server\\share\\Temp"],
  ["a forward-slash UNC parent", "//server/share/Temp"],
  ["an extended-length parent", "\\\\?\\D:\\Temp"],
  ["a device parent", "\\\\.\\D:\\Temp"],
])("leaves %s for native admission to decide", (_label, parent) => {
  expect(nativeRuntimeParent(parent)).toBe(parent);
});

it("keeps trailing-dot and stream components for native admission to reject", () => {
  expect(nativeRuntimeParent("D://Temp.//cache")).toBe("D:\\Temp.\\cache");
  expect(nativeRuntimeParent("D:/Temp/cache::$INDEX_ALLOCATION")).toBe(
    "D:\\Temp\\cache::$INDEX_ALLOCATION",
  );
});

it("does not infer a transient status from a human-readable diagnostic", () => {
  const cause = new Error("Open Windows path component failed (Win32 32)");
  nativeCall.mockImplementation(() => {
    throw cause;
  });
  let observed: unknown;
  try {
    WindowsPrivateRuntime.create("D:/selected parent", "selected-prefix-");
  } catch (failure: unknown) {
    observed = failure;
  }
  expect(observed).toBe(cause);
});
