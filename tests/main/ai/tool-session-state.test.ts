import { describe, expect, it } from "vitest";
import {
  appendToolStateMarker,
  buildToolStateNote,
  clearToolSessionState,
  clearToolSessionsForSession,
  getToolSessionState,
  MAX_NOTE_SEQS,
  hydrateToolSessionFromHistory,
  recordToolSessionActivity,
} from "../../../src/main/ai/tool-session-state";
import { stripToolContext } from "../../../src/shared/types";

describe("tool session state", () => {
  it("records fetched seqs without embedding bodies", () => {
    clearToolSessionState("s1", "r1");
    recordToolSessionActivity("s1", "r1", [1, 5], "[get_request_detail](seqs=1,5)");
    recordToolSessionActivity("s1", "r1", [5, 9], "[get_request_detail](seqs=5,9)");
    const snap = getToolSessionState("s1", "r1");
    expect(snap.fetchedSeqs).toEqual([1, 5, 9]);
    const note = buildToolStateNote(snap);
    expect(note).toContain("#1");
    expect(note).toContain("#9");
    expect(note).not.toContain("password");
  });

  it("caps the seq list in the note, which goes into every follow-up prompt", () => {
    clearToolSessionState("s-cap", "r1");
    const seqs = Array.from({ length: 500 }, (_, i) => i + 1);
    recordToolSessionActivity("s-cap", "r1", seqs, "[get_request_detail](seqs=1)");

    const note = buildToolStateNote(getToolSessionState("s-cap", "r1"))!;
    const listed = note.match(/#\d+/g) ?? [];

    expect(listed).toHaveLength(MAX_NOTE_SEQS);
    expect(note).toContain("共 500 条");
    // 存的仍然是全量，只是不全铺进提示词
    expect(getToolSessionState("s-cap", "r1").fetchedSeqs).toHaveLength(500);
    expect(note).toContain("#500");
  });

  it("drops every report's state for a session when its capture data is cleared", () => {
    recordToolSessionActivity("s-clear", "r1", [1], "[get_request_detail](seqs=1)");
    recordToolSessionActivity("s-clear", "r2", [2], "[get_request_detail](seqs=2)");
    recordToolSessionActivity("s-keep", "r3", [3], "[get_request_detail](seqs=3)");

    clearToolSessionsForSession("s-clear");

    expect(getToolSessionState("s-clear", "r1").fetchedSeqs).toEqual([]);
    expect(getToolSessionState("s-clear", "r2").fetchedSeqs).toEqual([]);
    expect(getToolSessionState("s-keep", "r3").fetchedSeqs).toEqual([3]);
  });

  it("persists compact tool_state marker and strips for display", () => {
    clearToolSessionState("s2", "r2");
    recordToolSessionActivity("s2", "r2", [3], "[get_request_detail](seqs=3)");
    const content = appendToolStateMarker("分析完成", getToolSessionState("s2", "r2"));
    expect(content).toContain("<tool_state>");
    expect(content).toContain('"fetchedSeqs":[3]');
    expect(stripToolContext(content)).toBe("分析完成");
  });

  it("hydrates from legacy tool_context and tool_state history", () => {
    clearToolSessionState("s3", "r3");
    const snap = hydrateToolSessionFromHistory("s3", "r3", [
      {
        role: "assistant",
        content: "old\n\n<tool_context>\n[get_request_detail](seqs=7)\n#7 POST /login\n</tool_context>",
      },
      {
        role: "assistant",
        content: 'new\n\n<tool_state>{"fetchedSeqs":[8,7],"recentRefs":["[list_requests](matched=2)"]}</tool_state>',
      },
    ]);
    expect(snap.fetchedSeqs).toEqual([7, 8]);
    expect(snap.recentRefs.some((r) => r.includes("list_requests"))).toBe(true);
  });
});
