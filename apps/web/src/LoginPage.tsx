import { useState, type FormEvent } from 'react'
import { loginRequest, setAuthSession } from './auth'
import './home/home.css'

export default function LoginPage({
  onSuccess,
}: {
  onSuccess: (username: string) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await loginRequest(username.trim(), password)
      setAuthSession(result)
      onSuccess(result.username)
    } catch (value) {
      setError(value instanceof Error ? value.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fb-login-page">
      <div className="fb-login-card">
        <div className="fb-login-brand">
          <span className="fb-login-kicker">ROOM DESIGN · DEMO</span>
          <h1>测试环境登录</h1>
          <p>
            本服务部署在公网仅供内测。请使用分配的测试账号登录，避免未授权调用生图
            API 消耗额度。
          </p>
        </div>
        <form className="fb-login-form" onSubmit={(e) => void onSubmit(e)}>
          <label>
            <span>用户名</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="测试账号"
              disabled={busy}
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="测试密码"
              disabled={busy}
              required
            />
          </label>
          {error ? <div className="fb-login-error">{error}</div> : null}
          <button type="submit" className="fb-login-submit" disabled={busy}>
            {busy ? '登录中…' : '进入工作台'}
          </button>
        </form>
        <p className="fb-login-hint">会话保存在本标签页，关闭后需重新登录。</p>
      </div>
    </div>
  )
}
