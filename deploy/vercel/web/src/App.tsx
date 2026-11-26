import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useChatRuntime } from '@assistant-ui/ai-sdk'
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui'
import { TooltipProvider } from '@/components/ui/tooltip'

const THREAD_COMPONENTS: ThreadComponents = {
  Welcome: () => (
    <div className="mb-6 text-center">
      <h1 className="font-heading text-4xl font-medium tracking-tight">Oracle</h1>
      <p className="mt-2 text-sm text-muted-foreground">AMATI's oracle. Messages go to the same bot as its terminal.</p>
    </div>
  ),
}

export default function App() {
  const runtime = useChatRuntime()
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <main className="h-dvh">
          <Thread components={THREAD_COMPONENTS} />
        </main>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  )
}
