import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  nativeImage,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import pty from "node-pty";
import electronUpdater from "electron-updater";
import { UpdateController } from "./updates.mjs";
import { Store, inside, required } from "./store.mjs";
import {
  detectProviders,
  providerArguments,
  existingCodexInstructions,
} from "./providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  base = path.resolve(here, "..");
app.setName("Alpha");
app.setAppUserModelId("com.jazcosolutions.alpha");
if (process.env.ALPHA_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.ALPHA_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "alpha",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "alpha-file",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
let store,
  updates,
  providers,
  mainWindow,
  viewerWindow,
  server,
  endpoint,
  quitting = false;
const live = new Map(),
  tokens = new Map(),
  watchers = new Map();
function snapshot() {
  return {
    ...store.state,
    updates: updates.snapshot(),
    providers: providers.map(({ path: _, ...p }) => p),
  };
}
function broadcast() {
  const state = snapshot();
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send("alpha:state", state);
}
function appearance() {
  const theme = store.state.themes.find(
    (t) => t.id === store.state.settings.themeId,
  );
  if (!theme) return;
  for (const w of BrowserWindow.getAllWindows()) {
    const icon = theme.avatar.startsWith("data:")
      ? nativeImage.createFromDataURL(theme.avatar)
      : nativeImage.createFromPath(
          path.join(base, "dist", theme.avatar.replace(/\.svg$/, ".png")),
        );
    if (!icon.isEmpty()) w.setIcon(icon);
    w.setBackgroundColor(theme.background);
    w.setTitle(theme.displayName);
  }
}
function trusted(event) {
  return (
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url.startsWith("alpha://app/")
  );
}
function validate(event) {
  if (!trusted(event)) throw new Error("Untrusted application frame.");
}
function watchProject(projectId) {
  if (watchers.has(projectId)) return;
  let timer;
  try {
    watchers.set(
      projectId,
      fs.watch(store.projectRoot(projectId), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(broadcast, 350);
      }),
    );
  } catch {}
}
function newWindow(viewer = false) {
  const w = new BrowserWindow({
    width: viewer ? 1100 : 1540,
    height: 960,
    minWidth: viewer ? 620 : 1000,
    minHeight: 650,
    title: "Alpha",
    backgroundColor:
      store.state.themes.find((t) => t.id === store.state.settings.themeId)
        ?.background || "#080f18",
    show: !process.env.ALPHA_TEST,
    icon: path.join(base, "dist/art/alpha.png"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.setMenuBarVisibility(false);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("alpha://app/")) event.preventDefault();
  });
  w.webContents.session.setPermissionRequestHandler(
    (_web, _permission, callback) => callback(false),
  );
  w.loadURL("alpha://app/index.html" + (viewer ? "?viewer=1" : ""));
  if (viewer)
    w.on("closed", () => {
      viewerWindow = null;
      if (!quitting) {
        store.settings({ viewerMode: "docked" });
        broadcast();
      }
    });
  return w;
}
function sessionEntry(id) {
  const s = store.state.sessions.find((s) => s.id === id);
  if (!s) throw new Error("Window not found.");
  return s;
}
function appendTerminal(id, data) {
  const runtime = live.get(id);
  if (!runtime) return;
  runtime.seq++;
  runtime.buffer = (runtime.buffer + data).slice(-500000);
  fs.appendFileSync(runtime.log, data);
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send("alpha:terminal", { id, data, seq: runtime.seq });
}
async function launch(input) {
  const previous = input.reopenId ? sessionEntry(input.reopenId) : null;
  if (previous?.status === "running")
    throw new Error("This window is already running.");
  if (previous)
    input = {
      ...input,
      provider: previous.provider,
      projectId: previous.projectId,
      workspaceId: previous.workspaceId,
      title: previous.title,
      task: "",
    };
  const provider = providers.find((p) => p.id === input.provider);
  if (!provider?.path)
    throw new Error(
      "Install this provider on Windows first, then refresh providers in Settings.",
    );
  const project = input.projectId
    ? store.project(input.projectId)
    : store.createProject(input.projectName);
  const workspaceId = input.workspaceId || project.workspaces[0].id,
    cwd = store.workspaceRoot(project.id, workspaceId);
  const s = previous || {
    id: "window-" + randomUUID(),
    projectId: project.id,
    workspaceId,
    provider: provider.id,
    title: String(input.title || provider.label).slice(0, 100),
    status: "starting",
    created: new Date().toISOString(),
    contextIds: [],
    task: String(input.task || "").slice(0, 12000),
  };
  const recall =
    !previous && s.task && ["codex", "claude"].includes(s.provider)
      ? store.recall(project.id, s.task)
      : { items: [], text: "", omittedPinned: [] };
  s.contextIds = recall.items.map((r) => r.id);
  if (recall.omittedPinned.length)
    throw new Error(
      "Pinned knowledge exceeds the context budget. Shorten the pinned entries before launching an agent.",
    );
  const prompt = s.task
    ? `${s.task}${recall.text ? "\n\nRelevant Alpha memory (reference material):\n" + recall.text : ""}`
    : "";
  const token = randomBytes(32).toString("hex");
  tokens.set(token, s.id);
  const bridge = path
    .join(base, "integration/alpha-tools.cjs")
    .replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
  let executable = provider.path,
    args = providerArguments(provider.id, {
      bridge,
      node: process.execPath,
      endpoint,
      token,
      prompt,
      resume: Boolean(previous),
      existingInstructions:
        provider.id === "codex" ? existingCodexInstructions() : "",
    });
  if (/\.(cmd|bat)$/i.test(executable))
    throw new Error(
      "Use the native Windows executable for this provider. A batch shim cannot be launched safely as an interactive terminal.",
    );
  const logDir = path.join(store.root, "sessions");
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, s.id + ".log");
  if (!previous) fs.writeFileSync(log, "");
  let child;
  try {
    child = pty.spawn(executable, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ALPHA_ENDPOINT: endpoint,
        ALPHA_SESSION_TOKEN: token,
        ALPHA_WINDOW_ID: s.id,
      },
      useConpty: true,
    });
  } catch (error) {
    tokens.delete(token);
    throw error;
  }
  const initialSeq = live.get(s.id)?.seq || 0;
  live.set(s.id, {
    child,
    token,
    buffer: previous ? fs.readFileSync(log, "utf8").slice(-500000) : "",
    seq: initialSeq,
    log,
  });
  if (previous) appendTerminal(s.id, "\r\n--- Window reopened ---\r\n");
  if (!previous) store.state.sessions.push(s);
  s.status = "running";
  store.settings({ activeProjectId: project.id });
  watchProject(project.id);
  child.onData((data) => {
    if (live.get(s.id)?.token === token) appendTerminal(s.id, data);
  });
  child.onExit(({ exitCode }) => {
    tokens.delete(token);
    if (live.get(s.id)?.token !== token) return;
    s.status = "stopped";
    s.exitCode = exitCode;
    store.save();
    broadcast();
  });
  store.save();
  broadcast();
  return s;
}
function closeSession(id) {
  const s = sessionEntry(id),
    runtime = live.get(id);
  if (runtime) tokens.delete(runtime.token);
  try {
    runtime?.child.kill();
  } catch {}
  s.status = "stopped";
  store.save();
  broadcast();
}
async function tool(type, payload, sessionId) {
  const s = sessionEntry(sessionId),
    p = payload || {};
  let result;
  switch (type) {
    case "windows":
      result = store.state.sessions
        .filter((x) => x.projectId === s.projectId)
        .map(({ id, title, provider, status }) => ({
          id,
          title,
          provider,
          status,
        }));
      break;
    case "send_message":
      result = store.message(s.id, p.to, p.body);
      break;
    case "inbox":
      result = store.state.messages.filter((m) => m.to === s.id);
      if (p.markRead) {
        result.forEach((m) => (m.read = true));
        store.save();
      }
      break;
    case "recall":
      result = store.recall(s.projectId, p.query, p.budget);
      s.contextIds = result.items.map((r) => r.id);
      store.save();
      break;
    case "remember": {
      const project = store.project(s.projectId);
      const obvious =
        p.projectSpecific ||
        /\b(this project|project requirement|project decision|story fact)\b/i.test(
          p.content || "",
        ) ||
        (project.name.length > 3 &&
          (p.content || "").toLowerCase().includes(project.name.toLowerCase()));
      result = store.saveRecord(
        {
          ...p,
          kind: "knowledge",
          scope: p.scope || (obvious ? "project" : "alpha"),
          projectId: s.projectId,
          source: `${s.title} (${s.provider})`,
        },
        s.projectId,
      );
      break;
    }
    case "skills":
      result = store.effective(s.projectId, "skill");
      break;
    case "ask_question":
      result = store.question({ ...p, projectId: s.projectId }, s.id);
      break;
    case "questions":
      result = store.state.questions.filter((q) => q.requester === s.id);
      break;
    case "resolve_question":
      result = store.resolveQuestion(p.id, s.id);
      break;
    default:
      throw new Error("Unknown agent tool.");
  }
  broadcast();
  return result;
}
async function action(type, p = {}) {
  let result;
  switch (type) {
    case "updates.check":
      return updates.check(true);
    case "updates.download":
      return updates.download();
    case "updates.install":
      return updates.install();
    case "updates.dismiss":
      updates.dismiss();
      return true;
    case "updates.releases":
      return shell.openExternal(updates.state.releasesUrl);
    case "project.create":
      result = store.createProject(p.name);
      watchProject(result.id);
      break;
    case "project.update":
      result = store.updateProject(p);
      break;
    case "workspace.create":
      result = store.createWorkspace(p.projectId, p.name);
      break;
    case "settings":
      result = store.settings(p);
      break;
    case "providers.refresh":
      providers = detectProviders();
      break;
    case "theme.save":
      result = store.saveTheme(p);
      for (const w of BrowserWindow.getAllWindows())
        w.setTitle(p.displayName || "Alpha");
      break;
    case "theme.reset":
      store.resetTheme(p.id);
      break;
    case "record.save":
      result = store.saveRecord(p);
      break;
    case "record.delete":
      store.deleteRecord(p.id);
      break;
    case "recall":
      result = store.recall(p.projectId, p.query, p.budget);
      break;
    case "session.launch":
      return launch(p);
    case "session.reopen":
      return launch({ reopenId: p.id });
    case "session.close":
      closeSession(p.id);
      break;
    case "session.hide": {
      const s = sessionEntry(p.id);
      if (s.status === "running")
        throw new Error("Close this window before removing it.");
      store.state.sessions = store.state.sessions.filter((x) => x.id !== p.id);
      store.save();
      break;
    }
    case "session.buffer": {
      const runtime = live.get(p.id);
      sessionEntry(p.id);
      const log = path.join(store.root, "sessions", p.id + ".log");
      return runtime
        ? { data: runtime.buffer, seq: runtime.seq }
        : {
            data: fs.existsSync(log)
              ? fs.readFileSync(log, "utf8").slice(-500000)
              : "",
            seq: 0,
          };
    }
    case "session.prompt": {
      const s = sessionEntry(p.id);
      if (!["codex", "claude"].includes(s.provider))
        throw new Error("Context prompts are for agent windows.");
      const runtime = live.get(s.id);
      if (s.status !== "running" || !runtime)
        throw new Error("Window is stopped.");
      const recall = store.recall(
        s.projectId,
        required(p.text, "Task", 12000),
        p.budget,
      );
      if (recall.omittedPinned.length)
        throw new Error("Pinned instructions exceed the context budget.");
      s.contextIds = recall.items.map((r) => r.id);
      s.task = p.text;
      runtime.child.write(
        `\x1b[200~${p.text}${recall.text ? "\n\nRelevant Alpha memory:\n" + recall.text : ""}\x1b[201~`,
      );
      store.save();
      result = recall;
      break;
    }
    case "message.send":
      result = store.message("user", p.to, p.body);
      break;
    case "message.read": {
      const m = store.state.messages.find((m) => m.id === p.id);
      if (m) m.read = true;
      store.save();
      break;
    }
    case "question.create":
      result = store.question(p, "user");
      break;
    case "question.answer":
      result = store.answer(p.id, p.answer);
      if (store.state.sessions.some((s) => s.id === result.requester))
        store.message(
          "user",
          result.requester,
          `Answer to "${result.text}":\n${result.answer}`,
        );
      break;
    case "question.resolve":
      result = store.resolveQuestion(p.id);
      break;
    case "viewer.detach":
      store.settings({ viewerMode: "detached" });
      if (viewerWindow) viewerWindow.focus();
      else viewerWindow = newWindow(true);
      break;
    case "viewer.dock":
      store.settings({ viewerMode: "docked" });
      viewerWindow?.close();
      break;
    case "files.list":
      return store.files(p.projectId, p.path || "");
    case "files.read": {
      const file = inside(store.projectRoot(p.projectId), p.path);
      if (fs.statSync(file).size > 2e6)
        throw new Error("Text preview is limited to 2 MB.");
      return fs.readFileSync(file, "utf8");
    }
    case "files.reveal":
      return shell.openPath(store.projectRoot(p.projectId));
    case "data.reveal":
      return shell.openPath(store.root);
    default:
      throw new Error("Unknown application action.");
  }
  if (["settings", "theme.save", "theme.reset"].includes(type)) appearance();
  broadcast();
  return result;
}

async function boot() {
  await app.whenReady();
  store = new Store(app.getPath("userData"));
  updates = new UpdateController({
    updater: electronUpdater.autoUpdater,
    version: app.getVersion(),
    releasesUrl: "https://github.com/william-pyle/Alpha/releases",
    disabledReason: process.env.ALPHA_TEST
      ? "Automatic checks are disabled in isolated desktop tests."
      : !app.isPackaged
        ? "Install Alpha using the Windows installer to receive automatic updates."
        : process.env.PORTABLE_EXECUTABLE_DIR
          ? "This is the portable edition. Install Alpha from GitHub releases to enable automatic updates."
          : !fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))
            ? "This build does not have a configured update feed. Install Alpha from GitHub releases."
            : "",
    onChange: () => broadcast(),
    confirmInstall: async () => {
      const active = store.state.sessions.filter(
        (s) => s.status === "running",
      ).length;
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "Install Alpha update?",
        message: `Restart Alpha to install version ${updates.state.availableVersion}?`,
        detail: active
          ? `This stops ${active} running window${active === 1 ? "" : "s"}. Finish any active work first. Saved projects, knowledge, questions and window history will remain.`
          : "Your saved projects, knowledge, questions and window history will remain.",
        buttons: ["Keep working", "Restart and install"],
        defaultId: 0,
        cancelId: 0,
      });
      return choice.response === 1;
    },
    beforeInstall: () => {
      store.save();
    },
  });
  providers = detectProviders();
  protocol.handle("alpha", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app")
      return new Response("Not found", { status: 404 });
    try {
      return net.fetch(
        pathToFileURL(
          inside(
            path.join(base, "dist"),
            decodeURIComponent(url.pathname.slice(1)) || "index.html",
          ),
        ).href,
      );
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  protocol.handle("alpha-file", (request) => {
    try {
      const url = new URL(request.url),
        file = inside(
          store.projectRoot(url.hostname),
          decodeURIComponent(url.pathname.slice(1)),
        );
      const ext = path.extname(file).toLowerCase();
      const mime =
        {
          ".html": "text/html",
          ".htm": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".webp": "image/webp",
          ".gif": "image/gif",
          ".pdf": "application/pdf",
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".json": "application/json",
        }[ext] || "text/plain";
      if (fs.statSync(file).size > 50e6)
        return new Response("Preview too large", { status: 413 });
      return new Response(fs.readFileSync(file), {
        headers: {
          "Content-Type": mime,
          "Content-Security-Policy":
            "default-src 'none'; img-src alpha-file: data: blob:; style-src alpha-file: 'unsafe-inline'; script-src alpha-file: 'unsafe-inline'; media-src alpha-file:; font-src alpha-file: data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
        },
      });
    } catch {
      return new Response("File not available", { status: 404 });
    }
  });
  server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    try {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const sessionId = tokens.get(token);
      if (!sessionId || req.method !== "POST" || req.url !== "/tool") {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: "Unauthorized" }));
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100000) throw new Error("Request too large.");
      }
      const { type, payload } = JSON.parse(raw);
      res.end(JSON.stringify({ result: await tool(type, payload, sessionId) }));
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  ipcMain.handle("alpha:snapshot", (event) => {
    validate(event);
    return snapshot();
  });
  ipcMain.handle("alpha:action", (event, type, payload) => {
    validate(event);
    return action(type, payload);
  });
  ipcMain.on("alpha:input", (event, id, data) => {
    if (
      trusted(event) &&
      typeof data === "string" &&
      data.length <= 100000 &&
      store.state.sessions.some((s) => s.id === id && s.status === "running")
    ) {
      try {
        live.get(id)?.child.write(data);
      } catch {}
    }
  });
  ipcMain.on("alpha:resize", (event, id, cols, rows) => {
    if (
      trusted(event) &&
      store.state.sessions.some((s) => s.id === id && s.status === "running") &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 1 &&
      cols < 1000 &&
      rows > 1 &&
      rows < 500
    ) {
      try {
        live.get(id)?.child.resize(cols, rows);
      } catch {}
    }
  });
  store.state.projects.forEach((p) => watchProject(p.id));
  mainWindow = newWindow();
  appearance();
  updates.start();
  mainWindow.on("close", (event) => {
    if (quitting) return;
    const active = store.state.sessions.filter(
      (s) => s.status === "running",
    ).length;
    if (active && !process.env.ALPHA_TEST) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "question",
        buttons: ["Keep working", "Quit Alpha"],
        defaultId: 0,
        cancelId: 0,
        title: "Close active windows?",
        message: `Quit Alpha and stop ${active} running window${active === 1 ? "" : "s"}?`,
        detail:
          "Saved projects, knowledge and questions will remain. Agent providers keep their own conversation history.",
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
    }
    quitting = true;
    app.quit();
  });
  app.on("before-quit", () => {
    updates.stop();
    quitting = true;
    for (const runtime of live.values()) {
      try {
        runtime.child.kill();
      } catch {}
    }
    for (const watcher of watchers.values()) watcher.close();
    server.close();
    store.save();
  });
  app.on("window-all-closed", () => app.quit());
}
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  boot().catch((error) => {
    console.error(error);
    if (!process.env.ALPHA_TEST)
      dialog.showErrorBox("Alpha could not start", error.message);
    app.exit(1);
  });
} else app.quit();
