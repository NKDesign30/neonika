import { readNeonSetupConfig, resolveNeonSetupPaths } from "../onboarding/neonSetup.js";
import { inspectNeonWhatsAppAuthState, type TNeonWhatsAppAuthReason } from "./whatsappAuth.js";

export type TNeonWhatsAppStatusState =
  | "disabled"
  | "needs-config"
  | "login-required"
  | "unsafe"
  | "ready";

export interface INeonWhatsAppStatusSnapshot {
  readonly state: TNeonWhatsAppStatusState;
  readonly configured: boolean;
  readonly ownerLinked: boolean;
  readonly authReason: TNeonWhatsAppAuthReason;
  readonly inbound: "disabled" | "ready";
  readonly groups: "disabled";
  readonly outbound: "suppressed";
}

export async function createNeonWhatsAppStatusSnapshot(
  configRoot?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<INeonWhatsAppStatusSnapshot> {
  const config = await readNeonSetupConfig(configRoot, env);
  const configured = config?.channels.whatsapp.enabled === true;
  const ownerLinked = config?.channels.whatsapp.ownerPeerId !== undefined;
  const paths = resolveNeonSetupPaths(configRoot, env);
  const auth = await inspectNeonWhatsAppAuthState(paths.whatsappAuthPath);
  const state: TNeonWhatsAppStatusState = !configured
    ? "disabled"
    : !ownerLinked
      ? "needs-config"
      : auth.state === "invalid"
        ? "unsafe"
        : auth.state === "missing"
          ? "login-required"
          : "ready";

  return {
    state,
    configured,
    ownerLinked,
    authReason: auth.reason,
    inbound: state === "ready" ? "ready" : "disabled",
    groups: "disabled",
    outbound: "suppressed"
  };
}

export function renderNeonWhatsAppStatusReport(
  snapshot: INeonWhatsAppStatusSnapshot
): string {
  return [
    `WhatsApp companion: ${snapshot.state}`,
    `Configured: ${snapshot.configured ? "yes" : "no"}`,
    `Owner linked: ${snapshot.ownerLinked ? "yes" : "no"}`,
    `Auth evidence: ${snapshot.authReason}`,
    `Inbound shadow tap: ${snapshot.inbound}`,
    `Groups: ${snapshot.groups}`,
    `Outbound agent messages: ${snapshot.outbound}`
  ].join("\n");
}
