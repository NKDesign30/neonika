import {
  classifyOnePasswordSecretRef,
  resolveSecretInputStatus
} from "./secretRefs.js";

/**
 * Read-only Secrets-Audit für Neon Core.
 *
 * Prüft credential-tragende Felder (per Default die bekannten Neon-Secret-Env-
 * Variablen) auf zwei Findings:
 *   - PLAINTEXT: ein nicht-leerer Wert, der KEIN `op://`-Ref ist (sollte als
 *     1Password-Referenz gespeichert werden, nicht im Klartext).
 *   - REF_UNRESOLVED: ein `op://`-Ref, dessen Struktur nicht auflösbar ist
 *     (incomplete/malformed) — strukturell geprüft, OHNE `op` aufzurufen.
 *
 * Komplett read-only: kein `op resolve`, kein Netz, kein Schreibzugriff. Der
 * Report enthält NIE einen Secret-Wert — nur Feld-Label, Finding-Code und einen
 * leak-sicheren Hinweistext.
 *
 * Vorlage: upstream `src/secrets/audit.ts` (`runSecretsAudit`,
 * `SecretsAuditReport`, `resolveSecretsAuditExitCode`). Bewusst auf die zwei
 * lokal entscheidbaren Codes reduziert; REF_SHADOWED (gleicher Key in mehreren
 * Stores) und LEGACY_RESIDUE (alte auth.json-Reste) brauchen mehrere Config-
 * Stores, die Neon Core im Shadow-Stand nicht führt — siehe Hinweis in der
 * Gap-MD.
 */
export type TNeonSecretsAuditCode = "PLAINTEXT" | "REF_UNRESOLVED";

export interface INeonSecretsAuditFinding {
  readonly code: TNeonSecretsAuditCode;
  readonly field: string;
  readonly detail: string;
}

export type TNeonSecretsAuditExitCode = 0 | 1 | 2;

export interface INeonSecretsAuditReport {
  readonly findings: readonly INeonSecretsAuditFinding[];
  readonly scannedFields: number;
  readonly cleanFields: number;
  readonly exitCode: TNeonSecretsAuditExitCode;
}

export interface INeonSecretsAuditInput {
  /**
   * Credential-Felder als `{ Feld-Label: Roh-Wert }`. Der Caller sammelt sie
   * (z.B. via `collectNeonSecretAuditFields`); der Audit liest sie nur.
   */
  readonly fields: Readonly<Record<string, string | undefined>>;
}

/**
 * Bekannte Neon-Secret-Env-Variablen. `NEON_PAIR_PUBLIC_KEY` ist bewusst NICHT
 * dabei: ein Public Key ist kein Geheimnis und würde sonst als PLAINTEXT
 * false-positiv gemeldet.
 */
export const neonSecretAuditEnvKeys: readonly string[] = [
  "NEON_DISCORD_BOT_TOKEN",
  "NEON_GATEWAY_HTTP_MUTATION_TOKEN",
  "NEON_NODE_SESSION_SECRET",
  "NEON_REPLAY_SESSION_KEY",
  "NEON_SECRET"
];

/**
 * Sammelt die bekannten Neon-Secret-Felder aus der Umgebung (Default
 * `process.env`). Read-only — liest nur die Werte, gibt sie an den Audit weiter.
 */
export function collectNeonSecretAuditFields(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {};

  for (const key of neonSecretAuditEnvKeys) {
    fields[key] = env[key];
  }

  return fields;
}

export function runNeonSecretsAudit(input: INeonSecretsAuditInput): INeonSecretsAuditReport {
  const findings: INeonSecretsAuditFinding[] = [];
  let scannedFields = 0;

  for (const field of Object.keys(input.fields).sort()) {
    const value = input.fields[field];
    const status = resolveSecretInputStatus(value);

    if (status === "missing") {
      continue;
    }

    scannedFields += 1;

    if (status === "value") {
      findings.push({
        code: "PLAINTEXT",
        field,
        detail: "plaintext credential value; store an op:// reference instead"
      });
      continue;
    }

    // status === "ref": value is a non-empty op:// string here.
    const reachability = value === undefined ? null : classifyOnePasswordSecretRef(value);
    if (reachability !== null && reachability !== "resolvable") {
      findings.push({
        code: "REF_UNRESOLVED",
        field,
        detail: `op:// reference is ${reachability}`
      });
    }
  }

  return {
    findings,
    scannedFields,
    cleanFields: scannedFields - findings.length,
    exitCode: resolveNeonSecretsAuditExitCode(findings)
  };
}

/**
 * Exit-Code-Konvention (Vorlage upstream `resolveSecretsAuditExitCode`):
 *   0 = clean, 2 = mindestens ein nicht auflösbarer op://-Ref, 1 = sonstige
 *   Findings (PLAINTEXT). Unresolved-Refs ranken über Plaintext, weil sie zur
 *   Laufzeit hart fehlschlagen würden.
 */
export function resolveNeonSecretsAuditExitCode(
  findings: readonly INeonSecretsAuditFinding[]
): TNeonSecretsAuditExitCode {
  if (findings.length === 0) {
    return 0;
  }

  if (findings.some((finding) => finding.code === "REF_UNRESOLVED")) {
    return 2;
  }

  return 1;
}

export function renderNeonSecretsAuditReport(report: INeonSecretsAuditReport): string {
  const lines: string[] = [];

  lines.push(`Neon Secrets Audit: ${report.findings.length === 0 ? "clean" : "findings"}`);
  lines.push(`Scanned fields: ${report.scannedFields}`);
  lines.push(`Clean fields: ${report.cleanFields}`);
  lines.push(`Exit code: ${report.exitCode}`);

  if (report.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of report.findings) {
      lines.push(`  [${finding.code}] ${finding.field}: ${finding.detail}`);
    }
  }

  return lines.join("\n");
}
