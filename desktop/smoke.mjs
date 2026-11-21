import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron, chromium } from 'playwright-core'
import { startDesktopServer } from './server.mjs'
import { createAiSettings } from './settings.mjs'

const [mode, executable] = process.argv.slice(2)
if (!executable || !['--electron', '--browser'].includes(mode)) {
  throw new Error('Usage: npm run test:desktop -- (--electron | --browser) <executable>')
}

const workspace = await mkdtemp(join(tmpdir(), 'serenity-desktop-test-'))
const providerKey = 'serenity-smoke-test-key'
const patchTitle = 'Serenity Desktop Smoke Test'
const patchId = 'node-ai-desktop-smoke'
let modelRequest
const provider = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  modelRequest = {
    url: request.url,
    key: request.headers.authorization,
    body: JSON.parse(Buffer.concat(chunks).toString()),
  }
  const source = JSON.parse(modelRequest.body.messages[1].content).context.nodes[0]
  const patch = {
    version: 1,
    intent: 'Test incremental changes',
    operations: [{ op: 'addNode', id: patchId, title: patchTitle, connectFromId: source?.id, edgeKind: 'related' }],
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ explanation: 'Mock reasoning', patch }) } }],
  }))
})

await new Promise((ready) => provider.listen(0, '127.0.0.1', ready))
const modelUrl = `http://127.0.0.1:${provider.address().port}/v1`

async function launch() {
  if (mode === '--electron') {
    const execution = await _electron.launch({
      executablePath: resolve(executable),
      args: [`--user-data-dir=${workspace}`],
      cwd: workspace,
      timeout: 30_000,
    })
    try {
      return { page: await execution.firstWindow(), close: () => execution.close() }
    } catch (error) {
      await execution.close()
      throw error
    }
  }

  // Exercise the same production renderer and HTTP backend where Electron cannot open a window.
  const settings = await createAiSettings(join(workspace, 'ai-settings.json'), {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'mock',
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  })
  const backend = await startDesktopServer({ distDir: resolve('dist'), storeDir: join(workspace, 'store'), settings })
  let browser
  try {
    browser = await chromium.launch({ executablePath: resolve(executable) })
    const page = await browser.newPage({ extraHTTPHeaders: { 'X-Serenity-Session': backend.token } })
    await page.goto(backend.origin)
    return {
      page,
      async close() {
        await browser.close()
        backend.close()
      },
    }
  } catch (error) {
    await browser?.close()
    backend.close()
    throw error
  }
}

async function fromCanvas(page, path) {
  return page.evaluate(async (relative) => {
    const response = await fetch(relative)
    return { status: response.status, body: await response.json() }
  }, path)
}

async function until(check, description) {
  const end = Date.now() + 15_000
  do {
    const result = await check()
    if (result) return result
    await delay(150)
  } while (Date.now() < end)
  throw new Error(`Timed out waiting for ${description}`)
}

async function readCanvas(page) {
  const result = await fromCanvas(page, '/api/canvas/default')
  return result.status === 200 ? result.body : undefined
}

function hasPatchNode(canvas) {
  return Object.values(canvas?.snapshot.document.store ?? {})
    .some((record) => record.meta?.serenity?.data?.id === patchId)
}

let instance
try {
  instance = await launch()
  const { page } = instance
  await page.getByText('AI API 设置', { exact: true }).click()
  await until(() => readCanvas(page), 'initial local snapshot')
  const pageMenu = page.getByTestId('page-menu.button')
  const initialPage = (await pageMenu.innerText()).trim()
  await pageMenu.click()
  await page.getByTestId('page-menu.create').click()
  await pageMenu.click()
  await page.getByTitle('新增卡片').click()
  await pageMenu.click()
  await page.getByTestId('page-menu.item').getByText(initialPage, { exact: true }).click()
  if (await page.getByTestId('page-menu.list').isVisible()) await pageMenu.click()
  const health = (await fromCanvas(page, '/api/health')).body
  assert.equal(await (await fetch(new URL('/api/health', page.url()))).status, 403)
  await page.getByLabel('API Base URL').fill(modelUrl)
  await page.getByLabel('模型', { exact: true }).fill('desktop-test-model')
  await page.getByLabel('API Key', { exact: true }).fill(providerKey)
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.getByText('AI 配置已保存。').waitFor()
  assert.deepEqual((await fromCanvas(page, '/api/desktop/settings')).body, {
    baseUrl: modelUrl, model: 'desktop-test-model', hasApiKey: true,
  })
  assert.ok(!(await readFile(join(health.storeDir, '..', 'ai-settings.json'), 'utf8')).includes(providerKey))

  await page.getByLabel('AI 思维指令').fill('Add one connected card')
  await page.getByRole('button', { name: '分析画布并提出修改' }).click()
  await page.getByText('待确认修改（1 项）').waitFor()
  assert.equal(modelRequest.url, '/v1/chat/completions')
  assert.equal(modelRequest.key, 'Bearer ' + providerKey)
  assert.equal(modelRequest.body.model, 'desktop-test-model')
  const context = JSON.parse(modelRequest.body.messages[1].content).context
  assert.ok(context.nodes.length && context.edges.length && context.otherPages.some((item) => item.nodes.length))
  assert.equal(hasPatchNode(await readCanvas(page)), false)
  await page.getByRole('button', { name: '确认并应用' }).click()
  await until(async () => hasPatchNode(await readCanvas(page)), 'confirmed patch on disk')

  await page.getByTestId('quick-actions.undo').click()
  await until(async () => !hasPatchNode(await readCanvas(page)), 'undo on disk')
  await page.getByTestId('quick-actions.redo').click()
  await until(async () => hasPatchNode(await readCanvas(page)), 'redo on disk')

  await instance.close()
  instance = await launch()
  await instance.page.getByText('AI API 设置', { exact: true }).waitFor()
  assert.equal(hasPatchNode(await readCanvas(instance.page)), true)
  assert.equal((await fromCanvas(instance.page, '/api/desktop/settings')).body.hasApiKey, true)
  console.log('Desktop smoke passed: startup, encrypted settings, multi-page reasoning, preview, apply, undo, redo, and restart.')
} finally {
  await instance?.close()
  provider.close()
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
