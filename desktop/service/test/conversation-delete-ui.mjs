import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createService } from '../server.mjs'
import { Threads } from '../threads.mjs'
import { launchBrowser } from './browser.mjs'

const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'alpha-conversation-delete-ui-'))
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, '.alpha'))
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'fixture', title: 'Fixture project', folder: 'fixture', steps: [] }] }))
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}')
const saved = await new Threads(path.join(repo, '.alpha')).init()
const old = saved.create({ name: 'Old deletable conversation' })
saved.closeConversation(old.id)
await saved.close()
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } })
const current = service.threads.create({ name: 'Current deletable conversation', projectId: 'fixture' })
const pendingCleanup = service.threads.create({ name: 'Pending cleanup conversation', projectId: 'fixture' })
service.threads.message(old.id, { id: 'private-fixture', role: 'assistant', text: 'Disposable fixture history' })
service.threads.closeConversation(old.id); service.threads.select(current.id); await service.threads.beginDeletion(pendingCleanup.id); await service.threads.save()
const pending = await service.questions.ask({ source: 'coordinator', sourceId: 'delete-ui-question', threadId: old.id, chatName: old.name, text: 'Resolve this fixture question before deletion?' })
let browser, page
try {
  browser = await launchBrowser(); page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(15000)
  await page.goto(service.urls.workspace)
  await page.evaluate(id => localStorage.setItem(`alpha.threadDraft.${id}`, JSON.stringify({ text: 'Cached draft to delete', paths: [] })), old.id)
  await page.getByRole('button', { name: 'View', exact: true }).click(); await page.getByRole('menuitem', { name: 'Conversation history', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: 'Conversation history' })
  await expect(panel.getByRole('button', { name: /Old deletable conversation.*Conversations/ })).toBeVisible()
  await expect(panel).toContainText(pendingCleanup.name); await panel.getByRole('button', { name: 'Retry cleanup', exact: true }).click(); await expect(panel).not.toContainText(pendingCleanup.name)
  await panel.getByRole('button', { name: `Delete ${old.name}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete conversation', exact: true })
  await expect(dialog).toContainText(`Permanently delete ${old.name} from Alpha?`)
  await expect(dialog).toContainText('Copies you explicitly shared in other conversations remain')
  await expect(dialog).toContainText('Files you attached or saved in Workspace remain available')
  await expect(dialog).toContainText("provider-native transcript remains in that provider's own history")
  await expect(dialog).toContainText('will refuse deletion while this conversation has running workers, active work or pending Questions')
  await page.screenshot({ path: path.join(repo, 'conversation-delete-confirmation.png') })
  await dialog.getByRole('button', { name: 'Delete from Alpha', exact: true }).click()
  await expect(dialog).toBeVisible(); await expect.poll(() => service.threads.get(old.id).id).toBe(old.id)
  await service.questions.dismiss(pending.id)
  await dialog.getByRole('button', { name: 'Delete from Alpha', exact: true }).click()
  await expect(dialog).toHaveCount(0); await expect(panel.getByRole('button', { name: `Delete ${old.name}`, exact: true })).toHaveCount(0)
  assert.throws(() => service.threads.get(old.id), /not found/)
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`alpha.threadDraft.${id}`), old.id)).toBeNull()
  await panel.getByRole('button', { name: 'Review conversation metadata', exact: true }).click()
  await expect(panel.getByRole('button', { name: `Review ${current.name}`, exact: true })).toBeVisible()
  await expect(panel).not.toContainText(old.name)

  const tab = page.locator(`#conversation-tab-${current.id}`)
  await tab.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Delete conversation', exact: true })).toContainText(current.name)
  await page.getByRole('dialog', { name: 'Delete conversation', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(tab).toBeVisible(); await tab.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete conversation', exact: true }).getByRole('button', { name: 'Delete from Alpha', exact: true }).click()
  await expect(page.getByText('No open conversations', { exact: true })).toBeVisible(); assert.equal(service.threads.items.length, 0)
  await expect(panel).not.toContainText(current.name)
  console.log(`Conversation deletion UI passed with disposable fixtures only. Screenshot: ${path.join(repo, 'conversation-delete-confirmation.png')}`)
} finally { await browser?.close(); await service.close() }
