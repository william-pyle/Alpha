import { useEffect, useState } from "react";
import {
  FileText,
  Folder,
  ArrowLeft,
  RefreshCw,
  ExternalLink,
  PanelRightClose,
  Network,
  Files,
} from "lucide-react";
import type { Snapshot, Theme, RecordItem } from "./types";
import MemoryGraph from "./MemoryGraph";
type Entry = { name: string; path: string; directory: boolean };
export default function Viewer({
  state,
  theme,
  onRecord,
  run,
  standalone = false,
}: {
  state: Snapshot;
  theme: Theme;
  onRecord: (r: RecordItem) => void;
  run: (type: string, payload?: any) => Promise<any>;
  standalone?: boolean;
}) {
  const pid = state.settings.activeProjectId,
    project = state.projects.find((p) => p.id === pid),
    tab = state.settings.viewerTab;
  const [entries, setEntries] = useState<Entry[]>([]),
    [folder, setFolder] = useState(""),
    [selected, setSelected] = useState<Entry | null>(null),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setFolder("");
    setSelected(null);
  }, [pid]);
  useEffect(() => {
    if (!pid) return;
    let active = true;
    window.alpha
      .action("files.list", { projectId: pid, path: folder })
      .then((value) => {
        if (active) {
          setEntries(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [pid, folder, state]);
  const select = async (entry: Entry) => {
    if (entry.directory) {
      setFolder(entry.path);
      setSelected(null);
      return;
    }
    setSelected(entry);
    setText("");
    if (
      !/\.(html?|png|jpe?g|webp|gif|svg|pdf|mp4|webm|mp3|wav)$/i.test(
        entry.path,
      )
    ) {
      try {
        setText(
          await window.alpha.action("files.read", {
            projectId: pid,
            path: entry.path,
          }),
        );
      } catch (e) {
        setText(String(e));
      }
    }
  };
  const src = selected
    ? `alpha-file://${pid}/${selected.path.split("/").map(encodeURIComponent).join("/")}`
    : "";
  const records = state.records.filter(
    (r) => r.scope === "alpha" || r.projectId === pid,
  );
  return (
    <div
      className="viewer"
      style={
        {
          "--scene": theme.backdrop
            ? `url("${new URL(theme.backdrop, location.href).href}")`
            : "none",
          ...Object.fromEntries(
            Object.entries(theme)
              .filter(([k]) =>
                [
                  "background",
                  "surface",
                  "raised",
                  "accent",
                  "secondary",
                  "text",
                  "muted",
                  "border",
                ].includes(k),
              )
              .map(([k, v]) => ["--" + k, v]),
          ),
        } as React.CSSProperties
      }
    >
      <div className="viewer-header">
        <div>
          <span className="eyebrow">PROJECT VIEWER</span>
          <strong>{project?.name || "Alpha shared"}</strong>
        </div>
        <button
          title={standalone ? "Dock viewer" : "Detach viewer"}
          aria-label={standalone ? "Dock viewer" : "Detach viewer"}
          onClick={() => run(standalone ? "viewer.dock" : "viewer.detach")}
        >
          {standalone ? (
            <PanelRightClose size={17} />
          ) : (
            <ExternalLink size={17} />
          )}
        </button>
      </div>
      <div className="tabbar">
        <button
          className={tab === "memory" ? "active" : ""}
          onClick={() => run("settings", { viewerTab: "memory" })}
        >
          <Network size={15} /> Memory
        </button>
        <button
          className={tab === "files" ? "active" : ""}
          onClick={() => run("settings", { viewerTab: "files" })}
        >
          <Files size={15} /> Files
        </button>
      </div>
      {tab === "memory" ? (
        <>
          <MemoryGraph records={records} theme={theme} onSelect={onRecord} />
          <div className="viewer-records">
            {records.slice(0, 20).map((r) => (
              <button key={r.id} onClick={() => onRecord(r)}>
                <span>{r.title}</span>
                <small>{r.scope}</small>
              </button>
            ))}
            {!records.length && (
              <p className="muted">
                Saved knowledge will appear here as it is learned.
              </p>
            )}
          </div>
        </>
      ) : !pid ? (
        <div className="empty compact">
          Select a project to browse its workspaces.
        </div>
      ) : (
        <>
          <div className="file-path">
            <button
              title="Parent folder"
              onClick={() => {
                setFolder(folder.split("/").slice(0, -1).join("/"));
                setSelected(null);
              }}
              disabled={!folder}
            >
              <ArrowLeft size={15} />
            </button>
            <span>{folder || project?.name}</span>
            <button title="Refresh files" onClick={() => run("settings", {})}>
              <RefreshCw size={14} />
            </button>
            <button
              title="Open project folder"
              onClick={() => run("files.reveal", { projectId: pid })}
            >
              <ExternalLink size={14} />
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          {selected ? (
            <div className="file-preview">
              <button className="back-link" onClick={() => setSelected(null)}>
                <ArrowLeft size={14} /> Files / {selected.name}
              </button>
              {/\.(png|jpe?g|webp|gif|svg)$/i.test(selected.path) ? (
                <a href={src} download={selected.name}>
                  <img src={src} alt={selected.name} />
                </a>
              ) : /\.(html?|pdf)$/i.test(selected.path) ? (
                <iframe
                  title={selected.name}
                  src={src}
                  sandbox="allow-scripts allow-downloads"
                />
              ) : /\.(mp4|webm)$/i.test(selected.path) ? (
                <video src={src} controls />
              ) : /\.(mp3|wav)$/i.test(selected.path) ? (
                <audio src={src} controls />
              ) : (
                <pre>{text}</pre>
              )}
            </div>
          ) : (
            <div className="file-list">
              {entries.map((entry) => (
                <button key={entry.path} onClick={() => select(entry)}>
                  {entry.directory ? (
                    <Folder size={17} />
                  ) : (
                    <FileText size={17} />
                  )}
                  <span>{entry.name}</span>
                </button>
              ))}
              {!entries.length && (
                <p className="muted">
                  This folder is empty. Files created by your windows appear
                  here.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
