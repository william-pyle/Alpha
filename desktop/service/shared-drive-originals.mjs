import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from './project-layout.mjs';

const projectId = 'author-ashlyn-brooks';
const workspacePath = `projects/${projectId}/workspace`;
const reportPath = `${workspacePath}/shared-drive.html`;
const reportIndex = 8;
const mirrorFolder = 'SharedDrive';
const fail = (status, message) => Object.assign(new Error(message), { status });

export function sharedDriveMirror(repo) {
  return path.join(repo, 'projects', projectId, mirrorFolder);
}

export class SharedDriveOriginals {
  constructor(repo, registry, send) {
    this.repo = repo;
    this.registry = registry;
    this.send = send;
    this.grant = randomUUID();
    this.pending = new Map();
  }

  async root() {
    try {
      const project = (await this.registry()).entities.find(item => item.id === projectId && !item.removedAt && !item.deletionPending);
      const report = project?.steps?.[reportIndex];
      if (project?.workspacePath !== workspacePath || report?.name !== 'Shared Drive' || report.path !== 'shared-drive.html' || report.viewer === 'card') return null;
      const config = path.join(this.repo, 'projects', projectId, 'project.json');
      await assertSafePath(this.repo, config);
      const settings = JSON.parse(await readFile(config, 'utf8')).sharedDrive;
      // A registered mirror is the fixed private project sibling of Workspace.
      // The mounted peer participates only in the separate sync workflow.
      if (settings?.sync?.mirrorFolder !== mirrorFolder || Object.hasOwn(settings, 'sourceFolder')) return null;
      return sharedDriveMirror(this.repo);
    } catch { return null; }
  }

  async reportGrant(file) {
    if (path.relative(path.join(this.repo, reportPath), file) !== '' || !await this.root()) return undefined;
    return this.grant;
  }

  async run(data) {
    if (data?.grant !== this.grant) throw fail(403, 'This report has no Shared Drive file access.');
    const root = await this.root();
    if (data.action === 'status') {
      if (!root) return { available: false };
      return this.request({ action: 'status' }, 2000).catch(() => ({ available: false }));
    }
    if (!root) throw fail(403, 'This report has no Shared Drive file access.');
    if (!['image', 'text', 'save'].includes(data.action)) throw fail(400, 'This Shared Drive action is unsupported.');
    if (typeof data.relativePath !== 'string' || data.relativePath.length > 1024 ||
        data.relativePath.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) {
      throw fail(400, 'Choose a file inside Shared Drive.');
    }
    const { action, relativePath, revision, text } = data;
    if (action === 'save' && (!/\.txt$/i.test(relativePath) || typeof text !== 'string' ||
        Buffer.byteLength(text) > 128 * 1024 || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) {
      throw fail(400, 'Save requires an existing .txt file and its current revision.');
    }
    return this.request({ root, action, relativePath, ...(action === 'save' ? { revision, text } : {}) }, 15_000);
  }

  request(data, timeout) {
    if (this.pending.size >= 4) throw fail(429, 'Shared Drive is busy. Try again.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(fail(503, 'Shared Drive did not respond. Review the original before trying again.'));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'shared-drive-original', requestId, ...data }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(fail(503, 'Shared Drive is unavailable.'));
      }
    });
  }

  receive(event) {
    if (event.type !== 'shared-drive-original') return;
    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.requestId);
    if (event.error) pending.reject(fail(event.status || 503, String(event.error)));
    else pending.resolve(event.result);
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail(503, 'Alpha is closing.'));
    }
    this.pending.clear();
  }
}
