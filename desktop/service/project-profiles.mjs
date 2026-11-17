import path from 'node:path';
import { readJson } from './util.mjs';

// Read only canonical project metadata. Excluded projects are not inspected.
// Returning the instruction path keeps local project rules authoritative.
export async function projectProfiles(repo, registry, scope = {}, query = '') {
  const profiles = [];
  for (const card of registry.entities || []) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(card.id) || query && !`${card.id} ${card.title}`.toLowerCase().includes(query.toLowerCase())) continue;
    if (scope.excludedProjects?.includes(card.id.toLowerCase())) { profiles.push({ id: card.id, title: card.title, excluded: true }); continue; }
    const directory = path.join(repo, 'projects', card.id);
    const record = await readJson(path.join(directory, 'project.json'), {});
    const source = record.source || {}, development = record.development || {};
    const commands = Object.fromEntries(Object.entries(development).filter(([key, value]) => /commands?$/i.test(key) && (typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string'))));
    profiles.push({ id: card.id, title: card.title, category: card.category, instructions: path.join(directory, 'AGENTS.md'), record: path.join(directory, 'project.json'), checkout: source.checkout || development.sourceFolder || null, repository: source.repository || null, technology: source.languages || source.language || source.stack || source.platform || development.framework || null, commands, releaseWorkflow: development.releaseWorkflow || development.deploymentWorkflow || development.ciWorkflow || null, note: 'Metadata is orientation, not proof of current installation, successful CI or deployment. Read the project instructions and verify current source before acting.' });
  }
  return profiles;
}
