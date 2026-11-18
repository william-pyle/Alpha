import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export function completedTurn(record, agent) {
  if (agent === 'codex' && record.type === 'event_msg' && record.payload?.type === 'task_complete') return { kind: 'turn-completed', id: record.payload.turn_id, text: 'The agent finished its turn. Review the result.', preview: String(record.payload.last_agent_message || '').slice(-350), message: String(record.payload.last_agent_message || '') };
  // Claude writes thinking and text as separate records with the same message ID
  // and stop reason. Only the actual final answer creates a completion notice.
  if (agent === 'claude' && !record.isSidechain && record.type === 'assistant' && record.message?.stop_reason === 'end_turn' && record.message.content?.some(item => item.type === 'text')) {
    const message = record.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return { kind: 'turn-completed', id: record.message.id, text: 'The agent finished its turn. Review the result.', preview: message.slice(-350), message };
  }
  if (agent === 'claude' && !record.isSidechain && record.type === 'system' && record.subtype === 'api_error') return { kind: 'turn-failed', text: 'The agent reported an API error.' };
  return null;
}

export function nativeActivity(record, agent) {
  const event = activity(record, agent);
  return event ? { ...event, source: 'provider-record', at: record.timestamp || record.createdAt, nativeTaskId: record.payload?.turn_id || event.nativeTaskId || null, eventKey: createHash('sha256').update(JSON.stringify(record)).digest('hex') } : null;
}
function activity(record, agent) {
  // Codex 0.169 writes submitted text as a user response item, with provenance
  // distinguishing owner text from injected environment/AGENTS instructions.
  if (agent === 'codex' && record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
    const meta = record.payload.internal_chat_message_metadata_passthrough;
    const text = record.payload.content?.filter((item, index) => item.type === 'input_text' && meta?.content_item_kinds?.[index] === 'user.text' && meta?.content_item_metadata?.[index]?.provenance?.type === 'user').map(item => item.text).join('\n');
    if (text) return { kind: 'task-input', text, nativeTaskId: meta.turn_id || null };
  }
  const completed = completedTurn(record, agent);
  if (completed) return completed;
  if (agent === 'codex' && record.type === 'response_item' && record.payload?.type === 'function_call' && ['request_user_input', 'request_user_input_async', 'ask_user_question'].includes(record.payload.name)) {
    try {
      const input = typeof record.payload.arguments === 'string' ? JSON.parse(record.payload.arguments) : record.payload.arguments;
      if (Array.isArray(input?.questions)) return { kind: 'question', id: record.payload.call_id, questions: input.questions.map(item => ({ text: item.question || item.title, options: item.options || [] })) };
    } catch { /* The CLI may write a partial or invalid tool payload. */ }
  }
  if (agent === 'claude' && !record.isSidechain && record.type === 'assistant') {
    const ask = record.message?.content?.find(item => item.type === 'tool_use' && item.name === 'AskUserQuestion');
    if (ask && Array.isArray(ask.input?.questions)) return { kind: 'question', id: ask.id, questions: ask.input.questions.map(item => ({ text: item.question, options: item.options || [] })) };
  }
  if (agent === 'codex' && record.type === 'event_msg') {
    if (record.payload?.type === 'user_message' && typeof record.payload.message === 'string') return { kind: 'task-input', text: record.payload.message };
    if (record.payload?.type === 'task_started') return { kind: 'turn-started' };
    if (record.payload?.type === 'error') return { kind: 'turn-failed', text: 'The native provider reported an error.' };
    if (record.payload?.type === 'turn_aborted') return { kind: 'turn-interrupted' };
  }
  if (agent === 'claude' && !record.isSidechain) {
    if (record.type === 'user' && !record.isMeta) {
      const content = record.message?.content;
      const interrupted = value => typeof value === 'string' && value.startsWith('[Request interrupted by user');
      if (interrupted(content) || Array.isArray(content) && content.some(item => item.type === 'text' && interrupted(item.text))) return { kind: 'turn-interrupted' };
      // Tool results also confirm ongoing work; file snapshots and metadata do not.
      if (content) {
        const taskText = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
        return { kind: 'turn-started', ...(taskText ? { taskText } : {}) };
      }
    }
    if (record.type === 'assistant' && record.message?.stop_reason !== 'end_turn') return { kind: 'turn-started' };
  }
  return null;
}

// Only read records appended after this managed session starts. These files belong
// to the native CLI; MR-MAK never modifies them or replaces the user's hooks.
export function tailNativeFile(file, agent, onEvent, from = 0) {
  let offset = from, partial = '', closed = false, reading = false, decoder = new StringDecoder('utf8');
  const tick = async () => {
    if (closed || reading) return;
    reading = true;
    try {
      const info = await stat(file);
      if (info.size < offset) { offset = 0; partial = ''; decoder = new StringDecoder('utf8'); }
      if (info.size === offset) return;
      if (info.size - offset > 4 * 1024 * 1024) { offset = info.size - 4 * 1024 * 1024; partial = ''; decoder = new StringDecoder('utf8'); }
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(info.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        const lines = (partial + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        partial = lines.pop() || '';
        for (const line of lines) {
          try { const event = nativeActivity(JSON.parse(line), agent); if (event && !closed) onEvent(event); } catch { /* Partial records are ignored, never guessed. */ }
        }
      } finally { await handle.close(); }
    } catch { /* CLI may not have created its transcript yet. */ }
    finally { reading = false; }
  };
  let watcher;
  try { watcher = watch(file, { persistent: false }, () => void tick()); watcher.on('error', () => { watcher?.close(); watcher = null; }); } catch { /* The watchdog also detects creation and missed filesystem notifications. */ }
  const timer = setInterval(tick, 2000); timer.unref(); tick();
  return () => { closed = true; clearInterval(timer); watcher?.close(); };
}

export async function claudeTranscript(cwd, nativeId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const escaped = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const folders = await readdir(root).catch(() => []);
  const folder = folders.find(item => item.toLowerCase() === escaped) || cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(root, folder, `${nativeId}.jsonl`);
}

export { codexTranscript } from './codex-history.mjs';
