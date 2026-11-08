import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Boxes,
  Check,
  ChevronDown,
  Columns2,
  Folder,
  Grid2X2,
  HelpCircle,
  Layers,
  MessageSquare,
  Network,
  PanelRight,
  Palette,
  Plus,
  Search,
  Send,
  Settings,
  Square,
  TerminalSquare,
  Rows2,
  X,
  ExternalLink,
  Pin,
  FileText,
} from "lucide-react";
import type { Snapshot, RecordItem, Recall } from "./types";
import TerminalPane from "./TerminalPane";
import MemoryGraph from "./MemoryGraph";
import Viewer from "./Viewer";
import Questions from "./Questions";
import ThemeEditor from "./ThemeEditor";
import Updates from "./Updates";
import { Modal, NewWindow, RecordEditor } from "./Dialogs";

export default function App() {
  const [state, setState] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [view, setView] = useState("overview"),
    [newWindow, setNewWindow] = useState(false),
    [newProject, setNewProject] = useState(false),
    [projectName, setProjectName] = useState(""),
    [workspaceModal, setWorkspaceModal] = useState(false),
    [workspaceName, setWorkspaceName] = useState(""),
    [editor, setEditor] = useState<{
      kind: "knowledge" | "skill";
      record?: RecordItem;
    } | null>(null),
    [inspect, setInspect] = useState<RecordItem | null>(null),
    [activeWindow, setActiveWindow] = useState(""),
    [query, setQuery] = useState(""),
    [scope, setScope] = useState("effective"),
    [recall, setRecall] = useState<Recall | null>(null),
    [recallQuery, setRecallQuery] = useState(""),
    [recipient, setRecipient] = useState(""),
    [message, setMessage] = useState(""),
    [task, setTask] = useState(""),
    [viewerWidth, setViewerWidth] = useState(400),
    [split, setSplit] = useState(50);
  const detached = new URLSearchParams(location.search).has("viewer");
  useEffect(() => {
    window.alpha
      .snapshot()
      .then(setState)
      .catch((e) => setError(e.message));
    return window.alpha.onState(setState);
  }, []);
  const run = async (type: string, payload?: any) => {
    try {
      const result = await window.alpha.action(type, payload);
      setError("");
      return result ?? true;
    } catch (e) {
      setError(
        String(e).replace(
          /^Error: Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
      return false;
    }
  };
  const theme =
    state?.themes.find((t) => t.id === state.settings.themeId) ||
    state?.themes[0];
  useEffect(() => {
    if (!theme) return;
    for (const k of [
      "background",
      "surface",
      "raised",
      "accent",
      "secondary",
      "text",
      "muted",
      "border",
    ] as const)
      document.documentElement.style.setProperty("--" + k, theme[k]);
    document.documentElement.style.setProperty(
      "--scene",
      theme.backdrop
        ? `url("${new URL(theme.backdrop, location.href).href}")`
        : "none",
    );
    document.documentElement.dataset.atmosphere = theme.atmosphere;
    document.title = theme.displayName;
  }, [theme]);
  if (!state || !theme)
    return (
      <div className="loading">
        <img src="art/alpha.svg" alt="Alpha" />
        <h1>Alpha</h1>
        <p>{error || "Opening your workspace…"}</p>
      </div>
    );
  const pid = state.settings.activeProjectId,
    project = state.projects.find((p) => p.id === pid),
    projectTheme = state.themes.find((t) => t.id === project?.themeId) || theme;
  const sessions = state.sessions.filter((s) => s.projectId === pid),
    selectedSession =
      sessions.find((s) => s.id === activeWindow) || sessions.at(-1),
    effective = state.records.filter(
      (r) => r.scope === "alpha" || r.projectId === pid,
    ),
    pending = state.questions.filter((q) => q.status === "pending").length,
    running = state.sessions.filter((s) => s.status === "running").length;
  const navigation = [
    { id: "overview", label: "Overview", Icon: Activity },
    { id: "windows", label: "Windows", Icon: TerminalSquare },
    { id: "memory", label: "Memory", Icon: Network },
    { id: "skills", label: "Skills", Icon: BookOpen },
    { id: "questions", label: "Questions", Icon: HelpCircle },
    { id: "messages", label: "Messages", Icon: MessageSquare },
  ];
  const libraryKind = view === "skills" ? "skill" : "knowledge";
  const records = state.records.filter(
    (r) =>
      r.kind === libraryKind &&
      (scope === "all" || scope === "shared"
        ? scope === "all" || r.scope === "alpha"
        : scope === "project"
          ? r.scope === "project" && r.projectId === pid
          : r.scope === "alpha" || r.projectId === pid) &&
      `${r.title} ${r.content} ${r.tags.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const openProject = async (id: string) => {
    await run("settings", { activeProjectId: id });
    setInspect(null);
    setRecall(null);
  };
  const openWindow = () => setNewWindow(true);
  const modalContent = (
    <>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      {newWindow && (
        <NewWindow
          state={state}
          run={run}
          onClose={() => setNewWindow(false)}
          onLaunch={(id) => {
            setActiveWindow(id);
            setView("windows");
          }}
        />
      )}
      {newProject && (
        <Modal
          title="New project"
          subtitle="A home for your windows, workspaces and project knowledge."
          onClose={() => setNewProject(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const p = await run("project.create", { name: projectName });
              if (p) {
                setNewProject(false);
                setProjectName("");
                setView("overview");
              }
            }}
          >
            <label>
              Project name
              <input
                autoFocus
                required
                maxLength={100}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Give your project a name"
              />
            </label>
            <footer>
              <button className="primary">
                Create project
                <ArrowRight size={16} />
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {workspaceModal && (
        <Modal
          title="New workspace"
          subtitle={`Inside ${project?.name}`}
          onClose={() => setWorkspaceModal(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run("workspace.create", {
                  projectId: pid,
                  name: workspaceName,
                })
              ) {
                setWorkspaceModal(false);
                setWorkspaceName("");
              }
            }}
          >
            <label>
              Workspace name
              <input
                autoFocus
                required
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
              />
            </label>
            <footer>
              <button className="primary">Create workspace</button>
            </footer>
          </form>
        </Modal>
      )}
      {editor && (
        <RecordEditor
          kind={editor.kind}
          record={editor.record}
          state={state}
          run={run}
          onClose={() => setEditor(null)}
        />
      )}{" "}
      {inspect && (
        <Modal
          title={inspect.title}
          subtitle={`${inspect.kind} · ${inspect.scope === "alpha" ? "Alpha shared" : state.projects.find((p) => p.id === inspect.projectId)?.name}`}
          onClose={() => setInspect(null)}
          wide
        >
          <div className="record-detail">
            <div className="tags">
              {inspect.pinned && (
                <span>
                  <Pin size={12} />
                  Pinned instruction
                </span>
              )}
              {inspect.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <p className="preserve">{inspect.content}</p>
            <dl>
              <dt>Source</dt>
              <dd>{inspect.source}</dd>
              <dt>Importance</dt>
              <dd>{inspect.importance}/5</dd>
              <dt>Updated</dt>
              <dd>{new Date(inspect.updated).toLocaleString()}</dd>
            </dl>
            {inspect.links.map((id) => {
              const r = state.records.find((r) => r.id === id);
              return r ? (
                <button key={id} onClick={() => setInspect(r)}>
                  <Network size={14} />
                  {r.title}
                </button>
              ) : null;
            })}
            <footer>
              <button
                className="primary"
                onClick={() => {
                  setEditor({ kind: inspect.kind, record: inspect });
                  setInspect(null);
                }}
              >
                Edit {inspect.kind}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
  if (detached)
    return (
      <div className="detached-viewer">
        <Viewer
          state={state}
          theme={projectTheme}
          onRecord={setInspect}
          run={run}
          standalone
        />
        {modalContent}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("overview")}>
          <img src={theme.avatar} alt={theme.controller} />
          <div>
            <strong>{theme.displayName}</strong>
            <span>YOUR CREATIVE SPACE</span>
          </div>
        </button>
        <button
          className="new-window primary"
          aria-label="New window"
          onClick={openWindow}
        >
          <Plus size={18} />
          New window<span>↗</span>
        </button>
        <nav className="main-nav">
          {navigation.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              <span className="themed-nav-icon">
                {theme.id !== "alpha" && <img src={theme.avatar} alt="" />}
                <Icon size={18} />
              </span>
              <span>{label}</span>
              {id === "questions" && pending > 0 && <b>{pending}</b>}
              {id === "windows" && running > 0 && <small>{running}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-title">
          <span>PROJECTS</span>
          <button
            aria-label="New project"
            title="New project"
            onClick={() => setNewProject(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="project-nav">
          {state.projects.map((p) => (
            <div key={p.id}>
              <button
                className={pid === p.id ? "selected" : ""}
                onClick={() => openProject(p.id)}
              >
                <Folder size={16} />
                <span>{p.name}</span>
                {pid === p.id && <ChevronDown size={13} />}
              </button>
              {pid === p.id && (
                <div className="workspace-list">
                  {p.workspaces.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => {
                        setView("windows");
                        run("settings", {
                          viewerTab: "files",
                          viewerMode: "docked",
                        });
                      }}
                    >
                      <span className="branch" />
                      <Layers size={13} />
                      {w.name}
                    </button>
                  ))}
                  <button onClick={() => setWorkspaceModal(true)}>
                    <Plus size={12} />
                    Add workspace
                  </button>
                </div>
              )}
            </div>
          ))}
          {!state.projects.length && (
            <button
              className="first-project"
              onClick={() => setNewProject(true)}
            >
              <Folder size={16} />
              Create your first project
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={view === "themes" ? "active" : ""}
            onClick={() => setView("themes")}
          >
            <Palette size={17} />
            Themes
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            <Settings size={17} />
            Settings
          </button>
          <div className="controller-mini">
            <img src={theme.avatar} alt="" />
            <div>
              <strong>{theme.controller}</strong>
              <span>
                <i className="dot" />
                Workspace controller
              </span>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{theme.displayName}</span>
            <span>/</span>
            <strong>{project?.name || "All projects"}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-label">
              <i className="dot" />
              Local workspace
            </span>
            <button
              title="Toggle docked viewer"
              aria-label="Toggle docked viewer"
              onClick={() =>
                run("settings", {
                  viewerMode:
                    state.settings.viewerMode === "docked"
                      ? "hidden"
                      : "docked",
                })
              }
            >
              <PanelRight size={18} />
            </button>
            <button title="Questions" onClick={() => setView("questions")}>
              <HelpCircle size={18} />
              {pending > 0 && <span className="count">{pending}</span>}
            </button>
          </div>
        </header>
        <Updates state={state.updates} run={run} compact />
        <div
          className={
            "work-area " +
            (view === "windows" && state.settings.viewerMode === "docked"
              ? "with-viewer"
              : "")
          }
        >
          <main className="main-content">
            {view === "overview" && (
              <div className="page overview">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">
                      {project
                        ? "PROJECT OVERVIEW"
                        : "WELCOME TO YOUR WORKSPACE"}
                    </span>
                    <h1>{project?.name || "Room for your next idea."}</h1>
                    <p className="muted">
                      Your tools, knowledge and conversations. Connected.
                    </p>
                  </div>
                  <button onClick={openWindow} className="primary">
                    <Plus size={16} />
                    New window
                  </button>
                </div>
                <div className="overview-grid">
                  <section className="hero-graph panel">
                    <MemoryGraph
                      records={effective}
                      theme={theme}
                      onSelect={setInspect}
                      highlight={selectedSession?.contextIds}
                    />
                    <div className="graph-summary">
                      <div>
                        <strong>A living memory</strong>
                        <p>
                          Only the knowledge that matters, when you need it.
                        </p>
                      </div>
                      <button
                        onClick={() => setView("memory")}
                        aria-label="Explore memory"
                      >
                        <ArrowRight size={20} />
                      </button>
                    </div>
                  </section>
                  <div className="overview-side">
                    <section className="controller-card panel">
                      <div className="halo">
                        <img src={theme.avatar} alt={theme.controller} />
                      </div>
                      <span className="eyebrow">YOUR CONTROLLER</span>
                      <h2>{theme.controller}</h2>
                      <p>
                        {pending
                          ? `${pending} question${pending === 1 ? "" : "s"} waiting for your direction.`
                          : "Everything has a place. Let’s make something."}
                      </p>
                      <button
                        onClick={() =>
                          setView(pending ? "questions" : "windows")
                        }
                      >
                        {pending ? "Review questions" : "Open your windows"}
                        <ArrowRight size={15} />
                      </button>
                    </section>
                    <div className="stat-grid">
                      <button
                        className="panel"
                        onClick={() => setView("windows")}
                      >
                        <TerminalSquare size={17} />
                        <strong>{running}</strong>
                        <span>Live windows</span>
                      </button>
                      <button
                        className="panel"
                        onClick={() => setView("memory")}
                      >
                        <Network size={17} />
                        <strong>{effective.length}</strong>
                        <span>Memory nodes</span>
                      </button>
                    </div>
                  </div>
                </div>
                <div className="section-heading subheading">
                  <h2>
                    {project ? "Project workspaces" : "Start something new"}
                  </h2>
                  {project && (
                    <button onClick={() => setWorkspaceModal(true)}>
                      <Plus size={15} />
                      Workspace
                    </button>
                  )}
                </div>
                {project ? (
                  <div className="workspace-cards">
                    {project.workspaces.map((w) => (
                      <button
                        className="panel"
                        key={w.id}
                        onClick={() => {
                          setView("windows");
                          run("settings", {
                            viewerTab: "files",
                            viewerMode: "docked",
                          });
                        }}
                      >
                        <Folder size={22} />
                        <div>
                          <strong>{w.name}</strong>
                          <span>
                            {
                              sessions.filter((s) => s.workspaceId === w.id)
                                .length
                            }{" "}
                            windows · project-owned workspace
                          </span>
                        </div>
                        <ArrowRight size={17} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="quick-start">
                    <button
                      className="panel"
                      onClick={() => setNewProject(true)}
                    >
                      <Boxes size={24} />
                      <h3>Create a project</h3>
                      <p>Give your work a home.</p>
                      <ArrowRight size={18} />
                    </button>
                    <button
                      className="panel"
                      onClick={() => setEditor({ kind: "knowledge" })}
                    >
                      <Network size={24} />
                      <h3>Add your first memory</h3>
                      <p>A useful lesson, available next time.</p>
                      <ArrowRight size={18} />
                    </button>
                    <button className="panel" onClick={() => setView("themes")}>
                      <Palette size={24} />
                      <h3>Choose your world</h3>
                      <p>Alpha, Smurfs or Higurashi.</p>
                      <ArrowRight size={18} />
                    </button>
                  </div>
                )}
              </div>
            )}
            {view === "windows" && (
              <div className="windows-page">
                <div className="window-toolbar">
                  <div>
                    <h1>Windows</h1>
                    <span className="muted small">
                      {project?.name || "Choose a project to begin"}
                    </span>
                  </div>
                  <div className="layout-buttons">
                    {[
                      { id: "columns", Icon: Columns2, label: "Side by side" },
                      { id: "rows", Icon: Rows2, label: "Top and bottom" },
                      { id: "grid", Icon: Grid2X2, label: "Grid" },
                      { id: "tabs", Icon: Square, label: "Tabs" },
                    ].map(({ id, Icon, label }) => (
                      <button
                        key={id}
                        title={label}
                        aria-label={label}
                        className={state.settings.layout === id ? "active" : ""}
                        onClick={() => run("settings", { layout: id })}
                      >
                        <Icon size={17} />
                      </button>
                    ))}
                    {sessions.length === 2 &&
                      state.settings.layout === "columns" && (
                        <input
                          aria-label="Pane balance"
                          type="range"
                          min="25"
                          max="75"
                          value={split}
                          onChange={(e) => setSplit(Number(e.target.value))}
                        />
                      )}
                    <button onClick={openWindow} title="New window">
                      <Plus size={18} />
                    </button>
                  </div>
                </div>
                {!sessions.length ? (
                  <div className="empty">
                    <TerminalSquare size={44} />
                    <h2>A window into your work</h2>
                    <p>Open Codex, Claude Code, PowerShell or Git Bash.</p>
                    <button className="primary" onClick={openWindow}>
                      <Plus size={16} />
                      New window
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="session-tabs">
                      {sessions.map((s) => (
                        <button
                          key={s.id}
                          className={
                            selectedSession?.id === s.id ? "active" : ""
                          }
                          onClick={() => setActiveWindow(s.id)}
                        >
                          <i
                            className={
                              "dot " + (s.status === "running" ? "" : "off")
                            }
                          />
                          {s.title}
                        </button>
                      ))}
                    </div>
                    <div
                      className={"session-grid " + state.settings.layout}
                      style={
                        sessions.length === 2 &&
                        state.settings.layout === "columns"
                          ? {
                              gridTemplateColumns: `minmax(0,${split}fr) minmax(0,${100 - split}fr)`,
                            }
                          : undefined
                      }
                    >
                      {sessions.map((s) => (
                        <section
                          className={
                            "session-pane " +
                            (selectedSession?.id === s.id ? "focused" : "")
                          }
                          key={s.id}
                          style={{
                            display:
                              state.settings.layout === "tabs" &&
                              selectedSession?.id !== s.id
                                ? "none"
                                : undefined,
                          }}
                          onMouseDown={() => setActiveWindow(s.id)}
                        >
                          <div className="pane-header">
                            <span>
                              <TerminalSquare size={14} />
                              <strong>{s.title}</strong>
                              <small>
                                {
                                  state.providers.find(
                                    (p) => p.id === s.provider,
                                  )?.label
                                }
                              </small>
                            </span>
                            <div>
                              <button
                                title="Window inbox"
                                onClick={() => {
                                  setRecipient(s.id);
                                  setView("messages");
                                }}
                              >
                                <MessageSquare size={14} />
                                {state.messages.filter(
                                  (m) => m.to === s.id && !m.read,
                                ).length || ""}
                              </button>
                              <button
                                aria-label={
                                  s.status === "running"
                                    ? `Close ${s.title}`
                                    : `Remove ${s.title}`
                                }
                                title={
                                  s.status === "running"
                                    ? "Stop window"
                                    : "Remove stopped window"
                                }
                                onClick={() => {
                                  if (
                                    s.status !== "running" ||
                                    confirm(`Stop ${s.title}?`)
                                  )
                                    run(
                                      s.status === "running"
                                        ? "session.close"
                                        : "session.hide",
                                      { id: s.id },
                                    );
                                }}
                              >
                                <X size={15} />
                              </button>
                            </div>
                          </div>
                          {["codex", "claude"].includes(s.provider) && (
                            <div className="session-approval">
                              {s.status === "running" ? (
                                <span>
                                  Approval mode:{" "}
                                  <strong>
                                    {s.approvalMode === "always"
                                      ? "Always approve"
                                      : "Provider settings"}
                                  </strong>
                                </span>
                              ) : (
                                <label>
                                  Approval mode
                                  <select
                                    aria-label={`Approval mode for ${s.title}`}
                                    value={s.approvalMode}
                                    onChange={(e) =>
                                      run("session.approval", {
                                        id: s.id,
                                        approvalMode: e.target.value,
                                      })
                                    }
                                  >
                                    <option value="provider">
                                      Provider settings
                                    </option>
                                    <option value="always">
                                      Always approve
                                    </option>
                                  </select>
                                </label>
                              )}
                            </div>
                          )}
                          <TerminalPane id={s.id} theme={theme} />
                          {s.status !== "running" && (
                            <div className="session-ended">
                              <span>
                                Window stopped · terminal history retained
                              </span>
                              <button
                                onClick={() =>
                                  run("session.reopen", { id: s.id })
                                }
                              >
                                {["codex", "claude"].includes(s.provider)
                                  ? "Reopen / resume"
                                  : "Reopen window"}
                              </button>
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                    {selectedSession &&
                      ["codex", "claude"].includes(selectedSession.provider) &&
                      selectedSession.status === "running" && (
                        <form
                          className="context-composer"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (
                              await run("session.prompt", {
                                id: selectedSession.id,
                                text: task,
                              })
                            ) {
                              setTask("");
                            }
                          }}
                        >
                          <input
                            aria-label="Task with selected context"
                            value={task}
                            onChange={(e) => setTask(e.target.value)}
                            placeholder={`Prepare a task for ${selectedSession.title} with relevant memory…`}
                            required
                          />
                          <button>
                            <Network size={15} />
                            Prepare context
                          </button>
                          <small>
                            Places the prompt in the terminal for review. Press
                            Enter there to send.
                          </small>
                        </form>
                      )}
                  </>
                )}
              </div>
            )}
            {(view === "memory" || view === "skills") && (
              <div className="page library-page">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">
                      {view === "skills"
                        ? "REUSABLE WAYS OF WORKING"
                        : "KNOWLEDGE WITH CONNECTIONS"}
                    </span>
                    <h1>{view === "skills" ? "Skills" : "Memory"}</h1>
                    <p className="muted">
                      Shared across Alpha. Scoped to a project when it belongs
                      there.
                    </p>
                  </div>
                  <button
                    className="primary"
                    onClick={() => setEditor({ kind: libraryKind })}
                  >
                    <Plus size={16} />
                    New {libraryKind === "skill" ? "skill" : "memory"}
                  </button>
                </div>
                {view === "memory" && (
                  <div className="memory-full panel">
                    <MemoryGraph
                      records={effective}
                      theme={theme}
                      onSelect={setInspect}
                      highlight={
                        recall?.items.map((r) => r.id) ||
                        selectedSession?.contextIds
                      }
                    />
                  </div>
                )}
                {view === "memory" && (
                  <section className="context-search panel">
                    <div>
                      <Network size={19} />
                      <strong>See what matters to a task</strong>
                      <span className="muted small">
                        Relevant knowledge, within a context budget.
                      </span>
                    </div>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const result = await run("recall", {
                          projectId: pid,
                          query: recallQuery,
                        });
                        if (result) setRecall(result);
                      }}
                    >
                      <input
                        aria-label="Memory retrieval query"
                        value={recallQuery}
                        onChange={(e) => setRecallQuery(e.target.value)}
                        required
                        placeholder="What are you working on?"
                      />
                      <button className="primary">
                        Find context
                        <ArrowRight size={16} />
                      </button>
                    </form>
                    {recall && (
                      <div className="recall-result">
                        <p>
                          {recall.items.length} memories selected · ~
                          {recall.usedTokens}/{recall.budget} tokens ·{" "}
                          {recall.elapsedMs} ms
                        </p>
                        {recall.omittedPinned.length > 0 && (
                          <p className="error">
                            Pinned instructions exceed the budget:{" "}
                            {recall.omittedPinned.join(", ")}
                          </p>
                        )}
                        {recall.items.map((r) => (
                          <button key={r.id} onClick={() => setInspect(r)}>
                            {r.title}
                            <small>{r.reason}</small>
                          </button>
                        ))}
                        {!recall.items.length && (
                          <p className="muted">
                            No relevant memories found. Other knowledge remains
                            stored.
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                )}
                <div className="library-filters">
                  <div className="search">
                    <Search size={16} />
                    <input
                      aria-label="Search library"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={`Search ${view === "skills" ? "skills" : "knowledge"}…`}
                    />
                  </div>
                  <select
                    aria-label="Library scope"
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <option value="effective">Shared + active project</option>
                    <option value="shared">Alpha shared</option>
                    <option value="project">Active project only</option>
                    <option value="all">All projects</option>
                  </select>
                  <span className="muted small">{records.length} entries</span>
                </div>
                <div className="record-grid">
                  {records.map((r) => (
                    <button
                      className="record-card panel"
                      key={r.id}
                      onClick={() => setInspect(r)}
                    >
                      <div className="row-between">
                        <span className={"scope-badge " + r.scope}>
                          {r.scope === "alpha"
                            ? "Alpha shared"
                            : state.projects.find((p) => p.id === r.projectId)
                                ?.name}
                        </span>
                        {r.pinned ? (
                          <Pin size={15} />
                        ) : view === "skills" ? (
                          <BookOpen size={17} />
                        ) : (
                          <Network size={17} />
                        )}
                      </div>
                      <h3>{r.title}</h3>
                      <p>
                        {r.content.slice(0, 180)}
                        {r.content.length > 180 ? "…" : ""}
                      </p>
                      <div className="tags">
                        {r.tags.slice(0, 4).map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
                {!records.length && (
                  <div className="empty compact">
                    <BookOpen size={32} />
                    <h2>{query ? "No matches" : "Your library starts here"}</h2>
                    <p>
                      {view === "skills"
                        ? "Save instructions that are worth reusing."
                        : "Capture a useful fact, decision or lesson."}
                    </p>
                  </div>
                )}
              </div>
            )}
            {view === "questions" && <Questions state={state} run={run} />}
            {view === "themes" && <ThemeEditor state={state} run={run} />}
            {view === "messages" && (
              <div className="page">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">CONNECTED WINDOWS</span>
                    <h1>Messages</h1>
                    <p className="muted">
                      A shared conversation space for your project's windows.
                    </p>
                  </div>
                </div>
                <section className="panel message-composer">
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (
                        await run("message.send", {
                          to: recipient || selectedSession?.id,
                          body: message,
                        })
                      )
                        setMessage("");
                    }}
                  >
                    <label>
                      Window inbox
                      <select
                        value={recipient || selectedSession?.id || ""}
                        onChange={(e) => setRecipient(e.target.value)}
                        required
                      >
                        <option value="" disabled>
                          Select a window
                        </option>
                        {state.sessions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {
                              state.projects.find((p) => p.id === s.projectId)
                                ?.name
                            }{" "}
                            / {s.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Message
                      <textarea
                        rows={3}
                        value={message}
                        required
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Send a note, share a finding or coordinate a task."
                      />
                    </label>
                    <footer>
                      <span className="muted small">
                        Agent windows read messages with their Alpha inbox tool.
                      </span>
                      <button
                        className="primary"
                        disabled={!state.sessions.length}
                      >
                        <Send size={16} />
                        Send message
                      </button>
                    </footer>
                  </form>
                </section>
                <div className="message-list">
                  {state.messages
                    .filter((m) => m.to === (recipient || selectedSession?.id))
                    .slice()
                    .reverse()
                    .map((m) => (
                      <article className="panel" key={m.id}>
                        <div className="row-between">
                          <strong>
                            {m.from === "user"
                              ? "You"
                              : state.sessions.find((s) => s.id === m.from)
                                  ?.title || "Window"}
                          </strong>
                          <small>{new Date(m.created).toLocaleString()}</small>
                        </div>
                        <p className="preserve">{m.body}</p>
                        {!m.read ? (
                          <button
                            onClick={() => run("message.read", { id: m.id })}
                          >
                            <Check size={14} />
                            Mark read
                          </button>
                        ) : (
                          <small className="muted">Read</small>
                        )}
                      </article>
                    ))}
                </div>
              </div>
            )}
            {view === "settings" && (
              <div className="page">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">YOUR ENVIRONMENT</span>
                    <h1>Settings</h1>
                  </div>
                </div>
                <section className="panel settings-panel">
                  <h2>Project appearance</h2>
                  {project ? (
                    <>
                      <p className="muted">
                        The viewer follows {project.name}'s theme. The main
                        application keeps your selected theme.
                      </p>
                      <label>
                        Viewer theme
                        <select
                          value={project.themeId}
                          onChange={(e) =>
                            run("project.update", {
                              id: pid,
                              themeId: e.target.value,
                            })
                          }
                        >
                          <option value="inherit">
                            Follow application theme
                          </option>
                          {state.themes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : (
                    <p>Select a project to set its viewer theme.</p>
                  )}
                </section>
                <section className="panel settings-panel">
                  <div className="row-between">
                    <h2>Installed tools</h2>
                    <button onClick={() => run("providers.refresh")}>
                      Refresh
                    </button>
                  </div>
                  {state.providers.map((p) => (
                    <div key={p.id} className="provider-status">
                      <span>{p.label}</span>
                      <span className={p.available ? "available" : "muted"}>
                        {p.available
                          ? "Available"
                          : "Not found on this computer"}
                      </span>
                    </div>
                  ))}
                  <p className="muted small">
                    Alpha uses the tools you install. Login and model come from
                    each provider; Alpha applies your selected approval mode.
                  </p>
                </section>
                <section className="panel settings-panel">
                  <h2>Agent approvals</h2>
                  <label>
                    Default approval mode
                    <select
                      aria-label="Default approval mode"
                      value={state.settings.defaultApprovalMode}
                      onChange={(e) =>
                        run("settings", { defaultApprovalMode: e.target.value })
                      }
                    >
                      <option value="provider">Provider settings</option>
                      <option value="always">Always approve</option>
                    </select>
                  </label>
                  <p className="muted small">
                    Applies to new Codex and Claude Code windows. Always approve
                    skips agent tool permission prompts; Codex also runs without
                    its sandbox. You can choose a different mode in New window.
                    Existing windows retain their saved mode when reopened.
                  </p>
                </section>
                <section className="panel settings-panel">
                  <h2>Storage</h2>
                  <p>
                    Each project's workspaces live inside that project. Shared
                    knowledge, settings and questions are stored locally in
                    Alpha's application data.
                  </p>
                  <button onClick={() => run("data.reveal")}>
                    <Folder size={16} />
                    Open Alpha data folder
                  </button>
                </section>
                <Updates state={state.updates} run={run} />
                <section className="panel settings-panel">
                  <h2>About Alpha</h2>
                  <p>
                    Version {state.updates.currentVersion} · Windows desktop
                  </p>
                  <p className="muted">com.jazcosolutions.alpha</p>
                  <p className="muted small">
                    Default namespace for anything created for or by Alpha:
                    com.jazcosolutions
                  </p>
                </section>
              </div>
            )}
          </main>
          {view === "windows" && state.settings.viewerMode === "docked" && (
            <>
              <div
                className="viewer-divider"
                role="separator"
                aria-label="Resize viewer"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    setViewerWidth(
                      Math.max(
                        300,
                        Math.min(700, window.innerWidth - e.clientX),
                      ),
                    );
                }}
              />
              <aside className="docked-viewer" style={{ width: viewerWidth }}>
                <Viewer
                  state={state}
                  theme={projectTheme}
                  run={run}
                  onRecord={setInspect}
                />
              </aside>
            </>
          )}
        </div>
        <footer className="statusbar">
          <span>
            <i className="dot" /> {running} live windows
          </span>
          <span>
            {state.records.filter((r) => r.scope === "alpha").length} shared
            memories & skills
          </span>
          <button onClick={() => setView("questions")}>
            {pending} pending questions
          </button>
          <span className="status-version">
            Alpha {state.updates.currentVersion}
          </span>
        </footer>
      </div>
      {modalContent}
    </div>
  );
}
