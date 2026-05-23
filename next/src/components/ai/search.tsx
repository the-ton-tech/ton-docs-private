"use client"
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react"
import {cn} from "../../lib/cn"
import {useChat, type UseChatHelpers} from "@ai-sdk/react"
import {DefaultChatTransport, type UIMessage} from "ai"
import {usePathname} from "next/navigation"
import dynamic from "next/dynamic"

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
export const STARTER_QUESTIONS = [
  "How do I deploy a smart contract on TON?",
  "What is a jetton?",
  "How does TON Connect work?",
  "How do I send messages between contracts?",
]

/**
 * Page-contextual starter questions, keyed by the first non-empty segment of
 * `location.pathname`. Keys must match the real top-level dirs under
 * `content/docs/` (currently: applications, blockchain-basics, contribute,
 * ecosystem, overview). Falls back to `STARTER_QUESTIONS`.
 */
const STARTER_CATALOG: Record<string, string[]> = {
  "blockchain-basics": [
    "How does the TON blockchain work at a high level?",
    "What are workchains and shards?",
    "What is the TON Virtual Machine?",
    "How does the jetton standard work?",
  ],
  applications: [
    "How does TON Connect work?",
    "How do I integrate TON Connect in a web app?",
    "What SDKs are available for TON?",
    "How do I accept payments in my app?",
  ],
  ecosystem: [
    "How do I build a Telegram Mini App on TON?",
    "How do I connect a wallet inside a TMA?",
    "What is the TMA SDK?",
    "How do TMAs handle payments?",
  ],
  overview: [
    "How do I get started building on TON?",
    "What tools do I need to develop on TON?",
    "What wallets are available in the TON ecosystem?",
    "Where can I find learning resources for TON?",
  ],
  contribute: [
    "How can I contribute to the TON documentation?",
    "What is the style guide for docs?",
    "How do I run the docs site locally?",
    "How do I propose a new page or section?",
  ],
}

/**
 * Nested-path aliases: when a top-level segment is too coarse, a deeper
 * segment can re-target a more specific question set.
 */
const STARTER_ALIASES: {prefix: string; questions: string[]}[] = [
  {
    prefix: "/blockchain-basics/tvm",
    questions: [
      "What is the TON Virtual Machine?",
      "How do gas and fees work in TVM?",
      "What are continuations in TVM?",
      "Where can I find the TVM instruction reference?",
    ],
  },
  {
    prefix: "/blockchain-basics/tolk",
    questions: [
      "What is Tolk and how is it different from FunC?",
      "How do I write a basic Tolk contract?",
      "How do I import standard libraries in Tolk?",
      "How do I test a Tolk contract locally?",
    ],
  },
  {
    prefix: "/blockchain-basics/contract-dev",
    questions: [
      "How do I deploy a smart contract on TON?",
      "How do I send a message between contracts?",
      "What's the difference between FunC, Tact, and Tolk?",
      "How do I test a smart contract locally?",
    ],
  },
  {
    prefix: "/blockchain-basics/standard",
    questions: [
      "What are the TON standards (TEPs)?",
      "How does the jetton standard work?",
      "What does the NFT standard cover?",
      "How do I propose a new TEP?",
    ],
  },
  {
    prefix: "/blockchain-basics/payments",
    questions: [
      "How do I send TON between wallets?",
      "What is a jetton and how do transfers work?",
      "How do I accept payments in my app?",
      "How are transaction fees calculated?",
    ],
  },
  {
    prefix: "/applications/ton-connect",
    questions: [
      "How does TON Connect work?",
      "How do I integrate TON Connect in a web app?",
      "How do I send a transaction via TON Connect?",
      "How do I verify a TON Connect signature?",
    ],
  },
]

/** Pick the right starter set for the current page URL. */
export function pickStarterQuestions(pathname: string): string[] {
  for (const alias of STARTER_ALIASES) {
    if (pathname === alias.prefix || pathname.startsWith(`${alias.prefix}/`)) {
      return alias.questions
    }
  }
  const segment = pathname.split("/").find(part => part.length > 0)
  if (segment && STARTER_CATALOG[segment]) return STARTER_CATALOG[segment]
  return STARTER_QUESTIONS
}

/** Plain mutable holder we can pass into the transport without using `useRef`
 * (React Compiler forbids reading `.current` of a ref during render, even
 * inside a closure). Created per `AISearch` instance. */
export interface RequestIdHolder {
  current: string | null
}

interface AISearchContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  /** True once the panel has been opened at least once in this session. */
  panelEverOpened: boolean
  chat: UseChatHelpers<ChatUIMessage>
  input: string
  setInput: (value: string) => void
  contextDetached: boolean
  setContextDetached: (value: boolean) => void
  restoredAt: number | null
  clearRestored: () => void
  /** Holder for the `x-request-id` of the most recent chat response. */
  lastRequestId: RequestIdHolder
  /** Assistant message ids whose generation the user manually stopped. */
  stoppedMessageIds: Set<string>
  markMessageStopped: (id: string) => void
  /** Map of assistant message id -> feedback verdict already submitted. */
  feedbackByMessage: Record<string, "up" | "down">
  recordFeedback: (id: string, verdict: "up" | "down") => void
}

const Context = createContext<AISearchContextValue | null>(null)

/** Send a user message, optionally attaching the current page as context. */
export function sendUserMessage(
  sendMessage: UseChatHelpers<ChatUIMessage>["sendMessage"],
  text: string,
  attachContext: boolean,
): void {
  const parts: ChatUIMessage["parts"] = []
  if (attachContext) {
    let href: string | null = null
    try {
      href = new URL(location.href).toString()
    } catch {
      href = null
    }
    if (href) parts.push({type: "data-client", data: {location: href}})
  }
  parts.push({type: "text", text})
  void sendMessage({role: "user", parts})
}

/** Concatenate the text parts of a message. */
export function collectText(message: ChatUIMessage): string {
  let text = ""
  for (const part of message.parts ?? []) {
    if (part.type === "text") text += part.text
  }
  return text
}

/** True if a message has anything worth rendering (answer text or a tool call). */
export function hasRenderableContent(message: ChatUIMessage): boolean {
  return (message.parts ?? []).some(
    part =>
      (part.type === "text" && part.text.trim().length > 0) || part.type.startsWith("tool-"),
  )
}

// --- Conversation persistence ----------------------------------------------

const StorageKeyMessages = "__ai_search_messages"
const StorageKeyInput = "__ai_search_input"
const MaxPersistedMessages = 30
const PersistTTLms = 7 * 24 * 60 * 60 * 1000

function loadPersisted(): {messages: ChatUIMessage[]; savedAt: number} | null {
  try {
    const raw = localStorage.getItem(StorageKeyMessages)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const messages = parsed.filter(isChatUIMessage)
      return messages.length === 0 ? null : {messages, savedAt: Date.now()}
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as {messages?: unknown}).messages) &&
      typeof (parsed as {savedAt?: unknown}).savedAt === "number"
    ) {
      const wrapper = parsed as {messages: unknown[]; savedAt: number}
      if (Date.now() - wrapper.savedAt > PersistTTLms) {
        localStorage.removeItem(StorageKeyMessages)
        return null
      }
      const messages = wrapper.messages.filter(isChatUIMessage)
      return messages.length === 0 ? null : {messages, savedAt: wrapper.savedAt}
    }
    return null
  } catch {
    return null
  }
}

function isChatUIMessage(m: unknown): m is ChatUIMessage {
  return (
    !!m &&
    typeof m === "object" &&
    typeof (m as {role?: unknown}).role === "string" &&
    Array.isArray((m as {parts?: unknown}).parts)
  )
}

function persistMessages(messages: ChatUIMessage[]): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(StorageKeyMessages)
      return
    }
    localStorage.setItem(
      StorageKeyMessages,
      JSON.stringify({
        savedAt: Date.now(),
        messages: messages.slice(-MaxPersistedMessages),
      }),
    )
  } catch {
    // Best-effort: ignore quota errors or unavailable localStorage.
  }
}

export function AISearch({children}: {children: ReactNode}) {
  const [open, setOpenState] = useState(false)
  // `panelEverOpened` flips true the first time the panel is requested, so
  // the dynamically-loaded panel chunk is mounted and stays mounted (for
  // its close animation). Tracked as state so consumers re-render.
  const [panelEverOpened, setPanelEverOpened] = useState(false)
  const setOpen = useCallback((next: boolean) => {
    if (next) setPanelEverOpened(true)
    setOpenState(next)
  }, [])
  const [input, setInputState] = useState<string>(() => {
    if (typeof window === "undefined") return ""
    try {
      return localStorage.getItem(StorageKeyInput) ?? ""
    } catch {
      return ""
    }
  })
  const [contextDetached, setContextDetached] = useState(false)
  const [restoredAt, setRestoredAt] = useState<number | null>(null)

  // `x-request-id` from the most recent /api/chat response. Captured by the
  // custom transport `fetch` below; consumed by the feedback POST in the
  // panel. Plain object (not `useRef`) so the React Compiler does not flag
  // the closure read inside the memoized transport.
  const [lastRequestId] = useState<RequestIdHolder>(() => ({current: null}))

  const [stoppedMessageIds, setStoppedMessageIds] = useState<Set<string>>(() => new Set())
  const markMessageStopped = useCallback((id: string) => {
    setStoppedMessageIds(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, "up" | "down">>({})
  const recordFeedback = useCallback((id: string, verdict: "up" | "down") => {
    setFeedbackByMessage(prev => (prev[id] ? prev : {...prev, [id]: verdict}))
  }, [])

  // The transport is built once. The `fetch` interceptor captures the
  // `x-request-id` response header for the feedback POST.
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: AI_BACKEND_URL,
        fetch: async (input, init) => {
          const res = await fetch(input, init)
          const reqId = res.headers.get("x-request-id")
          if (reqId) lastRequestId.current = reqId
          return res
        },
      }),
  )
  const chat = useChat<ChatUIMessage>({id: "search", transport})

  // Restore a persisted conversation once, after mount (client only).
  const restored = useRef(false)
  const lastCount = useRef(0)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const saved = loadPersisted()
    if (saved && saved.messages.length > 0) {
      chat.setMessages(saved.messages)
      lastCount.current = saved.messages.length
      const id = setTimeout(() => setRestoredAt(saved.savedAt), 0)
      return () => clearTimeout(id)
    }
  }, [chat])

  // Drop the restored banner the moment the user clears or sends a fresh msg.
  useEffect(() => {
    const count = chat.messages.length
    if (restoredAt !== null && count !== lastCount.current) setRestoredAt(null)
    lastCount.current = count
  }, [chat.messages, restoredAt])

  // Re-attach page context whenever the URL changes.
  const pathname = usePathname()
  useEffect(() => {
    const id = setTimeout(() => setContextDetached(false), 0)
    return () => clearTimeout(id)
  }, [pathname])

  // Persist the conversation whenever it settles.
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

  // Open the chat (and optionally pre-fill) when an outside actor dispatches
  // a `CustomEvent("ai-open")`.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{prefill?: string}>).detail
      setOpen(true)
      if (detail?.prefill) setInputState(detail.prefill)
    }
    window.addEventListener("ai-open", onOpen as EventListener)
    return () => window.removeEventListener("ai-open", onOpen as EventListener)
  }, [setOpen])

  // Global hot-keys must live on the provider (not the lazy panel) so the
  // Ctrl/Cmd+`/` shortcut can OPEN the panel before it has mounted.
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

  const clearRestored = () => setRestoredAt(null)

  return (
    <Context
      value={useMemo<AISearchContextValue>(
        () => ({
          chat,
          open,
          setOpen,
          panelEverOpened,
          input,
          setInput,
          contextDetached,
          setContextDetached,
          restoredAt,
          clearRestored,
          lastRequestId,
          stoppedMessageIds,
          markMessageStopped,
          feedbackByMessage,
          recordFeedback,
        }),
        [
          chat,
          open,
          setOpen,
          panelEverOpened,
          input,
          contextDetached,
          restoredAt,
          lastRequestId,
          stoppedMessageIds,
          markMessageStopped,
          feedbackByMessage,
          recordFeedback,
        ],
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

/**
 * `next/dynamic`-loaded wrapper for the chat panel. The panel pulls in the
 * markdown renderer (remark + rehype + Shiki via DynamicCodeBlock), so we
 * defer that whole chunk until the user actually opens the panel.
 *
 * `ssr: false` is fine — the panel is client-only anyway (uses
 * `localStorage`, `useChat` state, etc.) and is never rendered until the user
 * clicks the trigger.
 */
const LazyAISearchPanel = dynamic(() => import("./panel"), {ssr: false})

/**
 * Mounts the heavy panel only after the user has opened it once. After first
 * open, it stays mounted so the conversation and animations behave normally
 * (closing is a CSS animation driven by `Presence` inside the panel).
 */
export function AISearchPanel() {
  const {panelEverOpened} = useAISearchContext()
  if (!panelEverOpened) return null
  return <LazyAISearchPanel />
}

export function useAISearchContext() {
  return use(Context)!
}

export function useChatContext() {
  return use(Context)!.chat
}
