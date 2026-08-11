import { resolveNeonCronTimerGate } from "../automation/cronTimerRuntime.js";
import { resolveNeonDreamingGate } from "../automation/dreamingRuntime.js";
import { resolveNeonHeartbeatTimerGate } from "../automation/heartbeatTimerRuntime.js";
import { resolveNeonHookDispatchGate } from "../automation/hookDispatch.js";
import { resolveNeonScheduledAgentExecutionGate } from "../automation/scheduledAgentExecution.js";
import { resolveNeonDoctorFixGate } from "../doctor/doctorFixRuntime.js";
import { resolveNeonDeliveryDrainGate } from "../gateway/deliveryDrainRuntime.js";
import { resolveNeonInFlightRunGate } from "../gateway/inFlightRunRegistry.js";
import { resolveNeonMemoryWriteGate } from "../memory/memoryWriteRuntime.js";
import {
  resolveNeonMemoryRollbackGate,
  resolveNeonMemoryWritebackGate
} from "../memory/neonMemoryWriteback.js";
import { resolveNeonMirrorRunGate } from "./mirrorRun.js";
import { resolveNeonNodeFileWriteGate } from "../nodes/neonNodeFileWritePolicy.js";
import { resolveNeonPluginInstallGate } from "../plugins/installGate.js";
import { resolveNeonSecretResolutionGate } from "../secrets/secretResolution.js";
import { resolveNeonToolsLiveGate } from "../tools/toolCapabilities.js";
import { resolveNeonWorkspaceNotesGate } from "../workspace/workspaceNotes.js";

/**
 * Gated side-effect posture — the operator's single-pane "what can Neon
 * actually do right now" view over every default-off live-side-effect gate.
 *
 * This is the read-only complement to the cutover backbone: every dangerous
 * runtime path (outbound drain, live-run lifecycle, doctor --fix, memory-write,
 * cron daemon/timer, heartbeat daemon/timer, workspace notes, hook dispatch, dreaming promotion, secret resolution, mirror run,
 * node file-write, plugin-install, live tools) is guarded by a `NEON_*` env
 * gate that is off by default. This aggregates their resolved state so an
 * operator (or a Mission-Control panel / Doctor check) can confirm the shadow
 * posture at a glance: with no env set the posture is `fully-shadowed`.
 *
 * It performs no side effect itself — it only calls the existing pure gate
 * resolvers. The env param is typed `NodeJS.ProcessEnv` so every resolver
 * signature (some take `Readonly<Record<...>>`, plugin-install takes
 * `NodeJS.ProcessEnv`) accepts it without casts.
 */

export type TNeonGatedSideEffectCategory =
  | "outbound"
  | "mutation"
  | "execution"
  | "memory"
  | "secret"
  | "automation";

export type TNeonGatedSideEffectPostureState = "fully-shadowed" | "partially-armed";

export interface INeonGatedSideEffectGate {
  readonly key: string;
  readonly envKey: string;
  readonly category: TNeonGatedSideEffectCategory;
  readonly armed: boolean;
  /** What this gate enables when armed — leak-safe, static description. */
  readonly sideEffect: string;
}

export interface INeonGatedSideEffectPostureTotals {
  readonly gates: number;
  readonly armed: number;
  readonly shadowed: number;
}

export interface INeonGatedSideEffectPosture {
  readonly state: TNeonGatedSideEffectPostureState;
  readonly totals: INeonGatedSideEffectPostureTotals;
  readonly gates: readonly INeonGatedSideEffectGate[];
  readonly armedEnvKeys: readonly string[];
}

interface IGateDescriptor {
  readonly key: string;
  readonly envKey: string;
  readonly category: TNeonGatedSideEffectCategory;
  readonly sideEffect: string;
  readonly resolve: (env: NodeJS.ProcessEnv) => { readonly enabled: boolean };
}

const GATE_DESCRIPTORS: readonly IGateDescriptor[] = [
  {
    key: "delivery-drain",
    envKey: "NEON_DELIVERY_DRAIN_ENABLED",
    category: "outbound",
    sideEffect: "re-attempt stuck pending-drain deliveries on reconnect",
    resolve: (env) => resolveNeonDeliveryDrainGate(env)
  },
  {
    key: "live-run-lifecycle",
    envKey: "NEON_LIVE_RUN_LIFECYCLE_ENABLED",
    category: "execution",
    sideEffect: "track in-flight runs and arm run controls (stop/abort)",
    resolve: (env) => resolveNeonInFlightRunGate(env)
  },
  {
    key: "doctor-fix",
    envKey: "NEON_DOCTOR_FIX_ENABLED",
    category: "mutation",
    sideEffect: "apply permission-tighten chmod fixes",
    resolve: (env) => resolveNeonDoctorFixGate(env)
  },
  {
    key: "memory-write",
    envKey: "NEON_MEMORY_WRITE_ENABLED",
    category: "memory",
    sideEffect: "write productive memory entries to an isolated store",
    resolve: (env) => resolveNeonMemoryWriteGate(env)
  },
  {
    key: "live-index-memory-writeback",
    envKey: "NEON_LIVE_INDEX_WRITEBACK_ENABLED",
    category: "memory",
    sideEffect: "commit verified live-index batches after a private pre-write backup",
    resolve: (env) => resolveNeonMemoryWritebackGate(env)
  },
  {
    key: "memory-writeback-rollback",
    envKey: "NEON_MEMORY_ROLLBACK_ENABLED",
    category: "memory",
    sideEffect: "restore one verified memory snapshot with a bounded recovery attempt",
    resolve: (env) => resolveNeonMemoryRollbackGate(env)
  },
  {
    key: "workspace-notes",
    envKey: "NEON_WORKSPACE_NOTES_ENABLED",
    category: "memory",
    sideEffect: "append local workspace notes and daily memory artifacts",
    resolve: (env) => resolveNeonWorkspaceNotesGate(env)
  },
  {
    key: "dreaming",
    envKey: "NEON_DREAMING_ENABLED",
    category: "memory",
    sideEffect: "promote dream proposals (also needs the memory-write gate)",
    resolve: (env) => resolveNeonDreamingGate(env)
  },
  {
    key: "cron-daemon",
    envKey: "NEON_CRON_DAEMON_ENABLED",
    category: "automation",
    sideEffect: "run the autonomous cron daemon loop",
    resolve: (env) => resolveReadyEnvGate(env, "NEON_CRON_DAEMON_ENABLED")
  },
  {
    key: "cron-timer",
    envKey: "NEON_CRON_TIMER_ENABLED",
    category: "automation",
    sideEffect: "emit autonomous cron run intents",
    resolve: (env) => resolveNeonCronTimerGate(env)
  },
  {
    key: "heartbeat-daemon",
    envKey: "NEON_HEARTBEAT_DAEMON_ENABLED",
    category: "automation",
    sideEffect: "run the autonomous heartbeat daemon loop",
    resolve: (env) => resolveReadyEnvGate(env, "NEON_HEARTBEAT_DAEMON_ENABLED")
  },
  {
    key: "heartbeat-timer",
    envKey: "NEON_HEARTBEAT_TIMER_ENABLED",
    category: "automation",
    sideEffect: "emit autonomous heartbeat wake intents",
    resolve: (env) => resolveNeonHeartbeatTimerGate(env)
  },
  {
    key: "scheduled-agent-execution",
    envKey: "NEON_SCHEDULED_AGENT_EXECUTION_ENABLED",
    category: "automation",
    sideEffect: "invoke selected agent harnesses for deduplicated cron and heartbeat windows",
    resolve: (env) => resolveNeonScheduledAgentExecutionGate(env)
  },
  {
    key: "hook-dispatch",
    envKey: "NEON_HOOK_DISPATCH_ENABLED",
    category: "automation",
    sideEffect: "dispatch read-only internal hooks",
    resolve: (env) => resolveNeonHookDispatchGate(env)
  },
  {
    key: "secret-resolution",
    envKey: "NEON_SECRET_RESOLUTION_ENABLED",
    category: "secret",
    sideEffect: "resolve op:// references via the op CLI",
    resolve: (env) => resolveNeonSecretResolutionGate(env)
  },
  {
    key: "mirror-run",
    envKey: "NEON_MIRROR_RUN_ENABLED",
    category: "execution",
    sideEffect: "drive the Neon side of a mirror comparison run",
    resolve: (env) => resolveNeonMirrorRunGate(env)
  },
  {
    key: "node-file-write",
    envKey: "NEON_NODE_FILE_WRITE_ENABLED",
    category: "mutation",
    sideEffect: "write node files inside an allowlist root",
    resolve: (env) => resolveNeonNodeFileWriteGate(env)
  },
  {
    key: "plugin-install",
    envKey: "NEON_PLUGIN_INSTALL_ENABLED",
    category: "execution",
    sideEffect: "honor a plugin install/enable plan (still no exec)",
    resolve: (env) => resolveNeonPluginInstallGate(env)
  },
  {
    key: "tools-live",
    envKey: "NEON_TOOLS_LIVE_ENABLED",
    category: "execution",
    sideEffect: "run web/api/voice tools live instead of dry-run",
    resolve: (env) => resolveNeonToolsLiveGate(env)
  }
];

function resolveReadyEnvGate(
  env: Readonly<Record<string, string | undefined>>,
  envKey: string
): { readonly enabled: boolean } {
  const normalized = env[envKey]?.trim().toLowerCase();
  return {
    enabled:
      normalized === "1" ||
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "ready" ||
      normalized === "enabled"
  };
}

export function resolveNeonGatedSideEffectPosture(
  env: NodeJS.ProcessEnv = process.env
): INeonGatedSideEffectPosture {
  const gates = GATE_DESCRIPTORS.map((descriptor): INeonGatedSideEffectGate => ({
    key: descriptor.key,
    envKey: descriptor.envKey,
    category: descriptor.category,
    armed: descriptor.resolve(env).enabled,
    sideEffect: descriptor.sideEffect
  })).sort((left, right) =>
    left.category === right.category
      ? left.key.localeCompare(right.key)
      : left.category.localeCompare(right.category)
  );

  const armedGates = gates.filter((gate) => gate.armed);

  return {
    state: armedGates.length === 0 ? "fully-shadowed" : "partially-armed",
    totals: {
      gates: gates.length,
      armed: armedGates.length,
      shadowed: gates.length - armedGates.length
    },
    gates,
    armedEnvKeys: armedGates.map((gate) => gate.envKey)
  };
}

export function renderNeonGatedSideEffectPostureReport(
  posture: INeonGatedSideEffectPosture
): string {
  const lines = posture.gates.map(
    (gate) =>
      `${gate.armed ? "ARMED " : "shadow"} [${gate.category}] ${gate.key} (${gate.envKey}) — ${gate.sideEffect}`
  );

  return [
    "Neonika Gated Side-Effect Posture",
    `State: ${posture.state}`,
    `Gates: ${posture.totals.gates} (armed ${posture.totals.armed} · shadowed ${posture.totals.shadowed})`,
    ...(posture.armedEnvKeys.length > 0 ? [`Armed: ${posture.armedEnvKeys.join(", ")}`] : []),
    ...lines
  ].join("\n");
}
