"use client"
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type SyntheticEvent,
  use,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ArrowDown,
  Check,
  Copy,
  FileText,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react"
import {cn} from "../../lib/cn"
import {buttonVariants} from "../ui/button"
import {useChat, type UseChatHelpers} from "@ai-sdk/react"
import {DefaultChatTransport, type UIMessage} from "ai"
import {Markdown} from "./markdown"
import {Presence} from "@radix-ui/react-presence"

/**
 * URL of the external chat backend. The docs site is a static export
 * (`output: "export"` in next.config.mjs) with no server runtime, so the
 * chat endpoint lives on a separate service. `NEXT_PUBLIC_` vars are inlined
 * at build time; this URL is not a secret.
 */
const AI_BACKEND_URL = process.env.NEXT_PUBLIC_AI_BACKEND_URL ?? "https://docs-ton.space/api/chat"

/**
 * Shape of the chat messages exchanged with the external backend. Mirrors the
 * backend's own `UIMessage` type — kept here as a self-contained client type
 * so the frontend has no dependency on any server-only route module.
 */
export type ChatUIMessage = UIMessage<
  never,
  {
    client: {
      location: string
    }
  }
>

/** Questions offered in the empty state to get a new user started. */
const STARTER_QUESTIONS = [
  "How do I deploy a smart contract on TON?",
  "What is a jetton?",
  "How does TON Connect work?",
  "How do I send messages between contracts?",
]

/**
 * Page-contextual starter questions. Matched against the first non-empty
 * segment of `location.pathname`. Falls back to `STARTER_QUESTIONS` when no
 * segment matches.
 */
const STARTER_CATALOG: Record<string, string[]> = {
  develop: [
    "How do I deploy a smart contract on TON?",
    "What's the difference between FunC, Tact, and Tolk?",
    "How do I send a message between contracts?",
    "How do I test a smart contract locally?",
  ],
  contribute: [
    "How can I contribute to the TON documentation?",
    "What is the style guide for docs?",
    "How do I run the docs site locally?",
    "How do I propose a new page or section?",
  ],
  payments: [
    "How do I send TON between wallets?",
    "What is a jetton and how do transfers work?",
    "How do I accept payments in my app?",
    "How are transaction fees calculated?",
  ],
  "ton-connect": [
    "How does TON Connect work?",
    "How do I integrate TON Connect in a web app?",
    "How do I send a transaction via TON Connect?",
    "How do I verify a TON Connect signature?",
  ],
  guidelines: [
    "What are the security best practices for smart contracts?",
    "How should I structure a TON dApp?",
    "What naming conventions do TON projects follow?",
    "How do I audit a contract before deployment?",
  ],
}

/** Pick the right starter set for the current page URL. */
function pickStarterQuestions(pathname: string): string[] {
  const segment = pathname.split("/").find(part => part.length > 0)
  if (segment && STARTER_CATALOG[segment]) return STARTER_CATALOG[segment]
  return STARTER_QUESTIONS
}

const Context = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
  chat: UseChatHelpers<ChatUIMessage>
  input: string
  setInput: (value: string) => void
} | null>(null)

/** Send a user message, attaching the current page so the backend has context. */
function sendUserMessage(
  sendMessage: UseChatHelpers<ChatUIMessage>["sendMessage"],
  text: string,
): void {
  void sendMessage({
    role: "user",
    parts: [
      {type: "data-client", data: {location: location.href}},
      {type: "text", text},
    ],
  })
}

/** Concatenate the text parts of a message. */
function collectText(message: ChatUIMessage): string {
  let text = ""
  for (const part of message.parts ?? []) {
    if (part.type === "text") text += part.text
  }
  return text
}

/** True if a message has anything worth rendering (answer text or a tool call). */
function hasRenderableContent(message: ChatUIMessage): boolean {
  return (message.parts ?? []).some(
    part =>
      (part.type === "text" && part.text.trim().length > 0) || part.type.startsWith("tool-"),
  )
}

/**
 * Turn a backend error into a message a user can act on. The backend replies
 * with opaque codes (`daily_limit`, `rate_limited`, …); map the ones we know
 * and fall back to a generic message.
 */
function friendlyError(error: Error): string {
  const message = (error.message ?? "").toLowerCase()
  if (message.includes("ip_daily_limit")) {
    return "You've reached your daily question limit. Please try again tomorrow."
  }
  if (message.includes("daily_limit")) {
    return "The assistant has reached today's free usage limit. It resets at 00:00 UTC — please try again later."
  }
  if (message.includes("rate_limited")) {
    return "You're sending messages too quickly. Please wait a moment and try again."
  }
  if (message.includes("payload_too_large")) {
    return "That message is too long. Please shorten it and try again."
  }
  if (message.includes("429")) {
    return "The assistant is busy or has hit its usage limit. Please try again in a little while."
  }
  return "Something went wrong while contacting the assistant. Please try again."
}

// --- Conversation persistence ----------------------------------------------
// The chat lives in React state and is otherwise lost on a full reload. Keep
// the last few turns in localStorage so a returning reader picks up where they
// left off. Only settled conversations are saved (never a mid-stream answer).

const StorageKeyMessages = "__ai_search_messages"
const MaxPersistedMessages = 30

function loadPersistedMessages(): ChatUIMessage[] {
  try {
    const raw = localStorage.getItem(StorageKeyMessages)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (m): m is ChatUIMessage =>
        !!m &&
        typeof m === "object" &&
        typeof (m as {role?: unknown}).role === "string" &&
        Array.isArray((m as {parts?: unknown}).parts),
    )
  } catch {
    return []
  }
}

function persistMessages(messages: ChatUIMessage[]): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(StorageKeyMessages)
      return
    }
    localStorage.setItem(
      StorageKeyMessages,
      JSON.stringify(messages.slice(-MaxPersistedMessages)),
    )
  } catch {
    // Best-effort: ignore quota errors or unavailable localStorage.
  }
}

export function AISearchPanelHeader({className, ...props}: ComponentProps<"div">) {
  const {setOpen} = useAISearchContext()
  const {messages, setMessages} = useChatContext()

  return (
    <div className={cn("border-b px-[13px] pb-3", className)} {...props}>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-semibold">Ask AI</p>

        {messages.length > 0 && (
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
        AI can be inaccurate, please verify the answers.
      </p>
    </div>
  )
}

const StorageKeyInput = "__ai_search_input"
export function AISearchInput(props: ComponentProps<"form">) {
  const {status, sendMessage, stop} = useChatContext()
  const {input, setInput} = useAISearchContext()
  const isLoading = status === "streaming" || status === "submitted"
  const onStart = (e?: SyntheticEvent) => {
    e?.preventDefault()
    const message = input.trim()
    if (message.length === 0) return

    sendUserMessage(sendMessage, message)
    setInput("")
    localStorage.removeItem(StorageKeyInput)
  }

  useEffect(() => {
    if (isLoading) document.getElementById("nd-ai-input")?.focus()
  }, [isLoading])

  return (
    <form {...props} className={cn("flex items-start", props.className)} onSubmit={onStart}>
      <Input
        value={input}
        placeholder={isLoading ? "AI is answering..." : "Ask a question"}
        autoFocus
        className="p-3"
        disabled={status === "streaming" || status === "submitted"}
        onChange={e => {
          setInput(e.target.value)
        }}
        onKeyDown={event => {
          if (!event.shiftKey && event.key === "Enter") {
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
          onClick={stop}
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
    </form>
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

  // Reset pinned state when the conversation gets a fresh user message —
  // we want the new answer to follow the bottom regardless of prior scroll.
  useEffect(() => {
    pinnedRef.current = true
    const container = containerRef.current
    if (container) {
      container.scrollTo({top: container.scrollHeight, behavior: "instant"})
    }
    // Defer the hide to a microtask so we don't synchronously update state
    // from within the effect body (avoids cascading-renders lint rule).
    const id = setTimeout(() => setShowJump(false), 0)
    return () => clearTimeout(id)
  }, [resetPinSignal])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    function callback() {
      if (!container) return
      if (pinnedRef.current) {
        container.scrollTo({top: container.scrollHeight, behavior: "instant"})
        setShowJump(false)
      } else {
        setShowJump(true)
      }
    }

    function onScroll() {
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
    <div className="flex items-center gap-1.5 text-xs text-fd-muted-foreground" role="status">
      <Icon className={cn("size-3.5 shrink-0", busy && "animate-pulse")} />
      <span>{label}</span>
    </div>
  )
}

/**
 * Render a `search` (or `fetch_page`) tool call so the user can see the
 * assistant grounding its answer in the docs instead of staring at a blank wait.
 */
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
      <summary className="flex cursor-pointer select-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
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

function MessageParts({message}: {message: ChatUIMessage}) {
  return (
    <>
      {(message.parts ?? []).map((part, i) => {
        if (part.type === "text") {
          if (part.text.trim().length === 0) return null
          return (
            <div key={i} className="prose text-sm">
              <Markdown text={part.text} />
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

function Message({message, isLast}: {message: ChatUIMessage; isLast: boolean}) {
  const {regenerate, status, messages, setMessages} = useChatContext()
  const {setInput} = useAISearchContext()
  const isAssistant = message.role === "assistant"
  const isUser = message.role === "user"
  const text = collectText(message)
  const showActions = isAssistant && text.trim().length > 0
  const canRegenerate = isAssistant && isLast && status === "ready"
  const canEdit = isUser && status === "ready"
  const streaming = status === "streaming" || status === "submitted"
  const isStreamingThis = isAssistant && isLast && streaming

  function onEdit() {
    if (!canEdit) return
    setInput(text)
    const idx = messages.findIndex(m => m.id === message.id)
    if (idx >= 0) setMessages(messages.slice(0, idx))
    // Defer focus until after render so the input exists.
    setTimeout(() => {
      const el = document.getElementById("nd-ai-input") as HTMLTextAreaElement | null
      if (el) {
        el.focus()
        el.setSelectionRange(text.length, text.length)
      }
    }, 0)
  }

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
        <MessageParts message={message} />
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
        </div>
      )}
      {canEdit && text.trim().length > 0 && (
        <div className="mt-1.5 flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Edit and resend message"
            onClick={onEdit}
            className={cn(
              buttonVariants({
                color: "ghost",
                size: "icon-sm",
                className: "text-fd-muted-foreground",
              }),
            )}
          >
            <Pencil className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function LoadingDots({label}: {label?: string}) {
  return (
    <span className="flex gap-1 py-1" aria-hidden={label ? "true" : undefined}>
      <span className="size-1.5 animate-bounce rounded-full bg-fd-muted-foreground [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-fd-muted-foreground [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-fd-muted-foreground" />
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
            onClick={() => sendUserMessage(chat.sendMessage, question)}
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
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border bg-fd-card p-3 text-fd-card-foreground"
    >
      <p className="text-sm">{friendlyError(error)}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(buttonVariants({color: "secondary", size: "sm", className: "self-start"}))}
      >
        Try again
      </button>
    </div>
  )
}

export function AISearch({children}: {children: ReactNode}) {
  const [open, setOpen] = useState(false)
  // Lazy initializer so localStorage is only touched on the client. `AISearch`
  // is always rendered inside a `"use client"` tree.
  const [input, setInputState] = useState<string>(() => {
    if (typeof window === "undefined") return ""
    try {
      return localStorage.getItem(StorageKeyInput) ?? ""
    } catch {
      return ""
    }
  })
  const chat = useChat<ChatUIMessage>({
    id: "search",
    transport: new DefaultChatTransport({
      api: AI_BACKEND_URL,
    }),
  })

  // Restore a persisted conversation once, after mount (client only).
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const saved = loadPersistedMessages()
    if (saved.length > 0) chat.setMessages(saved)
  }, [chat])

  // Persist the conversation whenever it settles — never a mid-stream answer.
  useEffect(() => {
    if (chat.status === "streaming" || chat.status === "submitted") return
    persistMessages(chat.messages)
  }, [chat.status, chat.messages])

  const setInput = (value: string) => {
    setInputState(value)
    try {
      if (value.length === 0) localStorage.removeItem(StorageKeyInput)
      else localStorage.setItem(StorageKeyInput, value)
    } catch {
      // Ignore unavailable localStorage.
    }
  }

  return (
    <Context
      value={useMemo(
        () => ({chat, open, setOpen, input, setInput}),
        [chat, open, input],
      )}
    >
      {children}
    </Context>
  )
}

export function AISearchTrigger({
  position = "default",
  className,
  ...props
}: ComponentProps<"button"> & {position?: "default" | "float"}) {
  const {open, setOpen} = useAISearchContext()

  return (
    <button
      data-state={open ? "open" : "closed"}
      className={cn(
        position === "float" && [
          "fixed bottom-4 flex items-center gap-2 whitespace-nowrap inset-e-[calc(--spacing(4)+var(--removed-body-scroll-bar-size,0px))] shadow-lg z-20 transition-[translate,opacity]",
          open && "translate-y-10 opacity-0",
        ],
        className,
      )}
      onClick={() => setOpen(!open)}
      {...props}
    >
      {props.children}
    </button>
  )
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",")
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    el => !el.hasAttribute("aria-hidden") && el.offsetParent !== null,
  )
}

export function AISearchPanel() {
  const {open, setOpen} = useAISearchContext()
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  useHotKey()

  // Save the previously focused element when the dialog opens, restore it on
  // close. Also implement a minimal Tab / Shift+Tab focus trap.
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return
      const root = dialogRef.current
      if (!root) return
      const focusables = getFocusableElements(root)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      const target = restoreFocusRef.current
      if (target && typeof target.focus === "function") {
        // Defer to allow the closing animation / removal to finish.
        setTimeout(() => target.focus(), 0)
      }
    }
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
            open ? "animate-fd-fade-in" : "animate-fd-fade-out",
          )}
          onClick={() => setOpen(false)}
        />
      </Presence>
      <Presence present={open}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Ask AI"
          aria-modal="true"
          className={cn(
            "overflow-hidden z-30 bg-fd-background text-fd-foreground [--ai-chat-width:400px] 2xl:[--ai-chat-width:460px]",
            "max-lg:fixed max-lg:inset-3 max-lg:border max-lg:rounded-2xl max-lg:shadow-xl",
            "lg:sticky lg:top-0 lg:h-dvh lg:border-s lg:ms-auto lg:in-[#nd-docs-layout]:[grid-area:toc] lg:in-[#nd-notebook-layout]:row-span-full lg:in-[#nd-notebook-layout]:col-start-5",
            open
              ? "animate-fd-dialog-in lg:animate-[ask-ai-open_200ms]"
              : "animate-fd-dialog-out lg:animate-[ask-ai-close_200ms]",
          )}
        >
          <div className="flex flex-col size-full gap-2 p-2 lg:p-3 lg:w-(--ai-chat-width)">
            <AISearchPanelHeader />
            <AISearchPanelList className="flex-1" />
            <div className="rounded-xl border bg-fd-card text-fd-card-foreground has-focus-visible:border-fd-ring has-focus-visible:ring-1 has-focus-visible:ring-fd-ring">
              <AISearchInput />
            </div>
          </div>
        </div>
      </Presence>
    </>
  )
}

/** Latest tool-call type on the last assistant message, if any. */
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

export function AISearchPanelList({className, style, ...props}: ComponentProps<"div">) {
  const chat = useChatContext()
  const messages = chat.messages.filter(msg => msg.role !== "system")
  const isLoading = chat.status === "submitted" || chat.status === "streaming"
  const last = messages[messages.length - 1]
  // After a question is sent, show a "thinking" indicator until the first
  // part (a tool call or answer text) streams in.
  const pending =
    isLoading && (!last || last.role !== "assistant" || !hasRenderableContent(last))
  const visibleMessages = messages.filter(
    msg => msg.role !== "assistant" || hasRenderableContent(msg),
  )

  // A pin-reset signal: bumps each time a new user message is added so the
  // list re-pins to the bottom regardless of prior scroll position.
  const userMessageCount = messages.filter(m => m.role === "user").length

  // High-level announcement for screen readers. Only state changes are spoken,
  // not the streaming token-by-token markup.
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

export function useHotKey() {
  const {open, setOpen} = useAISearchContext()

  const onKeyPress = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      setOpen(false)
      e.preventDefault()
    }

    if (e.key === "/" && (e.metaKey || e.ctrlKey) && !open) {
      setOpen(true)
      e.preventDefault()
    }
  })

  useEffect(() => {
    window.addEventListener("keydown", onKeyPress)
    return () => window.removeEventListener("keydown", onKeyPress)
  }, [])
}

export function useAISearchContext() {
  return use(Context)!
}

function useChatContext() {
  return use(Context)!.chat
}
