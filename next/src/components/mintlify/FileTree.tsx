import type {ComponentProps, ReactNode} from "react"
import {File, Folder, Files} from "fumadocs-ui/components/files"

export type FileTreeItem =
  | "..."
  | "…"
  | string
  | {name: string; note?: string; kind: "file"}
  | {
      name: string
      note?: string
      kind: "folder"
      open?: boolean
      items?: FileTreeItem[]
    }

interface FileTreeProps {
  items?: FileTreeItem[]
  defaultOpen?: boolean
}

function renderItem(item: FileTreeItem, index: number, defaultOpen: boolean): ReactNode {
  if (item === "..." || item === "…") {
    return <File key={index} name="…" />
  }

  if (typeof item === "string") {
    return <File key={index} name={item} />
  }

  if (item.kind === "file") {
    if (item.note) {
      return (
        <div key={index}>
          <File name={item.name} />
          <span className="block ps-8 -mt-1 pb-1 text-xs text-fd-muted-foreground">{item.note}</span>
        </div>
      )
    }
    return <File key={index} name={item.name} />
  }

  if (item.kind === "folder") {
    const isOpen = item.open ?? defaultOpen
    return (
      <Folder key={index} name={item.name} defaultOpen={isOpen}>
        {item.note && (
          <span className="block whitespace-pre-line px-2 -mt-0.5 pb-0.5 text-xs text-fd-muted-foreground">{item.note}</span>
        )}
        {item.items?.map((child, childIdx) => renderItem(child, childIdx, defaultOpen))}
      </Folder>
    )
  }

  return null
}

export function FileTree({items = [], defaultOpen = true}: FileTreeProps) {
  return <Files className="[&_svg]:shrink-0">{items.map((item, idx) => renderItem(item, idx, defaultOpen))}</Files>
}

/**
 * Compositional form — content inside folders/files is regular MDX,
 * compiled by the MDX pipeline (links, lists, bold, etc. work natively).
 */
export function Tree({children}: {children?: ReactNode}) {
  return <Files className="[&_svg]:shrink-0">{children}</Files>
}

Tree.Folder = function TreeFolder({children, ...props}: ComponentProps<typeof Folder>) {
  return (
    <Folder {...props}>
      <div className="px-2 mt-0.5 pb-0.5 text-xs text-fd-muted-foreground [&_ul]:list-disc [&_ul]:ps-4 [&_ul]:my-0.5 [&_li]:my-0.5 [&_a]:text-fd-foreground [&_a]:underline">
        {children}
      </div>
    </Folder>
  )
}

Tree.File = function TreeFile({children, ...props}: ComponentProps<typeof File> & {children?: ReactNode}) {
  if (children) {
    return (
      <div>
        <File {...props} />
        <div className="ps-8 mt-0.5 pb-1 text-xs text-fd-muted-foreground">{children}</div>
      </div>
    )
  }
  return <File {...props} />
}
