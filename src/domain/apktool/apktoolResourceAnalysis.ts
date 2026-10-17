import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

const MAX_STRINGS = 2_000;
const ANDROID_NON_LOCALE_QUALIFIERS = new Set([
  "car",
  "desk",
  "television",
  "appliance",
  "watch",
  "vrheadset",
  "night",
  "notnight",
]);

const localeQualifierSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(
    /^(?:[a-z]{2,3}(?:-(?:r?[A-Z]{2}|r?[0-9]{3}))?|b\+[a-z]{2,3}(?:\+[A-Za-z0-9]{2,8})*)$/u,
    "Locale must look like de, pt-BR, pt-rBR, or b+zh+Hans+CN",
  )
  .refine(
    (value) => !ANDROID_NON_LOCALE_QUALIFIERS.has(value.toLowerCase()),
    "Android resource configuration qualifiers are not locales",
  );

/** Locale language tags admitted by Android resource table selection. */
export const androidLocaleQualifierSchema = localeQualifierSchema;

/**
 * Caller intent for Apktool-backed resource decoding. Apktool is
 * bring-your-own: REA never installs it, and decoding happens in a
 * provider-owned workspace that is removed after the facts are projected.
 */
export const apktoolInputSchemas = {
  inspect_apktool_client: z.strictObject({}),
  decode_android_resources: z.strictObject({
    path: localPathStringSchema.describe("Local APK file to decode"),
    include_strings: z
      .boolean()
      .default(true)
      .describe(
        `Project res/values/strings.xml entries (bounded to ${String(MAX_STRINGS)} entries)`,
      ),
    locale: androidLocaleQualifierSchema
      .optional()
      .describe(
        "Project strings from res/values-<locale>/strings.xml instead of the default table",
      ),
  }),
} as const;

/** Supported Apktool-backed operations. */
export type ApktoolOperation = keyof typeof apktoolInputSchemas;
/** Validated Apktool requests carry their selected operation. */
export type ApktoolRequest = {
  [Name in ApktoolOperation]: {
    operation: Name;
    input: z.infer<(typeof apktoolInputSchemas)[Name]>;
  };
}[ApktoolOperation];

/** Validate operation and input together so their types remain correlated. */
export const apktoolRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_apktool_client"),
    input: apktoolInputSchemas.inspect_apktool_client,
  }),
  z.strictObject({
    operation: z.literal("decode_android_resources"),
    input: apktoolInputSchemas.decode_android_resources,
  }),
]);

const client = z.strictObject({
  command: z.string().min(1),
  command_source: z.enum(["environment", "path"]),
  apktool_version: z.string().min(1).nullable(),
});

/** Manifest component elements whose intent filters are projected. */
export const ANDROID_ENTRY_POINT_KINDS = [
  "activity",
  "activity-alias",
  "service",
  "receiver",
] as const;

/** `<data>` path attributes, in the order Android's parser reads them. */
export const ANDROID_DEEP_LINK_PATH_KINDS = [
  "exact",
  "prefix",
  "pattern",
  "advanced_pattern",
  "suffix",
] as const;

const declaredValue = z.string().nullable();
const declaredBoolean = z
  .boolean()
  .nullable()
  .describe(
    "Literal true/false as declared; null when undeclared or not literal, such as a @bool reference (see limitations)",
  );

const androidIntentDataSchema = z.strictObject({
  scheme: declaredValue,
  host: declaredValue,
  port: declaredValue,
  path: declaredValue,
  path_prefix: declaredValue,
  path_pattern: declaredValue,
  path_advanced_pattern: declaredValue,
  path_suffix: declaredValue,
  mime_type: declaredValue,
});

const androidIntentFilterSchema = z.strictObject({
  actions: z.array(z.string().min(1)),
  categories: z.array(z.string().min(1)),
  auto_verify: declaredBoolean,
  data: z.array(androidIntentDataSchema),
});

const androidComponentSchema = z.strictObject({
  kind: z.enum(ANDROID_ENTRY_POINT_KINDS),
  name: z
    .string()
    .min(1)
    .describe(
      "Class name as declared; relative names are resolved against the manifest package",
    ),
  target_activity: z.string().min(1).nullable(),
  exported: declaredBoolean,
  enabled: declaredBoolean,
  permission: declaredValue,
  launcher: z
    .boolean()
    .describe(
      "An activity or alias filter declares action MAIN with category LAUNCHER",
    ),
  intent_filters: z.array(androidIntentFilterSchema),
});

const androidDeepLinkSchema = z.strictObject({
  component: z.string().min(1),
  scheme: z.string(),
  host: declaredValue,
  port: declaredValue,
  path: declaredValue,
  path_kind: z.enum(ANDROID_DEEP_LINK_PATH_KINDS).nullable(),
  browsable: z.boolean(),
  auto_verify: declaredBoolean,
  uri: z.string().describe("Display form only; match on the structured fields"),
});

/**
 * Entry points declared by the decoded manifest. Components are observed
 * declarations; deep links are derived from activity and alias filters that
 * declare a scheme, combining that filter's schemes, authorities, and paths.
 * Resource references stay as declared text rather than being resolved.
 */
export const androidEntryPointsSchema = z.strictObject({
  components: z.array(androidComponentSchema),
  deep_links: z
    .array(androidDeepLinkSchema)
    .describe(
      "Derived per intent filter: schemes x host/port authorities x paths",
    ),
});

export type AndroidEntryPoints = z.infer<typeof androidEntryPointsSchema>;
export type AndroidEntryPointComponent = z.infer<typeof androidComponentSchema>;
export type AndroidIntentFilter = z.infer<typeof androidIntentFilterSchema>;
export type AndroidIntentData = z.infer<typeof androidIntentDataSchema>;
export type AndroidDeepLink = z.infer<typeof androidDeepLinkSchema>;

/** Portable Apktool observations with explicit coverage limitations. */
export const apktoolResultSchemas = {
  inspect_apktool_client: z.strictObject({
    client,
  }),
  decode_android_resources: z.strictObject({
    client,
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
    }),
    metadata: z.strictObject({
      version_name: z.string().nullable(),
      version_code: z
        .string()
        .nullable()
        .describe(
          "Version code exactly as apktool.yml prints it, e.g. '45' or '45.1'",
        ),
      min_sdk_version: z.string().nullable(),
      target_sdk_version: z.string().nullable(),
      package_name: z.string().nullable(),
    }),
    manifest: z.string().nullable(),
    entry_points: androidEntryPointsSchema
      .nullable()
      .describe(
        "Components and deep links parsed from the decoded manifest; null when the manifest is missing or truncated",
      ),
    strings: z.array(
      z.strictObject({
        name: z.string().min(1),
        value: z.string(),
      }),
    ),
    locale: z.string().nullable(),
    locales: z.array(z.string().min(1)),
    decoded_file_count: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
