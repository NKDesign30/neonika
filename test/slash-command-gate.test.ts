import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonControlCommandGateReport,
  resolveNeonCommandAuthorized,
  resolveNeonControlCommandGate,
  resolveNeonDualTextControlCommandGate,
  type INeonCommandAuthorizer
} from "../src/index.js";

const configuredAllowed: INeonCommandAuthorizer = { configured: true, allowed: true };
const configuredDenied: INeonCommandAuthorizer = { configured: true, allowed: false };
const unconfigured: INeonCommandAuthorizer = { configured: false, allowed: false };

describe("Neon slash/control command gate (upstream command-gating parity)", () => {
  it("authorizes via access groups only on a configured+allowed authorizer", () => {
    assert.equal(
      resolveNeonCommandAuthorized({ useAccessGroups: true, authorizers: [configuredAllowed] }),
      true
    );
    assert.equal(
      resolveNeonCommandAuthorized({ useAccessGroups: true, authorizers: [configuredDenied] }),
      false
    );
    assert.equal(
      resolveNeonCommandAuthorized({ useAccessGroups: true, authorizers: [unconfigured] }),
      false
    );
  });

  it("applies modeWhenAccessGroupsOff when access groups are off", () => {
    const authorizers = [configuredDenied];
    assert.equal(
      resolveNeonCommandAuthorized({ useAccessGroups: false, authorizers, modeWhenAccessGroupsOff: "allow" }),
      true
    );
    assert.equal(
      resolveNeonCommandAuthorized({ useAccessGroups: false, authorizers, modeWhenAccessGroupsOff: "deny" }),
      false
    );
    // Default mode is allow.
    assert.equal(resolveNeonCommandAuthorized({ useAccessGroups: false, authorizers: [] }), true);
  });

  it("treats an unconfigured set as open in configured mode, else needs allow", () => {
    assert.equal(
      resolveNeonCommandAuthorized({
        useAccessGroups: false,
        authorizers: [unconfigured],
        modeWhenAccessGroupsOff: "configured"
      }),
      true
    );
    assert.equal(
      resolveNeonCommandAuthorized({
        useAccessGroups: false,
        authorizers: [configuredDenied],
        modeWhenAccessGroupsOff: "configured"
      }),
      false
    );
    assert.equal(
      resolveNeonCommandAuthorized({
        useAccessGroups: false,
        authorizers: [configuredAllowed],
        modeWhenAccessGroupsOff: "configured"
      }),
      true
    );
  });

  it("blocks a control command only when allowed text commands meet an unauthorized user", () => {
    const blocked = resolveNeonControlCommandGate({
      useAccessGroups: true,
      authorizers: [configuredDenied],
      allowTextCommands: true,
      hasControlCommand: true
    });
    assert.equal(blocked.commandAuthorized, false);
    assert.equal(blocked.shouldBlock, true);

    // Authorized user is never blocked.
    const allowed = resolveNeonControlCommandGate({
      useAccessGroups: true,
      authorizers: [configuredAllowed],
      allowTextCommands: true,
      hasControlCommand: true
    });
    assert.equal(allowed.shouldBlock, false);

    // No control command in the message -> never blocked.
    const noCommand = resolveNeonControlCommandGate({
      useAccessGroups: true,
      authorizers: [configuredDenied],
      allowTextCommands: true,
      hasControlCommand: false
    });
    assert.equal(noCommand.shouldBlock, false);

    // Text commands disabled -> never blocked here.
    const textOff = resolveNeonControlCommandGate({
      useAccessGroups: true,
      authorizers: [configuredDenied],
      allowTextCommands: false,
      hasControlCommand: true
    });
    assert.equal(textOff.shouldBlock, false);
  });

  it("renders a readable gate report", () => {
    const report = renderNeonControlCommandGateReport({ commandAuthorized: false, shouldBlock: true });
    assert.match(report, /Command authorized: false/);
    assert.match(report, /Should block: true/);
  });

  it("supports the upstream dual-authorizer text command gate helper", () => {
    const allowed = resolveNeonDualTextControlCommandGate({
      useAccessGroups: true,
      primaryConfigured: true,
      primaryAllowed: false,
      secondaryConfigured: true,
      secondaryAllowed: true,
      hasControlCommand: true
    });

    assert.equal(allowed.commandAuthorized, true);
    assert.equal(allowed.shouldBlock, false);

    const blocked = resolveNeonDualTextControlCommandGate({
      useAccessGroups: true,
      primaryConfigured: true,
      primaryAllowed: false,
      secondaryConfigured: true,
      secondaryAllowed: false,
      hasControlCommand: true
    });

    assert.equal(blocked.commandAuthorized, false);
    assert.equal(blocked.shouldBlock, true);
  });
});
