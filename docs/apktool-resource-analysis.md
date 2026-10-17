# Apktool resource decoding

REA decodes Android resource tables and the binary manifest through the
caller's Apktool launcher. This completes the static triad for Android
targets: Java/Kotlin sources through the JADX family, engine-grade
decompilation through JEB, and resources through this family. REA never
installs Apktool or a Java runtime.

## Supply tools

Use Apktool 2.7.0 or newer (verified with 2.7.0) and a Java runtime the
launcher can find. Select the launcher through the environment:

```sh
# Optional: absolute path to the apktool launcher (upstream wrapper or a
# java -jar script); without it, apktool resolves from PATH.
export REA_APKTOOL_COMMAND=/absolute/path/apktool
```

For setup registration, set `REA_APKTOOL_COMMAND` in the REA process
environment before running `rea setup`. The approved setup plan records the
exact selected path in the agent's REA server environment after checking that
it is absolute. A blank or relative value is not recorded. A launcher found on
`PATH` is not copied either, nor is `PATH` itself: the registered server
resolves Apktool from the environment its client starts it with. Recording
does not run the launcher.

Readiness is `rea inspect-apktool-client`: it runs `apktool --version` and
reports the resolved launcher, its selection source, and its version. A
missing launcher reports `capability_unavailable` with the
`REA_APKTOOL_COMMAND` remediation rather than attempting an installation.
`binary_session` uses the same host probe for tool availability; it does not
validate a particular APK or guarantee that the selected input can be decoded.

On Windows, a `.bat` or `.cmd` launcher (such as Chocolatey's `apktool.bat`)
runs through an explicit `cmd.exe /d /s /c` call. That call has no AutoRun,
no delayed expansion, and quotes every argument. A launcher path that
contains `"`, `%`, `^`, `!`, `&`, `|`, `<` or `>` is reported as
`not_configured` instead of being passed to `cmd.exe`. If REA's temporary
decode paths contain those characters, decoding through a batch launcher
reports `capability_unavailable`.

## Answer an analyst question

```sh
rea inspect-apktool-client
rea decode-android-resources /targets/Example.apk
rea decode-android-resources /targets/Example.apk --locale de
rea decode-android-resources /targets/Example.apk --no-strings
```

Equivalent MCP methods are `inspect_apktool_client` and
`decode_android_resources`. The decode request takes `path`, an optional
`locale` (project `res/values-<locale>/strings.xml` instead of the default
table), and `include_strings` (default true). Regional locales such as `pt-BR`
select Android's `values-pt-rBR`; Android qualifiers such as `pt-rBR` and
`b+zh+Hans+CN` may also be supplied directly.

## Interpret the result

- **An owned APK snapshot is digested and decoded.** `target.sha256` and
  `target.bytes` bind the observation to the exact APK that was decoded.
- **Metadata comes from apktool.yml as apktool printed it.** Version codes
  keep their own spelling (`'7'` versus `7`); `package_name` is read from
  the decoded manifest, not inferred.
- **The manifest is the decoded text**, bounded at 512 KiB and reported as
  truncated when larger.
- **`entry_points` is parsed from that same manifest text**, once, with the
  strict XML parser that also reads `package_name`. It is `null` when the
  manifest is missing or truncated; a manifest that is not well-formed XML
  fails the decode as unreadable output, as before. See
  [Entry points](#entry-points).
- **Strings are projected verbatim.** Escaped entities stay escaped, and
  entries containing nested markup (`<b>`, `<xliff:g>`) are counted as
  unparsed rather than flattened — the limitation names the count. The
  default table is bounded to 2000 entries with partial coverage when more
  exist; `locales` lists every `values-<locale>` that has a strings table.
- **Smali is skipped by design** (`apktool d --no-src`): Java-source
  recovery belongs to the JADX family. Resource smali edits and rebuild are
  a follow-up lane with mutation authority.
- **Workspaces are owned and short-lived.** Decoding happens in a
  provider-owned temporary directory that is removed before the result is
  returned. The APK snapshot and framework cache both live inside this directory.
  If removal fails, the result names the residual path and the provider retains
  ownership for a cleanup retry on close, including failed decodes.

## Entry points

`entry_points.components` lists every `<activity>`, `<activity-alias>`,
`<service>`, and `<receiver>` declared directly under the first
`<application>`, in document order. Providers, instrumentation, and elements
outside `<application>` are not entry points here. Each component reports:

- `kind` and `name`. A name that starts with `.` or contains no `.` is
  resolved against the manifest package, as Android's parser does; without a
  package it stays as declared and a limitation says so.
- `target_activity` for an alias (resolved the same way), otherwise `null`.
- `exported`, `enabled`, and `permission` exactly as the component declares
  them, `null` when undeclared. Android's defaults (for example, the
  intent-filter rule for an unset `exported`) and values inherited from
  `<application>` or an alias target are not applied.
- `launcher`: an activity or alias has a filter with action
  `android.intent.action.MAIN` and category
  `android.intent.category.LAUNCHER`.
- `intent_filters`, each with its distinct `actions` and `categories`,
  `auto_verify`, and one `data` entry per `<data>` element. A `data` entry
  has `scheme`, `host`, `port`, `path`, `path_prefix`, `path_pattern`,
  `path_advanced_pattern`, `path_suffix`, and `mime_type`, each `null` when
  that element does not declare it.

`entry_points.deep_links` is derived, not observed. Only activity and alias
filters that declare at least one scheme contribute. Within one filter,
Android combines all `<data>` elements: every distinct scheme with every
distinct host/port authority, and every distinct path with an authority. A
filter without a host yields one row per scheme with `host`, `port`, and
`path` `null`; paths and ports declared without a host are ignored, as
Android matching ignores them. Each row names the `component`, `path_kind`
(`exact`, `prefix`, `pattern`, `advanced_pattern`, or `suffix`), whether the
filter is `browsable`, and its `auto_verify`. `uri` is a display string only
(`myapp:`, `https://host:8443/item`, `https://host/shop*`); match on the
structured fields. Deep links do not check the filter's actions.

Values are reported as the decoded manifest declares them; nothing is
resolved against resource tables:

- Text that is a resource or theme reference (`@string/deep_host`,
  `?attr/x`) stays as declared in `name`, `permission`, `data`, and
  `deep_links`, including inside `uri`.
- A boolean whose value is not literal `true` or `false`, such as
  `@bool/atLeastHoneycomb`, reports `null`.
- One limitation counts these unresolved values and names the first
  `attribute=value` groups. The declaration itself remains in `manifest`.

Coverage becomes `partial` when the projection omits something it examined:

- A component without `android:name`, an alias without
  `android:targetActivity`, an `<action>` or `<category>` without a name, or
  an `<application>` after the first. The limitation names the element and
  its line.
- `<data>` attributes outside the projection, such as `ssp`, `sspPrefix`,
  `fragment`, or `query`. Deep links derived from those filters omit those
  constraints.
- `<uri-relative-filter-group>` elements inside an `<intent-filter>`. Their
  allow and deny rules are not modeled, so derived deep links can be broader
  than what Android matches.
- More than 2,000 derived deep links. The limitation reports the full product
  size, which is counted without enumerating it.

## Resource and lifecycle limits

- The decode runs with a 600 s deadline and a 4 MiB output capture budget;
  a stopped decode reports `provider_timeout` and exceeded budgets report
  `resource_constraint`.
- Manifest reads are bounded to 512 KiB before decoding UTF-8. Strings XML
  reads are bounded to 8 MiB; larger documents are skipped with partial
  coverage and an explicit limit, rather than reported as missing.
- `decoded_file_count` is capped at 100,000 files; the cap is reported in
  the limitations when hit.
- `entry_points.components` grows linearly with the 512 KiB manifest budget.
  `deep_links` multiply schemes, authorities, and paths within one filter, so
  they are bounded to 2,000 rows with partial coverage beyond that.
- Apktool's own decode failures (`AndrolibException`, directory traversal
  refusals) surface as `unsupported_target` with apktool's reason preserved
  verbatim.

## Real verification

`npm run verify:apktool -- --apk PATH` exercises both operations against a
real launcher. Record: apktool 2.7.0-dirty (Debian packaging) on Linux with
OpenJDK 25 against a signed aapt2-built probe APK carrying two resource
locales — launcher version, on-disk digest agreement, apktool.yml metadata
(1.2.3, SDK 24–34), manifest package agreement, default and `de` string
tables projected. Parser goldens in the test suite come from the same
decode. Entry points were checked on Windows 11 with Apktool 2.12.1 and
JDK 21 against `ApiDemos-debug.apk` 6.0.18: 351 components (331 activities,
2 aliases, 11 services, 7 receivers), one launcher activity, no deep links
because that APK declares no `<data>` elements, and 57 `@bool` `enabled`
values reported as unresolved. The manifest-excerpt golden in
`src/apktool/ApktoolManifest.test.ts` comes from that decode. Deep links
were checked through the CLI against a copy of that APK rebuilt with
`apktool b` (aapt2) after adding three activity filters: one browsable,
auto-verified filter with two schemes, two authorities, and two paths
produced its eight rows; an `@string` host stayed as declared; and an
`sspPrefix` constraint made coverage partial. Other derivation rules are
covered by parser tests. See `docs/testing.md` for the lane summary.
