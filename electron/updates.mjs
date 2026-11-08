// Injected updater: test approval and failure behavior without replacing an app.
export class UpdateController {
  constructor({
    updater,
    version,
    releasesUrl,
    disabledReason = "",
    onChange,
    confirmInstall,
    beforeInstall = () => {},
  }) {
    this.updater = updater;
    this.onChange = onChange;
    this.confirmInstall = confirmInstall;
    this.beforeInstall = beforeInstall;
    this.state = {
      status: disabledReason ? "disabled" : "idle",
      currentVersion: version,
      availableVersion: null,
      releasesUrl,
      message: disabledReason,
      progress: 0,
      lastCheckedAt: null,
      dismissed: false,
    };
    this.operation = false;
    this.timers = [];
    if (disabledReason) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on("update-available", (info) => {
      const sameVersion = info.version === this.state.availableVersion;
      this.set({
        status: "available",
        availableVersion: info.version,
        message: `Alpha ${info.version} is available.`,
        progress: 0,
        dismissed: sameVersion && this.state.dismissed,
      });
    });
    updater.on("update-not-available", () =>
      this.set({
        status: "current",
        availableVersion: null,
        message: "You're up to date.",
      }),
    );
    updater.on("download-progress", (info) =>
      this.set({
        status: "downloading",
        progress: Math.max(0, Math.min(100, info.percent || 0)),
      }),
    );
    updater.on("update-downloaded", (info) =>
      this.set({
        status: "ready",
        availableVersion: info.version,
        progress: 100,
        dismissed: false,
        message: "Update downloaded. Restart when you're ready.",
      }),
    );
    updater.on("error", (error) => this.failed(error));
  }
  snapshot() {
    return { ...this.state };
  }
  set(patch) {
    Object.assign(this.state, patch);
    this.onChange?.(this.snapshot());
  }
  failed(error) {
    // Network errors may contain URLs or headers. Never send raw errors to UI.
    const noRelease =
      /404|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/.test(
        String(error?.code || "") + String(error?.message || ""),
      );
    this.set({
      status: "error",
      message: noRelease
        ? "No published update is available yet. Try again after the first GitHub release."
        : "The update could not be checked or downloaded. Check your connection and try again.",
    });
  }
  async check(manual = false) {
    if (
      this.state.status === "disabled" ||
      this.operation ||
      ["downloading", "installing"].includes(this.state.status)
    )
      return this.snapshot();
    if (this.state.status === "ready") {
      if (manual) this.set({ dismissed: false });
      return this.snapshot();
    }
    this.operation = true;
    this.set({
      status: "checking",
      message: "Checking GitHub for updates…",
      ...(manual ? { dismissed: false } : {}),
    });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.failed(error);
    } finally {
      this.operation = false;
      this.set({ lastCheckedAt: new Date().toISOString() });
    }
    return this.snapshot();
  }
  async download() {
    if (this.operation || this.state.status !== "available")
      throw new Error("Check for an available update before downloading.");
    this.operation = true;
    this.set({
      status: "downloading",
      progress: 0,
      dismissed: false,
      message: "Downloading update… You can keep working.",
    });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.failed(error);
    } finally {
      this.operation = false;
    }
    return this.snapshot();
  }
  dismiss() {
    this.set({ dismissed: true });
  }
  async install() {
    if (this.operation || this.state.status !== "ready")
      throw new Error("Download the update before installing it.");
    this.operation = true;
    try {
      if (!(await this.confirmInstall())) return false;
      this.beforeInstall();
      this.set({
        status: "installing",
        message: "Restarting to install the update…",
      });
      this.updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      this.failed(error);
      return false;
    } finally {
      this.operation = false;
    }
  }
  start() {
    if (this.state.status === "disabled") return;
    this.timers.push(setTimeout(() => void this.check(), 15000));
    this.timers.push(setInterval(() => void this.check(), 6 * 60 * 60 * 1000));
    for (const timer of this.timers) timer.unref?.();
  }
  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
