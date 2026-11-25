# Ask Alpha from a managed worker

In the expanded source, call `alpha_list_session_actions` during an active
managed Codex task to find the current project's exact IDs, eligible app views,
file references, and registered scripts. Submit the matching typed action with a
request key unique to this task. Reuse that key when checking an uncertain
submission. Check the receipt with `alpha_request_result`. Continued approval
or application may be pending. The receipt is returned through the originating
session's tool.

The existing Help tools remain available. Call `alpha_list_disposable_previews`,
then `alpha_request` with `close-preview` and the exact ID. Terminal stop
requests are denied.

## Projects and persistent report tabs

Use `alpha_create_project` for a Gallery or Research project. Use
`alpha_update_project` for status, an existing category, or pinning. Create a
blank Markdown tab, rename it, or request removal using the exact project and
report IDs. Home-project additions and renames are routine. Cross-project
changes and persistent removal prompt the owner in Questions. Removal hides the
entry from navigation and retains the underlying file and original numbered
link. Reserved report routes remain under their established workflows.

- “Create a blank Sprint notes report tab in my project and give me its tab ID.”
- “Ask Alpha to remove the Draft notes entry from my project navigation. Tell me what the receipt says.”

## Access, decisions, and recovery

`owner-denied` means the owner declined the request in Questions. Alpha
records that decision and will keep the same effect closed across new request
keys and host restarts. A different description or target alias cannot make
the same action eligible again.

`system-blocked` identifies a host, operating-system, or policy boundary. The
receipt includes the applicable next step. An owner decision authorizes only
the reviewed request within those boundaries. Alpha keeps the current access
and retries at most once when the host confirms a recoverable failure happened
before any effect. The receipt records the retry and its result. An
`unconfirmed` result means the effect could not be verified after dispatch.
Inspect the target state before taking further action.

- “Use the existing Alpha file request to copy the approved report. Read the receipt and tell me whether the host recovered or still needs attention.”
- “Check the last request receipt. If I denied it in Questions, leave the request closed and report the decision.”

## Open tabs and conversation layout

Use the current target handles to open a registered home-project report or
Help, activate or close an eligible open tab, or set 3D and Messages visibility.
Closing a project document tab leaves its persistent reports in place. Use the
layout handle for the currently selected Messages conversation. Alpha confirms
the rendered effect before reporting success. The 3D and Messages changes apply
to that conversation until the Workspace window reloads. Use View to restore
either panel. Settings keeps the default 3D preference.

- “Open the registered Overview report for this project, then confirm it is visible.”
- “Hide the Messages panel in this conversation and tell me when Alpha confirms the change.”

## File requests

For eligible registered Markdown reports, supply the exact file ID and
revision. The owner can obtain these from **Questions → File request references**.
A copy creates a new file with the same name in the other eligible project's
Workspace. At least one side must be the requesting project. An edit can add a
missing final newline, preserving the existing bytes. Each request needs a
one-time owner decision. Alpha rechecks the approved revisions, file identities,
and path boundaries in the Windows host before applying the change. File
contents stay in the existing project viewer or editor.

- “Copy the report with this file ID and revision from my project into project Beta. Request approval in Questions and check the receipt.”
- “Ask Alpha to add a missing final newline to this eligible Markdown report using the file ID and revision I provided.”

## Registered scripts

Use `alpha_run_script` with the exact catalog ID and project-bound revision from
the capability list. Native Questions approves one invocation. The bundled
`alpha-runtime-check` uses a fixed command and restricted Node runtime with an
empty working folder. Project scripts and Workspace tool commands are outside
this runner.

- “Ask Alpha to run its registered restricted-runtime check and read the receipt after the owner decides.”
- “List registered Alpha scripts for this project and ask for approval to run the runtime check at the listed revision.”

## Import an artifact from another project

Use `alpha_import_project_artifact` with the exact source project ID, artifact
kind, and artifact ID. Alpha selects your authenticated project as the
destination. The owner reviews the source, destination, and mapped references
in Questions and can approve one copy. Check the result with
`alpha_request_result`.

Imports use canonical private Windows project workspaces. Supported entries
are Codex skills under `.agents/skills`, Markdown knowledge under `knowledge`,
and Markdown definitions under `.claude/agents`. A skill may carry supported
Markdown references, license and notice files, and display-only metadata.
Knowledge and agent definitions are single documents. Alpha preserves license
and notice bytes and verifies repository ownership where linked.

Use Markdown links for dependencies inside a copied skill. For a portable
working-directory link, use the label **Working directory** or the
`alpha-working-directory` link title and point to the source Workspace root or
a copied folder. Alpha checks those targets and rewrites the links relative to
their destination. A required dependency outside the copied artifact, an
unsupported manifest field, or an existing destination blocks the import.
Resolve required missing decisions through Questions and submit a fresh
request after the source is ready. Import leaves the original intact and uses
the normal project loading behavior. It runs no scripts and starts no agent.

- “Ask Alpha to copy the Codex skill `release-check` from project `alpha` into this project. Check the receipt after I review the mapping.”
- “Request the reusable agent definition `reviewer` from project `team-guide`. Tell me whether the exact artifact was imported or which reference blocked it.”

Only managed Codex receives these tools when Alpha launches or resumes its CLI.
Use the same native conversation at a normal stopping point if an earlier CLI
is still running. Claude Code and other adapters are unavailable for this
workflow. Keep credentials, paths, transcripts and file contents out of requests.
