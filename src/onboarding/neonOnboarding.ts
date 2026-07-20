import { access } from "node:fs/promises";
import { join } from "node:path";

import { createNeonAgentsSnapshot, loadNeonAgentProfiles } from "../agents/registry.js";
import { createNeonDoctorSnapshot } from "../doctor/neonDoctor.js";
import { readNeonGatewayStatus, resolveGatewayStatePaths } from "../gateway/runStore.js";
import {
  classifyOnePasswordSecretRef,
  resolveSecretInputStatus,
  type TNeonSecretInputStatus,
  type TOnePasswordSecretRefReachability
} from "../secrets/secretRefs.js";
import {
  inspectNeonWhatsAppAuthState,
  type TNeonWhatsAppAuthState
} from "../channels/whatsappAuth.js";
import {
  readNeonSetupConfig,
  resolveNeonSetupPaths,
  type INeonSetupConfig
} from "./neonSetup.js";

export type TNeonOnboardingState = "ready-for-discord-smoke" | "needs-action";
export type TNeonOnboardingStepState = "pass" | "warn" | "action";

export type TNeonOnboardingStepId =
  | "workspace"
  | "identity"
  | "gateway"
  | "agents"
  | "memory"
  | "discord"
  | "whatsapp"
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
  readonly readyForWhatsAppLogin: boolean;
  readonly whatsappSessionLinked: boolean;
  readonly configPreview: INeonOnboardingConfigPreview;
  readonly steps: readonly INeonOnboardingStep[];
}

export interface ICreateNeonOnboardingSnapshotOptions {
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly memorySearchCommandPath?: string;
  readonly configRoot?: string;
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
  const setupPaths = resolveNeonSetupPaths(options.configRoot, env);
  const memorySearchPath = options.memorySearchCommandPath ?? env[memorySearchCommandEnvKey]?.trim() ?? "";
  const memoryDbPath = env["NEON_MEMORY_DB_PATH"]?.trim() ?? "";
  const [workspaceReady, memorySearchReady, memoryDbReady, gatewayStatus, doctor, setupConfig, whatsappSessionLinked] = await Promise.all([
    fileExists(join(paths.projectRoot, "package.json")),
    fileExists(memorySearchPath),
    fileExists(memoryDbPath),
    readNeonGatewayStatus(projectRoot),
    createNeonDoctorSnapshot(projectRoot, { env }),
    readNeonSetupConfig(options.configRoot, env),
    inspectNeonWhatsAppAuthState(setupPaths.whatsappAuthPath)
  ]);
  const memoryReady = memorySearchReady || memoryDbReady;
  const agents = createNeonAgentsSnapshot((await loadNeonAgentProfiles(projectRoot)).profiles);
  const configPreview = createConfigPreview(env, setupConfig);
  const steps = [
    buildWorkspaceStep(workspaceReady),
    buildIdentityStep(setupConfig),
    buildGatewayStep(gatewayStatus.runCount),
    buildAgentsStep(agents.agents.length, agents.defaultAgentId),
    buildMemoryStep(memoryReady),
    buildDiscordStep(configPreview.env, setupConfig),
    buildWhatsAppStep(setupConfig, whatsappSessionLinked.state),
    buildDoctorStep(doctor.state)
  ];
  const readyForDiscordSmoke = steps
    .filter((step) => ["workspace", "identity", "agents", "memory", "discord"].includes(step.id))
    .every((step) => step.state === "pass");
  const whatsapp = setupConfig?.channels.whatsapp;
  const readyForWhatsAppLogin =
    whatsapp?.enabled === true &&
    whatsapp.ownerPeerId !== undefined &&
    whatsapp.groupPolicy === "disabled";

  return {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    state: readyForDiscordSmoke ? "ready-for-discord-smoke" : "needs-action",
    readyForDiscordSmoke,
    readyForWhatsAppLogin,
    whatsappSessionLinked: whatsappSessionLinked.state === "linked",
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
    `Neonika Onboarding: ${snapshot.state}`,
    `Ready for Discord smoke: ${snapshot.readyForDiscordSmoke ? "yes" : "no"}`,
    `Ready for WhatsApp login: ${snapshot.readyForWhatsAppLogin ? "yes" : "no"}`,
    `WhatsApp session linked: ${snapshot.whatsappSessionLinked ? "yes" : "no"}`,
    `Config preview: ${snapshot.configPreview.command}, secretsPrinted=${String(snapshot.configPreview.secretsPrinted)}`,
    ...snapshot.configPreview.env.map((entry) => `${entry.name}: ${entry.status}`),
    ...stepLines
  ].join("\n");
}

function createConfigPreview(
  env: Readonly<Record<string, string | undefined>>,
  setupConfig: INeonSetupConfig | undefined
): INeonOnboardingConfigPreview {
  const configuredEnv: Readonly<Record<string, string | undefined>> = {
    ...env,
    ...(setupConfig?.channels.discord.allowedGuilds.length
      ? { NEON_DISCORD_ALLOWED_GUILDS: "configured" }
      : {}),
    ...(setupConfig?.channels.discord.allowedChannels.length
      ? { NEON_DISCORD_ALLOWED_CHANNELS: "configured" }
      : {})
  };
  return {
    command: "discord-shadow-tap",
    env: discordEnvNames.map((name) => buildEnvPreview(name, configuredEnv[name])),
    secretsPrinted: false
  };
}

function buildIdentityStep(config: INeonSetupConfig | undefined): INeonOnboardingStep {
  if (config === undefined) {
    return {
      id: "identity",
      label: "Identity",
      state: "action",
      summary: "No private owner identity has been configured.",
      recovery: ["Run neonika onboard."]
    };
  }
  return {
    id: "identity",
    label: "Identity",
    state: config.identity.links.length > 0 ? "pass" : "warn",
    summary:
      config.identity.links.length > 0
        ? `${config.identity.links.length} explicit channel identity link(s).`
        : "Owner identity exists, but no channel peer is linked.",
    recovery: config.identity.links.length > 0 ? [] : ["Run neonika onboard --interactive to link a channel peer."]
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
    summary: workspaceReady ? "Neonika package is present." : "Neonika package.json is missing.",
    recovery: workspaceReady ? [] : ["Run this command from the Neonika checkout root."]
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
    summary: memoryReady ? "Local memory backend is available." : "Local memory backend is missing.",
    recovery: memoryReady
      ? []
      : [
          "Run neonika onboard to create local SQLite memory.",
          `Alternatively point ${memorySearchCommandEnvKey} at an executable memory-search command.`
        ]
  };
}

function buildDiscordStep(
  envPreview: readonly INeonOnboardingEnvPreview[],
  config: INeonSetupConfig | undefined
): INeonOnboardingStep {
  if (config?.channels.discord.enabled !== true) {
    return {
      id: "discord",
      label: "Discord",
      state: "action",
      summary: "Discord is not configured as the primary hub.",
      recovery: ["Run neonika onboard --interactive and configure Discord."]
    };
  }
  if (config.channels.discord.ownerPeerId === undefined) {
    return {
      id: "discord",
      label: "Discord",
      state: "action",
      summary: "Discord hub has no explicit owner identity link.",
      recovery: ["Run neonika onboard --discord --discord-owner <Discord user id>."]
    };
  }
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

function buildWhatsAppStep(
  config: INeonSetupConfig | undefined,
  authState: TNeonWhatsAppAuthState
): INeonOnboardingStep {
  const whatsapp = config?.channels.whatsapp;
  if (whatsapp?.enabled !== true) {
    return {
      id: "whatsapp",
      label: "WhatsApp",
      state: "warn",
      summary: "WhatsApp companion is skipped.",
      recovery: ["Run neonika onboard --interactive to configure the companion."]
    };
  }
  if (whatsapp.ownerPeerId === undefined) {
    return {
      id: "whatsapp",
      label: "WhatsApp",
      state: "action",
      summary: "WhatsApp companion has no explicit owner link.",
      recovery: ["Run neonika onboard --whatsapp --whatsapp-owner <E.164 number>."]
    };
  }
  if (authState === "invalid") {
    return {
      id: "whatsapp",
      label: "WhatsApp",
      state: "action",
      summary: "WhatsApp linked-device auth state is unsafe or invalid.",
      recovery: ["Repair the private auth state, then run neonika whatsapp-login again."]
    };
  }
  const sessionLinked = authState === "linked";
  return {
    id: "whatsapp",
    label: "WhatsApp",
    state: sessionLinked ? "pass" : "action",
    summary: sessionLinked
      ? "WhatsApp linked-device state is present."
      : "WhatsApp access policy is ready; linked-device login is pending.",
    recovery: sessionLinked ? [] : ["Complete the WhatsApp linked-device QR login."]
  };
}

function buildDoctorStep(doctorState: string): INeonOnboardingStep {
  return {
    id: "doctor",
    label: "Doctor",
    state: doctorState === "fail" ? "action" : doctorState === "warn" ? "warn" : "pass",
    summary: `Neonika Doctor reports ${doctorState}.`,
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
