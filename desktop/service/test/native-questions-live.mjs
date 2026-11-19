// Opt-in isolated live-provider acceptance; no existing Alpha sessions or settings.
import { createService } from '../server.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
if (!process.argv.includes('--use-subscription')) throw new Error('Pass --use-subscription for isolated real Codex verification.');
await mkdir('.test-output', { recursive: true });
const root = await mkdtemp(path.resolve('.test-output/live-questions-'));
await mkdir(path.join(root, 'workspace'));
await writeFile(path.join(root, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo: root, uiDir: path.resolve('dist'), restoreSessions: false, checkUpdates: false, mcpOptions: { home: root, env: {} } });
const result = { root, status: 'running', startedAt: new Date().toISOString() };
try {
  const chat = await service.sessions.create({ agent: 'codex', name: 'Isolated native Questions check', cwd: root, projectId: 'fixture', bypass: false, cols: 130, rows: 42 });
  const session = service.sessions.get(chat.id);
  const prompt = 'This is an isolated synthetic Alpha Questions integration test. Do not inspect or modify files, run commands, or use any tool except request_user_input_async. Call request_user_input_async with exactly one question titled "Which synthetic color should the fixture use?" and exactly two choices "Blue" and "Green". Wait for the answer, then reply with the chosen color and NATIVE_QUESTIONS_DONE. The harness will answer; do not choose for it.';
  result.submission = await service.sessions.input(chat.id, prompt, { coordinator: true, submit: true, taskId: 'live-questions-021' });
  console.log(JSON.stringify({ root, submission: result.submission }));
  const deadline = Date.now() + 120000;
  let question;
  while (Date.now() < deadline) {
    question = service.questions.list().find(q => q.sessionId === chat.id && q.asyncQuestion);
    if (question) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  result.finalSubmission = session.submissions;
  result.before = (await service.sessions.read(chat.id)).screen;
  result.questions = service.questions.list();
  result.nativeSource = session.promptQuestions;
  if (!question) throw new Error('No supported origin-bound native question observed.');
  try { result.delivery = await service.questions.answer(question.id, 'Blue', service.sessions); } catch (error) { result.pendingDelivery = error.message; }
  const doneBy = Date.now() + 45000;
  while (Date.now() < doneBy) {
    result.after = (await service.sessions.read(chat.id)).screen;
    if (session.preview?.includes('NATIVE_QUESTIONS_DONE') && session.activity === 'idle') break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  result.pendingAfter = service.questions.list();
  result.nativeId = session.nativeId;
  result.finalReceipts = session.submissions;
  result.status = result.pendingAfter.length === 0 && session.preview?.includes('NATIVE_QUESTIONS_DONE') ? 'passed' : 'incomplete';
} catch (error) { result.status = 'failed'; result.error = error.message; }
finally { await writeFile(path.join(root, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ root, status: result.status, error: result.error, nativeId: result.nativeId })); await service.close(); if (result.status !== 'passed') process.exitCode = 1; }
