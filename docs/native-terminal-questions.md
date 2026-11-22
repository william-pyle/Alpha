# Native Questions and dispatch

The native prompt adapter began in Alpha 0.2.21. Source and fixture checks do not change an
already running service or establish that an installed UI works. Publication,
installation and live provider observations are separate release evidence.

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
Starting in 0.2.24, the Questions tab shows all pending items. Its count and list
update when answers are verified. Native fallback opens the originating terminal without unlocking it.

Only the recognized optional update **Skip** uses an automatic key under the
owner's active-work preference. It sends `2`, with no trailing Enter. Install,
update, restart, permanent dismissal and security approval are never automatic.
Passwords, login, unsupported providers, unknown/truncated menus, custom keymaps,
freeform/Other and notes-focused question forms remain native interactions.
Other structured questions that lack a recognized menu stay native. Codex async
questions have a separate supported reply protocol: only a completed native
async-question record enables its question-ID/index-bound reply envelope. Delivery
uses the recognized empty composer and verifies the exact native input record.
One answer cannot resolve sibling questions. Late receipt observation clears the
pending item without another submission, including after service restoration.
Ordinary prose answers also require exact native input-record acceptance.

## Full Access and folder trust

Alpha's `bypass` option supplies the provider's sandbox/approval bypass argument.
It does not write project trust. Saved lessons are handoff text, not configuration.
Codex stores trust by canonical project/repository path, with Windows case folding
and canonical/original lookup spellings; a renamed checkout is a new path, and a
wildcard lesson is not a provider trust entry.

In 0.2.24 the explicit Settings option for `C:/Projects` enables manual review
notifications. A recognized folder-trust prompt for a canonical candidate, or for
a path that could not be verified, links to its exact question in Needs attention.
Sibling prefixes, traversal, other drives and UNC locations are out of scope.
Junction escapes and unavailable paths require verification. The text detector
is used only to route a manual decision.

A safe automatic flow would require a provider-supported startup event or a
per-launch policy that verifies the exact repository trust target, respects an
explicit trust denial and verifies effective permissions before loading project
configuration. Codex documents a per-project trust setting, but this setting can
enable project configuration. Alpha has no verified pre-launch comparison that
guarantees the selected permissions remain in effect. The prior CLI override is
removed, and the native confirmation remains manual.

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
`question-acceptance.test.mjs`, and isolated `native-questions-ui.mjs`.

A live isolated Codex 0.170.0 check observed an async question, its exact reply
envelope acceptance, pending-list removal and the expected final answer without
manual keys or repeated submissions. The CLI's supported identity format and
envelope are defined in its tagged
[question state](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/bottom_pane/async_questions/state.rs)
and [reply parser](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/async_question_reply.rs).
This is separate from owner-installed UI verification. The default isolated
startup reached a composer without a trust menu, so it did not verify live trust
choice delivery. Optional update Skip remains covered by the isolated fixtures;
no live update was manufactured or installed for that check.
