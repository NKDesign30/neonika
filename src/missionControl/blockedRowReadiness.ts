/**
 * Operator decision/readiness catalog for the blocked capability rows.
 *
 * Every other gated surface answers "is the gate open right now". This answers
 * the operator question one level up: for each capability that is deliberately
 * NOT live yet, why is it blocked, what would arming it actually do, which env
 * keys / product decision are missing, how do you roll it back, how do you
 * verify it, and is an operator decision required.
 *
 * The catalog rows mirror the `blocked` rows of `docs/neonika-acceleration-plan.md`
 * 1:1 (titles, areas, reasons and verify refs are taken from the matrix). The
 * static fields are the real decision record; the LIVE field is `missingEnv`,
 * computed against the actual process env so the panel is never a fake table.
 *
 * Nothing here arms anything: it is a pure read model.
 */

/** Why a row cannot go live, in operator terms. */
export type TNeonBlockedRowCategory =
  // Gated send/dispatch path is built; arming needs a real live target + operator go.
  | "outbound-live-target"
  // Routing production traffic to Neon; an operator product decision.
  | "primary-cutover"
  // Needs a live in-flight session runtime the shadow contract deliberately lacks.
  | "live-session-runtime"
  // Waiting on a Codex server-initiated request surface that is not modeled yet.
  | "upstream-protocol"
  // Intentional non-goal, hard-blocked by design.
  | "non-goal";

export type TNeonBlockedRowApproval =
  | "operator-live-target"
  | "operator-product-decision"
  | "needs-live-runtime-decision"
  | "upstream-protocol"
  | "none-by-design";

export interface INeonBlockedRowReadiness {
  readonly id: string;
  readonly title: string;
  readonly area: string;
  readonly category: TNeonBlockedRowCategory;
  readonly whyBlocked: string;
  readonly liveEffect: string;
  readonly rollback: string;
  readonly verifyCommand: string;
  /** Real env keys that must be set for the gated path to even be eligible. */
  readonly requiredEnv: readonly string[];
  readonly approval: TNeonBlockedRowApproval;
}

export interface INeonBlockedRowReadinessStatus extends INeonBlockedRowReadiness {
  /** Required env keys not currently set (presence check against live env). */
  readonly missingEnv: readonly string[];
  readonly requiredEnvSatisfied: boolean;
  readonly operatorApprovalNeeded: boolean;
}

export interface INeonBlockedRowReadinessTotals {
  readonly total: number;
  readonly operatorApprovalNeeded: number;
  readonly liveSessionRuntime: number;
  readonly upstreamProtocol: number;
  readonly nonGoal: number;
  readonly requiredEnvSatisfied: number;
}

export interface INeonBlockedRowReadinessSnapshot {
  readonly rows: readonly INeonBlockedRowReadinessStatus[];
  readonly totals: INeonBlockedRowReadinessTotals;
}

const CANARY_OUTBOUND_ENV: readonly string[] = [
  "NEON_CUTOVER_STAGE",
  "NEON_CUTOVER_CANARY_APPROVED",
  "NEON_CUTOVER_OUTBOUND_ENABLED",
  "NEON_CUTOVER_CANARY_CHANNELS"
];

const PRIMARY_CUTOVER_ENV: readonly string[] = [
  "NEON_CUTOVER_STAGE",
  "NEON_CUTOVER_PRIMARY_APPROVED"
];

/**
 * The 13 blocked rows, taken from the acceleration-plan matrix. Six named
 * capability rows plus seven numbered work-queue rows, each kept verbatim in
 * title/area so the panel maps 1:1 to the matrix an operator reads.
 */
export const NEON_BLOCKED_ROW_READINESS: readonly INeonBlockedRowReadiness[] = [
  {
    id: "slash-commands-interactive-dispatch",
    title: "Slash-Commands / Interactive-Dispatch",
    area: "Discord",
    category: "outbound-live-target",
    whyBlocked:
      "Read-only Unterbau (Mapping, Skill-Command-Katalog, Control-Command-Gate) ist gebaut; der Live-Interaction-Dispatch an Discord bleibt aus bis eine Interactive-Send/Deploy-Policy freigegeben ist.",
    liveEffect:
      "Neon würde auf Discord-Slash/Interaction-Events mit echten Interaction-Responses antworten (sichtbarer Bot-Output).",
    rollback: "Interactive-Dispatch-Flag schließen; Default bleibt shadow/candidate, kein Response.",
    verifyCommand: "node dist/src/cli.js slash-command-gate-smoke",
    requiredEnv: CANARY_OUTBOUND_ENV,
    approval: "operator-live-target"
  },
  {
    id: "handle-send-chat",
    title: "Nachricht senden / handleSendChat",
    area: "Gateway/Delivery",
    category: "outbound-live-target",
    whyBlocked:
      "Outbound bleibt default suppressed; der echte Send-Entry-Point hängt am Gateway-Delivery-Pfad, der nur über die Canary-Gates senden darf.",
    liveEffect: "Eine Operator-/Agent-Nachricht würde wirklich an einen Discord-Kanal zugestellt.",
    rollback: "Canary-Gates schließen (Stage != canary); Delivery fällt sofort auf suppressed zurück.",
    verifyCommand: "node dist/src/cli.js delivery-dispatch-smoke",
    requiredEnv: [...CANARY_OUTBOUND_ENV, "NEON_CHAT_SEND_CHANNELS"],
    approval: "operator-live-target"
  },
  {
    id: "lifecycle-actions-resume-branch-label-delete",
    title: "Lifecycle-Aktionen (resume/branch/label/delete)",
    area: "Sessions",
    category: "live-session-runtime",
    whyBlocked:
      "Bewusst nicht gebaut ohne echte Session-Runtime; ohne live In-Flight-Session wäre resume/branch/label/delete ein Schein-Feature.",
    liveEffect: "Operator würde laufende Agent-Sessions fortsetzen, abzweigen, umbenennen oder löschen.",
    rollback: "Keine Aktion vorhanden, solange kein Live-Session-Store armed ist; nichts zu rollbacken.",
    verifyCommand: "node dist/src/cli.js run-lifecycle-smoke",
    requiredEnv: [],
    approval: "needs-live-runtime-decision"
  },
  {
    id: "agent-registry-real-spawn-lifecycle",
    title: "Agent-Registry mit echtem Spawn/Lifecycle",
    area: "Agents",
    category: "live-session-runtime",
    whyBlocked:
      "agentId ist an Runs/Filter gekoppelt; echter Per-Agent-Spawn/Lifecycle bleibt aus bis ein In-Flight-Run-Store existiert.",
    liveEffect: "Neon würde echte Agent-Prozesse spawnen und pro Agent lifecyclen.",
    rollback: "Kein Spawn-Pfad armed; Registry bleibt read-only Projektion über terminale Runs.",
    verifyCommand: "node dist/src/cli.js agents-smoke chaty",
    requiredEnv: [],
    approval: "needs-live-runtime-decision"
  },
  {
    id: "remote-system-run-command-exec",
    title: "Remote system.run / Command-Exec",
    area: "Nodes",
    category: "non-goal",
    whyBlocked:
      "Read-only Audit-Policy gebaut (resolveNeonNodeExecPolicy, executed:false); echter Command-Exec ist struktureller Non-Goal und bleibt hart geblockt.",
    liveEffect: "Neon würde beliebige Shell-Kommandos auf einem Node ausführen.",
    rollback: "Nicht zutreffend; es gibt bewusst keinen Exec-Sink.",
    verifyCommand: "node dist/src/cli.js node-exec-policy-smoke",
    requiredEnv: [],
    approval: "none-by-design"
  },
  {
    id: "primary-switch-default-routing",
    title: "Primary-Switch (Default-Routing)",
    area: "Cutover/Delivery",
    category: "primary-cutover",
    whyBlocked:
      "Delivery-Default bleibt suppressed; Primary-Routing sendet erst bei Primary-Gate-pass und ist eine Produktentscheidung.",
    liveEffect: "Neon würde Default-Produktions-Routing übernehmen (jeder Pfad sendet live).",
    rollback: "NEON_CUTOVER_ROLLBACK_COMMAND zurücksetzen auf Canary/Shadow; Cutover-Gate verriegelt Primary sequentiell.",
    verifyCommand: "node dist/src/cli.js cutover-gate",
    requiredEnv: PRIMARY_CUTOVER_ENV,
    approval: "operator-product-decision"
  },
  {
    id: "slash-interaction-live-dispatch-13",
    title: "Slash-Interaction Live-Dispatch",
    area: "Discord",
    category: "outbound-live-target",
    whyBlocked:
      "Contract/Mapping existieren; echter Live-Dispatch bleibt aus bis Discord-Interactive-Send/Deploy-Policy freigegeben ist.",
    liveEffect: "Discord-Interactions würden in echte Run/Delivery-Candidates und sichtbare Responses münden.",
    rollback: "Dispatch-Flag schließen; Interactions bleiben shadow/candidate.",
    verifyCommand: "node dist/src/cli.js discord-shadow-smoke",
    requiredEnv: CANARY_OUTBOUND_ENV,
    approval: "operator-live-target"
  },
  {
    id: "session-checkpoint-count-18",
    title: "Session Checkpoint Count",
    area: "Sessions",
    category: "live-session-runtime",
    whyBlocked:
      "Blockt bis echte Checkpoint-/Compaction-Events im Run-Store existieren; Branch/Restore bleibt vorerst Nicht-Ziel.",
    liveEffect: "Sessions-Projektion würde echte Checkpoint-Counts und Branch/Restore anbieten.",
    rollback: "Kein Checkpoint-Schreiber armed; Count bleibt Empty-State.",
    verifyCommand: "node dist/src/cli.js sessions-smoke",
    requiredEnv: [],
    approval: "needs-live-runtime-decision"
  },
  {
    id: "session-lifecycle-actions-19",
    title: "Session Lifecycle Actions",
    area: "Sessions",
    category: "live-session-runtime",
    whyBlocked: "Resume/branch/label/delete erst nach echter Session-Runtime plus Auth-Gate.",
    liveEffect: "Operator würde Sessions live steuern (gleicher Effekt wie die benannte Lifecycle-Row).",
    rollback: "Keine Aktion armed; nichts zu rollbacken.",
    verifyCommand: "node dist/src/cli.js run-lifecycle-smoke",
    requiredEnv: [],
    approval: "needs-live-runtime-decision"
  },
  {
    id: "agent-run-record-per-agent-24",
    title: "Agent Run-Record pro Agent",
    area: "Agents",
    category: "live-session-runtime",
    whyBlocked: "agentId ist an Runs/Filter gekoppelt; echter Per-Agent-Spawn/Lifecycle bleibt aus bis In-Flight-Run-Store existiert.",
    liveEffect: "Pro-Agent Run-Records würden aus echten Live-Spawns statt terminalen Runs entstehen.",
    rollback: "Kein Live-Spawn armed; Records bleiben read-only über terminale Runs.",
    verifyCommand: "node dist/src/cli.js agents-smoke chaty",
    requiredEnv: [],
    approval: "needs-live-runtime-decision"
  },
  {
    id: "approval-request-event-projection-25",
    title: "Approval-Request Event Projection",
    area: "Agents",
    category: "upstream-protocol",
    whyBlocked:
      "Codex Approval ist ein server-initiierter Request; der Harness modelliert noch keinen server-request-Pfad und es werden keine Method-Namen geraten.",
    liveEffect: "Approval-Requests des Modells würden als Live-Events projiziert und operator-beantwortbar.",
    rollback: "Nicht zutreffend; Surface existiert upstream noch nicht.",
    verifyCommand: "npm test",
    requiredEnv: [],
    approval: "upstream-protocol"
  },
  {
    id: "elicitation-event-projection-26",
    title: "Elicitation Event Projection",
    area: "Agents",
    category: "upstream-protocol",
    whyBlocked: "Gleiche Ursache wie die Approval-Bridge; ohne Codex-Request-Surface wäre es Schein.",
    liveEffect: "Elicitation-Requests des Modells würden als Live-Events projiziert.",
    rollback: "Nicht zutreffend; Surface existiert upstream noch nicht.",
    verifyCommand: "npm test",
    requiredEnv: [],
    approval: "upstream-protocol"
  },
  {
    id: "primary-switch-44",
    title: "Primary Switch",
    area: "Cutover/Delivery",
    category: "primary-cutover",
    whyBlocked: "Erst nach Outbound-Canary plus Stabilitätsbeweis; default suppressed bis dahin.",
    liveEffect: "Primary-Routing würde aktiviert (gleicher Effekt wie die benannte Primary-Switch-Row).",
    rollback: "NEON_CUTOVER_ROLLBACK_COMMAND zurücksetzen; Cutover-Gate verriegelt Primary hinter Canary-Evidence.",
    verifyCommand: "node dist/src/cli.js cutover-gate",
    requiredEnv: PRIMARY_CUTOVER_ENV,
    approval: "operator-product-decision"
  }
];

function isEnvSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function operatorApprovalNeededFor(approval: TNeonBlockedRowApproval): boolean {
  return approval === "operator-live-target" || approval === "operator-product-decision";
}

export function createNeonBlockedRowReadinessSnapshot(
  options: { readonly env?: NodeJS.ProcessEnv } = {}
): INeonBlockedRowReadinessSnapshot {
  const env = options.env ?? process.env;

  const rows: INeonBlockedRowReadinessStatus[] = NEON_BLOCKED_ROW_READINESS.map((row) => {
    const missingEnv = row.requiredEnv.filter((key) => !isEnvSet(env, key));
    return {
      ...row,
      missingEnv,
      requiredEnvSatisfied: missingEnv.length === 0,
      operatorApprovalNeeded: operatorApprovalNeededFor(row.approval)
    };
  });

  const totals: INeonBlockedRowReadinessTotals = {
    total: rows.length,
    operatorApprovalNeeded: rows.filter((row) => row.operatorApprovalNeeded).length,
    liveSessionRuntime: rows.filter((row) => row.category === "live-session-runtime").length,
    upstreamProtocol: rows.filter((row) => row.category === "upstream-protocol").length,
    nonGoal: rows.filter((row) => row.category === "non-goal").length,
    requiredEnvSatisfied: rows.filter((row) => row.requiredEnv.length > 0 && row.requiredEnvSatisfied)
      .length
  };

  return { rows, totals };
}

export function renderNeonBlockedRowReadinessReport(
  snapshot: INeonBlockedRowReadinessSnapshot
): string {
  const lines: string[] = [
    "Neonika Blocked-Row Readiness",
    `rows=${snapshot.totals.total} operator-approval=${snapshot.totals.operatorApprovalNeeded} live-session=${snapshot.totals.liveSessionRuntime} upstream=${snapshot.totals.upstreamProtocol} non-goal=${snapshot.totals.nonGoal}`,
    ""
  ];
  for (const row of snapshot.rows) {
    const envState =
      row.requiredEnv.length === 0
        ? "no-env-gate"
        : row.requiredEnvSatisfied
          ? "env-set"
          : `missing:${row.missingEnv.join(",")}`;
    lines.push(
      `- [${row.category}] ${row.title} (${row.area})`,
      `    operator-approval=${row.operatorApprovalNeeded ? "yes" : "no"} approval=${row.approval} env=${envState}`,
      `    verify: ${row.verifyCommand}`
    );
  }
  return lines.join("\n");
}
