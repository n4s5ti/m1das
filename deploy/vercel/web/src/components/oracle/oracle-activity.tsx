import { useAuiState } from "@assistant-ui/react";
import type { PropsWithChildren } from "react";
import { SubagentList, type SubagentItem } from "@/components/assistant-ui/elements/subagent-list";
import { Timeline, type TimelineEvent } from "@/components/assistant-ui/elements/timeline";
import type { ThreadGroupPart } from "@/components/assistant-ui/elements/thread.aui";

// The tool calls of Oracle's run for a message, as /api/chat reports them: only each tool's name, when it ran,
// whether it failed, and for a child the task tool started, its title and model. A run of consecutive calls
// shows as a Timeline; the children it started show as a Subagent list. Children keep working after the
// answer, and their results come back to Oracle later, so the list shows them as started.

const LABELS: Record<string, string> = {
  read: "Read a file",
  write: "Wrote a file",
  edit: "Edited a file",
  bash: "Ran a command",
  grep: "Searched files",
  find: "Found files",
  ls: "Listed a folder",
  send: "Sent a message",
  react: "Reacted to a message",
  call: "Called a channel action",
  screen: "Used the screen",
  task: "Managed children",
  codemode: "Ran a script",
};

type ToolPart = {
  toolCallId: string;
  toolName: string;
  args: { at?: number; title?: string; model?: string };
  result?: { at?: number; ms?: number } | undefined;
  isError?: boolean | undefined;
};

const time = (at: number | undefined) =>
  at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

const duration = (ms: number | undefined) => (ms === undefined ? undefined : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function event(part: ToolPart): TimelineEvent {
  const running = part.result === undefined && !part.isError;
  const child = part.toolName === "task" && part.args.title;
  return {
    id: part.toolCallId,
    when: running ? "now" : "past",
    time: time(part.args.at),
    title: child ? `Started a child: ${part.args.title}` : (LABELS[part.toolName] ?? part.toolName),
    detail: part.isError ? "Failed" : running ? "Running" : duration(part.result?.ms),
  };
}

export function OracleActivity({ group }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const parts = useAuiState((s) => s.message.parts);
  const calls = group.indices.flatMap((index): ToolPart[] => {
    const part = parts[index];
    if (part?.type !== "tool-call") return [];
    return [{ toolCallId: part.toolCallId, toolName: part.toolName, args: part.args as ToolPart["args"], result: part.result as ToolPart["result"], isError: part.isError }];
  });
  const children: SubagentItem[] = calls
    .filter((part) => part.toolName === "task" && part.args.title && part.result !== undefined && !part.isError)
    .map((part) => ({ name: part.args.title!, model: part.args.model ?? "Oracle's model" }));
  const events = calls.map(event);

  return (
    <div className="my-3 flex flex-col gap-3">
      <Timeline events={events} visibleCount={events.length} />
      {children.length > 0 && (
        <SubagentList agents={children} completedCount={0} progress={children.map(() => 0)} showSummary={false} summaryAgent={children[0]!} />
      )}
    </div>
  );
}
