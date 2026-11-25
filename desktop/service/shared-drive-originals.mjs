import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateProjectRoot, assertSafePath } from './project-layout.mjs';

const projectId = 'author-ashlyn-brooks';
export { projectId as sharedDriveProjectId };
const workspacePath = `projects/${projectId}/workspace`;
const reportPath = `${workspacePath}/shared-drive.html`;
const reportIndex = 8;
const mirrorFolder = 'SharedDrive';
const syncActions = new Set(['sync-list', 'sync-choice', 'sync-run']);
const syncChoices = new Set(['Ignore', 'Update Local', 'Update GoogleDrive', 'Delete Locally', 'Delete GoogleDrive']);
const fail = (status, message) => Object.assign(new Error(message), { status });

function relativeWindowsPath(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(/[\\/]/);
  for (const part of parts) {
    const device = part.split('.', 1)[0].replace(/[\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, '');
    if (!part || /[. ]$|[<>:"|?*\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(part) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i.test(device)) return null;
  }
  return parts.join('/');
}

export function sharedDriveMirror(repo) {
  return path.join(repo, 'projects', projectId, mirrorFolder);
}

export function sharedDrivePrivateDirectory(repo) {
  return path.join(repo, 'projects', projectId, '.alpha-shared-drive');
}

export function sharedDriveJournalDirectory(repo) {
  return path.join(repo, 'projects', projectId, '.shared-drive-sync');
}

export class SharedDriveOriginals {
  constructor(repo, registry, send) {
    this.repo = repo;
    this.registry = registry;
    this.send = send;
    this.grant = randomUUID();
    this.pending = new Map();
  }

  async registration() {
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
      return { project, settings };
    } catch { return null; }
  }

  async reportGrant(file) {
    if (path.relative(path.join(this.repo, reportPath), file) !== '' || !await this.registration()) return undefined;
    return this.grant;
  }

  async run(data) {
    if (data?.grant !== this.grant) throw fail(403, 'This report has no Shared Drive file access.');
    const registration = await this.registration();
    if (data.action === 'status') {
      if (!registration) return { available: false };
      return this.request({ action: 'status' }, 2000).catch(() => ({ available: false }));
    }
    if (!registration) throw fail(403, 'This report has no Shared Drive file access.');
    if (syncActions.has(data.action)) return this.sync(data, registration);
    if (data.action === 'list-rejections' || data.action === 'set-rejection') {
      const { action, rejected } = data;
      const relativePath = action === 'set-rejection' && typeof data.relativePath === 'string' && data.relativePath.length <= 1024
        ? relativeWindowsPath(data.relativePath) : null;
      if (action === 'set-rejection' && (relativePath === null || typeof rejected !== 'boolean')) {
        throw fail(400, 'Choose a Shared Drive relative file path and a rejection value.');
      }
      await assertPrivateProjectRoot(this.repo, projectId).catch(() => {
        throw fail(403, 'This report has no Shared Drive rejection access.');
      });
      return this.request(action === 'list-rejections' ? { action } : { action, relativePath, rejected }, 15_000);
    }
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
    if (action === 'save' && this.syncRunning) throw fail(409, 'Wait for Shared Drive sync before saving.');
    return this.request({ root: sharedDriveMirror(this.repo), action, relativePath, ...(action === 'save' ? { revision, text } : {}) }, 15_000);
  }

  async sync({ action, relativePath, revision, choice }, { project, settings }) {
    if (process.platform !== 'win32' || settings.sync.bridge !== 'one-button-v1') {
      throw fail(404, 'One-button sync requires the updated Windows Shared Drive project.');
    }
    const input = { action };
    if (action === 'sync-choice') {
      // Match the private sync engine's 2,000 Unicode-character path limit.
      const relative = typeof relativePath === 'string' && relativePath.length <= 4000 && [...relativePath].length <= 2000
        ? relativeWindowsPath(relativePath) : null;
      if (relative === null || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || choice !== null && !syncChoices.has(choice)) {
        throw fail(400, 'Choose an action for the current Shared Drive conflict.');
      }
      Object.assign(input, { relativePath: relative, revision, choice });
    }
    if (this.closed) throw fail(503, 'Alpha is closing.');
    if (this.syncBusy) throw fail(409, 'Wait for the current Shared Drive action to finish.');
    this.syncBusy = true;
    this.syncRunning = action === 'sync-run';
    try {
      const { root } = await assertPrivateProjectRoot(this.repo, projectId);
      const scan = Array.isArray(project.tools) && project.tools.find(tool => tool?.id === 'shared-drive-scan' && tool.kind === 'one-shot')?.start;
      // Reuse the interpreter already approved for the registered private scanner.
      // Report input never selects an executable, argument list or root.
      if (typeof scan?.executable !== 'string' || !/^[a-z]:[\\/]/i.test(scan.executable) ||
          !/^python(?:3(?:\.\d+)?)?\.exe$/i.test(path.basename(scan.executable)) ||
          typeof scan.cwd !== 'string' || path.relative(root, scan.cwd) !== '' ||
          !Array.isArray(scan.args) || scan.args.length !== 2 || scan.args[0] !== '-B' || scan.args[1] !== 'shared-drive.py') {
        throw fail(503, 'Configure the existing Shared Drive scan with an absolute Python interpreter.');
      }
      const script = await assertSafePath(this.repo, path.join(root, 'shared_drive_sync.py')).catch(() => null);
      const scanner = await assertSafePath(this.repo, path.join(root, 'shared-drive.py')).catch(() => null);
      if (!script || !scanner) throw fail(503, 'The private Shared Drive sync files are unavailable.');
      if (this.closed) throw fail(503, 'Alpha is closing.');
      return await new Promise((resolve, reject) => {
        const options = { cwd: root, windowsHide: true, timeout: this.syncRunning ? 280_000 : 15_000, maxBuffer: 4 * 1024 * 1024 };
        this.syncChild = execFile(scan.executable, ['-E', '-B', script, 'bridge'], options, (error, stdout) => {
          let result;
          try { result = JSON.parse(stdout); } catch { /* Keep child diagnostics private. */ }
          if (!error && Array.isArray(result?.conflicts)) resolve(result);
          else if (typeof result?.error === 'string' && result.error.length <= 500) reject(fail(409, result.error));
          else reject(fail(503, 'Shared Drive did not finish. Reload the tab to check sync or recovery status.'));
        });
        this.syncChild.stdin.on('error', () => {});
        this.syncChild.stdin.end(JSON.stringify(input), 'utf8');
      });
    } finally {
      this.syncChild = null;
      this.syncRunning = false;
      this.syncBusy = false;
    }
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
    this.closed = true;
    this.syncChild?.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail(503, 'Alpha is closing.'));
    }
    this.pending.clear();
  }
}
