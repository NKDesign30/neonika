// Read-only parser for the upstream skill `metadata.upstream` frontmatter block
// (requirements + install specs). The block is an embedded multi-line JSON object
// with trailing commas (JSON5-ish), so the flat key:value frontmatter parser in
// neonSkills.ts cannot read it. This module extracts the balanced JSON blob,
// leniently parses it, and SANITIZES install specs — it never installs or
// executes anything (parity gap rows 181/182).

export type TNeonSkillInstallKind = "brew" | "node" | "go" | "uv" | "download";

export interface INeonSkillInstallSpec {
  readonly id: string;
  readonly kind: TNeonSkillInstallKind;
  readonly label?: string;
  readonly bins?: readonly string[];
  readonly formula?: string;
  readonly package?: string;
  readonly module?: string;
  readonly url?: string;
}

export interface INeonSkillRequires {
  readonly bins?: readonly string[];
  readonly anyBins?: readonly string[];
  readonly env?: readonly string[];
  readonly config?: readonly string[];
}

export interface INeonSkillReferenceMetadata {
  readonly os?: readonly string[];
  readonly requires?: INeonSkillRequires;
  readonly install?: readonly INeonSkillInstallSpec[];
}

// Extract the balanced `{...}` JSON object that follows a top-level `metadata:`
// key in the frontmatter, respecting double-quoted strings + escapes. Returns the
// raw blob or undefined when there is no metadata block.
function extractMetadataJsonBlock(frontmatter: string): string | undefined {
  const match = /(^|\n)metadata:\s*(\r?\n\s*)?\{/u.exec(frontmatter);
  if (!match) return undefined;
  const start = frontmatter.indexOf("{", match.index);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < frontmatter.length; i += 1) {
    const char = frontmatter[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return frontmatter.slice(start, i + 1);
    }
  }
  return undefined;
}

function lenithParse(blob: string): unknown {
  // Strip trailing commas before } or ] so standard JSON.parse accepts the JSON5
  // shape upstream uses.
  const cleaned = blob.replace(/,(\s*[}\]])/gu, "$1");
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return out.length > 0 ? out : undefined;
}

const SAFE_PATTERNS: Record<TNeonSkillInstallKind, { readonly field: "formula" | "package" | "module" | "url"; readonly re: RegExp }> = {
  brew: { field: "formula", re: /^[a-zA-Z0-9][a-zA-Z0-9._/+@-]*$/u },
  node: { field: "package", re: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-zA-Z0-9._-]+)?$/u },
  go: { field: "module", re: /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(@[a-zA-Z0-9._/-]+)?$/u },
  uv: { field: "package", re: /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\[[a-zA-Z0-9,._-]+\])?([<>=!~]=?[a-zA-Z0-9._-]+)?$/u },
  download: { field: "url", re: /^https:\/\/[^\s"'`<>$;|&]+$/u },
};

function isInstallKind(value: unknown): value is TNeonSkillInstallKind {
  return value === "brew" || value === "node" || value === "go" || value === "uv" || value === "download";
}

// Parse + sanitize a single raw install entry. Returns undefined when the kind is
// unknown or the install target fails the per-kind safe-charset check (defends the
// inventory surface against shell-metacharacter injection in skill frontmatter).
export function parseNeonSkillInstallSpec(raw: unknown): INeonSkillInstallSpec | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const kind = record["kind"];
  if (!isInstallKind(kind)) return undefined;

  const pattern = SAFE_PATTERNS[kind];
  const target = record[pattern.field];
  if (typeof target !== "string" || !pattern.re.test(target)) return undefined;

  const id = typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : kind;
  const label = typeof record["label"] === "string" ? record["label"] : undefined;
  const bins = asStringArray(record["bins"]);

  return {
    id,
    kind,
    [pattern.field]: target,
    ...(label ? { label } : {}),
    ...(bins ? { bins } : {}),
  };
}

function parseRequires(raw: unknown): INeonSkillRequires | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const bins = asStringArray(record["bins"]);
  const anyBins = asStringArray(record["anyBins"]);
  const env = asStringArray(record["env"]);
  const config = asStringArray(record["config"]);
  if (!bins && !anyBins && !env && !config) return undefined;
  return {
    ...(bins ? { bins } : {}),
    ...(anyBins ? { anyBins } : {}),
    ...(env ? { env } : {}),
    ...(config ? { config } : {}),
  };
}

// Parse the `metadata.upstream` block from a skill's full source. Returns
// undefined when absent or unparseable. Pure: no I/O, no execution.
export function parseNeonSkillReferenceMetadata(source: string): INeonSkillReferenceMetadata | undefined {
  const blob = extractMetadataJsonBlock(source);
  if (!blob) return undefined;
  const parsed = asRecord(lenithParse(blob));
  // "openclaw" is the frontmatter key skills carry on disk — an interop name,
  // not a brand reference.
  const meta = asRecord(parsed?.["openclaw"]);
  if (!meta) return undefined;

  const os = asStringArray(meta["os"]);
  const requires = parseRequires(meta["requires"]);
  const installRaw = Array.isArray(meta["install"]) ? meta["install"] : [];
  const install = installRaw
    .map((entry) => parseNeonSkillInstallSpec(entry))
    .filter((entry): entry is INeonSkillInstallSpec => entry !== undefined);

  if (!os && !requires && install.length === 0) return undefined;
  return {
    ...(os ? { os } : {}),
    ...(requires ? { requires } : {}),
    ...(install.length > 0 ? { install } : {}),
  };
}
