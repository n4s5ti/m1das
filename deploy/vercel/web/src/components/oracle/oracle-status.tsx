import { useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { AgentStatus, type AgentState } from "@/components/assistant-ui/elements/agent-status";

// The Agent status element for the request this page has in flight: working while Oracle's answer
// is on its way, then whether it came or failed. It knows nothing about work Oracle does elsewhere.

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function OracleStatus() {
  const running = useAuiState((s) => s.thread.isRunning);
  const failed = useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    return last?.role === "assistant" && last.status?.type === "incomplete" && last.status.reason === "error";
  });
  const asked = useAuiState((s) => s.thread.messages.length > 0);
  const started = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return undefined;
    started.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started.current), 500);
    return () => clearInterval(timer);
  }, [running]);

  if (!asked) return null;
  const state: AgentState = running ? "working" : failed ? "failed" : "done";
  const label = running ? "Oracle is answering" : failed ? "The answer did not come" : `Answered in ${clock(elapsed)}`;
  return <AgentStatus state={state} label={label} elapsed={running ? clock(elapsed) : undefined} />;
}
