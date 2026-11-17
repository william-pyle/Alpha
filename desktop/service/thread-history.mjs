import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { nativeActivity } from './native-events.mjs';

// Caller resolves a known session's exact provider file. Never accept a path
// from a conversation request, and never import tools/thinking/system records.
export async function readNativeConversation(file, agent, sessionId) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const messages = []; let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      let record; try { record = JSON.parse(line); } catch { continue; }
      const event = nativeActivity(record, agent);
      const at = record.timestamp || record.createdAt;
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
      if (event?.kind === 'turn-completed' && event.id && event.message) messages.push({ id: `reply:${sessionId}:${event.id}`, role: 'assistant', text: event.message, at, sessionId, source: 'native-history' });
      const text = event?.kind === 'task-input' ? event.text : event?.taskText;
      if (text) messages.push({ id: `native-user:${sessionId}:${lineNumber}`, role: 'user', text, at, sessionId, source: 'native-history' });
    }
    return messages;
  } finally { lines.close(); input.destroy(); }
}
