import { useState } from "react";
import { X, Plus, ArrowRight, TerminalSquare, Sparkles } from "lucide-react";
import type { Snapshot, RecordItem, ApprovalMode } from "./types";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button
            aria-label="Close dialog"
            className="icon-button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function NewWindow({
  state,
  onClose,
  run,
  onLaunch,
}: {
  state: Snapshot;
  onClose: () => void;
  run: (t: string, p?: any) => Promise<any>;
  onLaunch: (id: string) => void;
}) {
  const [provider, setProvider] = useState("codex"),
    [approvalMode, setApprovalMode] = useState<ApprovalMode>(
      state.settings.defaultApprovalMode,
    ),
    [projectId, setProjectId] = useState(""),
    [projectName, setProjectName] = useState(""),
    [workspaceId, setWorkspaceId] = useState(""),
    [title, setTitle] = useState(""),
    [task, setTask] = useState(""),
    [busy, setBusy] = useState(false);
  const project = state.projects.find((p) => p.id === projectId);
  return (
    <Modal
      title="New window"
      subtitle="Choose your tool. Give it a project. Make room for an idea."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const s = await run("session.launch", {
            provider,
            approvalMode,
            projectId: projectId || null,
            projectName,
            workspaceId: workspaceId || undefined,
            title,
            task,
          });
          setBusy(false);
          if (s) {
            onLaunch(s.id);
            onClose();
          }
        }}
      >
        <div className="provider-grid">
          {state.providers.map((p) => (
            <button
              type="button"
              className={provider === p.id ? "selected" : ""}
              key={p.id}
              onClick={() => setProvider(p.id)}
            >
              {["codex", "claude"].includes(p.id) ? (
                <Sparkles size={22} />
              ) : (
                <TerminalSquare size={22} />
              )}
              <strong>{p.label}</strong>
              <small>{p.available ? "Ready" : "Not installed"}</small>
            </button>
          ))}
        </div>
        <label>
          Associated project
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setWorkspaceId("");
            }}
          >
            <option value="">New Project</option>
            {state.projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {!projectId ? (
          <label>
            Project name
            <input
              autoFocus
              required
              maxLength={100}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="What are you working on?"
            />
          </label>
        ) : (
          <label>
            Workspace
            <select
              value={workspaceId || project?.workspaces[0].id}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {project?.workspaces.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Window name <span className="muted">optional</span>
          <input
            value={title}
            maxLength={100}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Interface design"
          />
        </label>
        {["codex", "claude"].includes(provider) && (
          <label>
            Approval mode
            <select
              aria-label="Approval mode"
              aria-describedby="approval-mode-help"
              value={approvalMode}
              onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)}
            >
              <option value="provider">Provider settings</option>
              <option value="always">Always approve</option>
            </select>
            <small id="approval-mode-help" className="muted">
              {approvalMode === "always"
                ? "Skips agent tool permission prompts. Codex also runs without its sandbox."
                : "Uses the provider's configured approval behavior."}
            </small>
          </label>
        )}
        {["codex", "claude"].includes(provider) && (
          <label>
            Initial task <span className="muted">optional</span>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Relevant shared and project knowledge will be selected for this task."
              rows={3}
            />
          </label>
        )}
        <footer>
          <span className="muted small">
            Uses your installed tools, login and model.
          </span>
          <button
            className="primary"
            disabled={
              busy || !state.providers.find((p) => p.id === provider)?.available
            }
          >
            {busy ? "Opening…" : "Open window"}
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function RecordEditor({
  record,
  kind,
  state,
  run,
  onClose,
}: {
  record?: RecordItem;
  kind: "knowledge" | "skill";
  state: Snapshot;
  run: (t: string, p?: any) => Promise<any>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(record?.title || ""),
    [content, setContent] = useState(record?.content || ""),
    [scope, setScope] = useState(record?.scope || "alpha"),
    [projectId, setProjectId] = useState(
      record?.projectId || state.settings.activeProjectId || "",
    ),
    [tags, setTags] = useState(record?.tags.join(" ") || ""),
    [importance, setImportance] = useState(record?.importance || 3),
    [pinned, setPinned] = useState(record?.pinned || false),
    [links, setLinks] = useState(record?.links || []),
    [source, setSource] = useState(record?.source || "User");
  const candidates = state.records.filter(
    (r) =>
      r.id !== record?.id &&
      (r.scope === "alpha" ||
        (scope === "project" && r.projectId === projectId)),
  );
  return (
    <Modal
      title={`${record ? "Edit" : "New"} ${kind === "skill" ? "skill" : "memory"}`}
      subtitle="Keep useful knowledge. Decide where it belongs."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await run("record.save", {
              id: record?.id,
              kind,
              title,
              content,
              scope,
              projectId: scope === "project" ? projectId : null,
              tags,
              importance,
              pinned,
              links: links.filter((id) => candidates.some((r) => r.id === id)),
              source,
            })
          )
            onClose();
        }}
      >
        <label>
          Title
          <input
            autoFocus
            value={title}
            required
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          {kind === "skill" ? "Instructions" : "Knowledge"}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            rows={7}
            maxLength={60000}
          />
        </label>
        <div className="form-row">
          <label>
            Scope
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "alpha" | "project")}
            >
              <option value="alpha">Alpha shared · all projects</option>
              <option value="project">Project-specific</option>
            </select>
          </label>
          {scope === "project" && (
            <label>
              Project
              <select
                required
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="" disabled>
                  Select project
                </option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Importance
            <select
              value={importance}
              onChange={(e) => setImportance(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((i) => (
                <option key={i} value={i}>
                  {i}
                  {i === 5 ? " · essential" : i === 3 ? " · normal" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Tags
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="design windows testing"
            />
          </label>
          <label>
            Source
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              maxLength={300}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
          />
          Always include as a governing instruction within this scope
        </label>
        {!!candidates.length && (
          <label>
            Related knowledge
            <select
              multiple
              value={links}
              onChange={(e) =>
                setLinks([...e.target.selectedOptions].map((o) => o.value))
              }
            >
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
            <small>Ctrl-click to select multiple related entries.</small>
          </label>
        )}
        <footer>
          {record && (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (
                  confirm(`Delete "${record.title}"?`) &&
                  (await run("record.delete", { id: record.id }))
                )
                  onClose();
              }}
            >
              Delete
            </button>
          )}
          <button className="primary">
            <Plus size={16} />
            Save {kind === "skill" ? "skill" : "memory"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
