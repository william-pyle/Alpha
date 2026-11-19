# Repository ownership preflight

Owner correction, 2026-11-18: changes are permitted only in GitHub repositories
whose actual owner is `william-pyle`. This eligibility boundary is not blanket
authorization to change every matching repository.

Before changing files, resolve the intended repository from its configured remote
and query GitHub repository metadata. For example:

```powershell
git remote get-url origin
gh api repos/OWNER/REPO --jq '{full_name: .full_name, owner: .owner.login, html_url: .html_url}'
```

Use the returned `owner.login` and canonical `full_name`, including after a rename
or redirect. Do not infer ownership from a folder, URL spelling, clone, fork
relationship, collaboration membership or write access. Record the lookup time,
canonical repository and owner in task evidence. Resolve and recheck the actual
push destination before pushing: a fetch remote may differ from its push URL.
Apply this verification before issues, comments, PRs and other remote writes too.

- Verified owner `william-pyle`: continue within the authorized task and project
  rules. Existing exclusions, including Mooseville, remain.
- Any other owner: research-only. No source edits, issues, comments, PRs or pushes,
  even when credentials permit them. Record research in the authorized Alpha
  inventory; do not modify the researched checkout.
- Missing remote, unresolved identity, failed lookup or unknown owner: stop
  dependent writes and report the gap. A previous inventory lookup is not a
  substitute for a fresh task preflight or destination check.

CraftLauncher and CraftWiki (`storytold`), SolidCraft (`tangency-labs`) and CraftLib
(`storytold`) are research-only. Launcher work was stopped separately. Do not
resume implementation through a common agent, project-local fallback, worktree,
copied checkout or alternate remote. Reverify ownership on future tasks; an
ownership change alone does not authorize previously stopped work.

Alpha owns shared workflow guidance and the central inventory. Preserve installed
library overrides. Propose common-agent registry revisions to the coordinator;
do not edit its live registry to encode or bypass this policy.
