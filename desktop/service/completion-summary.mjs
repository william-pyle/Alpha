export function completionSummary(value, { operationId, threadId }) {
  const strings = (items, key) => {
    if (!Array.isArray(items) || items.length > 8 || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 600)) throw new Error(`Use at most eight concise ${key} entries; retain details in the full report.`);
    return items.map(item => item.trim());
  };
  const changed = strings(value.changed, 'changed'), remaining = strings(value.remaining, 'remaining');
  if (!Array.isArray(value.passed) || value.passed.length > 8 || value.passed.some(item => typeof item?.text !== 'string' || !item.text.trim() || item.text.length > 600 || typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 500)) throw new Error('Each reported check needs its concrete evidence reference.');
  const lifecycle = {};
  for (const key of ['tested', 'published', 'installed', 'observed']) {
    const item = value.lifecycle?.[key];
    if (!item || !['not-done', 'reported', 'unknown'].includes(item.status) || item.status === 'reported' && (typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 500)) throw new Error(`Provide an explicit ${key} status and evidence for reported outcomes.`);
    lifecycle[key] = { status: item.status, evidence: item.status === 'reported' ? item.evidence : null };
  }
  return { changed, passed: value.passed.map(({ text, evidence }) => ({ text, evidence })), remaining, lifecycle, operationId, threadId, at: new Date().toISOString(), source: 'Coordinator structured report', verification: 'reported, not independently verified' };
}
