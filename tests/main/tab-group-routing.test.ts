import { describe, expect, it } from "vitest";
import { resolveOwnedTabMap } from "../../src/main/tab-group-routing";

interface TestTab {
  id: string;
}

describe("popup Session group routing", () => {
  it("creates and closes a Session A popup without touching visible Session B", () => {
    const sessionATabs = new Map<string, TestTab>([
      ["a-opener", { id: "a-opener" }],
    ]);
    const sessionBTabs = new Map<string, TestTab>([
      ["b-active", { id: "b-active" }],
    ]);
    const storedGroups = new Map([
      ["session-a", { tabs: sessionATabs }],
    ]);

    const popupOwner = resolveOwnedTabMap(
      "session-a",
      "session-b",
      sessionBTabs,
      storedGroups,
    );
    expect(popupOwner?.isCurrent).toBe(false);

    popupOwner?.tabs.set("a-popup", { id: "a-popup" });
    expect([...sessionATabs.keys()]).toEqual(["a-opener", "a-popup"]);
    expect([...sessionBTabs.keys()]).toEqual(["b-active"]);

    popupOwner?.tabs.delete("a-popup");
    expect([...sessionATabs.keys()]).toEqual(["a-opener"]);
    expect([...sessionBTabs.keys()]).toEqual(["b-active"]);
  });

  it("does not resurrect a deleted owner group", () => {
    const route = resolveOwnedTabMap(
      "deleted-session",
      "current-session",
      new Map<string, TestTab>(),
      new Map<string, { tabs: Map<string, TestTab> }>(),
    );
    expect(route).toBeNull();
  });
});
