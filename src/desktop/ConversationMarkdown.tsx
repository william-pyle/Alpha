import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useRef, useState } from 'react'
import { api, reportError, setPreview } from './client'
import type { Preview } from './types'

const localPath = (url: string) => /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(url)
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const node = useRef<HTMLPreElement>(null), [copied, setCopied] = useState(false)
  return <div className="message-code"><button onClick={() => void navigator.clipboard.writeText(node.current?.textContent || '').then(() => setCopied(true)).catch(reportError)}>{copied ? 'Copied' : 'Copy code'}</button><pre ref={node}>{children}</pre></div>
}
export default function ConversationMarkdown({ text }: { text: string }) {
  return <div className="conversation-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url, key) => key === 'src' ? '' : localPath(url) ? url : /^(https?:|mailto:|#)/i.test(url) ? defaultUrlTransform(url) : ''} components={{
    img: ({ alt }) => <span className="message-image-reference">[Image: {alt || 'external image'}]</span>,
    a: ({ href, children }) => !href ? <span>{children}</span> : localPath(href) ? <button className="message-file-link" onClick={() => void api<Preview>(`/preview?path=${encodeURIComponent(href.replace(/:\d+$/, ''))}`).then(setPreview).catch(reportError)}>{children}</button> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="message-table"><table>{children}</table></div>,
  }}>{text}</Markdown></div>
}
