import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const repository = 'https://api.github.com/repos/william-pyle/Alpha';
export const newerVersion = (next, current) => {
  if (!/^\d+\.\d+\.\d+$/.test(next) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const a = next.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};
export class Updates {
  constructor({ directory, version, changed = () => {}, native = () => {}, activeCount = () => 0, fetcher = fetch }) {
    Object.assign(this, { directory, version, changed, native, activeCount, fetcher });
    this.state = { status: 'idle', currentVersion: version }; this.busy = null;
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.changed(this.state); return this.state; }
  async json(url) {
    const response = await this.fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Alpha-desktop' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}. Try again later.`);
    return response.json();
  }
  check() {
    if (this.busy) return this.busy;
    if (this.state.status === 'downloaded') return Promise.resolve(this.state);
    this.set({ status: 'checking', error: null });
    this.busy = (async () => {
      const release = await this.json(repository + '/releases/latest');
      const version = String(release.tag_name || '').replace(/^v/, '');
      if (release.draft || release.prerelease || !newerVersion(version, this.version)) return this.set({ status: 'current', checkedAt: new Date().toISOString() });
      const prefix = `https://github.com/william-pyle/Alpha/releases/download/v${version}/`;
      const asset = release.assets?.find(item => item.name === 'alpha-update.json');
      if (asset?.browser_download_url !== prefix + 'alpha-update.json') throw new Error('This release has no compatible Alpha update.');
      const manifest = await this.json(asset.browser_download_url);
      if (manifest.version !== version || manifest.platform !== 'windows-x64' || manifest.url !== prefix + `Alpha-Setup-${version}-x64.exe` || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 500 * 1024 * 1024) throw new Error('The release update manifest is invalid.');
      this.manifest = manifest;
      return this.set({ status: 'available', version, releaseUrl: `https://github.com/william-pyle/Alpha/releases/tag/v${version}`, checkedAt: new Date().toISOString() });
    })().catch(error => this.set({ status: 'error', error: error.message })).finally(() => { this.busy = null; });
    return this.busy;
  }
  download() {
    if (this.busy) return this.busy;
    if (!this.manifest || !['available', 'error'].includes(this.state.status)) throw new Error('Check for a new release first.');
    const manifest = this.manifest;
    this.set({ status: 'downloading', percent: 0, error: null });
    this.busy = (async () => {
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, `Alpha-Setup-${manifest.version}-x64.exe`), temporary = file + '.partial';
      const response = await this.fetcher(manifest.url, { signal: AbortSignal.timeout(600000) });
      if (!response.ok || !response.body) throw new Error('The update download failed.');
      const chunks = []; let length = 0, lastPercent = -1;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > manifest.bytes) throw new Error('The update size did not match its release.');
        chunks.push(chunk);
        const percent = Math.floor(length / manifest.bytes * 100);
        if (percent !== lastPercent) { lastPercent = percent; this.set({ percent }); }
      }
      const bytes = Buffer.concat(chunks);
      if (length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Update checksum verification failed.');
      await writeFile(temporary, bytes); await rename(temporary, file); this.file = file;
      return this.set({ status: 'downloaded', percent: 100 });
    })().catch(error => this.set({ status: 'error', error: error.message })).finally(() => { this.busy = null; });
    return this.busy;
  }
  async install(confirmed) {
    if (confirmed !== true || this.state.status !== 'downloaded' || !this.file) throw new Error('Download the update and choose Restart and install first.');
    const bytes = await readFile(this.file);
    if (createHash('sha256').update(bytes).digest('hex') !== this.manifest.sha256) {
      await rm(this.file, { force: true }); this.file = null;
      this.set({ status: 'error', error: 'The downloaded installer changed. Download it again.' });
      throw new Error(this.state.error);
    }
    this.native({ type: 'update-install', file: this.file, version: this.manifest.version, activeCount: this.activeCount() });
    return this.state;
  }
  start() {
    this.startTimer = setTimeout(() => void this.check(), 1000); this.startTimer.unref();
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000); this.timer.unref();
  }
  close() { clearTimeout(this.startTimer); clearInterval(this.timer); }
}
