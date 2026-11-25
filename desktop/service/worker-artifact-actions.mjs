import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateProjectRoot, assertSafePath, projectId } from './project-layout.mjs';
import { within } from './util.mjs';
import { mapArtifactContent } from './worker-artifact-content.mjs';
import { accessFailure, isOsAccessError, nativeFailure, nativeWaitFailure } from './worker-native-access.mjs';

const layouts = {
  skill: '.agents/skills',
  knowledge: 'knowledge',
  agent: '.claude/agents',
};
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const relativeFile = /^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*){0,5}$/i;
const fail = (status, workerReason) => Object.assign(new Error('Alpha could not validate the exact project artifact.'), { status, workerReason });
const blocked = workerReason => accessFailure(403, 'The artifact is outside the eligible project boundary.', 'policy', workerReason);
const classifyOsAccess = error => {
  if (isOsAccessError(error)) throw accessFailure(403, 'Windows denied access to the artifact or its project Workspace.', 'os-permission');
  throw error;
};
const missingOkay = error => { if (error.code === 'ENOENT') return null; return classifyOsAccess(error); };
const boundaryFailure = error => {
  if (isOsAccessError(error)) return classifyOsAccess(error);
  if (error.status === 403 || error.status === 400) return null;
  throw accessFailure(503, 'Alpha could not check the artifact Workspace.', 'host-unavailable', 'artifact-unavailable');
};
const portable = value => value.split(path.sep).join('/');
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

function validateRequest(action, args, targetId) {
  if (action !== 'import-artifact' || targetId !== undefined || !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).length !== 3 || !['sourceProjectId', 'kind', 'artifactId'].every(field => Object.hasOwn(args, field)) ||
      typeof args.kind !== 'string' || !Object.hasOwn(layouts, args.kind) || typeof args.artifactId !== 'string' || args.artifactId.length > 64 || !slug.test(args.artifactId) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(args.artifactId)) return false;
  return projectId(args.sourceProjectId) === args.sourceProjectId;
}

function scanFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 24) throw fail(503, 'artifact-unavailable');
  const names = new Set();
  let bytes = 0;
  return files.map(file => {
    if (!file || typeof file.path !== 'string' || file.path.length > 240 || !relativeFile.test(file.path) || names.has(key(file.path)) ||
        typeof file.contents !== 'string') throw fail(403, 'artifact-unsupported');
    names.add(key(file.path));
    const buffer = Buffer.from(file.contents, 'utf8');
    bytes += buffer.length;
    if (buffer.length > 128 * 1024 || bytes > 256 * 1024) throw fail(403, 'artifact-unsupported');
    return { name: file.path, bytes: buffer };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function referenceMapper({ files, source, destination, bundle, mappings }) {
  const sourceBase = path.join(source, bundle);
  const destinationBase = path.join(destination, bundle);
  const entries = new Map();
  const directories = new Map([[key(sourceBase), '.']]);
  for (const file of files) {
    const full = path.join(sourceBase, file.name);
    entries.set(key(full), file.name);
    for (let folder = path.dirname(full); folder !== sourceBase; folder = path.dirname(folder)) {
      directories.set(key(folder), path.relative(sourceBase, folder));
    }
  }
  return ({ file, reference, type }) => {
    // Only the Markdown parser's declared links reach this resolver.
    // A relative parent segment is useful inside a reviewed bundle, and the
    // explicit working-directory link may point to the verified workspace root.
    if (typeof reference !== 'string' || !reference || /[\x00-\x1f%?]/.test(reference) || /^(?:[\\/]{2}|~)/.test(reference)) {
      throw fail(403, 'artifact-reference');
    }
    const fragmentAt = reference.indexOf('#');
    const target = fragmentAt < 0 ? reference : reference.slice(0, fragmentAt);
    const fragment = fragmentAt < 0 ? '' : reference.slice(fragmentAt);
    if (!target || /:(?![\\/])/.test(target) || (target.includes(':') && !/^[a-z]:[\\/]/i.test(target))) throw fail(403, 'artifact-reference');
    const initial = path.resolve(sourceBase, path.dirname(file), target.replaceAll('\\', path.sep));
    const working = type === 'working-directory';
    let mapped;
    if (working && !fragment && key(initial) === key(source)) {
      mapped = destination;
    } else if (within(sourceBase, initial)) {
      const registered = (working ? directories : entries).get(key(initial));
      if (registered !== undefined) mapped = path.resolve(destinationBase, registered);
    }
    if (!mapped || working && fragment || !within(destination, mapped)) throw fail(409, 'artifact-reference');
    const output = portable(path.relative(path.join(destinationBase, path.dirname(file)), mapped)) || '.';
    mappings.add(portable(path.relative(destination, mapped)) || 'Workspace root');
    return output + fragment;
  };
}

export class WorkerArtifactActions {
  group = 'artifacts';

  constructor({ projects, projectStorage, repositories, projectAllowed, send, changed = () => {} }) {
    Object.assign(this, { projects, projectStorage, repositories, projectAllowed, send, changed });
    this.pending = new Map();
  }

  validate = validateRequest;

  async list() {
    return Object.entries(layouts).map(([kind, layout]) => ({ kind, layout, approval: 'one-time owner review' }));
  }

  async project(id) {
    if (!this.projectAllowed(id)) throw blocked('artifact-provenance');
    const project = await this.projects.get(id, { allowRemoved: false }).catch(classifyOsAccess);
    this.projectStorage.assertAvailable(id);
    const roots = await assertPrivateProjectRoot(this.projects.repo, id).catch(boundaryFailure);
    if (!roots || project.workspacePath !== roots.workspacePath) throw blocked('artifact-unavailable');
    const local = await lstat(roots.workspace).catch(missingOkay);
    if (!local?.isDirectory() || local.isSymbolicLink()) throw blocked('artifact-unavailable');

    // Honor existing GitHub-linked project rules even though imports are
    // restricted to the private workspace, a sibling of the checkout.
    const recordPath = path.join(roots.root, 'project.json');
    const metadata = await lstat(recordPath).catch(missingOkay);
    let record = {};
    if (metadata) {
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 512 * 1024) throw blocked('artifact-provenance');
      try { record = JSON.parse((await readFile(await assertSafePath(roots.root, recordPath), 'utf8')).replace(/^\uFEFF/, '')); }
      catch (error) {
        if (!(error instanceof SyntaxError)) boundaryFailure(error);
        throw blocked('artifact-provenance');
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw blocked('artifact-provenance');
    }
    const urls = [...new Set([
      project.projectRepositoryUrl, project.sourceRepositoryUrl, record.source?.repository,
      typeof record.repository === 'string' ? record.repository : record.repository?.url,
    ].filter(Boolean))];
    if (!urls.length && (project.checkoutPath || record.source?.checkout || record.development?.sourceFolder || await lstat(roots.github).catch(missingOkay))) {
      throw blocked('artifact-provenance');
    }
    const provenance = await Promise.all(urls.map(async url => {
      const verified = await this.repositories.verify(url).catch(error => {
        if (error.status === 403 || error.status === 400) throw blocked('artifact-provenance');
        throw accessFailure(503, 'Alpha could not verify the linked GitHub repository.', 'host-unavailable', 'artifact-provenance');
      });
      if (verified?.owner !== 'william-pyle' || !verified.id) throw blocked('artifact-provenance');
      return [verified.id, verified.fullName];
    }));
    return { workspace: roots.workspace, provenance };
  }

  async inspect(origin, args) {
    if (origin.projectId === args.sourceProjectId) throw fail(403, 'artifact-destination');
    const [source, destination] = await Promise.all([this.project(args.sourceProjectId), this.project(origin.projectId)]);
    const identity = { sourceProjectId: args.sourceProjectId, destinationProjectId: origin.projectId, kind: args.kind, artifactId: args.artifactId };
    const scanned = await this.request({ ...identity, action: 'scan' });
    if (!digest(scanned.sourceRevision) || !digest(scanned.destinationRevision)) throw fail(503, 'artifact-unavailable');
    const input = scanFiles(scanned.files);
    const mappings = new Set();
    const bundle = args.kind === 'skill' ? layouts.skill + '/' + args.artifactId : layouts[args.kind];
    const mapReference = referenceMapper({ files: input, source: source.workspace, destination: destination.workspace, bundle, mappings });
    const mapped = await mapArtifactContent({ kind: args.kind, artifactId: args.artifactId, files: input, mapReference });
    const files = mapped.files.map(file => ({ path: file.name, contents: file.bytes.toString('utf8') }));
    const { sourceRevision, destinationRevision } = scanned;
    const revision = hash([identity, source.provenance, destination.provenance, sourceRevision, destinationRevision, files]);
    const names = [...mappings];
    const locations = names.slice(0, 8).map(name => name.slice(0, 180)).join(', ');
    const repositories = source.provenance.map(([, name]) => name);
    const review = [
      `Copy ${args.kind} ${args.artifactId} from ${identity.sourceProjectId} to ${identity.destinationProjectId}.`,
      `Destination ${args.kind === 'skill' ? bundle : bundle + '/' + args.artifactId + '.md'}. ${files.length} reviewed file(s).`,
      `Source is the private project workspace${repositories.length ? `. Verified linked GitHub ownership for ${repositories.join(', ')}` : ''}. Reviewed source revision ${sourceRevision}.`,
      names.length ? `Mapped destination references: ${locations}${names.length > 8 ? ` and ${names.length - 8} more` : ''}.` : 'This artifact declares no file or working-directory references.',
      'Existing entries will be preserved. License and notice text is retained. Import does not run helpers or start an agent.',
    ].join('\n');
    return { identity, files, sourceRevision, destinationRevision, revision, review };
  }

  async prepare(origin, action, args) {
    if (!this.validate(action, args)) throw fail(400, 'artifact-unsupported');
    const { review, revision } = await this.inspect(origin, args);
    return { approval: true, review, revision };
  }

  async apply(origin, action, args, { approved, revision, stillAuthorized }) {
    if (!this.validate(action, args) || approved !== true || !digest(revision)) throw fail(403, 'artifact-provenance');
    const [first, second] = [origin.projectId, args.sourceProjectId].sort();
    if (first === second) throw fail(403, 'artifact-destination');
    return this.projects.exclusive(first, () => this.projects.exclusive(second, async () => {
      if (!await stillAuthorized()) throw fail(403, 'artifact-provenance');
      const current = await this.inspect(origin, args);
      if (current.revision !== revision) throw fail(409, 'artifact-changed');
      if (!await stillAuthorized()) throw fail(403, 'artifact-provenance');
      await this.request({
        ...current.identity, action: 'apply', files: current.files,
        sourceRevision: current.sourceRevision, destinationRevision: current.destinationRevision,
      });
      this.changed();
      return { status: 'applied', projectId: origin.projectId };
    }));
  }

  request(data) {
    if (this.closed) return Promise.reject(accessFailure(503, 'Artifact requests are unavailable while Alpha is closing.', 'host-unavailable'));
    if (this.pending.size >= 4) return Promise.reject(accessFailure(429, 'Alpha is handling other artifact requests.', 'recoverable-host'));
    const readOnly = data.action === 'scan';
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(nativeWaitFailure('The Windows artifact operation could not be confirmed.', readOnly, true));
      }, 7500);
      this.pending.set(requestId, { resolve, reject, timer, readOnly });
      try { this.send({ type: 'worker-artifact-operation', requestId, ...data }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(nativeWaitFailure('The Windows artifact boundary is unavailable.', readOnly));
      }
    });
  }

  receive(event) {
    if (event.type !== 'worker-artifact-operation') return;
    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.requestId);
    const { status, result } = event;
    if (event.access && [403, 409, 503].includes(status)) {
      pending.reject(nativeFailure(status, 'Windows could not finish the artifact operation.', {
        access: event.access, readOnly: pending.readOnly,
        workerReason: event.access === 'policy' ? 'artifact-unsupported' : undefined,
      }));
    } else if (status === 409) pending.reject(fail(status, event.reason === 'collision' ? 'artifact-collision' : 'artifact-changed'));
    else if (status === 404) pending.reject(fail(status, 'artifact-missing'));
    else if ([400, 403, 413, 415].includes(status)) pending.reject(fail(403, 'artifact-unsupported'));
    else if (result && (pending.readOnly || result.applied === true)) pending.resolve(result);
    else pending.reject(nativeWaitFailure('The Windows artifact operation could not be confirmed.', pending.readOnly));
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(nativeWaitFailure('Alpha closed before confirming the Windows artifact operation.', pending.readOnly));
    }
    this.pending.clear();
  }
}
