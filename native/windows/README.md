# Windows native controls

REA ships one Windows x64 Node-API 8 addon. Users do not compile it or install
another runtime. Ghidra and a full JDK remain bring-your-own prerequisites.
The addon uses Windows 10+ APIs and admits fixed local NTFS volumes only.

The package owns the artifact path. The loader checks the package version,
ABI, Node-API compatibility, PE architecture, and SHA-256 before loading it.
There is no environment override for loading an arbitrary native module.

## Build

The artifact lane requires Linux, MinGW-w64 `x86_64-w64-mingw32-g++`,
`x86_64-w64-mingw32-dlltool`, and `tar`. It never installs these commands.
Node-API headers are reused from the build cache or downloaded from the
pinned official Node release with its published SHA-256 checked.

```sh
npm run build:windows-native
npm run verify:windows-native:artifact
npm pack
```

`build/` is ignored by Git. The npm file inventory includes only the addon and
its manifest. Release CI builds both, and `prepublishOnly` rejects a missing,
stale, mismatched, or wrong-architecture artifact. A development tarball built
without this lane reports Windows native controls as unavailable.

## Restore the artifact in a source checkout

The source tree omits `native/windows/build/` from Git. To run Windows
provider-backed workflows from a checkout without the MinGW build lane, restore
the two files from the published `rea-agents` tarball whose version exactly
matches the checkout's `package.json` version. From the checkout root, on a
Windows, Linux, or macOS host:

```sh
npm run restore:windows-native
```

That version names the last release, not the checkout's source:
release-please bumps `package.json` only when it cuts the next release, so a
checkout with unreleased commits still declares the published version, and
the published addon can be older than the checkout's native source. The
command therefore compares that source with the release tag before it
downloads anything.

The command uses the npm registry configured for the checkout and runs, in
order:

1. Reads the exact `version` from `package.json`. Ranges and dist-tags such as
   `latest` are rejected; another REA version is never used.
2. Compares `native/windows/src` and `src/windows` (excluding `*.test.ts`)
   between the Git tag `rea-agents-<version>` and `HEAD`, including
   uncommitted and untracked changes. When they differ, it lists the commits
   after the tag that changed them and refuses with `native_source_differs`;
   build the addon with the Linux/MinGW lane above instead, or rerun with
   `npm run restore:windows-native -- --accept-release-artifact` to install
   the published addon anyway. When Git is unavailable, the checkout is not a
   Git work tree, or the tag is not present (for example in a shallow clone;
   fetch it with `git fetch origin tag rea-agents-<version>`), the report and a
   warning say that the source was not compared.
3. Reads `dist.integrity` with `npm view rea-agents@<version>`, then downloads
   the tarball with `npm pack --ignore-scripts` into a private temporary
   directory that it removes afterwards.
4. Checks that the tarball's SHA-512 matches that registry integrity and the
   one npm pack reported, and that its `package.json` names
   `rea-agents@<version>`.
5. Reads `manifest.json` and `rea-windows-x64.node` from the tarball in
   memory. The manifest must satisfy the loader's contract with
   `packageVersion` equal to the checkout version, `platform` `win32`, and
   `architecture` `x64`. The addon's SHA-256 must equal
   `manifest.artifactSha256`, and its PE header must be x86-64 PE32+.
6. Only after every check passes, writes the addon and then its manifest into
   `native/windows/build/`, each through a temporary file renamed into place.

It prints each verified value, the source comparison, and whether each file
was created, replaced, or left unchanged. An existing identical file is left
untouched. An existing file that differs, such as the artifact of an earlier
version, is refused and nothing is written; rerun with
`npm run restore:windows-native -- --replace` to replace it. A destination
that is not a regular file is never replaced. An interrupted replacement can
leave a new addon beside the old manifest, which the loader rejects by digest;
rerun the same `--replace` command to complete it.

Windows refuses to replace an addon that a running process has loaded. When
writing a file fails with `EPERM`, `EBUSY`, or `EACCES`, the command reports
`destination_in_use`, names the file, and says which files were already
written. Stop the REA processes of that checkout, including its MCP server and
any `run-exclusive` command such as `npm run build:cached`, then rerun the
same command. `EACCES` can also mean that the user cannot write the
destination.

A version that is not published, such as a fork's own version, fails without
writing anything; build that artifact with the Linux/MinGW lane above instead.
The loader still verifies the manifest version, ABI, architecture, and addon
digest before it grants authority, but it cannot tell a restored release addon
from one built from the checkout's newer source; only the comparison in step 2
does.

This is a manual recovery command. No REA build, setup, doctor, or runtime path
invokes it, and REA never fetches or installs the artifact automatically.

## Boundaries

- Opaque Node objects carry a native type tag, resource kind, and closed state.
  A pathname, serialized object, or forged handle cannot grant authority.
- Input admission opens every component with `OPEN_REPARSE_POINT`, verifies
  the actual NTFS object, and retains handles that deny replacement and source
  writing. An admitted child keeps each ancestor nonempty; ancestor handles
  permit unrelated writes while NTFS rejects in-place reparse conversion. Volume serial, 128-bit file ID, final handle path,
  requested path, size, and digest observations are preserved separately.
- New runtime roots and private child objects are created relative to admitted
  parent handles with `NtCreateFile`. A protected DACL and current-user owner
  are installed at creation. Readback permits exactly the current user and SYSTEM. Child
  files inherit this boundary; private files are also checked by handle.
- Snapshots stream through a 64 KiB buffer on a Node async worker. Cancellation
  is checked between reads, cleanup waits for settlement, and the digest
  commits to the bytes written. Descriptor and snapshot handles remain held
  until runtime cleanup.
  Snapshot ownership is single-flight per runtime: an overlapping request fails
  with `ERROR_BUSY` before acquiring cancellation ownership. The TypeScript owner
  records only the accepted promise and abort listener; aborting a rejected copy
  must not cancel the active copy.
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns a suspended child atomically to an
  unnamed, non-inherited Job Object. Membership and kill-on-close policy are
  checked before resume. Breakaway is disabled, and cleanup waits for all
  job members and captured output, including detached descendants.
- A launch may request a Job Object commit limit (`JOB_OBJECT_LIMIT_JOB_MEMORY`)
  as a positive, page-aligned safe-integer byte count; invalid values fail
  with `ERROR_INVALID_PARAMETER` before any process is created. Readback must
  match the requested flags and limit exactly. A private I/O completion port is
  associated with that job before the child is created; each poll drains it
  without waiting and records a sticky `memoryLimitReached` when
  `JOB_OBJECT_MSG_JOB_MEMORY_LIMIT` arrives, alongside the job's
  `peakJobMemoryBytes`. Notifications are drained before checking for exit
  and again after exit is observed, so a memory failure between those steps
  is included in the first exit report. Runtimes report a reached limit
  differently (Bun 1.4.2 exits 1
  after a JavaScript out-of-memory exception or 3 after a panic), so callers
  classify by the notification. `inspect` reports `jobMemoryLimit` only after
  creating such a job and port. An artifact without that capability refuses a
  requested limit rather than launching an unlimited process. REA requests
  limits only for its JavaScript helpers when running on Bun, which ignores
  their V8 heap flags; Node.js launches are unchanged.
- Only the suspended child's default file owner is normalized. Caller token
  privileges and ownership remain unchanged. Caller process priority is
  preserved in the child, and caller CPU affinity whenever both occupy the same
  processor group. Windows chooses a new process's group itself and rejects a
  mask belonging to another group, so a child placed elsewhere keeps that
  group's default when the caller asked for no bound of its own. A caller
  deliberately pinned to fewer processors than its group holds is a constraint
  such a child cannot express, and is refused rather than widened to that
  group's default. A mask covering its group's whole active set does not
  distinguish a caller Windows placed in that group from one that selected the
  group deliberately, so such a child can still be placed elsewhere: its
  processor count stays bounded, its group placement is not preserved, and
  neither that case nor the refusal above has a verification lane, because both
  need a host whose processors span more than one group.
  Environment names are sorted and deduplicated using Windows
  ordinal comparison, preserving their native Unicode semantics and
  caller-selected values.
- Cleanup walks locked directory objects, removes files by handle, and unlinks
  reparse entries without traversing their targets. Failed removal retains the
  root and ancestor leases for retry; a partially removed runtime accepts only
  cleanup, and its registry entry remains until removal succeeds. The runtime
  owner retries only native close failures with Win32 sharing/lock codes 32/33,
  for at most ten attempts with a 100 ms delay between attempts. Other native
  errors are returned immediately; exhausting the retry budget preserves the
  runtime owner for a later explicit close. These cleanup retries do not use an
  analysis cancellation signal and schedule up to 900 ms of backoff, in
  addition to native cleanup time. The owned root handle includes attribute-write access so cleanup can clear a
  read-only marker, matching the child cleanup handles. Normal close, cancellation,
  startup failure, and timeout release provider resources. Abrupt owner death
  kills the owned job. The Android provider additionally uses a detached helper
  that owns its private runtime directory and cleans it when the owner pipe
  closes. Other providers can leave private runtime files after owner death;
  helper death and host power loss are not transactional deletion.

Windows failures retain their constraint, requested coordinate, Win32 code,
and system message. Unsupported filesystems and reparse paths are distinct
from OS access denial and missing packaged controls.

A failed runtime-parent admission additionally reports
`runtimeAllocation: "not-started"`: no runtime directory was created. The
Windows adapter uses that fact with numeric sharing/lock codes 32/33 to retain
a retryable private-runtime failure, including after successful native
authority caching. Missing allocation evidence, other codes, and opaque error
text do not establish a safe retry. Analysis errors propagate the producer's
retry disposition through JavaScript, source-map and WABT workflows; transient
failures report `category: unavailable` and retain the original reason.
Incomplete cleanup blocks an operation retry until its owned resources settle.
The close-stage retry is separate from allocation and analysis retries: it
repeats only the existing owned cleanup operation, and does not retry provider
work or create another runtime.

Ordinary drive-absolute paths accept backslashes, forward slashes, or mixed
separators. File identity retains the original requested spelling. Separator
translation does not resolve dot components, repeated separators, or extend
the supported device/UNC namespaces; existing admission checks still apply.

The bearer-token descriptor remains under its immutable private lease until
`runtime_close` on Windows; POSIX removes the descriptor after the bridge reads
it. Job ownership guarantees process termination on owner death. Android's
detached workspace helper provides a separate cleanup owner for that provider,
but simultaneous helper death or power loss can still leave private files.
SUBST drive aliases and changing DOS-device
namespaces are outside the verified P0 scope and are not detected as a separate
alias policy. Mounted-folder paths that report a reparse tag are rejected by
component admission; broader namespace variants remain unverified. Preserve
requested and final handle coordinates rather than treating them as one identity.

## Real verification

```powershell
npm run verify:windows-native
npm run verify:ghidra:windows
```

An unpublished runtime retains its directory and parent handles if validation,
result publication, or rollback fails. Errors retain the original failure and
any rollback failure. Later runtime creation or native inspection retries that
exact owner before allocating another directory. The same owner covers the
native inspection probe. A later availability query retries failed probe cleanup;
successful admission and static artifact failures remain cached. Environment
teardown makes one final cleanup attempt and reports a persistent failure to
stderr rather than claiming the directory was removed.

CI separately builds and verifies a test-only artifact:

```sh
node scripts/build-windows-native.mjs --inspection-fixture
```

On Windows, after compiling the runtime:

```powershell
node scripts/verify-windows-native-inspection.mjs
```

This artifact injects an access-denied disposition result while using real
NTFS directories, and separately denies post-create validation and rollback.
The verifier checks retained ownership after inspection and direct runtime
creation failures, recovery on later admission, cached successful inspection,
and cleanup on environment teardown. It
renames the retained probe and recreates its old path, checking that cleanup
removes the owned inode while preserving the replacement directory.
It does not reproduce or identify the host-dependent cause reported in #1701.
The fixture is stored under `.cache/` and is excluded from the shipped addon.

The native lane checks DACL readback independently, source write/replacement
rejection, unrelated sibling renames, reparse rejection, immutable snapshots,
asynchronous cancellation, cleanup containment,
descendant termination, unrelated-process preservation, normal exit, owner
close, forced owner exit, and Job Object commit limits: invalid limit
rejection, a 128 MiB-limited child allocating external Buffer memory that the
V8 heap flags cannot bound (limit notification, peak commit at the limit, all
members settled, with the notification present in the first native exit report
and the wrapper's exit event), and a control under the same limit that
completes normally.
A separately built `tests/fixtures/windows/processBoundary.cc` executable adds
breakaway, caller/child token and environment semantics observations and an
in-place ancestor reparse attempt. The lane skips all of them when the
executable is absent, so both Windows workflows cross-build it in the same
MinGW job that builds their artifact and pass it: the capability and package
lane in `.github/workflows/ci.yml`, and the real Ghidra proof run in
`.github/workflows/real-ghidra-windows.yml`. Build it locally with any Windows
C++ compiler, or the same way they do, and pass its path:

```powershell
node scripts/verify-windows-native.mjs . C:\fixtures\process-boundary.exe
```

`nonAdminRunner.cc` is a test-only launcher for an elevated development shell.
It duplicates an existing non-elevated Explorer token belonging to the same
user, creates private temporary window-station objects, and launches the test
inside a kill-on-close fixture job. It does not create accounts, modify host
policy, or change the caller's token. A real-provider claim must additionally
verify the packaged CLI and MCP on that ordinary-user token.
