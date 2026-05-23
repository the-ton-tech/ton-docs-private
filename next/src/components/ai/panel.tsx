"use client"
import {
  type ComponentProps,
  type SyntheticEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ArrowDown,
  Check,
  Copy,
  FileText,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react"
import {cn} from "../../lib/cn"
import {buttonVariants} from "../ui/button"
import type {UseChatHelpers} from "@ai-sdk/react"
import {Markdown, SourcesBlock, stripTrailingSources} from "./markdown"
import {Presence} from "@radix-ui/react-presence"
import {usePathname} from "next/navigation"
import {
  type ChatUIMessage,
  collectText,
  hasRenderableContent,
  pickStarterQuestions,
  STARTER_QUESTIONS,
  sendUserMessage,
  useAISearchContext,
  useChatContext,
} from "./search"

const FEEDBACK_URL = (() => {
  const base =
    process.env.NEXT_PUBLIC_AI_BACKEND_URL ?? "https://docs-ton.space/api/chat"
  try {
    const u = new URL(base)
    // Replace the final `/chat` segment with `/feedback` if present, else
    // just append `/feedback` to the origin's `/api`.
    u.pathname = u.pathname.replace(/\/chat\/?$/, "/feedback")
    if (!u.pathname.endsWith("/feedback")) {
      u.pathname = u.pathname.replace(/\/+$/, "") + "/feedback"
    }
    return u.toString()
  } catch {
    return "https://docs-ton.space/api/feedback"
  }
})()

// --- Reduced-motion ---------------------------------------------------------
// Read `prefers-reduced-motion: reduce` reactively. Tiny inline hook so we
// don't pull in a new dependency.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = () => setReduced(mq.matches)
    onChange()
    if (mq.addEventListener) mq.addEventListener("change", onChange)
    else mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange)
      else mq.removeListener(onChange)
    }
  }, [])
  return reduced
}

type ErrorKind = "terminal" | "rate_limited" | "network" | "unknown"

/** Bucket an error so we can pick the right UI affordance. */
function categorizeError(error: Error): ErrorKind {
  const message = (error.message ?? "").toLowerCase()
  if (
    message.includes("daily_limit") ||
    message.includes("ip_daily_limit") ||
    message.includes("payload_too_large")
  ) {
    return "terminal"
  }
  if (message.includes("rate_limited") || message.includes("429")) return "rate_limited"
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network"
  if (message.includes("failed to fetch") || message.includes("network")) return "network"
  return "unknown"
}

function friendlyError(error: Error): string {
  const kind = categorizeError(error)
  const message = (error.message ?? "").toLowerCase()
  if (kind === "network") {
    return "You're offline — we'll retry when you reconnect."
  }
  if (message.includes("ip_daily_limit")) {
    return "You've reached your daily question limit. Please try again tomorrow."
  }
  if (message.includes("daily_limit")) {
    return "The assistant has reached today's free usage limit. It resets at 00:00 UTC — please try again later."
  }
  if (message.includes("payload_too_large")) {
    return "That message is too long. Please shorten it and try again."
  }
  if (kind === "rate_limited") {
    if (message.includes("429")) {
      return "The assistant is busy or has hit its usage limit. Please try again in a little while."
    }
    return "You're sending messages too quickly. Please wait a moment and try again."
  }
  return "Something went wrong while contacting the assistant. Please try again."
}

function askElsewherePrompt(): string {
  const title = typeof document !== "undefined" ? document.title : "this page"
  const href = typeof window !== "undefined" ? window.location.href : ""
  return `Read ${href}, I want to ask questions about it. (Topic: ${title})`
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.max(1, Math.round(diff / 1000))
  if (sec < 60) return "just now"
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`
  const day = Math.round(hr / 24)
  return `${day} day${day === 1 ? "" : "s"} ago`
}

/** Serialize the visible conversation to a portable Markdown transcript. */
function conversationToMarkdown(messages: ChatUIMessage[]): string {
  const blocks: string[] = []
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue
    const text = collectText(msg).trim()
    if (text.length === 0) continue
    const label = msg.role === "user" ? "You" : "Assistant"
    blocks.push(`**${label}:** ${text}`)
  }
  return blocks.join("\n\n---\n\n")
}

function AISearchPanelHeader({className, ...props}: ComponentProps<"div">) {
  const {setOpen} = useAISearchContext()
  const {messages, setMessages} = useChatContext()
  const [copied, setCopied] = useState(false)

  function onCopyTranscript() {
    const md = conversationToMarkdown(messages)
    if (md.length === 0) return
    void navigator.clipboard?.writeText(md)?.then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className={cn("border-b px-[13px] pb-3", className)} {...props}>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-semibold">Ask AI</p>

        {messages.length > 0 && (
          <>
            <button
              type="button"
              className={cn(
                buttonVariants({
                  color: "ghost",
                  size: "sm",
                  className: "text-fd-muted-foreground",
                }),
              )}
              onClick={() => setMessages([])}
            >
              Clear chat
            </button>
          </>
        )}

        <button
          type="button"
          aria-label="Close"
          className={cn(
            buttonVariants({
              size: "icon-sm",
              color: "ghost",
              className: "text-fd-muted-foreground",
            }),
          )}
          onClick={() => setOpen(false)}
        >
          <X />
        </button>
      </div>

      <p className="mt-0.5 text-xs text-fd-muted-foreground">
        AI can be inaccurate, please verify the answers. Powered by OpenRouter.
      </p>
    </div>
  )
}

const StorageKeyInput = "__ai_search_input"
function AISearchInput(props: ComponentProps<"form">) {
  const {status, sendMessage, stop, messages} = useChatContext()
  const {input, setInput, contextDetached, markMessageStopped} = useAISearchContext()
  const isLoading = status === "streaming" || status === "submitted"
  const [stopHint, setStopHint] = useState(false)

  const onStart = (e?: SyntheticEvent) => {
    e?.preventDefault()
    const message = input.trim()
    if (message.length === 0) return

    sendUserMessage(sendMessage, message, !contextDetached)
    setInput("")
    localStorage.removeItem(StorageKeyInput)
  }

  useEffect(() => {
    if (isLoading) document.getElementById("nd-ai-input")?.focus()
  }, [isLoading])

  // Auto-dismiss the stop hint after 2s.
  useEffect(() => {
    if (!stopHint) return
    const id = setTimeout(() => setStopHint(false), 2000)
    return () => clearTimeout(id)
  }, [stopHint])

  function onStopClick() {
    // Tag the currently-streaming assistant message (if any) as stopped so
    // the renderer can show a "Stopped by you" badge.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        markMessageStopped(messages[i].id)
        break
      }
    }
    stop()
  }

  return (
    <form {...props} className={cn("flex flex-col", props.className)} onSubmit={onStart}>
      <div className="flex items-start">
        <Input
          value={input}
          placeholder={isLoading ? "AI is answering..." : "Ask a question"}
          autoFocus
          className="p-3 max-h-40 overflow-y-auto"
          onChange={e => {
            setInput(e.target.value)
          }}
          onKeyDown={event => {
            if (!event.shiftKey && event.key === "Enter") {
              // Allow typing while streaming, but ignore Enter — pressing
              // submit while a previous answer is in flight would queue a
              // request the backend can't handle until the stream finishes.
              if (isLoading) {
                event.preventDefault()
                setStopHint(true)
                return
              }
              onStart(event)
            }
          }}
        />
        {isLoading ? (
          <button
            key="bn"
            type="button"
            aria-label="Stop"
            className={cn(
              buttonVariants({
                color: "secondary",
                className: "transition-all m-3",
              }),
            )}
            onClick={onStopClick}
          >
            <Square className="size-4 fill-current" />
          </button>
        ) : (
          <button
            key="bn"
            type="submit"
            aria-label="Send"
            className={cn(
              buttonVariants({
                color: "primary",
                className: "transition-all m-3",
              }),
            )}
            disabled={input.length === 0}
          >
            <Send className="size-4" />
          </button>
        )}
      </div>
      {stopHint && (
        <p
          role="status"
          aria-live="polite"
          className="px-3 pb-2 text-xs text-fd-muted-foreground"
        >
          Stop the current answer first.
        </p>
      )}
    </form>
  )
}

function ContextChip() {
  const {contextDetached, setContextDetached} = useAISearchContext()
  const pathname = usePathname()
  const [label, setLabel] = useState<string>("")

  useEffect(() => {
    const id = setTimeout(() => {
      const raw = typeof document !== "undefined" ? document.title : ""
      const title = raw.replace(/\s*[—|-]\s*TON Docs\s*$/i, "").trim()
      setLabel(title && title.length > 0 ? title : pathname || "this page")
    }, 0)
    return () => clearTimeout(id)
  }, [pathname])

  if (contextDetached) {
    return (
      <div className="flex items-center px-1 pb-1">
        <button
          type="button"
          onClick={() => setContextDetached(false)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent focus-visible:ring-1 focus-visible:ring-fd-ring"
        >
          <FileText className="size-3" />
          <span>Re-attach context</span>
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center px-1 pb-1">
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-fd-secondary px-2 py-0.5 text-xs text-fd-muted-foreground">
        <FileText className="size-3 shrink-0" />
        <span className="truncate">Context: {label}</span>
        <button
          type="button"
          aria-label="Detach page context"
          className="ms-0.5 inline-flex items-center justify-center rounded-full p-0.5 hover:bg-fd-accent hover:text-fd-foreground focus-visible:ring-1 focus-visible:ring-fd-ring"
          onClick={() => setContextDetached(true)}
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  )
}

const PinThresholdPx = 40

function List({
  resetPinSignal,
  ...props
}: Omit<ComponentProps<"div">, "dir"> & {resetPinSignal?: unknown}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  function isAtBottom(container: HTMLElement): boolean {
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    return distance <= PinThresholdPx
  }

  useEffect(() => {
    pinnedRef.current = true
    const container = containerRef.current
    if (container) {
      container.scrollTo({top: container.scrollHeight, behavior: "instant"})
    }
    const id = setTimeout(() => setShowJump(false), 0)
    return () => clearTimeout(id)
  }, [resetPinSignal])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    // Streaming code blocks (Shiki) resize multiple times as they hydrate, so
    // the observer fires in tight bursts. Coalesce to one rAF tick and skip
    // the imperative scrollTo while the user has scrolled in the last 250ms —
    // otherwise the autoscroll yanks the viewport mid-read.
    let rafId = 0
    let lastUserScrollAt = 0
    const callback = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        if (!container) return
        if (Date.now() - lastUserScrollAt < 250) return
        if (pinnedRef.current) {
          container.scrollTo({top: container.scrollHeight, behavior: "instant"})
          setShowJump(false)
        } else {
          setShowJump(true)
        }
      })
    }

    function onScroll() {
      lastUserScrollAt = Date.now()
      if (!container) return
      const atBottom = isAtBottom(container)
      pinnedRef.current = atBottom
      if (atBottom) setShowJump(false)
    }

    const observer = new ResizeObserver(callback)
    callback()

    const element = container.firstElementChild
    if (element) observer.observe(element)
    container.addEventListener("scroll", onScroll, {passive: true})

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      observer.disconnect()
      container.removeEventListener("scroll", onScroll)
    }
  }, [])

  function jumpToLatest() {
    const container = containerRef.current
    if (!container) return
    pinnedRef.current = true
    container.scrollTo({top: container.scrollHeight, behavior: "smooth"})
    setShowJump(false)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        {...props}
        className={cn(
          "fd-scroll-container overflow-y-auto min-w-0 flex flex-col",
          props.className,
        )}
      >
        {props.children}
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className={cn(
            "absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-fd-card px-3 py-1 text-xs text-fd-muted-foreground shadow-sm transition-colors hover:text-fd-foreground",
          )}
        >
          <ArrowDown className="size-3" />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  )
}

function Input(props: ComponentProps<"textarea">) {
  const ref = useRef<HTMLDivElement>(null)
  const shared = cn("col-start-1 row-start-1", props.className)

  return (
    <div className="grid flex-1">
      <textarea
        id="nd-ai-input"
        {...props}
        className={cn(
          "resize-none bg-transparent placeholder:text-fd-muted-foreground focus-visible:outline-none",
          shared,
        )}
      />
      <div ref={ref} className={cn(shared, "break-all invisible")}>
        {`${props.value?.toString() ?? ""}\n`}
      </div>
    </div>
  )
}

const roleName: Record<string, string> = {
  user: "You",
  assistant: "TON Docs AI",
}

/** A tool-call part as it streams in — loosely typed; only render-time fields. */
interface ToolUIPartLike {
  type: string
  state?: "input-streaming" | "input-available" | "output-available" | "output-error"
  output?: unknown
}

function ToolStatusRow({
  icon: Icon,
  label,
  busy,
}: {
  icon: typeof Search
  label: string
  busy?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-fd-muted-foreground">
      <Icon
        className={cn("size-3.5 shrink-0", busy && "animate-pulse motion-reduce:animate-none")}
      />
      <span>{label}</span>
    </div>
  )
}

function ToolActivity({part}: {part: ToolUIPartLike}) {
  const isSearch = part.type === "tool-search"
  const isFetch = part.type === "tool-fetch_page"
  if (!isSearch && !isFetch) return null

  const Icon = isFetch ? FileText : Search
  const busyLabel = isFetch ? "Fetching page…" : "Searching the documentation…"
  const errorLabel = isFetch ? "Page fetch failed" : "Documentation search failed"
  const unavailableLabel = isFetch
    ? "Page fetch unavailable"
    : "Documentation search unavailable"
  const emptyLabel = isFetch ? "No page returned" : "No matching documentation found"
  const doneLabel = isFetch ? "Fetched page" : "Searched the documentation"

  const busy = part.state === "input-streaming" || part.state === "input-available"
  if (busy) return <ToolStatusRow icon={Icon} label={busyLabel} busy />
  if (part.state === "output-error") {
    return <ToolStatusRow icon={Icon} label={errorLabel} />
  }

  if (isFetch) {
    const output = part.output as {url?: string; content?: string; error?: string} | undefined
    if (!output || output.error) {
      return <ToolStatusRow icon={Icon} label={unavailableLabel} />
    }
    if (!output.content) {
      return <ToolStatusRow icon={Icon} label={emptyLabel} />
    }
    const fetched = output.url
    return (
      <div className="flex items-center gap-1.5 text-xs text-fd-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {fetched ? (
          <a
            href={fetched}
            target="_blank"
            rel="noopener"
            className="truncate underline-offset-2 hover:underline hover:text-fd-foreground"
          >
            {doneLabel} · {fetched}
          </a>
        ) : (
          <span>{doneLabel}</span>
        )}
      </div>
    )
  }

  const output = part.output as
    | {results?: {title?: string; url?: string}[]; error?: string}
    | undefined
  if (!output || output.error || !output.results) {
    return <ToolStatusRow icon={Icon} label={unavailableLabel} />
  }
  const results = output.results
  if (results.length === 0) {
    return <ToolStatusRow icon={Icon} label={emptyLabel} />
  }
  return (
    <details className="text-xs text-fd-muted-foreground">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 rounded focus-visible:ring-1 focus-visible:ring-fd-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <Icon className="size-3.5 shrink-0" />
        <span>
          {doneLabel} · {results.length} {results.length === 1 ? "page" : "pages"}
        </span>
      </summary>
      <ul className="mt-1 ms-5 flex flex-col gap-0.5">
        {results.map((result, i) => {
          const label = result.title ?? result.url ?? "Untitled page"
          if (result.url) {
            return (
              <li key={i} className="truncate">
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener"
                  className="text-fd-muted-foreground underline-offset-2 hover:underline hover:text-fd-foreground"
                >
                  {label}
                </a>
              </li>
            )
          }
          return (
            <li key={i} className="truncate">
              {label}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function MessageParts({
  message,
  streaming,
}: {
  message: ChatUIMessage
  streaming: boolean
}) {
  const isAssistant = message.role === "assistant"
  return (
    <>
      {(message.parts ?? []).map((part, i) => {
        if (part.type === "text") {
          if (part.text.trim().length === 0) return null
          // The pill row below (SourcesBlock) already lists every cited URL.
          // Strip the model's own trailing "Sources" section from the body
          // for assistant messages so we don't show it twice. Don't strip
          // while streaming — the regex anchors at EOF, and a partial
          // "Sources" label mid-stream would wrongly drop the rest of the
          // sentence; the final snapshot does the cleanup.
          const body =
            isAssistant && !streaming ? stripTrailingSources(part.text) : part.text
          if (body.trim().length === 0) return null
          return (
            <div key={i} className="prose text-sm">
              <Markdown text={body} streaming={streaming} />
            </div>
          )
        }
        if (part.type.startsWith("tool-")) {
          return <ToolActivity key={i} part={part as unknown as ToolUIPartLike} />
        }
        return null
      })}
    </>
  )
}

function CopyButton({text}: {text: string}) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label={copied ? "Answer copied" : "Copy answer"}
      onClick={() => {
        void navigator.clipboard?.writeText(text)?.then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
      className={cn(
        buttonVariants({
          color: "ghost",
          size: "icon-sm",
          className: "text-fd-muted-foreground",
        }),
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

/** Thumbs up / down feedback for an assistant message. */
function FeedbackButtons({
  messageId,
  disabled,
}: {
  messageId: string
  disabled: boolean
}) {
  const {feedbackByMessage, recordFeedback, requestIdByMessage} = useAISearchContext()
  const verdict = feedbackByMessage[messageId]
  const [thanks, setThanks] = useState(false)

  async function send(v: "up" | "down") {
    if (verdict || disabled) return
    recordFeedback(messageId, v)
    setThanks(true)
    setTimeout(() => setThanks(false), 2000)
    try {
      await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          verdict: v,
          // Per-message request id; falls back to undefined for messages
          // submitted before the binding effect ran (e.g. restored from
          // localStorage). Never use a shared "latest" id, which mis-attributes
          // older verdicts to the most recent request.
          requestId: requestIdByMessage[messageId] ?? undefined,
        }),
        keepalive: true,
      })
    } catch {
      // Best-effort: ignore network errors / 404 (endpoint may not be live yet).
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Helpful"
        aria-pressed={verdict === "up"}
        disabled={disabled || !!verdict}
        onClick={() => void send("up")}
        className={cn(
          buttonVariants({
            color: "ghost",
            size: "icon-sm",
            className: cn(
              "text-fd-muted-foreground",
              verdict === "up" && "text-fd-primary",
            ),
          }),
        )}
      >
        <ThumbsUp className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Not helpful"
        aria-pressed={verdict === "down"}
        disabled={disabled || !!verdict}
        onClick={() => void send("down")}
        className={cn(
          buttonVariants({
            color: "ghost",
            size: "icon-sm",
            className: cn(
              "text-fd-muted-foreground",
              verdict === "down" && "text-fd-primary",
            ),
          }),
        )}
      >
        <ThumbsDown className="size-3.5" />
      </button>
      {thanks && (
        <span className="ms-1 text-xs text-fd-muted-foreground" role="status">
          Thanks!
        </span>
      )}
    </>
  )
}

function MessageImpl({message, isLast}: {message: ChatUIMessage; isLast: boolean}) {
  const {regenerate, status} = useChatContext()
  const {stoppedMessageIds} = useAISearchContext()
  const isAssistant = message.role === "assistant"
  const text = collectText(message)
  const showActions = isAssistant && text.trim().length > 0
  const canRegenerate = isAssistant && isLast && status === "ready"
  const streaming = status === "streaming" || status === "submitted"
  const isStreamingThis = isAssistant && isLast && streaming
  const wasStopped = isAssistant && stoppedMessageIds.has(message.id)

  return (
    <div onClick={e => e.stopPropagation()} aria-busy={isStreamingThis || undefined}>
      <p
        className={cn(
          "mb-1 text-sm font-medium text-fd-muted-foreground",
          isAssistant && "text-fd-primary",
        )}
      >
        {roleName[message.role] ?? "unknown"}
      </p>
      <div className="flex flex-col gap-1.5">
        <MessageParts message={message} streaming={isStreamingThis} />
        {isStreamingThis && hasRenderableContent(message) && (
          <ToolStatusRow icon={Search} label={stageLabel(status, message)} busy />
        )}
        {isAssistant && !isStreamingThis && text.trim().length > 0 && (
          <SourcesBlock text={text} />
        )}
      </div>
      {showActions && (
        <div className="mt-1.5 flex items-center gap-0.5">
          <CopyButton text={text} />
          {canRegenerate && (
            <button
              type="button"
              aria-label="Regenerate answer"
              onClick={() => regenerate()}
              className={cn(
                buttonVariants({
                  color: "ghost",
                  size: "icon-sm",
                  className: "text-fd-muted-foreground",
                }),
              )}
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
          <FeedbackButtons messageId={message.id} disabled={isStreamingThis} />
          {wasStopped && (
            <span className="ms-1 text-xs text-fd-muted-foreground italic">
              Stopped by you
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// Custom comparator: `useChat` rebuilds `chat.messages` on every chunk, but
// past messages keep object identity — so a strict `===` on `message` skips
// re-rendering finished messages entirely while letting the streaming tail
// (whose `parts` array is patched in place under a stable id) still re-render
// via the parent's reference update. `isLast` is included so the
// regenerate/edit affordances appear/disappear correctly when the tail moves.
const Message = memo(
  MessageImpl,
  (prev, next) => prev.message === next.message && prev.isLast === next.isLast,
)

function LoadingDots({label}: {label?: string}) {
  return (
    <span className="flex gap-1 py-1" aria-hidden={label ? "true" : undefined}>
      <span className="size-1.5 animate-bounce motion-reduce:animate-none rounded-full bg-fd-muted-foreground [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce motion-reduce:animate-none rounded-full bg-fd-muted-foreground [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce motion-reduce:animate-none rounded-full bg-fd-muted-foreground" />
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
}

function PendingMessage({label}: {label: string}) {
  return (
    <div role="status" aria-live="polite">
      <p className="mb-1 text-sm font-medium text-fd-primary">{roleName.assistant}</p>
      <div className="flex items-center gap-2">
        <LoadingDots />
        <span className="text-xs text-fd-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

function EmptyState({chat}: {chat: UseChatHelpers<ChatUIMessage>}) {
  const {contextDetached} = useAISearchContext()
  const questions = useMemo(() => {
    if (typeof window === "undefined") return STARTER_QUESTIONS
    return pickStarterQuestions(window.location.pathname)
  }, [])

  return (
    <div className="text-sm text-fd-muted-foreground/80 size-full flex flex-col items-center justify-center text-center gap-3 px-[13px]">
      <Sparkles className="size-6 text-fd-muted-foreground/60" />
      <p onClick={e => e.stopPropagation()}>
        Ask anything about TON. Answers are grounded in the documentation.
      </p>
      <div className="flex w-full flex-col gap-1.5" onClick={e => e.stopPropagation()}>
        {questions.map(question => (
          <button
            key={question}
            type="button"
            onClick={() => sendUserMessage(chat.sendMessage, question, !contextDetached)}
            className="rounded-lg border px-3 py-2 text-start text-fd-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  )
}

function ErrorCard({error, onRetry}: {error: Error; onRetry: () => void}) {
  const kind = categorizeError(error)
  const [cooldown, setCooldown] = useState(kind === "rate_limited" ? 10 : 0)

  useEffect(() => {
    if (kind !== "rate_limited") return
    const reset = setTimeout(() => setCooldown(10), 0)
    const id = window.setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          window.clearInterval(id)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      clearTimeout(reset)
      window.clearInterval(id)
    }
  }, [kind, error])

  useEffect(() => {
    if (kind !== "network") return
    const onOnline = () => onRetry()
    window.addEventListener("online", onOnline, {once: true})
    return () => window.removeEventListener("online", onOnline)
  }, [kind, onRetry])

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border bg-fd-card p-3 text-fd-card-foreground"
    >
      <p className="text-sm">{friendlyError(error)}</p>
      {kind === "terminal" ? (
        <a
          href={`https://chatgpt.com/?${new URLSearchParams({hints: "search", q: askElsewherePrompt()})}`}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(buttonVariants({color: "secondary", size: "sm", className: "self-start"}))}
        >
          Ask in ChatGPT
        </a>
      ) : (
        <button
          type="button"
          onClick={onRetry}
          disabled={kind === "rate_limited" && cooldown > 0}
          className={cn(buttonVariants({color: "secondary", size: "sm", className: "self-start"}))}
        >
          {kind === "rate_limited" && cooldown > 0 ? `Try again in ${cooldown}s` : "Try again"}
        </button>
      )}
    </div>
  )
}

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"

// Picks the first/last interactive element inside `root`, skipping the focus
// sentinels themselves (data-focus-sentinel) and elements that are not laid
// out. Only runs when a sentinel actually receives focus — i.e. when the user
// has Tabbed past the dialog boundary — so we no longer walk the DOM on every
// Tab keystroke (the previous implementation did, and the transcript subtree
// can be hundreds of nodes while streaming).
function focusEdgeInside(root: HTMLElement | null, edge: "first" | "last"): void {
  if (!root) return
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  const candidates = all.filter(
    el => el.dataset.focusSentinel === undefined && el.offsetParent !== null,
  )
  if (candidates.length === 0) return
  const target = edge === "first" ? candidates[0] : candidates[candidates.length - 1]
  target.focus()
}

export default function AISearchPanel() {
  const {open, setOpen} = useAISearchContext()
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const reducedMotion = useReducedMotion()

  // Capture the element to restore focus to on open, restore on close.
  // The Tab-trap itself is implemented via two sentinel <div>s inside the
  // dialog (see render below) — no document keydown listener required.
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    return () => {
      const target = restoreFocusRef.current
      if (target && typeof target.focus === "function") {
        setTimeout(() => target.focus(), 0)
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => document.getElementById("nd-ai-input")?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  return (
    <>
      <style>
        {`
        @keyframes ask-ai-open {
          from {
            translate: 100% 0;
          }
          to {
            translate: 0 0;
          }
        }
        @keyframes ask-ai-close {
          from {
            width: var(--ai-chat-width);
          }
          to {
            width: 0px;
          }
        }`}
      </style>
      <Presence present={open}>
        <div
          className={cn(
            "fixed inset-0 z-30 backdrop-blur-xs bg-fd-overlay lg:hidden",
            reducedMotion
              ? ""
              : open
              ? "animate-fd-fade-in"
              : "animate-fd-fade-out",
          )}
          onClick={() => setOpen(false)}
        />
      </Presence>
      <Presence present={open}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Ask AI"
          aria-modal={open ? "true" : undefined}
          aria-hidden={open ? undefined : true}
          // `inert` makes the closed dialog non-interactive AND removes it from
          // the AT tree even while Presence is keeping it mounted for the exit
          // animation. Spread via cast: the React 18 type wants a boolean, the
          // React 19 type wants an empty string — neither matches our intent
          // exactly (omit when open, present when closed).
          {...((open ? {} : {inert: true}) as Record<string, unknown>)}
          className={cn(
            "overflow-hidden z-30 bg-fd-background text-fd-foreground [--ai-chat-width:400px] 2xl:[--ai-chat-width:460px]",
            "max-lg:fixed max-lg:inset-3 max-lg:border max-lg:rounded-2xl max-lg:shadow-xl",
            "lg:sticky lg:top-0 lg:h-dvh lg:border-s lg:ms-auto lg:in-[#nd-docs-layout]:[grid-area:toc] lg:in-[#nd-notebook-layout]:row-span-full lg:in-[#nd-notebook-layout]:col-start-5",
            reducedMotion
              ? ""
              : open
              ? "animate-fd-dialog-in lg:animate-[ask-ai-open_200ms]"
              : "animate-fd-dialog-out lg:animate-[ask-ai-close_200ms]",
          )}
        >
          {/* Leading focus sentinel: a Shift+Tab off the first interactive
              element lands here and bounces focus to the last interactive
              element inside the dialog. Trailing sentinel does the reverse. */}
          <div
            tabIndex={0}
            data-focus-sentinel="start"
            aria-hidden="true"
            style={{position: "absolute", width: 1, height: 1, opacity: 0}}
            onFocus={() => focusEdgeInside(dialogRef.current, "last")}
          />
          <div className="flex flex-col size-full gap-2 p-2 lg:p-3 lg:w-(--ai-chat-width)">
            <AISearchPanelHeader />
            <AISearchPanelList className="flex-1" />
            <div>
              <ContextChip />
              <div className="rounded-xl border bg-fd-card text-fd-card-foreground has-focus-visible:border-fd-ring has-focus-visible:ring-1 has-focus-visible:ring-fd-ring">
                <AISearchInput />
              </div>
            </div>
          </div>
          <div
            tabIndex={0}
            data-focus-sentinel="end"
            aria-hidden="true"
            style={{position: "absolute", width: 1, height: 1, opacity: 0}}
            onFocus={() => focusEdgeInside(dialogRef.current, "first")}
          />
        </div>
      </Presence>
    </>
  )
}

function latestToolType(message: ChatUIMessage | undefined): string | null {
  if (!message || message.role !== "assistant") return null
  const parts = message.parts ?? []
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type.startsWith("tool-")) {
      const state = (part as unknown as ToolUIPartLike).state
      if (state === "input-streaming" || state === "input-available") return part.type
    }
  }
  return null
}

function stageLabel(
  status: UseChatHelpers<ChatUIMessage>["status"],
  last: ChatUIMessage | undefined,
): string {
  const tool = latestToolType(last)
  if (tool === "tool-search") return "Searching the documentation…"
  if (tool === "tool-fetch_page") return "Fetching page…"
  if (status === "submitted") return "Thinking…"
  if (status === "streaming") return "Writing…"
  return "Thinking…"
}

function AISearchPanelList({className, style, ...props}: ComponentProps<"div">) {
  const chat = useChatContext()
  const {restoredAt, clearRestored} = useAISearchContext()
  const messages = chat.messages.filter(msg => msg.role !== "system")
  const isLoading = chat.status === "submitted" || chat.status === "streaming"
  const last = messages[messages.length - 1]
  const pending =
    isLoading && (!last || last.role !== "assistant" || !hasRenderableContent(last))
  const visibleMessages = messages.filter(
    msg => msg.role !== "assistant" || hasRenderableContent(msg),
  )

  const userMessageCount = messages.filter(m => m.role === "user").length

  const announcement = !isLoading && last?.role === "assistant" && hasRenderableContent(last)
    ? "Answer received"
    : isLoading
    ? stageLabel(chat.status, last)
    : ""

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <List
        resetPinSignal={userMessageCount}
        className={cn("py-4 overscroll-contain", className)}
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent, white 1rem, white calc(100% - 1rem), transparent 100%)",
          ...style,
        }}
        {...props}
      >
        {messages.length === 0 ? (
          <EmptyState chat={chat} />
        ) : (
          <div className="flex flex-col gap-4 px-[13px]">
            {restoredAt !== null && messages.length > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-fd-secondary px-2 py-1 text-xs text-fd-muted-foreground">
                <span>Continued from {formatRelativeTime(restoredAt)}</span>
                <button
                  type="button"
                  className="underline-offset-2 hover:underline hover:text-fd-foreground"
                  onClick={() => {
                    chat.setMessages([])
                    clearRestored()
                  }}
                >
                  Start new
                </button>
              </div>
            )}
            {chat.error && <ErrorCard error={chat.error} onRetry={() => chat.regenerate()} />}
            {visibleMessages.map((item, idx) => (
              <Message
                key={item.id}
                message={item}
                isLast={idx === visibleMessages.length - 1}
              />
            ))}
            {pending && <PendingMessage label={stageLabel(chat.status, last)} />}
          </div>
        )}
      </List>
    </>
  )
}
