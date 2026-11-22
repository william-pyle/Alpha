const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// URLs are data, never shell arguments or proof of ownership. Canonical ownership
// is resolved again through GitHub metadata immediately before each dependent action.
export function githubRepository(value, { optional = false } = {}) {
  if (optional && (value === '' || value === null)) return null;
  if (typeof value !== 'string' || value.length > 500 || value !== value.trim() || /[\s\\\x00-\x1f\x7f%]/.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)) fail('Enter a GitHub repository URL without credentials, query parameters or fragments.');
  let candidate = value;
  if (/^git@github\.com:/i.test(candidate)) candidate = `https://github.com/${candidate.slice(15)}`;
  let url; try { url = new URL(candidate); } catch { fail('Enter a GitHub repository URL such as https://github.com/account/repository.'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) fail('Use an HTTPS GitHub repository URL without credentials, query parameters or fragments.');
  const match = /^\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d._-]+?)(?:\.git)?\/?$/i.exec(url.pathname);
  if (!match || ['.', '..'].includes(match[2]) || match[2].length > 100) fail('Enter the repository URL, not a branch, issue or nested path.');
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}`, url: `https://github.com/${match[1]}/${match[2]}` };
}
