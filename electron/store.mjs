import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { defaultThemes } from "./themes.mjs";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID()}`;
export function required(value, label, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
const tokens = (text) => [
  ...new Set(
    String(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu) || [],
  ),
];
export function inside(root, relative = "") {
  const target = path.resolve(root, relative),
    rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path is outside this project.");
  if (fs.existsSync(target)) {
    const actual = fs.realpathSync(target),
      base = fs.realpathSync(root),
      r = path.relative(base, actual);
    if (r.startsWith("..") || path.isAbsolute(r))
      throw new Error("Linked path is outside this project.");
  }
  return target;
}

export class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
    this.file = path.join(root, "alpha.json");
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {
          version: 1,
          projects: [],
          records: [],
          sessions: [],
          messages: [],
          questions: [],
          themes: structuredClone(defaultThemes),
          settings: {
            themeId: "alpha",
            activeProjectId: null,
            layout: "columns",
            viewerMode: "docked",
            viewerTab: "memory",
            namespacePrefix: "com.jazcosolutions",
          },
        };
    this.state.questions ||= [];
    for (const theme of this.state.themes)
      if (theme.backdrop === undefined)
        theme.backdrop =
          defaultThemes.find((t) => t.id === theme.id)?.backdrop || "";
    this.state.sessions.forEach((s) => {
      if (["running", "starting"].includes(s.status)) s.status = "stopped";
    });
    this.reindex();
    this.save();
  }
  save() {
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2) + "\n");
    fs.renameSync(temp, this.file);
  }
  project(projectId) {
    const p = this.state.projects.find((p) => p.id === projectId);
    if (!p) throw new Error("Project not found.");
    return p;
  }
  projectRoot(projectId) {
    this.project(projectId);
    return path.join(this.root, "projects", projectId);
  }
  workspaceRoot(projectId, workspaceId) {
    const p = this.project(projectId);
    if (!p.workspaces.some((w) => w.id === workspaceId))
      throw new Error("Workspace not found.");
    return path.join(this.projectRoot(projectId), "workspaces", workspaceId);
  }
  createProject(name) {
    const p = {
      id: id("project"),
      name: required(name, "Project name", 100),
      themeId: "inherit",
      created: now(),
      workspaces: [{ id: "main", name: "Main workspace" }],
    };
    this.state.projects.push(p);
    fs.mkdirSync(this.workspaceRoot(p.id, "main"), { recursive: true });
    fs.writeFileSync(
      path.join(this.projectRoot(p.id), "project.json"),
      JSON.stringify(p, null, 2) + "\n",
    );
    this.state.settings.activeProjectId = p.id;
    this.save();
    return p;
  }
  updateProject(input) {
    const p = this.project(input.id);
    if (input.name !== undefined)
      p.name = required(input.name, "Project name", 100);
    if (input.themeId !== undefined) {
      if (
        input.themeId !== "inherit" &&
        !this.state.themes.some((t) => t.id === input.themeId)
      )
        throw new Error("Theme not found.");
      p.themeId = input.themeId;
    }
    fs.writeFileSync(
      path.join(this.projectRoot(p.id), "project.json"),
      JSON.stringify(p, null, 2) + "\n",
    );
    this.save();
    return p;
  }
  createWorkspace(projectId, name) {
    const p = this.project(projectId),
      w = { id: id("workspace"), name: required(name, "Workspace name", 100) };
    p.workspaces.push(w);
    fs.mkdirSync(this.workspaceRoot(p.id, w.id), { recursive: true });
    this.updateProject({ id: projectId });
    return w;
  }
  settings(input) {
    for (const k of [
      "themeId",
      "activeProjectId",
      "layout",
      "viewerMode",
      "viewerTab",
    ])
      if (input[k] !== undefined) {
        const allowed = {
          layout: ["columns", "rows", "grid", "tabs"],
          viewerMode: ["docked", "detached", "hidden"],
          viewerTab: ["memory", "files"],
        };
        if (allowed[k] && !allowed[k].includes(input[k]))
          throw new Error("Invalid setting.");
        if (
          k === "themeId" &&
          !this.state.themes.some((t) => t.id === input[k])
        )
          throw new Error("Unknown theme.");
        if (k === "activeProjectId" && input[k] !== null)
          this.project(input[k]);
        this.state.settings[k] = input[k];
      }
    this.save();
    return this.state.settings;
  }
  saveTheme(input) {
    const original = this.state.themes.find((t) => t.id === input.id);
    if (!original) throw new Error("Theme not found.");
    const next = { ...original };
    for (const k of ["name", "displayName", "controller"])
      if (input[k] !== undefined) next[k] = required(input[k], k, 60);
    for (const k of [
      "background",
      "surface",
      "raised",
      "accent",
      "secondary",
      "text",
      "muted",
      "border",
    ])
      if (input[k] !== undefined) {
        if (!/^#[0-9a-f]{6}$/i.test(input[k]))
          throw new Error("Use six-digit hex colors.");
        next[k] = input[k];
      }
    if (input.avatar !== undefined) {
      if (
        !/^art\/[a-z0-9-]+\.(svg|png)$/.test(input.avatar) &&
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
          input.avatar,
        )
      )
        throw new Error("Unsupported icon.");
      if (input.avatar.length > 3e6) throw new Error("Icon is too large.");
      next.avatar = input.avatar;
    }
    if (input.backdrop !== undefined) {
      if (
        input.backdrop !== "" &&
        !/^art\/[a-z0-9-]+\.png$/.test(input.backdrop) &&
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
          input.backdrop,
        )
      )
        throw new Error("Unsupported background.");
      if (input.backdrop.length > 20e6)
        throw new Error("Background is too large.");
      next.backdrop = input.backdrop;
    }
    Object.assign(original, next);
    this.save();
    return original;
  }
  resetTheme(themeId) {
    const preset = defaultThemes.find((t) => t.id === themeId);
    if (!preset) throw new Error("Unknown theme.");
    Object.assign(
      this.state.themes.find((t) => t.id === themeId),
      structuredClone(preset),
    );
    this.save();
  }
  effective(projectId, kind) {
    return this.state.records.filter(
      (r) =>
        (!kind || r.kind === kind) &&
        (r.scope === "alpha" || r.projectId === projectId),
    );
  }
  saveRecord(input, forcedProjectId) {
    const existing = input.id
      ? this.state.records.find((r) => r.id === input.id)
      : null;
    if (input.id && !existing) throw new Error("Record not found.");
    if (
      forcedProjectId &&
      existing?.scope === "project" &&
      existing.projectId !== forcedProjectId
    )
      throw new Error("Record belongs to another project.");
    const kind = input.kind ?? existing?.kind ?? "knowledge";
    if (!["knowledge", "skill"].includes(kind))
      throw new Error("Invalid record kind.");
    let scope = input.scope ?? existing?.scope ?? "alpha";
    if (!["alpha", "project"].includes(scope))
      throw new Error("Invalid scope.");
    const projectId =
      scope === "project"
        ? forcedProjectId || input.projectId || existing?.projectId
        : null;
    if (scope === "project") this.project(projectId);
    const links = Array.isArray(input.links)
      ? [...new Set(input.links)]
      : existing?.links || [];
    for (const link of links) {
      const target = this.state.records.find((r) => r.id === link);
      if (!target || link === input.id) throw new Error("Invalid memory link.");
      if (
        target.scope === "project" &&
        (scope === "alpha" || target.projectId !== projectId)
      )
        throw new Error(
          "A shared or unrelated memory cannot link to a private project record.",
        );
    }
    const importance = Number(input.importance ?? existing?.importance ?? 3);
    if (!Number.isInteger(importance) || importance < 1 || importance > 5)
      throw new Error("Importance must be 1 through 5.");
    const r = {
      id: existing?.id || id(kind),
      kind,
      title: required(input.title ?? existing?.title, "Title", 160),
      content: required(input.content ?? existing?.content, "Content", 60000),
      scope,
      projectId,
      tags: tokens(
        Array.isArray(input.tags)
          ? input.tags.join(" ")
          : (input.tags ?? existing?.tags?.join(" ") ?? ""),
      ).slice(0, 20),
      importance,
      pinned: Boolean(input.pinned ?? existing?.pinned),
      links,
      source: String(input.source ?? existing?.source ?? "User").slice(0, 300),
      created: existing?.created || now(),
      updated: now(),
    };
    if (existing) Object.assign(existing, r);
    else this.state.records.push(r);
    // Scope changes must not leave links that disclose private project knowledge.
    for (const record of this.state.records)
      record.links = record.links.filter((link) => {
        const t = this.state.records.find((x) => x.id === link);
        return (
          t &&
          (t.scope === "alpha" ||
            (record.scope === "project" && record.projectId === t.projectId))
        );
      });
    this.reindex();
    this.save();
    return r;
  }
  deleteRecord(recordId) {
    this.state.records = this.state.records.filter((r) => r.id !== recordId);
    this.state.records.forEach(
      (r) => (r.links = r.links.filter((x) => x !== recordId)),
    );
    this.reindex();
    this.save();
  }
  reindex() {
    this.index = new Map();
    for (const r of this.state.records)
      for (const word of tokens(
        r.title + " " + r.tags.join(" ") + " " + r.content,
      )) {
        if (!this.index.has(word)) this.index.set(word, new Set());
        this.index.get(word).add(r.id);
      }
  }
  recall(projectId, query, budget = 1800) {
    const start = performance.now();
    if (projectId) this.project(projectId);
    budget = Math.max(128, Math.min(12000, Number(budget) || 1800));
    const words = tokens(query),
      matches = new Map();
    for (const word of words)
      for (const rid of this.index.get(word) || [])
        matches.set(rid, (matches.get(rid) || 0) + 1);
    const ranked = this.effective(projectId)
      .map((r) => {
        const hits = matches.get(r.id) || 0;
        const titleHits = words.filter((w) =>
          tokens(r.title + " " + r.tags.join(" ")).includes(w),
        ).length;
        return {
          ...r,
          score:
            (r.pinned ? 1000 : 0) + hits * 10 + titleHits * 8 + r.importance,
          reason: r.pinned
            ? "Pinned instruction"
            : `${hits} matching terms; importance ${r.importance}/5`,
          hits,
        };
      })
      .filter((r) => r.pinned || r.hits > 0)
      .sort((a, b) => b.score - a.score);
    let text = "",
      usedTokens = 0;
    const items = [],
      omittedPinned = [];
    for (const r of ranked) {
      const segment = `[${r.kind}: ${r.title} | ${r.scope} | ${r.source}]\n${r.content}\n\n`;
      const cost = Math.ceil(segment.length / 4);
      if (usedTokens + cost > budget) {
        if (r.pinned) omittedPinned.push(r.title);
        continue;
      }
      items.push(r);
      text += segment;
      usedTokens += cost;
    }
    return {
      items,
      text,
      usedTokens,
      budget,
      omittedPinned,
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }
  question(input, requester) {
    if (input.projectId) this.project(input.projectId);
    const q = {
      id: id("question"),
      text: required(input.text, "Question", 4000),
      context: String(input.context || "").slice(0, 10000),
      options: Array.isArray(input.options)
        ? input.options.map((x) => required(x, "Option", 200)).slice(0, 6)
        : [],
      projectId: input.projectId || null,
      requester: requester || "user",
      area: String(input.area || "General").slice(0, 100),
      status: "pending",
      answer: null,
      created: now(),
      answeredAt: null,
      resolvedAt: null,
    };
    this.state.questions.push(q);
    this.save();
    return q;
  }
  answer(questionId, answer) {
    const q = this.state.questions.find((q) => q.id === questionId);
    if (!q) throw new Error("Question not found.");
    if (q.status !== "pending")
      throw new Error("This question already has an answer.");
    q.answer = required(answer, "Answer", 20000);
    q.status = "answered";
    q.answeredAt = now();
    q.answeredBy = "user";
    this.save();
    return q;
  }
  resolveQuestion(questionId, requester) {
    const q = this.state.questions.find((q) => q.id === questionId);
    if (!q) throw new Error("Question not found.");
    if (requester && q.requester !== requester)
      throw new Error("Only the requester can resolve this question.");
    if (q.status !== "answered")
      throw new Error("A human answer is required first.");
    q.status = "resolved";
    q.resolvedAt = now();
    this.save();
    return q;
  }
  message(from, to, body) {
    const target = this.state.sessions.find((s) => s.id === to);
    if (!target) throw new Error("Recipient not found.");
    if (from !== "user") {
      const sender = this.state.sessions.find((s) => s.id === from);
      if (!sender || sender.projectId !== target.projectId)
        throw new Error("Agent messages stay within their project.");
    }
    const m = {
      id: id("message"),
      from,
      to,
      body: required(body, "Message", 20000),
      created: now(),
      read: false,
    };
    this.state.messages.push(m);
    this.save();
    return m;
  }
  files(projectId, relative = "") {
    const root = this.projectRoot(projectId),
      folder = inside(root, relative);
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter(
        (e) =>
          !["node_modules", ".git", ".alpha"].includes(e.name) &&
          !e.name.startsWith(".env"),
      )
      .map((e) => ({
        name: e.name,
        path: path
          .relative(root, path.join(folder, e.name))
          .replaceAll("\\", "/"),
        directory: e.isDirectory(),
      }))
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      );
  }
}
