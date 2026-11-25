import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const diagnosticCategories = ['conversation', 'worker', 'workspace', 'settings', 'voice', 'updates', 'integrations', 'startup'];
const events = new Set(`capture-start capture-end http-start http-body http-finish ui-request ui-response ui-render
  ui-task service-ready coordinator-route coordinator-init coordinator-queue coordinator-dequeue coordinator-ready
  context-start context-end process-spawn process-exit ipc-send ipc-backpressure ipc-drain ipc-reply
  ipc-timeout ipc-frame ipc-decision first-text tool-scheduled tool-start tool-end turn-status interrupt-start
  interrupt-end coordinator-result persist-start persist-end broadcast websocket-pressure worker-route
  worker-queue worker-dequeue worker-binding worker-launch worker-ready worker-exit worker-completion-check receipt-created receipt-state
  composer-state paste-intent paste submit-intent submit native-input worker-completion worker-notice
  storage-start storage-end voice-start voice-end update-state integration-state pressure`.split(/\s+/));
const kinds = new Set(`ok error timeout abort stopped disabled expired complete success failed unsupported
  pending duplicate cold warm connecting work reply direct accepted rejected blocked unconfirmed waiting-ready paste-pending
  submitted-unconfirmed queued idle busy unknown changed running starting exited interrupted detected none
  invalid-json handler-error stale-rpc matched mismatch missing early late ignored observed
  no-active wrong-thread wrong-turn unhandled wrong-tool accepted-unchecked response text final completion
  provider-error provider-retry provider-record clean connected reconnecting downloading downloaded checking available current`.split(/\s+/));
const methods = new Set(`initialize initialized thread/start turn/start turn/interrupt turn/started turn/completed
  item/started item/completed item/tool/call item/agentMessage/delta item/reasoning/summaryTextDelta
  item/reasoning/textDelta thread/tokenUsage/updated thread/status/changed error`.split(/\s+/));
const toolNames = new Set('get_alpha_health list_chats read_chat send_to_chat open_chat read_conversation get_project_settings list_workspace read_workspace list_files preview_file read_release_status record_completion_summary'.split(' '));
const idKeys = ['operation', 'thread', 'turn', 'worker', 'call', 'rpc'];
const numericKeys = ['durationMs', 'count', 'chars', 'bytes', 'depth', 'lagMs', 'cpuMs', 'rssMiB', 'busyPct', 'statusCode'];

export function diagnosticRoute(method, pathname) {
  if (method === 'POST' && /^\/api\/threads\/[\w-]+\/input$/.test(pathname)) return 'conversation';
  if (method === 'POST' && /^\/api\/coordinator$/.test(pathname)) return 'conversation';
  if (/^\/api\/sessions(?:\/|$)/.test(pathname) || (method !== 'GET' && /^\/api\/threads(?:\/|$)/.test(pathname))) return 'worker';
  if (/^\/api\/(?:workspace|files|preview|attachments)(?:\/|$)/.test(pathname)) return 'workspace';
  if (/^\/api\/(?:settings|native-settings)(?:\/|$)/.test(pathname)) return 'settings';
  if (/^\/api\/(?:dictation|transcribe|speech|live|voice)(?:\/|$)/.test(pathname)) return 'voice';
  if (/^\/api\/(?:updates|release-monitor)(?:\/|$)/.test(pathname)) return 'updates';
  if (/^\/api\/(?:integrations|mcp)(?:\/|$)/.test(pathname)) return 'integrations';
  if (pathname === '/api/bootstrap') return 'startup';
  return null;
}

export class PerformanceDiagnostics {
  constructor({ enabled = false, capacity = 1024, armMs = 60000, captureMs = 360000, tailMs = 10000, clock = () => performance.now(), changed = () => {} } = {}) {
    Object.assign(this, { enabled, capacity, armMs, captureMs, tailMs, clock, changed });
    this.capacity = Math.max(4, Math.min(4096, Math.trunc(capacity) || 1024));
    this.active = null;
    this.armed = null;
    this.last = null;
  }

  get activeId() { return this.active?.id ?? null; }

  status() {
    return { enabled: this.enabled, armed: this.armed?.category ?? null,
      active: this.active ? { id: this.active.id, category: this.active.category } : null,
      last: this.last };
  }

  configure(enabled) {
    if (enabled !== true) this.stop('disabled');
    this.enabled = enabled === true;
    this.changed();
    return this.status();
  }

  arm(category) {
    if (!this.enabled || this.active) throw new Error('Enable Performance Diagnostics and stop the current capture before arming another.');
    if (!diagnosticCategories.includes(category)) throw new Error('Choose a diagnostic category.');
    this.stop();
    const timer = setTimeout(() => { this.armed = null; this.changed(); }, this.armMs);
    timer.unref?.();
    this.armed = { category, timer };
    this.changed();
    return this.status();
  }

  begin(category) {
    if (!this.enabled || this.armed?.category !== category) return null;
    clearTimeout(this.armed.timer);
    this.armed = null;
    const capture = { id: randomUUID(), category, key: randomBytes(32), ids: new Map(),
      startedAt: new Date().toISOString(), start: this.clock(), events: [], seq: 0, pending: 1, ui: 0 };
    this.active = capture;
    const current = () => this.enabled && this.active === capture;
    const trace = {
      id: capture.id,
      event: (name, data) => this.record(capture, name, data),
      operation: (id) => { if (current() && typeof id === 'string' && id.length <= 200) capture.operation = id; },
      worker: (id, task) => {
        if (!current() || typeof id !== 'string' || id.length > 200) return;
        if (typeof task === 'string' && task.length > 200) { capture.worker = capture.task = undefined; return; }
        capture.worker = id;
        capture.task = typeof task === 'string' && task.length <= 200 ? task : undefined;
      },
      hold: () => {
        if (current()) capture.pending++;
        let done = false;
        return outcome => {
          if (done || !current()) return;
          done = true;
          this.release(capture, outcome);
        };
      },
      finish: outcome => this.release(capture, outcome),
    };
    capture.trace = trace;
    capture.timer = setTimeout(() => this.stop('expired'), this.captureMs);
    capture.timer.unref?.();
    let tick = this.clock(), cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
    capture.sampler = setInterval(() => {
      const now = this.clock(), nextCpu = process.cpuUsage(), nextLoop = performance.eventLoopUtilization();
      trace.event('pressure', { lagMs: now - tick - 1000, cpuMs: (nextCpu.user + nextCpu.system - cpu.user - cpu.system) / 1000,
        rssMiB: Math.round(process.memoryUsage.rss() / 1048576), busyPct: performance.eventLoopUtilization(nextLoop, loop).utilization * 100 });
      tick = now; cpu = nextCpu; loop = nextLoop;
    }, 1000);
    capture.sampler.unref?.();
    trace.event('capture-start');
    this.changed();
    return trace;
  }

  worker(id, task) {
    const capture = this.active;
    return this.enabled && id && capture?.worker === id && (!capture.task || capture.task === task) ? capture.trace : null;
  }

  client({ captureId, operation, event, durationMs, count }) {
    const capture = this.active;
    if (!this.enabled || !capture || capture.ui >= 24 || !['ui-request', 'ui-response', 'ui-render', 'ui-task'].includes(event)) return;
    if (capture.id !== captureId && (!capture.operation || capture.operation !== operation)) return;
    capture.ui++;
    this.record(capture, event, { operation: capture.operation, durationMs, count });
  }

  record(capture, name, data = {}) {
    if (!this.enabled || this.active !== capture || !events.has(name)) return;
    const entry = { seq: ++capture.seq, ms: Math.max(0, Math.round((this.clock() - capture.start) * 100) / 100), event: name };
    if (kinds.has(data.kind)) entry.kind = data.kind;
    if (['matched', 'mismatch', 'missing', 'early'].includes(data.match)) entry.match = data.match;
    if (methods.has(data.method)) entry.method = data.method;
    if (toolNames.has(data.tool)) entry.tool = data.tool;
    if (diagnosticCategories.includes(data.category)) entry.category = data.category;
    for (const key of numericKeys) {
      const number = data[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1e10) continue;
      const bucket = key === 'chars' ? 256 : key === 'bytes' ? 4096 : 0;
      entry[key] = bucket ? Math.ceil(number / bucket) * bucket : Math.round(number * 100) / 100;
    }
    for (const key of idKeys) {
      const value = data[key];
      if (typeof value === 'string' && value.length && value.length <= 200 || Number.isSafeInteger(value)) {
        const identity = key + '\0' + value;
        let alias = capture.ids.get(identity);
        if (!alias) {
          alias = createHmac('sha256', capture.key).update(identity).digest('hex').slice(0, 16);
          if (capture.ids.size < 128) capture.ids.set(identity, alias);
        }
        entry[key] = alias;
      }
    }
    const initial = Math.floor(this.capacity / 4);
    const index = capture.seq - 1;
    capture.events[index < initial ? index : initial + (index - initial) % (this.capacity - initial)] = entry;
  }

  release(capture, outcome) {
    if (!this.enabled || this.active !== capture || capture.pending < 1) return;
    if (outcome !== 'ok' && kinds.has(outcome)) capture.outcome ??= outcome;
    if (--capture.pending !== 0) return;
    capture.tail = setTimeout(() => this.stop(capture.outcome ?? 'complete'), this.tailMs);
    capture.tail.unref?.();
  }

  stop(reason = 'stopped') {
    clearTimeout(this.armed?.timer);
    this.armed = null;
    const capture = this.active;
    if (capture) {
      this.record(capture, 'capture-end', { kind: reason });
      this.active = null;
      clearTimeout(capture.timer);
      clearTimeout(capture.tail);
      clearInterval(capture.sampler);
      this.last = { schemaVersion: 1, id: capture.id, category: capture.category, startedAt: capture.startedAt,
        outcome: kinds.has(reason) ? reason : 'stopped', durationMs: Math.max(0, Math.round(this.clock() - capture.start)),
        dropped: capture.seq - capture.events.length, events: capture.events.sort((a, b) => a.seq - b.seq) };
      capture.events = [];
      capture.ids.clear();
      capture.key.fill(0);
      capture.worker = capture.operation = capture.task = undefined;
    }
    this.changed();
    return this.status();
  }

  delete() {
    this.last = null;
    this.changed();
    return this.status();
  }
}
