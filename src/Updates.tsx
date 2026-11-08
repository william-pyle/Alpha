import { Download, RefreshCw, ExternalLink, X } from "lucide-react";
import type { UpdateState } from "./types";

export default function Updates({
  state,
  run,
  compact = false,
}: {
  state: UpdateState;
  run: (type: string) => Promise<any>;
  compact?: boolean;
}) {
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  if (
    compact &&
    (state.dismissed ||
      !["available", "downloading", "ready", "error"].includes(state.status))
  )
    return null;
  return (
    <section
      className={compact ? "update-banner" : "panel settings-panel"}
      aria-label="Application updates"
      aria-live="polite"
    >
      <div className="update-copy">
        <h2>
          {compact
            ? state.status === "ready"
              ? "Ready to update"
              : "Alpha updates"
            : "Updates"}
        </h2>
        <p>
          {state.message ||
            `Alpha ${state.currentVersion}. Checks GitHub automatically on startup and every six hours.`}
        </p>
        {!compact && (
          <p className="muted small">
            Current version: {state.currentVersion}
            {state.lastCheckedAt &&
              ` · Last checked: ${new Date(state.lastCheckedAt).toLocaleString()}`}
          </p>
        )}
        {state.status === "downloading" && (
          <div className="update-progress">
            <progress
              max="100"
              value={state.progress}
              aria-label="Update download progress"
            />
            <span>{Math.round(state.progress)}%</span>
          </div>
        )}
      </div>
      <div className="update-actions">
        {state.status === "available" && (
          <button className="primary" onClick={() => run("updates.download")}>
            <Download size={16} />
            Download update
          </button>
        )}
        {state.status === "ready" && (
          <button className="primary" onClick={() => run("updates.install")}>
            <RefreshCw size={16} />
            Restart and install
          </button>
        )}
        {!compact && (
          <button
            disabled={busy || state.status === "disabled"}
            onClick={() => run("updates.check")}
          >
            <RefreshCw size={16} />
            {state.status === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
        {state.status === "error" && compact && (
          <button onClick={() => run("updates.check")}>Try again</button>
        )}
        {!compact && (
          <button onClick={() => run("updates.releases")}>
            <ExternalLink size={16} />
            GitHub releases
          </button>
        )}
        {compact && (
          <button
            onClick={() => run("updates.dismiss")}
            aria-label="Dismiss update prompt"
          >
            {busy ? <X size={16} /> : "Later"}
          </button>
        )}
      </div>
      {!compact && (
        <p className="muted small">
          Updates download only when you choose. Alpha asks again before
          restarting and stopping any running windows.
        </p>
      )}
    </section>
  );
}
