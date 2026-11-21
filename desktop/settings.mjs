import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultAiConfig } from '../scripts/ai-agent.mjs'

export async function createAiSettings(file, safeStorage) {
  let current = { ...defaultAiConfig, encryptedKey: '' }
  try {
    current = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  function publicConfig() {
    return {
      baseUrl: current.baseUrl,
      model: current.model,
      hasApiKey: Boolean(current.encryptedKey),
    }
  }

  let pending = Promise.resolve()

  function save(input) {
    const operation = pending.then(async () => {
      const baseUrl = String(input?.baseUrl ?? '').trim().replace(/\/+$/, '')
      const model = String(input?.model ?? '').trim()
      const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
      let url
      try {
        url = new URL(baseUrl)
      } catch {
        throw Object.assign(new Error('请输入有效的 API Base URL。'), { statusCode: 400 })
      }

      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
          url.username || url.password || url.search || url.hash || !model || model.length > 200 ||
          apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) {
        throw Object.assign(new Error('请检查 API 地址、模型名称和 API Key。'), { statusCode: 400 })
      }

      // Changing provider must not implicitly send the previous provider's key.
      let encryptedKey = input.clearKey || baseUrl !== current.baseUrl ? '' : current.encryptedKey
      if (apiKey) {
        if (!safeStorage.isEncryptionAvailable() ||
            (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
          throw Object.assign(new Error('系统密钥存储不可用，无法保存 API Key。'), { statusCode: 503 })
        }
        encryptedKey = safeStorage.encryptString(apiKey).toString('base64')
      }

      const next = { baseUrl, model, encryptedKey }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 })
      await rename(file + '.tmp', file)
      current = next
      return publicConfig()
    })
    pending = operation.catch(() => {})
    return operation
  }

  function forRequest() {
    try {
      return {
        ...publicConfig(),
        apiKey: current.encryptedKey
          ? safeStorage.decryptString(Buffer.from(current.encryptedKey, 'base64'))
          : '',
      }
    } catch {
      throw Object.assign(new Error('无法读取系统加密的 API Key，请重新保存。'), { statusCode: 503 })
    }
  }

  return { publicConfig, save, forRequest }
}
