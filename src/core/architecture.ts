export interface IArchitectureLayer {
  readonly name: string;
  readonly responsibilities: readonly string[];
  readonly sourceOfTruth: string;
}

export interface INeonikaArchitecture {
  readonly ingress: IArchitectureLayer;
  readonly gateway: IArchitectureLayer;
  readonly core: IArchitectureLayer;
  readonly controlPlane: IArchitectureLayer;
}

export const neonikaArchitecture: INeonikaArchitecture = {
  ingress: {
    name: "Discord / Telegram / WhatsApp / WebChat / CLI / Devices",
    responsibilities: [
      "Receive user and device input",
      "Normalize channel envelopes",
      "Preserve account, guild, channel, thread, and user identity"
    ],
    sourceOfTruth: "Neon Gateway adapters"
  },
  gateway: {
    name: "Neon Gateway",
    responsibilities: [
      "Pair channels and devices",
      "Apply allowlists and trust policies",
      "Route turns into Neonika",
      "Deliver preview and final replies"
    ],
    sourceOfTruth: "Gateway status API and delivery queue"
  },
  core: {
    name: "Neonika",
    responsibilities: [
      "Run agents",
      "Attach targeted Neon Memory",
      "Manage sessions, tasks, approvals, tools, and skills",
      "Expose runtime state for Mission Control"
    ],
    sourceOfTruth: "Neon run store and policy layer"
  },
  controlPlane: {
    name: "Neon Mission Control",
    responsibilities: [
      "Show live gateway, channel, run, memory, and doctor state",
      "Provide onboarding and repair flows",
      "Avoid fake dashboard state"
    ],
    sourceOfTruth: "Live Neonika APIs"
  }
};

export function renderArchitectureSummary(): string {
  const sections: readonly (readonly [string, IArchitectureLayer])[] = [
    ["Ingress", neonikaArchitecture.ingress],
    ["Gateway", neonikaArchitecture.gateway],
    ["Core", neonikaArchitecture.core],
    ["Mission Control", neonikaArchitecture.controlPlane]
  ];

  return sections
    .map(([title, layer]) => {
      const responsibilities = layer.responsibilities
        .map((responsibility) => `  - ${responsibility}`)
        .join("\n");

      return `${title}: ${layer.name}\n${responsibilities}\n  Source: ${layer.sourceOfTruth}`;
    })
    .join("\n\n");
}
