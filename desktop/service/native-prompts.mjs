import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Adapter for Codex's numbered update and folder-trust pickers. Numeric keys
// are not a generic menu protocol. Unknown providers/menus stay in the terminal.
// Contracts: codex rust-v0.169.1 tui/src/{update_prompt,onboarding/trust_directory}.rs.
export function nativePrompt(agent, view) {
  if (agent !== 'codex') return null;
  const lines = (view.lines || []).map(line => line.trimEnd());
  const screen = lines.join('\n').trim();
  if (!screen || /(?:password|sign in|log in|api key|device code)/i.test(screen)) return null;
  const choices = lines.flatMap(line => {
    const match = /^\s*(?:[›❯>]\s*)?([1-9])[.)]\s+(.+?)\s*$/.exec(line);
    return match ? [{ key: match[1], label: match[2] }] : [];
  });
  if (choices.length < 2 || choices.some((c, i) => c.key !== String(i + 1))) return null;
  if (!lines.some(line => /^\s*[›❯>]\s*[1-9][.)]\s/.test(line))) return null;
  if (!/(?:enter|↵).*?(?:continue|confirm|select|submit)/i.test(screen)) return null;
  let kind;
  if (/^\s*Update available\b/m.test(screen)
      && screen.includes('https://github.com/openai/codex/releases/latest')
      && choices.length === 3 && /^Update now \(runs `.+`\)$/.test(choices[0].label)
      && choices[1].label === 'Skip' && choices[2].label === 'Skip until next version'
      && !/trust|permission|approve|sandbox/i.test(screen)) kind = 'update';
  else if (/Trust this folder\?|Do you trust (?:the files|this)|Is this a project you created/i.test(screen)
      && choices.length === 2
      && /^(?:Trust and continue|Yes, (?:I trust this folder|proceed))$/.test(choices[0].label)
      && /^(?:Quit|No, (?:exit|quit))$/.test(choices[1].label)
      && /(?:[A-Za-z]:[\\/]|\/)[^\n]+/.test(screen)) kind = 'trust';
  else if (view.questions?.id && ['request_user_input', 'request_user_input_async'].includes(view.questions.tool)
      && !/to clear notes|type your answer|password|secret/i.test(screen)) {
    const flat = screen.replace(/\s+/g, ' ');
    const question = view.questions.items.find(item => flat.includes(String(item.text).replace(/\s+/g, ' '))
      && item.options.length >= 2 && item.options.length === choices.length
      && item.options.every((option, i) => (typeof option === 'string' ? option : option.label) === choices[i].label));
    // Only complete, fully visible choice lists. Freeform/Other, custom
    // keymaps, notes focus and truncated questions remain native interactions.
    if (!question || !/(?:enter|↵)\s+(?:to )?submit/i.test(screen) || !/tab\s+(?:to add )?notes/i.test(screen)) return null;
    kind = 'question';
  } else return null;
  // Highlight movement is expected while selecting, but every other visible
  // character (including directory, version and disclosure) binds the answer.
  const context = lines.map(line => line.replace(/^(\s*)[›❯>]\s*(?=[1-9][.)])/, '$1').trim()).filter(Boolean).join('\n');
  return { kind, text: kind === 'update' ? 'Codex update available' : kind === 'trust' ? 'Trust this folder?' : 'Native question', context, choices, sourceId: kind === 'question' ? view.questions.id : null, fingerprint: digest(context + (kind === 'question' ? view.questions.id : '')) };
}

export class NativePrompts {
  constructor({ view, ready, wait = sleep, clock = Date.now, timeout = 4000 }) {
    Object.assign(this, { view, ready, wait, clock, timeout });
    this.states = new Map(); this.active = new Map();
  }
  observe(session, view) {
    const prompt = nativePrompt(session.agent, view), prior = this.states.get(session.id);
    const same = prior && prior.process === session.process && prior.nativeId === (session.nativeId || null)
      && prior.threadId === (session.alphaThreadId || session.id) && prior.prompt?.fingerprint === prompt?.fingerprint;
    if (same) return prior;
    const state = { process: session.process, sessionId: session.id, nativeId: session.nativeId || null,
      threadId: session.alphaThreadId || session.id, generation: randomUUID(), prompt, since: this.clock() };
    this.states.set(session.id, state); return state;
  }
  async inspect(session) { return this.observe(session, await this.view(session)); }
  binding(state) { return { sessionId: state.sessionId, nativeId: state.nativeId, threadId: state.threadId, generation: state.generation, fingerprint: state.prompt.fingerprint }; }
  matches(session, binding, state) {
    return session.status === 'running' && !!session.process && state.process === session.process && !!state.prompt
      && Object.entries(binding).every(([key, value]) => (key === 'fingerprint' ? state.prompt.fingerprint : state[key]) === value);
  }
  async answer(session, binding, answer, receipt, persist, { automatic = false } = {}) {
    if (this.active.has(session.id)) throw new Error('An answer is already being checked for this terminal.');
    this.active.set(session.id, true);
    try {
      let state = await this.inspect(session);
      if (!this.matches(session, binding, state)) throw new Error('The native prompt changed. Review the current terminal question.');
      const choice = state.prompt.choices.find(item => item.label === answer);
      if (!choice) throw new Error('Choose one of the actual native options.');
      if (state.prompt.kind === 'update' && choice.label !== 'Skip') throw new Error('Updates are deferred during active work. Choose Skip; use the native terminal after work to update.');
      if (automatic && (state.prompt.kind !== 'update' || choice.label !== 'Skip')) throw new Error('Only an optional update Skip can be automatic.');
      if (receipt.intentAt) throw new Error('This answer was already attempted. Inspect the terminal; it will not be replayed.');
      const target = session.process, manual = session.manualInputRevision || 0;
      const unchanged = () => session.id === binding.sessionId && session.process === target && (session.nativeId || null) === binding.nativeId && (session.alphaThreadId || session.id) === binding.threadId && (session.manualInputRevision || 0) === manual;
      await this.wait(200);
      state = await this.inspect(session);
      if (!unchanged() || !this.matches(session, binding, state)) throw new Error('The native prompt changed before delivery.');
      receipt.intentAt = this.clock(); receipt.answer = answer;
      await persist();
      state = await this.inspect(session);
      if (!unchanged() || !this.matches(session, binding, state)) throw new Error('The native prompt changed before delivery. No key sent.');
      receipt.sentAt = this.clock();
      target.write(choice.key);
      // Trust's first key only highlights. Revalidate before the separate
      // confirmation; never send a trailing Enter into the next prompt.
      if (state.prompt.kind === 'trust' && choice.key === '1') {
        await this.wait(150);
        state = await this.inspect(session);
        if (!unchanged() || !this.matches(session, binding, state)) throw new Error('Trust prompt changed before confirmation. Inspect the terminal.');
        target.write('\r');
      }
      const deadline = this.clock() + this.timeout;
      const exiting = state.prompt?.kind === 'trust' && choice.key === '2';
      let nextKey, nextSince;
      while (this.clock() < deadline) {
        await this.wait(100);
        if (exiting && session.process === null && session.status === 'exited' && session.exitCode === 0 && (session.manualInputRevision || 0) === manual) {
          receipt.acceptedAt = this.clock(); receipt.evidence = 'Native process exited successfully after Quit';
          await persist(); return { delivered: true, accepted: true, sessionId: session.id, evidence: receipt.evidence };
        }
        if (!unchanged()) break;
        const view = await this.view(session); state = this.observe(session, view);
        // A blank/redrawing screen is not acceptance. Require a stable next
        // supported prompt or positively recognized native message composer.
        const key = state.prompt && state.prompt.fingerprint !== binding.fingerprint ? state.prompt.fingerprint : !state.prompt && this.ready(session, view) ? 'composer' : null;
        if (key !== nextKey) { nextKey = key; nextSince = this.clock(); }
        if (key && this.clock() - nextSince >= 200 && unchanged()) {
          receipt.acceptedAt = this.clock(); receipt.evidence = key === 'composer' ? 'Native composer observed' : 'Next native prompt observed';
          await persist(); return { delivered: true, accepted: true, sessionId: session.id, evidence: receipt.evidence };
        }
      }
      throw new Error('Answer sent once, but the next native state was not verified. Use the terminal; Alpha will not replay it.');
    } finally { this.active.delete(session.id); }
  }
}
