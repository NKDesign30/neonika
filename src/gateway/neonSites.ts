// Public-safe Sites projection for Mission Control.
// Adapted from NK Design's Mission Control Sites runtime with owner permission.
// See THIRD_PARTY_NOTICES.md.
// Unlike the private source runtime, Neonika never hardcodes a site registry,
// user path, or analytics binary. Both seams are explicit environment config.

import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { redactText } from "../harness/redaction.js";

const execFileAsync = promisify(execFile);

export const neonSitesJsonEnvKey = "NEONIKA_SITES_JSON" as const;
export const neonSiteAnalyticsCommandEnvKey = "NEONIKA_SITE_ANALYTICS_COMMAND" as const;

const analyticsTimeoutMs = 30_000;
const analyticsMaxBuffer = 4 * 1024 * 1024;
const minDays = 1;
const maxDays = 90;
const defaultDays = 28;
const propertyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu;

export interface INeonSite {
  readonly property: string;
  readonly label: string;
  readonly domain: string;
}

export interface INeonSitesSnapshot {
  readonly sites: readonly INeonSite[];
}

export interface INeonSiteAnalyticsRunnerOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

export type TNeonSiteAnalyticsRunner = (
  command: string,
  args: readonly string[],
  options: INeonSiteAnalyticsRunnerOptions
) => Promise<{ readonly stdout: string }>;

export type TNeonSiteAnalyticsResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 404 | 502; readonly error: string };

export interface ICreateNeonSiteAnalyticsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: TNeonSiteAnalyticsRunner;
}

export function createNeonSitesSnapshot(env: NodeJS.ProcessEnv = process.env): INeonSitesSnapshot {
  const raw = env[neonSitesJsonEnvKey]?.trim();

  if (!raw) {
    return { sites: [] };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { sites: [] };
  }

  if (!Array.isArray(parsed)) {
    return { sites: [] };
  }

  const sites: INeonSite[] = [];
  const properties = new Set<string>();

  for (const value of parsed) {
    const site = parseNeonSite(value);

    if (!site || properties.has(site.property)) {
      continue;
    }

    properties.add(site.property);
    sites.push(site);
  }

  return { sites };
}

export async function createNeonSiteAnalyticsSnapshot(
  propertyRaw: string | undefined,
  daysRaw: string | number | undefined,
  options: ICreateNeonSiteAnalyticsOptions = {}
): Promise<TNeonSiteAnalyticsResult> {
  const env = options.env ?? process.env;
  const sites = createNeonSitesSnapshot(env).sites;
  const property = (propertyRaw ?? "").trim() || sites[0]?.property || "";
  const site = sites.find((candidate) => candidate.property === property);

  if (!site) {
    return { ok: false, status: 404, error: "unknown-site" };
  }

  const days = clampDays(daysRaw);

  if (days === undefined) {
    return { ok: false, status: 400, error: "invalid-days" };
  }

  const command = env[neonSiteAnalyticsCommandEnvKey]?.trim();

  if (!command || !isAbsolute(command)) {
    return { ok: false, status: 502, error: "analytics-command-unavailable" };
  }

  const run = options.run ?? runAnalyticsCommand;

  try {
    const { stdout } = await run(
      command,
      ["--json", "--property", site.property, "--days", String(days)],
      { timeout: analyticsTimeoutMs, maxBuffer: analyticsMaxBuffer }
    );

    const parsed = JSON.parse(stdout) as unknown;
    const redacted = redactText(JSON.stringify(parsed));

    return { ok: true, value: JSON.parse(redacted) as unknown };
  } catch {
    return { ok: false, status: 502, error: "analytics-command-failed" };
  }
}

function parseNeonSite(value: unknown): INeonSite | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = readBoundedString(value["property"], 64).toLowerCase();
  const label = readBoundedString(value["label"], 80);
  const domain = readBoundedString(value["domain"], 253).toLowerCase();

  if (!propertyPattern.test(property) || label === "" || !domainPattern.test(domain)) {
    return undefined;
  }

  return { property, label, domain };
}

function readBoundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampDays(value: string | number | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? defaultDays), 10);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.min(maxDays, Math.max(minDays, Math.trunc(parsed)));
}

async function runAnalyticsCommand(
  command: string,
  args: readonly string[],
  options: INeonSiteAnalyticsRunnerOptions
): Promise<{ readonly stdout: string }> {
  const { stdout } = await execFileAsync(command, [...args], {
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer
  });

  return { stdout };
}
