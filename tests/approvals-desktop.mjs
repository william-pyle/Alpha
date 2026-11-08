import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Store } from "../electron/store.mjs";
fs.mkdirSync(".test-output", { recursive: true });
const profile = fs.mkdtempSync(path.resolve(".test-output/approvals-"));
const store = new Store(profile);
const project = store.createProject("Approval controls");
store.state.sessions = ["codex", "claude"].map((provider) => ({
  id: provider + "-saved",
  provider,
  projectId: project.id,
  workspaceId: "main",
  title: provider + " saved window",
  status: "stopped",
  approvalMode: "provider",
  contextIds: [],
  task: "",
  created: new Date().toISOString(),
}));
store.save();
const app = await electron.launch({
  ...(process.env.ALPHA_EXECUTABLE
    ? { executablePath: process.env.ALPHA_EXECUTABLE, args: [] }
    : { args: ["."] }),
  env: { ...process.env, ALPHA_TEST: "1", ALPHA_DATA_DIR: profile },
});
try {
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Windows", exact: true }).click();
  const mode = page.getByLabel("Approval mode for codex saved window", {
    exact: true,
  });
  await expect(mode).toHaveValue("provider");
  await mode.selectOption("always");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.alpha.snapshot())).sessions[0]
          .approvalMode,
    )
    .toBe("always");
  await expect(
    page.getByLabel("Approval mode for claude saved window", { exact: true }),
  ).toHaveValue("provider");
  assert.equal(
    (await page.evaluate(() => window.alpha.snapshot())).settings
      .defaultApprovalMode,
    "provider",
  );
  await assert.rejects(
    page.evaluate(() =>
      window.alpha.action("session.approval", {
        id: "codex-saved",
        approvalMode: "unknown",
      }),
    ),
    /approval mode/,
  );
  await expect(
    page.getByRole("button", { name: "Reopen / resume", exact: true }),
  ).toHaveCount(2);
  await page.screenshot({ path: ".test-output/saved-approval-modes.png" });
} finally {
  await app.close();
}
const recovered = new Store(profile);
assert.equal(recovered.state.sessions[0].approvalMode, "always");
assert.equal(recovered.state.sessions[1].approvalMode, "provider");
console.log(
  "Saved-window approval controls persist independently; no agent session was launched.",
);
