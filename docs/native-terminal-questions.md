# Native Questions and dispatch

These are unreleased source changes. They do not change an already running Alpha
service, install an update, or establish that an installed UI works.

Previously, task submission correctly rejected interactive menus, while Questions
only inferred terminal prose. Answer delivery then treated a local terminal write
as acceptance and could send a delayed Enter without checking the current menu.
This left native prompts behind the terminal lock and made answer removal premature.

## Supported choices

The adapter recognizes complete Codex numbered update and folder-trust menus, plus
choice-only questions matched against the current native question-tool record.
The displayed disclosure and actual options bind a fingerprint and generation to
the exact Alpha chat, originating thread, native conversation and process.
Selection highlighting is the only ignored display change. The current viewport
is used, never old scrollback. Every output transition invalidates an old binding.

Each answer is persisted as an intent, revalidated, and delivered once. Trust
selection and Enter confirmation have separate validation. A stable next supported
prompt or native composer proves a transition; a blank redraw does not. An uncertain
delivery stays pending and is never replayed, including after service restart.
Questions displays one item at a time and hides when the verified pending list is
empty. Native fallback opens the originating terminal without unlocking it.

Only the recognized optional update **Skip** uses an automatic key under the
owner's active-work preference. It sends `2`, with no trailing Enter. Install,
update, restart, permanent dismissal and security approval are never automatic.
Passwords, login, unsupported providers, unknown/truncated menus, custom keymaps,
freeform/Other and notes-focused question forms remain native interactions.
Structured questions that lack a recognized menu cannot become composed task or
shell input. Ordinary prose answers require exact native input-record acceptance.

## Full Access and folder trust

Alpha's `bypass` option supplies the provider's sandbox/approval bypass argument.
It does not write project trust. Saved lessons are handoff text, not configuration.
Codex stores trust by canonical project/repository path, with Windows case folding
and canonical/original lookup spellings; a renamed checkout is a new path, and a
wildcard lesson is not a provider trust entry.

An explicit Settings option supports the owner's approved `C:/Projects` scope for
future Codex launches. It supplies a provider-supported exact `projects.<path>`
configuration entry only after checking canonical cwd and repository trust target.
Sibling prefixes, traversal, other drives, UNC locations and junction escapes are
excluded. Linked worktrees check their common repository root. It neither rewrites
the provider configuration file nor changes permission flags. The opt-in is not
inferred from a lesson, and this task did not enable it in live settings. Without
that opt-in, a user's selected Trust choice follows the provider's own persistence.

Evidence was checked against installed `codex-cli 0.169.1` and its tagged sources:
[update keys](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/tui/src/update_prompt.rs),
[trust confirmation](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/tui/src/onboarding/trust_directory.rs),
[trust lookup](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/config/src/loader/mod.rs),
[question keys](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs).
No live provider configuration was inspected; a particular corrupted or missing
local trust entry has not been established.

## Recovering partial dispatch

Use a stable `submissionId` for each authorized task. `send_to_chat` returns within
one second with a pending receipt if verification is ongoing; up to four terminal
submissions run concurrently, with at most 80 waiting. Read that chat's submissions
to distinguish paste, submit, queue and exact native acceptance. Reuse the same ID
and text across coordinator turns. `retry: true` is accepted only for blocked,
failed or timed-out receipts with no paste intent. Pasted, uncertain and accepted
work cannot be replayed through that ID. Accepted IDs are retained rather than
silently evicted. The twelve-worker fixture verifies one payload per worker and
exact native-record acceptance; it is not evidence of a live twelve-worker run.

Tests: `native-prompts.test.mjs`, `terminal-submission.test.mjs`,
`question-acceptance.test.mjs`, and isolated `native-questions-ui.mjs`. Live installed
UI/provider verification requires a later authorized release and installation.
