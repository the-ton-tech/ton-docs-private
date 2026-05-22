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
import {Send, Sparkles, Square, X} from "lucide-react"
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
const AI_BACKEND_URL =
  process.env.NEXT_PUBLIC_AI_BACKEND_URL ?? "https://docs-ton.space/api/chat"

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

const Context = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
  chat: UseChatHelpers<ChatUIMessage>
} | null>(null)

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
          aria-label="Close"
          tabIndex={-1}
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
  const [input, setInput] = useState(() => localStorage.getItem(StorageKeyInput) ?? "")
  const isLoading = status === "streaming" || status === "submitted"
  const onStart = (e?: SyntheticEvent) => {
    e?.preventDefault()
    const message = input.trim()
    if (message.length === 0) return

    void sendMessage({
      role: "user",
      parts: [
        {
          type: "data-client",
          data: {
            location: location.href,
          },
        },
        {
          type: "text",
          text: message,
        },
      ],
    })
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
          localStorage.setItem(StorageKeyInput, e.target.value)
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

function List(props: Omit<ComponentProps<"div">, "dir">) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    function callback() {
      const container = containerRef.current
      if (!container) return

      container.scrollTo({
        top: container.scrollHeight,
        behavior: "instant",
      })
    }

    const observer = new ResizeObserver(callback)
    callback()

    const element = containerRef.current?.firstElementChild

    if (element) {
      observer.observe(element)
    }

    return () => {
      observer.disconnect()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      {...props}
      className={cn("fd-scroll-container overflow-y-auto min-w-0 flex flex-col", props.className)}
    >
      {props.children}
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

function Message({message, ...props}: {message: ChatUIMessage} & ComponentProps<"div">) {
  let markdown = ""
  for (const part of message.parts ?? []) {
    if (part.type === "text") markdown += part.text
  }

  return (
    <div onClick={e => e.stopPropagation()} {...props}>
      <p
        className={cn(
          "mb-1 text-sm font-medium text-fd-muted-foreground",
          message.role === "assistant" && "text-fd-primary",
        )}
      >
        {roleName[message.role] ?? "unknown"}
      </p>
      <div className="prose text-sm">
        <Markdown text={markdown} />
      </div>
    </div>
  )
}

function messageHasText(message: ChatUIMessage): boolean {
  return (message.parts ?? []).some(
    part => part.type === "text" && part.text.trim().length > 0,
  )
}

function LoadingDots() {
  return (
    <span className="flex gap-1 py-1" role="status" aria-label="Generating response">
      <span className="size-1.5 animate-bounce rounded-full bg-fd-muted-foreground [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-fd-muted-foreground [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-fd-muted-foreground" />
    </span>
  )
}

function PendingMessage() {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-fd-primary">{roleName.assistant}</p>
      <LoadingDots />
    </div>
  )
}

export function AISearch({children}: {children: ReactNode}) {
  const [open, setOpen] = useState(false)
  const chat = useChat<ChatUIMessage>({
    id: "search",
    transport: new DefaultChatTransport({
      api: AI_BACKEND_URL,
    }),
  })

  return (
    <Context value={useMemo(() => ({chat, open, setOpen}), [chat, open])}>{children}</Context>
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

export function AISearchPanel() {
  const {open, setOpen} = useAISearchContext()
  useHotKey()

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

export function AISearchPanelList({className, style, ...props}: ComponentProps<"div">) {
  const chat = useChatContext()
  const messages = chat.messages.filter(msg => msg.role !== "system")
  const isLoading = chat.status === "submitted" || chat.status === "streaming"
  const last = messages[messages.length - 1]
  // After a question is sent, show a "thinking" indicator until the first
  // answer text streams in — the backend runs its search tool in between.
  const pending = isLoading && (last?.role !== "assistant" || !messageHasText(last))
  const visibleMessages = messages.filter(
    msg => msg.role !== "assistant" || messageHasText(msg),
  )

  return (
    <List
      className={cn("py-4 overscroll-contain", className)}
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent, white 1rem, white calc(100% - 1rem), transparent 100%)",
        ...style,
      }}
      {...props}
    >
      {messages.length === 0 ? (
        <div className="text-sm text-fd-muted-foreground/80 size-full flex flex-col items-center justify-center text-center gap-2">
          <Sparkles className="size-6 text-fd-muted-foreground/60" />
          <p onClick={e => e.stopPropagation()}>Start a new chat below.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-[13px]">
          {chat.error && (
            <div className="p-2 bg-fd-card text-fd-card-foreground border rounded-xl">
              <p className="text-xs text-fd-error mb-1">
                Request Failed: {chat.error.name}
              </p>
              <p className="text-sm">{chat.error.message}</p>
            </div>
          )}
          {visibleMessages.map(item => (
            <Message key={item.id} message={item} />
          ))}
          {pending && <PendingMessage />}
        </div>
      )}
    </List>
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
