import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, FileText, Clock, CheckCircle2, XCircle, ArrowRight, RotateCcw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import ChainTimeline from '../components/ChainTimeline'

// 把 status 分到三大類：進行中 / 已通過 / 已退回
const PASS_STATUSES = ['已核准', '已核銷', '已通過', 'approved']  // approved=headcount 英文狀態
// 任何一種 reject 都可以編輯重送（後端 RPC 已支援 3 種變體）
const RESUBMIT_STATUSES = ['已退回', '已駁回', '已拒絕']
const FAIL_STATUSES = ['已拒絕', '已駁回', '已退回', 'rejected']

// 幣別符號（與 Approve.jsx 同步）— 之前 expenses/expense_requests 摘要寫死 NT$，
// USD/JPY 等外幣單也顯示 NT$（例：US$668 伺服器費被印成 NT$668）→ 改讀 currency
const CURRENCY_SYMBOLS = {
  TWD: 'NT$', USD: '$', JPY: '¥', CNY: '¥', EUR: '€', GBP: '£',
  HKD: 'HK$', SGD: 'S$', AUD: 'A$', NZD: 'NZ$', CAD: 'C$', KRW: '₩', THB: '฿',
}
const fmtCurrency = (amount, currency) => {
  const cur = currency || 'TWD'
  const sym = CURRENCY_SYMBOLS[cur] || cur
  return `${sym} ${Number(amount || 0).toLocaleString()}`
}

const TYPE_META = {
  leaves:           { label: '請假',   icon: '🏖️', color: 'cyan',   rpcType: 'leave',           editPath: '/leave' },
  overtimes:        { label: '加班',   icon: '⏰', color: 'orange', rpcType: 'overtime',        editPath: '/overtime' },
  trips:            { label: '出差',   icon: '🚗', color: 'purple', rpcType: 'trip',            editPath: '/business-trip' },
  expenses:         { label: '報帳',   icon: '💰', color: 'green',  rpcType: 'expense',         editPath: '/expenses' },
  corrections:      { label: '補打卡', icon: '✏️', color: 'cyan',   rpcType: 'correction',      editPath: '/clock-correction' },
  expense_requests: { label: '申請',   icon: '📝', color: 'green',  rpcType: 'expense_request', editPath: '/expense-request' },
  form_submissions: { label: '自訂表單', icon: '📋', color: 'blue',  rpcType: 'form_submission', editPath: null },
  resignations:     { label: '離職',   icon: '👋', color: 'orange', rpcType: 'resignation',     editPath: null },
  loas:             { label: '留停',   icon: '⏸️', color: 'cyan',   rpcType: 'loa',             editPath: null },
  transfers:        { label: '異動',   icon: '🔀', color: 'purple', rpcType: 'transfer',        editPath: null },
  headcounts:       { label: '人力需求', icon: '🧑‍💼', color: 'blue', rpcType: 'headcount',       editPath: null },
}

export default function ApprovalStatus() {
  const { lineProfile } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState('pending') // pending | passed | failed
  const [data, setData] = useState({ leaves: [], overtimes: [], trips: [], expenses: [], corrections: [], expense_requests: [], form_submissions: [], resignations: [], loas: [], transfers: [], headcounts: [] })
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!lineProfile?.lineUserId) return
    const { data: rpcData, error } = await supabase.rpc('liff_list_my_submissions', {
      p_line_user_id: lineProfile.lineUserId,
    })
    if (error) {
      console.error('load my submissions', error)
      setLoading(false)
      return
    }
    setData(rpcData || { leaves: [], overtimes: [], trips: [], expenses: [], corrections: [], expense_requests: [], form_submissions: [], resignations: [], loas: [], transfers: [], headcounts: [] })
    setLoading(false)
  }, [lineProfile?.lineUserId])

  useEffect(() => { reload() }, [reload])

  // 展開看簽核進度（懶載入 liff_get_request_chain）
  const [openChain, setOpenChain] = useState(null)   // `${type}-${id}`
  const [chains, setChains] = useState({})           // { key: { loading, steps } }
  const toggleChain = useCallback(async (r) => {
    const key = `${r._type}-${r.id}`
    if (openChain === key) { setOpenChain(null); return }
    setOpenChain(key)
    if (chains[key]) return
    setChains(prev => ({ ...prev, [key]: { loading: true, steps: [] } }))
    const { data: steps, error } = await supabase.rpc('liff_get_request_chain', {
      p_type: r._meta.rpcType, p_id: r.id,
    })
    setChains(prev => ({ ...prev, [key]: { loading: false, steps: error ? [] : (steps || []) } }))
  }, [openChain, chains])

  // 把所有 type 的 records 攤平成統一格式
  const flatten = () => {
    const rows = []
    Object.entries(TYPE_META).forEach(([key, meta]) => {
      ;(data[key] || []).forEach(r => {
        const status = r.status || ''
        rows.push({
          ...r,
          _type: key,
          _meta: meta,
          _status: status,
          _bucket: PASS_STATUSES.includes(status) ? 'passed'
                 : FAIL_STATUSES.includes(status) ? 'failed'
                 : 'pending',
        })
      })
    })
    rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    return rows
  }

  const allRows = flatten()
  const counts = {
    pending: allRows.filter(r => r._bucket === 'pending').length,
    passed:  allRows.filter(r => r._bucket === 'passed').length,
    failed:  allRows.filter(r => r._bucket === 'failed').length,
  }
  const visibleRows = allRows.filter(r => r._bucket === tab)

  const stColor = (s) => PASS_STATUSES.includes(s) ? 'var(--green)'
                       : FAIL_STATUSES.includes(s) ? 'var(--red)'
                       : 'var(--orange)'
  const stBg    = (s) => PASS_STATUSES.includes(s) ? 'var(--green-dim)'
                       : FAIL_STATUSES.includes(s) ? 'var(--red-dim)'
                       : 'rgba(251,146,60,0.1)'

  // 摘要行：根據 type 顯示不同欄位
  const renderSummary = (r) => {
    if (r._type === 'leaves') {
      return `${r.type || '請假'} · ${r.start_date}${r.end_date && r.end_date !== r.start_date ? ` ~ ${r.end_date}` : ''} · ${r.hours && r.hours < 8 ? `${r.hours}h` : `${r.days}天`}`
    }
    if (r._type === 'overtimes') return `${r.date} · ${r.hours}h`
    if (r._type === 'trips')     return `${r.destination || ''} · ${r.start_date} ~ ${r.end_date}`
    if (r._type === 'expenses')  return `${r.category || ''} · ${fmtCurrency(r.amount, r.currency)} · ${r.date}`
    if (r._type === 'corrections') return `${({ clock_in: '上班打卡', clock_out: '下班打卡' }[r.type] || r.type || '上班打卡')} · ${r.date} · ${r.correction_time || '未填'}`
    if (r._type === 'expense_requests') return `${r.title} · ${fmtCurrency(r.estimated_amount, r.currency)}`
    if (r._type === 'form_submissions') return r.template_name || '自訂表單'
    if (r._type === 'resignations') return `離職 · 預計 ${r.planned_resign_date || '—'}`
    if (r._type === 'loas')        return `${r.reason_type || '留停'} · ${r.start_date || ''}${r.planned_end_date ? ' ~ ' + r.planned_end_date : ''}`
    if (r._type === 'transfers')   return `${r.transfer_type || '異動'} · 生效 ${r.effective_date || '—'}`
    if (r._type === 'headcounts')  return r.title || '人力需求申請'
    return ''
  }

  return (
    <div className="page">
      <button className="back-btn" onClick={() => navigate('/')}><ChevronLeft size={16} /> 首頁</button>
      <div className="header">
        <div className="header-title">📊 我的簽核進度</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>
          查詢我提交過的所有單據狀態
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'pending', label: '進行中', icon: Clock,         count: counts.pending, color: 'var(--orange)' },
          { key: 'passed',  label: '已通過', icon: CheckCircle2,  count: counts.passed,  color: 'var(--green)' },
          { key: 'failed',  label: '已退回', icon: XCircle,       count: counts.failed,  color: 'var(--red)' },
        ].map(t => {
          const Icon = t.icon
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              flex: 1, padding: '10px 6px', borderRadius: 10, fontSize: 12, fontWeight: 700,
              border: `1.5px solid ${tab === t.key ? t.color : 'var(--border2)'}`,
              background: tab === t.key ? `${t.color === 'var(--orange)' ? 'rgba(251,146,60,0.1)' : t.color === 'var(--green)' ? 'var(--green-dim)' : 'var(--red-dim)'}` : 'var(--card)',
              color: tab === t.key ? t.color : 'var(--t2)',
              cursor: 'pointer', position: 'relative',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            }}>
              <Icon size={16} />
              <span>{t.label}</span>
              {t.count > 0 && (
                <span style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 20, height: 20, borderRadius: '50%',
                  background: t.color, color: '#fff',
                  fontSize: 11, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{t.count}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Quick link to Approve page */}
      <button onClick={() => navigate('/approve')} style={{
        width: '100%', padding: '10px 14px', borderRadius: 10, marginBottom: 16,
        background: 'var(--cyan-dim)', color: 'var(--cyan)',
        border: '1.5px solid var(--cyan)', fontSize: 13, fontWeight: 700,
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>👀 我要審別人的單據</span>
        <ArrowRight size={14} />
      </button>

      {loading ? (
        <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>
      ) : visibleRows.length === 0 ? (
        <div className="empty">
          <FileText size={20} style={{ marginBottom: 8, opacity: 0.6 }} />
          <div>
            {tab === 'pending' ? '目前沒有進行中的單據' :
             tab === 'passed'  ? '尚無已通過的單據' :
                                 '尚無被退回的單據'}
          </div>
        </div>
      ) : visibleRows.map(r => (
        <div key={`${r._type}-${r.id}`} className="list-item" style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 16 }}>{r._meta.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{r._meta.label}</span>
              {r.created_at && (
                <span style={{ fontSize: 11, color: 'var(--t3)' }}>· {r.created_at.slice(0, 10)}</span>
              )}
            </div>
            <span style={{
              padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
              background: stBg(r._status), color: stColor(r._status), flexShrink: 0,
            }}>{r._status}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--t2)', marginLeft: 24 }}>
            {renderSummary(r)}
          </div>
          {/* 經常性費用(expense)已補簽核鏈快照+RPC分支 → 也顯示「查看簽核進度」(原本排除是因RPC不支援) */}
          {(
            <div style={{ marginLeft: 24, marginTop: 8 }}>
              <button
                onClick={() => toggleChain(r)}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--cyan)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {openChain === `${r._type}-${r.id}` ? '▾' : '▸'} 查看簽核進度
              </button>
              {openChain === `${r._type}-${r.id}` && (() => {
                const c = chains[`${r._type}-${r.id}`]
                if (!c || c.loading) return <div style={{ marginTop: 8, fontSize: 12, color: 'var(--t3)' }}>載入中…</div>
                if (!c.steps.length) return <div style={{ marginTop: 8, fontSize: 12, color: 'var(--t3)' }}>此單無詳細簽核關卡紀錄（較早期建立的單）。</div>
                return (
                  <div style={{ marginTop: 8 }}>
                    <ChainTimeline steps={c.steps} requestType={r._meta.rpcType} requestId={r.id} />
                  </div>
                )
              })()}
            </div>
          )}
          {r.reject_reason && (
            <div style={{
              marginTop: 8, marginLeft: 24, padding: '10px 12px', borderRadius: 8,
              background: 'rgba(248,113,113,0.12)', border: '1.5px solid var(--red)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 3 }}>
                🔄 退回原因
              </div>
              <div style={{ fontSize: 13, color: 'var(--red)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {r.reject_reason}
              </div>
            </div>
          )}
          {Array.isArray(r.reject_attachments) && r.reject_attachments.length > 0 && (
            <div style={{ marginTop: 8, marginLeft: 24, padding: '10px 12px', borderRadius: 8,
              background: 'rgba(248,113,113,0.08)', border: '1px solid var(--red)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>
                📎 駁回附件
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {r.reject_attachments.map((att, i) => (
                  <a key={i} href={att.url} target="_blank" rel="noreferrer"
                     style={{ fontSize: 12, color: 'var(--cyan)', textDecoration: 'underline', wordBreak: 'break-all' }}>
                    {att.name || `附件 ${i + 1}`}
                  </a>
                ))}
              </div>
            </div>
          )}
          {r.approver && PASS_STATUSES.includes(r._status) && (
            <div style={{ marginTop: 4, marginLeft: 24, fontSize: 11, color: 'var(--t3)' }}>
              簽核人：{r.approver}
            </div>
          )}
          {RESUBMIT_STATUSES.includes(r._status) && r._meta.editPath && r._type !== 'expense_requests' && (
            <button
              onClick={() => navigate(`${r._meta.editPath}?resubmit=${r.id}`)}
              style={{
                marginTop: 8, marginLeft: 24, padding: '8px 14px', borderRadius: 8,
                border: '1.5px solid var(--orange)', background: 'rgba(251,146,60,0.1)',
                color: 'var(--orange)', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <RotateCcw size={12} /> ✏️ 編輯並重送
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
