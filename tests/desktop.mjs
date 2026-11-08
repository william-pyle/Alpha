import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
fs.mkdirSync(".test-output", { recursive: true });
const profile = fs.mkdtempSync(path.resolve(".test-output/desktop-"));
const app = await electron.launch({
  ...(process.env.ALPHA_EXECUTABLE
    ? { executablePath: process.env.ALPHA_EXECUTABLE, args: [] }
    : { args: ["."] }),
  env: { ...process.env, ALPHA_TEST: "1", ALPHA_DATA_DIR: profile },
  timeout: 30000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("heading", { name: "Room for your next idea." })
    .waitFor();
  await page.screenshot({ path: ".test-output/alpha-overview.png" });
  const call = (type, payload) =>
    page.evaluate(
      async ({ type, payload }) => window.alpha.action(type, payload),
      { type, payload },
    );
  const snapshot = () => page.evaluate(() => window.alpha.snapshot());
  await page
    .getByRole("button", { name: "New window", exact: true })
    .first()
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "New window" })
      .getByLabel("Associated project"),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "PowerShell Ready", exact: true })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("Test studio");
  await page.getByLabel("Window name").fill("Shell one");
  await page.getByRole("button", { name: "Open window", exact: true }).click();
  await page
    .getByTestId(/^terminal-/)
    .first()
    .waitFor();
  let state = await snapshot();
  const project = state.projects[0],
    first = state.sessions[0];
  await page.evaluate(
    (id) =>
      window.alpha.terminalInput(id, "Write-Output 'ALPHA_TERMINAL_OK'\r"),
    first.id,
  );
  await expect
    .poll(async () => (await call("session.buffer", { id: first.id })).data)
    .toContain("ALPHA_TERMINAL_OK");
  const second = await call("session.launch", {
    provider: "gitbash",
    projectId: project.id,
    title: "Shell two",
  });
  await page.evaluate(
    (id) => window.alpha.terminalInput(id, "printf 'ALPHA_BASH_OK\\n'\r"),
    second.id,
  );
  await expect
    .poll(async () => (await call("session.buffer", { id: second.id })).data)
    .toContain("ALPHA_BASH_OK");
  await page
    .getByRole("button", { name: "Top and bottom", exact: true })
    .click();
  await expect(page.locator(".session-pane:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Side by side", exact: true }).click();
  assert.equal(
    (await snapshot()).sessions.filter((s) => s.status === "running").length,
    2,
  );
  await page.screenshot({ path: ".test-output/alpha-windows.png" });
  const shared = await call("record.save", {
    title: "Rendering cache",
    content: "Cache repeated rendering calculations.",
    tags: ["rendering"],
    importance: 4,
  });
  await call("record.save", {
    title: "Project palette",
    content: "Use cyan for the rendering palette.",
    scope: "project",
    projectId: project.id,
    tags: ["rendering"],
    links: [shared.id],
  });
  const other = await call("project.create", { name: "Private project" });
  await call("record.save", {
    title: "Rendering secret",
    content: "Never share this private rendering decision.",
    scope: "project",
    projectId: other.id,
  });
  await call("settings", { activeProjectId: project.id });
  const recall = await call("recall", {
    projectId: project.id,
    query: "rendering",
  });
  assert.equal(recall.items.length, 2);
  // Ask through the authenticated per-window HTTP tool endpoint using the real shell's environment.
  const command =
    "$body = @{ type = 'ask_question'; payload = @{ text = 'Which accent should this project use?'; area = 'Design'; options = @('Cyan','Orange') } } | ConvertTo-Json -Depth 4; Invoke-RestMethod -Method Post -Uri ($env:ALPHA_ENDPOINT + '/tool') -Headers @{ Authorization = ('Bearer ' + $env:ALPHA_SESSION_TOKEN) } -ContentType 'application/json' -Body $body | Out-Null\r";
  await page.evaluate(
    ({ id, command }) => window.alpha.terminalInput(id, command),
    { id: first.id, command },
  );
  await expect.poll(async () => (await snapshot()).questions.length).toBe(1);
  await page
    .locator(".main-nav")
    .getByRole("button", { name: /Questions/ })
    .click();
  await page.getByRole("button", { name: "Orange", exact: true }).click();
  assert.equal((await snapshot()).questions[0].answer, null);
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  state = await snapshot();
  assert.equal(state.questions[0].answer, "Orange");
  assert.equal(state.messages.at(-1).to, first.id);
  await page.getByRole("button", { name: /Answered/ }).click();
  await page.screenshot({ path: ".test-output/alpha-questions.png" });
  await call("viewer.detach");
  await expect.poll(() => app.windows().length).toBe(2);
  await call("viewer.dock");
  await expect.poll(() => app.windows().length).toBe(1);
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "Memory", exact: true })
    .click();
  await expect(page.locator(".graph-canvas canvas")).toHaveCount(1);
  await page.getByLabel("Memory retrieval query").fill("rendering");
  await page.getByRole("button", { name: "Find context" }).click();
  await expect(page.locator(".recall-result")).toContainText(
    "2 memories selected",
  );
  await page.screenshot({ path: ".test-output/alpha-memory.png" });
  for (const id of ["smurfs", "rena-higurashi", "alpha"]) {
    await call("settings", { themeId: id });
    await page
      .locator(".main-nav")
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await page.locator(".controller-card img").evaluate((img) => img.decode());
    await page.screenshot({ path: `.test-output/theme-${id}.png` });
  }
  const root = path.join(profile, "projects", project.id, "workspaces", "main");
  assert.ok(fs.statSync(root).isDirectory());
  fs.writeFileSync(
    path.join(root, "preview.html"),
    "<h1>Workspace preview</h1><p>Local content.</p>",
  );
  await call("settings", { viewerTab: "files", viewerMode: "docked" });
  await page
    .locator(".main-nav")
    .getByRole("button", { name: /Windows/ })
    .click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: "workspaces", exact: true })
    .click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: "main", exact: true })
    .click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: "preview.html", exact: true })
    .click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Workspace preview" }),
  ).toBeVisible();
  assert.equal(
    await page
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => typeof window.alpha),
    "undefined",
  );
  await call("session.close", { id: first.id });
  await call("session.close", { id: second.id });
  await page.evaluate(
    (id) => window.alpha.terminalInput(id, "ignored after close"),
    first.id,
  );
  await call("session.reopen", { id: first.id });
  await page.evaluate(
    (id) => window.alpha.terminalInput(id, "Write-Output 'REOPEN_OK'\r"),
    first.id,
  );
  await expect
    .poll(async () => (await call("session.buffer", { id: first.id })).data)
    .toContain("REOPEN_OK");
  assert.equal(
    (await snapshot()).sessions.filter((s) => s.id === first.id).length,
    1,
  );
  assert.equal((await snapshot()).questions[0].requester, first.id);
  await call("session.close", { id: first.id });
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    ".test-output/desktop-result.json",
    JSON.stringify(
      {
        passed: true,
        profile,
        checks: [
          "New Project launcher default",
          "PowerShell and Git Bash native PTYs",
          "Layout continuity",
          "Scoped retrieval",
          "Per-window tool authentication",
          "Central questions and answer delivery",
          "Detached/docked viewer",
          "Live WebGL memory",
          "Three theme images",
          "Project-owned files and isolated HTML viewer",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Desktop checks passed: terminals, scopes, questions, themes, graph and viewer.",
  );
} finally {
  await app.close();
}
