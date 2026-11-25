import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateWorkspaceRoot, assertSafePath, projectWorkspaceDirectory } from './project-layout.mjs';
import { categoriesOf, localDay, metadataPatch } from './workspace.mjs';
import { cardTemplates } from './card-schema.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unsafeLabel = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const storedTabId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const tabIdPattern = /^(?:legacy-[0-9a-f]{64}|step-(?:0|[1-9][0-9]{0,5}))$/;
const exactShape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const cleanLabel = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || unsafeLabel.test(value)) fail(400, 'Use a short, plain-text title.');
  return value.trim();
};
const display = (value, max = 100) => [...String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')].slice(0, max).join('');
const tabId = (entity, step, index) => storedTabId.test(step.id) ? step.id : 'legacy-' + hash([entity.id, index, step.path, step.viewer]);
const blankReport = '# Report\n\n';
const maxTabs = 128;
const requestFields = {
  'create-project': ['title', 'template'],
  'update-project': ['projectId', 'patch'],
  'create-report-tab': ['projectId', 'title'],
  'rename-report-tab': ['projectId', 'tabId', 'title'],
  'remove-report-tab': ['projectId', 'tabId'],
};
export function validateProjectRequest(action, input) {
  if (!Object.hasOwn(requestFields, action) || !exactShape(input, requestFields[action])) fail(400, 'Use the exact fields for this Alpha project action.');
  if (action === 'create-project') {
    if (!cardTemplates.includes(input.template)) fail(400, 'Choose Gallery or Research.');
    return { title: cleanLabel(input.title, 200), template: input.template };
  }
  const { projectId } = input;
  if (typeof projectId !== 'string' || projectId.length > 100 || !projectId.trim() || projectId.trim() !== projectId ||
      projectId === '.' || projectId === '..' || unsafeLabel.test(projectId) || /[\\/:?#]/.test(projectId)) fail(400, 'Use an exact stable project ID.');
  if (action === 'update-project') {
    const { status, category, pinned } = metadataPatch(input.patch);
    if (Object.hasOwn(input.patch, 'status') && !['active', 'done', 'archived'].includes(status)) fail(400, 'Use active, done or archived status.');
    if (Object.hasOwn(input.patch, 'category') && (typeof category !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(category))) fail(400, 'Use an existing category ID.');
    if (Object.hasOwn(input.patch, 'pinned') && typeof pinned !== 'boolean') fail(400, 'Use a boolean pin value.');
    return { projectId, patch: { ...(status !== undefined && { status }), ...(category !== undefined && { category }), ...(pinned !== undefined && { pinned }) } };
  }
  if (action === 'create-report-tab') return { projectId, title: cleanLabel(input.title, 80) };
  if (typeof input.tabId !== 'string' || (!storedTabId.test(input.tabId) && !tabIdPattern.test(input.tabId))) fail(400, 'Use an exact report tab ID.');
  return action === 'rename-report-tab' ? { projectId, tabId: input.tabId, title: cleanLabel(input.title, 80) } : { projectId, tabId: input.tabId };
}

export class WorkerProjectActions {
  constructor({ projects, workspace, cards, assertAvailable = () => {}, allowsProject = () => true }) {
    Object.assign(this, { projects, workspace, cards, assertAvailable, allowsProject });
  }

  validate(action, input, targetId) {
    return targetId === undefined && !!validateProjectRequest(action, input);
  }

  checkProject(id) {
    if (id.toLowerCase() === 'mooseville' || !this.allowsProject(id)) fail(403, 'This project is excluded from worker requests.');
    this.assertAvailable(id);
  }

  async list(origin) {
    this.checkProject(origin.projectId);
    const project = await this.projects.get(origin.projectId, { allowRemoved: false });
    return {
      projectId: project.id,
      tabs: (project.steps || []).flatMap((step, index) => step && !step.removedAt ?
        [{ tabId: tabId(project, step, index), stepIndex: index, title: display(step.name, 80) }] : []).slice(0, 64),
    };
  }

  // Resolve the host target and bind the complete reviewed registry entry so a
  // differently named/reordered/replaced tab cannot inherit a pending approval.
  inspect(origin, action, input, registry) {
    this.checkProject(origin.projectId);
    if (action === 'create-project') return { approval: false, revision: hash([origin.projectId, action, input]) };
    this.checkProject(input.projectId);
    const project = registry.entities.find(item => item.id === input.projectId && !item.removedAt && !item.deletionPending);
    if (!project) fail(404, 'The requested project is unavailable.');
    const crossProject = project.id !== origin.projectId;
    const projectLabel = display(project.id);
    const steps = project.steps || [];
    const index = input.tabId ? steps.findIndex((step, index) => step && !step.removedAt &&
      (tabId(project, step, index) === input.tabId || 'step-' + index === input.tabId)) : -1;
    const step = steps[index];
    if (input.tabId && !step) fail(404, 'The requested report tab is unavailable.');
    if (step && ((project.builtin && index === 0) || (project.id === 'alpha' && index < 6) ||
        (project.id === 'author-ashlyn-brooks' && index === 8 && step.path === 'shared-drive.html'))) fail(403, 'This reserved report tab has an established project workflow.');
    if (action === 'remove-report-tab' && steps.filter(step => step && !step.removedAt).length <= 1) fail(409, 'Keep at least one report tab in the project.');
    if (action === 'create-report-tab' && steps.length >= maxTabs) fail(409, 'This project has reached its report tab limit.');
    if (action === 'create-report-tab' && !project.workspacePath && registry.entities.some(item =>
      item.id !== project.id && !item.workspacePath && typeof item.folder === 'string' &&
      item.folder.replaceAll('\\', '/').toLowerCase() === String(project.folder).replaceAll('\\', '/').toLowerCase())) fail(409, 'This report directory is shared with another project.');
    if (input.title && steps.some((existing, current) => existing && !existing.removedAt && current !== index &&
        String(existing.name).toLowerCase() === input.title.toLowerCase())) fail(409, 'That report tab name is already in use.');
    if (action === 'update-project' && input.patch.category && !categoriesOf(registry).some(category => category.id === input.patch.category)) fail(400, 'Use an existing category.');

    const approval = crossProject || action === 'remove-report-tab';
    const targetLabel = step ? '“' + display(step.name, 80) + '” at report step ' + index : '';
    let review;
    if (action === 'update-project') review = 'Change project ' + projectLabel + ' to ' +
      Object.entries(input.patch).map(([key, value]) => key + ' = ' + value).join(', ') + '.';
    else if (action === 'create-report-tab') review = 'Add an empty Markdown report named “' + input.title + '” to project ' + projectLabel + '.';
    else if (action === 'rename-report-tab') review = 'Rename ' + targetLabel + ' in project ' + projectLabel + ' to “' + input.title + '”.';
    else review = 'Remove ' + targetLabel + ' from project ' + projectLabel + ' navigation. Its file and existing link are retained.';
    return { approval, review, revision: hash([origin.projectId, action, input, project]), project, index };
  }

  async prepare(origin, action, data) {
    const input = validateProjectRequest(action, data);
    const { approval, review, revision } = this.inspect(origin, action, input, await this.workspace.registry());
    return { approval, review, revision };
  }

  async resolveIntent(origin, action, data) {
    if (!['rename-report-tab', 'remove-report-tab'].includes(action)) return;
    const input = validateProjectRequest(action, data);
    const { project, index } = this.inspect(origin, action, input, await this.workspace.registry());
    return hash([action, { ...input, tabId: tabId(project, project.steps[index], index) }]);
  }

  async apply(origin, action, data, { approved = false, revision, stillAuthorized = () => true } = {}) {
    const input = validateProjectRequest(action, data);
    const authorize = async () => {
      if (!await stillAuthorized()) fail(403, 'The requesting session no longer has authority for this change.');
      this.checkProject(origin.projectId);
      if (input.projectId) this.checkProject(input.projectId);
    };
    const verify = async registry => {
      await authorize();
      let current;
      try { current = this.inspect(origin, action, input, registry); }
      catch (error) {
        if (error.status === 404) fail(409, 'The reviewed project or report tab changed.');
        throw error;
      }
      if (current.revision !== revision) fail(409, 'The reviewed project or report tab changed.');
      if (current.approval && !approved) fail(403, 'This exact project change requires an owner decision.');
      return current;
    };
    if (action === 'create-project') {
      await verify();
      const { entity } = await this.cards.create(input, authorize);
      return { projectId: entity.id };
    }
    return this.projects.exclusive(input.projectId, async () => {
      const { project } = await verify(await this.workspace.registry());
      if (action === 'update-project') {
        await this.workspace.update(project.id, input.patch, null, { guard: (_, registry) => verify(registry), authorize });
        return { projectId: project.id };
      }
      if (action !== 'create-report-tab') return this.projects.transaction(async registry => {
        const { project, index } = await verify(registry);
        const step = project.steps[index];
        if (action === 'rename-report-tab') step.name = input.title;
        else step.removedAt = new Date().toISOString();
        project.updated = localDay();
        return { projectId: project.id, tabId: tabId(project, step, index), stepIndex: index };
      }, { authorize });
      return this.createTab(project, input.title, verify, authorize);
    });
  }

  async createTab(project, title, verify, authorize) {
    const directory = await projectWorkspaceDirectory(this.workspace.repo, project);
    await assertPrivateWorkspaceRoot(directory);
    const id = randomUUID(), filename = 'report-' + id + '.md';
    const file = await assertSafePath(directory, path.join(directory, filename), { allowMissing: true });
    await authorize();
    await writeFile(file, blankReport, { flag: 'wx' });
    try {
      return await this.projects.transaction(async registry => {
        const { project } = await verify(registry);
        const steps = project.steps ||= [];
        steps.push({ id, name: title, path: filename });
        project.updated = localDay();
        return { projectId: project.id, tabId: id, stepIndex: steps.length - 1 };
      }, { authorize });
    } catch (error) {
      // Only clean up the unpublished blank file created above.
      await this.workspace.registry().then(async registry => {
        if (registry.entities.some(entity => entity.id === project.id && entity.steps?.some(step => step.id === id))) return;
        const unchanged = await readFile(await assertSafePath(directory, file), 'utf8');
        if (unchanged === blankReport) await unlink(file);
      }).catch(() => {});
      throw error;
    }
  }
}
