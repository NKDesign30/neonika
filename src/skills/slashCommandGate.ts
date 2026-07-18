/**
 * Slash / control command authorization gate (parity row "Slash-Commands /
 * Interactive-Dispatch"), a 1:1 rebuild of upstream
 * `src/channels/command-gating.ts` (`resolveCommandAuthorizedFromAuthorizers`,
 * `resolveControlCommandGate`).
 *
 * This is the pure authorization decision that sits in front of any real slash
 * command dispatch: given the per-user access-group authorizers, decide whether
 * the user may run a control command and whether an incoming control command
 * should be blocked. It performs no dispatch and no side effect — the live
 * interactive dispatch to Discord stays gated behind a real channel tap. It
 * pairs with the read-only skill command catalog (`skillCommandCatalog.ts`),
 * which lists what commands exist; this decides who may invoke them.
 */

export type TNeonCommandGatingMode = "allow" | "deny" | "configured";

export interface INeonCommandAuthorizer {
  readonly configured: boolean;
  readonly allowed: boolean;
}

export interface IResolveNeonCommandAuthorizedParams {
  readonly useAccessGroups: boolean;
  readonly authorizers: readonly INeonCommandAuthorizer[];
  readonly modeWhenAccessGroupsOff?: TNeonCommandGatingMode;
}

export interface IResolveNeonControlCommandGateParams extends IResolveNeonCommandAuthorizedParams {
  readonly allowTextCommands: boolean;
  readonly hasControlCommand: boolean;
}

export interface IResolveNeonDualTextControlCommandGateParams {
  readonly useAccessGroups: boolean;
  readonly primaryConfigured: boolean;
  readonly primaryAllowed: boolean;
  readonly secondaryConfigured: boolean;
  readonly secondaryAllowed: boolean;
  readonly hasControlCommand: boolean;
  readonly modeWhenAccessGroupsOff?: TNeonCommandGatingMode;
}

export interface INeonControlCommandGateDecision {
  readonly commandAuthorized: boolean;
  readonly shouldBlock: boolean;
}

/**
 * Resolves whether the command is authorized from the access-group authorizers.
 * With access groups on, authorization needs a configured + allowed authorizer.
 * With them off, the `modeWhenAccessGroupsOff` decides (default `allow`); in
 * `configured` mode an unconfigured set is open, otherwise it needs a
 * configured + allowed authorizer.
 */
export function resolveNeonCommandAuthorized(params: IResolveNeonCommandAuthorizedParams): boolean {
  const mode = params.modeWhenAccessGroupsOff ?? "allow";

  if (!params.useAccessGroups) {
    if (mode === "allow") {
      return true;
    }
    if (mode === "deny") {
      return false;
    }
    const anyConfigured = params.authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    return params.authorizers.some((entry) => entry.configured && entry.allowed);
  }

  return params.authorizers.some((entry) => entry.configured && entry.allowed);
}

/**
 * Resolves the control-command gate: a control command is blocked only when text
 * commands are allowed, the message carries a control command, and the user is
 * not authorized.
 */
export function resolveNeonControlCommandGate(
  params: IResolveNeonControlCommandGateParams
): INeonControlCommandGateDecision {
  const commandAuthorized = resolveNeonCommandAuthorized(params);
  const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;

  return { commandAuthorized, shouldBlock };
}

export function resolveNeonDualTextControlCommandGate(
  params: IResolveNeonDualTextControlCommandGateParams
): INeonControlCommandGateDecision {
  return resolveNeonControlCommandGate({
    useAccessGroups: params.useAccessGroups,
    authorizers: [
      { configured: params.primaryConfigured, allowed: params.primaryAllowed },
      { configured: params.secondaryConfigured, allowed: params.secondaryAllowed }
    ],
    allowTextCommands: true,
    hasControlCommand: params.hasControlCommand,
    ...(params.modeWhenAccessGroupsOff ? { modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff } : {})
  });
}

export function renderNeonControlCommandGateReport(
  decision: INeonControlCommandGateDecision
): string {
  return [
    "Neonika Slash/Control Command Gate",
    `Command authorized: ${decision.commandAuthorized}`,
    `Should block: ${decision.shouldBlock}`
  ].join("\n");
}
