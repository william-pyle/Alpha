# Alpha shared library

Open **Skills → Shared library** in Alpha to browse skills, knowledge and workflows.
The installed path is also available to terminal sessions as `ALPHA_SHARED_LIBRARY`.
The coordinator discovers shared skills and passes relevant paths in task handoffs.
Project skills of the same name take precedence over shared skills.

- `.agents/skills/`: maintained Codex skill folders, including scripts and references.
- `.claude/skills/`: complete copies generated for Claude Code during packaging.
- `knowledge/`: general reusable knowledge, including future additions.
- `knowledge/mailcraft-mcp.md`: MailCraft CLI, MCP bridge, and owner approval behavior.
- `processes/`: reusable workflows.
- `scripts/`: supporting helpers; optional dependencies are documented alongside them.
- `workspace/_shared/`: common report templates to copy into a project when missing.
- `docs/skills.md`: the skill index.
- `docs/editable-cards.md`: Gallery and Research card format and editing guide.
- `desktop/service/card-schema.mjs`: reusable card validator.

The initial library comes exclusively from the official MrMak source checkout.
See `provenance.json` and LICENSE. img2threejs retains its Apache-2.0 license and
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
