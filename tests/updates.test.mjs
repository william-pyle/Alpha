import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { UpdateController } from "../electron/updates.mjs";
function setup(options = {}) {
  const updater = new EventEmitter();
  const calls = {
    checks: 0,
    downloads: 0,
    installs: 0,
    saves: 0,
    confirmations: 0,
  };
  updater.checkForUpdates = async () => {
    calls.checks++;
    updater.emit("update-available", { version: "0.2.0" });
  };
  updater.downloadUpdate = async () => {
    calls.downloads++;
    updater.emit("download-progress", { percent: 42 });
    updater.emit("update-downloaded", { version: "0.2.0" });
  };
  updater.quitAndInstall = () => {
    calls.installs++;
  };
  const changes = [];
  const controller = new UpdateController({
    updater,
    version: "0.1.1",
    releasesUrl: "https://github.com/william-pyle/Alpha/releases",
    onChange: (s) => changes.push(s),
    confirmInstall: async () => {
      calls.confirmations++;
      return false;
    },
    beforeInstall: () => {
      calls.saves++;
    },
    ...options,
  });
  return { updater, controller, changes, calls };
}
test("checks never download or install without explicit actions", async () => {
  const { updater, controller, calls } = setup();
  for (const key of [
    "autoDownload",
    "autoInstallOnAppQuit",
    "allowPrerelease",
    "allowDowngrade",
  ])
    assert.equal(updater[key], false);
  await controller.check();
  assert.equal(controller.state.status, "available");
  assert.equal(calls.downloads, 0);
  assert.equal(calls.installs, 0);
  await assert.rejects(controller.install(), /Download/);
});
test("Later defers a version; manual checks and a new version reveal the prompt", async () => {
  const { updater, controller } = setup();
  await controller.check();
  controller.dismiss();
  await controller.check();
  assert.equal(controller.state.dismissed, true);
  await controller.check(true);
  assert.equal(controller.state.dismissed, false);
  controller.dismiss();
  updater.emit("update-available", { version: "0.3.0" });
  assert.equal(controller.state.dismissed, false);
});
test("download progress is visible and cancelling restart keeps sessions intact", async () => {
  const { controller, changes, calls } = setup();
  await controller.check();
  await controller.download();
  assert.ok(changes.some((s) => s.progress === 42));
  assert.equal(controller.state.status, "ready");
  controller.dismiss();
  await controller.check(true);
  assert.equal(controller.state.dismissed, false);
  assert.equal(await controller.install(), false);
  assert.equal(calls.confirmations, 1);
  assert.equal(calls.saves, 0);
  assert.equal(calls.installs, 0);
  assert.equal(controller.state.status, "ready");
  controller.confirmInstall = async () => true;
  await controller.install();
  assert.equal(calls.saves, 1);
  assert.equal(calls.installs, 1);
});
test("failed downloads cannot install; retry recovers without exposing raw errors", async () => {
  const { updater, controller, calls } = setup();
  await controller.check();
  const download = updater.downloadUpdate;
  updater.downloadUpdate = async () => {
    throw new Error("https://example.invalid?token=private-value");
  };
  await controller.download();
  assert.equal(controller.state.status, "error");
  assert.ok(!JSON.stringify(controller.snapshot()).includes("private-value"));
  await assert.rejects(controller.install(), /Download/);
  assert.equal(calls.installs, 0);
  updater.downloadUpdate = download;
  await controller.check();
  await controller.download();
  assert.equal(controller.state.status, "ready");
});
test("duplicate checks and actions cannot race an in-flight download", async () => {
  const { updater, controller, calls } = setup();
  let finish;
  updater.checkForUpdates = () => {
    calls.checks++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = controller.check();
  await controller.check();
  assert.equal(calls.checks, 1);
  updater.emit("update-available", { version: "0.2.0" });
  finish();
  await pending;
  updater.downloadUpdate = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const downloading = controller.download();
  await controller.check();
  assert.equal(calls.checks, 1);
  await assert.rejects(controller.download(), /Check/);
  updater.emit("update-downloaded", { version: "0.2.0" });
  await assert.rejects(controller.install(), /Download/);
  finish();
  await downloading;
});
test("development and portable builds do not start update network activity", async () => {
  const { controller, calls } = setup({ disabledReason: "Use the installer." });
  controller.start();
  await controller.check(true);
  assert.equal(calls.checks, 0);
  assert.equal(controller.timers.length, 0);
  assert.equal(controller.state.status, "disabled");
});
