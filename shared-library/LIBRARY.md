# Alpha shared library

Repository work first follows `processes/repository-ownership.md`: verify actual
GitHub ownership before changes and recheck the destination before remote writes.
Only `william-pyle` repositories are eligible; other owners are research-only and
unknown ownership stops dependent writes. Local folders and write access are not
ownership evidence. Existing task authorization and project exclusions still apply.

Open **Skills → Shared library** in Alpha to browse skills, knowledge and workflows.
The installed path is also available to terminal sessions as `ALPHA_SHARED_LIBRARY`.
The coordinator discovers shared skills and passes relevant paths in task handoffs.
Project skills of the same name take precedence over shared skills.

Release and workflow optimization follows `.agents/skills/release-packaging/`:
measure actual CI timing, test the same bytes that are packaged, and promote an
exact-commit trusted immutable artifact when the project's policy supports it.
Common-agent routing failures follow `.agents/skills/common-agent-maintenance/`;
preserve the task and use project-local instructions rather than bypass exclusions.

- `.agents/skills/`: maintained Codex skill folders, including scripts and references.
- `.claude/skills/`: complete copies generated for Claude Code during packaging.
- `knowledge/`: general reusable knowledge, including future additions.
- `knowledge/mailcraft-mcp.md`: MailCraft CLI, MCP bridge, and owner approval behavior.
- `processes/`: reusable workflows.
- `processes/worker-requests.md`: typed requests from a managed Codex worker to Alpha.
- `processes/computer-use-recovery.md`: bounded supported connection recovery,
  fresh window observations and checkpointed affected-session restart handling.
- `.agents/skills/common-agent-maintenance/`: evidence-based upkeep of Alpha's common agents.
- `common-agents/registry.json`: locally maintained reusable agent definitions and versions, created by Alpha at runtime; never copied into the release package.
- `scripts/`: supporting helpers; optional dependencies are documented alongside them.
- `workspace/_shared/`: bundled report templates for the Workspace root’s `_shared/`.
- `docs/skills.md`: the skill index.
- `docs/editable-cards.md`: Gallery and Research card format and editing guide.
- `desktop/service/card-schema.mjs`: reusable card validator.

See `provenance.json` and LICENSE for the bundled library's provenance. img2threejs retains its Apache-2.0 license and
complete supporting files. Tools, models, provider accounts and optional
Python packages remain separate installations.

## Add content to future releases

In the Alpha **source repository**, add files under `shared-library/knowledge/`,
`shared-library/processes/` or a complete skill under `shared-library/.agents/skills/`.
The build scans this directory automatically: no per-file inclusion list is needed.
Commit the files and publish the next version normally. The installer and in-app
update carry the new files. Local edits in an installed library stay local until
you deliberately copy them into the source package and commit them.

## Installed updates

Alpha applies the packaged library on startup. New defaults are added and unchanged
defaults are updated. Locally edited or deleted files are preserved. For conflicts,
the incoming version is saved under `.alpha-library/incoming/<version>/` and shown
in Skills. Removed package files are retained locally. This avoids silently removing
your knowledge. Replacing the application does not erase this library.

Use the active project's instructions first. Open a relevant shared SKILL.md
explicitly when working directly in a CLI; discovery inside Alpha does not modify
your global Codex or Claude configuration.
