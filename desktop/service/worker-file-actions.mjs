import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { assertPrivateProjectRoot } from './project-layout.mjs';
import { accessFailure, isOsAccessError, nativeFailure, nativeWaitFailure } from './worker-native-access.mjs';

const actions = new Set(['copy-file', 'modify-file']);
const revisionValue = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const targetIdValue = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const projectIdValue = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
const fail = (status, message) => Object.assign(new Error(message), { status });
const filePolicy = message => accessFailure(403, message, 'policy');
const classifyProjectAccess = error => {
  if (isOsAccessError(error)) throw accessFailure(403, 'Windows denied access to the project Workspace.', 'os-permission');
  throw error;
};
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function eligibleName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}\.md$/i.test(name)) return false;
  const stem = name.slice(0, -3).toLowerCase();
  return !/^(agents|con|prn|aux|nul|(?:com|lpt)[0-9])$/.test(stem)
    && !/(secret|credential|password|token|private[_-]?key|api[_-]?key|signing|oauth|(^|[-_])auth($|[-_]))/.test(stem);
}

function fileTarget(key, projectId, filename) {
  const hash = createHmac('sha256', key).update(JSON.stringify([projectId, filename.toLowerCase()])).digest('hex');
  return { id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`, projectId, filename };
}

export class WorkerFileActions {
  constructor({ projectStore, projectStorage, send, projectAllowed, changed = () => {} }) {
    Object.assign(this, { projectStore, projectStorage, send, projectAllowed, changed });
    this.pending = new Map();
    this.targetKey = randomBytes(32);
  }

  validate(action, args, targetId) {
    if (!actions.has(action) || !targetIdValue(targetId)) return false;
    return action === 'copy-file'
      ? shape(args, ['destinationProjectId', 'expectedRevision']) && projectIdValue(args.destinationProjectId) && revisionValue(args.expectedRevision)
      : shape(args, ['expectedRevision', 'edit']) && revisionValue(args.expectedRevision) && args.edit === 'ensure-final-newline';
  }

  async project(id) {
    if (!projectIdValue(id) || !this.projectAllowed(id)) throw filePolicy('This project is outside the file request scope.');
    const project = await this.projectStore.get(id, { allowRemoved: false }).catch(classifyProjectAccess);
    this.projectStorage.assertAvailable(id);
    const roots = await assertPrivateProjectRoot(this.projectStore.repo, id).catch(error => {
      if (error.status === 403 || error.status === 400) return null;
      if (isOsAccessError(error)) return classifyProjectAccess(error);
      throw accessFailure(503, 'Alpha could not check the project Workspace.', 'host-unavailable');
    });
    if (!roots || project.workspacePath !== roots.workspacePath) throw filePolicy('File requests require a canonical private project Workspace.');
    return project;
  }

  targets(project) {
    const names = new Map();
    for (const step of project.steps || []) {
      if (!step || step.removed || step.removedAt || !eligibleName(step.path)) continue;
      const key = step.path.toLowerCase();
      if (names.has(key) && names.get(key) !== step.path) names.set(key, '');
      else names.set(key, step.path);
    }
    return [...names.values()].filter(Boolean).map(filename => fileTarget(this.targetKey, project.id, filename));
  }

  async list(origin) {
    return this.listOwner(origin.projectId).catch(() => []);
  }

  async listOwner(projectId) {
    const project = await this.project(projectId);
    const candidates = this.targets(project).slice(0, 16);
    const targets = [];
    for (const candidate of candidates) {
      const revision = await this.inspect(candidate).catch(error => {
        if (error.status === 503) throw error;
        return null;
      });
      if (revision) targets.push({ id: candidate.id, kind: 'file', projectId, label: candidate.filename, revision });
    }
    return targets;
  }

  async registeredSource(targetId, homeId, destinationId) {
    // Exact handles can be provided by the owner. Worker inventory is home-only.
    const mayUseExternalSource = !destinationId || destinationId === homeId;
    const { entities } = await this.projectStore.workspace.registry().catch(classifyProjectAccess);
    for (const project of entities) {
      const { id, workspacePath, removedAt, deletionPending } = project;
      if ((!mayUseExternalSource && id !== homeId) || !workspacePath || removedAt || deletionPending || !projectIdValue(id)) continue;
      const match = this.targets(project).find(item => item.id === targetId);
      if (match) return match;
    }
    throw fail(404, 'The exact registered Markdown file is unavailable.');
  }

  async source(targetId, homeId, destinationId) {
    const source = await this.registeredSource(targetId, homeId, destinationId);
    const project = await this.project(source.projectId);
    const exact = this.targets(project).find(target => target.id === targetId);
    if (!exact) throw fail(404, 'The exact registered Markdown file is unavailable.');
    return exact;
  }

  intent(origin, action, args, source) {
    return createHash('sha256').update(JSON.stringify([
      action, origin.projectId, source.projectId, source.filename.toLowerCase(), args.destinationProjectId, args.edit,
    ])).digest('hex');
  }

  async resolveIntent(origin, action, args, targetId) {
    if (!this.validate(action, args, targetId)) throw fail(400, 'Choose an eligible Markdown file and its exact revision.');
    const source = await this.registeredSource(targetId, origin.projectId, args.destinationProjectId);
    return this.intent(origin, action, args, source);
  }

  inspect(target) {
    return this.request({ action: 'inspect', projectId: target.projectId, filename: target.filename }).then(result => result.revision);
  }

  async inspectRequest(origin, action, args, targetId) {
    if (!this.validate(action, args, targetId)) throw fail(400, 'Choose an eligible Markdown file and its exact revision.');
    const source = await this.source(targetId, origin.projectId, args.destinationProjectId);
    const intent = this.intent(origin, action, args, source);
    const wire = { projectId: source.projectId, filename: source.filename, expectedRevision: args.expectedRevision };
    if (action === 'modify-file') {
      const current = await this.inspect(source);
      if (current !== args.expectedRevision) throw fail(409, 'The registered report changed. Review it again.');
      return { wire: { ...wire, action: 'modify', edit: args.edit }, revision: current, intent,
        review: `Add the missing final newline in ${source.projectId} / ${source.filename}. Existing bytes will stay intact.\nFile revision ${current}` };
    }
    if (args.destinationProjectId === source.projectId) throw fail(403, 'Choose a different eligible destination project.');
    const destination = await this.project(args.destinationProjectId);
    const { destinationRevision } = await this.request({ ...wire, action: 'inspect-copy', destinationProjectId: destination.id });
    return {
      wire: { ...wire, action: 'copy', destinationProjectId: destination.id, destinationRevision },
      revision: destinationRevision, intent,
      review: `Copy ${source.projectId} / ${source.filename} to ${destination.id} / ${source.filename}. Only a new file can be created.\nSource revision ${args.expectedRevision}\nDestination revision ${destinationRevision}`,
    };
  }

  async prepare(origin, action, args, targetId) {
    const { revision, review, intent } = await this.inspectRequest(origin, action, args, targetId);
    return { approval: true, revision, review, intent };
  }

  async apply(origin, action, args, { approved, revision, targetId, stillAuthorized }) {
    if (approved !== true || !revisionValue(revision)) throw fail(403, 'This file request needs its own owner approval.');
    if (!this.validate(action, args, targetId)) throw fail(400, 'Choose an eligible Markdown file and its exact revision.');
    const source = await this.source(targetId, origin.projectId, args.destinationProjectId);
    const projects = [...new Set([source.projectId, args.destinationProjectId].filter(Boolean))].sort();
    const apply = async () => {
      const { wire, revision: current } = await this.inspectRequest(origin, action, args, targetId);
      if (current !== revision) throw fail(409, 'The approved file target changed. Review it again.');
      if (typeof stillAuthorized !== 'function' || !await stillAuthorized()) throw fail(403, 'The file approval is no longer active.');
      await this.request(wire);
      this.changed();
      return { status: 'applied' };
    };
    // A consistent order also serializes simultaneous A-to-B and B-to-A
    // copies with project operations that can remove or move their roots.
    return projects.reduceRight((run, id) => () => this.projectStore.exclusive(id, run), apply)();
  }

  request(data) {
    if (this.closed) return Promise.reject(accessFailure(503, 'File requests are unavailable while Alpha is closing.', 'host-unavailable'));
    if (this.pending.size >= 4) return Promise.reject(accessFailure(429, 'Alpha is handling other file requests.', 'recoverable-host'));
    const requestId = randomUUID();
    const resultKey = data.action === 'inspect' ? 'revision' : data.action === 'inspect-copy' ? 'destinationRevision' : 'applied';
    const readOnly = resultKey !== 'applied';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(nativeWaitFailure('The Windows file operation could not be confirmed.', readOnly, true));
      }, 5000);
      this.pending.set(requestId, { resolve, reject, timer, resultKey, readOnly });
      try { this.send({ type: 'worker-file-operation', requestId, ...data }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(nativeWaitFailure('The Windows file boundary is unavailable.', readOnly));
      }
    });
  }

  receive(event) {
    if (event.type !== 'worker-file-operation') return;
    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.requestId);
    if ([400, 403, 404, 409, 413, 415, 503].includes(event.status) && typeof event.error === 'string') {
      pending.reject(nativeFailure(event.status, event.error, { access: event.access, readOnly: pending.readOnly }));
    } else {
      const value = event.result?.[pending.resultKey];
      if (pending.resultKey === 'applied' ? value === true : revisionValue(value)) pending.resolve({ [pending.resultKey]: value });
      else pending.reject(nativeWaitFailure('The Windows file operation could not be confirmed.', pending.readOnly));
    }
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(nativeWaitFailure('Alpha closed before confirming the Windows file operation.', pending.readOnly));
    }
    this.pending.clear();
  }
}
