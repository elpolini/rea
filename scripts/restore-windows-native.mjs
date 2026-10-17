#!/usr/bin/env node

// Manual source-checkout recovery: restores native/windows/build from the
// published rea-agents tarball of this checkout's exact version. No other
// script, build, or runtime path invokes it.

import { fileURLToPath } from "node:url";

import {
  RESTORE_USAGE,
  WindowsNativeRestoreError,
  formatRestoreReport,
  parseRestoreArguments,
  restoreWindowsNative,
} from "./lib/windows-native-restore.mjs";

try {
  const options = parseRestoreArguments(process.argv.slice(2));
  if (options.help) process.stdout.write(RESTORE_USAGE);
  else {
    const report = await restoreWindowsNative({
      root: fileURLToPath(new URL("../", import.meta.url)),
      replace: options.replace,
    });
    process.stdout.write(formatRestoreReport(report));
    if (report.retainedDownload !== undefined)
      process.stderr.write(`warning: ${report.retainedDownload}\n`);
  }
} catch (cause) {
  process.stderr.write(
    cause instanceof WindowsNativeRestoreError
      ? `restore:windows-native failed (${cause.code}): ${cause.message}\n`
      : `restore:windows-native failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
  );
  process.exitCode = 1;
}
