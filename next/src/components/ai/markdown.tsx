"use client"
import {remark} from "remark"
import remarkGfm from "remark-gfm"
import remarkRehype from "remark-rehype"
import {toJsxRuntime} from "hast-util-to-jsx-runtime"
import {
  Children,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  Suspense,
  use,
  useDeferredValue,
  useMemo,
  useState,
} from "react"
import {Fragment, jsx, jsxs} from "react/jsx-runtime"
import {DynamicCodeBlock} from "fumadocs-ui/components/dynamic-codeblock"
import defaultMdxComponents from "fumadocs-ui/mdx"
import {visit} from "unist-util-visit"
import type {ElementContent, Root, RootContent} from "hast"
import {Check, Copy} from "lucide-react"
import {cn} from "../../lib/cn"

export interface Processor {
  process: (content: string) => Promise<ReactNode>
}

export function rehypeWrapWords() {
  return (tree: Root) => {
    visit(tree, ["text", "element"], (node, index, parent) => {
      if (node.type === "element" && node.tagName === "pre") return "skip"
      if (node.type !== "text" || !parent || index === undefined) return

      const words = node.value.split(/(?=\s)/)

      // Create new span nodes for each word and whitespace
      const newNodes: ElementContent[] = words.flatMap(word => {
        if (word.length === 0) return []

        return {
          type: "element",
          tagName: "span",
          properties: {
            // `motion-reduce:` honors `prefers-reduced-motion: reduce`.
            class: "animate-fd-fade-in motion-reduce:animate-none",
          },
          children: [{type: "text", value: word}],
        }
      })

      Object.assign(node, {
        type: "element",
        tagName: "span",
        properties: {},
        children: newNodes,
      } satisfies RootContent)
      return "skip"
    })
  }
}

// The docs `.prose` heading scale is tuned for full-width articles and looks
// oversized in the narrow chat column. Inline styles override `.prose` here.
const compactHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  function Heading(props: ComponentProps<"h2">) {
    return (
      <Tag
        {...props}
        style={{
          marginTop: "0.875rem",
          marginBottom: "0.25rem",
          fontSize: "0.9375rem",
          fontWeight: 600,
          lineHeight: 1.4,
        }}
      />
    )
  }

function createProcessor({wrapWords = true}: {wrapWords?: boolean} = {}): Processor {
  // While streaming we render hundreds of intermediate snapshots per answer;
  // `rehypeWrapWords` emits one <span> per word, so a 2000-word answer adds
  // ~2000 nodes per snapshot of pure fade-in chrome. Skip it on the streaming
  // path and only run the fade pass once, on the final snapshot.
  const base = remark().use(remarkGfm).use(remarkRehype)
  const processor = wrapWords ? base.use(rehypeWrapWords) : base

  return {
    async process(content) {
      const nodes = processor.parse({value: content})
      const hast = await processor.run(nodes)

      return toJsxRuntime(hast, {
        development: false,
        jsx,
        jsxs,
        Fragment,
        components: {
          ...defaultMdxComponents,
          a: Anchor,
          pre: Pre,
          img: undefined, // use JSX
          h1: compactHeading("h1"),
          h2: compactHeading("h2"),
          h3: compactHeading("h3"),
          h4: compactHeading("h4"),
          h5: compactHeading("h5"),
          h6: compactHeading("h6"),
        },
      })
    },
  }
}

function CodeCopyButton({text}: {text: string}) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label={copied ? "Code copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard?.writeText(text)?.then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
      className={cn(
        "absolute top-2 end-2 z-10 inline-flex items-center justify-center rounded-md border bg-fd-card/80 p-1.5 text-fd-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-fd-foreground group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function Pre(props: ComponentProps<"pre">) {
  const code = Children.only(props.children) as ReactElement
  const codeProps = code.props as ComponentProps<"code">
  const content = codeProps.children
  if (typeof content !== "string") return null

  let lang =
    codeProps.className
      ?.split(" ")
      .find(v => v.startsWith("language-"))
      ?.slice("language-".length) ?? "text"

  if (lang === "mdx") lang = "md"

  const trimmed = content.trimEnd()

  return (
    <div className="group relative">
      <CodeCopyButton text={trimmed} />
      <DynamicCodeBlock lang={lang} code={trimmed} />
    </div>
  )
}

// Citations come back as absolute docs URLs (https://docs.ton.org/...).
// Rewrite links that point at the docs site itself to a root-relative path so
// following a citation is a client-side navigation — it keeps the chat panel
// and conversation alive instead of full-reloading the page. Genuine external
// links fall through to the fumadocs default (which opens a new tab).
const INTERNAL_DOCS_HOSTS = ["docs.ton.org", "docs-ton.space"]

function internalDocsPath(href: string): string | null {
  let url: URL
  try {
    url = new URL(href, "https://docs.ton.org")
  } catch {
    return null
  }
  const isInternal =
    INTERNAL_DOCS_HOSTS.includes(url.hostname) ||
    (typeof window !== "undefined" && url.hostname === window.location.hostname)
  if (!isInternal) return null
  return `${url.pathname}${url.search}${url.hash}`
}

function Anchor({href, ...props}: ComponentProps<"a">) {
  const internal = typeof href === "string" ? internalDocsPath(href) : null
  const DefaultAnchor = defaultMdxComponents.a ?? "a"
  return <DefaultAnchor href={internal ?? href} {...props} />
}

const finalProcessor = createProcessor()
const streamingProcessor = createProcessor({wrapWords: false})

export function Markdown({text, streaming = false}: {text: string; streaming?: boolean}) {
  const deferredText = useDeferredValue(text)

  return (
    // Fallback was previously the entire raw markdown wrapped in `invisible`,
    // which reserved layout space sized to the raw string length (CLS when the
    // rendered JSX is shorter), polluted screen readers, and made copy-paste
    // capture markup. A non-breaking space + aria-hidden is enough to keep
    // Suspense happy without surfacing any content.
    <Suspense fallback={<p className="invisible" aria-hidden="true">{"\u00A0"}</p>}>
      <Renderer text={deferredText} streaming={streaming} />
    </Suspense>
  )
}

// Bounded LRU. Previously a module-level Map with no eviction: a 1500-token
// answer produced ~1500 distinct keys (one per prefix snapshot) and held them
// for the session's lifetime. Cap is generous enough to keep recent snapshots
// for back-scrolling without unbounded growth across a long session. Keys
// distinguish streaming vs final renders because the two processors produce
// different node trees.
const CACHE_MAX = 64
const cache = new Map<string, Promise<ReactNode>>()

function cacheGet(key: string): Promise<ReactNode> | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cachePut(key: string, value: Promise<ReactNode>): void {
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, value)
}

function Renderer({text, streaming}: {text: string; streaming: boolean}) {
  const proc = streaming ? streamingProcessor : finalProcessor
  const key = `${streaming ? "s" : "f"}:${text}`
  let result = cacheGet(key)
  if (!result) {
    result = proc.process(text)
    cachePut(key, result)
  }
  return use(result)
}

interface Source {
  url: string
  title: string
  hostPath: string
  /** Parsed `#fragment` (without the `#`), if present. */
  hash: string | null
}

/** Turn a slug-style hash like `my-section_2` into a human "My Section 2". */
function humanizeHash(hash: string): string {
  const cleaned = decodeURIComponent(hash.replace(/^#/, "")).replace(/[-_]+/g, " ").trim()
  if (cleaned.length === 0) return ""
  return cleaned
    .split(/\s+/)
    .map(w => (w.length === 0 ? "" : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
}

/** Extract unique markdown links from `text` so they can be listed as sources. */
function extractSources(text: string): Source[] {
  // Strip code regions before matching — links inside fenced or inline code
  // are examples, not citations.
  const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  // Match http(s) URLs greedily up to whitespace; many docs URLs legitimately
  // contain `)` (e.g. Wikipedia-style paths), so we can't stop at `)`.
  const re = /\[([^\]\n]+)\]\((https?:\/\/\S+)\)/g
  // Dedup by a normalized key that INCLUDES the hash fragment, so two
  // different sections of the same page remain distinct sources.
  const seen = new Map<string, Source>()
  let match: RegExpExecArray | null
  while ((match = re.exec(stripped)) !== null) {
    const title = match[1].trim()
    let url = match[2].trim()
    // Walk back over trailing sentence punctuation that the greedy `\S+`
    // swept up: `[foo](https://x/y).` should yield `https://x/y`.
    while (url.length > 0 && /[.,;:)]/.test(url[url.length - 1])) {
      url = url.slice(0, -1)
    }
    if (url.length === 0) continue
    let hostPath = url
    let normalized = url
    let hash: string | null = null
    try {
      const u = new URL(url, "https://docs.ton.org")
      hostPath = `${u.hostname}${u.pathname}`.replace(/\/+$/, "")
      // Dedup key: trim trailing slashes from pathname, KEEP search + hash so
      // `/x#a` and `/x#b` are distinct sources.
      normalized = `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`
      hash = u.hash ? u.hash.slice(1) : null
    } catch {
      // Leave hostPath = url for non-parseable hrefs.
    }
    if (seen.has(normalized)) continue
    seen.set(normalized, {url, title: title || hostPath, hostPath, hash})
  }
  return Array.from(seen.values())
}

/**
 * Strip the model's own trailing "Sources" list from an assistant answer so
 * it isn't rendered twice — once as Markdown bullets and again as the pill
 * row produced by `SourcesBlock`. The model emits the section in several
 * shapes despite the system prompt asking for `## Sources`:
 *   - `## Sources` / `### Sources`           (H2/H3 heading)
 *   - `**Sources:**` / `**Sources**`         (bold label, inline or own line)
 *   - `Sources:`                              (plain label)
 * We match any of those at the start of a line near the end of the message
 * and drop everything from that label to EOF.
 */
export function stripTrailingSources(text: string): string {
  const re = /\n[ \t]*(?:#{1,6}[ \t]*Sources\b[^\n]*|\*{1,2}\s*Sources\s*:?\s*\*{1,2}[^\n]*|Sources\s*:)[\s\S]*$/i
  return text.replace(re, "").trimEnd()
}

/** Compact list of inline citations rendered below an assistant answer. */
export function SourcesBlock({text}: {text: string}) {
  // Memoize: the parent `Message` re-renders on every chat status tick during
  // streaming, but `text` is stable once the answer settles.
  const sources = useMemo(() => extractSources(text), [text])
  if (sources.length === 0) return null
  return (
    <div className="mt-3 border-t pt-2">
      <h3 className="mb-1 text-xs font-semibold text-fd-muted-foreground">Sources</h3>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((source, i) => {
          const sectionLabel = source.hash ? humanizeHash(source.hash) : ""
          // Reuse the existing internal/external detection so internal
          // docs.ton.org links stay in the SPA (no `target="_blank"` —
          // keeps the chat panel and conversation alive on click).
          const internalHref = internalDocsPath(source.url)
          const isInternal = internalHref !== null
          const linkProps: ComponentProps<"a"> = isInternal
            ? {href: internalHref ?? source.url}
            : {href: source.url, target: "_blank", rel: "noreferrer noopener"}
          return (
            <li key={source.url} className="flex min-w-0 max-w-full">
              <a
                {...linkProps}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-fd-secondary px-2 py-0.5 text-xs text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent"
              >
                <span className="text-fd-primary">[{i + 1}]</span>
                <span className="truncate">
                  {source.title} — {source.hostPath}
                  {sectionLabel ? ` — ${sectionLabel}` : ""}
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
