import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronLeft, Check, X, ClipboardCheck, AlertCircle, Edit3, Send, Paperclip, Star } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import SignaturePad from '../components/SignaturePad'
import EmployeePicker from '../components/EmployeePicker'

const STATUS_COLOR = {
  '草稿':   '#94a3b8',
  '待確認': '#6366f1',
  '申請中': '#f59e0b',
  '已核准': '#22c55e',
  '已退回': '#ef4444',
}

const CAT_ORDER = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }

// 依 item_no → 兩層分組：大類 → 關聯群組
function buildCats(items) {
  const cats = {}
  ;[...items].sort((a, b) => (a.item_no || 0) - (b.item_no || 0)).forEach(item => {
    const c = item.category_code || '?'
    if (!cats[c]) cats[c] = { code: c, name: item.category_name, groups: {}, order: [] }
    const g = item.relation_group || '—'
    if (!cats[c].groups[g]) { cats[c].groups[g] = { name: g, allot: item.group_allot || 0, items: [] }; cats[c].order.push(g) }
    cats[c].groups[g].items.push(item)
  })
  return Object.values(cats).sort((a, b) => (CAT_ORDER[a.code] || 99) - (CAT_ORDER[b.code] || 99))
}
// 加分列(input_type='bonus')的 deduct_score 存加分點數,計分時當負扣往回加
const itemDeduct = (i) => i.input_type === 'bonus' ? -(i.deduct_score || 0) : (i.deduct_score || 0)
const groupDeduct = (grp) => grp.items.reduce((s, i) => s + itemDeduct(i), 0)
const catMax = (cat) => cat.order.reduce((s, g) => s + (cat.groups[g].allot || 0), 0)
const catDeduct = (cat) => cat.order.reduce((s, g) => s + groupDeduct(cat.groups[g]), 0)
const catScore = (cat) => Math.min(catMax(cat), Math.max(0, catMax(cat) - catDeduct(cat)))

export default function StoreAudit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { lineProfile, employee } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showReject, setShowReject] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const [employees, setEmployees] = useState([])
  const [draftOnDuty, setDraftOnDuty] = useState([])
  const [signingIdx, setSigningIdx] = useState(null)

  const load = useCallback(async () => {
    if (!lineProfile?.lineUserId || !id) return
    setLoading(true)
    const { data: res, error } = await supabase.rpc('liff_get_store_audit_detail', {
      p_line_user_id: lineProfile.lineUserId,
      p_audit_id: Number(id),
    })
    if (error || !res?.ok) {
      alert('載入失敗：' + (error?.message || res?.error || 'unknown'))
      setLoading(false); return
    }
    setData(res)
    setDraftOnDuty((res.on_duty || []).map(d => ({ ...d })))
    setLoading(false)
  }, [lineProfile?.lineUserId, id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!lineProfile?.lineUserId) return
    supabase.rpc('liff_list_employees', { p_line_user_id: lineProfile.lineUserId })
      .then(({ data }) => setEmployees(data?.list || []))
  }, [lineProfile?.lineUserId])

  const cats = useMemo(() => buildCats(data?.items || []), [data])
  const scoredCats = useMemo(() => cats.filter(c => catMax(c) > 0), [cats])
  const avgScore = useMemo(() => scoredCats.length
    ? Math.round(scoredCats.reduce((s, c) => s + catScore(c), 0) / scoredCats.length * 100) / 100 : 0, [scoredCats])

  const stats = useMemo(() => {
    const its = data?.items || []
    const deductedCount = its.filter(i => i.input_type !== 'bonus' && (i.deduct_score || 0) > 0).length
    const totalDeducted = its.reduce((s, i) => s + (i.input_type === 'bonus' ? 0 : (i.deduct_score || 0)), 0)
    return { deductedCount, totalDeducted }
  }, [data])

  const a = data?.audit
  const isDraft = a?.status === '草稿'
  const isAuditor = a?.auditor_id === employee?.id
  const canEdit = isDraft && isAuditor
  const photos = Array.isArray(a?.photos) ? a.photos : []

  const patchItem = (itemId, patch) =>
    setData(prev => ({ ...prev, items: prev.items.map(i => i.id === itemId ? { ...i, ...patch } : i) }))

  // 扣分（clamp 群組配分）
  const setDeduct = async (item, raw, maxDeduct) => {
    const isBonus = item.input_type === 'bonus'
    let v = Math.max(0, Math.floor(Number(raw) || 0))
    if (v > maxDeduct) { v = Math.max(0, maxDeduct); alert(isBonus ? `加分上限 ${Math.max(0, maxDeduct)} 分` : `此群組最多再扣 ${Math.max(0, maxDeduct)} 分`) }
    patchItem(item.id, isBonus ? { deduct_score: v, passed: true } : { deduct_score: v, passed: v > 0 ? false : true })
    await supabase.rpc('liff_update_store_audit_item', {
      p_line_user_id: lineProfile.lineUserId, p_item_id: item.id, p_deduct_score: v,
    })
  }
  // 群組說明（存群組首項；新範本改存「其他」列 → 大項集中說明）
  const setGroupNote = async (leadItemId, text) => {
    patchItem(leadItemId, { group_note: text })
    await supabase.rpc('liff_update_store_audit_item', {
      p_line_user_id: lineProfile.lineUserId, p_item_id: leadItemId, p_group_note: text,
    })
  }
  // 「其他」列名稱（可自由填）
  const setItemText = async (itemId, text) => {
    patchItem(itemId, { item_text: text })
    await supabase.rpc('liff_update_store_audit_item', {
      p_line_user_id: lineProfile.lineUserId, p_item_id: itemId, p_item_text: text,
    })
  }
  // 打字題內容
  const setItemRemark = async (itemId, text) => {
    patchItem(itemId, { remark: text })
    await supabase.rpc('liff_update_store_audit_item', {
      p_line_user_id: lineProfile.lineUserId, p_item_id: itemId, p_remark: text,
    })
  }
  // 多格填寫內容(input_type='multi',存 remark_list jsonb 陣列)
  const setItemRemarkList = async (itemId, arr) => {
    patchItem(itemId, { remark_list: arr })
    await supabase.rpc('liff_update_store_audit_item', {
      p_line_user_id: lineProfile.lineUserId, p_item_id: itemId, p_remark_list: arr,
    })
  }

  // ─── 整張單共用照片 ───
  const [photoUploading, setPhotoUploading] = useState(false)
  const savePhotos = async (next) => {
    setData(prev => ({ ...prev, audit: { ...prev.audit, photos: next } }))
    await supabase.rpc('liff_save_store_audit_photos', {
      p_line_user_id: lineProfile.lineUserId, p_audit_id: Number(id), p_photos: next,
    })
  }
  const handlePhotoFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    const remaining = 20 - photos.length
    if (remaining <= 0) { alert('最多 20 張照片'); e.target.value = ''; return }
    setPhotoUploading(true)
    try {
      const urls = await Promise.all(files.slice(0, remaining).map(async (file) => {
        const ext = file.name.split('.').pop() || 'jpg'
        const path = `${Number(id)}/audit/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const { error } = await supabase.storage.from('audit-photos').upload(path, file, { upsert: false })
        if (error) throw error
        return supabase.storage.from('audit-photos').getPublicUrl(path).data.publicUrl
      }))
      await savePhotos([...photos, ...urls])
    } catch (err) {
      alert('上傳失敗：' + err.message)
    } finally {
      setPhotoUploading(false); e.target.value = ''
    }
  }
  const removePhoto = (url) => savePhotos(photos.filter(u => u !== url))

  // ─── 當班人員 ───
  const addDraftStaff = () => {
    if (draftOnDuty.length >= 3) { alert('最多 3 人'); return }
    setDraftOnDuty(prev => [...prev, { employee_id: null, employee_name: '' }])
  }
  const updateDraftStaff = (idx, empId) => {
    const emp = employees.find(e => e.id === Number(empId))
    const next = draftOnDuty.map((d, i) => i === idx ? { ...d, employee_id: emp?.id || null, employee_name: emp?.name || '' } : d)
    setDraftOnDuty(next); saveDraftOnDuty(next)
  }
  const removeDraftStaff = (idx) => {
    const next = draftOnDuty.filter((_, i) => i !== idx)
    setDraftOnDuty(next); saveDraftOnDuty(next)
  }

  const uploadSignature = async (dataUrl, audId, empId) => {
    if (dataUrl.startsWith('http')) return dataUrl
    const blob = await (await fetch(dataUrl)).blob()
    const path = `${audId}/${empId || 'anon'}_${Date.now()}.png`
    const { error } = await supabase.storage.from('audit-signatures')
      .upload(path, blob, { contentType: 'image/png', upsert: true })
    if (error) throw error
    return supabase.storage.from('audit-signatures').getPublicUrl(path).data.publicUrl
  }

  const saveDraftOnDuty = async (list) => {
    if (!isDraft || !lineProfile?.lineUserId) return
    try {
      const uploaded = await Promise.all(list.map(async d => ({
        employee_id: d.employee_id,
        employee_name: d.employee_name,
        signature: d.signature_data_url ? await uploadSignature(d.signature_data_url, Number(id), d.employee_id) : null,
      })))
      await supabase.rpc('liff_save_audit_draft_on_duty', {
        p_line_user_id: lineProfile.lineUserId, p_audit_id: Number(id), p_on_duty: uploaded,
      })
    } catch (e) { console.warn('save draft on_duty failed', e) }
  }

  // ─── 送出 ───
  const doSubmit = async () => {
    // 加分改整組一格說明:任一加分群組有加分(合計>0)就需填該組 group_note(存在該組第一列)
    const bg = {}
    for (const i of (data?.items || []).filter(i => i.input_type === 'bonus')) {
      const k = `${i.category_code}|${i.relation_group}`
      bg[k] = bg[k] || { pts: 0, note: '' }
      bg[k].pts += (i.deduct_score || 0)
      if (i.group_note?.trim()) bg[k].note = i.group_note.trim()
    }
    const bonusMissing = Object.values(bg).some(g => g.pts > 0 && !g.note)
    if (bonusMissing) { alert('有加分時，需填該加分區的「加分原因」'); return }
    if (draftOnDuty.length === 0) { alert('請至少選 1 名當班人員'); return }
    const unsigned = draftOnDuty.filter(d => !d.signature_data_url)
    if (unsigned.length > 0) { alert(`還有 ${unsigned.length} 位當班人員未簽名`); return }
    setBusy(true)
    try {
      const uploaded = await Promise.all(draftOnDuty.map(async d => ({
        employee_id: d.employee_id,
        employee_name: d.employee_name,
        signature: await uploadSignature(d.signature_data_url, Number(id), d.employee_id),
      })))
      const { data: res, error } = await supabase.rpc('submit_store_audit', {
        p_line_user_id: lineProfile.lineUserId, p_audit_id: Number(id), p_on_duty: uploaded,
      })
      if (error) throw error
      if (!res?.ok) throw new Error(res?.error || 'unknown')
      alert(res.event === 'auto_approved_no_chain' ? '已核准（無簽核鏈設定）' : '已送出，進入簽核流程')
      load()
    } catch (err) {
      alert('送出失敗：' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const doApprove = async () => {
    if (busy) return
    if (!confirm('確認核准此份稽核？')) return
    setBusy(true)
    const { data: res, error } = await supabase.rpc('liff_store_audit_approve', {
      p_line_user_id: lineProfile.lineUserId, p_id: Number(id), p_action: 'approve', p_reason: null,
    })
    setBusy(false)
    if (error || !res?.ok) { alert('失敗：' + (error?.message || res?.error || 'unknown')); return }
    alert('完成'); load()
  }

  const doReject = async () => {
    if (busy) return
    if (!rejectReason.trim()) { alert('請填退回原因'); return }
    setBusy(true)
    const { data: res, error } = await supabase.rpc('liff_store_audit_approve', {
      p_line_user_id: lineProfile.lineUserId, p_id: Number(id), p_action: 'reject', p_reason: rejectReason.trim(),
    })
    setBusy(false)
    if (error || !res?.ok) { alert('失敗：' + (error?.message || res?.error || 'unknown')); return }
    setShowReject(false); setRejectReason('')
    alert('已退回'); load()
  }

  if (loading) {
    return <div className="page"><div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div></div>
  }
  if (!a) {
    return (
      <div className="page">
        <button className="back-btn" onClick={() => navigate('/')}><ChevronLeft size={16} /> 首頁</button>
        <div className="empty"><AlertCircle size={32} style={{ opacity: 0.4 }} /><div>找不到稽核單</div></div>
      </div>
    )
  }

  const statusColor = STATUS_COLOR[a.status] || '#94a3b8'
  const scoreColor = avgScore >= 90 ? '#22c55e' : avgScore >= 70 ? '#f59e0b' : '#ef4444'

  return (
    <div className="page">
      <button className="back-btn" onClick={() => navigate(-1)}><ChevronLeft size={16} /> 返回</button>

      {/* Header */}
      <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="header-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ClipboardCheck size={18} /> 稽核單 #{a.id}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>
            {a.store_name} · {a.audit_date}{a.shift ? ` · ${a.shift}` : ''}
          </div>
        </div>
        <span style={{ padding: '4px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: `${statusColor}22`, color: statusColor }}>{a.status}</span>
      </div>

      {/* 總平均 + 各類 */}
      <div style={{ margin: '12px 0', padding: 12, background: 'var(--glass)', borderRadius: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>扣分 {stats.deductedCount} 項 · 總扣 {stats.totalDeducted}</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: scoreColor }}>總平均 {avgScore}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {scoredCats.map(c => (
            <span key={c.code} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--bg)', color: 'var(--t2)' }}>
              {c.name} {catScore(c)}
            </span>
          ))}
        </div>
      </div>

      <Section title="基本資訊">
        <Row label="稽核員" value={a.auditor_name} />
        {a.arrive_time && <Row label="到店" value={a.arrive_time.slice(0, 5)} />}
        {a.depart_time && <Row label="離店" value={a.depart_time.slice(0, 5)} />}
        {a.approver && <Row label={a.status === '已退回' ? '退回人' : '核簽人'} value={a.approver} />}
        {a.reject_reason && <Row label="退回原因" value={a.reject_reason} color="#ef4444" />}
      </Section>

      {/* 當班人員 */}
      <Section title={canEdit ? '當班人員（1~3 人，請現場簽名）' : '當班人員'}>
        {canEdit ? (
          <>
            {draftOnDuty.map((d, idx) => (
              <div key={idx} style={{ marginBottom: 8, padding: 8, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <EmployeePicker value={d.employee_id || ''} employees={employees}
                      onChange={(v) => updateDraftStaff(idx, v)} placeholder="選當班人員" />
                  </div>
                  <button onClick={() => removeDraftStaff(idx)}
                    style={{ padding: '0 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--t3)', minHeight: 38 }}>×</button>
                </div>
                {d.employee_id && (
                  d.signature_data_url ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <img src={d.signature_data_url} alt="簽名" style={{ height: 32, background: '#fff', borderRadius: 4 }} />
                      <span style={{ flex: 1, fontSize: 11, color: '#22c55e' }}>✓ 已簽</span>
                      <button onClick={() => setSigningIdx(idx)} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)' }}>重簽</button>
                    </div>
                  ) : (
                    <button onClick={() => setSigningIdx(idx)}
                      style={{ width: '100%', padding: 8, borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 700 }}>
                      <Edit3 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />請當班人員簽名
                    </button>
                  )
                )}
              </div>
            ))}
            {draftOnDuty.length < 3 && (
              <button onClick={addDraftStaff}
                style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--t2)', fontSize: 12 }}>
                + 新增當班人員
              </button>
            )}
          </>
        ) : (
          (data.on_duty || []).map((d, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: i < data.on_duty.length - 1 ? '1px solid var(--border)' : 'none', fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span>{d.employee_name}</span>
                {d.confirmed && <span style={{ color: '#22c55e', fontSize: 11 }}>✓ 已簽</span>}
              </div>
              {d.signature_data_url && (
                <img src={d.signature_data_url} alt="簽名" style={{ height: 36, background: '#fff', borderRadius: 4 }} />
              )}
            </div>
          ))
        )}
      </Section>

      {/* 評核項目：大類 → 群組 */}
      {cats.map(cat => (
        <Section key={cat.code} title={`${cat.code}、${cat.name}`}
          subtitle={catMax(cat) > 0 ? `${catScore(cat)} / ${catMax(cat)}` : undefined}>
          {cat.order.map(gName => {
            const grp = cat.groups[gName]
            // 「其他」群組移到大項底部集中處理
            if (grp.items.some(i => i.input_type === 'other')) return null
            const isBonusGroup = grp.items.some(i => i.input_type === 'bonus')
            const gd = groupDeduct(grp)
            const bonusPts = isBonusGroup ? grp.items.reduce((s, i) => s + (i.deduct_score || 0), 0) : 0
            const lead = grp.items[0]
            return (
              <div key={gName} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 700, color: isBonusGroup ? '#22c55e' : 'var(--t2)', padding: '4px 6px', background: isBonusGroup ? 'rgba(34,197,94,0.12)' : 'var(--bg)', borderRadius: 6, marginBottom: 4 }}>
                  <span>{isBonusGroup ? '➕ 加分（回補分數，上限 100）' : grp.name}</span>
                  {isBonusGroup
                    ? (bonusPts > 0 && <span style={{ color: '#22c55e' }}>已加 {bonusPts}</span>)
                    : <span style={{ color: gd > 0 ? '#ef4444' : 'var(--t3)' }}>配分 {grp.allot}{gd > 0 ? ` · 已扣 ${gd}` : ''}</span>}
                </div>
                {!isBonusGroup && !cat.groups['其他']?.items?.some(i => i.input_type === 'other') && (canEdit ? (
                  <input value={lead?.group_note || ''} onChange={e => setGroupNote(lead.id, e.target.value)}
                    placeholder="此區說明（可留白）"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 12, marginBottom: 6 }} />
                ) : (lead?.group_note && (
                  <div style={{ fontSize: 12, color: 'var(--t2)', padding: '6px 8px', background: 'var(--glass)', borderRadius: 6, marginBottom: 6 }}>說明：{lead.group_note}</div>
                )))}
                {grp.items.map(item => (
                  <ItemRow key={item.id} item={item} canEdit={canEdit}
                    maxDeduct={item.input_type === 'bonus' ? 100 : (grp.allot || 0) - (gd - (item.deduct_score || 0))}
                    onDeduct={(v, max) => setDeduct(item, v, max)}
                    onRemark={(t) => setItemRemark(item.id, t)}
                    onRemarkList={(arr) => setItemRemarkList(item.id, arr)} />
                ))}
                {/* 加分群組:整組一格說明(有加分才必填) */}
                {isBonusGroup && (canEdit ? (
                  <input value={lead?.group_note || ''} onChange={e => setGroupNote(lead.id, e.target.value)}
                    placeholder="加分原因（有加分則必填，整組填一次即可）"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: (bonusPts > 0 && !lead?.group_note?.trim()) ? '1px solid #ef4444' : '1px solid var(--border)', background: 'rgba(34,197,94,0.10)', color: 'var(--t1)', fontSize: 12, marginTop: 6 }} />
                ) : (lead?.group_note && (
                  <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 6, padding: '6px 8px', background: 'rgba(34,197,94,0.10)', borderRadius: 6 }}>加分原因：{lead.group_note}</div>
                )))}
              </div>
            )
          })}
          {/* 其他（自由填寫,扣分計入本區）+ 大項集中說明 — 僅新範本 */}
          {(() => {
            const oItem = cat.groups['其他']?.items?.find(i => i.input_type === 'other')
            if (!oItem) return null
            return (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', padding: '4px 6px', background: 'var(--bg)', borderRadius: 6, marginBottom: 4 }}>其他（自由填寫，扣分計入本區）</div>
                {canEdit ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input value={oItem.item_text || ''} onChange={e => setItemText(oItem.id, e.target.value)} placeholder="項目名稱（可自由填）"
                      style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 13 }} />
                    <span style={{ fontSize: 12, color: 'var(--t3)' }}>扣</span>
                    <input type="number" inputMode="numeric" min="0" value={oItem.deduct_score || 0} onChange={e => setDeduct(oItem, e.target.value, 100)}
                      style={{ width: 58, padding: '8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 13, textAlign: 'right' }} />
                  </div>
                ) : ((oItem.item_text || oItem.deduct_score > 0) && (
                  <div style={{ fontSize: 12, color: 'var(--t2)', padding: '6px 8px', background: 'var(--glass)', borderRadius: 6, marginBottom: 6 }}>{oItem.item_text || '其他'}{oItem.deduct_score > 0 ? ` — 扣 ${oItem.deduct_score}` : ''}</div>
                ))}
                {canEdit ? (
                  <textarea value={oItem.group_note || ''} onChange={e => setGroupNote(oItem.id, e.target.value)} placeholder="本大項集中說明（可留白）" rows={2}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 12, resize: 'vertical' }} />
                ) : (oItem.group_note && (
                  <div style={{ fontSize: 12, color: 'var(--t2)', padding: '6px 8px', background: 'var(--glass)', borderRadius: 6 }}>說明：{oItem.group_note}</div>
                ))}
              </div>
            )
          })()}
        </Section>
      ))}

      {/* 整張單共用照片 */}
      {(canEdit || photos.length > 0) && (
        <Section title={`稽核照片（${photos.length}/20）`}>
          {canEdit && photos.length < 20 && (
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 52, border: '1px dashed var(--border)', borderRadius: 8, cursor: photoUploading ? 'default' : 'pointer', fontSize: 12, color: 'var(--t3)', marginBottom: photos.length ? 8 : 0 }}>
              <Paperclip size={14} /> {photoUploading ? '上傳中…' : '點此拍照 / 選檔案（最多 20）'}
              <input type="file" multiple style={{ display: 'none' }} onChange={handlePhotoFiles} disabled={photoUploading} />
            </label>
          )}
          {photos.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
              {photos.map((url, i) => {
                const isImg = /\.(jpe?g|png|webp|heic|heif|gif|bmp|svg)(\?|$)/i.test(url)
                const ext = ((url.split('?')[0].split('.').pop() || '檔').toUpperCase()).slice(0, 5)
                return (
                <div key={url} style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'var(--glass)' }}>
                  {isImg ? (
                    <img src={url} alt={`照片 ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onClick={() => window.open(url, '_blank')} />
                  ) : (
                    <a href={url} target="_blank" rel="noreferrer" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', gap: 4, textDecoration: 'none', color: 'var(--t1)' }}>
                      <Paperclip size={20} />
                      <span style={{ fontSize: 10, fontWeight: 700 }}>{ext}</span>
                    </a>
                  )}
                  {canEdit && (
                    <button onClick={() => removePhoto(url)}
                      style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 14, lineHeight: '20px', padding: 0, cursor: 'pointer' }}>×</button>
                  )}
                </div>
                )})}
            </div>
          )}
        </Section>
      )}

      {/* 底部 action */}
      {canEdit && (
        <div style={{ position: 'sticky', bottom: 0, padding: '12px 0 24px', background: 'var(--bg)' }}>
          <button onClick={doSubmit} disabled={busy}
            style={{ width: '100%', padding: 14, borderRadius: 10, border: 'none', background: '#22c55e', color: '#fff', fontSize: 15, fontWeight: 700, opacity: busy ? 0.5 : 1 }}>
            <Send size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {busy ? '送出中…' : '送出稽核'}
          </button>
        </div>
      )}

      {data.can_approve && !showReject && (
        <div style={{ position: 'sticky', bottom: 0, padding: '12px 0 24px', background: 'var(--bg)', display: 'flex', gap: 8 }}>
          <button onClick={() => setShowReject(true)} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 14, fontWeight: 700 }}>
            <X size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />退回
          </button>
          <button onClick={doApprove} disabled={busy}
            style={{ flex: 2, padding: 12, borderRadius: 10, border: 'none', background: '#22c55e', color: '#fff', fontSize: 14, fontWeight: 700, opacity: busy ? 0.5 : 1 }}>
            <Check size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />核准
          </button>
        </div>
      )}

      {/* 退回 modal */}
      {showReject && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) setShowReject(false) }}>
          <div style={{ width: '100%', maxWidth: 480, padding: 20, background: 'var(--bg)', borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>退回原因 *</div>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="請說明退回理由…" rows={4}
              style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 13 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => { setShowReject(false); setRejectReason('') }}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)' }}>取消</button>
              <button onClick={doReject} disabled={busy || !rejectReason.trim()}
                style={{ flex: 2, padding: 10, borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 700, opacity: (busy || !rejectReason.trim()) ? 0.5 : 1 }}>確定退回</button>
            </div>
          </div>
        </div>
      )}

      {/* 簽名 pad */}
      {signingIdx !== null && (
        <SignaturePad open signerName={draftOnDuty[signingIdx]?.employee_name || ''}
          onClose={() => setSigningIdx(null)}
          onConfirm={async (dataUrl) => {
            const idx = signingIdx
            setSigningIdx(null)
            let url = dataUrl
            try { url = await uploadSignature(dataUrl, Number(id), draftOnDuty[idx]?.employee_id) } catch { /* 上傳失敗先留 dataURL */ }
            const next = draftOnDuty.map((d, i) => i === idx ? { ...d, signature_data_url: url } : d)
            setDraftOnDuty(next); saveDraftOnDuty(next)
          }} />
      )}
    </div>
  )
}

// ─── 評核項目單列（評分制：扣分；加分列往回補分）───
// 多格填寫:一格一項抽查內容,可 +新增 / 刪除;存 remark_list(jsonb 字串陣列)
function MultiRemark({ list, canEdit, onChange }) {
  const arr = Array.isArray(list) ? list : []
  if (!canEdit) {
    const filled = arr.filter(x => (x || '').trim())
    if (!filled.length) return null
    return (
      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {filled.map((x, i) => (
          <div key={i} style={{ fontSize: 12, color: 'var(--t2)', padding: '6px 8px', background: 'var(--glass)', borderRadius: 6 }}>{i + 1}. {x}</div>
        ))}
      </div>
    )
  }
  const display = arr.length ? arr : ['']
  const commit = (next) => onChange(next.length ? next : [''])
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {display.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--t3)', width: 16, textAlign: 'right' }}>{i + 1}.</span>
          <input value={v || ''}
            onChange={e => { const n = [...display]; n[i] = e.target.value; onChange(n) }}
            placeholder={`抽查品項 ${i + 1}（帳面 vs 現場）`}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 12 }} />
          {display.length > 1 && (
            <button type="button" onClick={() => commit(display.filter((_, j) => j !== i))}
              style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--glass)', color: '#ef4444', cursor: 'pointer', fontSize: 15, lineHeight: 1, flexShrink: 0 }}>×</button>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...display, ''])}
        style={{ alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 8, border: '1px dashed #22d3ee', background: 'rgba(34,211,238,0.1)', color: '#22d3ee', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>＋ 新增一格</button>
    </div>
  )
}

function ItemRow({ item, canEdit, maxDeduct, onDeduct, onRemark, onRemarkList }) {
  const isBonus = item.input_type === 'bonus'
  const val = item.deduct_score || 0
  const active = val > 0
  const c = isBonus ? '#22c55e' : '#ef4444'
  const bg = isBonus ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.06)'
  const needRemark = isBonus && val > 0 && !item.remark
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', background: active ? bg : 'transparent', marginLeft: -6, marginRight: -6, paddingLeft: 6, paddingRight: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: 13, lineHeight: 1.5 }}>
          {item.is_star && <Star size={12} style={{ color: '#f59e0b', verticalAlign: 'middle', marginRight: 4 }} fill="#f59e0b" />}
          {item.item_text}
          {item.is_star && <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>可開罰</span>}
        </span>
        {canEdit ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: isBonus ? '#22c55e' : 'var(--t3)' }}>{isBonus ? '加' : '扣'}</span>
            <input type="number" min={0} inputMode="numeric"
              value={val || ''} placeholder="0"
              onChange={e => onDeduct(e.target.value, Math.max(0, maxDeduct))}
              style={{ width: 52, padding: '5px 4px', textAlign: 'center', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--glass)', color: active ? c : 'var(--t1)', fontWeight: active ? 700 : 400, fontSize: 14 }} />
          </div>
        ) : (
          <span style={{
            padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
            background: active ? (isBonus ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'rgba(34,197,94,0.15)',
            color: active ? c : '#22c55e',
          }}>{isBonus ? (active ? `加 ${val}` : '—') : (active ? `扣 ${val}` : '✓')}</span>
        )}
      </div>
      {item.input_type === 'text' && (
        canEdit ? (
          <input value={item.remark || ''} onChange={e => onRemark(e.target.value)}
            placeholder="請填寫抽查 / 內容"
            style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--glass)', color: 'var(--t1)', fontSize: 12, marginTop: 6 }} />
        ) : (
          item.remark && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 4, padding: '6px 8px', background: 'var(--glass)', borderRadius: 6 }}>{item.remark}</div>
        )
      )}
      {item.input_type === 'multi' && (
        <MultiRemark list={item.remark_list} canEdit={canEdit} onChange={onRemarkList} />
      )}
    </div>
  )
}

function Section({ title, subtitle, children }) {
  return (
    <div style={{ marginTop: 16, padding: 12, background: 'var(--glass)', borderRadius: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>{title}</span>
        {subtitle && <span style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 700 }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--t3)' }}>{label}</span>
      <span style={{ color: color || 'var(--t1)', textAlign: 'right', maxWidth: '70%' }}>{value}</span>
    </div>
  )
}
