import { AuiIf, ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import {
  Composer,
  ComposerActions,
  ComposerBar,
  ComposerSend,
  ComposerToolbar,
  ComposerVoice,
  ComposerVoiceButton,
} from "@/components/assistant-ui/elements/composer";

// The Composer element, with only what Oracle's chat can do: text, voice input through the browser's
// speech recognition, send, and stop. Attachments, models, mentions and commands have nothing behind them.

/** Whole seconds since dictation started, while it runs. */
function useDictationSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

export function OracleComposer({ autoFocus }: { autoFocus: boolean }) {
  const dictating = useAuiState((s) => s.composer.dictation != null);
  const empty = useAuiState((s) => s.composer.isEmpty);
  const seconds = useDictationSeconds(dictating);

  return (
    <Composer className="max-w-(--thread-max-width)">
      <ComposerPrimitive.Root>
        <ComposerBar>
          {dictating && <ComposerVoice recording seconds={seconds} />}
          <ComposerPrimitive.Input
            placeholder="Message Oracle..."
            rows={1}
            autoFocus={autoFocus}
            enterKeyHint="send"
            aria-label="Message input"
            className={dictating ? "sr-only" : "placeholder:text-muted-foreground max-h-48 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 outline-none"}
          />
          <ComposerToolbar className="justify-end">
            <ComposerActions>
              <AuiIf condition={(s) => s.thread.capabilities.dictation}>
                <AuiIf condition={(s) => s.composer.dictation == null}>
                  <ComposerPrimitive.Dictate render={<ComposerVoiceButton active={false} />} />
                </AuiIf>
                <AuiIf condition={(s) => s.composer.dictation != null}>
                  <ComposerPrimitive.StopDictation render={<ComposerVoiceButton active />} />
                </AuiIf>
              </AuiIf>
              <AuiIf condition={(s) => !s.composer.canCancel}>
                <ComposerPrimitive.Send render={<ComposerSend streaming={false} idle={empty} />} />
              </AuiIf>
              <AuiIf condition={(s) => s.composer.canCancel}>
                <ComposerPrimitive.Cancel render={<ComposerSend streaming idle={false} aria-label="Stop waiting for the answer" />} />
              </AuiIf>
            </ComposerActions>
          </ComposerToolbar>
        </ComposerBar>
      </ComposerPrimitive.Root>
    </Composer>
  );
}
