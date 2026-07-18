/**
 * Discord slash/interaction shadow dispatch (parity row "Slash-Commands /
 * Interactive-Dispatch").
 *
 * Neon already had the two halves: `mapDiscordSlashInteractionToMessageEnvelope`
 * turns a native interaction into a deterministic `/command ...` message
 * envelope, and `createNeonDiscordIngressDecision` (now running the full inbound
 * access chain incl. control-command authorization) gates it. This module is the
 * single named dispatch entry point that ties them together: interaction ->
 * envelope -> shadow ingress -> persisted run. No send happens (shadow run,
 * delivery suppressed); a live interaction *response* stays behind the same
 * outbound canary gates as every other reply.
 *
 * Command authorization is opt-in and reuses the inbound access posture: set
 * `policy.allowTextCommands` + an `allowFrom`/`accessGroups` on the ingress
 * policy and an unauthorized invoker is dropped (`command-not-authorized`);
 * leave them unset and the interaction is admitted as a no-send run (the
 * default). Empty/invalid interactions are dropped distinctly as
 * `empty-command` before they reach ingress.
 *
 * The registration plan is a pure, read-only safety decision: it never calls the
 * Discord API. It prefers guild-scoped registration and blocks global
 * registration unless an operator explicitly opts in — there is no live deploy
 * in shadow regardless.
 */

import type { IMemoryAttachment } from "../harness/types.js";
import {
  mapDiscordSlashInteractionToMessageEnvelope,
  runNeonDiscordShadowIngress,
  type INeonDiscordIngressPolicy,
  type INeonDiscordShadowIngressOptions,
  type INeonDiscordSlashInteractionEnvelope,
  type TNeonDiscordDropReason,
  type TNeonDiscordMemoryResolver
} from "./discordIngress.js";
import type { INeonGatewayShadowResult } from "./types.js";

export type TNeonSlashDispatchDropReason = "empty-command" | TNeonDiscordDropReason;

export interface INeonDiscordSlashDispatchInput {
  readonly interaction: INeonDiscordSlashInteractionEnvelope;
  readonly policy: INeonDiscordIngressPolicy;
  readonly memory?: IMemoryAttachment;
  readonly resolveMemory?: TNeonDiscordMemoryResolver;
}

export type TNeonDiscordSlashDispatchResult =
  | {
      readonly state: "accepted";
      readonly result: INeonGatewayShadowResult;
      readonly commandText: string;
    }
  | {
      readonly state: "dropped";
      readonly reason: TNeonSlashDispatchDropReason;
    };

/**
 * Dispatches a native Discord slash interaction through the live shadow ingress.
 * Returns the persisted shadow run on accept, or a drop reason — including the
 * access-chain reasons (`command-not-authorized`, `mention-required`, …) and the
 * dispatch-level `empty-command` for an interaction that maps to nothing.
 */
export async function runNeonDiscordSlashInteractionShadow(
  input: INeonDiscordSlashDispatchInput,
  options: INeonDiscordShadowIngressOptions
): Promise<TNeonDiscordSlashDispatchResult> {
  const envelope = mapDiscordSlashInteractionToMessageEnvelope(input.interaction);

  if (!envelope) {
    return { state: "dropped", reason: "empty-command" };
  }

  const result = await runNeonDiscordShadowIngress(
    {
      message: envelope,
      policy: input.policy,
      ...(input.memory ? { memory: input.memory } : {}),
      ...(input.resolveMemory ? { resolveMemory: input.resolveMemory } : {})
    },
    options
  );

  if (result.state === "dropped") {
    return { state: "dropped", reason: result.reason };
  }

  return {
    state: "accepted",
    result: result.result,
    commandText: envelope.content
  };
}

export type TNeonSlashCommandRegistrationScope = "guild" | "blocked";

export interface INeonSlashCommandRegistrationPlan {
  readonly scope: TNeonSlashCommandRegistrationScope;
  readonly guildIds: readonly string[];
  readonly blocked: boolean;
  readonly reason: string;
}

/**
 * Pure, read-only registration-scope decision. Prefers guild-scoped
 * registration; blocks global registration (the rule is "no global commands
 * until policy is explicit") and blocks any plan with no guild to scope to. This
 * produces a PLAN only — no Discord API call, no deploy, ever, in shadow.
 */
export function resolveNeonSlashCommandRegistrationPlan(params: {
  readonly requestedScope?: "guild" | "global";
  readonly guildIds?: readonly string[];
  readonly allowGlobal?: boolean;
}): INeonSlashCommandRegistrationPlan {
  const guildIds = (params.guildIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);

  if (params.requestedScope === "global") {
    return {
      scope: "blocked",
      guildIds,
      blocked: true,
      reason:
        params.allowGlobal === true
          ? "global registration acknowledged but never deployed in shadow"
          : "global command registration requires explicit operator opt-in"
    };
  }

  if (guildIds.length === 0) {
    return {
      scope: "blocked",
      guildIds,
      blocked: true,
      reason: "no guild ids to scope registration to"
    };
  }

  return {
    scope: "guild",
    guildIds,
    blocked: false,
    reason: `guild-scoped registration planned for ${guildIds.length} guild(s)`
  };
}

export function renderNeonSlashCommandRegistrationPlanReport(
  plan: INeonSlashCommandRegistrationPlan
): string {
  return [
    "Neon Slash Command Registration Plan",
    `Scope: ${plan.scope}`,
    `Guilds: ${plan.guildIds.length}`,
    `Blocked: ${plan.blocked}`,
    `Reason: ${plan.reason}`
  ].join("\n");
}
