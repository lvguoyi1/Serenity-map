import { useEffect, useState } from 'react'

interface AiSettings {
  baseUrl: string
  model: string
  hasApiKey: boolean
}

const endpoint = '/api/desktop/settings'

export const isDesktop = () => Boolean(document.querySelector('meta[name="serenity-desktop"]'))

export function DesktopAiSettings() {
  const [settings, setSettings] = useState<AiSettings>()
  const [apiKey, setApiKey] = useState('')
  const [feedback, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch(endpoint, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error()
      setSettings(await response.json())
    }).catch(() => {
      if (!controller.signal.aborted) setFeedback('无法读取 AI 配置。')
    })
    return () => controller.abort()
  }, [])

  async function save(clearKey = false) {
    if (!settings || saving) return
    setSaving(true)
    setFeedback('')
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model, apiKey: clearKey ? '' : apiKey, clearKey }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setSettings(result)
      setApiKey('')
      setFeedback(clearKey ? 'API Key 已清除。' : 'AI 配置已保存。')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '无法保存 AI 配置。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="desktop-ai-settings">
      <summary>AI API 设置</summary>
      {settings && (
        <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          <fieldset disabled={saving}>
            <label>
              API Base URL
              <input required type="url" value={settings.baseUrl} onChange={(event) => {
                setSettings({ ...settings, baseUrl: event.target.value })
              }} />
            </label>
            <label>
              模型
              <input required value={settings.model} onChange={(event) => {
                setSettings({ ...settings, model: event.target.value })
              }} />
            </label>
            <label>
              API Key
              <input type="password" autoComplete="new-password" value={apiKey}
                placeholder={settings.hasApiKey ? '已保存' : '输入 API Key'}
                onChange={(event) => setApiKey(event.target.value)} />
            </label>
            <small>更换 API 地址时，请同时填写新地址的密钥。</small>
            <button type="submit" className="primary-action">{saving ? '保存中…' : '保存配置'}</button>
            {settings.hasApiKey && <button type="button" onClick={() => void save(true)}>清除密钥</button>}
          </fieldset>
        </form>
      )}
      {feedback && <p role="status">{feedback}</p>}
    </details>
  )
}
