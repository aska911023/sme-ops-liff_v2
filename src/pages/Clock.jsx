import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { MapPin, Wifi, AlertTriangle, CheckCircle, XCircle, CalendarDays, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import liff from '@line/liff'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

// LIFF 打卡定位失敗時的備援:導去 web 系統員工打卡頁(GPS 用系統瀏覽器較穩)
const SYSTEM_CLOCK_URL = 'https://mywinesweeapp.vercel.app/portal'
const openSystemClock = () => {
  try { liff.openWindow({ url: SYSTEM_CLOCK_URL, external: true }) }
  catch { window.open(SYSTEM_CLOCK_URL, '_blank', 'noreferrer') }
}

const GPS_ACCURACY_THRESHOLD = 200

// 2-mode clock-in tag — 對齊主系統 supabase/functions/clock-in/index.ts VALID_MODES
// （2026-05-28 簡化：normal 鎖 IP/GPS；outing 免位置驗證 + 標籤'外出'。兩者皆不查班表）
const MODE_META = {
  normal: { label: '一般', icon: '🕒', color: 'var(--cyan)',  dim: 'var(--cyan-dim)' },
  outing: { label: '外出', icon: '✈️', color: 'var(--green)', dim: 'var(--green-dim)' },
}

// Haversine formula: distance between two GPS points in meters
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Check if an IP matches a CIDR or exact IP entry
function ipMatchesCIDR(ip, cidr) {
  const trimmed = cidr.trim()
  if (!trimmed) return false
  const ipToNum = (s) => {
    const parts = s.split('.')
    if (parts.length !== 4) return null
    let num = 0
    for (const p of parts) {
      const n = parseInt(p, 10)
      if (isNaN(n) || n < 0 || n > 255) return null
      num = (num << 8) + n
    }
    return num >>> 0
  }
  const ipNum = ipToNum(ip)
  if (ipNum === null) return false
  if (trimmed.includes('/')) {
    const [network, bitsStr] = trimmed.split('/')
    const bits = parseInt(bitsStr, 10)
    if (isNaN(bits) || bits < 0 || bits > 32) return false
    const netNum = ipToNum(network)
    if (netNum === null) return false
    const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0
    return (ipNum & mask) === (netNum & mask)
  }
  return ip === trimmed
}

// Get public IP with retry + backup API
async function fetchPublicIP() {
  const apis = [
    'https://api.ipify.org?format=json',
    'https://api.seeip.org/jsonip',
  ]
  for (const url of apis) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const data = await res.json()
      return data.ip
    } catch { /* try next */ }
  }
  return null
}

// Server-side clock-in via Edge Function
async function serverClockIn(payload) {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  const res = await fetch(`${url}/functions/v1/clock-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = data.reasons ? `${data.error}\n${data.reasons.join('\n')}` : (data.error || '伺服器錯誤')
    throw new Error(msg)
  }
  return data
}

export default function ClockPage() {
  const { employee, lineProfile } = useAuth()
  const navigate = useNavigate()
  const lineUserId = lineProfile?.lineUserId
  const [time, setTime] = useState(new Date())
  const [todayRecord, setTodayRecord] = useState(null)
  const [loading, setLoading] = useState(false)
  const [location, setLocation] = useState(null)
  const [gpsError, setGpsError] = useState('')
  const [stores, setStores] = useState([])  // 跨店打卡支援：候選店陣列（主要店 + additional_stores）
  const [gpsAccuracy, setGpsAccuracy] = useState(null)
  const [gpsWeak, setGpsWeak] = useState(false)
  const [distance, setDistance] = useState(null)
  const [gpsRetrying, setGpsRetrying] = useState(false)     // 距離 151–1800m 時自動重抓一次
  const retriedRef = useRef(false)                          // 同次 mount 只重試 1 次
  const watchdogRef = useRef(null)                          // 定位看門狗 timer（8s 沒結果就解卡）
  const loggedRef = useRef(new Set())                       // 失敗診斷:同原因每次進頁只記一次(不洗版)
  const ctxRef = useRef({})                                 // 給 log 用的最新值(避開 geolocation callback 的 stale closure)
  const [clientIp, setClientIp] = useState(null)
  const [ipError, setIpError] = useState(false)
  const [wifiMatch, setWifiMatch] = useState(null) // null=checking, true/false
  const [msg, setMsg] = useState('')
  const [clockMode, setClockMode] = useState('normal')  // normal | outing (2026-05-28 簡化)

  // today = 台灣日曆日期（顯示用）
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  // workDay = 出勤「工作日」：凌晨 6 點前算前一天（夜班跨午夜）。打卡查詢/按鈕判斷用，
  // 避免跨午夜後 UI 誤顯示「上班」、使用者誤按生出空紀錄。
  const workDay = (() => {
    const d = new Date(Date.now() + 8 * 3600 * 1000)
    if (d.getUTCHours() < 6) d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  })()

  // 打卡失敗診斷 log:分辨「按不允許/定位沒開/逾時/太遠/精度差」寫進後台(clock_attempts)。
  //   同一原因每次進頁只記一次;讀 ctxRef 最新值避開 geolocation callback 的 stale closure。
  const logClockFailure = useCallback(async (reason, extra = {}) => {
    try {
      const c = ctxRef.current
      if (!c.employeeId) return
      if (loggedRef.current.has(reason)) return
      loggedRef.current.add(reason)
      let perm = extra.perm
      if (!perm) {
        try { perm = navigator.permissions?.query ? (await navigator.permissions.query({ name: 'geolocation' })).state : 'unsupported' }
        catch { perm = 'unsupported' }
      }
      await supabase.rpc('liff_log_clock_attempt', {
        p_employee_id: c.employeeId, p_line_user_id: c.lineUserId || null,
        p_action: 'clock_in', p_result: 'failed', p_reason: reason,
        p_geo_code: extra.code ?? null, p_perm_state: perm,
        p_lat: c.location?.lat ?? null, p_lng: c.location?.lng ?? null,
        p_accuracy: c.gpsAccuracy ?? null, p_ip: c.clientIp || null,
        p_distance: extra.distance ?? null, p_store: c.storeName || null,
        p_detail: extra.detail || null, p_client: 'liff',
      })
    } catch { /* log 失敗絕不影響打卡流程 */ }
  }, [])

  // 取一次 GPS — 頁面載入 + 手動「重新定位」按鈕共用。
  // 第一次失敗自動 retry 一次（放寬 timeout + 容忍 60s 快取）避免單次 race。
  // gpsRetrying 當「定位進行中」旗標：卡住時使用者可再按按鈕重觸發。
  const refreshLocation = useCallback(() => {
    if (!navigator.geolocation) { setGpsError('此裝置不支援 GPS'); return }
    retriedRef.current = false   // 允許距離重試 useEffect 再跑一次
    setGpsError('')
    setGpsRetrying(true)
    // 看門狗：不靠瀏覽器 geolocation timeout（LINE/WebView 有時 callback 不回，
    // 會卡在「定位中」永遠不解）。8 秒沒結果就強制解卡，顯示逾時讓使用者可
    // 重按或改外出。背景 getCurrentPosition 仍在跑，之後定到會自動更新。
    if (watchdogRef.current) clearTimeout(watchdogRef.current)
    watchdogRef.current = setTimeout(() => {
      setGpsRetrying(false)
      setGpsError('定位逾時，請按「重新定位」重試，或改用「外出」打卡')
      logClockFailure('timeout', { code: 3, detail: '看門狗 8s 無回應（WebView 卡住或訊號差）' })
    }, 8000)
    const clearWatchdog = () => {
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null }
    }
    const onSuccess = (pos) => {
      clearWatchdog()
      const { latitude, longitude, accuracy } = pos.coords
      setLocation({ lat: latitude, lng: longitude })
      setGpsAccuracy(Math.round(accuracy))
      if (accuracy > GPS_ACCURACY_THRESHOLD) {
        setGpsWeak(true)
        setGpsError(`GPS 精確度不足（${Math.round(accuracy)}m），定位結果僅供參考`)
        logClockFailure('weak_accuracy', { detail: `GPS 精度 ${Math.round(accuracy)}m（門檻 ${GPS_ACCURACY_THRESHOLD}m）` })
      } else {
        setGpsWeak(false)
        setGpsError('')
      }
      setGpsRetrying(false)
    }
    const onFinalError = (err) => {
      clearWatchdog()
      const code = err?.code
      // 錯誤碼分細:1=拒絕權限、2=定位服務關/抓不到、3=逾時
      const msg = code === 1 ? '無法定位：請確認①已「允許」此頁使用定位、②手機「定位服務」已開啟'
                : code === 2 ? '請開啟手機定位服務（抓不到你的位置）'
                : code === 3 ? '定位逾時，請按「重新定位」重試，或改用「外出」打卡'
                : '無法取得定位'
      setGpsError(msg)
      setGpsRetrying(false)
      const reason = code === 1 ? 'permission_denied' : code === 2 ? 'position_unavailable' : code === 3 ? 'timeout' : 'unknown'
      logClockFailure(reason, { code: code ?? null, detail: msg })
    }
    navigator.geolocation.getCurrentPosition(
      onSuccess,
      () => {
        // 第一次失敗 → retry：放寬 timeout + 容忍 60s 快取
        navigator.geolocation.getCurrentPosition(
          onSuccess, onFinalError,
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
        )
      },
      { enableHighAccuracy: true, timeout: 25000 }
    )
  }, [logClockFailure])

  // 離開頁面時清掉看門狗 timer（反覆進出不累積、不對已卸載元件 setState）
  useEffect(() => () => { if (watchdogRef.current) clearTimeout(watchdogRef.current) }, [])

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Load today's record + employee's store GPS
  useEffect(() => {
    if (!employee) return

    // ★ 走 SECURITY DEFINER RPC — anon 直查 attendance_records 會被 RLS silent skip
    //   (policy: employee = current_employee_name()，LIFF anon 沒 auth → 永遠看不到)
    if (lineUserId) {
      supabase
        .rpc('liff_get_today_attendance', { p_line_user_id: lineUserId, p_date: workDay })
        .then(({ data }) => setTodayRecord((data && data[0]) || null))
    }

    // 跨店打卡：拿員工授權的所有候選店（主要店 + additional_stores）
    if (employee.id) {
      supabase
        .rpc('liff_get_stores_for_employee', { p_employee_id: employee.id })
        .then(({ data, error }) => {
          if (error) {
            console.error('[liff_get_stores_for_employee] failed:', error)
            setMsg(`⚠️ 載入門市失敗：${error.message || '請聯絡管理員'}`)
            setStores([])
          } else {
            setStores(Array.isArray(data) ? data : [])
          }
        })
    }

    // Get current GPS — 抽成 refreshLocation（手動重新定位按鈕共用）
    refreshLocation()

    // Get client IP for WiFi check (with retry + backup)
    fetchPublicIP().then(ip => {
      if (ip) {
        setClientIp(ip)
        setIpError(false)
      } else {
        setClientIp(null)
        setIpError(true)
      }
    })
  }, [employee, refreshLocation])

  // 跨店打卡：從候選店清單中挑出「員工現在實際在範圍內」的那家當 store
  // store._matched=true → 真匹配可打卡；_matched=false → 只是 fallback 給距離顯示
  const store = useMemo(() => {
    if (!stores.length) return null

    // Step 1：GPS 範圍內優先
    if (location) {
      for (const s of stores) {
        if (s.lat == null || s.lng == null) continue
        const d = Math.round(getDistance(location.lat, location.lng, s.lat, s.lng))
        const radius = s.clock_radius || 150
        if (d <= radius) return { ...s, _matched: true }
      }
    }

    // Step 2：WiFi 範圍內次之
    if (clientIp) {
      for (const s of stores) {
        if (!s.allowed_wifi?.length) continue
        if (s.allowed_wifi.some(rule => ipMatchesCIDR(clientIp, rule))) return { ...s, _matched: true }
      }
    }

    // Step 3：都不在範圍 → 取最近的（給距離顯示用，canClock 會 false）
    if (location) {
      let nearest = null
      let minDist = Infinity
      for (const s of stores) {
        if (s.lat == null || s.lng == null) continue
        const d = Math.round(getDistance(location.lat, location.lng, s.lat, s.lng))
        if (d < minDist) { minDist = d; nearest = s }
      }
      if (nearest) return { ...nearest, _matched: false }
    }

    // Step 4：沒 GPS 也沒最近店 → 主要店（is_primary=true）作 fallback 顯示
    const fallback = stores.find(s => s.is_primary) || stores[0]
    return fallback ? { ...fallback, _matched: false } : null
  }, [stores, location, clientIp])

  // Calculate distance when both location and store are available
  // + 距離落在 151–1800m 自動重試一次（iPhone 第一筆常吃 cached Wi-Fi 估算位置）
  useEffect(() => {
    if (!location || !store?.lat || !store?.lng) return
    const d = Math.round(getDistance(location.lat, location.lng, store.lat, store.lng))
    setDistance(d)
    // 人不在店:超出範圍且(明顯太遠 or 已重試過)→ 記 log(別在 151–1800m 首測就誤記,等重試定案)
    const _radius = store.clock_radius || 150
    if (d > _radius && (d > 1800 || retriedRef.current) && store._matched !== false && clockMode !== 'outing') {
      logClockFailure('out_of_range', { distance: d, detail: `距 ${store.name} ${d} 公尺（允許 ${_radius}m）` })
    }
    if (d > 150 && d <= 1800 && !retriedRef.current && navigator.geolocation) {
      retriedRef.current = true
      setGpsRetrying(true)
      let safety
      const timer = setTimeout(() => {
        let settled = false
        const done = () => { if (!settled) { settled = true; clearTimeout(safety); setGpsRetrying(false) } }
        // 兜底:LIFF/iOS webview 有時 getCurrentPosition 不回 callback(連 timeout 都不觸發)→
        //   轉圈永遠停不掉「一直重新整理中」。硬限 12s 一定收掉,讓距離結果(如 165m 超範圍)顯示出來。
        safety = setTimeout(done, 12000)
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude, accuracy } = pos.coords
            const newDist = Math.round(getDistance(latitude, longitude, store.lat, store.lng))
            const weak = accuracy > GPS_ACCURACY_THRESHOLD
            setLocation({ lat: latitude, lng: longitude })
            setGpsAccuracy(Math.round(accuracy))
            setDistance(newDist)
            setGpsWeak(weak)
            setGpsError(weak ? `GPS 精確度不足（${Math.round(accuracy)}m），定位結果僅供參考` : '')
            done()
          },
          () => done(),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        )
      }, 1500)
      return () => { clearTimeout(timer); clearTimeout(safety) }
    }
  }, [location, store, clockMode, logClockFailure])

  // Check WiFi IP match (proper CIDR)
  useEffect(() => {
    if (!clientIp || !store?.allowed_wifi?.length) {
      setWifiMatch(null)
      return
    }
    setWifiMatch(store.allowed_wifi.some(rule => ipMatchesCIDR(clientIp, rule)))
  }, [clientIp, store])

  // 保持 log 用的最新值(每次 render 後更新,geolocation callback 讀 ctxRef 才不會拿到舊值)
  useEffect(() => {
    ctxRef.current = { employeeId: employee?.id, lineUserId, storeName: store?.name || null, location, gpsAccuracy, clientIp, distance }
  })

  const radius = store?.clock_radius || 150
  const isInRange = distance !== null && distance <= radius && !gpsWeak
  const hasWifiRule = store?.allowed_wifi?.length > 0
  // Can clock if: GPS in range (and accurate) OR WiFi IP matches. If neither rule is set, allow.
  const gpsOk = (isInRange || !store?.lat) && !gpsWeak
  const wifiOk = !hasWifiRule || wifiMatch === true
  // 外出模式：免位置驗證，直接可打卡（不擋距離/範圍）。
  //   背景仍照抓 GPS，有抓到就把 lat/lng 一起送進紀錄（僅記錄不驗證），
  //   抓不到也照打不卡住。
  const isOuting = clockMode === 'outing'
  // 跨店打卡：store 若是 fallback (_matched=false) 則 canClock 一定 false
  // 真匹配時才走原本 gpsOk / wifiOk 邏輯
  const canClock = isOuting
    ? true
    : (location && store?._matched !== false && (gpsOk || wifiOk))

  // GPS 不穩(精確度差)→ 不鎖按鈕,改走「確定畫面」後照打(後端標 gps_weak、位置僅參考、時間照記)。
  //   只在「一般模式 + GPS 弱 + 一般驗證沒過」時啟用;GPS 良好但超出範圍(真的不在店)仍擋。
  const canClockWeak = !isOuting && gpsWeak && !canClock
  const canPunch = canClock || canClockWeak

  // Determine clock-in location name
  const getLocationName = () => {
    if (gpsOk && store?.name) return store.name
    if (wifiOk && store?.name) return store.name
    return '外部位置'
  }

  const [confirmOut, setConfirmOut] = useState(false)
  const [weakGpsConfirm, setWeakGpsConfirm] = useState(null)  // null | 'in' | 'out' — 待確認的弱GPS打卡
  const [clockOverlay, setClockOverlay] = useState(null)  // null | 'pending' | 'success'

  // 實際送出打卡(關卡都過了才呼叫)
  const doPunch = async (type) => {
    setConfirmOut(false)
    setWeakGpsConfirm(null)
    setLoading(true)
    // ★ 一按即時回饋：先顯示「打卡中」spinner（不等後端往返），成功才切成功動畫。
    //   永遠不會假成功 —— 失敗時 catch 收回 overlay 並報錯。
    if (type === 'in') setClockOverlay('pending')

    try {
      const action = type === 'in' ? 'clock_in' : 'clock_out'
      const data = await serverClockIn({
        employee:     employee.name,
        line_user_id: lineUserId || null,   // LIFF 走 LINE 身份；有帶就跳過 JWT 驗證
        action,
        lat:      location?.lat || null,
        lng:      location?.lng || null,
        accuracy: gpsAccuracy  || null,
        ip:       clientIp     || null,
        clock_mode:   clockMode,
        force_weak_gps: canClockWeak,   // GPS 不穩已確認 → 後端照打、標 gps_weak
      })
      setTodayRecord(data.record)
      const base = type === 'in' ? '上班打卡成功 ✓' : '下班打卡成功 ✓'
      // 後端 reminder 訊息（outing 模式）
      if (data.reminder) {
        setMsg(base)
        setTimeout(() => setMsg('⚠️ ' + data.reminder), 1500)
      } else {
        setMsg(base)
      }
      // 成功 → 把「打卡中」切成成功動畫，1.5 秒後收回
      if (type === 'in') {
        setClockOverlay('success')
        setTimeout(() => setClockOverlay(null), 1500)
      }
      // 成功後重置模式
      setClockMode('normal')
    } catch (e) {
      setClockOverlay(null)  // ★ 打卡失敗 → 收回 overlay + 報錯（不會假成功）
      setMsg('打卡失敗: ' + (e.message || '未知錯誤'))
    }
    setLoading(false)
    // outing 有 reminder 訊息，多顯示一些時間
    const msgDuration = clockMode === 'outing' ? 8000 : 5000
    setTimeout(() => setMsg(''), msgDuration)
  }

  // 從按鈕按下：依序過「弱GPS確認 → 下班確認」兩關,都過才送
  const handleClock = (type) => {
    if (loading || !canPunch) return
    if (canClockWeak && !weakGpsConfirm) { setWeakGpsConfirm(type); return }   // GPS 不穩 → 確定畫面
    if (type === 'out' && !confirmOut) { setConfirmOut(true); return }         // 下班 → 防誤觸
    doPunch(type)
  }
  // 弱 GPS 確定畫面「仍要打卡」→ 下班仍二次確認,上班直接送
  const confirmWeakGps = () => {
    const type = weakGpsConfirm
    setWeakGpsConfirm(null)
    if (type === 'out' && !confirmOut) { setConfirmOut(true); return }
    doPunch(type)
  }

  const clockedIn = !!todayRecord?.clock_in
  const clockedOut = !!todayRecord?.clock_out
  const showModePicker = !clockedOut  // 完成下班後不再讓選

  return (
    <div className="page">
      <div className="header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="header-title">打卡</div>
          <div className="header-sub">{today}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* 🆘 SOS:定位失敗備援 → 導去 web 系統打卡頁 */}
          <button
            type="button"
            onClick={openSystemClock}
            title="定位失敗時改用網頁打卡"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '6px 10px', borderRadius: 8,
              background: 'var(--red)', color: '#fff',
              border: '1px solid var(--red)', fontSize: 12, fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            例外打卡
          </button>
          <button
            onClick={() => navigate('/attendance-history')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '6px 10px', borderRadius: 8,
              background: 'var(--cyan-dim)', color: 'var(--cyan)',
              border: '1px solid var(--cyan)', fontSize: 12, fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <CalendarDays size={12} /> 紀錄
          </button>
        </div>
      </div>

      {/* Clock Display */}
      <div style={{ textAlign: 'center', margin: '20px 0 24px' }}>
        <div className="clock-display">
          {time.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
        </div>
      </div>

      {/* GPS Status Card */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <MapPin size={16} style={{ color: 'var(--cyan)' }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)' }}>GPS 定位狀態</span>
          {/* 重新定位 — 卡在「定位中」時可手動重觸發，任何時候都能按 */}
          <button
            type="button"
            onClick={refreshLocation}
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
              background: 'var(--cyan-dim)', color: 'var(--cyan)',
              border: '1px solid var(--cyan)', cursor: 'pointer',
            }}
          >
            <RefreshCw size={13} style={gpsRetrying ? { animation: 'spin 1s linear infinite' } : undefined} />
            重新定位
          </button>
        </div>

        {isOuting ? (
          // 外出模式：免位置驗證，GPS 僅背景記錄，不擋打卡、不顯示範圍外紅字
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px', borderRadius: 10,
            background: 'var(--green-dim)', border: '1px solid rgba(52,211,153,0.2)',
          }}>
            <CheckCircle size={18} style={{ color: 'var(--green)', flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>外出模式 — 免位置驗證</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                {gpsRetrying ? '定位中，位置僅記錄不影響打卡'
                  : location ? `位置已記錄${distance !== null && store?.lat ? `（距門市 ${distance >= 1000 ? `${(distance / 1000).toFixed(1)}km` : `${distance}m`}）` : ''}`
                  : '未取得位置，仍可直接打卡'}
              </div>
            </div>
          </div>
        ) : gpsError && !gpsRetrying ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: gpsWeak ? 'var(--orange, #fb923c)' : 'var(--red)', fontSize: 13 }}>
            {gpsWeak ? <AlertTriangle size={16} /> : <XCircle size={16} />}
            <span>{gpsError}</span>
          </div>
        ) : !location ? (
          <div style={{ fontSize: 13, color: 'var(--t3)' }}>定位中...</div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)', marginBottom: 8 }}>
              <span>門市：{store?.name || employee?.store || '-'}</span>
              <span>範圍：{radius}m</span>
            </div>

            {distance !== null && store?.lat ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 14px', borderRadius: 10,
                background: isInRange ? 'var(--green-dim)' : 'var(--red-dim)',
                border: `1px solid ${isInRange ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
              }}>
                {isInRange ? (
                  <CheckCircle size={18} style={{ color: 'var(--green)', flexShrink: 0 }} />
                ) : (
                  <AlertTriangle size={18} style={{ color: 'var(--red)', flexShrink: 0 }} />
                )}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: isInRange ? 'var(--green)' : 'var(--red)' }}>
                    {isInRange ? '在打卡範圍內' : '不在打卡範圍內'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                    距離門市 {distance >= 1000 ? `${(distance / 1000).toFixed(1)}km` : `${distance}m`}
                    {!isInRange && ` (需在 ${radius}m 以內，超出 ${distance - radius}m)`}
                    {gpsRetrying && '　· 定位更新中…'}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>
                <CheckCircle size={14} style={{ color: 'var(--green)', verticalAlign: 'middle', marginRight: 4 }} />
                GPS 已取得（門市未設定座標，不限制範圍）
              </div>
            )}
          </>
        )}

        {/* WiFi IP Status */}
        {!isOuting && hasWifiRule && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Wifi size={14} style={{ color: 'var(--cyan)' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)' }}>WiFi 網路驗證</span>
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', borderRadius: 10,
              background: wifiMatch === true ? 'var(--green-dim)' : wifiMatch === false ? 'var(--red-dim)' : 'var(--card)',
              border: `1px solid ${wifiMatch === true ? 'rgba(52,211,153,0.2)' : wifiMatch === false ? 'rgba(248,113,113,0.2)' : 'var(--border)'}`,
            }}>
              {ipError ? (
                <>
                  <AlertTriangle size={18} style={{ color: 'var(--red)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>無法取得網路 IP</div>
                    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>請確認網路連線正常</div>
                  </div>
                </>
              ) : wifiMatch === null ? (
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>偵測中...</span>
              ) : wifiMatch ? (
                <>
                  <CheckCircle size={18} style={{ color: 'var(--green)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>門市 WiFi 已連線</div>
                    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>IP: {clientIp}</div>
                  </div>
                </>
              ) : (
                <>
                  <AlertTriangle size={18} style={{ color: 'var(--red)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>非門市網路</div>
                    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>IP: {clientIp || '無法取得'}（請連接門市 WiFi）</div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4 模式打卡選擇 */}
      {showModePicker && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 10 }}>打卡模式</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 10 }}>
            {Object.entries(MODE_META).map(([key, m]) => {
              const active = clockMode === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setClockMode(key)}
                  style={{
                    padding: '10px 4px', borderRadius: 10, cursor: 'pointer',
                    background: active ? m.dim : 'var(--card)',
                    border: `1px solid ${active ? m.color : 'var(--border)'}`,
                    color: active ? m.color : 'var(--t3)',
                    fontSize: 11, fontWeight: 700,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{m.icon}</span>
                  {m.label}
                </button>
              )
            })}
          </div>

          {/* 模式說明 */}
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            background: MODE_META[clockMode].dim,
            border: `1px solid ${MODE_META[clockMode].color}`,
            fontSize: 12, lineHeight: 1.5, color: 'var(--t2)',
          }}>
            {clockMode === 'normal' && <span>🕒 一般打卡：須在店內網路或 GPS 範圍內。</span>}
            {clockMode === 'outing' && <span style={{ color: 'var(--green)' }}>✈️ 外出打卡：免位置驗證，紀錄標籤為「外出」。</span>}
          </div>
        </div>
      )}

      {/* Clock Button */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 32 }}>
        {!clockedIn ? (
          <button
            className={`clock-btn ${canPunch && clockMode === 'normal' ? 'clock-in' : ''}`}
            onClick={() => handleClock('in')}
            disabled={loading || !canPunch}
            style={!canPunch ? {
              background: 'var(--card)', border: '2px solid var(--border)',
              color: 'var(--t3)', boxShadow: 'none', cursor: 'not-allowed',
              width: 140, height: 140, borderRadius: '50%',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, fontSize: 16, fontWeight: 800,
            } : (clockMode !== 'normal' ? {
              background: MODE_META[clockMode].color, color: '#fff',
              width: 140, height: 140, borderRadius: '50%', border: 'none',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, fontSize: 15, fontWeight: 800, cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
            } : undefined)}
          >
            <span style={{ fontSize: 28 }}>{canPunch ? (clockMode === 'normal' ? '👆' : MODE_META[clockMode].icon) : '📍'}</span>
            {!canPunch ? '範圍外' : (clockMode === 'normal' ? '上班打卡' : `${MODE_META[clockMode].label}上班`)}
          </button>
        ) : !clockedOut ? (
          <button
            className={`clock-btn ${canPunch && clockMode === 'normal' ? 'clock-out' : ''}`}
            onClick={() => handleClock('out')}
            disabled={loading || !canPunch}
            style={!canPunch ? {
              background: 'var(--card)', border: '2px solid var(--border)',
              color: 'var(--t3)', boxShadow: 'none', cursor: 'not-allowed',
              width: 140, height: 140, borderRadius: '50%',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, fontSize: 16, fontWeight: 800,
            } : (clockMode !== 'normal' ? {
              background: MODE_META[clockMode].color, color: '#fff',
              width: 140, height: 140, borderRadius: '50%', border: 'none',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, fontSize: 15, fontWeight: 800, cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
            } : undefined)}
          >
            <span style={{ fontSize: 28 }}>{canPunch ? (clockMode === 'normal' ? '👋' : MODE_META[clockMode].icon) : '📍'}</span>
            {!canPunch ? '範圍外' : (clockMode === 'normal' ? '下班打卡' : `${MODE_META[clockMode].label}下班`)}
          </button>
        ) : (
          <div style={{
            width: 140, height: 140, borderRadius: '50%',
            background: 'var(--green-dim)', border: '2px solid var(--green)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: 28 }}>✅</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)', marginTop: 4 }}>已完成</span>
          </div>
        )}
      </div>

      {/* Message */}
      {msg && (
        <div style={{
          textAlign: 'center', padding: '10px', borderRadius: 10,
          background: msg.includes('失敗') ? 'var(--red-dim)' : 'var(--green-dim)',
          color: msg.includes('失敗') ? 'var(--red)' : 'var(--green)',
          fontSize: 14, fontWeight: 600, marginBottom: 20,
        }}>{msg}</div>
      )}

      {/* Today Record */}
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 12 }}>今日紀錄</div>
        <div className="info-row">
          <span className="info-label">上班打卡</span>
          <span className="info-value" style={{ color: clockedIn ? 'var(--green)' : 'var(--t3)' }}>
            {todayRecord?.clock_in || '--:--'}
          </span>
        </div>
        <div className="info-row">
          <span className="info-label">下班打卡</span>
          <span className="info-value" style={{ color: clockedOut ? 'var(--cyan)' : 'var(--t3)' }}>
            {todayRecord?.clock_out || '--:--'}
          </span>
        </div>
        <div className="info-row">
          <span className="info-label">工時</span>
          <span className="info-value">{(todayRecord?.total_hours > 0 ? todayRecord.total_hours : todayRecord?.hours) > 0 ? `${(todayRecord.total_hours > 0 ? todayRecord.total_hours : todayRecord.hours).toFixed(1)}h` : '-'}</span>
        </div>
        <div className="info-row">
          <span className="info-label">狀態</span>
          <span className={`badge ${todayRecord?.status === '正常' ? 'badge-green' : todayRecord?.status === '遲到' ? 'badge-orange' : todayRecord?.status === '加班' ? 'badge-purple' : todayRecord?.status === '請假' ? 'badge-blue' : todayRecord?.status === '外出' ? 'badge-green' : 'badge-cyan'}`}>
            {todayRecord?.status || '未打卡'}
          </span>
        </div>
        {/* 4 模式 tag — 與主系統 Attendance.jsx 對齊 */}
        {(todayRecord?.clock_in_mode && todayRecord.clock_in_mode !== 'normal') || (todayRecord?.clock_out_mode && todayRecord.clock_out_mode !== 'normal') ? (
          <div className="info-row">
            <span className="info-label">模式</span>
            <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
              {todayRecord.clock_in_mode && todayRecord.clock_in_mode !== 'normal' && MODE_META[todayRecord.clock_in_mode] && (
                <span style={{
                  padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                  background: MODE_META[todayRecord.clock_in_mode].dim,
                  color: MODE_META[todayRecord.clock_in_mode].color,
                }}>
                  上{MODE_META[todayRecord.clock_in_mode].label}
                </span>
              )}
              {todayRecord.clock_out_mode && todayRecord.clock_out_mode !== 'normal'
                && todayRecord.clock_out_mode !== todayRecord.clock_in_mode
                && MODE_META[todayRecord.clock_out_mode] && (
                <span style={{
                  padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                  background: MODE_META[todayRecord.clock_out_mode].dim,
                  color: MODE_META[todayRecord.clock_out_mode].color,
                }}>
                  下{MODE_META[todayRecord.clock_out_mode].label}
                </span>
              )}
            </span>
          </div>
        ) : null}
        {todayRecord?.clock_in_location && (
          <div className="info-row">
            <span className="info-label">打卡地點</span>
            <span className="info-value" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={12} /> {todayRecord.clock_in_location}
            </span>
          </div>
        )}
        {todayRecord?.clock_in_ip && (
          <div className="info-row">
            <span className="info-label">IP 位址</span>
            <span className="info-value" style={{ fontFamily: 'monospace', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Wifi size={12} /> {todayRecord.clock_in_ip}
            </span>
          </div>
        )}
      </div>

      {/* 上班打卡成功 overlay — 顯示 2 秒後自動消失 */}
      {clockOverlay && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 100,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{
            width: 96, height: 96, borderRadius: '50%',
            background: clockOverlay === 'success' ? 'var(--green-dim)' : 'rgba(255,255,255,0.1)',
            border: `3px solid ${clockOverlay === 'success' ? 'var(--green)' : 'rgba(255,255,255,0.3)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {clockOverlay === 'success'
              ? <CheckCircle size={52} style={{ color: 'var(--green)' }} />
              : <div className="spinner" style={{ width: 48, height: 48, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: '#fff' }} />}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#fff' }}>
            {clockOverlay === 'success' ? '上班打卡成功' : '打卡中...'}
          </div>
          {clockOverlay === 'success' && (
            <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.75)', fontWeight: 600 }}>
              {todayRecord?.clock_in || time.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </div>
          )}
        </div>
      )}

      {/* 下班打卡 確認 modal — 防誤觸 */}
      {confirmOut && (
        <div
          onClick={() => setConfirmOut(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 380,
              background: 'var(--bg)', borderRadius: 16, padding: '24px 22px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 8 }}>👋</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>
              確認下班打卡？
            </div>
            <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 6 }}>
              已上班 {todayRecord?.clock_in || '--:--'} → 現在 {time.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--orange)', marginBottom: 18 }}>
              ⚠️ 下班打卡後無法再修改，請確認真的要下班了再按
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setConfirmOut(false)}
                style={{
                  flex: 1, padding: '12px', borderRadius: 10,
                  background: 'var(--card)', color: 'var(--t2)',
                  border: '1px solid var(--border)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                onClick={() => doPunch('out')}
                style={{
                  flex: 1, padding: '12px', borderRadius: 10,
                  background: 'var(--orange)', color: '#fff', border: 'none',
                  fontSize: 14, fontWeight: 700, cursor: 'pointer',
                }}
              >
                確認下班
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GPS 不穩 確定畫面 — 告知後照打(後端標 gps_weak、時間照記) */}
      {weakGpsConfirm && (
        <div
          onClick={() => setWeakGpsConfirm(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 380, background: 'var(--bg)', borderRadius: 16, padding: '24px 22px', textAlign: 'center' }}
          >
            <div style={{ fontSize: 40, marginBottom: 8 }}>📍</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>GPS 定位不穩定</div>
            <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 6 }}>
              目前定位精確度不足{gpsAccuracy ? `（約 ${gpsAccuracy}m）` : ''}，系統無法確認你是否在店內。
            </div>
            <div style={{ fontSize: 12, color: 'var(--orange)', marginBottom: 18 }}>
              仍要打卡的話，<b>打卡時間會照樣記錄</b>，但此筆<b>位置僅供參考</b>，主管可能會再跟你確認。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setWeakGpsConfirm(null)}
                style={{ flex: 1, padding: '12px', borderRadius: 10, background: 'var(--card)', color: 'var(--t2)', border: '1px solid var(--border)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
              >
                取消
              </button>
              <button
                onClick={confirmWeakGps}
                style={{ flex: 1, padding: '12px', borderRadius: 10, background: 'var(--orange)', color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
              >
                仍要打卡
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
