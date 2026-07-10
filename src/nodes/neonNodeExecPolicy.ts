// Read-only command-execution policy for paired nodes.
//
// Upstream exposes a remote `system.run` command-exec capability that is gated by
// exec-approvals. Neon Core does NOT execute remote commands at all. This module
// states that posture as an explicit deny-by-default policy so an operator audit
// can see that `system.run` is a recognized-but-blocked kind, and how the gate
// would layer once execution is ever enabled. Pure: no execution, no I/O.
//
// Two block reasons make the layered gate visible: even a kind on the allowlist
// is still blocked while `executionEnabled` is false (`execution-disabled`); a
// kind that is not on the allowlist would also be blocked once execution is
// enabled (`not-allowlisted`). The hard `executed: false` marker mirrors the node
// action model's `sideEffectExecuted: false`.

export type TNeonNodeExecKind = "system.run";
export type TNeonNodeExecBlockReason = "execution-disabled" | "not-allowlisted";

export interface INeonNodeExecPolicyDecision {
  readonly kind: TNeonNodeExecKind;
  readonly state: "blocked";
  readonly reason: TNeonNodeExecBlockReason;
  readonly executed: false;
}

export interface INeonNodeExecPolicySnapshot {
  readonly state: "read-only";
  readonly executionEnabled: false;
  readonly allowlist: readonly string[];
  readonly decisions: readonly INeonNodeExecPolicyDecision[];
}

const recognizedExecKinds: readonly TNeonNodeExecKind[] = ["system.run"];

/**
 * Resolve the policy decision for one command-exec kind. Always blocked while
 * execution is globally disabled; the allowlist only determines the reason so the
 * audit shows which kinds a future operator allowlist would still need to cover.
 */
export function resolveNeonNodeExecPolicy(
  kind: TNeonNodeExecKind,
  allowlist: readonly string[] = []
): INeonNodeExecPolicyDecision {
  const onAllowlist = allowlist.includes(kind);

  return {
    kind,
    state: "blocked",
    reason: onAllowlist ? "execution-disabled" : "not-allowlisted",
    executed: false
  };
}

/** Build the read-only exec policy snapshot for all recognized exec kinds. */
export function createNeonNodeExecPolicySnapshot(
  allowlist: readonly string[] = []
): INeonNodeExecPolicySnapshot {
  return {
    state: "read-only",
    executionEnabled: false,
    allowlist: [...allowlist],
    decisions: recognizedExecKinds.map((kind) => resolveNeonNodeExecPolicy(kind, allowlist))
  };
}

export function renderNeonNodeExecPolicyReport(snapshot: INeonNodeExecPolicySnapshot): string {
  const decisionLines = snapshot.decisions.map(
    (decision) => `- ${decision.kind}: ${decision.state} / ${decision.reason} / executed=${decision.executed}`
  );

  return [
    `Neon Node Exec Policy: ${snapshot.state}`,
    `Execution enabled: ${snapshot.executionEnabled} / allowlist: ${snapshot.allowlist.length}`,
    "Decisions:",
    ...decisionLines
  ].join("\n");
}
