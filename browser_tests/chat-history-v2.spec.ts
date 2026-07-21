import { test, expect } from './fixtures/panelTest'

const THREADS_KEY = 'comfyui-mcp.panel.threads'
const META_KEY = 'comfyui-mcp.panel.historyMeta'

async function indexedThreadCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('comfyui-mcp-panel-history', 2)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('state')
        req.onsuccess = () => resolve(Array.isArray(req.result?.threads) ? req.result.threads.length : 0)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
}

test('keeps multiple chats, supports search and restores from IndexedDB without localStorage', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  let received = mockBridge.waitForUserMessage()
  await panel.sendMessage('first durable conversation')
  await received
  mockBridge.say('first answer')

  await panel.root.locator('button[title="New chat"]').click()
  received = mockBridge.waitForUserMessage()
  await panel.sendMessage('second searchable conversation')
  await received
  mockBridge.say('second answer')

  await expect(panel.root.locator('.cmcp-workflow-version').last()).toBeVisible()
  await expect.poll(() => indexedThreadCount(page)).toBe(2)

  await panel.root.locator('button[title="Chat history"]').click()
  const rows = panel.root.locator('.cmcp-hist-row')
  await expect(rows).toHaveCount(2)

  const newest = rows.first()
  await newest.hover()
  await newest.evaluate((row) => {
    const original = window.prompt
    window.prompt = () => 'Pinned test chat'
    row.querySelector<HTMLButtonElement>('button[aria-label="Rename chat"]')?.click()
    window.prompt = original
  })
  await expect(panel.root.locator('.cmcp-hist-row').first()).toContainText('Pinned test chat')
  await panel.root.locator('.cmcp-hist-row').first().getByRole('button', { name: 'Pin chat' }).evaluate((button: HTMLButtonElement) => button.click())

  const search = panel.root.getByRole('searchbox', { name: 'Search chat history' })
  await search.fill('first durable')
  await expect(panel.root.locator('.cmcp-hist-row')).toHaveCount(1)
  await expect(panel.root.locator('.cmcp-hist-row')).toContainText('first durable conversation')

  const downloadPromise = page.waitForEvent('download')
  await panel.root.getByRole('button', { name: 'Export all chat history' }).evaluate((button: HTMLButtonElement) => button.click())
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^comfyui-agent-panel-history-.*\.json$/)

  await search.fill('')
  const chooserPromise = page.waitForEvent('filechooser')
  await panel.root.getByRole('button', { name: 'Import chat history (merge)' }).evaluate((button: HTMLButtonElement) => button.click())
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'history-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2,
      threads: [{
        id: 'imported-thread',
        ts: 1,
        workflowKey: 'panel:global',
        title: 'Imported archive',
        msgs: [{ role: 'user', text: 'imported history marker' }]
      }],
      meta: {}
    }))
  })
  await expect(panel.root.locator('.cmcp-hist-row')).toHaveCount(3)
  await expect(panel.root.locator('.cmcp-hist-row').filter({ hasText: 'Imported archive' })).toBeVisible()
  await expect.poll(() => indexedThreadCount(page)).toBe(3)

  // Remove both synchronous shadows. IndexedDB alone must recover the newest
  // conversation after a new page session.
  await page.evaluate(([threadsKey, metaKey]) => {
    localStorage.removeItem(threadsKey)
    localStorage.removeItem(metaKey)
    localStorage.removeItem('comfyui-mcp.panel.autoConnect')
    sessionStorage.clear()
  }, [THREADS_KEY, META_KEY])
  await page.reload()
  await panel.openSidebar()

  await expect(panel.userBubble('second searchable conversation')).toBeVisible()
  await expect(panel.agentBubbles.filter({ hasText: 'second answer' }).last()).toBeVisible()
})

test('embeds a stable workflow UUID and records provider/model workflow snapshots', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await page.evaluate(() => {
    const w = window as unknown as {
      app?: { ui?: { settings?: { setSettingValue?: (id: string, value: unknown) => void } } }
      comfyAPI?: { app?: { app?: { ui?: { settings?: { setSettingValue?: (id: string, value: unknown) => void } } } } }
    }
    const app = w.comfyAPI?.app?.app || w.app
    app?.ui?.settings?.setSettingValue?.('comfyui-mcp.chatScope', 'workflow')
  })
  await expect.poll(() => page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return app?.ui?.settings?.getSettingValue?.('comfyui-mcp.chatScope')
  })).toBe('workflow')

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('workflow identity test')
  await received

  const state = await page.evaluate((key) => {
    const w = window as unknown as {
      app?: { graph?: { extra?: Record<string, any> } }
      comfyAPI?: { app?: { app?: { graph?: { extra?: Record<string, any> } } } }
    }
    const app = w.comfyAPI?.app?.app || w.app
    const threads = JSON.parse(localStorage.getItem(key) || '[]')
    const current = threads.find((t: any) => t.msgs?.some((m: any) => m.text === 'workflow identity test'))
    return {
      uuid: app?.graph?.extra?.comfyui_mcp?.workflow_uuid,
      workflowKey: current?.workflowKey,
      provider: current?.provider,
      model: current?.model,
      versions: current?.workflowVersions,
      messageVersion: current?.msgs?.find((m: any) => m.text === 'workflow identity test')?.workflowVersion
    }
  }, THREADS_KEY)

  expect(state.uuid).toMatch(/^[0-9a-f-]{36}$/i)
  expect(state.workflowKey).toBe(`workflow:${state.uuid}`)
  expect(state.provider).toBe('claude')
  expect(state.model).toBeTruthy()
  expect(state.messageVersion).toMatch(/^[0-9a-f]{8}$/)
  expect(state.versions?.[state.messageVersion]?.nodeCount).toBeGreaterThanOrEqual(0)
})

test('workflow scope disables foreign chats and never restores a stale foreign pointer', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    app?.ui?.settings?.setSettingValue?.('comfyui-mcp.chatScope', 'workflow')
  })

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('belongs only to workflow A')
  await received

  const current = await page.evaluate((key) => {
    const threads = JSON.parse(localStorage.getItem(key) || '[]')
    return threads.find((thread: any) => thread.msgs?.some((m: any) => m.text === 'belongs only to workflow A'))
  }, THREADS_KEY)
  expect(current?.workflowKey).toMatch(/^workflow:/)

  await page.evaluate(({ threadsKey, metaKey, currentThread, currentWorkflowKey }) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    threads.push({
      id: 'foreign-thread',
      schemaVersion: 2,
      createdAt: Date.now() + 10,
      updatedAt: Date.now() + 10,
      ts: Date.now() + 10,
      workflowKey: 'workflow:definitely-another-workflow',
      workflowTitle: 'Workflow B',
      msgs: [{ id: 'foreign-message', role: 'user', text: 'must never appear on workflow A', createdAt: Date.now() + 10 }]
    })
    localStorage.setItem(threadsKey, JSON.stringify(threads))
    const meta = JSON.parse(localStorage.getItem(metaKey) || '{}')
    meta.activeByScope = {
      ...(meta.activeByScope || {}),
      [currentWorkflowKey]: currentThread,
      'workflow:definitely-another-workflow': 'foreign-thread'
    }
    localStorage.setItem(metaKey, JSON.stringify(meta))
    sessionStorage.setItem('comfyui-mcp.panel.currentThreadId', 'foreign-thread')
    window.dispatchEvent(new StorageEvent('storage', { key: threadsKey }))
  }, {
    threadsKey: THREADS_KEY,
    metaKey: META_KEY,
    currentThread: current.id,
    currentWorkflowKey: current.workflowKey
  })

  await panel.root.locator('button[title="Chat history"]').click()
  let currentOnly = panel.root.getByTestId('history-current-workflow')
  await currentOnly.uncheck()
  let foreignRow = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'must never appear on workflow A' })
  await expect(foreignRow).toBeVisible()
  await expect(foreignRow.locator('.cmcp-hist-open')).toBeDisabled()
  await expect(foreignRow.locator('.cmcp-hist-open')).toHaveAttribute('title', /open workflow b/i)
  await panel.root.locator('button[title="Chat history"]').click()

  await page.evaluate(() => sessionStorage.clear())

  await page.reload()
  await panel.openSidebar()
  // The hermetic fixture intentionally discards panel-setting writes at the
  // HTTP boundary, so re-apply the user's persisted workflow mode after reload.
  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    app?.ui?.settings?.setSettingValue?.('comfyui-mcp.chatScope', 'workflow')
  })
  // The fixture's canvas is intentionally unsaved, so a full browser restart
  // creates a fresh workflow UUID and a clean view. Crucially, the stale pointer
  // from Workflow B is never used as a fallback.
  await expect(panel.userBubble('must never appear on workflow A')).toHaveCount(0)

  await panel.root.locator('button[title="Chat history"]').click()
  currentOnly = panel.root.getByTestId('history-current-workflow')
  await currentOnly.uncheck()
  foreignRow = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'must never appear on workflow A' })
  await expect(foreignRow).toBeVisible()
  await expect(foreignRow.locator('.cmcp-hist-open')).toBeDisabled()
  await expect(foreignRow.locator('.cmcp-hist-open')).toHaveAttribute('title', /open workflow b/i)
})
