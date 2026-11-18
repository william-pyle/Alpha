import ConversationMarkdown from './ConversationMarkdown'
import type { ThreadMessage } from './types'
export default function CompletionSummary({ message, pending }: { message: ThreadMessage; pending: boolean }) {
  const summary = message.completionSummary
  if (!summary) return <ConversationMarkdown text={message.text} />
  return <section className="completion-summary"><h3>What changed</h3><ul>{summary.changed.map((item, i) => <li key={i}>{item}</li>)}</ul><h3>What passed</h3>{summary.passed.length ? <ul>{summary.passed.map((item, i) => <li key={i}>{item.text}<small>Reported evidence: {item.evidence}</small></li>)}</ul> : <p>No passing checks recorded.</p>}<h3>What remains</h3><ul>{summary.remaining.map((item, i) => <li key={i}>{item}</li>)}</ul>{pending && <p role="alert">Questions still need your answer.</p>}{message.status === 'failed' && <p role="alert">This operation failed. Review the full result.</p>}<details open={message.status === 'failed' || pending ? true : undefined}><summary>Full report and evidence</summary><p>{summary.source} · {summary.verification}</p><dl>{Object.entries(summary.lifecycle).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value.status}{value.evidence ? `: ${value.evidence}` : ''}</dd></div>)}</dl><small>Operation {summary.operationId} · {summary.at}</small><ConversationMarkdown text={message.text} /></details></section>
}
