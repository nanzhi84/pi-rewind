/**
 * Prompt-oriented rewind list (Claude Code style).
 *
 * Each item means "rewind to just before this user prompt".
 * The restore target is the newest checkpoint at or before the prompt's
 * timestamp — i.e. the previous turn_end snapshot, or the session-start
 * snapshot when no turn has produced one yet.
 *
 * Pure functions with zero Pi/git dependencies so the mapping is testable
 * without a live session.
 */

export interface RewindCheckpoint {
  id: string;
  timestamp: number;
  description?: string;
}

export interface RewindSessionEntry {
  id: string;
  type: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

export interface PromptRewindItem {
  entryId: string;
  prompt: string;
  promptTimestamp: number;
  checkpoint: RewindCheckpoint;
  /** Number of checkpoints created after this prompt (undone by rewinding). */
  revertedSnapshotCount: number;
}

function extractPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part && typeof part === "object" &&
          (part as any).type === "text" && typeof (part as any).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export function buildPromptRewindList(
  entries: RewindSessionEntry[],
  checkpoints: RewindCheckpoint[],
): PromptRewindItem[] {
  const sorted = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp);
  const items: PromptRewindItem[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    if (!entry.timestamp) continue;
    const promptTimestamp = new Date(entry.timestamp).getTime();
    if (Number.isNaN(promptTimestamp)) continue;

    // Newest checkpoint at or before this prompt = state before the prompt ran.
    let target: RewindCheckpoint | undefined;
    for (const cp of sorted) {
      if (cp.timestamp <= promptTimestamp) target = cp;
      else break;
    }
    if (!target) continue;

    items.push({
      entryId: entry.id,
      prompt: extractPromptText(entry.message.content),
      promptTimestamp,
      checkpoint: target,
      revertedSnapshotCount: sorted.filter((cp) => cp.timestamp > promptTimestamp).length,
    });
  }

  return items.sort((a, b) => b.promptTimestamp - a.promptTimestamp);
}
