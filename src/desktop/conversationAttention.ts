import type { AlphaThread, DesktopState } from './types'

export function importantEvents(state: DesktopState) {
  return state.awareness.items.filter(item =>
    ['error', 'attention', 'review', 'health'].includes(item.kind) &&
    !(item.kind === 'review' && item.source === 'Coordinator completion event') &&
    !(item.kind === 'attention' && state.questions.some(question => question.threadId === item.threadId && (!item.sessionId || question.sessionId === item.sessionId))))
}

export function conversationAttention(state: DesktopState, thread: AlphaThread) {
  const questions = state.questions.filter(item => item.threadId === thread.id).length
  const events = importantEvents(state).filter(item => item.threadId === thread.id)
  const errors = events.filter(item => item.kind === 'error').length
  const label = [questions ? `${questions} pending question${questions === 1 ? '' : 's'}` : '', errors ? `${errors} failure${errors === 1 ? '' : 's'} need attention` : '', events.some(item => item.kind === 'attention') ? 'Worker needs input' : '', events.some(item => item.kind === 'review') ? 'Worker result ready for review; not verified' : '', thread.unread ? 'Unread messages' : ''].filter(Boolean).join('. ')
  return { label, count: questions + events.length || (thread.unread ? 1 : 0), question: state.questions.find(item => item.threadId === thread.id) }
}
