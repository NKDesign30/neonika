import { access } from "node:fs/promises";
import { join } from "node:path";

import { createNeonAgentsSnapshot } from "../agents/registry.js";
import { createNeonDoctorSnapshot } from "../doctor/neonDoctor.js";
import { readNeonGatewayStatus, resolveGatewayStatePaths } from "../gateway/runStore.js";
import {
  classifyOnePasswordSecretRef,
  resolveSecretInputStatus,
  type TNeonSecretInputStatus,
  type TOnePasswordSecretRefReachability
} from "../secrets/secretRefs.js";

export type TNeonOnboardingState = "ready-for-discord-smoke" | "needs-action";
export type TNeonOnboardingStepState = "pass" | "warn" | "action";

export type TNeonOnboardingStepId =
  | "workspace"
  | "gateway"
  | "agents"
  | "memory"
  | "discord"
  | "doctor";

export interface INeonOnboardingEnvPreview {
  readonly name: string;
  readonly present: boolean;
  readonly secret: boolean;
  readonly status: TNeonSecretInputStatus;
  /**
   * Structural reachability of an `op://` value (only set when `status === "ref"`).
   * Derived without resolving the secret — the value is never read or echoed.
   */
  readonly reachability?: TOnePasswordSecretRefReachability;
}

export interface INeonOnboardingConfigPreview {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly gatewayRunsPath: string;
  readonly command: "discord-shadow-tap";
  readonly env: readonly INeonOnboardingEnvPreview[];
  readonly secretsPrinted: false;
}

export interface INeonOnboardingStep {
  readonly id: TNeonOnboardingStepId;
  readonly label: string;
  readonly state: TNeonOnboardingStepState;
  readonly summary: string;
  readonly recovery: readonly string[];
}

export interface INeonOnboardingSnapshot {
  readonly generatedAt: string;
  readonly state: TNeonOnboardingState;
  readonly readyForDiscordSmoke: boolean;
  readonly configPreview: INeonOnboardingConfigPreview;
  readonly steps: readonly INeonOnboardingStep[];
}

export interface ICreateNeonOnboardingSnapshotOptions {
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly memorySearchCommandPath?: string;
}

// Same contract as neonMemory.ts: the CLI memory backend is opt-in via env, so a
// fresh checkout onboards without assuming any local layout.
const memorySearchCommandEnvKey = "NEON_MEMORY_SEARCH_COMMAND" as const;
const discordEnvNames = [
  "NEON_DISCORD_BOT_TOKEN",
  "NEON_DISCORD_BOT_USER_ID",
  "NEON_DISCORD_ALLOWED_GUILDS",
  "NEON_DISCORD_ALLOWED_CHANNELS"
] as const;

export async function createNeonOnboardingSnapshot(
  projectRoot: string,
  options: ICreateNeonOnboardingSnapshotOptions = {}
): Promise<INeonOnboardingSnapshot> {
  const env = options.env ?? process.env;
  const paths = resolveGatewayStatePaths(projectRoot);
  const [workspaceReady, memoryReady, gatewayStatus, doctor] = await Promise.all([
    fileExists(join(paths.projectRoot, "package.json")),
    fileExists(options.memorySearchCommandPath ?? env[memorySearchCommandEnvKey]?.trim() ?? ""),
    readNeonGatewayStatus(projectRoot),
    createNeonDoctorSnapshot(projectRoot)
  ]);
  const agents = createNeonAgentsSnapshot();
  const configPreview = createConfigPreview(paths.projectRoot, paths.stateRoot, paths.runsPath, env);
  const steps = [
    buildWorkspaceStep(workspaceReady),
    buildGatewayStep(gatewayStatus.runCount),
    buildAgentsStep(agents.agents.length, agents.defaultAgentId),
    buildMemoryStep(memoryReady),
    buildDiscordStep(configPreview.env),
    buildDoctorStep(doctor.state)
  ];
  const readyForDiscordSmoke = steps
    .filter((step) => step.id !== "gateway" && step.id !== "doctor")
    .every((step) => step.state === "pass");

  return {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    state: readyForDiscordSmoke ? "ready-for-discord-smoke" : "needs-action",
    readyForDiscordSmoke,
    configPreview,
    steps
  };
}

export function renderNeonOnboardingReport(snapshot: INeonOnboardingSnapshot): string {
  const stepLines = snapshot.steps.map((step) => {
    const recovery = step.recovery.length > 0 ? ` Recovery: ${step.recovery.join(" | ")}` : "";

    return `${step.state.toUpperCase()} ${step.label}: ${step.summary}${recovery}`;
  });

  return [
    `Neon Onboarding: ${snapshot.state}`,
    `Ready for Discord smoke: ${snapshot.readyForDiscordSmoke ? "yes" : "no"}`,
    `Config preview: ${snapshot.configPreview.command}, secretsPrinted=${String(snapshot.configPreview.secretsPrinted)}`,
    `Project: ${snapshot.configPreview.projectRoot}`,
    ...snapshot.configPreview.env.map((entry) => `${entry.name}: ${entry.status}`),
    ...stepLines
  ].join("\n");
}

function createConfigPreview(
  projectRoot: string,
  stateRoot: string,
  runsPath: string,
  env: Readonly<Record<string, string | undefined>>
): INeonOnboardingConfigPreview {
  return {
    projectRoot,
    stateRoot,
    gatewayRunsPath: runsPath,
    command: "discord-shadow-tap",
    env: discordEnvNames.map((name) => buildEnvPreview(name, env[name])),
    secretsPrinted: false
  };
}

function buildEnvPreview(name: string, value: string | undefined): INeonOnboardingEnvPreview {
  const status = resolveSecretInputStatus(value);
  const base = {
    name,
    present: isPresent(value),
    secret: name === "NEON_DISCORD_BOT_TOKEN",
    status
  } as const;

  if (status !== "ref" || value === undefined) {
    return base;
  }

  const reachability = classifyOnePasswordSecretRef(value);

  return reachability === null ? base : { ...base, reachability };
}

function buildWorkspaceStep(workspaceReady: boolean): INeonOnboardingStep {
  return {
    id: "workspace",
    label: "Workspace",
    state: workspaceReady ? "pass" : "action",
    summary: workspaceReady ? "Neon Core package is present." : "Neon Core package.json is missing.",
    recovery: workspaceReady ? [] : ["Run this command from the Neon Core checkout root."]
  };
}

function buildGatewayStep(runCount: number): INeonOnboardingStep {
  return {
    id: "gateway",
    label: "Gateway",
    state: runCount > 0 ? "pass" : "warn",
    summary: runCount > 0 ? `${runCount} Gateway run(s) captured.` : "No Gateway run captured yet.",
    recovery: runCount > 0 ? [] : ["node dist/src/cli.js gateway-shadow-smoke"]
  };
}

function buildAgentsStep(agentCount: number, defaultAgentId: string): INeonOnboardingStep {
  return {
    id: "agents",
    label: "Agents",
    state: agentCount > 0 ? "pass" : "action",
    summary: `${agentCount} agent(s), default=${defaultAgentId}.`,
    recovery: agentCount > 0 ? [] : ["Check src/agents/registry.ts."]
  };
}

function buildMemoryStep(memoryReady: boolean): INeonOnboardingStep {
  return {
    id: "memory",
    label: "Memory",
    state: memoryReady ? "pass" : "action",
    summary: memoryReady ? "memory-search command is available." : "memory-search command is missing.",
    recovery: memoryReady
      ? []
      : [`Point ${memorySearchCommandEnvKey} at an executable memory-search command (optional).`]
  };
}

function buildDiscordStep(envPreview: readonly INeonOnboardingEnvPreview[]): INeonOnboardingStep {
  const missing = envPreview.filter((entry) => !entry.present).map((entry) => entry.name);
  // Present op:// refs that cannot structurally resolve — flagged without ever
  // reading or echoing the secret value (only the env var name surfaces).
  const unreachable = envPreview
    .filter((entry) => entry.reachability === "incomplete" || entry.reachability === "malformed")
    .map((entry) => entry.name);

  if (missing.length > 0) {
    return {
      id: "discord",
      label: "Discord",
      state: "action",
      summary: `${missing.length} Discord env value(s) missing.`,
      recovery: missing.map((name) => `Set ${name}.`)
    };
  }

  if (unreachable.length > 0) {
    return {
      id: "discord",
      label: "Discord",
      state: "action",
      summary: `${unreachable.length} Discord SecretRef(s) cannot resolve (incomplete op:// shape).`,
      recovery: unreachable.map(
        (name) => `Fix ${name}: use op://vault/item/field (values were not read).`
      )
    };
  }

  return {
    id: "discord",
    label: "Discord",
    state: "pass",
    summary: "Discord shadow tap env is ready.",
    recovery: []
  };
}

function buildDoctorStep(doctorState: string): INeonOnboardingStep {
  return {
    id: "doctor",
    label: "Doctor",
    state: doctorState === "fail" ? "action" : doctorState === "warn" ? "warn" : "pass",
    summary: `Neon Doctor reports ${doctorState}.`,
    recovery: doctorState === "fail" ? ["node dist/src/cli.js doctor-smoke"] : []
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
