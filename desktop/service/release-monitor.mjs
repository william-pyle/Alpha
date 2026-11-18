import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const repo = 'repos/william-pyle/Alpha';
const installScript = `$ErrorActionPreference='Stop'; $roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); $items=@(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Alpha' } | ForEach-Object { @{ version=$_.DisplayVersion; source='Windows uninstall registration'; installed=$true } }); ConvertTo-Json -InputObject $items -Compress`;
export class ReleaseMonitor {
  constructor({ version, nativeVersion, run = execute, now = Date.now }) { Object.assign(this, { version, nativeVersion, run, now }); this.feed = null; this.busy = null; }
  snapshot() { return this.feed ? { ...this.feed, stale: this.now() - Date.parse(this.feed.checkedAt) > 5 * 60_000 || this.feed.errors.length > 0 } : { stale: true, status: 'not-checked' }; }
  refresh() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const errors = [], checkedAt = new Date(this.now()).toISOString();
      const read = async (part, args) => { try { const { stdout } = await this.run('gh', ['api', '--method', 'GET', ...args], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }); return JSON.parse(stdout); } catch { errors.push(`${part}: GitHub unavailable, offline or authentication required. Previous evidence may be stale.`); return null; } };
      const [release, runs, installed] = await Promise.all([
        read('Publication', [`${repo}/releases/latest`]), read('Build', [`${repo}/actions/runs?branch=main&per_page=1`]),
        (async () => { if (process.platform !== 'win32') return { records: [], status: 'unavailable', source: 'Windows installer registration unavailable', at: checkedAt }; try { const { stdout } = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', installScript], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }); const records = JSON.parse(stdout); return { records: (Array.isArray(records) ? records : [records]).filter(record => /^\d+\.\d+\.\d+$/.test(record?.version)).map(({ version }) => ({ version })), status: 'observed', source: 'Windows uninstall registration (installation evidence, not runtime verification)', at: checkedAt }; } catch { errors.push('Installed version: local registration could not be read.'); return this.feed?.installed || { records: [], status: 'unknown', at: checkedAt }; } })(),
      ]);
      const run = runs?.workflow_runs?.[0];
      this.feed = { checkedAt, errors, status: errors.length ? 'partial' : 'observed',
        published: release ? { version: String(release.tag_name || ''), draft: !!release.draft, prerelease: !!release.prerelease, at: checkedAt, source: 'GitHub releases/latest', url: `https://github.com/william-pyle/Alpha/releases/tag/${encodeURIComponent(String(release.tag_name || ''))}` } : this.feed?.published || null,
        build: run ? { status: run.status, conclusion: run.conclusion, commit: run.head_sha, id: run.id, at: checkedAt, source: 'GitHub actions/runs?branch=main', url: `https://github.com/william-pyle/Alpha/actions/runs/${Number(run.id)}` } : this.feed?.build || null,
        installed, running: { version: this.nativeVersion || this.version, source: this.nativeVersion ? 'Running native host compiled version' : 'Development service package; native runtime unverified', native: !!this.nativeVersion, at: checkedAt },
      }; return this.snapshot();
    })().finally(() => { this.busy = null; }); return this.busy;
  }
}
