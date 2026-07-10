export type TNeonCoreLayerId =
  | "runtime"
  | "gateway"
  | "mission-control"
  | "memory"
  | "agents"
  | "skills"
  | "doctor";

export interface INeonCoreLayer {
  readonly id: TNeonCoreLayerId;
  readonly name: string;
  readonly purpose: string;
  readonly referenceImplementation: string;
  readonly firstAcceptance: string;
}

export const neonCoreLayers: readonly INeonCoreLayer[] = [
  {
    id: "runtime",
    name: "Neon Core",
    purpose: "Agent runs, policy, sessions, tasks, tools, and memory context.",
    referenceImplementation: "Gateway runtime and agent execution loop.",
    firstAcceptance: "CLI status renders the architecture manifest."
  },
  {
    id: "gateway",
    name: "Neon Gateway",
    purpose: "Channel ingress, device pairing, routing, allowlists, and delivery.",
    referenceImplementation: "upstream gateway and channel providers.",
    firstAcceptance: "Gateway status API returns live Discord configuration."
  },
  {
    id: "mission-control",
    name: "Neon Mission Control",
    purpose: "Operator dashboard for runs, channels, agents, skills, and doctor state.",
    referenceImplementation: "upstream local dashboard.",
    firstAcceptance: "Dashboard reads live Gateway status."
  },
  {
    id: "memory",
    name: "Neon Memory",
    purpose: "Targeted identity, recall, project context, and run metadata.",
    referenceImplementation: "Session context and memory hooks.",
    firstAcceptance: "Agent run metadata records memory attached, skipped, or failed."
  },
  {
    id: "agents",
    name: "Neon Agents",
    purpose: "Neo, Chaty, Rex, Nova, Forge, Sentinel, and role-based workers.",
    referenceImplementation: "Agent session routing.",
    firstAcceptance: "Run routing includes selected agent and workspace."
  },
  {
    id: "skills",
    name: "Neon Skills",
    purpose: "Repeatable workflows, local commands, and trusted extensions.",
    referenceImplementation: "Skills and plugins.",
    firstAcceptance: "Skills can be listed with trust metadata."
  },
  {
    id: "doctor",
    name: "Neon Doctor",
    purpose: "Health, auth, channel, memory, worker, security, and repair checks.",
    referenceImplementation: "Doctor and security audit flows.",
    firstAcceptance: "Doctor reports config health without printing secrets."
  }
];

export function getLayerById(id: TNeonCoreLayerId): INeonCoreLayer {
  const layer = neonCoreLayers.find((candidate) => candidate.id === id);

  if (!layer) {
    throw new Error(`Unknown Neon Core layer: ${id}`);
  }

  return layer;
}

export function renderProductManifest(): string {
  const layerLines = neonCoreLayers
    .map((layer) => `- ${layer.name}: ${layer.purpose}`)
    .join("\n");

  return `Neon Core\n\n${layerLines}`;
}
