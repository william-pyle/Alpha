import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realFile, saveJson, sleep } from './util.mjs';
import { validateCard, cardText, CARD_MAX_BYTES } from './card-schema.mjs';
import defaultCategories from './default-categories.json' with { type: 'json' };

const execute = promisify(execFile);
export const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const brief = ({ id, title, description, status, category, created, updated, pinned, steps }) => ({ id, title, description, status, category, created, updated, pinned: !!pinned, steps: (steps || []).map(({ name }, index) => ({ name, index })) });
const invalid = message => Object.assign(new Error(message), { status: 400 });
const categoryId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const categoryName = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 && !/[\x00-\x1f\x7f]/.test(value);
const categoryIcon = value => typeof value === 'string' && value.trim().length > 0 && [...value].length <= 8 && !/[\x00-\x1f\x7f<>]/.test(value);
const displayName = id => id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
export function categoriesOf(registry) {
  const source = Array.isArray(registry.categories) ? registry.categories : defaultCategories;
  const categories = source.filter(item => categoryId(item?.id) && categoryName(item?.name) && categoryIcon(item?.icon)).map(item => ({ id: item.id, name: item.name.trim(), icon: item.icon.trim() }));
  for (const entity of registry.entities || []) if (categoryId(entity.category) && !categories.some(item => item.id === entity.category)) categories.push({ id: entity.category, name: displayName(entity.category), icon: '📁' });
  return categories;
}

// Removes <script> and <style> blocks in one pass. A lazy regex up to the closing
// tag rescans the rest of the text for every unclosed opening tag, which lets a
// report stall the service. An unclosed block hides the rest, as it does in a browser.
export function stripCodeBlocks(text) {
  const opening = /<(script|style)\b/gi, closing = { script: /<\/script>/gi, style: /<\/style>/gi };
  let result = '', kept = 0, match;
  while ((match = opening.exec(text))) {
    const tagEnd = text.indexOf('>', opening.lastIndex);
    if (tagEnd < 0) break;
    const close = closing[match[1].toLowerCase()];
    close.lastIndex = tagEnd + 1;
    result += text.slice(kept, match.index) + ' ';
    if (!close.exec(text)) return result;
    kept = opening.lastIndex = close.lastIndex;
  }
  return result + text.slice(kept);
}

// UI requests can only change card metadata, never report paths or contents.
export function metadataPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !['status', 'category', 'pinned'].includes(key))) {
    throw invalid('Choose a status, category or pin change.');
  }
  return value;
}

export class Workspace {
  constructor(repo, changed = () => {}) { this.repo = repo; this.file = path.join(repo, 'workspace', 'workspace.json'); this.changed = changed; this.writes = Promise.resolve(); }
  async registry() {
    const registry = JSON.parse(await readFile(this.file, 'utf8'));
    if (!Array.isArray(registry.entities)) throw new Error('Workspace registry is not ready.');
    registry.categories = categoriesOf(registry);
    return registry;
  }
  async list({ query = '', date, status } = {}) {
    const { entities } = await this.registry();
    return entities.filter(item => (!query || `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase())) && (!date || item.created === date || item.updated === date) && (!status || item.status === status)).map(brief);
  }
  async read(id, step = 0) {
    const entity = (await this.registry()).entities.find(item => item.id === id);
    if (!entity) throw new Error('Workspace card was not found.');
    const result = { ...brief(entity), text: '' };
    const selected = entity.steps?.[step];
    if (!selected) return result;
    const relative = path.join(entity.folder, selected.path.split('?')[0]);
    const { file } = await realFile(path.join(this.repo, 'workspace'), relative);
    if (selected.viewer === 'card' && file.endsWith('.card.json') && (await stat(file)).size <= CARD_MAX_BYTES) return { ...result, text: cardText(validateCard(JSON.parse(await readFile(file, 'utf8')))).slice(0, 12000) };
    if (!/\.(html?|md|txt)$/i.test(file) || (await stat(file)).size > 3 * 1024 * 1024) return { ...result, note: 'The card uses a visual or large report. Open it for the full content.' };
    const text = await readFile(file, 'utf8');
    result.text = stripCodeBlocks(text).replace(/<[^<>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 12000);
    return result;
  }
  async activity(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Use a date in YYYY-MM-DD format.');
    const registry = await this.registry();
    const { stdout = '' } = await execute('git', ['log', `--since=${date}T00:00:00`, `--until=${date}T23:59:59`, '--format=%s', '--name-only', '--max-count=45', '--', 'workspace'], { cwd: this.repo, windowsHide: true, maxBuffer: 128 * 1024 }).catch(() => ({}));
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const paths = lines.filter(line => line.startsWith('workspace/'));
    const cards = registry.entities.filter(item => item.created === date || item.updated === date || paths.some(file => file.startsWith(`workspace/${item.folder}/`))).map(brief);
    return { date, cards, commits: [...new Set(lines.filter(line => !line.startsWith('workspace/')))].slice(0, 15), basis: 'Workspace dates and recorded Git changes; not a complete record of unsaved work.' };
  }
  update(id, patch) {
    const operation = this.writes.catch(() => {}).then(async () => {
      if (patch.status !== undefined && !['active', 'done', 'archived'].includes(patch.status)) throw invalid('Use active, done or archived status.');
      if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') throw invalid('Pinned must be true or false.');
      if (patch.category !== undefined && !categoryId(patch.category)) throw invalid('Use a category with lowercase letters, numbers and hyphens.');
      if (patch.status === undefined && patch.pinned === undefined && patch.category === undefined) throw invalid('Choose a status, category or pin change.');
      for (let attempt = 0; attempt < 6; attempt++) {
        const source = await readFile(this.file, 'utf8');
        const registry = JSON.parse(source);
        registry.categories = categoriesOf(registry);
        const entity = registry.entities.find(item => item.id === id);
        if (!entity) throw Object.assign(new Error('Workspace card was not found.'), { status: 404 });
        if (patch.status !== undefined) entity.status = patch.status;
        if (patch.pinned !== undefined) entity.pinned = patch.pinned;
        if (patch.category !== undefined) {
          if (!registry.categories.some(item => item.id === patch.category)) registry.categories.push({ id: patch.category, name: displayName(patch.category), icon: '📁' });
          entity.category = patch.category;
        }
        entity.updated = localDay();
        // Preserve other agents' latest registry changes instead of saving a stale snapshot.
        if (await readFile(this.file, 'utf8') !== source) continue;
        try { await saveJson(this.file, registry, { beforeReplace: async () => {
          if (await readFile(this.file, 'utf8') !== source) throw Object.assign(new Error('Workspace changed while saving.'), { code: 'ESTALE' });
        } }); }
        catch (error) {
          // Windows indexers/readers can briefly lock atomic replacements. Retry
          // from a fresh registry so another agent's edits are still retained.
          if (!['EPERM', 'EACCES', 'EBUSY', 'ESTALE'].includes(error.code) || attempt === 5) throw error;
          await sleep(40 * (attempt + 1));
          continue;
        }
        this.changed();
        return brief(entity);
      }
      throw new Error('Workspace is being updated by another task. Try the change again.');
    });
    this.writes = operation;
    return operation;
  }
  changeCategory(action, id, details = {}) {
    const operation = this.writes.catch(() => {}).then(async () => {
      if (!['create', 'update', 'delete'].includes(action)) throw invalid('Choose a category action.');
      if (!categoryId(id)) throw invalid('Use a category ID with lowercase letters, numbers and hyphens.');
      if (action !== 'delete' && (!categoryName(details.name) || !categoryIcon(details.icon))) throw invalid('Enter a category name and choose an icon.');
      for (let attempt = 0; attempt < 6; attempt++) {
        const source = await readFile(this.file, 'utf8');
        const registry = JSON.parse(source);
        if (!Array.isArray(registry.entities)) throw new Error('Workspace registry is not ready.');
        registry.categories = categoriesOf(registry);
        const index = registry.categories.findIndex(item => item.id === id);
        let reassigned = 0;
        if (action === 'create') {
          if (index >= 0) throw invalid('That category ID already exists.');
          registry.categories.push({ id, name: details.name.trim(), icon: details.icon.trim() });
        } else {
          if (index < 0) throw Object.assign(new Error('Category was not found.'), { status: 404 });
          if (action === 'update') registry.categories[index] = { id, name: details.name.trim(), icon: details.icon.trim() };
          else {
            const used = registry.entities.filter(item => item.category === id);
            reassigned = used.length;
            if (registry.categories.length < 2) throw invalid('Keep at least one category.');
            if (used.length && (!categoryId(details.replacement) || details.replacement === id || !registry.categories.some(item => item.id === details.replacement))) throw invalid('Choose another category for these cards.');
            for (const entity of used) { entity.category = details.replacement; entity.updated = localDay(); }
            registry.categories.splice(index, 1);
          }
        }
        if (await readFile(this.file, 'utf8') !== source) continue;
        try { await saveJson(this.file, registry, { beforeReplace: async () => {
          if (await readFile(this.file, 'utf8') !== source) throw Object.assign(new Error('Workspace changed while saving.'), { code: 'ESTALE' });
        } }); }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY', 'ESTALE'].includes(error.code) || attempt === 5) throw error;
          await sleep(40 * (attempt + 1)); continue;
        }
        this.changed();
        return { categories: registry.categories, reassigned };
      }
      throw new Error('Workspace is being updated by another task. Try again.');
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
