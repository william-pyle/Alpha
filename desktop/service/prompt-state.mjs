// Inspect only the visible terminal viewport, never scrollback or transcripts.
// Recognize a prompt plus its interactive choices; prose mentioning trust is not a prompt.
export function startupPrompt(screen) {
  const text = String(screen || '').toLowerCase();
  if (/trust (?:the files|this (?:folder|directory|workspace))|do you trust|is this a project you created/.test(text)
    && /^\s*[^\w\n]*1[.)]\s+yes[, ]/m.test(text)
    && /^\s*[^\w\n]*2[.)]\s+no[, ]/m.test(text)) return 'Folder trust requires your input in Activity.';
  if (/(?:sign in|log in) to (?:codex|claude)/.test(text) && /(?:press enter|sign in with|use an api key)/.test(text)) return 'Sign-in requires your input in Activity.';
  return null;
}
