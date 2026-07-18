import { describe, expect, it } from "vitest";
import {
  ALL_TABS,
  DEFAULT_TAB,
  isMissionControlLocation,
  isTab,
  missionControlPath,
  tabFromHash,
  tabFromLocation,
  tabFromMissionControlPath,
  titleForTab,
} from "./navigation.js";

describe("isTab", () => {
  it("accepts every known tab and rejects unknown values", () => {
    for (const tab of ALL_TABS) {
      expect(isTab(tab)).toBe(true);
    }
    expect(isTab("bogus")).toBe(false);
    expect(isTab("")).toBe(false);
  });
});

describe("tabFromHash", () => {
  it("reads the view from the hash, defaulting to overview", () => {
    expect(tabFromHash("#overview")).toBe("overview");
    expect(tabFromHash("#skills")).toBe("skills");
    expect(tabFromHash("#CHAT")).toBe("chat");
    expect(tabFromHash("")).toBe(DEFAULT_TAB);
    expect(tabFromHash("#nope")).toBe(DEFAULT_TAB);
  });
});

describe("tabFromMissionControlPath", () => {
  it("extracts the view from a /mission-control/<view> path", () => {
    expect(tabFromMissionControlPath("/mission-control/overview")).toBe("overview");
    expect(tabFromMissionControlPath("/mission-control/chat")).toBe("chat");
    expect(tabFromMissionControlPath("/mission-control/skills/")).toBe("skills");
    expect(tabFromMissionControlPath("/mission-control/logs")).toBe("logs");
  });

  it("returns undefined for non-view and non-mission-control paths", () => {
    expect(tabFromMissionControlPath("/mission-control")).toBeUndefined();
    expect(tabFromMissionControlPath("/mission-control/")).toBeUndefined();
    expect(tabFromMissionControlPath("/mission-control/bogus")).toBeUndefined();
    expect(tabFromMissionControlPath("/control-ui/")).toBeUndefined();
    expect(tabFromMissionControlPath("/")).toBeUndefined();
  });
});

describe("tabFromLocation", () => {
  it("prefers the mission-control path over the hash", () => {
    expect(tabFromLocation("/mission-control/usage", "#chat")).toBe("usage");
  });

  it("falls back to the hash in standalone dev", () => {
    expect(tabFromLocation("/control-ui/", "#sessions")).toBe("sessions");
    expect(tabFromLocation("/control-ui/", "")).toBe(DEFAULT_TAB);
  });
});

describe("missionControlPath / isMissionControlLocation", () => {
  it("builds the canonical path for a tab", () => {
    expect(missionControlPath("overview")).toBe("/mission-control/overview");
    expect(missionControlPath("chat")).toBe("/mission-control/chat");
  });

  it("detects mission-control locations only", () => {
    expect(isMissionControlLocation("/mission-control")).toBe(true);
    expect(isMissionControlLocation("/mission-control/chat")).toBe(true);
    expect(isMissionControlLocation("/control-ui/")).toBe(false);
    expect(isMissionControlLocation("/")).toBe(false);
  });
});

describe("titleForTab", () => {
  it("returns a title for every tab", () => {
    for (const tab of ALL_TABS) {
      expect(titleForTab(tab).length).toBeGreaterThan(0);
    }
  });
});
