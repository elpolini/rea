import { describe, expect, it } from "vitest";

import { androidEntryPointsSchema } from "../domain/apktool/apktoolResourceAnalysis.js";
import {
  MAX_DEEP_LINKS,
  parseDecodedManifest,
  projectManifestRead,
  type DecodedManifest,
} from "./ApktoolManifest.js";

const ANDROID = 'xmlns:android="http://schemas.android.com/apk/res/android"';

const manifestWith = (
  application: string,
  packageName: string | null = "com.rea.probe",
): string =>
  [
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
    `<manifest ${ANDROID}${packageName === null ? "" : ` package="${packageName}"`}>`,
    `    <application android:label="@string/app_name">${application}</application>`,
    "</manifest>",
    "",
  ].join("\n");

const decoded = (manifest: string): DecodedManifest => {
  const result = parseDecodedManifest(manifest);
  if (!result.ok) throw result.error;
  // Every projection must satisfy the advertised strict result schema.
  expect(androidEntryPointsSchema.parse(result.value.entryPoints)).toEqual(
    result.value.entryPoints,
  );
  return result.value;
};

const NO_DATA = {
  scheme: null,
  host: null,
  port: null,
  path: null,
  path_prefix: null,
  path_pattern: null,
  path_advanced_pattern: null,
  path_suffix: null,
  mime_type: null,
};

describe("manifest package", () => {
  it("reads the package attribute from a decoded manifest", () => {
    const manifest =
      '<?xml version="1.0" encoding="utf-8" standalone="no"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" android:compileSdkVersion="34" package="com.rea.apktool.probe" platformBuildVersionCode="34">';
    expect(decoded(`${manifest}</manifest>`)).toEqual({
      packageName: "com.rea.apktool.probe",
      entryPoints: { components: [], deep_links: [] },
      coverage: "complete",
      limitations: [],
    });
  });

  it("reads package with reordered or single-quoted XML attributes", () => {
    expect(
      decoded("<manifest debug='false' package='org.rea.app' />").packageName,
    ).toBe("org.rea.app");
  });

  it("reports null when no package attribute exists", () => {
    expect(decoded("<manifest>\n</manifest>\n").packageName).toBeNull();
  });

  it("reads the package when unrelated manifest text contains U+FFFD", () => {
    expect(
      decoded(
        '<manifest package="org.rea.app"><application label="�"/></manifest>',
      ).packageName,
    ).toBe("org.rea.app");
  });

  it.each([
    [
      '<manifest package=org.rea.app><application label="�"/></manifest>',
      /AndroidManifest.xml is not well-formed XML/u,
    ],
    [
      '<manifest package="p"><application><activity android:name=".A"/></application></manifest>',
      /AndroidManifest.xml is not well-formed XML/u,
    ],
    ["<resources/>", /AndroidManifest.xml root must be <manifest>/u],
  ])(
    "refuses an unreadable manifest as a protocol error: %s",
    (xml, message) => {
      const result = parseDecodedManifest(xml);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error._tag).toBe("AnalysisProtocolError");
      expect(result.error.message).toMatch(message);
    },
  );
});

describe("bounded manifest reads", () => {
  it("reports a missing manifest as unavailable rather than empty", () => {
    expect(projectManifestRead({ text: null, truncated: false }, 64)).toEqual({
      ok: true,
      value: {
        packageName: null,
        entryPoints: null,
        coverage: "complete",
        limitations: [
          "No AndroidManifest.xml was found in the decoded workspace; package_name and entry_points are unavailable",
        ],
      },
    });
  });

  it("does not parse a truncated prefix, even when it is well-formed", () => {
    expect(
      projectManifestRead(
        {
          text: manifestWith('<activity android:name=".Main"/>'),
          truncated: true,
        },
        64,
      ),
    ).toEqual({
      ok: true,
      value: {
        packageName: null,
        entryPoints: null,
        coverage: "partial",
        limitations: [
          "manifest is truncated at 64 bytes; package_name and entry_points are not derived from the incomplete document",
        ],
      },
    });
  });

  it("parses a complete read once for package and entry points", () => {
    const result = projectManifestRead(
      {
        text: manifestWith('<activity android:name=".Main"/>'),
        truncated: false,
      },
      1024,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        packageName: "com.rea.probe",
        entryPoints: { components: [{ name: "com.rea.probe.Main" }] },
      },
    });
  });
});

describe("real Apktool manifest excerpt", () => {
  it("projects a real Apktool launcher activity, alias, receiver, and service", () => {
    // Excerpt of Apktool 2.12.1 output for ApiDemos-debug.apk (CRLF kept).
    const manifest = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" android:compileSdkVersion="33" android:compileSdkVersionCodename="13" package="io.appium.android.apis" platformBuildVersionCode="33" platformBuildVersionName="13">',
      '    <instrumentation android:label="Local Sample" android:name=".app.LocalSampleInstrumentation" android:targetPackage="io.appium.android.apis"/>',
      '    <application android:allowBackup="false" android:label="@string/activity_sample_code" android:name="io.appium.android.apis.ApiDemosApplication">',
      '        <activity android:exported="true" android:name="io.appium.android.apis.ApiDemos">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.MAIN"/>',
      '                <category android:name="android.intent.category.DEFAULT"/>',
      '                <category android:name="android.intent.category.LAUNCHER"/>',
      "            </intent-filter>",
      "        </activity>",
      '        <activity android:enabled="@bool/atLeastHoneycomb" android:exported="true" android:label="@string/activity_recreate" android:name="io.appium.android.apis.app.ActivityRecreate">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.MAIN"/>',
      '                <category android:name="appium.android.intent.category.SAMPLE_CODE"/>',
      "            </intent-filter>",
      "        </activity>",
      '        <provider android:authorities="io.appium.android.apis.app.LoaderThrottle" android:enabled="@bool/atLeastHoneycomb" android:name="io.appium.android.apis.app.LoaderThrottle$SimpleProvider"/>',
      '        <service android:exported="false" android:name="io.appium.android.apis.app.MessengerService" android:process=":remote"/>',
      '        <receiver android:enabled="false" android:exported="true" android:name="io.appium.android.apis.os.SmsMessageReceiver">',
      "            <intent-filter>",
      '                <action android:name="android.provider.Telephony.SMS_RECEIVED"/>',
      "            </intent-filter>",
      "        </receiver>",
      '        <activity-alias android:exported="true" android:label="@string/sample_shortcuts" android:name="io.appium.android.apis.app.CreateShortcuts" android:targetActivity="io.appium.android.apis.app.LauncherShortcuts">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.CREATE_SHORTCUT"/>',
      '                <category android:name="android.intent.category.DEFAULT"/>',
      "            </intent-filter>",
      "        </activity-alias>",
      "    </application>",
      "</manifest>",
    ].join("\r\n");
    const result = decoded(manifest);
    expect(result.packageName).toBe("io.appium.android.apis");
    expect(result.entryPoints.components).toEqual([
      {
        kind: "activity",
        name: "io.appium.android.apis.ApiDemos",
        target_activity: null,
        exported: true,
        enabled: null,
        permission: null,
        launcher: true,
        intent_filters: [
          {
            actions: ["android.intent.action.MAIN"],
            categories: [
              "android.intent.category.DEFAULT",
              "android.intent.category.LAUNCHER",
            ],
            auto_verify: null,
            data: [],
          },
        ],
      },
      {
        kind: "activity",
        name: "io.appium.android.apis.app.ActivityRecreate",
        target_activity: null,
        exported: true,
        enabled: null,
        permission: null,
        launcher: false,
        intent_filters: [
          {
            actions: ["android.intent.action.MAIN"],
            categories: ["appium.android.intent.category.SAMPLE_CODE"],
            auto_verify: null,
            data: [],
          },
        ],
      },
      {
        kind: "service",
        name: "io.appium.android.apis.app.MessengerService",
        target_activity: null,
        exported: false,
        enabled: null,
        permission: null,
        launcher: false,
        intent_filters: [],
      },
      {
        kind: "receiver",
        name: "io.appium.android.apis.os.SmsMessageReceiver",
        target_activity: null,
        exported: true,
        enabled: false,
        permission: null,
        launcher: false,
        intent_filters: [
          {
            actions: ["android.provider.Telephony.SMS_RECEIVED"],
            categories: [],
            auto_verify: null,
            data: [],
          },
        ],
      },
      {
        kind: "activity-alias",
        name: "io.appium.android.apis.app.CreateShortcuts",
        target_activity: "io.appium.android.apis.app.LauncherShortcuts",
        exported: true,
        enabled: null,
        permission: null,
        launcher: false,
        intent_filters: [
          {
            actions: ["android.intent.action.CREATE_SHORTCUT"],
            categories: ["android.intent.category.DEFAULT"],
            auto_verify: null,
            data: [],
          },
        ],
      },
    ]);
    expect(result.entryPoints.deep_links).toEqual([]);
    // The @bool reference is unresolved, not guessed, and named explicitly.
    expect(result.coverage).toBe("complete");
    expect(result.limitations).toEqual([
      "entry_points leaves 1 resource reference(s) or non-literal value(s) unresolved: text keeps the declared value and booleans report null: enabled=@bool/atLeastHoneycomb (1)",
    ]);
  });
});

describe("entry point components", () => {
  it("resolves relative names and aliases against the manifest package", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".MainActivity">
          <intent-filter>
            <action android:name="android.intent.action.MAIN"/>
            <category android:name="android.intent.category.LAUNCHER"/>
          </intent-filter>
        </activity>
        <activity-alias android:name="Launcher" android:targetActivity=".MainActivity" android:exported="true" android:permission="com.rea.probe.LAUNCH">
          <intent-filter>
            <action android:name="android.intent.action.MAIN"/>
            <category android:name="android.intent.category.LAUNCHER"/>
          </intent-filter>
        </activity-alias>
        <service android:name="org.other.Sync">
          <intent-filter>
            <action android:name="android.intent.action.MAIN"/>
            <category android:name="android.intent.category.LAUNCHER"/>
          </intent-filter>
        </service>`),
    );
    expect(
      result.entryPoints.components.map(
        ({ kind, name, target_activity, exported, permission, launcher }) => ({
          kind,
          name,
          target_activity,
          exported,
          permission,
          launcher,
        }),
      ),
    ).toEqual([
      {
        kind: "activity",
        name: "com.rea.probe.MainActivity",
        target_activity: null,
        exported: null,
        permission: null,
        launcher: true,
      },
      {
        kind: "activity-alias",
        name: "com.rea.probe.Launcher",
        target_activity: "com.rea.probe.MainActivity",
        exported: true,
        permission: "com.rea.probe.LAUNCH",
        launcher: true,
      },
      // Only activities and aliases are launcher entries.
      {
        kind: "service",
        name: "org.other.Sync",
        target_activity: null,
        exported: null,
        permission: null,
        launcher: false,
      },
    ]);
    expect(result.limitations).toEqual([]);
  });

  it("distinguishes exported unset from exported false and true", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".Unset"/>
        <activity android:name=".Hidden" android:exported="false"/>
        <receiver android:name=".Open" android:exported="true" android:enabled="true"/>`),
    );
    expect(
      result.entryPoints.components.map(({ name, exported, enabled }) => [
        name,
        exported,
        enabled,
      ]),
    ).toEqual([
      ["com.rea.probe.Unset", null, null],
      ["com.rea.probe.Hidden", false, null],
      ["com.rea.probe.Open", true, true],
    ]);
  });

  it("keeps relative names as declared when the manifest has no package", () => {
    const result = decoded(
      manifestWith('<activity android:name=".Main"/>', null),
    );
    expect(result.entryPoints.components[0]?.name).toBe(".Main");
    expect(result.coverage).toBe("complete");
    expect(result.limitations).toEqual([
      "entry_points reports 1 relative class name(s) as declared because the manifest declares no package",
    ]);
  });

  it("ignores components outside the first application and counts extras", () => {
    const manifest = [
      `<manifest ${ANDROID} package="com.rea.probe">`,
      '  <activity android:name=".Stray"/>',
      '  <application><activity android:name=".Real"/><provider android:name=".Data"/></application>',
      '  <application><activity android:name=".Ignored"/></application>',
      "</manifest>",
    ].join("\n");
    const result = decoded(manifest);
    expect(result.entryPoints.components.map(({ name }) => name)).toEqual([
      "com.rea.probe.Real",
    ]);
    expect(result.coverage).toBe("partial");
    expect(result.limitations).toEqual([
      "entry_points omits 1 malformed manifest declaration(s): <application> at line 4 after the first <application>",
    ]);
  });
});

describe("deep link combination", () => {
  it("combines several schemes, hosts, and paths of one browsable filter", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".LinkActivity" android:exported="true">
          <intent-filter android:autoVerify="true">
            <action android:name="android.intent.action.VIEW"/>
            <category android:name="android.intent.category.DEFAULT"/>
            <category android:name="android.intent.category.BROWSABLE"/>
            <data android:scheme="https" android:host="example.com" android:path="/item"/>
            <data android:scheme="http"/>
            <data android:host="m.example.com" android:port="8443"/>
            <data android:pathPrefix="/shop" android:pathPattern="/p/.*"/>
            <data android:scheme="https"/>
          </intent-filter>
        </activity>`),
    );
    const [component] = result.entryPoints.components;
    expect(component?.intent_filters[0]?.data).toEqual([
      { ...NO_DATA, scheme: "https", host: "example.com", path: "/item" },
      { ...NO_DATA, scheme: "http" },
      { ...NO_DATA, host: "m.example.com", port: "8443" },
      { ...NO_DATA, path_prefix: "/shop", path_pattern: "/p/.*" },
      { ...NO_DATA, scheme: "https" },
    ]);
    const links = result.entryPoints.deep_links;
    // 2 distinct schemes x 2 authorities x 3 paths, scheme-major.
    expect(links).toHaveLength(12);
    expect(links.map(({ uri }) => uri)).toEqual([
      "https://example.com/item",
      "https://example.com/shop*",
      "https://example.com/p/.*",
      "https://m.example.com:8443/item",
      "https://m.example.com:8443/shop*",
      "https://m.example.com:8443/p/.*",
      "http://example.com/item",
      "http://example.com/shop*",
      "http://example.com/p/.*",
      "http://m.example.com:8443/item",
      "http://m.example.com:8443/shop*",
      "http://m.example.com:8443/p/.*",
    ]);
    expect(links[4]).toEqual({
      component: "com.rea.probe.LinkActivity",
      scheme: "https",
      host: "m.example.com",
      port: "8443",
      path: "/shop",
      path_kind: "prefix",
      browsable: true,
      auto_verify: true,
      uri: "https://m.example.com:8443/shop*",
    });
    expect(result.limitations).toEqual([]);
  });

  it("reports every path kind and keeps filters of one component separate", () => {
    const result = decoded(
      manifestWith(`
        <activity-alias android:name=".Share" android:targetActivity=".Main">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            <data android:scheme="app" android:host="h" android:pathAdvancedPattern="/[a-z]+" android:pathSuffix=".pdf"/>
          </intent-filter>
          <intent-filter android:autoVerify="false">
            <action android:name="android.intent.action.VIEW"/>
            <category android:name="android.intent.category.BROWSABLE"/>
            <data android:scheme="app" android:host="h" android:path="/x"/>
          </intent-filter>
        </activity-alias>`),
    );
    expect(
      result.entryPoints.deep_links.map(
        ({ component, path, path_kind, browsable, auto_verify, uri }) => ({
          component,
          path,
          path_kind,
          browsable,
          auto_verify,
          uri,
        }),
      ),
    ).toEqual([
      {
        component: "com.rea.probe.Share",
        path: "/[a-z]+",
        path_kind: "advanced_pattern",
        browsable: false,
        auto_verify: null,
        uri: "app://h/[a-z]+",
      },
      {
        component: "com.rea.probe.Share",
        path: ".pdf",
        path_kind: "suffix",
        browsable: false,
        auto_verify: null,
        uri: "app://h*.pdf",
      },
      {
        component: "com.rea.probe.Share",
        path: "/x",
        path_kind: "exact",
        browsable: true,
        auto_verify: false,
        uri: "app://h/x",
      },
    ]);
  });

  it("ignores paths and ports without a host, as Android matching does", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".Custom">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            <data android:scheme="myapp" android:port="80" android:path="/ignored"/>
          </intent-filter>
        </activity>`),
    );
    expect(result.entryPoints.deep_links).toEqual([
      {
        component: "com.rea.probe.Custom",
        scheme: "myapp",
        host: null,
        port: null,
        path: null,
        path_kind: null,
        browsable: false,
        auto_verify: null,
        uri: "myapp:",
      },
    ]);
  });
});

describe("deep link eligibility and bounds", () => {
  it("derives no deep links from scheme-less, service, or receiver filters", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".Viewer">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            <category android:name="android.intent.category.BROWSABLE"/>
            <data android:mimeType="image/*" android:host="ignored.example"/>
          </intent-filter>
        </activity>
        <service android:name=".Api">
          <intent-filter>
            <action android:name="com.rea.probe.BIND"/>
            <data android:scheme="https" android:host="service.example"/>
          </intent-filter>
        </service>
        <receiver android:name=".Push">
          <intent-filter>
            <action android:name="com.rea.probe.PUSH"/>
            <data android:scheme="push"/>
          </intent-filter>
        </receiver>`),
    );
    expect(result.entryPoints.components).toHaveLength(3);
    expect(result.entryPoints.components[0]?.intent_filters[0]?.data).toEqual([
      { ...NO_DATA, host: "ignored.example", mime_type: "image/*" },
    ]);
    expect(result.entryPoints.deep_links).toEqual([]);
  });

  it("keeps unresolved resource references explicit instead of guessing", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".Deep" android:exported="@bool/exported" android:permission="@string/perm">
          <intent-filter android:autoVerify="@bool/verify">
            <action android:name="android.intent.action.VIEW"/>
            <category android:name="android.intent.category.BROWSABLE"/>
            <data android:scheme="https" android:host="@string/deep_host" android:pathPrefix="@string/deep_path"/>
          </intent-filter>
        </activity>`),
    );
    const [component] = result.entryPoints.components;
    expect(component).toMatchObject({
      exported: null,
      permission: "@string/perm",
      intent_filters: [{ auto_verify: null }],
    });
    expect(result.entryPoints.deep_links).toEqual([
      {
        component: "com.rea.probe.Deep",
        scheme: "https",
        host: "@string/deep_host",
        port: null,
        path: "@string/deep_path",
        path_kind: "prefix",
        browsable: true,
        auto_verify: null,
        uri: "https://@string/deep_host@string/deep_path*",
      },
    ]);
    expect(result.coverage).toBe("complete");
    expect(result.limitations).toEqual([
      "entry_points leaves 5 resource reference(s) or non-literal value(s) unresolved: text keeps the declared value and booleans report null: exported=@bool/exported (1); permission=@string/perm (1); autoVerify=@bool/verify (1); host=@string/deep_host (1); pathPrefix=@string/deep_path (1)",
    ]);
  });

  it("reports data constraints outside the projection as partial", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".Dial">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            <data android:scheme="tel" android:ssp="123" android:fragment="top"/>
          </intent-filter>
        </activity>`),
    );
    expect(result.entryPoints.deep_links.map(({ uri }) => uri)).toEqual([
      "tel:",
    ]);
    expect(result.coverage).toBe("partial");
    expect(result.limitations).toEqual([
      "entry_points does not project <data> attribute(s) fragment, ssp; deep_links omit those constraints",
    ]);
  });

  it("reports relative filter groups as unprojected URI constraints", () => {
    const result = decoded(
      manifestWith(`
        <activity android:name=".Shop">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            <category android:name="android.intent.category.BROWSABLE"/>
            <data android:scheme="https" android:host="shop.example"/>
            <uri-relative-filter-group android:allow="false">
              <data android:path="/admin"/>
            </uri-relative-filter-group>
          </intent-filter>
        </activity>`),
    );
    // The group's own <data> is not merged into the filter's paths.
    expect(result.entryPoints.components[0]?.intent_filters[0]?.data).toEqual([
      { ...NO_DATA, scheme: "https", host: "shop.example" },
    ]);
    expect(result.entryPoints.deep_links.map(({ uri }) => uri)).toEqual([
      "https://shop.example",
    ]);
    expect(result.coverage).toBe("partial");
    expect(result.limitations).toEqual([
      "entry_points does not project <intent-filter> element(s) <uri-relative-filter-group>; deep_links omit their URI constraints",
    ]);
  });

  it("bounds the derived product before enumerating it", () => {
    const schemes = Array.from(
      { length: 20 },
      (_, index) => `<data android:scheme="s${String(index)}"/>`,
    ).join("");
    const hosts = Array.from(
      { length: 20 },
      (_, index) => `<data android:host="h${String(index)}.example"/>`,
    ).join("");
    const paths = Array.from(
      { length: 20 },
      (_, index) => `<data android:path="/p${String(index)}"/>`,
    ).join("");
    const result = decoded(
      manifestWith(`
        <activity android:name=".Many">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            ${schemes}${hosts}${paths}
          </intent-filter>
        </activity>
        <activity android:name=".Later">
          <intent-filter>
            <action android:name="android.intent.action.VIEW"/>
            <data android:scheme="later"/>
          </intent-filter>
        </activity>`),
    );
    expect(result.entryPoints.deep_links).toHaveLength(MAX_DEEP_LINKS);
    expect(result.entryPoints.deep_links.at(-1)?.uri).toBe(
      "s4://h19.example/p19",
    );
    expect(result.coverage).toBe("partial");
    expect(result.limitations).toEqual([
      `deep_links reports the first ${String(MAX_DEEP_LINKS)} of 8001 derived combinations`,
    ]);
  });
});

describe("malformed declarations", () => {
  it("omits unnamed components and incomplete filters with their locations", () => {
    const result = decoded(
      manifestWith(`
        <activity android:exported="true"/>
        <activity-alias android:name=".NoTarget"/>
        <service android:name=""/>
        <activity android:name=".Kept" android:enabled="yes">
          <intent-filter>
            <action/>
            <action android:name="android.intent.action.VIEW"/>
            <action android:name="android.intent.action.VIEW"/>
            <category android:name=""/>
            <data/>
          </intent-filter>
        </activity>`),
    );
    expect(result.entryPoints.components).toEqual([
      {
        kind: "activity",
        name: "com.rea.probe.Kept",
        target_activity: null,
        exported: null,
        enabled: null,
        permission: null,
        launcher: false,
        intent_filters: [
          {
            actions: ["android.intent.action.VIEW"],
            categories: [],
            auto_verify: null,
            data: [NO_DATA],
          },
        ],
      },
    ]);
    expect(result.coverage).toBe("partial");
    expect(result.limitations).toEqual([
      "entry_points omits 5 malformed manifest declaration(s): <activity> at line 4 without android:name; <activity-alias> at line 5 without android:targetActivity; <service> at line 6 without android:name; <action> at line 9 without android:name; <category> at line 12 without android:name",
      "entry_points leaves 1 resource reference(s) or non-literal value(s) unresolved: text keeps the declared value and booleans report null: enabled=yes (1)",
    ]);
  });

  it("names only the first examples of many omissions", () => {
    const result = decoded(manifestWith("<receiver/>".repeat(7)));
    expect(result.limitations[0]).toMatch(
      /^entry_points omits 7 malformed manifest declaration\(s\): .*; and 2 more$/u,
    );
  });
});
