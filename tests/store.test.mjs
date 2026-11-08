import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store, inside } from "../electron/store.mjs";
import { providerArguments } from "../electron/providers.mjs";

const make = () => {
  fs.mkdirSync(".test-output", { recursive: true });
  return new Store(fs.mkdtempSync(path.resolve(".test-output/store-")));
};
test("project owns physical workspaces and state persists", () => {
  const s = make(),
    p = s.createProject("Design"),
    w = s.createWorkspace(p.id, "Research");
  assert.ok(fs.statSync(s.workspaceRoot(p.id, w.id)).isDirectory());
  assert.ok(
    s
      .workspaceRoot(p.id, w.id)
      .startsWith(path.join(s.root, "projects", p.id, "workspaces")),
  );
  const recovered = new Store(s.root);
  assert.equal(recovered.project(p.id).workspaces.length, 2);
  assert.throws(() => s.workspaceRoot(p.id, "../outside"));
  assert.throws(() => inside(s.projectRoot(p.id), "../../outside"));
});
test("retrieval filters scope before ranking and obeys the approximate token budget", () => {
  const s = make(),
    a = s.createProject("Alpha test"),
    b = s.createProject("Other");
  const shared = s.saveRecord({
    title: "Rendering performance",
    content: "Cache expensive rendering computations.",
    tags: ["performance"],
  });
  const local = s.saveRecord({
    title: "Rendering constraints",
    content: "Rendering must support this project palette.",
    scope: "project",
    projectId: a.id,
    pinned: true,
  });
  const secret = s.saveRecord({
    title: "Rendering secret",
    content: "Unrelated private rendering information.",
    scope: "project",
    projectId: b.id,
    importance: 5,
  });
  s.saveRecord({ title: "Cooking", content: "Bake bread gently." });
  const result = s.recall(a.id, "rendering", 200);
  assert.ok(result.items.some((r) => r.id === shared.id));
  assert.ok(result.items.some((r) => r.id === local.id));
  assert.ok(!result.items.some((r) => r.id === secret.id));
  assert.ok(result.usedTokens <= 200);
  assert.equal(s.state.records.length, 4);
});
test("pinned content that cannot fit is explicitly reported", () => {
  const s = make();
  s.saveRecord({
    title: "Governing instruction",
    content: "Important ".repeat(200),
    pinned: true,
  });
  const r = s.recall(null, "test", 128);
  assert.deepEqual(r.omittedPinned, ["Governing instruction"]);
  assert.equal(r.items.length, 0);
});
test("scope changes remove cross-project graph leaks", () => {
  const s = make(),
    p = s.createProject("One");
  const a = s.saveRecord({ title: "Shared", content: "A fact" });
  const b = s.saveRecord({
    title: "Related",
    content: "Another fact",
    links: [a.id],
  });
  s.saveRecord({ id: a.id, scope: "project", projectId: p.id });
  assert.deepEqual(b.links, []);
  assert.throws(() =>
    s.saveRecord({ title: "Bad link", content: "Leak", links: [a.id] }),
  );
});
test("questions require actual answers, keep source, and survive restart", () => {
  const s = make(),
    p = s.createProject("One");
  const q = s.question(
    {
      text: "Which color?",
      projectId: p.id,
      options: ["Blue", "Red"],
      area: "Design",
    },
    "window-test",
  );
  assert.equal(q.answer, null);
  assert.throws(() => s.resolveQuestion(q.id));
  s.answer(q.id, "Use red");
  assert.equal(q.answeredBy, "user");
  assert.throws(() => s.resolveQuestion(q.id, "wrong-window"));
  s.resolveQuestion(q.id, "window-test");
  assert.equal(new Store(s.root).state.questions[0].status, "resolved");
});
test("agent messaging respects project boundaries", () => {
  const s = make();
  s.state.sessions = [
    { id: "a", projectId: "one" },
    { id: "b", projectId: "one" },
    { id: "c", projectId: "two" },
  ];
  assert.equal(s.message("a", "b", "Hello").body, "Hello");
  assert.throws(() => s.message("a", "c", "No"));
  assert.equal(s.message("user", "c", "Explicit user message").to, "c");
});
test("the three themes validate edits and preserve restore defaults", () => {
  const s = make();
  assert.deepEqual(
    s.state.themes.map((t) => t.controller),
    ["Alpha", "Papa Smurf", "Rena"],
  );
  s.saveTheme({ id: "alpha", displayName: "My workspace", accent: "#bb8844" });
  assert.equal(s.state.themes[0].displayName, "My workspace");
  assert.throws(() =>
    s.saveTheme({ id: "alpha", avatar: "https://untrusted.example/icon" }),
  );
  s.resetTheme("alpha");
  assert.equal(s.state.themes[0].displayName, "Alpha");
});
test("provider integration adds scoped tools without changing models or permissions", () => {
  for (const provider of ["codex", "claude"]) {
    const args = providerArguments(provider, {
      bridge: "C:/Alpha/bridge.mjs",
      node: "C:/Alpha/Alpha.exe",
      endpoint: "http://127.0.0.1:1234",
      token: "test-token",
      prompt: "Build UI",
    });
    assert.ok(args.includes("Build UI"));
    assert.ok(
      !args.some((a) =>
        /dangerously|--model|--sandbox|--permission-mode/.test(a),
      ),
    );
    assert.ok(args.join(" ").includes("alpha_ask_question"));
  }
});
