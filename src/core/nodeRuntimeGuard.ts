export const neonSupportedNodeEngine = ">=22.19.0 <23 || >=23.11.0";

export type TNeonNodeRuntimeSupportState = "supported" | "unsupported";

export interface INeonNodeVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface INeonNodeRuntimeAssessment {
  readonly state: TNeonNodeRuntimeSupportState;
  readonly nodeVersion: string;
  readonly supportedRange: string;
  readonly reason: string;
  readonly version?: INeonNodeVersionParts;
}

const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseNeonNodeVersion(version: string): INeonNodeVersionParts | undefined {
  const match = version.trim().match(NODE_VERSION_PATTERN);
  if (!match) {
    return undefined;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }

  return { major, minor, patch };
}

export function isNeonSupportedNodeVersion(version: string): boolean {
  return assessNeonNodeRuntime(version).state === "supported";
}

export function assessNeonNodeRuntime(version: string | undefined): INeonNodeRuntimeAssessment {
  const nodeVersion = version?.trim() ?? "";
  const parsed = parseNeonNodeVersion(nodeVersion);
  if (!parsed) {
    return {
      state: "unsupported",
      nodeVersion: nodeVersion || "unreadable",
      supportedRange: neonSupportedNodeEngine,
      reason: "Node runtime version is unreadable"
    };
  }

  if (isSupportedParsedNodeVersion(parsed)) {
    return {
      state: "supported",
      nodeVersion,
      supportedRange: neonSupportedNodeEngine,
      reason: `Node ${nodeVersion} satisfies ${neonSupportedNodeEngine}`,
      version: parsed
    };
  }

  return {
    state: "unsupported",
    nodeVersion,
    supportedRange: neonSupportedNodeEngine,
    reason: `Node ${nodeVersion} does not satisfy ${neonSupportedNodeEngine}`,
    version: parsed
  };
}

function isSupportedParsedNodeVersion(version: INeonNodeVersionParts): boolean {
  if (version.major < 22) {
    return false;
  }
  if (version.major === 22) {
    return version.minor >= 19;
  }
  if (version.major === 23) {
    return version.minor >= 11;
  }
  return true;
}
