import {createReadStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {reportThemeCSS} from './report-theme.mjs';

// Shared browser chrome and external-link routing. The selected reader theme
// applies to standard reports; custom designs and artwork keep their colours.
function preludeFor({theme = 'dark', parentOrigin = '', sharedDriveGrant} = {}) {
  theme = theme === 'light' ? 'light' : 'dark';
  const trustedOrigin = JSON.stringify(parentOrigin).replace(/</g, '\\u003c');
  const sharedDriveBridge = sharedDriveGrant ? `
  document.addEventListener('alpha:shared-drive-request', event => {
    const request = event.detail;
    if (!request || typeof request.requestId !== 'string') return;
    parent.postMessage({ type: 'alpha:shared-drive-request', grant: ${JSON.stringify(sharedDriveGrant)}, request }, ${trustedOrigin});
  });` : '';
  return Buffer.from(`<meta name="color-scheme" content="${theme}"><style data-alpha-chrome>
html{color-scheme:dark;background-color:#101115;color:#d3d0d9}
html,body,body *{scrollbar-color:#514c59 #111217!important;scrollbar-width:thin}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:#111217!important}
::-webkit-scrollbar-thumb{background:#514c59!important;border:2px solid #111217;border-radius:6px}
${reportThemeCSS}
</style><script data-alpha-links>
(() => {
  const setTheme = theme => { if (theme === 'dark' || theme === 'light') document.documentElement.dataset.alphaTheme = theme; };
  setTheme('${theme}');
  let toolQuery;
  ${sharedDriveBridge}
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== ${trustedOrigin} || !event.data) return;
    const message = event.data;
    if (message.type === 'alpha:theme') setTheme(message.theme);
    ${sharedDriveGrant ? `if (message.type === 'alpha:shared-drive-ready') {
      document.dispatchEvent(new Event('alpha:shared-drive-ready'));
    }
    if (message.type === 'alpha:shared-drive-result') {
      const { type, ...detail } = message;
      document.dispatchEvent(new CustomEvent('alpha:shared-drive-result', { detail }));
    }` : ''}
    if (message.type === 'alpha:report-tools-query' && typeof message.query === 'string') {
      const declaration = document.head?.querySelector('meta[name="alpha-workspace-tools"]');
      const ids = declaration?.content.match(/[^,\\s]+/g)?.slice(0, 20) || [];
      toolQuery = message.query;
      parent.postMessage({ type: 'alpha:report-tools', query: toolQuery, ids }, event.origin);
    }
    if (message.type === 'alpha:report-tool-finished' && toolQuery && message.query === toolQuery) {
      document.dispatchEvent(new CustomEvent('alpha:workspace-tool-finished', {
        detail: { id: message.id, success: message.success }
      }));
    }
  });
  const route = event => {
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || event.defaultPrevented) return;
    const url = new URL(link.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
    link.target = '_blank';
    link.relList.add('noopener', 'noreferrer');
  };
  document.addEventListener('click', route, true);
  document.addEventListener('auxclick', route, true);
})();
</script>`);
}

export function reportChromeStream(options) {
  const prelude = preludeFor(options);
  let pending = Buffer.alloc(0), inserted = false;
  const emit = function () {
    const text = pending.toString('utf8');
    // Preserve doctype, charset declarations and original bytes, including BOM.
    const head = /<head(?:\s[^>]*)?>/i.exec(text);
    const fallback = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(text);
    const position = head ? head.index + head[0].length : fallback ? fallback[0].length : text.startsWith('\uFEFF') ? 1 : 0;
    const offset = Buffer.byteLength(text.slice(0, position));
    this.push(pending.subarray(0, offset)); this.push(prelude); this.push(pending.subarray(offset));
    pending = null; inserted = true;
  };
  return new Transform({
    transform(chunk, encoding, callback) {
      if (inserted) this.push(chunk);
      else {
        pending = Buffer.concat([pending, chunk]);
        if (/<head(?:\s[^>]*)?>/i.test(pending.toString('utf8')) || pending.length >= 65536) emit.call(this);
      }
      callback();
    },
    flush(callback) { if (!inserted) emit.call(this); callback(); },
  });
}

export async function serveReport(request, response, file, info, headers, reportOptions = {}) {
  const options = {theme: new URL(request.url, 'http://localhost').searchParams.get('alpha-theme'), parentOrigin: headers['Access-Control-Allow-Origin'] || '', ...reportOptions};
  const prelude = preludeFor(options);
  response.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Content-Length':info.size + prelude.length, 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff', ...headers});
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(file), reportChromeStream(options), response).catch(error => {
    if (!request.destroyed && !response.destroyed) throw error;
  });
}
