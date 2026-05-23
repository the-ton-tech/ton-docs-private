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
