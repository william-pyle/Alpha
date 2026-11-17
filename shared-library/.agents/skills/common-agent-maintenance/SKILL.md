---
name: common-agent-maintenance
description: Maintain Alpha's reusable agents when repeated work spans projects or an existing common agent needs a demonstrated correction. Use task evidence and version history; ordinary project work alone does not require creating an agent.
---

# Common agent maintenance

Use Alpha's Common agents records to identify work repeated across projects. Its
coordinator exposes `list_task_patterns`, `list_common_agents`,
`create_common_agent` and `revise_common_agent`. If these tools are not available
in the current worker, return the proposed change and supporting task IDs to Alpha
instead of inventing a connection or directly editing a live registry.

Compare the actual task evidence. Create a role only when its procedure can be
reused and it is not already covered by an existing role. A new learned role needs
at least three completed tasks across two projects. A completed turn proves that
the agent returned, not that its result was accepted or verified.

Keep instructions general and put project facts in the active project's records.
Use project-specific AGENTS.md files, tools and build commands at execution time.
Do not bake in credentials, conversations, account settings or one project's paths.

For maintenance, inspect the reported failure and current version. Make the narrow
instruction change that addresses the evidence, record the reason, and preserve the
previous version for rollback. A changed definition is not yet a validated outcome;
judge the next real result and its feedback before claiming improvement.

Route missing decisions through Questions. Report repeated failures or slowness
with a concrete fix or redesign proposal. Do not retry external actions, publish,
spend money or restart applications merely because a reusable role exists.
