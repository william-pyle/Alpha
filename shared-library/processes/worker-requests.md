# Ask Alpha from a managed worker

When the Alpha request tools are available in a managed Codex session, use them
for app actions that Alpha owns. The host checks the active native task and its
project before acting. For the disposable Help preview, call
`alpha_list_disposable_previews`, then `alpha_request` with `close-preview`, the
exact listed ID and a request key unique to that task. Read the tool's result. If
it is pending, call `alpha_request_result` with the receipt ID. Use the same key
when checking whether an uncertain submission from the same task was accepted.

The host returns verified closure after the Workspace view confirms removal.
Editable documents, project reports, conversation tabs and terminals remain
under their existing controls. A stop request returns a denial. Route a separate
decision that needs the owner through Questions. Keep credentials, transcripts
and file paths out of worker requests.
