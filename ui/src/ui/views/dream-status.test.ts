import { describe, expect, it } from "vitest";

import {
  lastReflectionLabelForDream,
  phaseLabelForDream,
  reflectionLabelForDream
} from "./dream-status.js";

describe("dream status labels", () => {
  it("surfaces phase and disabled reflection in operator copy", () => {
    const dream = {
      phase: "off",
      reflectionEnabled: false,
      lastReflectionAt: null
    };

    expect(phaseLabelForDream(dream)).toBe("Phase off");
    expect(reflectionLabelForDream(dream)).toBe("Reflexion aus");
    expect(lastReflectionLabelForDream(dream)).toBe("Letzte Reflexion: nie");
  });

  it("surfaces armed reflection and last reflection time", () => {
    const dream = {
      phase: "deep",
      reflectionEnabled: true,
      lastReflectionAt: "2026-06-02T12:00:00.000Z"
    };

    expect(phaseLabelForDream(dream)).toBe("Phase deep");
    expect(reflectionLabelForDream(dream)).toBe("Reflexion an");
    expect(lastReflectionLabelForDream(dream)).toBe("Letzte Reflexion: 2026-06-02T12:00:00.000Z");
  });
});
