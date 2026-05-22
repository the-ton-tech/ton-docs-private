import type {ComponentProps, ReactNode} from "react"
import {File, Folder, Files} from "fumadocs-ui/components/files"

export type FileTreeItem =
  | "..."
  | "…"
  | string
  | {name: string; note?: string | string[]; kind: "file"}
  | {
      name: string
      note?: string | string[]
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
      const noteStr = Array.isArray(item.note) ? item.note.join(", ") : item.note
      return (
        <div key={index}>
          <File name={item.name} />
          <span className="block ps-8 -mt-1 pb-1 text-xs text-fd-muted-foreground">{noteStr}</span>
        </div>
      )
    }
    return <File key={index} name={item.name} />
  }

  if (item.kind === "folder") {
    const isOpen = item.open ?? defaultOpen
    const noteIsArray = Array.isArray(item.note)
    return (
      <Folder key={index} name={item.name} defaultOpen={isOpen}>
        {item.note && !noteIsArray && (
          <span className="block whitespace-pre-line px-2 -mt-0.5 pb-0.5 text-xs text-fd-muted-foreground">{item.note}</span>
        )}
        {noteIsArray && (() => {
          const lines = item.note as string[]
          const elements: ReactNode[] = []
          let listItems: string[] = []

          const flushList = () => {
            if (listItems.length > 0) {
              elements.push(
                <ul key={`ul-${elements.length}`} className="list-disc px-2 py-0.5 ps-6 text-xs text-fd-muted-foreground">
                  {listItems.map((li, i) => <li key={i} className="my-0.5">{li}</li>)}
                </ul>
              )
              listItems = []
            }
          }

          for (const line of lines) {
            if (line.startsWith("- ")) {
              listItems.push(line.slice(2))
            } else {
              flushList()
              elements.push(
                <span key={`t-${elements.length}`} className="block whitespace-pre-line px-2 -mt-0.5 pb-0.5 text-xs text-fd-muted-foreground">{line}</span>
              )
            }
          }
          flushList()
          return elements
        })()}
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
 * Mintlify exposed a built-in `<Tree>` JSX element accepting `<Tree.Folder>`
 * and `<Tree.File>` children. We re-implement that surface on top of Fumadocs'
 * `Files`, so authors can keep using the compositional form without imports.
 */
export function Tree({children}: {children?: ReactNode}) {
  return <Files className="[&_svg]:shrink-0">{children}</Files>
}

Tree.Folder = function TreeFolder(props: ComponentProps<typeof Folder>) {
  return <Folder {...props} />
}

Tree.File = function TreeFile(props: ComponentProps<typeof File>) {
  return <File {...props} />
}
