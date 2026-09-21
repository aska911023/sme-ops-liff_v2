import { Component } from 'react'

// 全域錯誤邊界:任何一頁 render 崩潰時,顯示可讀的錯誤 + 重新載入,而不是整頁全白
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // 保留錯誤資訊方便診斷(console + 顯示)
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const msg = String(this.state.error?.message || this.state.error || '未知錯誤')
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
        background: 'var(--bg, #06091a)', color: 'var(--t1, #f1f5f9)', textAlign: 'center',
      }}>
        <div style={{ fontSize: 44 }}>⚠️</div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>頁面載入發生問題</div>
        <div style={{ fontSize: 13, color: 'var(--t2, #94a3b8)', maxWidth: 320, lineHeight: 1.6 }}>
          請點下方重新載入。若持續發生,請完全關閉後重新開啟。
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 4, padding: '10px 28px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontSize: 15, fontWeight: 700, color: '#fff',
            background: 'var(--wine-accent, #800020)',
          }}>
          重新載入
        </button>
        <details style={{ marginTop: 12, maxWidth: 340, width: '100%' }}>
          <summary style={{ fontSize: 12, color: 'var(--t2, #94a3b8)', cursor: 'pointer' }}>錯誤訊息(給工程師)</summary>
          <pre style={{
            marginTop: 8, textAlign: 'left', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            padding: 12, borderRadius: 8, background: 'var(--card, rgba(15,23,55,0.75))',
            border: '1px solid var(--border, rgba(148,163,184,0.15))', color: 'var(--t2, #94a3b8)',
          }}>{msg}</pre>
        </details>
      </div>
    )
  }
}
