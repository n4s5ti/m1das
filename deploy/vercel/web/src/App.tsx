import { AssistantRuntimeProvider, WebSpeechDictationAdapter } from '@assistant-ui/react'
import { useChatRuntime } from '@assistant-ui/ai-sdk'
import { useSyncExternalStore } from 'react'
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui'
import { OracleActivity } from '@/components/oracle/oracle-activity'
import { OracleStatus } from '@/components/oracle/oracle-status'
import { TooltipProvider } from '@/components/ui/tooltip'

const THREAD_COMPONENTS: ThreadComponents = {
  Welcome: () => (
    <div className="mb-6 text-center">
      <h1 className="font-heading text-4xl font-medium tracking-tight">Oracle</h1>
      <p className="mt-2 text-sm text-muted-foreground">AMATI's oracle. Messages go to the same bot as its terminal.</p>
    </div>
  ),
  ToolGroup: OracleActivity,
}

// Voice input only where the browser has speech recognition.
const noop = () => () => {}
const dictation = new WebSpeechDictationAdapter({ interimResults: true })

export default function App() {
  const speech = useSyncExternalStore(noop, WebSpeechDictationAdapter.isSupported, () => false)
  const runtime = useChatRuntime({ adapters: speech ? { dictation } : {} })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <main className="flex h-dvh flex-col">
          <header className="flex h-12 shrink-0 items-center justify-end px-4">
            <OracleStatus />
          </header>
          <div className="min-h-0 flex-1">
            <Thread components={THREAD_COMPONENTS} />
          </div>
        </main>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  )
}
