import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'

// Hub pages
import HRHub from './pages/HRHub'

// HR pages
import ClockPage from './pages/Clock'
import Salary from './pages/Salary'
import Leave from './pages/Leave'
import Tasks from './pages/Tasks'
import TaskNew from './pages/TaskNew'
import Dashboard from './pages/Dashboard'
import Todo from './pages/Todo'
import Expenses from './pages/Expenses'
import RenovationQuotes from './pages/RenovationQuotes'
import Collections from './pages/Collections'
import OffRequest from './pages/OffRequest'
import BusinessTrip from './pages/BusinessTrip'
import LeaveOfAbsence from './pages/LeaveOfAbsence'
import Overtime from './pages/Overtime'
import TransferRequest from './pages/TransferRequest'
import Approve from './pages/Approve'
import TaskConfirmations from './pages/TaskConfirmations'
import ClockCorrection from './pages/ClockCorrection'
import EarlyLeave from './pages/EarlyLeave'
import AttendanceHistory from './pages/AttendanceHistory'
import AttendanceIssues from './pages/AttendanceIssues'
import MySchedule from './pages/MySchedule'
import ApprovalStatus from './pages/ApprovalStatus'
import ExpenseRequest from './pages/ExpenseRequest'
import CustomFormFill from './pages/CustomFormFill'
import RecruitmentHub from './pages/RecruitmentHub'
import RecruitmentCandidate from './pages/RecruitmentCandidate'
import RecruitmentInterview from './pages/RecruitmentInterview'
import RecruitmentInterviewEval from './pages/RecruitmentInterviewEval'
import RecruitmentOffer from './pages/RecruitmentOffer'
import CoverInvitations from './pages/CoverInvitations'
import LeaveBalance from './pages/LeaveBalance'
import Documents from './pages/Documents'
import Benefits from './pages/Benefits'
import Training from './pages/Training'
import TrainingCourse from './pages/TrainingCourse'
import Performance from './pages/Performance'
import RejectReasonPopup from './pages/RejectReasonPopup'
import StoreAudit from './pages/StoreAudit'
import StoreAudits from './pages/StoreAudits'
import StoreAuditNew from './pages/StoreAuditNew'
import Resignation from './pages/Resignation'
import PersonnelTransfer from './pages/PersonnelTransfer'
import StoreRepair from './pages/StoreRepair'
import WorkOrders from './pages/WorkOrders'
import RepairOrders from './pages/RepairOrders'
import Preorders from './pages/Preorders'

// LINE rejects LIFF URIs with sub-paths, so the BOT links us with ?to=/route.
// Other query params (e.g. ?to=/tasks&task=123&filter=all) must be forwarded
// to the target route so BOT deep-links like 「更新任務」can pre-open the right task.
function LiffDeepLinkRedirect() {
  const navigate = useNavigate()
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const to = params.get('to')
    if (!to || !to.startsWith('/')) return
    params.delete('to')
    const rest = params.toString()
    const target = rest ? `${to}${to.includes('?') ? '&' : '?'}${rest}` : to
    navigate(target, { replace: true })
  }, [])
  return null
}

export default function App() {
  const { loading, error, employee, lineProfile } = useAuth()

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div style={{ color: 'var(--t3)', fontSize: 13 }}>載入中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="loading-screen">
        <div style={{ fontSize: 48 }}>😵</div>
        <div style={{ color: 'var(--t2)', fontSize: 14, textAlign: 'center', padding: '0 32px', marginBottom: 16 }}>{error}</div>
        <div style={{ fontSize: 11, color: 'var(--t3)', padding: '8px 16px', background: 'var(--glass)', borderRadius: 8, maxWidth: '80%', wordBreak: 'break-all' }}>
          LIFF ID: {import.meta.env.VITE_LIFF_ID || '(未設定)'}
        </div>
      </div>
    )
  }

  if (!employee) {
    const uid = lineProfile?.lineUserId || ''
    return (
      <div className="loading-screen">
        <div style={{ fontSize: 48 }}>🔗</div>
        <div style={{ color: 'var(--t2)', fontSize: 15, textAlign: 'center', padding: '0 32px', marginBottom: 20, fontWeight: 600 }}>
          尚未綁定員工帳號
        </div>
        <div style={{
          padding: '14px 18px', margin: '0 24px 20px', borderRadius: 12,
          background: 'var(--cyan-dim)', border: '1px solid rgba(34,211,238,0.3)',
          maxWidth: 360,
        }}>
          <div style={{ fontSize: 13, color: 'var(--cyan)', fontWeight: 700, marginBottom: 6 }}>
            🚀 推薦：自助綁定
          </div>
          <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.6 }}>
            回 LINE 對話框傳訊給機器人：<br />
            <code style={{ background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
              /註冊 你的姓名
            </code>
            <br />
            （例：<code>/註冊 張小明</code>），完成後重開此頁。
          </div>
        </div>
        {uid && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--t3)' }}>無法自助？把這串 ID 給管理員：</div>
            <div
              onClick={() => { navigator.clipboard?.writeText(uid); alert('已複製！') }}
              style={{
                padding: '8px 16px', borderRadius: 8,
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--t2)', fontSize: 11,
                fontFamily: 'monospace', wordBreak: 'break-all',
                cursor: 'pointer', textAlign: 'center', maxWidth: 320,
              }}
            >
              {uid}
            </div>
            <div style={{ fontSize: 10, color: 'var(--t3)' }}>點擊複製</div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <LiffDeepLinkRedirect />
      <Routes>
        {/* HR Hub + pages */}
        <Route path="/" element={<HRHub />} />
        <Route path="/clock" element={<ClockPage />} />
        <Route path="/salary" element={<Salary />} />
        <Route path="/leave" element={<Leave />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/new" element={<TaskNew />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/todo" element={<Todo />} />
        <Route path="/expenses" element={<Expenses />} />
        <Route path="/renovation-quotes" element={<RenovationQuotes />} />
        <Route path="/collections" element={<Collections />} />
        <Route path="/off-request" element={<OffRequest />} />
        <Route path="/business-trip" element={<BusinessTrip />} />
        <Route path="/leave-of-absence" element={<LeaveOfAbsence />} />
        <Route path="/overtime" element={<Overtime />} />
        <Route path="/transfer-request" element={<TransferRequest />} />
        <Route path="/approve" element={<Approve />} />
        <Route path="/approve/:tabSlug" element={<Approve />} />
        <Route path="/task-confirmations" element={<TaskConfirmations />} />
        <Route path="/clock-correction" element={<ClockCorrection />} />
        <Route path="/preorders" element={<Preorders />} />
        <Route path="/early-leave" element={<EarlyLeave />} />
        <Route path="/attendance-history" element={<AttendanceHistory />} />
        <Route path="/attendance-issues" element={<AttendanceIssues />} />
        <Route path="/my-schedule" element={<MySchedule />} />
        <Route path="/approval-status" element={<ApprovalStatus />} />
        <Route path="/expense-request" element={<ExpenseRequest />} />
        <Route path="/forms/custom/:templateId" element={<CustomFormFill />} />
        <Route path="/recruitment" element={<RecruitmentHub />} />
        <Route path="/recruitment/candidate/:id" element={<RecruitmentCandidate />} />
        <Route path="/recruitment/interview/:id" element={<RecruitmentInterview />} />
        <Route path="/recruitment/interview/:id/eval" element={<RecruitmentInterviewEval />} />
        <Route path="/recruitment/offer/:id" element={<RecruitmentOffer />} />
        <Route path="/cover-invitations" element={<CoverInvitations />} />
        <Route path="/leave-balance" element={<LeaveBalance />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/benefits" element={<Benefits />} />
        <Route path="/training" element={<Training />} />
        <Route path="/training/course/:id" element={<TrainingCourse />} />
        <Route path="/performance" element={<Performance />} />
        <Route path="/reject-reason" element={<RejectReasonPopup />} />
        <Route path="/store-audit/:id" element={<StoreAudit />} />
        <Route path="/store-audits" element={<StoreAudits />} />
        <Route path="/store-audits/new" element={<StoreAuditNew />} />
        <Route path="/resignation" element={<Resignation />} />
        <Route path="/personnel-transfer" element={<PersonnelTransfer />} />
        <Route path="/store-repair" element={<StoreRepair />} />
        <Route path="/work-orders" element={<WorkOrders />} />
        <Route path="/repair-orders" element={<RepairOrders />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
