import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson } from './util.mjs';

const fail = message => Object.assign(new Error(message), { status: 400 });
const base = `Read the active project's AGENTS.md and relevant skills. Preserve its IDs, routes, data and running sessions. Stay within the current task and the user's selected permissions. Ask missing decisions through the agent's question tool so Alpha can route them to Questions. Verify the requested result with appropriate evidence. Report what changed, what was checked and what remains unresolved; a completed turn is not proof that the project works.`;
const templates = [
  { id: 'workspace-upkeep', name: 'Workspace Upkeep', purpose: 'Refresh project records and rebuild their existing Workspace views.', pattern: /\b(rebuild|refresh|update|maintain|publish)\b.{0,100}\b(workspace|project records|report tabs|documentation|docs)\b/i, instructions: 'Find the canonical structured records and the project-specific renderer. Update the records, preserve existing routes, run the documented renderer and inspect the resulting views. Keep unreleased work distinct from shipped features. Do not publish or deploy merely because local rendering succeeded.', starter: true },
  { id: 'build-verification', name: 'Build Verification', purpose: 'Run the relevant build and checks, investigate failures and verify repairs.', pattern: /\b(run|repair|fix|verify|validate|check)\b.{0,70}\b(tests?|lint|typecheck|build|checks|verification)\b/i, instructions: 'Identify the checks appropriate to the actual change. Reproduce a failure before editing. Fix its cause within the authorized task, then rerun affected checks. Distinguish a fixture problem, an environment problem and a product defect. Avoid repeating an already-green full suite without a new reason.', starter: true },
  { id: 'release-preparation', name: 'Release Preparation', purpose: 'Prepare and verify a project release using its own release procedure.', pattern: /\b(prepare|verify|publish|push|cut)\b.{0,50}\b(release|installer|update package)\b/i, instructions: 'Read the project release sequence and inspect the working tree. Finish source, version, documentation and workflow changes before tagging. Use the required CI gate, verify the published assets and distinguish publication from installation. Preserve unrelated edits. Publish, install or restart only within the current user authorization.', starter: true },
  { id: 'interface-review', name: 'Interface Review', purpose: 'Inspect and repair repeated UI layout, usability and accessibility issues.', pattern: /\b(review|check|test|fix|inspect)\b.{0,70}\b(layout|responsive|accessibility|interface|ui)\b/i, instructions: 'Exercise the actual interaction and relevant display sizes. Inspect screenshots and keyboard behavior, then fix demonstrated problems within scope. Check errors, empty states and recovery where they affect the flow. Keep technical work details out of the user-facing conversation.' },
  { id: 'web-deployment', name: 'Web Deployment', purpose: 'Prepare and verify wiki and website deployments, including Cloudflare Pages and Workers.', pattern: /\b(deploy|publish|verify)\b.{0,80}\b(website|wiki|cloudflare|pages|workers|web site)\b/i, instructions: 'Read the actual site configuration and deployment workflow. Distinguish static-site builds, Pages deployments and Workers deployments. Check build output, routes, assets and configured integrations. A successful deploy hook is not proof that the live site updated. After an authorized deployment, verify the target deployment and live result. Keep tokens and webhook URLs private. Do not deploy merely because a preview built successfully.', starter: true },
  { id: 'research-evidence', name: 'Research Evidence', purpose: 'Maintain sourced research and code-based comparisons with clear evidence and uncertainty.', pattern: /\b(research|investigate|compare|verify|refresh)\b.{0,80}\b(sources|evidence|findings|timeline|research|comparison)\b/i, instructions: 'Identify the question, source of truth and date of each claim. Prefer primary sources for technical facts. Separate observed facts, user preferences, inferences and unresolved questions. Preserve stable source references in canonical structured records and rebuild the project views. A static source inventory is not proof of runtime behavior. Do not change an application merely because a comparison identifies a difference.', starter: true },
  { id: 'rust-windows', name: 'Rust Windows Engineering', purpose: 'Develop Windows application behavior in Rust using the active project architecture.', pattern: /\b(implement|develop|build|fix)\b.{0,90}\b(rust|windows app|windows application)\b/i, instructions: 'Read the project architecture, Rust workspace, quality gates and shared-library boundaries. Use existing crates and application flows where appropriate. Review relevant Craft-style interaction references when the owner has chosen them, and explain purposeful deviations. Preserve an existing working UI or service architecture unless migration is in scope. Verify state persistence, errors and the native Windows result as appropriate; compile success alone does not establish usability.', starter: true },
];
export const taskFamily = text => templates.find(item => item.pattern.test(String(text || '').slice(0, 1200)))?.id || null;
const revision = (instructions, reason, version = 1) => ({ version, instructions, reason, createdAt: new Date().toISOString() });

export function outcomeSummary(runs, version) {
  const selected = runs.filter(run => version == null || run.version === version);
  const failures = selected.flatMap(run => (run.feedbackHistory || (run.outcome === 'needs-fix' ? [{ outcome: 'needs-fix', failureKey: run.feedback }] : [])).filter(item => item.outcome === 'needs-fix').map(item => ({ taskId: run.id, key: item.failureKey || 'unspecified' })));
  const groups = new Map();
  for (const failure of failures) { if (!groups.has(failure.key)) groups.set(failure.key, new Set()); groups.get(failure.key).add(failure.taskId); }
  return { runs: selected.length, unverified: selected.filter(run => run.outcome === 'completed-unverified').length, accepted: selected.filter(run => run.outcome === 'accepted').length, verified: selected.filter(run => run.outcome === 'verified' && run.evidence?.reference).length, needsFix: selected.filter(run => run.outcome === 'needs-fix').length, corrections: failures.length, repeatFailures: [...groups].filter(([, ids]) => ids.size > 1).map(([key, ids]) => ({ key, taskIds: [...ids] })) };
}

export class CommonAgents {
  constructor({ stateDir, libraryRoot, changed = () => {}, onError = () => {} }) {
    this.file = path.join(libraryRoot || stateDir, 'common-agents', 'registry.json');
    this.activityFile = path.join(stateDir, 'common-agent-activity.json');
    this.scopeFile = path.join(stateDir, 'common-agent-scope.json');
    this.changed = changed; this.onError = onError; this.agents = []; this.tasks = []; this.pending = new Map(); this.writes = Promise.resolve();
  }
  async init() {
    this.scope = await readJson(this.scopeFile, { excludedProjects: [] });
    const saved = await readJson(this.file, null);
    this.agents = Array.isArray(saved) ? saved.filter(item => typeof item.id === 'string' && Array.isArray(item.versions)) : [];
    const activity = await readJson(this.activityFile, {});
    this.tasks = Array.isArray(activity) ? activity : activity.tasks || [];
    this.pending = new Map((activity.pending || []).map(item => [item.sessionId, item]));
    for (const template of templates.filter(item => item.starter)) if (!this.agents.some(item => item.id === template.id)) this.agents.push(this.fromTemplate(template, 'starter', []));
    await this.persist(); return this;
  }
  fromTemplate(template, origin, evidenceIds) {
    return { id: template.id, name: template.name, purpose: template.purpose, family: template.id, enabled: true, origin, evidenceIds, activeVersion: 1, versions: [revision(`${template.instructions}\n\n${base}`, origin === 'starter' ? 'Reusable starting role.' : 'Repeated completed work across projects.')] };
  }
  persist() {
    this.writes = this.writes.catch(() => {}).then(async () => {
      await saveJson(this.file, this.agents); await saveJson(this.activityFile, { tasks: this.tasks.slice(-500), pending: [...this.pending.values()] }); this.changed();
    }); return this.writes;
  }
  async purgeSessions(ids) {
    if (!ids.size) return;
    for (const id of ids) this.pending.delete(id);
    this.tasks = this.tasks.filter(item => !ids.has(item.sessionId) && !ids.has(item.provenance?.sessionId));
    await this.persist();
  }
  get(id) { const agent = this.agents.find(item => item.id === id); if (!agent) throw fail('Common agent was not found.'); return agent; }
  allows(project, text = '') {
    const source = `${project || ''} ${text}`.toLowerCase().split(/[^a-z0-9-]+/);
    return !(this.scope.excludedProjects || []).some(name => source.includes(name.toLowerCase()));
  }
  async setScope({ excludedProjects }) {
    if (!Array.isArray(excludedProjects) || excludedProjects.length > 100 || excludedProjects.some(value => typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(value))) throw fail('Use project IDs separated by commas.');
    this.scope = { excludedProjects: [...new Set(excludedProjects.map(value => value.toLowerCase()))] };
    await saveJson(this.scopeFile, this.scope); this.changed(); return this.scope;
  }
  list() {
    return this.agents.map(agent => {
      const runs = this.tasks.filter(task => this.allows(task.project, task.task) && task.agentId === agent.id);
      return { ...agent, runs, outcomes: outcomeSummary(runs), versionOutcomes: agent.versions.map(item => ({ version: item.version, ...outcomeSummary(runs, item.version) })), instructions: agent.versions.find(item => item.version === agent.activeVersion)?.instructions || '', maintenanceNeeded: runs.some(task => task.outcome === 'needs-fix' && !task.reviewedAt) };
    });
  }
  patterns() {
    return templates.map(template => {
      const tasks = this.tasks.filter(task => this.allows(task.project, task.task) && task.family === template.id && task.completedAt);
      return { id: template.id, name: template.name, observations: tasks.length, projects: new Set(tasks.map(task => task.project)).size, evidenceIds: tasks.map(task => task.id), agentCreated: this.agents.some(agent => agent.family === template.id) };
    }).filter(item => item.observations);
  }
  candidates() { return this.tasks.filter(task => this.allows(task.project, task.task) && task.completedAt).slice(-60).map(({ id, project, task, family, agentId, version, outcome, feedback, evidence, feedbackHistory, provenance }) => ({ id, project, task, family, agentId, version, outcome, feedback, evidence, feedbackHistory, provenance })); }
  match(text) { const family = taskFamily(text); return family ? this.agents.find(agent => agent.enabled && agent.family === family) || null : null; }
  instructions(id) {
    const agent = this.get(id); if (!agent.enabled) throw fail('This common agent is disabled.');
    return { id, version: agent.activeVersion, text: agent.versions.find(item => item.version === agent.activeVersion).instructions };
  }
  input(session, text, project = session.cwd, agentId) {
    if (!['codex', 'claude'].includes(session.agent) || typeof text !== 'string' || text.trim().length < 12) return;
    const task = text.split('USER-AUTHORIZED TASK:\n').at(-1).trim().slice(0, 1600);
    if (!this.allows(project, task)) return;
    const prior = this.pending.get(session.id);
    if (prior?.task === task) { if (agentId) { const agent = this.get(agentId); prior.agentId = agent.id; prior.version = agent.activeVersion; void this.persist().catch(this.onError); } return prior; }
    const agent = agentId ? this.get(agentId) : null;
    const record = { id: randomUUID(), sessionId: session.id, project: path.normalize(String(project)), task, family: taskFamily(task), agentId: agent?.id || null, version: agent?.activeVersion || null, startedAt: new Date().toISOString(), outcome: 'running' };
    this.pending.set(session.id, record); void this.persist().catch(this.onError); return record;
  }
  async complete(session, event) {
    const record = this.pending.get(session.id); if (!record) return null;
    this.pending.delete(session.id);
    if (!this.allows(record.project, record.task)) { await this.persist(); return null; }
    record.completedAt = new Date().toISOString(); record.completionId = event.id; record.outcome = 'completed-unverified';
    record.provenance = { source: 'native-turn-completed', sessionId: session.id, completionId: event.id || null, agentId: record.agentId, version: record.version };
    record.durationMs = Date.parse(record.completedAt) - Date.parse(record.startedAt);
    this.tasks.push(record); this.tasks = this.tasks.slice(-500);
    for (const pattern of this.patterns()) {
      if (pattern.observations < 3 || pattern.projects < 2 || pattern.agentCreated) continue;
      this.agents.push(this.fromTemplate(templates.find(item => item.id === pattern.id), 'detected', pattern.evidenceIds));
    }
    await this.persist(); return record;
  }
  async create({ name, purpose, instructions, evidenceIds }) {
    if (typeof name !== 'string' || name.trim().length < 3 || name.length > 60 || typeof purpose !== 'string' || purpose.length < 15 || purpose.length > 300) throw fail('Give the agent a short name and a specific purpose.');
    this.validateInstructions(instructions);
    const evidence = this.tasks.filter(task => this.allows(task.project, task.task) && evidenceIds?.includes(task.id) && task.completedAt);
    if (evidence.length < 3 || new Set(evidence.map(task => task.project)).size < 2) throw fail('A new common agent needs at least three completed tasks across two projects.');
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id || this.agents.some(agent => agent.id === id)) throw fail('Choose a distinct common-agent name.');
    const agent = { id, name: name.trim(), purpose: purpose.trim(), enabled: true, origin: 'detected', evidenceIds: evidence.map(task => task.id), activeVersion: 1, versions: [revision(`${instructions.trim()}\n\n${base}`, 'Created from repeated task evidence.')] };
    this.agents.push(agent); await this.persist(); return agent;
  }
  validateInstructions(value) { if (typeof value !== 'string' || value.trim().length < 80 || value.length > 10000) throw fail('Agent instructions must contain between 80 and 10000 characters.'); }
  async revise(id, { instructions, reason, evidenceIds }) {
    const agent = this.get(id); this.validateInstructions(instructions);
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000) throw fail('Explain the evidence and purpose for this revision.');
    if (evidenceIds !== undefined && (!Array.isArray(evidenceIds) || evidenceIds.some(value => typeof value !== 'string'))) throw fail('Use existing task evidence IDs for this role.');
    const evidence = this.tasks.filter(task => task.agentId === id && this.allows(task.project, task.task) && task.completedAt && (evidenceIds ? evidenceIds.includes(task.id) : task.outcome === 'needs-fix' && !task.reviewedAt));
    if (!evidence.length || evidenceIds && evidence.length !== new Set(evidenceIds).size) throw fail('Link this revision to existing task evidence for this role.');
    const version = Math.max(...agent.versions.map(item => item.version)) + 1;
    agent.versions.push({ ...revision(instructions.includes(base) ? instructions.trim() : `${instructions.trim()}\n\n${base}`, reason.trim(), version), evidenceIds: evidence.map(task => task.id), validation: 'awaiting-real-outcome' }); agent.activeVersion = version;
    for (const task of evidence.filter(task => task.outcome === 'needs-fix')) { task.reviewedAt = new Date().toISOString(); task.addressedByVersion = version; }
    await this.persist(); return agent;
  }
  async control(id, { enabled, version }) {
    const agent = this.get(id);
    if (enabled !== undefined) { if (typeof enabled !== 'boolean') throw fail('Choose whether this agent is enabled.'); agent.enabled = enabled; }
    if (version !== undefined) { if (!agent.versions.some(item => item.version === version)) throw fail('Agent version was not found.'); agent.activeVersion = version; }
    await this.persist(); return agent;
  }
  async feedback(id, { outcome, feedback, evidence, failureKey }) {
    const task = this.tasks.find(item => item.id === id); if (!task) throw fail('Task record was not found.');
    if (!this.allows(task.project, task.task)) throw fail('This project is excluded from common-agent automation.');
    if (!['accepted', 'needs-fix', 'verified'].includes(outcome) || typeof feedback !== 'string' || feedback.length > 2000 || outcome === 'needs-fix' && feedback.trim().length < 8) throw fail('Describe the problem or mark the result accepted.');
    if (outcome === 'verified' && (!evidence || !['reference', 'check', 'result', 'sourceRevision'].every(key => typeof evidence[key] === 'string' && evidence[key].trim().length >= 3 && evidence[key].length <= 1000))) throw fail('Verification needs an evidence reference, check, observed result and source revision or artifact identity.');
    if (failureKey != null && (typeof failureKey !== 'string' || failureKey.length > 160)) throw fail('Use a short repeat-failure label.');
    const recordedAt = new Date().toISOString();
    const proof = outcome === 'verified' ? { ...Object.fromEntries(['reference', 'check', 'result', 'sourceRevision'].map(key => [key, evidence[key].trim()])), recordedAt, source: 'owner-recorded-verification', agentId: task.agentId, version: task.version, completionId: task.completionId } : null;
    task.feedbackHistory ||= [];
    if (!task.feedbackHistory.length && task.feedback) task.feedbackHistory.push({ outcome: task.outcome, feedback: task.feedback, recordedAt: null, source: 'legacy-feedback', version: task.version });
    task.feedbackHistory.push({ outcome, feedback: feedback.trim(), failureKey: outcome === 'needs-fix' ? (failureKey || feedback).trim().toLowerCase() : null, evidence: proof, recordedAt, source: 'owner-feedback', version: task.version });
    task.outcome = outcome; task.feedback = feedback.trim(); task.evidence = proof; task.reviewedAt = null; await this.persist(); return task;
  }
  close() { return this.writes.catch(() => {}); }
}
