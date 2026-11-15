"use client"

import { memo, type ComponentProps } from "react"
import { Streamdown } from "streamdown"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { cn } from "@/lib/utils"

/** A fenced block, with highlighting and a copy button. */
export function Fence({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedCode(code, language || "text")
  return (
    <CodeBlock size="sm" className="my-3" data-testid="code-block" data-language={language}>
      {language && (
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono text-xs text-muted-foreground">{language}</CodeBlockTitle>
        </CodeBlockHeader>
      )}
      <CodeBlockActions>
        <CodeBlockCopyButton value={code.replace(/\n$/, "")} />
      </CodeBlockActions>
      <CodeBlockContent wrap>
        {lines.map((line, i) => (
          <span key={i} className="block min-h-lh">
            {line}
          </span>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

type CodeProps = ComponentProps<"code"> & { node?: unknown }

function Code({ className, children, node: _node, ...rest }: CodeProps) {
  const language = /language-([\w+-]+)/.exec(className ?? "")?.[1]
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : ""
  // A fence has a language class or spans lines; inline code is neither.
  if (language || text.includes("\n")) return <Fence code={text} language={language ?? ""} />
  return (
    <code {...rest} className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)}>
      {children}
    </code>
  )
}

const components = {
  code: Code,
  // The fence draws its own box; Streamdown's wrapper around it is not needed.
  pre: ({ children }: ComponentProps<"pre">) => <>{children}</>,
}

/**
 * Markdown as the agent wrote it. While `streaming`, Streamdown completes what is half written and
 * re-renders only the block that is still changing.
 */
export const Markdown = memo(function Markdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      components={components}
      controls={false}
      className={cn("chat-markdown text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
    >
      {text}
    </Streamdown>
  )
})
