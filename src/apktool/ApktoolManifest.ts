import type { Element, Node } from "@xmldom/xmldom";

import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import {
  ANDROID_ENTRY_POINT_KINDS,
  type ANDROID_DEEP_LINK_PATH_KINDS,
  type AndroidDeepLink,
  type AndroidEntryPointComponent,
  type AndroidEntryPoints,
  type AndroidIntentData,
  type AndroidIntentFilter,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseXmlDocument } from "../domain/xmlDocument.js";

const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";
const ACTION_MAIN = "android.intent.action.MAIN";
const CATEGORY_LAUNCHER = "android.intent.category.LAUNCHER";
const CATEGORY_BROWSABLE = "android.intent.category.BROWSABLE";

/**
 * Deep links are a per-filter product of schemes, authorities, and paths, so
 * their count can grow far beyond the bounded manifest that declares them.
 */
export const MAX_DEEP_LINKS = 2_000;
/** Examples named inline by one limitation; the count names the rest. */
const MAX_LISTED_EXAMPLES = 5;

type ComponentKind = (typeof ANDROID_ENTRY_POINT_KINDS)[number];
type PathKind = (typeof ANDROID_DEEP_LINK_PATH_KINDS)[number];

/** `<data>` attributes projected into `intent_filters[].data`. */
const PROJECTED_DATA_ATTRIBUTES: ReadonlySet<string> = new Set([
  "scheme",
  "host",
  "port",
  "path",
  "pathPrefix",
  "pathPattern",
  "pathAdvancedPattern",
  "pathSuffix",
  "mimeType",
]);

/**
 * `<intent-filter>` children that Android applies as further URI constraints
 * (API 35 relative filter groups) but the projection does not model.
 */
const UNPROJECTED_FILTER_ELEMENTS: ReadonlySet<string> = new Set([
  "uri-relative-filter-group",
]);

/** Path fields in the order Android's manifest parser reads them. */
const PATH_ATTRIBUTES = [
  ["exact", "path"],
  ["prefix", "path_prefix"],
  ["pattern", "path_pattern"],
  ["advanced_pattern", "path_advanced_pattern"],
  ["suffix", "path_suffix"],
] as const satisfies readonly (readonly [PathKind, keyof AndroidIntentData])[];

const COMPONENT_KINDS: ReadonlySet<string> = new Set(ANDROID_ENTRY_POINT_KINDS);

/** A resource (`@`) or theme attribute (`?`) reference Apktool left unresolved. */
const isReference = (value: string): boolean =>
  value.startsWith("@") || value.startsWith("?");

/** Facts parsed once from Apktool's decoded AndroidManifest.xml. */
export interface DecodedManifest {
  readonly packageName: string | null;
  readonly entryPoints: AndroidEntryPoints;
  /** Omitted or unexpandable declarations make the projection partial. */
  readonly coverage: "complete" | "partial";
  readonly limitations: readonly string[];
}

/** Manifest facts for one bounded read; entry points need the whole document. */
export interface ManifestFacts extends Omit<DecodedManifest, "entryPoints"> {
  readonly entryPoints: AndroidEntryPoints | null;
}

/**
 * Project a bounded manifest read. A missing manifest has nothing to examine,
 * and a truncated prefix is not parsed as though it were the whole document.
 */
export const projectManifestRead = (
  read: { readonly text: string | null; readonly truncated: boolean },
  budgetBytes: number,
): Result<ManifestFacts, AnalysisProtocolError> => {
  if (read.text === null)
    return ok({
      packageName: null,
      entryPoints: null,
      coverage: "complete",
      limitations: [
        "No AndroidManifest.xml was found in the decoded workspace; package_name and entry_points are unavailable",
      ],
    });
  if (read.truncated)
    return ok({
      packageName: null,
      entryPoints: null,
      coverage: "partial",
      limitations: [
        `manifest is truncated at ${String(budgetBytes)} bytes; package_name and entry_points are not derived from the incomplete document`,
      ],
    });
  return parseDecodedManifest(read.text);
};

/**
 * Parse the decoded manifest with the strict XML boundary and project its
 * package and entry points. Only declarations are interpreted: resource
 * references stay as declared text, booleans that are not literal report
 * null, and malformed component declarations are omitted with a limitation.
 */
export const parseDecodedManifest = (
  manifest: string,
): Result<DecodedManifest, AnalysisProtocolError> => {
  const parsed = parseXmlDocument(manifest, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    return err(
      new AnalysisProtocolError(
        `AndroidManifest.xml is not well-formed XML: ${parsed.error.message}`,
        { cause: parsed.error },
      ),
    );
  const root = parsed.value.documentElement;
  if (root === null || root.nodeName !== "manifest")
    return err(
      new AnalysisProtocolError("AndroidManifest.xml root must be <manifest>"),
    );
  const packageName = root.getAttribute("package") || null;
  const projection = new ManifestProjection(packageName);

  // Android reads the first <application> and ignores later ones.
  const [application, ...ignored] = elementChildren(root).filter(
    (element) => element.nodeName === "application",
  );
  for (const element of ignored)
    projection.omit(`${describe(element)} after the first <application>`);
  const projected: ProjectedComponent[] = [];
  for (const element of application === undefined
    ? []
    : elementChildren(application)) {
    if (!COMPONENT_KINDS.has(element.nodeName)) continue;
    const component = projection.component(
      element,
      element.nodeName as ComponentKind,
    );
    if (component !== undefined) projected.push(component);
  }
  const deepLinks = deriveDeepLinks(projected);
  return ok({
    packageName,
    entryPoints: {
      components: projected.map(({ component }) => component),
      deep_links: deepLinks.links,
    },
    ...projection.report(deepLinks.total),
  });
};

/** A declared boolean and, when it is not literal, its declared text. */
interface DeclaredBoolean {
  readonly value: boolean | null;
  readonly reference: string | null;
}

/** One intent filter and the URI constraints it declares but does not project. */
interface ProjectedFilter {
  readonly filter: AndroidIntentFilter;
  /** Sorted distinct names; derived deep links omit these constraints. */
  readonly unprojected: readonly string[];
}

/** A projected component with its filters, in `intent_filters` order. */
interface ProjectedComponent {
  readonly component: AndroidEntryPointComponent;
  readonly filters: readonly ProjectedFilter[];
}

/** Collects omissions and unresolved values while projecting one manifest. */
class ManifestProjection {
  readonly #omitted: string[] = [];
  readonly #unresolved = new Map<string, number>();
  readonly #unprojectedData = new Set<string>();
  readonly #unprojectedFilterElements = new Set<string>();
  #relativeNames = 0;

  constructor(private readonly packageName: string | null) {}

  omit(description: string): void {
    this.#omitted.push(description);
  }

  component(
    element: Element,
    kind: ComponentKind,
  ): ProjectedComponent | undefined {
    // Android refuses these declarations; omit them before resolving anything.
    const declaredName = element.getAttributeNS(ANDROID_NAMESPACE, "name");
    if (declaredName === null || declaredName === "") {
      this.omit(`${describe(element)} without android:name`);
      return undefined;
    }
    const declaredTarget =
      kind === "activity-alias"
        ? element.getAttributeNS(ANDROID_NAMESPACE, "targetActivity")
        : null;
    if (
      kind === "activity-alias" &&
      (declaredTarget === null || declaredTarget === "")
    ) {
      this.omit(`${describe(element)} without android:targetActivity`);
      return undefined;
    }
    const name = this.className("name", declaredName);
    const targetActivity =
      declaredTarget === null
        ? null
        : this.className("targetActivity", declaredTarget);
    const exported = this.boolean(element, "exported");
    const enabled = this.boolean(element, "enabled");
    const permission = this.text(element, "permission");
    const filters = elementChildren(element)
      .filter((child) => child.nodeName === "intent-filter")
      .map((filter) => this.intentFilter(filter));
    const intentFilters = filters.map(({ filter }) => filter);
    return {
      component: {
        kind,
        name,
        target_activity: targetActivity,
        exported: exported.value,
        exported_reference: exported.reference,
        enabled: enabled.value,
        enabled_reference: enabled.reference,
        permission,
        launcher:
          (kind === "activity" || kind === "activity-alias") &&
          intentFilters.some(
            ({ actions, categories }) =>
              actions.includes(ACTION_MAIN) &&
              categories.includes(CATEGORY_LAUNCHER),
          ),
        intent_filters: intentFilters,
      },
      filters,
    };
  }

  report(
    derivedDeepLinks: number,
  ): Pick<DecodedManifest, "coverage" | "limitations"> {
    const partial: string[] = [];
    if (this.#omitted.length > 0)
      partial.push(
        `entry_points omits ${String(this.#omitted.length)} malformed manifest declaration(s): ${listed(this.#omitted)}`,
      );
    if (this.#unprojectedData.size > 0)
      partial.push(
        `entry_points does not project <data> attribute(s) ${[...this.#unprojectedData].sort().join(", ")}; deep_links omit those constraints`,
      );
    if (this.#unprojectedFilterElements.size > 0)
      partial.push(
        `entry_points does not project <intent-filter> element(s) ${[
          ...this.#unprojectedFilterElements,
        ]
          .sort()
          .map((name) => `<${name}>`)
          .join(", ")}; deep_links omit their URI constraints`,
      );
    if (derivedDeepLinks > MAX_DEEP_LINKS)
      partial.push(
        `deep_links reports the first ${String(MAX_DEEP_LINKS)} of ${String(derivedDeepLinks)} derived combinations`,
      );
    const notes: string[] = [];
    if (this.#unresolved.size > 0) {
      const total = [...this.#unresolved.values()].reduce((a, b) => a + b, 0);
      notes.push(
        `entry_points leaves ${String(total)} resource reference(s) or non-literal value(s) unresolved: text keeps the declared value and booleans report null: ${listed(
          [...this.#unresolved].map(
            ([value, count]) => `${value} (${String(count)})`,
          ),
        )}`,
      );
    }
    if (this.#relativeNames > 0)
      notes.push(
        `entry_points reports ${String(this.#relativeNames)} relative class name(s) as declared because the manifest declares no package`,
      );
    return {
      coverage: partial.length > 0 ? "partial" : "complete",
      limitations: [...partial, ...notes],
    };
  }

  private intentFilter(filter: Element): ProjectedFilter {
    const autoVerify = this.boolean(filter, "autoVerify");
    const children = elementChildren(filter);
    const unprojected = new Set<string>();
    for (const child of children)
      if (UNPROJECTED_FILTER_ELEMENTS.has(child.nodeName)) {
        this.#unprojectedFilterElements.add(child.nodeName);
        unprojected.add(child.nodeName);
      }
    const actions = this.names(children, "action");
    const categories = this.names(children, "category");
    const data = children
      .filter((child) => child.nodeName === "data")
      .map((child) => this.data(child, unprojected));
    return {
      filter: {
        actions,
        categories,
        auto_verify: autoVerify.value,
        auto_verify_reference: autoVerify.reference,
        data,
      },
      unprojected: [...unprojected].sort(),
    };
  }

  /** Distinct `android:name` values; Android's IntentFilter de-duplicates them. */
  private names(children: readonly Element[], tag: string): string[] {
    const names = new Set<string>();
    for (const child of children) {
      if (child.nodeName !== tag) continue;
      const name = this.text(child, "name");
      if (name === null || name === "")
        this.omit(`${describe(child)} without android:name`);
      else names.add(name);
    }
    return [...names];
  }

  /** Project one `<data>`, adding its unprojected attributes to the filter's. */
  private data(element: Element, unprojected: Set<string>): AndroidIntentData {
    const attributes = element.attributes;
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes.item(index);
      const name = attribute?.localName ?? null;
      if (
        attribute?.namespaceURI === ANDROID_NAMESPACE &&
        name !== null &&
        !PROJECTED_DATA_ATTRIBUTES.has(name)
      ) {
        this.#unprojectedData.add(name);
        unprojected.add(name);
      }
    }
    return {
      scheme: this.text(element, "scheme"),
      host: this.text(element, "host"),
      port: this.text(element, "port"),
      path: this.text(element, "path"),
      path_prefix: this.text(element, "pathPrefix"),
      path_pattern: this.text(element, "pathPattern"),
      path_advanced_pattern: this.text(element, "pathAdvancedPattern"),
      path_suffix: this.text(element, "pathSuffix"),
      mime_type: this.text(element, "mimeType"),
    };
  }

  /** Resolve a class name the way Android's manifest parser does. */
  private className(attribute: string, declared: string): string {
    if (isReference(declared)) {
      this.#noteUnresolved(attribute, declared);
      return declared;
    }
    const relative = declared.startsWith(".");
    if (!relative && declared.includes(".")) return declared;
    if (this.packageName === null) {
      this.#relativeNames += 1;
      return declared;
    }
    return relative
      ? `${this.packageName}${declared}`
      : `${this.packageName}.${declared}`;
  }

  private text(element: Element, attribute: string): string | null {
    const value = element.getAttributeNS(ANDROID_NAMESPACE, attribute);
    if (value !== null && isReference(value))
      this.#noteUnresolved(attribute, value);
    return value;
  }

  /**
   * A literal boolean, or null with the declared text kept verbatim, so an
   * unresolved value is never conflated with an undeclared one.
   */
  private boolean(element: Element, attribute: string): DeclaredBoolean {
    const value = element.getAttributeNS(ANDROID_NAMESPACE, attribute);
    if (value === null) return { value: null, reference: null };
    if (value === "true") return { value: true, reference: null };
    if (value === "false") return { value: false, reference: null };
    this.#noteUnresolved(attribute, value);
    return { value: null, reference: value };
  }

  #noteUnresolved(attribute: string, value: string): void {
    const key = `${attribute}=${value}`;
    this.#unresolved.set(key, (this.#unresolved.get(key) ?? 0) + 1);
  }
}

interface Authority {
  readonly host: string;
  readonly port: string | null;
}

interface DeclaredPath {
  readonly path: string;
  readonly kind: PathKind;
}

/** One filter's distinct URI parts, in declaration order. */
interface UriParts {
  readonly schemes: readonly string[];
  readonly authorities: readonly (Authority | null)[];
  readonly paths: readonly (DeclaredPath | null)[];
}

/**
 * Combine one filter's `<data>` elements as Android's IntentFilter matches
 * them: every scheme with every host/port authority, and every path only when
 * an authority exists. A port without a host declares no authority.
 */
const uriParts = (filter: AndroidIntentFilter): UriParts | undefined => {
  const schemes = distinctBy(
    filter.data.flatMap(({ scheme }) => (scheme === null ? [] : [scheme])),
    (scheme) => scheme,
  );
  if (schemes.length === 0) return undefined;
  const authorities = distinctBy(
    filter.data.flatMap(({ host, port }) =>
      host === null ? [] : [{ host, port }],
    ),
    ({ host, port }) => JSON.stringify([host, port]),
  );
  if (authorities.length === 0)
    return { schemes, authorities: [null], paths: [null] };
  const paths = distinctBy(
    filter.data.flatMap((data) =>
      PATH_ATTRIBUTES.flatMap(([kind, field]) => {
        const path = data[field];
        return path === null ? [] : [{ path, kind }];
      }),
    ),
    ({ path, kind }) => JSON.stringify([path, kind]),
  );
  return { schemes, authorities, paths: paths.length === 0 ? [null] : paths };
};

/** Derive deep links, counting each product before enumerating its bound. */
const deriveDeepLinks = (
  components: readonly ProjectedComponent[],
): { links: AndroidDeepLink[]; total: number } => {
  const links: AndroidDeepLink[] = [];
  let total = 0;
  for (const { component, filters } of components) {
    if (component.kind !== "activity" && component.kind !== "activity-alias")
      continue;
    filters.forEach(({ filter, unprojected }, filterIndex) => {
      const parts = uriParts(filter);
      if (parts === undefined) return;
      total +=
        parts.schemes.length * parts.authorities.length * parts.paths.length;
      if (links.length < MAX_DEEP_LINKS)
        links.push(
          ...expandDeepLinks(
            {
              component: component.name,
              filter,
              filterIndex,
              unprojected,
            },
            parts,
            MAX_DEEP_LINKS - links.length,
          ),
        );
    });
  }
  return { links, total };
};

/** The filter a set of derived rows comes from, and how rows name it. */
interface DeepLinkSource {
  readonly component: string;
  readonly filter: AndroidIntentFilter;
  readonly filterIndex: number;
  readonly unprojected: readonly string[];
}

const expandDeepLinks = (
  { component, filter, filterIndex, unprojected }: DeepLinkSource,
  { schemes, authorities, paths }: UriParts,
  limit: number,
): AndroidDeepLink[] => {
  const browsable = filter.categories.includes(CATEGORY_BROWSABLE);
  const links: AndroidDeepLink[] = [];
  for (const scheme of schemes)
    for (const authority of authorities)
      for (const path of paths) {
        if (links.length >= limit) return links;
        links.push({
          component,
          filter_index: filterIndex,
          unprojected: [...unprojected],
          scheme,
          host: authority?.host ?? null,
          port: authority?.port ?? null,
          path: path?.path ?? null,
          path_kind: path?.kind ?? null,
          browsable,
          auto_verify: filter.auto_verify,
          uri: displayUri(scheme, authority, path),
        });
      }
  return links;
};

const displayUri = (
  scheme: string,
  authority: Authority | null,
  path: DeclaredPath | null,
): string => {
  if (authority === null) return `${scheme}:`;
  const port = authority.port === null ? "" : `:${authority.port}`;
  const rendered =
    path === null
      ? ""
      : path.kind === "prefix"
        ? `${path.path}*`
        : path.kind === "suffix"
          ? `*${path.path}`
          : path.path;
  return `${scheme}://${authority.host}${port}${rendered}`;
};

const elementChildren = (node: Node): Element[] => {
  const children: Element[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling)
    if (child.nodeType === 1) children.push(child as Element);
  return children;
};

const describe = (element: Element): string =>
  element.lineNumber === undefined
    ? `<${element.nodeName}>`
    : `<${element.nodeName}> at line ${String(element.lineNumber)}`;

const listed = (items: readonly string[]): string => {
  const shown = items.slice(0, MAX_LISTED_EXAMPLES).join("; ");
  return items.length > MAX_LISTED_EXAMPLES
    ? `${shown}; and ${String(items.length - MAX_LISTED_EXAMPLES)} more`
    : shown;
};

const distinctBy = <T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};
