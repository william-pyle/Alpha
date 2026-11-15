import { randomUUID } from 'node:crypto';

export const builtInThemeIds = ['alpha', 'smurfs', 'higurashi'];
export const themeIcons = ['/art/alpha.png', '/art/smurfs.png', '/art/rena.png'];
export const themeBackdrops = ['', '/art/smurfs-background.png', '/art/rena-background.png'];
const hex = /^#[0-9a-fA-F]{6}$/;
const cleanText = (value, limit) => typeof value === 'string' ? value.trim().replace(/[\r\n\t]/g, ' ').slice(0, limit) : '';

export function themeProfile(input, id) {
  const label = cleanText(input?.label, 48), controller = cleanText(input?.controller, 48);
  if (!label || !controller || !themeIcons.includes(input?.icon) || !themeBackdrops.includes(input?.backdrop) ||
      ![input?.background, input?.foreground, input?.accent].every(color => typeof color === 'string' && hex.test(color))) {
    throw Object.assign(new Error('Choose a name, controller, bundled artwork and three valid colors.'), { status: 400 });
  }
  return { id, label, controller, icon: input.icon, backdrop: input.backdrop,
    background: input.background.toLowerCase(), foreground: input.foreground.toLowerCase(), accent: input.accent.toLowerCase() };
}

export function validThemeProfiles(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 35).flatMap(item => {
    const id = item?.id;
    if (typeof id !== 'string' || !(builtInThemeIds.includes(id) || /^custom-[0-9a-f-]{36}$/.test(id)) || seen.has(id)) return [];
    try { const profile = themeProfile(item, id); seen.add(id); return [profile]; } catch { return []; }
  });
}

export function changeTheme(settings, data) {
  const profiles = validThemeProfiles(settings.themeProfiles);
  if (data.action === 'create') {
    if (profiles.filter(item => item.id.startsWith('custom-')).length >= 30) throw Object.assign(new Error('The custom theme limit has been reached.'), { status: 400 });
    const profile = themeProfile(data, `custom-${randomUUID()}`);
    settings.themeProfiles = [...profiles, profile]; settings.appTheme = profile.id;
  } else if (data.action === 'save') {
    if (!builtInThemeIds.includes(data.id) && !profiles.some(item => item.id === data.id)) throw Object.assign(new Error('Theme not found.'), { status: 404 });
    const profile = themeProfile(data, data.id);
    settings.themeProfiles = [...profiles.filter(item => item.id !== data.id), profile];
  } else if (data.action === 'delete' && profiles.some(item => item.id === data.id && item.id.startsWith('custom-'))) {
    settings.themeProfiles = profiles.filter(item => item.id !== data.id);
    if (settings.appTheme === data.id) settings.appTheme = 'alpha';
  } else if (data.action === 'reset' && builtInThemeIds.includes(data.id)) {
    settings.themeProfiles = profiles.filter(item => item.id !== data.id);
  } else throw Object.assign(new Error('Choose a valid theme action.'), { status: 400 });
  return settings;
}
