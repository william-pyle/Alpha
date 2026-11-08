import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
fs.mkdirSync(".test-output", { recursive: true });
const profile = fs.mkdtempSync(path.resolve(".test-output/update-ui-"));
const app = await electron.launch({
  ...(process.env.ALPHA_EXECUTABLE
    ? { executablePath: process.env.ALPHA_EXECUTABLE, args: [] }
    : { args: ["."] }),
  env: { ...process.env, ALPHA_TEST: "1", ALPHA_DATA_DIR: profile },
});
try {
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "Room for your next idea." })
    .waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check for updates" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Automatic checks are disabled in isolated desktop tests."),
  ).toBeVisible();
  const state = await page.evaluate(() => window.alpha.snapshot());
  // Exercise UI states through the same main-process state event used in production.
  // Controller tests separately verify actual action dispatch and restart approval.
  const show = async (updates) =>
    app.evaluate(
      ({ BrowserWindow }, data) => {
        BrowserWindow.getAllWindows()[0].webContents.send("alpha:state", data);
      },
      { ...state, updates: { ...state.updates, ...updates } },
    );
  await show({
    status: "available",
    availableVersion: "0.2.0",
    message: "Alpha 0.2.0 is available.",
  });
  await expect(
    page
      .locator(".update-banner")
      .getByRole("button", { name: "Download update" }),
  ).toBeVisible();
  await page
    .locator(".update-banner")
    .getByRole("button", { name: "Dismiss update prompt" })
    .click();
  await expect(page.locator(".update-banner")).toHaveCount(0);
  await show({
    status: "downloading",
    progress: 42,
    message: "Downloading update… You can keep working.",
  });
  await expect(page.locator(".update-banner progress")).toHaveAttribute(
    "value",
    "42",
  );
  await show({
    status: "ready",
    progress: 100,
    availableVersion: "0.2.0",
    message: "Update downloaded. Restart when you're ready.",
  });
  await expect(
    page
      .locator(".update-banner")
      .getByRole("button", { name: "Restart and install" }),
  ).toBeVisible();
  await page.screenshot({ path: ".test-output/update-ready.png" });
  console.log(
    "Update UI passed: settings, available prompt, Later, progress and restart action.",
  );
} finally {
  await app.close();
}
