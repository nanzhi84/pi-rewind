import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptRewindList } from "../src/prompts.ts";

const T0 = "2024-12-03T14:00:00.000Z";
const T1 = "2024-12-03T14:00:01.000Z";
const T2 = "2024-12-03T14:00:02.000Z";
const T3 = "2024-12-03T14:00:03.000Z";
const T4 = "2024-12-03T14:00:04.000Z";

function userEntry(id: string, timestamp: string | undefined, content: unknown) {
  return {
    type: "message",
    id,
    parentId: null,
    ...(timestamp === undefined ? {} : { timestamp }),
    message: {
      role: "user",
      content,
      ...(timestamp === undefined ? {} : { timestamp: Date.parse(timestamp) }),
    },
  };
}

function messageEntry(id: string, role: string, timestamp: string, content: unknown) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role, content, timestamp: Date.parse(timestamp) },
  };
}

function checkpoint(id: string, timestamp: string, description?: string) {
  return { id, timestamp: Date.parse(timestamp), ...(description ? { description } : {}) };
}

describe("TestPromptRewindList", () => {
  it("test_only_valid_user_message_entries_are_included", () => {
    const sessionStart = checkpoint("cp-start", T0, "session start");
    const entries = [
      userEntry("valid-user", T1, "Keep this prompt"),
      messageEntry("assistant", "assistant", T1, "Assistant response"),
      messageEntry("tool-result", "toolResult", T1, "Tool output"),
      { type: "toolResult", id: "tool-entry", parentId: null, timestamp: T1, output: "Tool output" },
      { type: "label", id: "label", parentId: null, timestamp: T1, label: "A label" },
      { type: "compaction", id: "compaction", parentId: null, timestamp: T1, summary: "Compacted" },
      { type: "custom", id: "wrong-type", parentId: null, timestamp: T1, message: { role: "user", content: "Ignore" } },
      userEntry("missing-timestamp", undefined, "Ignore"),
      userEntry("invalid-timestamp", "not-a-date", "Ignore"),
    ];

    const result = buildPromptRewindList(entries, [sessionStart]);

    assert.deepEqual(result, [
      {
        entryId: "valid-user",
        prompt: "Keep this prompt",
        promptTimestamp: Date.parse(T1),
        checkpoint: sessionStart,
        revertedSnapshotCount: 0,
      },
    ]);
  });

  it("test_string_content_is_preserved_exactly", () => {
    const sessionStart = checkpoint("cp-start", T0);
    const prompt = "  Keep whitespace\nand punctuation!  ";

    const result = buildPromptRewindList([userEntry("user-1", T1, prompt)], [sessionStart]);

    assert.equal(result.length, 1);
    assert.equal(result[0].prompt, prompt);
  });

  it("test_text_parts_are_joined_and_non_text_parts_are_ignored", () => {
    const sessionStart = checkpoint("cp-start", T0);
    const content = [
      { type: "text", text: "Inspect the diff" },
      { type: "image", data: "base64-data", mimeType: "image/png" },
      { type: "text", text: "Then summarize the changes" },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ];

    const result = buildPromptRewindList([userEntry("user-1", T1, content)], [sessionStart]);

    assert.equal(result.length, 1);
    assert.equal(result[0].prompt, "Inspect the diff\nThen summarize the changes");
  });

  it("test_unsupported_content_produces_an_empty_prompt", () => {
    const sessionStart = checkpoint("cp-start", T0);

    const result = buildPromptRewindList(
      [userEntry("user-1", T1, { text: "This is not a top-level string" })],
      [sessionStart],
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].prompt, "");
  });

  it("test_multiple_later_checkpoints_do_not_change_the_restore_target", () => {
    const sessionStart = checkpoint("cp-start", T0);
    const previousTurnEnd = checkpoint("cp-previous-turn", T1, "previous turn end");
    const laterWrite = checkpoint("cp-later-write", T3, "later write");
    const laterEdit = checkpoint("cp-later-edit", T4, "later edit");

    const result = buildPromptRewindList(
      [userEntry("user-1", T2, "Start the next change")],
      [sessionStart, previousTurnEnd, laterWrite, laterEdit],
    );

    assert.deepEqual(result, [
      {
        entryId: "user-1",
        prompt: "Start the next change",
        promptTimestamp: Date.parse(T2),
        checkpoint: previousTurnEnd,
        revertedSnapshotCount: 2,
      },
    ]);
  });

  it("test_unordered_checkpoints_still_select_the_latest_prior_snapshot", () => {
    const sessionStart = checkpoint("cp-start", T0);
    const firstTurnEnd = checkpoint("cp-first-turn", T1);
    const latestPrior = checkpoint("cp-latest-prior", T2);
    const laterCheckpoint = checkpoint("cp-later", T4);

    const result = buildPromptRewindList(
      [userEntry("user-1", T3, "Choose the nearest earlier snapshot")],
      [laterCheckpoint, latestPrior, sessionStart, firstTurnEnd],
    );

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].checkpoint, latestPrior);
    assert.equal(result[0].revertedSnapshotCount, 1);
  });

  it("test_prompt_without_any_prior_checkpoint_is_excluded", () => {
    const middleCheckpoint = checkpoint("cp-middle", T2);
    const laterCheckpoint = checkpoint("cp-later", T4);
    const entries = [
      userEntry("too-early", T1, "There is no snapshot before this prompt"),
      userEntry("restorable", T3, "This prompt has a prior snapshot"),
    ];

    const result = buildPromptRewindList(entries, [middleCheckpoint, laterCheckpoint]);

    assert.deepEqual(result, [
      {
        entryId: "restorable",
        prompt: "This prompt has a prior snapshot",
        promptTimestamp: Date.parse(T3),
        checkpoint: middleCheckpoint,
        revertedSnapshotCount: 1,
      },
    ]);
  });

  it("test_prompts_are_returned_newest_first", () => {
    const sessionStart = checkpoint("cp-start", T0);
    const middleCheckpoint = checkpoint("cp-middle", T2);
    const entries = [
      userEntry("oldest", T1, "Oldest prompt"),
      userEntry("newest", T4, "Newest prompt"),
      userEntry("middle", T3, "Middle prompt"),
    ];

    const result = buildPromptRewindList(entries, [sessionStart, middleCheckpoint]);

    assert.deepEqual(
      result.map(({ entryId, promptTimestamp }) => ({ entryId, promptTimestamp })),
      [
        { entryId: "newest", promptTimestamp: Date.parse(T4) },
        { entryId: "middle", promptTimestamp: Date.parse(T3) },
        { entryId: "oldest", promptTimestamp: Date.parse(T1) },
      ],
    );
  });

  it("test_equal_timestamp_is_restorable_and_not_counted_as_reverted", () => {
    const sessionStart = checkpoint("cp-start", T0);
    const sameTime = checkpoint("cp-same-time", T1);
    const laterOne = checkpoint("cp-later-one", T2);
    const laterTwo = checkpoint("cp-later-two", T3);

    const result = buildPromptRewindList(
      [userEntry("user-1", T1, "A snapshot exists at exactly this time")],
      [sessionStart, sameTime, laterOne, laterTwo],
    );

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].checkpoint, sameTime);
    assert.equal(result[0].revertedSnapshotCount, 2);
  });
});
