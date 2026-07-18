import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installNeonWhatsAppLibsignalLogGuard } from "../src/index.js";

describe("Neonika WhatsApp libsignal log guard", () => {
  it("suppresses only sensitive libsignal session lines and restores console", () => {
    const originalInfo = console.info;
    const originalError = console.error;
    const captured: unknown[][] = [];
    const capturedErrors: unknown[][] = [];
    console.info = (...values: readonly unknown[]): void => {
      captured.push([...values]);
    };
    console.error = (...values: readonly unknown[]): void => {
      capturedErrors.push([...values]);
    };
    const restore = installNeonWhatsAppLibsignalLogGuard();
    try {
      console.info("Opening session:", { privateKey: "must-not-log" });
      console.info("Opening session: public lifecycle marker");
      console.info("WhatsApp transport ready", { state: "open" });
      console.error("V1 session storage migration error: registrationId", 12345);
      console.error("WhatsApp transport failed", "network");

      assert.deepEqual(captured, [
        ["Opening session: public lifecycle marker"],
        ["WhatsApp transport ready", { state: "open" }]
      ]);
      assert.deepEqual(capturedErrors, [["WhatsApp transport failed", "network"]]);
    } finally {
      restore();
      assert.notEqual(console.info, originalInfo);
      console.info = originalInfo;
      console.error = originalError;
    }
  });
});
