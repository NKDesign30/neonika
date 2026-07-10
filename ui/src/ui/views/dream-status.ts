export interface DreamStatusInput {
  readonly phase?: string;
  readonly reflectionEnabled?: boolean;
  readonly lastReflectionAt?: string | null;
}

export function phaseLabelForDream(input: DreamStatusInput): string {
  return `Phase ${input.phase ?? "unbekannt"}`;
}

export function reflectionLabelForDream(input: DreamStatusInput): string {
  return input.reflectionEnabled ? "Reflexion an" : "Reflexion aus";
}

export function lastReflectionLabelForDream(input: DreamStatusInput): string {
  return `Letzte Reflexion: ${input.lastReflectionAt ?? "nie"}`;
}
