// Preloaded with `node --import` to prove a script never reads, opens, or
// loads the packaged Windows native artifact. Any attempt is reported on
// stderr and fails the process, whether or not the artifact exists.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const NATIVE_ARTIFACT = /(?:^|[\\/])native[\\/]windows[\\/]build(?:[\\/]|$)/u;
const ACCESS_EXIT_CODE = 97;

const pathText = (value) =>
  value instanceof URL ? fileURLToPath(value) : String(value);

const record = (operation, path) => {
  process.stderr.write(`windows-native-artifact-access ${operation} ${path}\n`);
  process.exitCode = ACCESS_EXIT_CODE;
};

const guard = (owner, name, label) => {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function guardedNativeArtifactAccess(path, ...rest) {
    const text = pathText(path);
    if (NATIVE_ARTIFACT.test(text)) record(label, text);
    return original.call(this, path, ...rest);
  };
};

for (const name of [
  "readFileSync",
  "openSync",
  "statSync",
  "lstatSync",
  "existsSync",
  "accessSync",
  "readFile",
  "open",
  "stat",
  "lstat",
  "access",
])
  guard(fs, name, name);
for (const name of ["readFile", "open", "stat", "lstat", "access"])
  guard(fs.promises, name, `promises.${name}`);
syncBuiltinESMExports();

const dlopen = process.dlopen;
process.dlopen = function guardedNativeArtifactLoad(module, filename, ...rest) {
  if (NATIVE_ARTIFACT.test(String(filename))) record("dlopen", filename);
  return dlopen.call(this, module, filename, ...rest);
};
