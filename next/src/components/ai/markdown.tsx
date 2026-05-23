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
            class: "animate-fd-fade-in",
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

function createProcessor(): Processor {
  const processor = remark().use(remarkGfm).use(remarkRehype).use(rehypeWrapWords)

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

const processor = createProcessor()

export function Markdown({text}: {text: string}) {
  const deferredText = useDeferredValue(text)

  return (
    <Suspense fallback={<p className="invisible">{text}</p>}>
      <Renderer text={deferredText} />
    </Suspense>
  )
}

const cache = new Map<string, Promise<ReactNode>>()

function Renderer({text}: {text: string}) {
  const result = cache.get(text) ?? processor.process(text)
  cache.set(text, result)

  return use(result)
}

interface Source {
  url: string
  title: string
  hostPath: string
}

/** Extract unique markdown links from `text` so they can be listed as sources. */
function extractSources(text: string): Source[] {
  // Strip code regions before matching — links inside fenced or inline code
  // are examples, not citations.
  const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  // Match http(s) URLs greedily up to whitespace; many docs URLs legitimately
  // contain `)` (e.g. Wikipedia-style paths), so we can't stop at `)`.
  const re = /\[([^\]\n]+)\]\((https?:\/\/\S+)\)/g
  // Dedup by a normalized key (strip trailing slash + hash fragment) but
  // keep the first-seen original URL for the rendered link.
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
    try {
      const u = new URL(url, "https://docs.ton.org")
      hostPath = `${u.hostname}${u.pathname}`.replace(/\/+$/, "")
      // Normalize for dedup: drop trailing slash + fragment so `/x`, `/x/`,
      // and `/x#sec` collapse to a single source.
      normalized = `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, "")}${u.search}`
    } catch {
      // Leave hostPath = url for non-parseable hrefs.
    }
    if (seen.has(normalized)) continue
    seen.set(normalized, {url, title: title || hostPath, hostPath})
  }
  return Array.from(seen.values())
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
        {sources.map((source, i) => (
          <li key={source.url}>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex max-w-full items-center gap-1 rounded-full border bg-fd-secondary px-2 py-0.5 text-xs text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent"
            >
              <span className="text-fd-primary">[{i + 1}]</span>
              <span className="truncate">
                {source.title} — {source.hostPath}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
