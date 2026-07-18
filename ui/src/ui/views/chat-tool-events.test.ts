import { describe, expect, it } from "vitest";

import {
  iconForChatToolEvent,
  labelForChatToolEvent,
  visibleChatToolEvents,
  type ChatToolEvent
} from "./chat-tool-events.js";

describe("chat tool events", () => {
  it("maps tool event status and kind into compact UI metadata", () => {
    const event: ChatToolEvent = {
      kind: "command-exit",
      status: "error",
      title: "Command exit",
      summary: "npm test exited 1.",
      exitCode: 1
    };

    expect(iconForChatToolEvent(event)).toBe("alertTriangle");
    expect(labelForChatToolEvent(event)).toBe("Exit · Fehler");
  });

  it("bounds visible tool cards without mutating the source list", () => {
    const events = Array.from({ length: 8 }, (_, index): ChatToolEvent => ({
      kind: "tool-output",
      status: "done",
      title: `Tool ${index}`,
      summary: "returned output",
      sequence: index
    }));

    expect(visibleChatToolEvents(events)).toHaveLength(6);
    expect(events).toHaveLength(8);
  });
});
