import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronDown, Lock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import liff from '@line/liff'

const SS_KEY = 'salary_unlocked'   // 本次 LIFF 開啟期間記住已解鎖

export default function Salary() {
  const { lineProfile } = useAuth()
  const navigate = useNavigate()

  // ── PIN 閘門 ──
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(SS_KEY) === '1')
  const [gateLoading, setGateLoading] = useState(true)
  const [hasPin, setHasPin] = useState(false)
  const [usingDefault, setUsingDefault] = useState(false)
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')          // 設定時的確認欄
  const [pinErr, setPinErr] = useState('')
  const [pinBusy, setPinBusy] = useState(false)

  // ── 薪資資料 ──
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [leaveDeductions, setLeaveDeductions] = useState([])
  const [expenses, setExpenses] = useState([])
  const [payrollRecords, setPayrollRecords] = useState([])
  const [bonusRecords, setBonusRecords] = useState([])   // 門市營運獎金（逐月累計·預覽）
  const [quarterBonuses, setQuarterBonuses] = useState([]) // 季結算（已發放，掛在發放月）
  const [competitions, setCompetitions] = useState([])     // 店長競賽（前三名，掛在發放月）
  const [personalSales, setPersonalSales] = useState([])   // 個人銷售酒款激勵（次月發放）
  const [parttimeIncentives, setParttimeIncentives] = useState([]) // 計時全勤激勵（次月發放）
  const [bag, setBag] = useState(null)          // liff_get_my_salary_detail(引擎明細+微調+發布實領)
  const [bagLoading, setBagLoading] = useState(false)
  const [expandAdd, setExpandAdd] = useState(true)  // 加項預設展開
  const [expandDed, setExpandDed] = useState(true)  // 減項預設展開
  const [pdfBusy, setPdfBusy] = useState(false)     // 下載 PDF 中
  const [pdfLink, setPdfLink] = useState(null)      // 保險:簽名網址,自動跳瀏覽器沒成功時給使用者手動點
  const [org, setOrg] = useState(null)              // 公司信頭:logo/名稱/地址/統編
  const [logoData, setLogoData] = useState(null)    // logo 轉 dataURL(避免 html2canvas CORS 汙染)

  // 選定月份 → 抓引擎完整明細(跟 web 同源;實領以發布版為準)
  useEffect(() => {
    if (!lineProfile?.lineUserId || !unlocked || !selectedMonth) { setBag(null); return }
    let cancelled = false
    setBagLoading(true)
    supabase.rpc('liff_get_my_salary_detail', { p_line_user_id: lineProfile.lineUserId, p_period: selectedMonth })
      .then(({ data }) => { if (!cancelled) { setBag(data?.ok ? data : null); setExpandAdd(true); setExpandDed(true) } })
      .finally(() => { if (!cancelled) setBagLoading(false) })
    return () => { cancelled = true }
  }, [lineProfile, unlocked, selectedMonth])

  // 公司信頭資訊(薪資單 PDF 用)+ logo 先轉 dataURL,產 PDF 時 html2canvas 才不會因跨域汙染 canvas
  useEffect(() => {
    if (!lineProfile?.lineUserId) return
    let cancelled = false
    supabase.rpc('liff_get_org_info', { p_line_user_id: lineProfile.lineUserId }).then(({ data }) => {
      if (cancelled || !data?.ok) return
      setOrg(data)
      if (data.logo_url) {
        fetch(data.logo_url).then(r => r.blob()).then(b => {
          const fr = new FileReader()
          fr.onload = () => { if (!cancelled) setLogoData(fr.result) }
          fr.readAsDataURL(b)
        }).catch(() => {})
      }
    })
    return () => { cancelled = true }
  }, [lineProfile])

  // 閘門：查 has_pin（未解鎖時）
  useEffect(() => {
    if (!lineProfile?.lineUserId || unlocked) { setGateLoading(false); return }
    supabase.rpc('liff_card_my_salary_brief', { p_line_user_id: lineProfile.lineUserId })
      .then(({ data }) => {
        setHasPin(!!data?.has_pin)
        setUsingDefault(!!data?.using_default_pin)
        setGateLoading(false)
      })
  }, [lineProfile, unlocked])

  // 解鎖後才抓薪資資料
  useEffect(() => {
    if (!lineProfile?.lineUserId || !unlocked) return
    Promise.all([
      supabase.rpc('liff_list_my_salary', { p_line_user_id: lineProfile.lineUserId }),
      supabase.rpc('liff_list_leave_requests', { p_line_user_id: lineProfile.lineUserId }),
      supabase.rpc('liff_list_my_expenses', { p_line_user_id: lineProfile.lineUserId }),
      supabase.rpc('liff_get_my_payroll_records', { p_line_user_id: lineProfile.lineUserId, p_limit: 12 }),
      supabase.rpc('liff_get_my_store_bonus', { p_line_user_id: lineProfile.lineUserId, p_limit: 12 }),
    ]).then(([s, l, e, p, b]) => {
      const sal = Array.isArray(s.data) ? s.data : []
      setRecords(sal)
      setLeaveDeductions((Array.isArray(l.data) ? l.data : []).filter(x => x.status === '已核准'))
      setExpenses(Array.isArray(e.data) ? e.data : [])
      if (p.data?.ok) setPayrollRecords(p.data.records || [])
      if (b.data?.ok) { setBonusRecords(b.data.records || []); setQuarterBonuses(b.data.quarters || []); setCompetitions(b.data.competitions || []); setPersonalSales(b.data.personal_sales || []); setParttimeIncentives(b.data.parttime_incentives || []) }
      if (sal.length) setSelectedMonth(sal[0].month)
      setLoading(false)
    })
  }, [lineProfile, unlocked])

  const doUnlock = async () => {
    if (pinBusy) return
    setPinErr(''); setPinBusy(true)
    const { data } = await supabase.rpc('liff_card_my_salary_unlock', {
      p_line_user_id: lineProfile.lineUserId, p_pin: pin,
    })
    setPinBusy(false)
    if (data?.ok) {
      sessionStorage.setItem(SS_KEY, '1'); setUnlocked(true)
    } else {
      setPinErr(data?.error === 'WRONG_PIN' ? '密碼錯誤，請再試一次' : '驗證失敗')
      setPin('')
    }
  }

  const doSetPin = async () => {
    if (pinBusy) return
    if (!/^[0-9]{4,6}$/.test(pin)) { setPinErr('請輸入 4~6 位數字'); return }
    if (pin !== pin2) { setPinErr('兩次輸入不一致'); return }
    setPinErr(''); setPinBusy(true)
    const { data } = await supabase.rpc('liff_card_set_line_pin', {
      p_line_user_id: lineProfile.lineUserId, p_pin: pin,
    })
    setPinBusy(false)
    if (data?.ok) {
      sessionStorage.setItem(SS_KEY, '1'); setUnlocked(true)
    } else {
      setPinErr(data?.error === 'INVALID_PIN_FORMAT' ? '密碼格式錯誤（4~6 位數字）' : '設定失敗')
    }
  }

  // ─────────────────────────── PIN 閘門畫面 ───────────────────────────
  if (!unlocked) {
    return (
      <div className="page">
        <button className="back-btn" onClick={() => navigate('/')}><ChevronLeft size={16} /> 首頁</button>
        <div className="header"><div className="header-title">💰 薪資查詢</div></div>

        {gateLoading ? (
          <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: '32px 22px', marginTop: 8 }}>
            <div style={{
              width: 64, height: 64, borderRadius: 18, margin: '0 auto 16px',
              background: 'rgba(34,211,238,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Lock size={30} style={{ color: 'var(--cyan)' }} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>
              {hasPin ? '輸入薪資密碼' : '設定薪資密碼'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: usingDefault ? 8 : 20, lineHeight: 1.6 }}>
              {hasPin
                ? '薪資為個人機密，請輸入你的 4~6 位密碼解鎖。'
                : '第一次查看，請設定一組 4~6 位數字密碼，之後每次查薪資都要輸入。'}
            </div>
            {usingDefault && (
              <div style={{ fontSize: 12, color: 'var(--cyan)', background: 'rgba(34,211,238,0.08)', borderRadius: 8, padding: '6px 12px', marginBottom: 20 }}>
                預設密碼為身分證末 4 碼
              </div>
            )}

            <input
              type="password" inputMode="numeric" maxLength={6} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="密碼"
              className="form-input"
              style={{ textAlign: 'center', letterSpacing: 8, fontSize: 22, fontWeight: 700, marginBottom: 12 }}
              onKeyDown={e => { if (e.key === 'Enter' && hasPin) doUnlock() }}
            />
            {!hasPin && (
              <input
                type="password" inputMode="numeric" maxLength={6} value={pin2}
                onChange={e => setPin2(e.target.value.replace(/\D/g, ''))}
                placeholder="再次輸入密碼"
                className="form-input"
                style={{ textAlign: 'center', letterSpacing: 8, fontSize: 22, fontWeight: 700, marginBottom: 12 }}
              />
            )}

            {pinErr && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12 }}>{pinErr}</div>}

            <button
              className="btn btn-primary"
              style={{ width: '100%', padding: '12px', fontSize: 15, fontWeight: 700, opacity: pinBusy ? 0.6 : 1 }}
              disabled={pinBusy}
              onClick={hasPin ? doUnlock : doSetPin}
            >
              {pinBusy ? '處理中…' : (hasPin ? '解鎖' : '設定並解鎖')}
            </button>
            {hasPin && !usingDefault && (
              <button
                style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--t3)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
                disabled={pinBusy}
                onClick={async () => {
                  if (!window.confirm('重設後將改用身分證末 4 碼作為密碼，確定嗎？')) return
                  setPinBusy(true)
                  const { data } = await supabase.rpc('liff_reset_my_salary_pin', { p_line_user_id: lineProfile.lineUserId })
                  setPinBusy(false)
                  if (data?.ok) {
                    setUsingDefault(true)
                    setPinErr('已重設！請使用身分證末 4 碼解鎖。')
                  } else {
                    setPinErr(data?.error === 'NO_DEFAULT_PIN' ? '員工資料尚未填身分證號，請聯絡管理員' : '重設失敗，請再試')
                  }
                }}
              >
                忘記密碼？重設為預設（身分證末 4 碼）
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ─────────────────────────── 已解鎖：薪資內容 ───────────────────────────
  const officialRecord = payrollRecords.find(r => r.pay_period === selectedMonth)
  const current = records.find(r => r.month === selectedMonth)
  const monthBonus = bonusRecords.find(b => b.year_month === selectedMonth)
  const monthQuarterBonus = quarterBonuses.find(qb => qb.payout_year_month === selectedMonth)
  const monthCompetition = competitions.find(c => c.payout_year_month === selectedMonth)
  const num = v => Number(v || 0)
  const money = v => `NT$ ${num(v).toLocaleString()}`
  const monthPersonalSales = personalSales.filter(p => p.payout_year_month === selectedMonth)
  const monthPersonalSalesTotal = monthPersonalSales.reduce((s, p) => s + num(p.bonus), 0)
  const monthParttime = parttimeIncentives.find(p => p.payout_year_month === selectedMonth)
  const monthLeaves = leaveDeductions.filter(l => l.start_date?.startsWith(selectedMonth) && ['事假', '病假'].includes(l.type))
  const monthExpenses = expenses.filter(e => e.date?.startsWith(selectedMonth) && e.status === '已核准')
  const expenseTotal = monthExpenses.reduce((s, e) => s + (e.amount || 0), 0)

  // ── 薪資袋:加項/減項(順序 津貼→加班費→其他;顏色對齊 web);實領以發布版為準,殘差吸收 ──
  //   引擎現算對得回發布版 → 用引擎最細明細;對不回(舊月出勤/排班/員工資料事後被改,引擎算不回)
  //   → 改讀發布版當下存的欄位(record,粗但正確、定版不漂)。實領一律以發布版 net 為準。
  const bagItems = (() => {
    if (!bag || (!bag.detail && !bag.record)) return null   // 引擎沒回也沒 record 才放棄;有 record 仍可顯示
    const N = v => Number(v) || 0
    const adjs = bag.adjustments || []
    const net = Math.round(N(bag.published_net))
    // 殘差吸收 + 收尾(讓「本薪+加項−減項 = 實領」)
    const finalize = (base, add, ded) => {
      const gap = net - (base + add.reduce((s, i) => s + i.value, 0) - ded.reduce((s, i) => s + i.value, 0))
      if (gap > 1) add.push({ label: '其他加項', value: gap, color: 'var(--green)' })
      else if (gap < -1) ded.push({ label: '其他減項', value: -gap, color: 'var(--red)' })
      return { base, add, ded, addTotal: base + add.reduce((s, i) => s + i.value, 0), dedTotal: ded.reduce((s, i) => s + i.value, 0), net }
    }
    // ── 引擎現算路徑(與 web SalaryTable 同源逐項) ──
    const eng = (() => {
      const d = bag.detail || {}, add = [], ded = []
      const pA = (label, v, o = {}) => { if (N(v) > 0) add.push({ label, value: Math.round(N(v)), color: o.color || 'var(--green)', note: o.note }) }
      const pD = (label, v, o = {}) => { if (N(v) > 0) ded.push({ label, value: Math.round(N(v)), color: o.color || 'var(--red)', note: o.note }) }
      const base = Math.round(N(d.base_salary))
      ;[['主管加給', d.role_allowance], ['伙食津貼', d.meal_allowance], ['交通津貼', d.transport_allowance], ['夜班津貼', d.night_allowance], ['跨區津貼', d.cross_store_allowance]].forEach(([l, v]) => pA(l, v))
      if (Array.isArray(d.custom_allowances)) d.custom_allowances.forEach(c => { if (N(c.amount) > 0 && !/夜班|夜間|跨店|跨區/.test(c.name || '')) pA(c.name || '自訂津貼', c.amount) })
      ;[['平日加班', N(d.otWeekday) + N(d._ot_exc_weekday), N(d.otPayWeekday) + N(d._ot_exc_weekday_pay)], ['休息日加班', N(d.otRestday) + N(d._ot_exc_restday), N(d.otPayRestday) + N(d._ot_exc_restday_pay)], ['例假加班', N(d.otWeeklyOff) + N(d._ot_exc_weekly_off), N(d.otPayWeeklyOff) + N(d._ot_exc_weekly_off_pay)], ['國定加班', N(d.otHoliday) + N(d._ot_exc_holiday), N(d.otPayHoliday) + N(d._ot_exc_holiday_pay)]].forEach(([l, h, p]) => { if (N(p) > 0 || N(h) > 0) pA(l, p, { color: 'var(--cyan)', note: `${N(h)} 小時` }) })
      if (N(d.comp_time_settled_pay) > 0) pA('補休兌現', d.comp_time_settled_pay, { color: 'var(--cyan)' })
      if (N(d.holidayBonus) > 0) pA('國定假日出勤加給', d.holidayBonus, { color: 'var(--cyan)' })
      pA('全勤獎金', d.attendance_bonus)
      if (N(d.policyBonus) > 0) pA('獎金', d.policyBonus, { color: 'var(--purple)' })
      pA('特休折現', d.unused_leave_payout, { note: N(d.unused_leave_days) ? `${N(d.unused_leave_days)} 天` : undefined })
      pA('資遣費', d.severance_amount)
      pA('預告工資', d.severance_notice_wage)
      const bAdj = adjs.filter(a => a.source_type === 'manual_bonus' || a.source_type === 'manual_backpay')
      const bSum = bAdj.reduce((s, a) => s + N(a.amount), 0)
      if (bSum > 0) pA('微調加項', bSum, { note: bAdj.map(a => a.label).filter(Boolean).join('、') || undefined })
      pD('勞保自付', d.laborInsurance, { color: 'var(--orange)', note: N(d.insuredLabor) ? `投保級距 ${N(d.insuredLabor).toLocaleString()}` : undefined })
      pD('健保自付', d.healthInsurance, { color: 'var(--orange)', note: N(d.insuredHealth) ? `投保級距 ${N(d.insuredHealth).toLocaleString()}` : undefined })
      pD('勞退自提', d.pension, { color: 'var(--orange)' })
      const absR = N(d.absenceDeduction) - N(d.unpaidDeduction) - N(d.halfPayDeduction) - N(d.awolDeduction)
      if (absR > 0) pD('其他缺勤', absR)
      // 無薪/半薪 → 逐假別+日期(取代籠統的「無薪假」「半薪假」;員工看不懂哪筆)
      //   金額用引擎總額(d.unpaidDeduction/d.halfPayDeduction)按各假別時數分攤,末筆吸收餘數 → 加總不變。
      const _md = s => { const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? `${+p[1]}/${+p[2]}` : String(s) }
      const _fmtSpans = (spans) => {
        const parts = spans.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([s, e]) => (e && e !== s) ? `${_md(s)}~${_md(e)}` : _md(s))
        return parts.length <= 3 ? parts.join('、') : `${parts.slice(0, 2).join('、')}…`
      }
      const _leaveBreakdown = (total, typeSet, tag, fb) => {
        if (N(total) <= 0) return
        const grp = {}
        ;(Array.isArray(d._leave_rows) ? d._leave_rows : []).filter(r => typeSet.has(r.type)).forEach(r => {
          const g = grp[r.type] || (grp[r.type] = { days: 0, hours: 0, spans: [] })
          g.days += N(r.days); g.hours += N(r.hours)
          g.spans.push([String(r.date).slice(0, 10), String(r.end_date || r.date).slice(0, 10)])
        })
        const types = Object.keys(grp)
        const th = types.reduce((s, t) => s + grp[t].hours, 0)
        if (!types.length || th <= 0) { pD(fb, total); return }   // 對不到明細 → 退回籠統
        let alloc = 0
        types.forEach((t, i) => {
          const g = grp[t]
          const amt = (i === types.length - 1) ? Math.round(N(total)) - alloc : Math.round(N(total) * g.hours / th)
          alloc += amt
          if (amt > 0) pD(t, amt, { note: `${tag} · ${_fmtSpans(g.spans)}${g.days ? ` · ${g.days}天` : ''}` })
        })
      }
      _leaveBreakdown(d.unpaidDeduction, new Set(['事假', 'personal', '無薪假', 'unpaid', '天災假', '天災', 'disaster']), '無薪', '無薪假')
      _leaveBreakdown(d.halfPayDeduction, new Set(['病假', 'sick', '生理假', 'menstrual']), '半薪', '半薪假')
      if (N(d.awolDeduction) > 0) pD('曠職', d.awolDeduction, { note: (Array.isArray(d._awol_rows) && d._awol_rows.length) ? `${N(d.awolDays)} 天（${d._awol_rows.join('、')}）` : (N(d.awolDays) ? `${N(d.awolDays)} 天` : undefined) })
      if (N(d.lateDeduction) > 0) pD('遲到', d.lateDeduction, { note: N(d.lateMins) ? `${N(d.lateMins)} 分鐘` : undefined })
      if (N(d.earlyLeaveDeduction) > 0) pD('早退', d.earlyLeaveDeduction, { note: N(d.earlyLeaveMinutes) ? `${N(d.earlyLeaveMinutes)} 分鐘` : undefined })
      pD('法定扣款', d.legal_deduction)
      pD('補充保費', d.nhi_supplementary, { color: 'var(--orange)' })
      pD('所得稅', d.incomeTax, { color: 'var(--orange)' })
      const dAdj = adjs.filter(a => a.source_type === 'manual_deduction')
      const dSum = dAdj.reduce((s, a) => s + N(a.amount), 0)
      if (dSum > 0) pD('微調減項', dSum, { note: dAdj.map(a => a.label).filter(Boolean).join('、') || undefined })
      const gap = net - (base + add.reduce((s, i) => s + i.value, 0) - ded.reduce((s, i) => s + i.value, 0))
      return { base, add, ded, gap }
    })()

    // 引擎對得回發布版(殘差在容忍內)→ 用引擎最細明細
    const TOL = Math.max(100, Math.round(net * 0.01))
    if (Math.abs(eng.gap) <= TOL || !bag.record) return finalize(eng.base, eng.add, eng.ded)

    // 引擎對不回(舊月資料漂移)→ 改讀發布版存的欄位(粗但正確、定版不漂)
    const r = bag.record, add = [], ded = []
    const pA = (label, v, o = {}) => { if (N(v) > 0) add.push({ label, value: Math.round(N(v)), color: o.color || 'var(--green)', note: o.note }) }
    const pD = (label, v, o = {}) => { if (N(v) > 0) ded.push({ label, value: Math.round(N(v)), color: o.color || 'var(--red)', note: o.note }) }
    const base = Math.round(N(r.base_salary))
    pA('主管加給', r.role_allowance); pA('伙食津貼', r.meal_allowance); pA('交通津貼', r.transport_allowance)
    if (Array.isArray(r.custom_allowances)) r.custom_allowances.forEach(c => pA(c.name || '自訂津貼', c.amount))
    // r.allowance 是各津貼「合計」欄:只有在沒逐項(舊格式只填合計)時才用,避免與上面逐項重複計
    const itemizedAllow = N(r.role_allowance) + N(r.meal_allowance) + N(r.transport_allowance) + (Array.isArray(r.custom_allowances) ? r.custom_allowances.reduce((s, c) => s + N(c.amount), 0) : 0)
    if (itemizedAllow === 0) pA('津貼', r.allowance)
    pA('加班費', N(r.overtime_pay) || N(r.overtime), { color: 'var(--cyan)' })
    pA('全勤獎金', r.attendance_bonus)
    if (N(r.bonus) > 0) pA('獎金', r.bonus, { color: 'var(--purple)' })
    pA('特休折現', r.unused_leave_payout)
    const bAdj = adjs.filter(a => a.source_type === 'manual_bonus' || a.source_type === 'manual_backpay')
    const bSum = bAdj.reduce((s, a) => s + N(a.amount), 0)
    if (bSum > 0) pA('微調加項', bSum, { note: bAdj.map(a => a.label).filter(Boolean).join('、') || undefined })
    if (N(r.labor_insurance) > 0 || N(r.health_insurance) > 0) {
      pD('勞保自付', r.labor_insurance, { color: 'var(--orange)' })
      pD('健保自付', r.health_insurance, { color: 'var(--orange)' })
    } else pD('勞健保自付', r.insurance, { color: 'var(--orange)' })
    pD('勞退自提', r.pension_self, { color: 'var(--orange)' })
    pD('遲到', r.late_deduction)
    pD('缺勤', r.absence_deduction)
    pD('所得稅', r.income_tax, { color: 'var(--orange)' })
    const dAdj = adjs.filter(a => a.source_type === 'manual_deduction')
    const dSum = dAdj.reduce((s, a) => s + N(a.amount), 0)
    if (dSum > 0) pD('微調減項', dSum, { note: dAdj.map(a => a.label).filter(Boolean).join('、') || undefined })
    return finalize(base, add, ded)
  })()

  // ── 下載 PDF 薪資單:用 bagItems 在畫面外組一張「白底」單據 → html2canvas 截圖 → jsPDF(中文用圖片,不需嵌字型) ──
  const downloadPdf = async () => {
    if (!bagItems || pdfBusy) return
    setPdfBusy(true)
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent || '')
    try {
      const m2 = v => 'NT$ ' + Math.round(Number(v) || 0).toLocaleString()
      const addTotal = (Number(bagItems.base) || 0) + (bagItems.add || []).reduce((s, it) => s + (Number(it.value) || 0), 0)
      const dedTotal = (bagItems.ded || []).reduce((s, it) => s + (Number(it.value) || 0), 0)
      const row = (l, v, c, note) => `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 4px;border-bottom:1px solid #eef2f6;font-size:13.5px"><span style="color:#3a4a5a">${l}${note ? `<span style="color:#9aa7b5;font-size:11px;margin-left:6px;font-weight:400">${note}</span>` : ''}</span><span style="font-weight:700;color:${c};white-space:nowrap">${v}</span></div>`
      const secHead = (t, sub, sc) => `<div style="display:flex;justify-content:space-between;align-items:center;margin:16px 4px 4px"><span style="font-size:12px;font-weight:800;color:#14283c">${t}</span><span style="font-size:12.5px;font-weight:800;color:${sc || '#9aa7b5'}">${sub}</span></div>`
      const orgName = org?.name || '威耀時代股份有限公司'
      const orgLine2 = [org?.tax_id ? `統一編號 ${org.tax_id}` : '', org?.phone ? `TEL ${org.phone}` : ''].filter(Boolean).join('　·　')
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:540px;box-sizing:border-box;background:#ffffff;color:#14283c;padding:32px 30px;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;line-height:1.5'
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:13px;padding-bottom:14px;border-bottom:2.5px solid #14283c">
          ${logoData ? `<img src="${logoData}" style="width:68px;height:68px;object-fit:contain;flex-shrink:0"/>` : ''}
          <div style="min-width:0">
            <div style="font-size:17px;font-weight:900;color:#14283c">${orgName}</div>
            ${org?.address ? `<div style="font-size:10.5px;color:#8a99a8;margin-top:3px;line-height:1.6">${org.address}</div>` : ''}
            ${orgLine2 ? `<div style="font-size:10.5px;color:#8a99a8;line-height:1.6">${orgLine2}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px">
          <div>
            <div style="font-size:10px;color:#9aa7b5;letter-spacing:3px;font-weight:700">SALARY STATEMENT</div>
            <div style="font-size:19px;font-weight:900;color:#14283c;margin-top:2px">薪資明細表</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:18px;font-weight:800;color:#14283c">${current?.employee || ''}</div>
            <div style="font-size:12px;color:#8a99a8;margin-top:2px">${selectedMonth || ''}</div>
          </div>
        </div>
        <div style="background:linear-gradient(135deg,#0e7490,#0891b2);border-radius:14px;padding:16px 20px;margin-top:16px;display:flex;justify-content:space-between;align-items:center;color:#ffffff">
          <span style="font-size:13px;letter-spacing:5px;font-weight:700;opacity:0.94">實 發 薪 資</span>
          <span style="font-size:28px;font-weight:900">${m2(bagItems.net)}</span>
        </div>
        ${secHead('加項', '+' + m2(addTotal), '#059669')}
        ${row('本薪', '+' + m2(bagItems.base), '#059669')}
        ${bagItems.add.map(it => row(it.label, '+' + m2(it.value), '#059669', it.note)).join('')}
        ${secHead('減項', dedTotal > 0 ? '−' + m2(dedTotal) : '無', dedTotal > 0 ? '#dc2626' : '#9aa7b5')}
        ${bagItems.ded.map(it => row(it.label, '−' + m2(it.value), '#dc2626', it.note)).join('') || '<div style="font-size:13px;color:#9aa7b5;padding:8px 4px">無減項</div>'}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;padding:14px 4px;border-top:2px solid #14283c;font-size:16px;font-weight:900;color:#14283c"><span>實領薪資</span><span style="color:#0e7490">${m2(bagItems.net)}</span></div>
        <div style="margin-top:22px;padding-top:12px;border-top:1px solid #edf1f5;display:flex;justify-content:space-between;font-size:10px;color:#aab4c0"><span>本薪資單由系統自動產生</span><span>製表日 ${new Date().toLocaleDateString('zh-TW')}</span></div>
        <div style="text-align:center;font-size:9.5px;color:#c2cbd4;margin-top:6px">※ 本薪資單屬個人機密文件，請妥善保管</div>`
      document.body.appendChild(el)
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
      document.body.removeChild(el)
      const doc = new jsPDF({ unit: 'mm', format: 'a4' })
      const iw = 186, ih = canvas.height * iw / canvas.width
      doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 12, 12, iw, Math.min(ih, 273))
      const fname = `薪資單-${current?.employee || ''}-${selectedMonth || ''}.pdf`
      const blob = doc.output('blob')
      const file = new File([blob], fname, { type: 'application/pdf' })
      // iOS LINE:原生分享面板(可存檔案/轉傳)——iPhone 一直都能用
      if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: fname }); setPdfBusy(false); return }
        catch (e) { if (e?.name === 'AbortError') { setPdfBusy(false); return } /* 失敗→往下退回 */ }
      }
      // Android/其他:Android LINE 擋 blob,必須用真實 https 網址 →
      //   上傳私有桶 payslips(隨機路徑)→ sign-payslip 簽 120 秒短效網址 → 用系統瀏覽器開下載
      const path = `${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2))}.pdf`
      const up = await supabase.storage.from('payslips').upload(path, blob, { contentType: 'application/pdf' })
      if (up.error) throw new Error('上傳失敗：' + up.error.message)
      const { data: sig, error: sigErr } = await supabase.functions.invoke('sign-payslip', { body: { path } })
      if (sigErr || !sig?.url) throw new Error('產生下載連結失敗')
      setPdfLink(sig.url)   // 保險:畫面上也放可點連結,自動跳瀏覽器沒成功也能手動點
      try { liff.openWindow({ url: sig.url, external: true }) }
      catch { window.open(sig.url, '_blank', 'noopener') }
    } catch (e) {
      alert('PDF 下載失敗：' + (e?.message || e))
    }
    setPdfBusy(false)
  }

  return (
    <div className="page">
      <button className="back-btn" onClick={() => navigate('/')}><ChevronLeft size={16} /> 首頁</button>
      <div className="header"><div className="header-title">💰 薪資查詢</div></div>

      {loading ? (
        <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>
      ) : records.length === 0 ? (
        <div className="empty">尚無薪資紀錄</div>
      ) : (
        <>
          {/* 月份選擇 */}
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <select
              className="form-input"
              value={selectedMonth || ''}
              onChange={e => setSelectedMonth(e.target.value)}
              style={{
                width: '100%', padding: '12px 40px 12px 16px', borderRadius: 12,
                fontSize: 15, fontWeight: 700, color: 'var(--cyan)',
                background: 'var(--card)', border: '1.5px solid rgba(34,211,238,0.3)',
                appearance: 'none', cursor: 'pointer',
              }}
            >
              {records.map(r => {
                const [y, m] = r.month.split('-')
                return <option key={r.month} value={r.month}>{y} 年 {parseInt(m)} 月</option>
              })}
            </select>
            <ChevronDown size={18} style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--cyan)', pointerEvents: 'none' }} />
          </div>

          {current && (
            <>
              {/* 💰 薪資袋:實發大數字 + 本薪→加項→扣項→實領(收合) */}
              <div style={{
                background: 'linear-gradient(135deg, rgba(52,211,153,0.12), rgba(34,211,238,0.08))',
                border: '1px solid rgba(52,211,153,0.2)',
                borderRadius: 16, padding: '24px 20px', textAlign: 'center', marginBottom: 16,
              }}>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 6 }}>實發薪資</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--green)' }}>
                  {money(bagItems ? bagItems.net : (officialRecord?.net_salary ?? current.net_salary))}
                </div>
                {bag?.published_at && <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>已發布</div>}
              </div>

              {bagLoading ? (
                <div className="card" style={{ textAlign: 'center', padding: 24 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : bagItems && (
                <div className="card">
                  {/* 本薪 */}
                  <div className="info-row" style={{ fontWeight: 700 }}>
                    <span className="info-label" style={{ color: 'var(--t1)' }}>本薪</span>
                    <span style={{ fontWeight: 700 }}>{money(bagItems.base)}</span>
                  </div>
                  {/* ＋ 加項（點開展細項） */}
                  <div className="info-row" onClick={() => setExpandAdd(v => !v)} style={{ cursor: 'pointer', borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 4 }}>
                    <span className="info-label" style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700 }}>{expandAdd ? '▾' : '▸'} ＋ 加項</span>
                    <span style={{ fontWeight: 700, color: 'var(--green)' }}>+{money(bagItems.addTotal - bagItems.base)}</span>
                  </div>
                  {expandAdd && bagItems.add.map((it, i) => (
                    <div key={'a' + i} className="info-row" style={{ paddingLeft: 18 }}>
                      <span className="info-label" style={{ fontSize: 12 }}>{it.label}{it.note && <span style={{ color: 'var(--t3)', marginLeft: 4, fontSize: 11 }}>{it.note}</span>}</span>
                      <span style={{ fontWeight: 600, color: it.color }}>+{money(it.value)}</span>
                    </div>
                  ))}
                  {/* － 減項（點開展細項） */}
                  <div className="info-row" onClick={() => setExpandDed(v => !v)} style={{ cursor: 'pointer', borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 4 }}>
                    <span className="info-label" style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700 }}>{expandDed ? '▾' : '▸'} － 減項</span>
                    <span style={{ fontWeight: 700, color: 'var(--orange)' }}>−{money(bagItems.dedTotal)}</span>
                  </div>
                  {expandDed && bagItems.ded.map((it, i) => (
                    <div key={'d' + i} className="info-row" style={{ paddingLeft: 18 }}>
                      <span className="info-label" style={{ fontSize: 12 }}>{it.label}{it.note && <span style={{ color: 'var(--t3)', marginLeft: 4, fontSize: 11 }}>{it.note}</span>}</span>
                      <span style={{ fontWeight: 600, color: it.color }}>−{money(it.value)}</span>
                    </div>
                  ))}
                  {/* ＝ 實領（最下面） */}
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>＝ 實領薪資</span>
                    <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--green)' }}>{money(bagItems.net)}</span>
                  </div>
                </div>
              )}
              {bagItems && !bagLoading && (
                <button onClick={downloadPdf} disabled={pdfBusy} style={{
                  width: '100%', marginTop: 4, marginBottom: 4, padding: 13, borderRadius: 13, border: 'none',
                  background: 'linear-gradient(135deg, #0891b2, #06b6d4)', color: '#fff',
                  fontSize: 15, fontWeight: 800, cursor: 'pointer', opacity: pdfBusy ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>📄 {pdfBusy ? '產生中…' : '下載 PDF 薪資單'}</button>
              )}
              {!bagLoading && bagItems && !/iP(hone|ad|od)/.test(navigator.userAgent || '') && (
                <div style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'center', marginTop: 2, lineHeight: 1.5 }}>
                  Android 會用瀏覽器開啟 PDF，即可下載／分享
                </div>
              )}
              {pdfLink && (
                <a href={pdfLink} target="_blank" rel="noreferrer" style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  marginTop: 8, padding: 11, borderRadius: 11, textDecoration: 'none',
                  border: '1.5px solid var(--cyan)', color: 'var(--cyan)', fontWeight: 800, fontSize: 14,
                }}>📥 沒自動開啟？點我開啟 PDF</a>
              )}
              {!bagLoading && !bagItems && (
                <div className="card" style={{ textAlign: 'center', padding: 18, fontSize: 12, color: 'var(--t3)' }}>此月正式薪資明細尚未發布</div>
              )}



              {/* 🏆 營運獎金（逐月累計·預覽，季末才實際發放） */}
              {monthBonus && (
                <div className="card bonus-card">
                  <div className="bonus-h" style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    🍷 營運獎金（本月累計）
                    <span className="bonus-tag mute">預覽·季末發放</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>此為當月累計金額,實際併入該季發放月薪資袋。</div>
                  {[
                    { label: '管理獎金', value: monthBonus.mgmt_bonus, sign: '+' },
                    { label: '業績獎金', value: monthBonus.target_bonus, sign: '+' },
                    { label: '記功獎金', value: monthBonus.merit_bonus, sign: '+' },
                    { label: '前月補發', value: monthBonus.prev_month_supplement, sign: '+' },
                    { label: '稽核扣項', value: monthBonus.audit_deduction, sign: '-', neg: true },
                    { label: '補卡扣項', value: monthBonus.punch_deduction, sign: '-', neg: true },
                  ].filter(r => num(r.value) !== 0).map((r, i) => (
                    <div key={i} className="info-row" style={{ paddingLeft: 12 }}>
                      <span className="info-label">{r.label}</span>
                      <span style={{ fontWeight: 600, color: r.neg ? 'var(--red)' : 'var(--green)' }}>
                        {r.sign}{money(Math.abs(num(r.value)))}
                      </span>
                    </div>
                  ))}
                  {num(monthBonus.custom_adjust) !== 0 && (
                    <div className="info-row" style={{ paddingLeft: 12 }}>
                      <span className="info-label">其他調整</span>
                      <span style={{ fontWeight: 600, color: num(monthBonus.custom_adjust) < 0 ? 'var(--red)' : 'var(--green)' }}>
                        {num(monthBonus.custom_adjust) < 0 ? '-' : '+'}{money(Math.abs(num(monthBonus.custom_adjust)))}
                      </span>
                    </div>
                  )}
                  <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>本月累計</span>
                    <span className="bonus-v" style={{ fontSize: 18, fontWeight: 800 }}>{money(monthBonus.net_bonus)}</span>
                  </div>
                  {monthBonus.notes && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>{monthBonus.notes}</div>}
                </div>
              )}

              {/* 🏆 季營運獎金（已發放，掛在發放月） */}
              {monthQuarterBonus && (
                <div className="card bonus-card hl">
                  <div className="bonus-h" style={{ fontSize: 15, fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    🏆 {monthQuarterBonus.year} {monthQuarterBonus.quarter} 營運獎金
                    <span className="bonus-tag gold">已發放</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>
                    統計月份：{(monthQuarterBonus.months || []).join('、')} 月（{monthQuarterBonus.months_count} 個月累計）
                  </div>
                  {[
                    { label: '管理獎金（季累計）', value: monthQuarterBonus.total_mgmt, sign: '+' },
                    { label: '業績獎金（季累計）', value: monthQuarterBonus.total_target, sign: '+' },
                    { label: '記功獎金（季累計）', value: monthQuarterBonus.total_merit, sign: '+' },
                    { label: '扣款（季累計）', value: monthQuarterBonus.total_deduct, sign: '', neg: true },
                  ].filter(r => num(r.value) !== 0).map((r, i) => (
                    <div key={i} className="info-row" style={{ paddingLeft: 12 }}>
                      <span className="info-label">{r.label}</span>
                      <span style={{ fontWeight: 600, color: num(r.value) < 0 ? 'var(--red)' : 'var(--green)' }}>
                        {num(r.value) < 0 ? '' : '+'}{money(num(r.value))}
                      </span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, fontWeight: 800 }}>本季實發</span>
                    <span className="bonus-v" style={{ fontSize: 22, fontWeight: 800 }}>{money(monthQuarterBonus.total_net)}</span>
                  </div>
                </div>
              )}

              {/* 🏆 店長競賽獎金（前三名，掛在發放月） */}
              {monthCompetition && (
                <div className="card bonus-card hl">
                  <div className="bonus-h" style={{ fontSize: 15, fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    🏅 {monthCompetition.year} {monthCompetition.period} 店長競賽
                    <span className="bonus-tag wine">第 {monthCompetition.rank} 名</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>
                    {monthCompetition.store_name}　業績成長率 {monthCompetition.growth == null ? '—' : (Number(monthCompetition.growth) * 100).toFixed(1) + '%'}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, fontWeight: 800 }}>競賽獎金</span>
                    <span className="bonus-v" style={{ fontSize: 22, fontWeight: 800 }}>{money(monthCompetition.prize)}</span>
                  </div>
                </div>
              )}

              {/* 🍷 個人銷售酒款激勵（次月發放） */}
              {monthPersonalSales.length > 0 && (
                <div className="card bonus-card">
                  <div className="bonus-h" style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    🍇 個人銷售酒款激勵
                    <span className="bonus-tag plum">{monthPersonalSales.length} 筆</span>
                  </div>
                  {monthPersonalSales.map((p, i) => (
                    <div key={i} className="info-row" style={{ paddingLeft: 12 }}>
                      <span className="info-label">{p.sale_date}　成交 {money(p.sale_amount)}</span>
                      <span style={{ fontWeight: 600, color: 'var(--green)' }}>+{money(p.bonus)}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>激勵合計</span>
                    <span className="bonus-v" style={{ fontSize: 18, fontWeight: 800 }}>{money(monthPersonalSalesTotal)}</span>
                  </div>
                </div>
              )}

              {/* ⏱️ 計時全勤激勵（次月發放） */}
              {monthParttime && (
                <div className="card bonus-card">
                  <div className="bonus-h" style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    ⏱️ 計時全勤激勵
                    <span className="bonus-tag plum">{monthParttime.year_month} 全勤</span>
                  </div>
                  <div className="info-row" style={{ paddingLeft: 12 }}>
                    <span className="info-label">核薪工時 {num(monthParttime.paid_hours)}h × 時薪+{num(monthParttime.rate_add)}</span>
                    <span style={{ fontWeight: 600, color: 'var(--green)' }}>+{money(monthParttime.bonus)}</span>
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>全勤激勵</span>
                    <span className="bonus-v" style={{ fontSize: 18, fontWeight: 800 }}>{money(monthParttime.bonus)}</span>
                  </div>
                </div>
              )}

              {/* 📋 請假扣款明細 */}
              {monthLeaves.length > 0 && (
                <div className="card">
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 12 }}>📋 請假扣款明細</div>
                  {monthLeaves.map(l => (
                    <div key={l.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span><span className="badge badge-cyan" style={{ marginRight: 6 }}>{l.type}</span>{l.start_date}</span>
                        <span style={{ color: 'var(--red)', fontWeight: 600 }}>{l.hours ? `${l.hours}h` : `${l.days || 1}天`}</span>
                      </div>
                      {l.reason && <div style={{ fontSize: 11, color: 'var(--t3)' }}>{l.reason}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* 🧾 報帳退款明細 */}
              {monthExpenses.length > 0 && (
                <div className="card">
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 12 }}>🧾 報帳退款明細</div>
                  {monthExpenses.map(e => (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                      <span style={{ color: 'var(--t2)' }}>{e.description || e.category || '報帳'}</span>
                      <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>+{money(e.amount)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 700 }}>
                    <span>合計</span>
                    <span style={{ color: 'var(--cyan)' }}>+{money(expenseTotal)}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
