import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Archive,
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  Boxes,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  CloudOff,
  Command,
  Database,
  Eye,
  FileCheck2,
  FileCode2,
  FileText,
  Fingerprint,
  FlaskConical,
  FolderGit2,
  FolderTree,
  GitBranch,
  GitPullRequest,
  History,
  Home,
  Inbox,
  LayoutDashboard,
  KeyRound,
  ListFilter,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Network,
  PackageCheck,
  PanelRightClose,
  Play,
  Plug,
  Plus,
  RadioTower,
  RefreshCw,
  Route,
  Rocket,
  Save,
  Search,
  ServerCog,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  Undo2,
  Webhook,
  Workflow,
  X,
  Zap,
  UserCheck,
  ClipboardCopy,
} from 'lucide-react'
import { activity, intents, reviews, runs, type IntentItem, type ReviewItem } from './data'
import type { AgentRunEvent, AutonomyDecisionInput } from './adapters/contracts'
import { LocalAutonomyDecisionProvider } from './adapters/local-autonomy-provider'
import { LocalOtlpFileExportProvider } from './adapters/local-otlp-file-export-provider'
import { providerCatalog, summarizeProviderCatalog, type ProviderStage } from './provider-catalog'
import { criteriaSyntaxHint, criticalityLabels, inspectStatement, intentTemplates, lintIntentDraft, mentionsCriterion, parseAcceptanceCriteria, splitLines, verificationLabels, type ProductType, type RiskLevel } from './intent-templates'
import type { WorkbenchState } from './store-model'
import { useWorkbench } from './use-workbench'
import { useLocalControlPlane } from './local-control-plane-context'
import type { LocalActor, LocalActorUpdate, LocalAgentRunDetail, LocalAgentRuntimeDescriptor, LocalWorkItem, LocalCodeHostConnection, LocalProject, LocalProjectInput, LocalProjectRole, LocalIdentityMode, LocalChangeProposal, LocalEvidencePackageView, LocalIntentVersion, LocalReviewAssignment, LocalReviewReadiness } from './local-control-plane-client'
import { DEMO_PROJECT_ID } from './local-control-plane-client'
import './styles.css'

type Page = '总览' | 'Intents' | '上下文' | 'Agent Runs' | '评审队列' | '发布' | '评估' | '证据中心' | '追溯' | '策略' | '反馈闭环' | '集成' | '项目' | '团队' | '度量'
type RunItem = (typeof runs)[number]
type EvalTaskItem = { id: string; title: string; kind: string; detail: string; tone: string; derived?: boolean; liveRunId?: string; regressionId?: string; remediationType?: 'intent' | 'regression' }

// Nav counts must come from the local Control Plane. The hardcoded demo numbers that used to live here showed on
// every page without a demo label, which is exactly the kind of unsourced claim this platform exists to prevent.
const navigation: Array<{ group: string; items: Array<{ label: Page; icon: typeof Home; count?: number }> }> = [
  {
    group: '工作区',
    items: [
      { label: '总览', icon: LayoutDashboard },
      { label: 'Intents', icon: CircleDot },
      { label: '上下文', icon: FolderTree },
      { label: 'Agent Runs', icon: Bot },
      { label: '评审队列', icon: Inbox },
      { label: '发布', icon: Rocket },
    ],
  },
  {
    group: '控制面',
    items: [
      { label: '评估', icon: FlaskConical },
      { label: '证据中心', icon: FileCheck2 },
      { label: '追溯', icon: Route },
      { label: '策略', icon: ShieldCheck },
      { label: '反馈闭环', icon: RefreshCw },
      { label: '集成', icon: Plug },
      { label: '项目', icon: FolderGit2 },
      { label: '团队', icon: Users },
      { label: '度量', icon: BarChart3 },
    ],
  },
]

const pageToHash: Record<Page, string> = {
  '总览': 'overview',
  'Intents': 'intents',
  '上下文': 'context',
  'Agent Runs': 'runs',
  '评审队列': 'reviews',
  '发布': 'releases',
  '评估': 'evaluations',
  '证据中心': 'evidence',
  '追溯': 'traceability',
  '策略': 'policies',
  '反馈闭环': 'feedback',
  '集成': 'integrations',
  '项目': 'projects',
  '团队': 'team',
  '度量': 'metrics',
}

const hashToPage = Object.fromEntries(Object.entries(pageToHash).map(([page, hash]) => [hash, page])) as Record<string, Page>

/** A work item as the team refers to it: its number within the project, then its title. */
function workItemLabel<T extends { sequence: number; title: string } | undefined>(item: T): T extends undefined ? string | undefined : string
function workItemLabel(item?: { sequence: number; title: string }) {
  if (!item) return undefined
  return item.sequence ? `#${item.sequence} ${item.title}` : item.title
}

/**
 * A failed run as plain text for whoever diagnoses it: identity, runtime, error, the agent's redacted stderr tail,
 * what it left uncommitted, and the event log. Built only from what the API already returns, so it holds no secret
 * the server did not already redact.
 */
function runDiagnosticReport(detail: LocalAgentRunDetail, workItem: LocalWorkItem | undefined, runtime: LocalAgentRuntimeDescriptor | undefined, projectSlug: string | undefined) {
  const run = detail.agentRun
  const failure = detail.events.find((event) => event.eventType === 'agent_run.failure_diagnostic')?.payload as { stderrTail?: string | null; uncommittedChanges?: string[]; uncommittedPatch?: { path: string; bytes: number } | null } | undefined
  const seconds = run.completedAt ? Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000) : undefined
  const compact = (payload: Record<string, unknown>) => {
    const { stderrTail: _stderr, uncommittedChanges: _changes, uncommittedPatch: _patch, ...rest } = payload
    const text = JSON.stringify(rest)
    return text === '{}' ? '' : ` ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`
  }
  return [
    `# BoundaryX Agent Run 诊断 · ${run.id}`,
    `状态: ${run.status}${run.exitCode === undefined ? '' : ` · exit ${run.exitCode}`}`,
    `Work Item: ${workItemLabel(workItem) ?? run.workItemId} (${run.workItemId}) · Intent ${run.intentVersionId}`,
    `项目: ${projectSlug ?? run.projectId} · base ${run.baseRef}@${run.baseSha.slice(0, 12)} → ${run.branchRef}`,
    `Runtime: ${run.adapterId} · ${run.isolation} · egress ${run.networkEgress}${runtime?.modelProvider || runtime?.model ? ` · 当前模型 ${runtime.modelProvider ?? '?'}/${runtime.model ?? '?'}` : ''}`,
    `时间: ${run.startedAt} → ${run.completedAt ?? '未结束'}${seconds === undefined ? '' : ` (${seconds}s)`}`,
    '',
    '## 错误',
    run.errorMessage ?? '(无错误信息)',
    ...(failure?.stderrTail ? ['', '## Agent stderr 末尾（已脱敏）', failure.stderrTail] : []),
    ...(failure?.uncommittedChanges ? ['', `## 未提交的改动（${failure.uncommittedChanges.length}）`, ...(failure.uncommittedChanges.length ? failure.uncommittedChanges : ['(无)']), ...(failure.uncommittedPatch ? [`补丁已保存: ${failure.uncommittedPatch.path} (${failure.uncommittedPatch.bytes} bytes)`] : [])] : []),
    '',
    `## 事件（${detail.events.length}）`,
    ...detail.events.map((event) => `${event.occurredAt} ${event.eventType}${compact(event.payload)}`),
  ].join('\n')
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard API refused (permissions, non-secure origin): fall back to a selected textarea.
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

function downloadArtifact(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

async function sha256Hex(content: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createEvidencePackage(run: NonNullable<WorkbenchState['liveRun']>) {
  const runtime = run.events.find((event) => event.type === 'runtime_bound')
  return {
    schemaVersion: 'aperture.evidence-package/v0.1',
    generatedAt: new Date().toISOString(),
    run: { id: run.runId, label: run.label, status: run.status, reviewRequired: run.reviewRequired, runGateApproved: run.approved, runGateApprovedBy: run.runGateApprovedBy ?? null, reviewDecision: run.reviewDecision ?? null, reviewDecisionBy: run.reviewDecisionBy ?? null, sessionIntegrity: run.integrityValid ? 'verified' : 'failed', chainHead: run.events.at(-1)?.eventDigest ?? null },
    runtime: runtime ?? null,
    sandboxAttestation: run.events.find((event) => event.type === 'sandbox_attested') ?? null,
    harnessSelection: run.events.find((event) => event.type === 'harness_profile_selected') ?? null,
    workflow: {
      binding: run.events.find((event) => event.type === 'workflow_bound') ?? null,
      activities: run.events.filter((event) => event.type === 'activity_attempt_started' || event.type === 'activity_failed' || event.type === 'activity_retry_scheduled' || event.type === 'activity_completed'),
    },
    policyBundle: run.events.find((event) => event.type === 'policy_bundle_bound') ?? null,
    planning: {
      roadmap: run.events.find((event) => event.type === 'roadmap_created') ?? null,
      sprint: run.events.find((event) => event.type === 'sprint_planned') ?? null,
      executionPlan: run.events.find((event) => event.type === 'plan_created') ?? null,
      updates: run.events.filter((event) => event.type === 'roadmap_updated'),
    },
    workContract: {
      proposed: run.events.find((event) => event.type === 'work_contract_proposed') ?? null,
      review: run.events.find((event) => event.type === 'work_contract_reviewed') ?? null,
    },
    context: {
      requested: run.events.filter((event) => event.type === 'context_requested'),
      consumed: run.events.filter((event) => event.type === 'context_consumed'),
      scopes: run.events.filter((event) => event.type === 'context_scope_created'),
      notes: run.events.filter((event) => event.type === 'context_note_written'),
      resetDecisions: run.events.filter((event) => event.type === 'context_reset_decided'),
      compactions: run.events.filter((event) => event.type === 'context_compacted'),
    },
    policyDecisions: run.events.filter((event) => event.type === 'policy_decided'),
    artifacts: run.events.filter((event) => event.type === 'artifact_created'),
    ciEvidence: run.events.filter((event) => event.type === 'ci_evidence_ingested'),
    usage: run.events.filter((event) => event.type === 'usage_reported'),
    checkpoints: run.events.filter((event) => event.type === 'checkpoint_saved' || event.type === 'checkpoint_restored'),
    evaluationExperiments: run.events.filter((event) => event.type === 'evaluation_experiment_bound'),
    evaluations: run.events.filter((event) => event.type === 'evaluation_completed'),
    evaluationDiagnoses: run.events.filter((event) => event.type === 'evaluation_diagnosed'),
    traceProjection: run.traceProjection ?? null,
    sink: run.evidencePackage ? { uri: run.evidencePackage.uri, digest: run.evidencePackage.digest, finalizedAt: run.evidencePackage.finalizedAt } : null,
    attestation: run.attestation ?? null,
    transcript: run.events,
  }
}

function App() {
  const { notifications: demoNotifications, dismissNotification } = useWorkbench()
  const localControlPlane = useLocalControlPlane()
  // The prototype store's notifications are sample data too, so they stay with the rest of it.
  const notifications = useDemoScope() ? demoNotifications : []
  const [page, setPage] = useState<Page>(() => hashToPage[window.location.hash.replace('#/', '')] ?? '总览')
  const routeMounted = useRef(false)
  const [selectedReview, setSelectedReview] = useState<ReviewItem | null>(null)
  const [selectedRun, setSelectedRun] = useState<RunItem | null>(null)
  const [selectedIntent, setSelectedIntent] = useState<IntentItem | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('aperture.sidebar-collapsed') === 'true')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((current) => !current)
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setNotificationsOpen(false)
        setSelectedReview(null)
        setSelectedRun(null)
        setSelectedIntent(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('aperture.sidebar-collapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    window.history.replaceState(null, '', `#/${pageToHash[page]}`)
    document.title = `${page === '总览' ? '研发态势' : page} · BoundaryX`
    if (routeMounted.current) {
      const main = document.getElementById('main-content')
      main?.focus({ preventScroll: true })
      // Restart the one-shot scan: drop the class, force a reflow, add it back.
      main?.classList.remove('scan'); void main?.offsetWidth; main?.classList.add('scan')
    }
    routeMounted.current = true
  }, [page])

  useEffect(() => {
    const onHashChange = () => {
      const nextPage = hashToPage[window.location.hash.replace('#/', '')]
      if (nextPage) setPage(nextPage)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const title = page === '总览' ? '研发态势' : page

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <Sidebar page={page} onNavigate={(next) => { setPage(next); setSidebarOpen(false) }} open={sidebarOpen} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((current) => !current)} />
      {sidebarOpen && <button className="mobile-overlay" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}

      <main className="main-area" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu size={18} /></button>
            <div className="breadcrumb">
              <span>Control Plane</span><ChevronRight size={14} /><strong>{title}</strong>
            </div>
          </div>
          <div className="topbar-actions">
            <span className={`prototype-pill local-${localControlPlane.status}`}><i />{localControlPlane.status === 'ready' ? `Local · ${localControlPlane.actor?.username}` : localControlPlane.status === 'offline' ? 'Local service offline' : localControlPlane.status === 'setup_required' ? 'Local setup required' : localControlPlane.status === 'unauthenticated' ? 'Local login required' : 'Connecting local service'}</span>
            {localControlPlane.status === 'ready' && localControlPlane.actor && <IdentityBadge actor={localControlPlane.actor} mode={localControlPlane.identityMode} />}
            <button className="search-trigger" onClick={() => setCommandOpen(true)}>
              <Search size={15} /><span>搜索或执行命令</span><kbd>⌘ K</kbd>
            </button>
            <div className="notification-wrap">
              <button className="icon-button notification" onClick={() => setNotificationsOpen((current) => !current)} aria-label={notifications.length > 0 ? `打开通知，${notifications.length} 条需要关注` : '打开通知'} aria-expanded={notificationsOpen}><Bell size={17} />{notifications.length > 0 && <i />}</button>
              {notificationsOpen && <div className="notification-popover"><div><strong>需要关注 · {notifications.length}</strong><button onClick={() => setNotificationsOpen(false)} aria-label="关闭提醒"><X size={14} /></button></div>{notifications.map((notice) => <button className="notice-row" key={notice.id} onClick={() => { setPage(notice.page as Page); dismissNotification(notice.id); setNotificationsOpen(false) }}><span className={notice.tone} /><div><strong>{notice.title}</strong><small>{notice.detail}</small></div><ChevronRight size={14} /></button>)}{notifications.length === 0 && <div className="notice-empty"><CheckCircle2 size={18} /><strong>暂时没有待处理提醒</strong></div>}</div>}
            </div>
            <button className="avatar-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">{localControlPlane.actor?.displayName.split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase() ?? 'LC'}</button>
          </div>
        </header>

        <div className="page-content">
          <LocalControlPlaneAccess />
          {page === '总览' && <Overview onOpenReview={setSelectedReview} onOpenRun={setSelectedRun} onNavigate={setPage} />}
          {page === 'Intents' && <IntentsPage onOpenIntent={setSelectedIntent} />}
          {page === '上下文' && <ContextPage />}
          {page === 'Agent Runs' && <RunsPage onOpenRun={setSelectedRun} />}
          {page === '评审队列' && <ReviewPage onOpenReview={setSelectedReview} />}
          {page === '发布' && <ReleasePage />}
          {page === '评估' && <EvaluationPage />}
          {page === '证据中心' && <EvidencePage />}
          {page === '追溯' && <TraceabilityPage />}
          {page === '策略' && <PolicyPage />}
          {page === '反馈闭环' && <FeedbackPage />}
          {page === '集成' && <IntegrationsPage />}
          {page === '项目' && <ProjectsPage />}
          {page === '团队' && <TeamPage />}
          {page === '度量' && <MetricsPage />}
        </div>
      </main>

      {selectedReview && <ReviewDrawer item={selectedReview} onClose={() => setSelectedReview(null)} />}
      {selectedRun && <RunDrawer run={selectedRun} onClose={() => setSelectedRun(null)} />}
      {selectedIntent && <IntentDrawer intent={selectedIntent} onClose={() => setSelectedIntent(null)} />}
      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={(next) => { setPage(next); setCommandOpen(false) }} />}
    </div>
  )
}

function LocalControlPlaneAccess() {
  const local = useLocalControlPlane()
  const [username, setUsername] = useState('owner')
  const [displayName, setDisplayName] = useState('Local Owner')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string>()
  if (local.status === 'ready') return null
  const submit = async () => {
    setSubmitting(true)
    setFormError(undefined)
    try {
      if (local.status === 'setup_required') await local.setup({ username, displayName, password })
      else await local.login({ username, password })
      setPassword('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }
  if (local.status === 'connecting') return <section className="panel local-access compact"><RefreshCw size={16} className="spin" /><div><strong>连接本地 Control Plane</strong><p>正在检测 SQLite Service 与 Session。</p></div></section>
  if (local.status === 'offline' || local.status === 'error') return <section className="panel local-access offline"><CloudOff size={18} /><div><strong>本地 Control Plane 未运行</strong><p>执行 `npm run server:dev`，Workbench 将通过 `/api` 接入 SQLite。</p>{local.error && <small>{local.error}</small>}</div><button className="secondary-button" onClick={() => window.location.reload()}><RefreshCw size={14} />重试</button></section>
  return <section className="panel local-access"><KeyRound size={20} /><div className="local-access-copy"><strong>{local.status === 'setup_required' ? '初始化本地 Control Plane' : '登录本地 Control Plane'}</strong><p>{local.status === 'setup_required' ? '第一个账号将成为 Owner；身份从服务端 Session 获取。' : local.identityMode === 'team' ? 'Team 模式：密码登录只能查看，审批、合并、授权必须用 GitHub 登录。' : 'Mock Actor 切换已退出 Core，审批身份由 HttpOnly Session 决定。'}</p>{local.status === 'unauthenticated' && local.sessionExpired && <p className="local-run-notice" role="status"><Clock3 size={11} />登录已失效（会话有效期 8 小时，或账号密码已被重置），请重新登录后继续。</p>}{local.status === 'unauthenticated' && local.githubConfigured && <a className="secondary-button github-sign-in" href="/api/auth/github/start"><GitBranch size={14} />使用 GitHub 登录</a>}<IdentityNotice /></div><div className="local-access-form"><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" aria-label="用户名" autoComplete="username" />{local.status === 'setup_required' && <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示名称" aria-label="显示名称" autoComplete="name" />}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 位密码" aria-label="密码" autoComplete={local.status === 'setup_required' ? 'new-password' : 'current-password'} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} /><button className="primary-button" disabled={submitting || password.length < 12} onClick={() => void submit()}>{submitting ? '处理中…' : local.status === 'setup_required' ? '初始化' : '登录'}</button>{formError && <small className="local-form-error" role="alert">{formError}</small>}</div></section>
}

const identityErrorMessages: Record<string, string> = {
  identity_not_bound: '这个 GitHub 账号没有被 Owner 声明给任何成员，或该登录名已被其他 GitHub 账号回收使用。',
  invalid_oauth_state: 'GitHub 登录已过期或被重放，请重新发起。',
  github_exchange_failed: 'GitHub 拒绝了授权码，请重新发起登录。',
  github_unreachable: '无法连接 GitHub，请检查网络后重试。',
  github_user_unavailable: 'GitHub 没有返回用户身份。',
  github_code_missing: 'GitHub 回调缺少授权码，可能是在 GitHub 上取消了授权。',
  actor_disabled: '该成员已被停用。',
  github_oauth_unconfigured: '服务端未配置 GitHub OAuth App。',
}

function IdentityNotice() {
  const local = useLocalControlPlane()
  const notice = local.identityNotice
  if (!notice) return null
  if (notice.tone === 'success') return local.actor?.authMethod === 'github' ? <small className="identity-notice success" role="status">已通过 GitHub 验证：github:{local.actor.identity?.login}</small> : null
  return <small className="identity-notice error" role="alert">GitHub 登录失败：{identityErrorMessages[notice.code] ?? notice.code}</small>
}

/** How much the current session's decisions can be trusted: GitHub-proven, or a local password nobody else vouched for. */
function IdentityBadge({ actor, mode }: { actor: LocalActor; mode: LocalIdentityMode }) {
  const external = actor.authMethod === 'github' && actor.identity?.status === 'verified'
  return <span className={`identity-badge ${external ? 'external' : mode === 'team' ? 'blocked' : 'self-asserted'}`} title={external ? `决策以 github:${actor.identity?.login}（#${actor.identity?.subject}）记入账本` : mode === 'team' ? 'Team 模式下密码 Session 不能做决策，请用 GitHub 登录' : '开发模式：决策记为本地自证身份（self_asserted）'}>{external ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}{external ? `github:${actor.identity?.login}` : mode === 'team' ? '只读 · 需 GitHub 登录' : '本地身份 · 可自证'}</span>
}

function MemberIdentity({ member }: { member: LocalActor }) {
  const local = useLocalControlPlane()
  const [editing, setEditing] = useState(false)
  const [login, setLogin] = useState(member.identity?.expectedLogin ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const identity = member.identity
  const state = !identity ? <span className="identity-state none">未绑定外部身份</span> : identity.status === 'verified' ? <span className="identity-state verified"><ShieldCheck size={12} />已验证 github:{identity.login} · #{identity.subject}</span> : <span className="identity-state declared"><ShieldAlert size={12} />待验证 github:{identity.expectedLogin} · 需本人用 GitHub 登录一次</span>
  const canDeclare = local.actor?.role === 'owner'
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try { await local.declareIdentity(member.id, login); setEditing(false) } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) } finally { setSaving(false) }
  }
  return <div className="member-identity">{state}{canDeclare && !editing && <button className="text-button" onClick={() => setEditing(true)}>{identity ? '重新声明' : '声明 GitHub 账号'}</button>}{editing && <div className="identity-declare"><input value={login} onChange={(event) => setLogin(event.target.value)} placeholder="GitHub 登录名" aria-label={`${member.displayName} 的 GitHub 登录名`} onKeyDown={(event) => { if (event.key === 'Enter' && login) void save() }} /><button className="primary-button" disabled={saving || !login.trim()} onClick={() => void save()}>{saving ? '保存中…' : '声明'}</button><button className="secondary-button" onClick={() => { setEditing(false); setError(undefined) }}>取消</button>{identity?.status === 'verified' && <small>重新声明会撤销已验证的绑定，并让该成员的 GitHub Session 失效。</small>}{error && <small className="local-form-error" role="alert">{error}</small>}</div>}</div>
}

function TrustModePanel() {
  const local = useLocalControlPlane()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  if (!local.actor) return null
  const external = local.actor.authMethod === 'github' && local.actor.identity?.status === 'verified'
  const target: LocalIdentityMode = local.identityMode === 'team' ? 'development' : 'team'
  const verifiedReviewers = local.actors.filter((member) => member.role !== 'developer' && member.identity?.status === 'verified').length
  const switchMode = async () => {
    setSaving(true)
    setError(undefined)
    try { await local.setIdentityMode(target) } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) } finally { setSaving(false) }
  }
  return <section className="panel trust-mode-panel"><div><span className="eyebrow">信任模式</span><h2>{local.identityMode === 'team' ? 'Team · 外部身份' : 'Development · 本地自证'}</h2><p>{local.identityMode === 'team' ? '每一次批准、合并、授权、Override 都必须来自 GitHub 验证过的 Session，账本冻结 github:<login> 与数字 ID。密码 Session 只能查看和评论。' : '密码登录可以做决策，但账本会把这些决策标记为 self_asserted（低保证）。团队协作前请切换到 Team 模式。'}</p><small>{verifiedReviewers} 名可审查成员已验证 GitHub 身份{!local.githubConfigured && ' · 服务端未配置 GitHub OAuth App'}</small>{error && <small className="local-form-error" role="alert">{error}</small>}</div>{local.actor.role === 'owner' && <div className="trust-mode-action"><button className={target === 'team' ? 'primary-button' : 'secondary-button'} disabled={saving || !external} onClick={() => void switchMode()}>{saving ? '切换中…' : target === 'team' ? '切换到 Team 模式' : '回到 Development 模式'}</button>{!external && <small>切换信任模式本身是决策，需要 Owner 用 GitHub 登录。</small>}</div>}</section>
}

const codeHostLabels: Record<LocalProject['codeHost'], string> = { local: '本地 Git', github: 'GitHub' }
const mergeModeLabels: Record<LocalProject['mergeMode'], string> = { control_plane: '平台合并', host_protected: '托管方合并' }
// Display names only: the stored role values, and every permission check on them, stay owner / maintainer / reviewer / developer.
const TEAM_NAME = 'FDU-前沿部署单元'
const projectRoleLabels: Record<LocalActor['role'], string> = { owner: 'FDE-Owner', maintainer: 'FDE-Maintainer', reviewer: 'FDE-Reviewer', developer: 'FDE-Developer' }
const assignableRoleOptions = (['developer', 'reviewer', 'maintainer'] as const).map((value) => <option key={value} value={value}>{projectRoleLabels[value]}</option>)

function projectLocation(project: LocalProject) {
  return project.codeHost === 'github' ? `${project.codeHostConfig.owner ?? '?'}/${project.codeHostConfig.repo ?? '?'}` : project.repositoryPath ?? '未配置仓库'
}

/** Every page below the sidebar shows the current project's work; switching reloads it from the server. */
function ProjectSwitcher({ onManage }: { onManage: () => void }) {
  const local = useLocalControlPlane()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const project = local.currentProject
  if (local.status !== 'ready') return <button className="project-switcher" disabled title="登录后可切换项目"><span className="project-icon">CP</span><span><strong>Control Plane</strong><small>未登录</small></span><ChevronDown size={15} /></button>
  const pick = async (projectId: string) => {
    setOpen(false)
    if (projectId === local.currentProjectId) return
    setSwitching(true)
    try { await local.selectProject(projectId) } finally { setSwitching(false) }
  }
  return <div className="project-switcher-wrap">
    <button className="project-switcher" onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open} disabled={switching}>
      <span className="project-icon">{(project?.slug ?? '—').slice(0, 2).toUpperCase()}</span>
      <span><strong>{project?.name ?? '没有可用项目'}{project?.id === DEMO_PROJECT_ID && <em className="project-demo-tag">演示</em>}</strong><small>{project ? `${codeHostLabels[project.codeHost]} · ${projectRoleLabels[local.currentProjectRole ?? 'developer']}${project.status === 'archived' ? ' · 已归档' : ''}` : '请 Owner 把你加入项目'}</small></span>
      <ChevronDown size={15} />
    </button>
    {open && <div className="project-menu" role="listbox" aria-label="切换项目">
      {local.projects.map((item) => <button key={item.id} role="option" aria-selected={item.id === local.currentProjectId} className={item.id === local.currentProjectId ? 'active' : undefined} onClick={() => void pick(item.id)}>
        <FolderGit2 size={13} /><span><strong>{item.name}{item.id === DEMO_PROJECT_ID && <em className="project-demo-tag">演示</em>}</strong><small>{item.slug} · {codeHostLabels[item.codeHost]} · {projectRoleLabels[local.projectRoles[item.id] ?? 'developer']}{item.status === 'archived' ? ' · 已归档' : ''}</small></span>{item.id === local.currentProjectId && <Check size={13} />}
      </button>)}
      <button className="project-menu-manage" onClick={() => { setOpen(false); onManage() }}><Settings size={13} /><span>{local.actor?.role === 'owner' ? '管理项目与成员' : '查看项目'}</span></button>
    </div>}
  </div>
}

function Sidebar({ page, onNavigate, open, collapsed, onToggle }: { page: Page; onNavigate: (page: Page) => void; open: boolean; collapsed: boolean; onToggle: () => void }) {
  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="brand-row">
        <div className="brand-mark"><Sparkles size={16} /></div>
        <span>BoundaryX<small className="brand-cn">邦界</small></span>
        <button className="icon-button subtle sidebar-collapse" onClick={onToggle} aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} title={collapsed ? '展开侧栏' : '折叠侧栏'}><PanelRightClose size={15} /></button>
      </div>
      <ProjectSwitcher onManage={() => onNavigate('项目')} />
      <nav>
        {navigation.map((section) => (
          <div className="nav-section" key={section.group}>
            <p>{section.group}</p>
            {section.items.map((item) => {
              const Icon = item.icon
              return (
                <button className={`nav-item ${page === item.label ? 'active' : ''}`} key={item.label} onClick={() => onNavigate(item.label)} title={collapsed ? item.label : undefined} aria-current={page === item.label ? 'page' : undefined}>
                  <Icon size={16} /><span>{item.label}</span>{item.count !== undefined && <em>{item.count}</em>}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => onNavigate('集成')} title={collapsed ? '设置与集成' : undefined}><Settings size={16} /><span>设置与集成</span></button>
      </div>
    </aside>
  )
}

/**
 * Whether static sample data may be shown: only in the default project, which has no repository and so no real work
 * to be confused with, and before sign-in, when there is no project at all.
 */
function useDemoScope() {
  const local = useLocalControlPlane()
  return !(local.status === 'ready' && local.actor) || local.currentProjectId === DEMO_PROJECT_ID
}

// Everything below a DemoRegion is static sample data. It used to share cards, check marks and scores with the
// real sections above it, so a reviewer could not tell them apart at a glance; the region now carries its own frame,
// neutralises the "passed" greens, and appears only in the default project, where it is open by default.
function DemoRegion({ title, note, actions, children }: { title: string; note: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const local = useLocalControlPlane()
  const demoScope = useDemoScope()
  const [expanded, setExpanded] = useState<boolean>()
  const bodyId = useId()
  const open = expanded ?? true
  const demoProject = local.projects.find((project) => project.id === DEMO_PROJECT_ID)
  if (!demoScope) return (
    <section className="demo-region demo-region-elsewhere" aria-label={`演示数据：${title}`}>
      <header className="demo-region-bar">
        <span className="demo-region-tag">演示数据</span>
        <div><strong>{title}</strong><p>演示数据只在「{demoProject?.name ?? '默认项目'}」中显示；当前项目只展示真实数据。</p></div>
        {demoProject && <button className="secondary-button" onClick={() => void local.selectProject(DEMO_PROJECT_ID)}>切换到演示项目</button>}
      </header>
    </section>
  )
  return (
    <section className="demo-region" aria-label={`演示数据：${title}`}>
      <header className="demo-region-bar">
        <span className="demo-region-tag">演示数据</span>
        <div><strong>{title}</strong><p>{note}</p></div>
        {open && actions}
        <button className="secondary-button" aria-expanded={open} aria-controls={bodyId} onClick={() => setExpanded(!open)}>{open ? '收起' : '展开演示'}<ChevronDown size={13} className={open ? 'demo-region-chevron open' : 'demo-region-chevron'} /></button>
      </header>
      {open && <div className="demo-region-body" id={bodyId}>{children}</div>}
    </section>
  )
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>
      {action}
    </div>
  )
}

/**
 * The Overview's only job is to answer "what needs a human right now" — so it reads the local Control Plane
 * rather than the demo fixtures. Everything here is a count of real rows; nothing is projected or smoothed.
 */
function LocalOverviewSummary({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const local = useLocalControlPlane()
  if (local.status !== 'ready') return (
    <section className="attention-strip">
      <div className="attention-icon"><ShieldAlert size={17} /></div>
      <div><strong>本地 Control Plane 未连接</strong><span>下面的数字来自演示数据。连接后本区域会显示真实的待决策变更、运行中的 Agent Run 与被阻断的证据。</span></div>
      <button onClick={() => onNavigate('团队')}>去连接<ArrowRight size={15} /></button>
    </section>
  )
  const openProposals = local.changeProposals.filter((proposal) => !['merged', 'closed'].includes(proposal.status))
  const inFlightRuns = local.agentRuns.filter((run) => run.status === 'queued' || run.status === 'running')
  const blocked = local.reviewReadiness.filter((item) => item.status === 'blocked')
  const awaitingDecision = local.changeProposals.filter((proposal) => proposal.status === 'review_ready'
    && proposal.authorActorId !== local.actor?.id
    && !local.reviews.some((review) => review.changeProposalId === proposal.id && review.headSha === proposal.headSha && !review.invalidatedAt && review.decision !== 'commented'))
  const selfAuthored = local.reviewReadiness.filter((item) => item.evidence.at(-1)?.summary.independentTestSignal === false)
  // Same rule as the Intents page: an approver role, and never the author's own Intent.
  const canApproveIntents = ['owner', 'maintainer', 'reviewer'].includes(local.currentProjectRole ?? '')
  const awaitingIntents = canApproveIntents ? local.intentVersions.filter((intent) => intent.status === 'draft' && intent.createdBy !== local.actor?.id) : []
  const attention = awaitingIntents.length + awaitingDecision.length + inFlightRuns.length
  const expansion = local.reviewMetrics.approvalDecisionCount === 0 ? undefined : local.reviewMetrics.evidenceExpandedApprovalCount / local.reviewMetrics.approvalDecisionCount
  return (
    <>
      <section className="attention-strip">
        <div className="attention-icon"><Sparkles size={17} /></div>
        <div>
          <strong>{attention === 0 ? '当前没有等待你的决策' : `${attention} 项等待人工处理`}</strong>
          <span>{awaitingIntents.length ? `${awaitingIntents.length} 个 Intent 等待你批准 · ` : ''}{awaitingDecision.length} 个变更等待独立 Reviewer 决策 · {inFlightRuns.length} 个 Agent Run 在队列或执行中 · {blocked.length} 个提案因证据被阻断{selfAuthored.length ? ` · ${selfAuthored.length} 个提案只有自带测试结论` : ''}</span>
        </div>
        {awaitingIntents.length > 0 && awaitingDecision.length === 0 ? <button onClick={() => onNavigate('Intents')}>去批准 Intent<ArrowRight size={15} /></button> : <button onClick={() => onNavigate('评审队列')}>查看决策队列<ArrowRight size={15} /></button>}
      </section>
      <section className="metric-grid">
        <MetricCard icon={GitPullRequest} label="进行中变更" value={String(openProposals.length)} change={`${local.changeProposals.length} 个提案累计`} tone="blue" />
        <MetricCard icon={Clock3} label="等待人工决策" value={String(local.reviewMetrics.pendingCount)} change={local.reviewMetrics.pendingCount ? `最长 ${formatReviewDuration(local.reviewMetrics.oldestPendingSeconds)}` : '无积压'} tone="amber" />
        <MetricCard icon={FileCheck2} label="证据展开率" value={expansion === undefined ? '无样本' : `${Math.round(expansion * 100)}%`} change={`${local.reviewMetrics.evidenceExpandedApprovalCount}/${local.reviewMetrics.approvalDecisionCount} 次批准`} tone="green" />
        <MetricCard icon={Bot} label="运行中 Agent Run" value={String(inFlightRuns.length)} change={inFlightRuns.length ? `${inFlightRuns.filter((run) => run.status === 'queued').length} 个排队中` : `${local.agentRuns.length} 个历史运行`} tone="violet" />
      </section>
    </>
  )
}

function Overview({ onOpenReview, onOpenRun, onNavigate }: { onOpenReview: (item: ReviewItem) => void; onOpenRun: (run: RunItem) => void; onNavigate: (page: Page) => void }) {
  const { events } = useWorkbench()
  const local = useLocalControlPlane()
  const throughput: [string, number][] = [['三', 3], ['四', 5], ['五', 3], ['六', 6], ['日', 5], ['一', 7], ['二', 4]]
  const today = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
  const eventTone = (kind: string) => kind === 'approval' || kind === 'deployment' ? 'green' : kind === 'review' ? 'blue' : kind === 'evaluation' ? 'amber' : kind === 'intent' ? 'violet' : 'blue'
  return (
    <>
      <PageHeader
        eyebrow={today}
        title={local.status === 'ready' && local.actor ? `${local.actor.displayName} · 今日决策` : '今日决策'}
        description="这里是团队今天需要关注的变更、风险与决策。"
        action={<button className="primary-button" onClick={() => onNavigate('Intents')}><Plus size={16} />新建 Intent</button>}
      />

      <LocalOverviewSummary onNavigate={onNavigate} />

      <DemoRegion title="总览看板" note="以下变更流、吞吐量、评审列表、Run 列表与团队动态仍为静态演示数据；真实状态见上方区域与「评审队列」「Agent Runs」页。">
        <section className="dashboard-grid">
          <div className="panel workflow-panel">
            <PanelHeading title="变更流" subtitle="最近 7 天" action="查看全部" />
            <div className="flow-summary">
              {[
                ['Intent', 8, 'cyan'], ['Context', 4, 'blue'], ['Build', 3, 'violet'], ['Test+Docs', 2, 'amber'], ['Review', 5, 'rose'], ['Ship', 11, 'green'], ['Observe', 2, 'blue'], ['Learn', 3, 'cyan'],
              ].map(([label, value, tone], index, array) => (
                <div className="flow-step" key={String(label)}>
                  <div className={`flow-node ${tone}`}><strong>{value}</strong><span>{label}</span></div>
                  {index < array.length - 1 && <ChevronRight size={16} />}
                </div>
              ))}
            </div>
            <div className="throughput-chart">
              <div className="chart-title"><span>变更吞吐量</span><strong>33</strong><small>完成变更</small></div>
              <div className="bars" role="img" aria-label={`变更吞吐量（样例）：${throughput.map(([day, count]) => `周${day} ${count}`).join('，')}`}>
                {throughput.map(([day, count]) => <i key={day} style={{ height: `${Math.round(count / 7 * 100)}%` }}><b>{count}</b><span>{day}</span></i>)}
              </div>
            </div>
          </div>

          <div className="panel review-panel">
            <PanelHeading title="待你审查" subtitle="按风险和等待时间排序" action="查看队列" onAction={() => onNavigate('评审队列')} />
            <div className="review-list">
              {reviews.slice(0, 3).map((item) => <ReviewRow key={item.id} item={item} onClick={() => onOpenReview(item)} />)}
            </div>
          </div>

          <div className="panel runs-panel">
            <PanelHeading title="Agent Runs" subtitle="当前执行状态" action="运行中心" onAction={() => onNavigate('Agent Runs')} />
            <div className="run-list">
              {runs.slice(0, 3).map((run) => <RunRow key={run.id} run={run} onClick={() => onOpenRun(run)} />)}
            </div>
          </div>

          <div className="panel activity-panel">
            <PanelHeading title="团队动态" subtitle="实时活动" />
            <div className="activity-list">
              {events.slice(0, 2).map((event) => <div className="activity-row" key={event.id}><span className={`mini-avatar ${eventTone(event.kind)}`}>CP</span><div><span>{event.title}</span><strong>{event.detail}</strong></div><time>{event.createdAt}</time></div>)}
              {activity.slice(0, Math.max(3, 5 - events.slice(0, 2).length)).map((item) => (
                <div className="activity-row" key={`${item.target}-${item.time}`}>
                  <span className={`mini-avatar ${item.color}`}>{item.person}</span>
                  <div><span>{item.text}</span><strong>{item.target}</strong></div><time>{item.time}</time>
                </div>
              ))}
            </div>
          </div>
        </section>
      </DemoRegion>
    </>
  )
}

function MetricCard({ icon: Icon, label, value, change, tone }: { icon: typeof Activity; label: string; value: string; change: string; tone: string }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${tone}`}><Icon size={17} /></div>
      <div><span>{label}</span><strong>{value}</strong></div>
      <small className={change.includes('↑') ? 'positive' : ''}>{change}</small>
    </article>
  )
}

function PanelHeading({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) {
  return (
    <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <button onClick={onAction}>{action}<ChevronRight size={14} /></button>}</div>
  )
}

function RiskBadge({ risk }: { risk: ReviewItem['risk'] }) {
  return <span className={`risk-badge ${risk === '高风险' ? 'high' : risk === '中风险' ? 'medium' : 'low'}`}>{risk}</span>
}

function ReviewRow({ item, onClick }: { item: ReviewItem; onClick: () => void }) {
  return (
    <button className="review-row" onClick={onClick}>
      <div className="review-status"><GitPullRequest size={15} /></div>
      <div className="review-copy"><div><strong>{item.title}</strong><RiskBadge risk={item.risk} /></div><span>{item.id} · {item.author} · {item.updated}</span></div>
      <div className="coverage-cell" title="验收标准中已有证据的比例"><div className={`coverage-ring ${item.coverage < 80 ? 'low' : ''}`} style={{ '--coverage': `${item.coverage * 3.6}deg` } as React.CSSProperties}><span>{item.coverage}</span></div><small>证据覆盖 %</small></div>
      <ChevronRight size={16} />
    </button>
  )
}

function RunRow({ run, onClick }: { run: RunItem; onClick: () => void }) {
  return (
    <button className="run-row" onClick={onClick}>
      <div className={`run-icon ${run.tone}`}><Bot size={16} /></div>
      <div className="run-copy"><strong>{run.label}</strong><span>{run.id} · {run.agent}</span><div className="progress-track"><i className={run.tone} style={{ width: `${run.progress}%` }} /></div></div>
      <div className="run-state"><span className={run.tone}>{run.state}</span><small>{run.duration}</small></div>
    </button>
  )
}

const riskLabels: Record<LocalIntentVersion['riskLevel'], string> = { low: '低风险', medium: '中风险', high: '高风险' }

function IntentsPage({ onOpenIntent }: { onOpenIntent: (intent: IntentItem) => void }) {
  const { derivedIntents } = useWorkbench()
  const local = useLocalControlPlane()
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [constraints, setConstraints] = useState('')
  const [criteria, setCriteria] = useState('')
  const [productType, setProductType] = useState<ProductType>('application')
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()
  const [approvingId, setApprovingId] = useState<string>()
  const [approvalError, setApprovalError] = useState<string>()
  const [openWorkItemId, setOpenWorkItemId] = useState<string>()
  const allIntents = useMemo(() => [...derivedIntents, ...intents], [derivedIntents])
  const filtered = useMemo(() => allIntents.filter((item) => `${item.id}${item.title}`.toLowerCase().includes(query.toLowerCase())), [allIntents, query])
  const template = intentTemplates[productType]
  const parsedCriteria = useMemo(() => parseAcceptanceCriteria(criteria), [criteria])
  const draftLint = useMemo(() => lintIntentDraft({ goal, constraints: splitLines(constraints), riskLevel, criteria: parsedCriteria }), [goal, constraints, riskLevel, parsedCriteria])
  const applyTemplate = () => {
    const hasDraft = [goal, constraints, criteria].some((value) => value.trim())
    if (hasDraft && !window.confirm(`套用「${template.label}」模版会覆盖当前的业务目标、约束和验收标准，继续？`)) return
    setGoal(template.goal)
    setConstraints(template.constraints)
    setCriteria(template.criteria)
  }
  const submitBlocked = creating || !title.trim() || !goal.trim() || parsedCriteria.length === 0 || draftLint.blockers.length > 0
  const latestIntentFor = (workItemId: string) => local.intentVersions.filter((intent) => intent.workItemId === workItemId).sort((left, right) => right.version - left.version)[0]
  const actorName = (actorId?: string) => local.actors.find((candidate) => candidate.id === actorId)?.displayName ?? actorId ?? '—'
  const intentStatusLabel = (intent: LocalIntentVersion) => intent.status === 'draft' ? '待批准' : intent.status === 'superseded' ? '已被新版本取代' : intent.approval?.basis === 'low_risk_rule' ? '低风险 · 规则批准' : `已批准 · ${actorName(intent.approval?.actorId)}`
  // Mirrors approveIntentVersion in server/database.ts: the button explains a refusal instead of letting the server reject it.
  const canApproveIntent = (intent: LocalIntentVersion) => Boolean(local.actor && ['owner', 'maintainer', 'reviewer'].includes(local.currentProjectRole ?? '') && intent.createdBy !== local.actor.id)
  const approveIntentTitle = (intent: LocalIntentVersion) => !local.actor || !['owner', 'maintainer', 'reviewer'].includes(local.currentProjectRole ?? '') ? '只有 owner、maintainer 或 reviewer 可以批准 Intent' : intent.createdBy === local.actor.id ? 'Intent 的作者不能批准自己的 Intent，请让另一位成员批准' : `批准内容摘要 ${intent.contentDigest.slice(0, 19)}…；批准后才能启动 Run，修改 Intent 会产生新版本并需要重新批准`
  const approveIntent = async (intentVersionId: string) => {
    setApprovingId(intentVersionId)
    setApprovalError(undefined)
    try {
      await local.approveIntentVersion(intentVersionId, '')
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : String(error))
    } finally {
      setApprovingId(undefined)
    }
  }
  return (
    <>
      <PageHeader title="Intents" description="把业务目标、验收标准和实现约束连接到每一次软件变更。" />
      {local.status === 'ready' && <section className="panel local-core-section">
        <div className="local-core-heading">
          <div><span className="eyebrow">真实数据 · 本地 SQLite</span><h2>创建版本化 Intent</h2><p>开发执行者可以是 Agent；被开发对象明确区分 App 与 Agent System。</p></div>
          <div className="local-core-heading-actions">
            <button className="secondary-button" onClick={applyTemplate}><Sparkles size={15} />套用「{template.label}」模版</button>
            <span>{local.workItems.length} local work items</span>
          </div>
        </div>
        <div className="local-intent-form">
          <label className="local-intent-title"><span>Work Item 标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一句话说清要交付什么" /></label>
          <label className="local-intent-type"><span>被开发对象</span><select value={productType} onChange={(event) => setProductType(event.target.value as ProductType)}><option value="application">开发 App</option><option value="agent_system">开发 Agent System</option></select></label>
          <label className="local-intent-goal"><span>业务目标</span><input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="改完之后系统的可观察行为是什么" /></label>
          <label className="local-intent-risk"><span>风险等级</span><select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as RiskLevel)}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option></select></label>
          <label className="local-intent-constraints"><span>约束 · 每行一条</span><textarea value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder={'Agent 不得做什么\n例：不得删除或弱化既有测试'} /></label>
          <label className="local-intent-criteria"><span>验收标准 · 每行一条</span><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder={`${template.hint}\n${criteriaSyntaxHint}`} /></label>
          {parsedCriteria.length > 0 && <div className="local-criteria-preview">
            <span className="eyebrow">解析结果 · {parsedCriteria.length} 条 · 你声明的验证方式</span>
            <small className="local-criteria-note">标注会进入 Agent prompt 与 Evidence，并在审查时逐条设门禁：关键标准必须有独立证据，[人工] 标准由批准人在审批意见中签署。</small>
            {parsedCriteria.map((criterion, index) => (
              <div className={`local-criteria-row ${criterion.criticality}`} key={`${index}-${criterion.statement}`}>
                <em className={criterion.verificationType}>{criticalityLabels[criterion.criticality]} · {verificationLabels[criterion.verificationType]}验证{criterion.verifiedBy?.length ? ` · 由 ${criterion.verifiedBy.join('、')} 证明` : ''}</em>
                <p>AC-{index + 1} · {criterion.statement || '（这一行只有标注）'}</p>
                {criterion.warnings.length > 0 && <ul>{criterion.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
              </div>
            ))}
          </div>}
          {(draftLint.blockers.length > 0 || draftLint.warnings.length > 0) && <div className="local-intent-lint">
            {draftLint.blockers.map((blocker) => <p className="blocker" key={blocker}><ShieldAlert size={13} />{blocker}</p>)}
            {draftLint.warnings.map((warning) => <p key={warning}><CircleDot size={13} />{warning}</p>)}
          </div>}
          <div className="local-intent-actions">
            <button className="primary-button" disabled={submitBlocked} onClick={() => void (async () => { setCreating(true); setCreateError(undefined); try { await local.createIntentBundle({ title: title.trim(), description: goal.trim(), productType, goal: goal.trim(), constraints: splitLines(constraints), riskLevel, acceptanceCriteria: parsedCriteria.map(({ statement, criticality, verificationType, verifiedBy }) => ({ statement, criticality, verificationType, ...(verifiedBy?.length ? { verifiedBy } : {}) })) }); setTitle(''); setGoal(''); setConstraints(''); setCriteria('') } catch (error) { setCreateError(error instanceof Error ? error.message : String(error)) } finally { setCreating(false) } })()}><Plus size={15} />{creating ? '创建中…' : '创建本地 Intent'}</button>
            <small>提示只是建议，不阻塞提交；红色项会被服务端拒绝，必须改。{riskLevel === 'low' ? '低风险 Intent 创建即按规则批准。' : '中、高风险 Intent 创建后需由另一位成员批准，才能启动 Run。'}</small>
            {createError && <small className="local-form-error" role="alert">{createError}</small>}
          </div>
        </div>
        {approvalError && <p className="local-form-error" role="alert">{approvalError}</p>}
        {local.workItems.length > 0 && <div className="local-work-items">{local.workItems.map((item) => {
          const intent = latestIntentFor(item.id)
          return <article key={item.id} className="local-work-item-row" onClick={() => setOpenWorkItemId(item.id)}><span className={`local-product-type ${item.productType}`}>{item.productType === 'agent_system' ? 'AGENT' : 'APP'}</span><div><button className="local-work-item-open" onClick={(event) => { event.stopPropagation(); setOpenWorkItemId(item.id) }} title="查看 Intent 详情"><strong>{workItemLabel(item)}</strong></button><small>{item.id} · {intent ? `v${intent.version} · ${riskLabels[intent.riskLevel]} · ${intent.contentDigest.slice(7, 19)}` : item.authorityRef}</small></div>{intent && <div className="local-intent-approval"><span className={`local-status ${intent.status}`}>{intentStatusLabel(intent)}</span>{intent.status === 'draft' && <button className="secondary-button" disabled={approvingId === intent.id || !canApproveIntent(intent)} title={approveIntentTitle(intent)} onClick={(event) => { event.stopPropagation(); void approveIntent(intent.id) }}><ShieldCheck size={13} />{approvingId === intent.id ? '批准中' : '批准 Intent'}</button>}</div>}<code>{item.updatedAt.slice(0, 16).replace('T', ' ')}<span className="local-work-item-more">详情<ChevronRight size={13} /></span></code></article>
        })}</div>}
        {openWorkItemId && local.workItems.some((item) => item.id === openWorkItemId) && <LocalIntentDrawer workItemId={openWorkItemId} onClose={() => setOpenWorkItemId(undefined)} approval={{ can: canApproveIntent, title: approveIntentTitle, approvingId, error: approvalError, approve: approveIntent }} />}
      </section>}
      <DemoRegion title="Intent 列表" note="以下列表仍用于展示既有 UI，不作为本地权威状态。">
        <div className="table-toolbar"><div className="inline-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Intent..." aria-label="搜索 Intent" type="search" /></div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><ListFilter size={15} />筛选</button><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><Boxes size={15} />视图</button></div>
        <div className="data-table panel">
          <div className="table-head intent-grid"><span>Intent</span><span>阶段</span><span>风险</span><span>负责人</span><span>验收标准</span><span>更新</span></div>
          {filtered.map((item) => (
            <button className="table-row intent-grid" key={item.id} onClick={() => onOpenIntent(item)}><span className="intent-title"><i /><span><strong>{item.title}</strong><small>{item.id}</small></span></span><span><StageBadge stage={item.stage} /></span><span className={`risk-text risk-${item.risk}`}>{item.risk}</span><span><b className="tiny-avatar">{item.owner}</b></span><span className="criteria-value">{item.criteria}</span><span className="muted">{item.updated}</span></button>
          ))}
        </div>
      </DemoRegion>
    </>
  )
}

function StageBadge({ stage }: { stage: string }) {
  const className = stage.toLowerCase().replace(' ', '-')
  return <span className={`stage-badge ${className}`}><i />{stage}</span>
}

function ContextPage() {
  const { liveRun } = useWorkbench()
  const liveContextReads = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'context_consumed' }> => event.type === 'context_consumed') ?? []
  const liveContextRequests = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'context_requested' }> => event.type === 'context_requested') ?? []
  const liveContextScopes = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'context_scope_created' }> => event.type === 'context_scope_created') ?? []
  const liveContextNotes = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'context_note_written' }> => event.type === 'context_note_written') ?? []
  const liveContextResetDecisions = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'context_reset_decided' }> => event.type === 'context_reset_decided') ?? []
  const liveContextCompactions = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'context_compacted' }> => event.type === 'context_compacted') ?? []
  const latestResetDecision = liveContextResetDecisions.at(-1)
  const latestCompaction = liveContextCompactions.at(-1)
  const hasLiveContext = liveContextReads.length > 0 || liveContextRequests.length > 0 || liveContextScopes.length > 0
  const sources = [
    { icon: FileCode2, title: '仓库代码与规则', meta: '126 files · 482 KB', detail: 'AGENTS.md、架构约束、相关模块与测试', tone: 'violet' },
    { icon: GitPullRequest, title: 'GitHub Issue 与讨论', meta: 'Issue #142 · 18 comments', detail: '需求背景、验收标准和历史决策', tone: 'blue' },
    { icon: Database, title: '团队知识库', meta: '4 documents · 96 KB', detail: '认证规范、运行手册与安全基线', tone: 'cyan' },
    { icon: FileCheck2, title: '历史证据与变更', meta: '3 related changes', detail: '相邻实现、失败评估和审查结论', tone: 'green' },
  ]

  const manifestFiles = [
    { path: 'src/auth/oidc/provider.ts', reason: 'OIDC Provider 核心实现', declared: true, read: true, trust: 'trusted', sensitivity: '内部' },
    { path: 'src/auth/session.ts', reason: '会话创建与撤销逻辑', declared: true, read: true, trust: 'trusted', sensitivity: '内部' },
    { path: 'docs/security/identity-binding.md', reason: '身份绑定安全约束', declared: true, read: true, trust: 'trusted', sensitivity: '受限' },
    { path: 'tests/auth/oidc.test.ts', reason: '既有认证回归测试', declared: true, read: false, trust: 'trusted', sensitivity: '公开' },
    { path: 'config/oauth.internal.yml', reason: 'Agent 执行期间实际读取', declared: false, read: true, trust: 'trusted', sensitivity: '敏感' },
  ]
  const observedPaths = new Set([...liveContextReads.map((event) => event.source), ...liveContextRequests.map((event) => event.source)])
  const manifestPaths = new Set(manifestFiles.map((file) => file.path))
  const files = hasLiveContext ? [
    ...manifestFiles.map((file) => ({
      ...file,
      read: liveContextReads.some((event) => event.source === file.path),
      blocked: liveContextRequests.some((event) => event.source === file.path) && !liveContextReads.some((event) => event.source === file.path),
      reason: observedPaths.has(file.path) ? '来自当前 Run 的上下文事件' : file.reason,
    })),
    ...[...observedPaths].filter((path) => !manifestPaths.has(path)).map((path) => {
      const observedEvent = liveContextReads.find((event) => event.source === path) ?? liveContextRequests.find((event) => event.source === path)
      const sensitivityLabel = observedEvent?.sensitivity === 'public' ? '公开' : observedEvent?.sensitivity === 'restricted' ? '受限' : observedEvent?.sensitivity === 'sensitive' ? '敏感' : '内部'
      return {
      path,
      reason: '当前 Run 动态请求的上下文',
      declared: observedEvent?.declared ?? false,
      read: liveContextReads.some((event) => event.source === path),
      blocked: liveContextRequests.some((event) => event.source === path) && !liveContextReads.some((event) => event.source === path),
      trust: observedEvent?.trust ?? 'mixed',
      sensitivity: sensitivityLabel,
    }}),
  ] : manifestFiles.map((file) => ({ ...file, blocked: false }))
  const blockedCount = files.filter((file) => file.blocked).length
  const undeclaredReadCount = files.filter((file) => !file.declared && file.read).length
  const unusedCount = files.filter((file) => file.declared && !file.read).length
  const contextMatch = hasLiveContext ? Math.max(0, 100 - blockedCount * 4 - undeclaredReadCount * 10 - unusedCount) : 94
  const currentContextTokens = latestCompaction?.afterTokens ?? (hasLiveContext ? liveContextReads.length * 8_000 : 54_200)
  const contextBudgetPercent = Math.min(100, Math.round((currentContextTokens / 80_000) * 100))

  return (
    <>
      <PageHeader
        title="上下文中心"
        description="管理 Agent 被允许知道什么，并对账它实际读取了什么。"
      />
      <DemoRegion title="上下文面板" note="本页的上下文来源、检索质量与预算面板仍为演示数据；真实的“声明 vs 实际读取”对账在「Agent Runs」页每个 Run 的「上下文对账」里。">

        <div className="context-status-grid">
          <article className="context-score panel">
            <div className="context-score-ring"><strong>{contextMatch}</strong><span>%</span></div>
            <div><h2>{blockedCount ? '边界已阻止未声明上下文进入模型' : '声明与实际读取基本一致'}</h2><p>{hasLiveContext ? `${liveContextReads.length} 项已消费，${blockedCount} 项请求被阻断，${unusedCount} 项声明资源未使用。` : '发现 1 个未声明读取，1 个声明文件未使用。'}</p></div>
          </article>
          <article className="context-budget panel">
            <div className="context-budget-head"><span>上下文预算</span><strong>{contextBudgetPercent}%</strong></div>
            <div className="context-budget-track"><i style={{ width: `${contextBudgetPercent}%` }} /></div>
            <div className="context-budget-meta"><span>已使用 {(currentContextTokens / 1_000).toFixed(1)}K tokens</span><span>上限 80K</span></div>
            <p>{latestCompaction ? `最近压缩节省 ${((latestCompaction.beforeTokens - latestCompaction.afterTokens) / 1_000).toFixed(1)}K tokens` : hasLiveContext ? `${liveRun?.runId} · ${liveContextRequests.length + liveContextReads.length} 个访问事件` : '代码 46% · 文档 31% · 历史证据 23%'}</p>
          </article>
          <article className="context-alert panel">
            <div className="context-alert-icon"><Eye size={18} /></div>
            <div><span>{blockedCount ? '策略已执行' : '需要审查'}</span><strong>{blockedCount ? `${blockedCount} 个敏感上下文请求已阻断` : '1 个敏感上下文偏差'}</strong><p>{blockedCount ? '资源内容未进入模型上下文，尝试记录保留用于审计。' : 'Agent 读取了未声明的内部 OAuth 配置。'}</p></div>
            <button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更" aria-label="查看详情（原型控件，未接入）"><ChevronRight size={17} /></button>
          </article>
        </div>

        <section className="context-engineering-strip">
          {[
            { title: 'Just-in-time', detail: '按任务阶段渐进加载，不一次塞入全部资料', icon: Database, tone: 'blue', state: hasLiveContext ? `${liveContextReads.length} consumed` : '启用' },
            { title: 'Compaction', detail: '压缩历史轨迹，同时保留决策与来源指针', icon: RefreshCw, tone: 'violet', state: latestCompaction ? `${(latestCompaction.beforeTokens / 1_000).toFixed(1)}K → ${(latestCompaction.afterTokens / 1_000).toFixed(1)}K` : '等待阈值' },
            { title: 'Adaptive Reset', detail: '根据模型、阶段、反馈与 Token 压力选择继续、压缩或新会话', icon: RefreshCw, tone: 'blue', state: latestResetDecision ? `${latestResetDecision.trigger} → ${latestResetDecision.action}` : '等待策略决策' },
            { title: 'Structured Notes', detail: '把计划、发现和未决问题写入持久笔记', icon: FileText, tone: 'green', state: hasLiveContext ? `${liveContextNotes.length} durable` : '4 notes' },
            { title: 'Sub-agent Isolation', detail: '子 Agent 仅接收其子任务所需上下文', icon: Workflow, tone: 'amber', state: hasLiveContext ? `${liveContextScopes.length} scopes` : '强制' },
          ].map(({ title, detail, icon: Icon, tone, state }) => <article className="context-strategy panel" key={title}><span className={`context-strategy-icon ${tone}`}><Icon size={16} /></span><div><strong>{title}</strong><p>{detail}</p></div><em>{state}</em></article>)}
        </section>

        {hasLiveContext && <section className="context-runtime panel"><div className="context-section-heading"><div><h2>Session Context Operations</h2><p>{liveRun?.runId} · 事件驱动的上下文生命周期</p></div><span className="trace-integrity"><Fingerprint size={14} />digest chained</span></div><div className="context-runtime-grid"><div><span className="context-runtime-label">Worker Scopes</span>{liveContextScopes.map((scope) => <article key={scope.scopeId}><Workflow size={14} /><div><strong>{scope.worker}</strong><small>{scope.allowedSources.join(' · ')}</small></div><em>{(scope.maxTokens / 1_000).toFixed(0)}K</em></article>)}</div><div><span className="context-runtime-label">Structured Notes</span>{liveContextNotes.map((note) => <article key={note.noteRef}><FileText size={14} /><div><strong>{note.category}</strong><small>{note.noteRef}</small></div><em>{note.durable ? 'durable' : 'ephemeral'}</em></article>)}</div><div><span className="context-runtime-label">Compaction</span>{latestCompaction ? <article className="context-compaction"><RefreshCw size={14} /><div><strong>{latestCompaction.strategy}</strong><small>{latestCompaction.preservedNoteRefs.length} notes preserved · {latestCompaction.summaryDigest}</small></div><em>{Math.round((1 - latestCompaction.afterTokens / latestCompaction.beforeTokens) * 100)}% reduced</em></article> : <div className="context-runtime-empty"><Clock3 size={15} /><span>尚未达到压缩阈值</span></div>}</div></div></section>}

        <section className="context-layout">
          <div className="panel context-manifest">
            <div className="context-section-heading">
              <div><h2>Context Manifest</h2><p>INT-142 · Version 3 · 8 分钟前编译</p></div>
              <div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><ListFilter size={15} />筛选</button><button className="icon-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更" aria-label="更多操作（原型控件，未接入）"><MoreHorizontal size={17} /></button></div>
            </div>
            <div className="context-table-head context-file-grid"><span>资源</span><span>声明</span><span>实际读取</span><span>信任</span><span>敏感性</span></div>
            {files.map((file) => (
              <div className={`context-file-row context-file-grid ${!file.declared && file.read ? 'context-drift' : ''}`} key={file.path}>
                <div className="context-file-name"><FileText size={15} /><span><code>{file.path}</code><small>{file.reason}</small></span></div>
                <span className={file.declared ? 'context-yes' : 'context-no'}>{file.declared ? <><Check size={13} />已声明</> : '未声明'}</span>
                <span className={file.blocked ? 'context-no' : file.read ? 'context-yes' : 'context-unused'}>{file.blocked ? <><LockKeyhole size={13} />已阻断</> : file.read ? <><Eye size={13} />已读取</> : '未使用'}</span>
                <span className={`trust-level trust-${file.trust}`}>{file.trust === 'trusted' ? '可信' : file.trust === 'untrusted' ? '未信任' : '混合'}</span>
                <span className={`sensitivity sensitivity-${file.sensitivity}`}>{file.sensitivity}</span>
              </div>
            ))}
          </div>

          <aside className="context-side">
            <div className="panel context-sources">
              <div className="context-section-heading"><div><h2>上下文来源</h2><p>4 类已批准来源</p></div><button className="icon-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更" aria-label="添加上下文来源（原型控件，未接入）"><Plus size={16} /></button></div>
              {sources.map((source) => {
                const Icon = source.icon
                return <button className="context-source-row" key={source.title} disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><span className={`context-source-icon ${source.tone}`}><Icon size={16} /></span><span><strong>{source.title}</strong><small>{source.detail}</small><em>{source.meta}</em></span><ChevronRight size={15} /></button>
              })}
            </div>
            <div className="panel context-rules">
              <div className="context-section-heading"><div><h2>编译规则</h2><p>当前项目策略</p></div></div>
              <div><span>优先相关模块</span><strong>开启</strong></div>
              <div><span>包含历史 Evidence</span><strong>最近 3 次</strong></div>
              <div><span>敏感资源需审批</span><strong>强制</strong></div>
              <div><span>最大上下文预算</span><strong>80K</strong></div>
            </div>
          </aside>
        </section>
      </DemoRegion>
    </>
  )
}

function RunsPage({ onOpenRun }: { onOpenRun: (run: RunItem) => void }) {
  const { liveRun, startMockRun } = useWorkbench()
  const liveDisplayRun: RunItem | null = liveRun ? {
    id: liveRun.runId,
    label: liveRun.label,
    agent: 'Mock Agent Adapter',
    state: liveRun.status,
    progress: liveRun.progress,
    duration: liveRun.progress === 100 ? 'completed' : 'live',
    tone: !liveRun.integrityValid ? 'rose' : liveRun.progress === 100 ? liveRun.reviewRequired && !liveRun.approved ? 'amber' : 'green' : liveRun.progress >= 80 ? 'amber' : 'violet',
  } : null
  const displayedRuns = [
    ...(liveDisplayRun ? [liveDisplayRun] : []),
    ...runs,
    { id: 'RUN-8808', label: '审查队列领域标签', agent: 'Claude Code', state: '已完成', progress: 100, duration: '14m 32s', tone: 'green' },
    { id: 'RUN-8804', label: 'SARIF 聚合器', agent: 'Codex', state: '等待审批', progress: 62, duration: '21m 09s', tone: 'amber' },
  ]
  const lastLiveEvent = liveRun?.events.at(-1)
  const runtimeBinding = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'runtime_bound' }> => event.type === 'runtime_bound')
  const sandboxAttestation = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'sandbox_attested' }> => event.type === 'sandbox_attested')
  const harnessSelection = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'harness_profile_selected' }> => event.type === 'harness_profile_selected')
  const workflowBinding = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'workflow_bound' }> => event.type === 'workflow_bound')
  const workflowRetries = liveRun?.events.filter((event) => event.type === 'activity_retry_scheduled').length ?? 0
  const checkpointCount = liveRun?.events.filter((event) => event.type === 'checkpoint_saved').length ?? 0

  return (
    <>
      <PageHeader title="Agent Runs" description="观察 Agent 的上下文、权限、执行过程和评估状态。" />
      <LocalAgentRuns />
      <DemoRegion title="Run 原型" note="以下筛选器、Mock Run 与事件流为原型演示；真实 Run 的排队、Worker、取消与上下文对账在上方区块。" actions={<button className="secondary-button" disabled={Boolean(liveRun && liveRun.progress < 100)} onClick={() => void startMockRun()}><Play size={13} />{liveRun && liveRun.progress < 100 ? '演示 Run 执行中' : '播放演示 Run'}</button>}>
        <div className="filter-tabs"><button className="active" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">全部 <span>8</span></button><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">执行中 <span>2</span></button><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">等待审批 <span>2</span></button><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">已完成 <span>4</span></button></div>
        {liveRun && <section className={`live-run-strip panel ${liveRun.progress === 100 ? 'complete' : ''} ${liveRun.reviewRequired && !liveRun.approved ? 'review-required' : ''} ${!liveRun.integrityValid ? 'integrity-failed' : ''}`}><span className="live-run-pulse"><Bot size={16} /></span><div><strong>{liveRun.label}</strong><p>{liveRun.status} · {lastLiveEvent ? `${lastLiveEvent.sequence}. ${lastLiveEvent.type}` : '准备启动'} · {liveRun.events.length} events</p></div><div className="live-run-progress"><i><b style={{ width: `${liveRun.progress}%` }} /></i><span>{liveRun.progress}%</span></div><button onClick={() => onOpenRun(liveDisplayRun!)}>查看事件流<ChevronRight size={14} /></button></section>}
        <section className="orchestration-panel panel">
          <div className="orchestration-copy"><h2>按模型能力与 Eval 证据选择 Harness</h2><p>{harnessSelection ? `${harnessSelection.profileId} 从 ${harnessSelection.candidateCount} 个候选中选出；证据 ${harnessSelection.evidenceRef}。` : '当前变更采用 Orchestrator–Workers：协调者分解任务，专用 Worker 隔离执行，最终由 Evaluator 汇总。'}</p></div>
          <div className="orchestration-graph">
            <div className="orchestration-node lead"><span><Workflow size={16} /></span><strong>Orchestrator</strong><small>plan + route</small></div>
            <ArrowRight size={16} />
            <div className="worker-stack"><div><Bot size={14} /><span><strong>Code</strong><small>8 files</small></span></div><div><FileCheck2 size={14} /><span><strong>Test</strong><small>42 tasks</small></span></div><div><FileText size={14} /><span><strong>Docs</strong><small>3 updates</small></span></div></div>
            <ArrowRight size={16} />
            <div className="orchestration-node evaluator"><span><FlaskConical size={16} /></span><strong>Evaluator</strong><small>3 graders</small></div>
          </div>
          <div className="orchestration-meta"><span>模式 <strong>{harnessSelection?.executionMode ?? 'Orchestrator–Workers'}</strong></span><span>Reset <strong>{harnessSelection?.contextResetPolicy ?? 'phase boundary'}</strong></span><span>Workflow <strong>{workflowBinding?.replayMode ?? 'event history'}</strong></span><span>Retry <strong>{workflowRetries}</strong></span><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">查看拓扑<ChevronRight size={14} /></button></div>
        </section>
        <section className="runtime-plane panel">
          <div className="runtime-plane-heading"><div><h2>大脑、工具、隔离环境与会话解耦</h2><p>任一组件都可替换、恢复和审计；Session 作为追加写事件日志保存跨步骤状态。</p></div><span className={`runtime-health ${sandboxAttestation?.status === 'failed' ? 'failed' : ''}`}><i />{sandboxAttestation?.status === 'verified' ? 'Sandbox attested' : runtimeBinding ? 'Awaiting attestation' : 'Runtime sample'}</span></div>
          <div className="runtime-components">
            <div><span><Bot size={16} /></span><small>模型</small><strong>{runtimeBinding?.modelRef ?? 'claude-compatible://reasoning'}</strong><em>推理可替换</em></div>
            <div><span><Command size={16} /></span><small>Harness 与工具</small><strong>{runtimeBinding?.harnessRef ?? 'harness://control-plane-v0.1'}</strong><em>工具与循环</em></div>
            <div><span><Boxes size={16} /></span><small>隔离环境</small><strong>{runtimeBinding?.sandboxRef ?? 'sandbox://ephemeral-worktree'}</strong><em>{sandboxAttestation ? `${sandboxAttestation.isolation} · ${sandboxAttestation.networkEgress}` : '等待 Attestation'}</em></div>
            <div><span><Database size={16} /></span><small>会话日志</small><strong>{runtimeBinding?.sessionRef ?? 'session://append-only-log'}</strong><em>{!liveRun ? '样例值，未校验' : !liveRun.integrityValid ? '摘要链校验失败' : runtimeBinding?.appendOnlyLog === false ? '可变日志' : `摘要链已验证 · ${checkpointCount} checkpoint`}</em></div>
          </div>
          {sandboxAttestation && <div className={`runtime-attestation ${sandboxAttestation.status}`}><ShieldCheck size={15} /><div><strong>{sandboxAttestation.attestorRef}</strong><span>{sandboxAttestation.workspaceRoot} · {sandboxAttestation.writablePaths.length} writable · {sandboxAttestation.readonlyPaths.length} readonly · {sandboxAttestation.allowedHosts.length} allowed hosts · {sandboxAttestation.secretMounts.length} secret mounts</span></div><code>{sandboxAttestation.attestationDigest}</code></div>}
        </section>
        <div className="run-board">
          {displayedRuns.map((run) => (
            <button className="run-card panel" key={run.id} onClick={() => onOpenRun(run)}>
              <div className="run-card-top"><div className={`run-icon ${run.tone}`}><Bot size={17} /></div><span className={`state-pill ${run.tone}`}>{run.state}</span><span className="icon-button"><MoreHorizontal size={17} /></span></div>
              <h3>{run.label}</h3><p>{run.id} · {run.agent}</p>
              <div className="run-metadata"><span><Clock3 size={14} />{run.duration}</span><span><Network size={14} />4 tools</span><span><FileText size={14} />12 files</span></div>
              <div className="large-progress"><i className={run.tone} style={{ width: `${run.progress}%` }} /></div><small>{run.progress}% complete</small>
            </button>
          ))}
        </div>
      </DemoRegion>
    </>
  )
}

/**
 * Declared Context versus what the run reported reading. The charter treats the gap itself as review
 * information, so both directions are shown — undeclared reads and declared-but-unread paths — together with
 * the fact that the report comes from the agent's own protocol and is not independently observed.
 */
function LocalRunContextDrawer({ detail, onClose }: { detail: LocalAgentRunDetail; onClose: () => void }) {
  const consumed = detail.events.filter((event) => event.eventType === 'agent_run.context_consumed').map((event) => ({
    path: String(event.payload.path ?? ''),
    declared: event.payload.declared === true,
    contentDigest: String(event.payload.contentDigest ?? ''),
    reportSource: String(event.payload.reportSource ?? 'unknown'),
    independentlyObserved: event.payload.independentlyObserved === true,
  }))
  const rejected = detail.events.filter((event) => event.eventType === 'agent_run.context_rejected')
  const consumedPaths = new Set(consumed.map((item) => item.path))
  const undeclared = consumed.filter((item) => !item.declared)
  const unread = detail.declaredContextPaths.filter((path) => !consumedPaths.has(path))
  return (
    <>
      <button className="local-evidence-overlay" aria-label="关闭运行详情" onClick={onClose} />
      <aside className="local-evidence-drawer">
        <header><div><span className="eyebrow">上下文对账</span><h3>{detail.agentRun.id}</h3><p>Manifest 是声明，实际读取是事实，两者不一致本身就是审查信息。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={15} /></button></header>
        <div className={`local-evidence-digest ${undeclared.length || unread.length ? 'drift' : ''}`}>
          {undeclared.length || unread.length ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
          <div>
            <strong>声明 {detail.declaredContextPaths.length} · 实际读取 {consumed.length} · 未声明读取 {undeclared.length} · 声明未读 {unread.length} · 被拒绝 {rejected.length}</strong>
            <small>读取记录来自 Agent 自述协议（detective，未被独立观测）；它能发现不一致，但不能阻止未声明读取。</small>
          </div>
        </div>
        <section><span>实际读取</span>{consumed.length ? <div className="local-context-rows">{consumed.map((item) => <div className={`local-context-row ${item.declared ? 'declared' : 'undeclared'}`} key={`${item.path}-${item.contentDigest}`}>
          <strong>{item.path}</strong>
          <span className={`local-check-provenance ${item.declared ? 'pre_existing' : 'unverified'}`}>{item.declared ? '在声明内' : '未声明'}</span>
          <code>{item.contentDigest}</code>
          <em>{item.reportSource} · {item.independentlyObserved ? '已独立观测' : '未独立观测'}</em>
        </div>)}</div> : <p className="local-evidence-empty">这次运行没有上报任何读取；无法判断它到底看了什么。</p>}</section>
        <section><span>声明但未读取</span>{unread.length ? <div className="local-context-rows">{unread.map((path) => <div className="local-context-row unread" key={path}><strong>{path}</strong><span className="local-check-provenance all_tests">未读取</span></div>)}</div> : <small>声明的路径都被读取了。</small>}</section>
        {rejected.length > 0 && <section><span>被拒绝的读取</span><div className="local-context-rows">{rejected.map((event) => <div className="local-context-row rejected" key={event.id}><strong>{String(event.payload.reportedPath ?? '')}</strong><span className="local-check-provenance unverified">{String(event.payload.reason ?? 'rejected')}</span></div>)}</div></section>}
        <section><span>Run</span><div className="local-evidence-runtime"><code>{detail.agentRun.adapterId} · {detail.agentRun.status}</code><small>{detail.agentRun.isolation} · {detail.agentRun.networkEgress} egress · base {detail.agentRun.baseSha.slice(0, 12)} · {detail.events.length} 条事件</small></div></section>
      </aside>
    </>
  )
}

/** The repository runs and proposals use, read from the current project. The browser cannot choose another one. */
function ProjectRepositoryChip() {
  const local = useLocalControlPlane()
  const project = local.currentProject
  if (!project) return <span className="project-repo-chip missing"><FolderGit2 size={12} />没有可用项目</span>
  const location = project.codeHost === 'github' ? `${project.codeHostConfig.owner ?? '?'}/${project.codeHostConfig.repo ?? '?'}` : project.repositoryPath
  if (!project.repositoryPath && project.codeHost === 'local') return <span className="project-repo-chip missing" title="Owner 需要在「项目」页配置仓库后才能启动 Run"><FolderGit2 size={12} />{project.slug} · 未配置仓库</span>
  return <span className="project-repo-chip" title={`${project.name} · ${location} · 默认分支 ${project.defaultBranch}`}><FolderGit2 size={12} /><strong>{project.slug}</strong><code>{location}</code><em>{project.defaultBranch}</em></span>
}

function LocalAgentRuns() {
  const local = useLocalControlPlane()
  const [input, setInput] = useState({ workItemId: '', baseRef: '', declaredContextPaths: '' })
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [detail, setDetail] = useState<LocalAgentRunDetail>()
  const [detailBusyId, setDetailBusyId] = useState<string>()
  const [copiedRunId, setCopiedRunId] = useState<string>()
  const [error, setError] = useState<string>()
  if (local.status !== 'ready') return null
  const copyDiagnostic = async (runId: string) => {
    setError(undefined)
    try {
      const runDetail = await local.getAgentRunDetail(runId)
      await copyText(runDiagnosticReport(runDetail, local.workItems.find((item) => item.id === runDetail.agentRun.workItemId), local.agentRuntime, local.projects.find((project) => project.id === runDetail.agentRun.projectId)?.slug))
      setCopiedRunId(runId)
      window.setTimeout(() => setCopiedRunId((current) => current === runId ? undefined : current), 2000)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  const selectedWorkItemId = input.workItemId || local.workItems[0]?.id || ''
  const selectedIntent = local.intentVersions.filter((item) => item.workItemId === selectedWorkItemId).sort((left, right) => right.version - left.version)[0]
  const canRun = local.actor && ['owner', 'maintainer', 'developer'].includes(local.currentProjectRole ?? '')
  // DOMAIN_MODEL.md §6.1: the server refuses a Run on an unapproved Intent; say so before the click.
  const intentBlock = !selectedIntent ? undefined : selectedIntent.status === 'draft' ? `Intent v${selectedIntent.version} 为${selectedIntent.riskLevel === 'high' ? '高' : '中'}风险，尚未批准。请在 Intents 页由作者以外的 owner、maintainer 或 reviewer 批准后再启动。` : selectedIntent.status === 'superseded' ? `Intent v${selectedIntent.version} 已被新版本取代。` : undefined
  const inFlight = local.agentRuns.filter((run) => run.status === 'queued' || run.status === 'running')
  const start = async () => {
    if (!selectedIntent) return setError('所选 Work Item 缺少 Intent Version。')
    setBusy(true)
    setError(undefined)
    try {
      // Admission is synchronous; the agent itself runs in a worker process, so this returns in milliseconds.
      const queuePosition = await local.startAgentRun({ workItemId: selectedWorkItemId, intentVersionId: selectedIntent.id, baseRef: input.baseRef.trim() || undefined, declaredContextPaths: input.declaredContextPaths.split(/[\n,]/u).map((value) => value.trim()).filter(Boolean) })
      setNotice(queuePosition === undefined ? 'Run 已受理。' : queuePosition === 0 ? 'Run 已受理，正在执行。' : `Run 已受理，队列中第 ${queuePosition} 位等待。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async (runId: string) => {
    setCancelling(runId)
    setError(undefined)
    try {
      await local.cancelAgentRun(runId)
      setNotice(`${runId} 已请求取消。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCancelling(undefined)
    }
  }
  const openDetail = async (runId: string) => {
    setDetailBusyId(runId)
    setError(undefined)
    try {
      setDetail(await local.getAgentRunDetail(runId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDetailBusyId(undefined)
    }
  }
  return <section className="panel local-agent-runs"><div className="local-core-heading"><div><span className="eyebrow">真实数据 · 本地 Agent</span><h2>Intent → Worktree → Agent → Change Proposal</h2><p>Agent 命令由服务端配置；浏览器不能提交任意 Shell。只有 Container Runtime 会显示受限网络与运行证明。</p>{local.agentRuntime?.reason && <small className="local-runtime-reason"><ShieldAlert size={12} />{local.agentRuntime.reason}</small>}</div><span className={`local-agent-capability ${local.agentRuntime?.status === 'ready' ? 'ready' : 'disabled'}`}><i />{local.agentRuntime ? `${local.agentRuntime.status} · ${local.agentRuntime.isolation}` : 'Runner disabled'}</span></div><div className="local-agent-form"><select value={selectedWorkItemId} onChange={(event) => setInput((current) => ({ ...current, workItemId: event.target.value }))}>{local.workItems.length === 0 ? <option value="">先创建 Intent</option> : local.workItems.map((item) => <option key={item.id} value={item.id}>{workItemLabel(item)}</option>)}</select><ProjectRepositoryChip /><input value={input.baseRef} onChange={(event) => setInput((current) => ({ ...current, baseRef: event.target.value }))} placeholder={`Base ref（默认 ${local.currentProject?.defaultBranch ?? 'main'}）`} /><input value={input.declaredContextPaths} onChange={(event) => setInput((current) => ({ ...current, declaredContextPaths: event.target.value }))} placeholder="追加 Context，逗号分隔（manifest 的必需文件总会带上）" aria-label="声明 Context" /><button className="primary-button" disabled={!local.agentRunnerId || !canRun || !selectedIntent || Boolean(intentBlock) || !local.currentProject?.repositoryPath || busy} onClick={() => void start()}><Play size={13} />{busy ? '受理中' : '启动真实 Run'}</button></div>{intentBlock && <p className="local-rule-note local-intent-block" role="status"><ShieldAlert size={12} />{intentBlock}</p>}{error && <p className="local-form-error" role="alert">{error}</p>}{notice && !error && <p className="local-run-notice" role="status"><Clock3 size={11} />{notice}</p>}{inFlight.length > 0 && <p className="local-run-notice" role="status"><RefreshCw size={11} className="spin" />{inFlight.length} 个 Run 在 Worker 进程中执行，状态每 3 秒自动刷新；控制面保持可用。</p>}<div className="local-agent-run-list">{local.agentRuns.length === 0 ? <div className="local-empty"><Bot size={18} /><p>尚无真实本地 Agent Run。</p></div> : local.agentRuns.map((run) => <article key={run.id} className={run.status === 'queued' || run.status === 'running' ? 'in-flight' : undefined}><span className={`local-status ${run.status}`}>{run.status}</span><div><strong>{workItemLabel(local.workItems.find((item) => item.id === run.workItemId)) ?? run.workItemId}</strong><small>{run.id} · {run.branchRef} · {run.adapterId}</small>{run.status === 'failed' && run.errorMessage && <small className="local-run-error" title={run.errorMessage}>{run.errorMessage.trim().split('\n').at(-1)}</small>}</div><code title={run.runtimeAttestationDigest}>{run.baseSha.slice(0, 7)} → {run.changeProposalId ?? 'no proposal'}</code><em>{run.status === 'queued' ? '排队等待 Worker' : run.status === 'running' ? `Worker PID ${run.workerPid ?? '—'}` : run.isolation === 'container' ? `${run.networkEgress} egress · ${run.runtimeImageRef}` : '未隔离进程'}</em><button className="secondary-button" disabled={detailBusyId === run.id} onClick={() => void openDetail(run.id)}><Eye size={12} />{detailBusyId === run.id ? '读取中' : '上下文对账'}</button>{(run.status === 'failed' || run.status === 'cancelled') && <button className="secondary-button" onClick={() => void copyDiagnostic(run.id)} title="复制错误、Agent 输出末尾、未提交改动与事件日志（密钥已脱敏）"><ClipboardCopy size={12} />{copiedRunId === run.id ? '已复制' : '复制诊断'}</button>}{(run.status === 'queued' || run.status === 'running') && <button className="secondary-button" disabled={cancelling === run.id || Boolean(run.cancellationRequestedAt)} onClick={() => void cancel(run.id)}><X size={12} />{run.cancellationRequestedAt ? '取消中' : '取消'}</button>}</article>)}</div>{detail && <LocalRunContextDrawer detail={detail} onClose={() => setDetail(undefined)} />}</section>
}

function ReviewPage({ onOpenReview }: { onOpenReview: (item: ReviewItem) => void }) {
  const { liveRun } = useWorkbench()
  const evaluation = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const artifacts = liveRun?.events.filter((event) => event.type === 'artifact_created') ?? []
  const liveReview: ReviewItem | null = liveRun?.approved ? {
    id: liveRun.runId,
    title: liveRun.label,
    project: 'Control Plane',
    author: 'Mock Agent + Wangzhen',
    risk: evaluation?.failed ? '中风险' : '低风险',
    status: liveRun.reviewDecision === 'changes_requested' ? '需修改' : liveRun.reviewDecision === 'approved' ? '审查中' : '待审查',
    coverage: evaluation ? Math.round((evaluation.passed / Math.max(evaluation.passed + evaluation.failed + evaluation.unknown, 1)) * 100) : 0,
    files: artifacts.length,
    additions: 128,
    deletions: 24,
    updated: '刚刚',
    summary: '该变更已完成 Agent 执行、策略阻断、检查点保存、Evaluation 和具名运行门禁，现进入人工变更评审。',
    evidenceHeadline: `${evaluation?.passed ?? 0} 项评估通过，${evaluation?.failed ?? 0} 项需人工判断`,
    evidenceDetail: `${artifacts.length} 个签名产物 · ${liveRun.events.length} 条 Session 事件 · 人工门禁已通过`,
    contextDetail: '未声明的 OAuth 配置请求已被预防性阻断，资源内容未进入模型上下文。',
    criteria: [
      { label: 'Context Manifest 与实际消费已对账', state: 'passed' },
      { label: 'Patch、Tests 与 Docs 产物完整', state: artifacts.length >= 3 ? 'passed' : 'unknown' },
      { label: 'Evaluation 失败项已具名确认', state: evaluation?.failed ? 'warning' : 'passed' },
      { label: 'Session 事件与检查点可追溯', state: liveRun.events.some((event) => event.type === 'checkpoint_saved' || event.type === 'checkpoint_restored') ? 'passed' : 'unknown' },
    ],
  } : null
  const reviewItems = [...(liveReview ? [liveReview] : []), ...reviews]
  return (
    <>
      <PageHeader title="评审队列" description="把有限的人类审查带宽优先分配给高风险和高影响变更。" />
      <LocalReviewQueue />
      <DemoRegion title="评审队列" note="以下队列保留用于原型展示，审批结果不进入本地 Event Log。">
        <div className="review-summary">
          <div><span className="dot high" /><strong>{reviewItems.filter((item) => item.risk === '高风险').length}</strong><small>高风险待审</small></div><div><span className="dot medium" /><strong>2h 14m</strong><small>最长等待</small></div><div><span className="dot low" /><strong>68%</strong><small>团队负载</small></div>
        </div>
        <div className="review-page-list panel">
          <div className="list-title"><span>按优先级排序</span><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><ListFilter size={15} />筛选</button></div>
          {reviewItems.map((item) => <ReviewRow key={item.id} item={item} onClick={() => onOpenReview(item)} />)}
        </div>
      </DemoRegion>
    </>
  )
}

function formatReviewDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

const criterionStatusLabels: Record<LocalReviewReadiness['criteria'][number]['status'], string> = { passed: '已证明', self_graded: '仅自带测试', failed: '证据失败', pending: '待证据', unmapped: '无可映射检查', awaiting_review: '待人工签署', overridden: '已推翻' }

const assignmentStatusLabels: Record<LocalReviewAssignment['status'], string> = { pending: '待开始', in_review: '审查中', changes_requested: '已请求修改', approved: '已批准', reassigned: '已转交' }
const assignmentBasisLabels: Record<LocalReviewAssignment['basis'], string> = { manual: '指定分配', self_claim: '自行认领', load_balanced: '按负载分配' }

function LocalReviewQueue() {
  const local = useLocalControlPlane()
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [proposalInput, setProposalInput] = useState({ workItemId: '', baseRef: '', headRef: '' })
  const [busyId, setBusyId] = useState<string>()
  const [evidenceBusyId, setEvidenceBusyId] = useState<string>()
  const [evidencePreview, setEvidencePreview] = useState<LocalEvidencePackageView>()
  const [error, setError] = useState<string>()
  const [assigneeChoice, setAssigneeChoice] = useState<Record<string, string>>({})
  if (local.status !== 'ready') return null
  const workItems = new Map(local.workItems.map((item) => [item.id, item]))
  const selectedWorkItemId = proposalInput.workItemId || local.workItems[0]?.id || ''
  const selectedIntent = local.intentVersions.filter((item) => item.workItemId === selectedWorkItemId).sort((left, right) => right.version - left.version)[0]
  const canReview = local.actor && ['owner', 'maintainer', 'reviewer'].includes(local.currentProjectRole ?? '')
  const canMerge = local.actor && ['owner', 'maintainer'].includes(local.currentProjectRole ?? '')
  const canOverride = local.currentProjectRole === 'owner'
  const reviewsByProposal = new Map<string, typeof local.reviews>()
  for (const review of local.reviews) reviewsByProposal.set(review.changeProposalId, [...(reviewsByProposal.get(review.changeProposalId) ?? []), review])
  // Whether any test conclusion in the open package is independent of the change under review. This is the
  // first thing a reviewer has to know, because it decides how much the green checks below are worth. The
  // package's own `independent` flag only says the provenance was *determinable*, so the stronger claim —
  // a passing conclusion the change could not have authored — is derived from the conclusions here.
  const testProvenance = evidencePreview?.evidencePackage.testProvenance
  const independentPassingConclusion = Boolean(testProvenance && (testProvenance.baselineConclusions.some((item) => item.conclusion === 'success')
    || (testProvenance.declaredTestPaths.length > 0 && testProvenance.agentModifiedTestFiles.length === 0 && testProvenance.headConclusions.some((item) => item.conclusion === 'success'))))
  const createProposal = async () => {
    if (!selectedWorkItemId || !selectedIntent) return setError('请先为 Work Item 创建 Intent Version。')
    setBusyId('create')
    setError(undefined)
    try {
      await local.createChangeProposal({ headRef: proposalInput.headRef.trim(), baseRef: proposalInput.baseRef.trim() || undefined, workItemId: selectedWorkItemId, intentVersionId: selectedIntent.id })
      setProposalInput((current) => ({ ...current, headRef: '' }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }
  const assign = async (proposal: LocalChangeProposal, assigneeActorId: string | undefined, reassigning: boolean) => {
    setBusyId(proposal.id)
    setError(undefined)
    try {
      // Taking a review from someone needs a reason; like reject and override, it comes from the reviewer's note.
      await local.assignReviewer(proposal.id, { assigneeActorId, reason: reassigning ? notes[proposal.id]?.trim() : undefined })
      if (reassigning) setNotes((current) => ({ ...current, [proposal.id]: '' }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }
  const humanCriteriaFor = (proposalId: string) => (local.reviewReadiness.find((item) => item.changeProposalId === proposalId)?.criteria ?? []).filter((item) => item.verificationType === 'human' && item.criticality === 'critical')
  const act = async (proposal: LocalChangeProposal, action: 'refresh' | 'approved' | 'changes_requested' | 'merge' | 'revise' | 'reject' | { overrideCriterionId: string }) => {
    setBusyId(proposal.id)
    setError(undefined)
    try {
      // Reject and Override take the reviewer's own words as the reason; the server refuses them without one.
      if (typeof action === 'object') {
        await local.overrideCriterion(proposal, action.overrideCriterionId, notes[proposal.id]?.trim() ?? '')
        setNotes((current) => ({ ...current, [proposal.id]: '' }))
      } else if (action === 'reject') await local.rejectChangeProposal(proposal, notes[proposal.id]?.trim() ?? '')
      else if (action === 'refresh') await local.refreshChangeProposal(proposal.id)
      else if (action === 'merge') await local.mergeChangeProposal(proposal.id)
      else if (action === 'revise') await local.reviseChangeProposal(proposal.id)
      // No default text when approving signs off human-verified criteria: the server requires the reviewer's own
      // judgement there, and a canned sentence would satisfy it without anyone having judged anything.
      else await local.reviewChangeProposal(proposal, action, notes[proposal.id]?.trim() || (action === 'approved' ? (humanCriteriaFor(proposal.id).length || proposal.policyFiles?.length || local.reviewReadiness.find((item) => item.changeProposalId === proposal.id)?.builderStop ? '' : '本地证据与 Revision 已审查。') : '请根据审查意见修改后提交新 Revision。'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }
  const viewEvidence = async (evidenceId: string) => {
    setEvidenceBusyId(evidenceId)
    setError(undefined)
    try {
      setEvidencePreview(await local.viewEvidence(evidenceId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setEvidenceBusyId(undefined)
    }
  }
  return (
    <section className="panel local-review-queue">
      <div className="local-core-heading">
        <div><span className="eyebrow">真实数据 · 本地变更提案</span><h2>Revision-bound Review</h2><p>审批身份来自 Session；Decision、首响时间与当前 Head SHA 绑定。</p></div>
        <button className="secondary-button" onClick={() => void local.refresh()}><RefreshCw size={14} />刷新</button>
      </div>
      <div className="local-review-metrics">
        <div><span>待评审</span><strong>{local.reviewMetrics.pendingCount}</strong><small>oldest {formatReviewDuration(local.reviewMetrics.oldestPendingSeconds)}</small></div>
        <div><span>首个决策中位数</span><strong>{formatReviewDuration(local.reviewMetrics.medianDecisionLatencySeconds)}</strong><small>按 Revision 计算</small></div>
        <div><span>请求修改</span><strong>{local.reviewMetrics.changesRequestedCount}</strong><small>阻断批准状态</small></div>
        <div><span>有效 / 失效决策</span><strong>{local.reviewMetrics.currentDecisionCount} / {local.reviewMetrics.invalidatedDecisionCount}</strong><small>{local.reviewMetrics.activeReviewerCount} active reviewers</small></div>
      </div>
      <div className="local-change-form">
        <select value={selectedWorkItemId} onChange={(event) => setProposalInput((current) => ({ ...current, workItemId: event.target.value }))}>{local.workItems.length === 0 ? <option value="">先创建 Intent</option> : local.workItems.map((item) => <option key={item.id} value={item.id}>{workItemLabel(item)}</option>)}</select>
        <ProjectRepositoryChip />
        <input value={proposalInput.baseRef} onChange={(event) => setProposalInput((current) => ({ ...current, baseRef: event.target.value }))} placeholder={`Base ref（默认 ${local.currentProject?.defaultBranch ?? 'main'}）`} />
        <input value={proposalInput.headRef} onChange={(event) => setProposalInput((current) => ({ ...current, headRef: event.target.value }))} placeholder="Head ref / branch" />
        <button className="primary-button" disabled={busyId === 'create' || !selectedIntent || !local.currentProject?.repositoryPath || !proposalInput.headRef.trim()} onClick={() => void createProposal()}><Plus size={13} />创建提案</button>
        <small>{selectedIntent ? `绑定 ${selectedIntent.id} · Intent v${selectedIntent.version}` : '所选 Work Item 缺少 Intent Version'}</small>
      </div>
      {local.changeProposals.length === 0 ? <div className="local-empty"><GitBranch size={18} /><p>暂无本地 Change Proposal。请从具有独立 Base / Head Revision 的真实 Git 仓库创建。</p></div> : (
        <div className="local-proposal-list">{local.changeProposals.map((proposal) => {
          const selfReview = proposal.authorActorId === local.actor?.id
          const proposalReviews = reviewsByProposal.get(proposal.id) ?? []
          const currentReview = proposalReviews.find((review) => !review.invalidatedAt && review.headSha === proposal.headSha && review.decision !== 'commented')
          const invalidatedCount = proposalReviews.filter((review) => Boolean(review.invalidatedAt)).length
          const readiness = local.reviewReadiness.find((item) => item.changeProposalId === proposal.id)
          const mergeEvent = local.events.find((event) => event.aggregateType === 'change_proposal' && event.aggregateId === proposal.id && event.eventType === 'change_proposal.merged')
          const rejectEvent = local.events.find((event) => event.aggregateType === 'change_proposal' && event.aggregateId === proposal.id && event.eventType === 'decision.rejected')
          // Surfaced on the row, not only inside the drawer: whether any passing test predates the change is
          // the difference between evidence and self-grading, and it has to be visible before the 批准 button.
          const latestEvidence = readiness?.evidence.at(-1)
          const independentTestSignal = typeof latestEvidence?.summary.independentTestSignal === 'boolean' ? latestEvidence.summary.independentTestSignal : undefined
          const humanCriteria = humanCriteriaFor(proposal.id)
          const unsignedHumanCriteria = humanCriteria.filter((item) => !mentionsCriterion(notes[proposal.id] ?? '', item.label))
          const note = notes[proposal.id]?.trim() ?? ''
          const closed = proposal.status === 'merged' || proposal.status === 'closed'
          const hostLink = local.codeHostLinks.find((link) => link.changeProposalId === proposal.id)
          const outsideGateEvent = local.events.find((event) => event.aggregateType === 'change_proposal' && event.aggregateId === proposal.id && event.eventType === 'change_proposal.merged_outside_gate')
          const mergesOnHost = local.currentProject?.mergeMode === 'host_protected'
          // DOMAIN_MODEL.md §9.1.1: a head that edits the rules it is judged by is flagged, and only an Owner who
          // writes down why the new rules are acceptable may approve it.
          const policyFiles = readiness?.policyFiles ?? proposal.policyFiles ?? []
          const policyApprovalBlock = policyFiles.length ? (!canOverride ? '改动了 .aperture 策略文件：仅 Owner 可批准' : !note ? '改动了 .aperture 策略文件：先在审查意见里写明为什么接受新策略' : '') : ''
          // A Builder that ran out of time or steps handed over whatever it had; approving it means someone read it as partial.
          const builderStop = readiness?.builderStop ?? null
          const partialApprovalBlock = builderStop && !note ? 'Builder 未完成就停止：先在审查意见里写明为什么接受这份部分变更' : ''
          const assignment = local.reviewAssignments.find((item) => item.changeProposalId === proposal.id && item.status !== 'reassigned')
          const assignedElsewhere = Boolean(assignment && assignment.assigneeActorId !== local.actor?.id)
          const assignedTitle = assignedElsewhere ? `已分配给 ${assignment!.assigneeDisplayName}；需先重新分配` : ''
          const candidates = local.reviewerLoad.filter((item) => item.actorId !== proposal.authorActorId && item.actorId !== assignment?.assigneeActorId)
          const choice = assigneeChoice[proposal.id] ?? ''
          const choiceIneligible = Boolean(choice && policyFiles.length && candidates.find((item) => item.actorId === choice)?.role !== 'owner')
          const overrideTitle = !canOverride ? '仅 Owner 可推翻门禁' : selfReview ? '作者不能推翻自己提案的门禁' : note.length < 10 ? '先在下方意见框写下推翻理由（至少 10 个字）' : '以下方意见作为理由，记录一条 Override Decision'
          return <article key={proposal.id}>
            <div className="local-proposal-main"><span className={`local-status ${proposal.status}`}>{proposal.status}</span><div><strong>{workItemLabel(workItems.get(proposal.workItemId)) ?? proposal.workItemId}</strong><small>{proposal.id} · {proposal.baseRef} → {proposal.headRef}</small></div><code title={proposal.headSha}>{proposal.headSha.slice(0, 12)}</code></div>
            <div className="local-proposal-stats"><span>{proposal.changedFiles} files</span><span className="additions">+{proposal.additions}</span><span className="deletions">−{proposal.deletions}</span><span>{proposal.authorActorId === local.actor?.id ? '你是作者' : `author ${proposal.authorActorId.slice(-8)}`}</span><span><Clock3 size={11} /> cycle {formatReviewDuration(Math.max(0, Math.floor((Date.now() - Date.parse(proposal.reviewCycleStartedAt)) / 1000)))}</span></div>
            {builderStop && <div className="local-policy-change local-builder-stop" role="note"><ShieldAlert size={14} /><div><strong>部分变更 · {builderStop.reason === 'time_budget' ? 'Builder 用完了时间预算' : 'Builder 用完了步数预算'}</strong><small>{builderStop.summary}</small><small>{builderStop.runId} · 按每条验收标准核对；批准需在审查意见里写明为什么接受。</small></div></div>}
            {policyFiles.length > 0 && <div className="local-policy-change" role="note"><ShieldAlert size={14} /><div><strong>改动策略文件 · {policyFiles.length}</strong><small>本次变更修改了治理它自己的规则；Run 仍按 Base 上的 Manifest 执行。批准需 Owner 并写明理由。</small></div><ul>{policyFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>}
            <div className={`local-review-assignment ${assignment?.overdue ? 'overdue' : assignment ? assignment.status : 'unassigned'}`}>
              <UserCheck size={14} />
              <div>{assignment ? <><strong>审查人 · {assignment.assigneeActorId === local.actor?.id ? '你' : assignment.assigneeDisplayName} · {assignmentStatusLabels[assignment.status]}{assignment.overdue && <em className="local-assignment-overdue">逾期</em>}</strong><small>{assignmentBasisLabels[assignment.basis]} · 截止 {assignment.dueAt.slice(0, 16).replace('T', ' ')} · {assignment.evidenceOpenedAt ? '已展开证据' : '尚未展开证据'}{assignment.timeSpentSeconds !== undefined ? ` · 用时 ${formatReviewDuration(assignment.timeSpentSeconds)}` : ''}{assignment.reason ? ` · ${assignment.reason}` : ''}</small></> : <><strong>未分配审查人</strong><small>任何有审查权限的非作者都可以决策；分配后只有被分配人可以批准或请求修改。</small></>}</div>
              {!closed && canMerge && <div className="local-assignment-controls"><select aria-label="选择审查人" value={choice} onChange={(event) => setAssigneeChoice((current) => ({ ...current, [proposal.id]: event.target.value }))}><option value="">按负载自动分配</option>{candidates.map((item) => <option key={item.actorId} value={item.actorId} disabled={policyFiles.length > 0 && item.role !== 'owner'}>{item.displayName} · {item.role} · {item.openAssignmentCount} 待审</option>)}</select><button className="secondary-button" title={assignment && !note ? '重新分配需要理由：先在下方意见框写明' : choiceIneligible ? '策略文件改动只能分配给 Owner' : undefined} disabled={busyId === proposal.id || (Boolean(assignment) && !note) || choiceIneligible} onClick={() => void assign(proposal, choice || undefined, Boolean(assignment))}>{assignment ? '重新分配' : '分配'}</button></div>}
              {!closed && !canMerge && canReview && !assignment && !selfReview && <button className="secondary-button" disabled={busyId === proposal.id || (policyFiles.length > 0 && local.currentProjectRole !== 'owner')} onClick={() => void assign(proposal, local.actor!.id, false)}>认领审查</button>}
            </div>
            {currentReview ? <div className={`local-review-decision ${currentReview.decision}`}><ShieldCheck size={14} /><div><strong>{currentReview.reviewerDisplayName} · {currentReview.decision}</strong><small>{formatReviewDuration(currentReview.decisionLatencySeconds)} 首响 · head {currentReview.headSha.slice(0, 8)} · {currentReview.comment || '无附加说明'}</small></div></div> : <div className="local-review-decision pending"><Clock3 size={14} /><div><strong>等待独立 Reviewer 决策</strong><small>Decision 必须绑定当前 Head SHA；作者不能自批。</small></div></div>}
            {readiness && <div className={`local-review-readiness ${readiness.status}`}><div><span>{readiness.status === 'ready' ? <CheckCircle2 size={14} /> : readiness.status === 'blocked' ? <ShieldAlert size={14} /> : <FileCheck2 size={14} />}</span><div><strong>Evidence readiness · {readiness.status}</strong><small>{readiness.successfulCheckCount}/{readiness.checks.length} checks passed · {readiness.evidence.length} package(s) · {readiness.evidence.reduce((total, item) => total + item.viewCount, 0)} view(s)</small></div></div><code title={readiness.evidence.map((item) => item.sha256).join('\n')}>{readiness.blockers[0] ?? `bound to ${readiness.headSha.slice(0, 12)}`}</code>{independentTestSignal !== undefined && <span className={`local-independence-chip ${independentTestSignal ? 'independent' : 'self-authored'}`} title={independentTestSignal ? '有一条通过结论来自把测试重置回 Base 之后的重跑' : '所有通过结论都包含本次变更自带的测试；关键验收标准不能只靠它'}>{independentTestSignal ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}{independentTestSignal ? '含独立测试结论' : '仅自带测试结论'}</span>}<button className="secondary-button" disabled={!readiness.evidence.length || evidenceBusyId === readiness.evidence.at(-1)?.id} onClick={() => { const evidenceId = readiness.evidence.at(-1)?.id; if (evidenceId) void viewEvidence(evidenceId) }}><Eye size={13} />{evidenceBusyId === readiness.evidence.at(-1)?.id ? '校验中' : '查看证据'}</button>{(readiness.invalidatedCheckCount > 0 || readiness.invalidatedEvidenceCount > 0) && <em>{readiness.invalidatedCheckCount} stale checks · {readiness.invalidatedEvidenceCount} stale evidence</em>}</div>}
            {readiness?.criteria?.length ? <ul className="local-criteria-status" aria-label="验收标准证据">{readiness.criteria.map((item) => <li key={item.criterionId} className={item.status} title={item.unmappedReason ?? (item.checkNames.length ? `${item.mapping === 'declared' ? '声明映射' : '规则映射'}证据：${item.checkNames.join(', ')}` : '由批准本身签署')}><b>{item.label}</b><span>{item.status === 'self_graded' && item.verificationType === 'model' ? '评测未隔离' : criterionStatusLabels[item.status]}</span><em>{criticalityLabels[item.criticality]} · {verificationLabels[item.verificationType]}</em><p>{item.statement}</p>{item.override && <small className="local-criterion-override">{item.override.decisionId} · {item.override.actorDisplayName} 推翻了「{criterionStatusLabels[item.override.overriddenStatus]}」：{item.override.reason}</small>}{item.criticality === 'critical' && ['failed', 'self_graded', 'unmapped'].includes(item.status) && !closed && <button className="secondary-button local-criterion-override-button" title={overrideTitle} disabled={!canOverride || selfReview || note.length < 10 || busyId === proposal.id} onClick={() => void act(proposal, { overrideCriterionId: item.criterionId })}>推翻</button>}</li>)}</ul> : null}
            {invalidatedCount > 0 && <small className="local-invalidated-note"><History size={12} />{invalidatedCount} 条旧决策因 Reviewer 更新或 Revision 变化已失效</small>}
            {rejectEvent && <div className="local-reject-decision" role="status"><X size={13} /><div><strong>已拒绝 · {String(rejectEvent.payload.decisionId)} · {local.actors.find((item) => item.id === rejectEvent.actorId)?.displayName ?? rejectEvent.actorId}</strong><small>{String(rejectEvent.payload.reason)}</small></div></div>}
            {mergeEvent && <div className="local-merge-evidence"><PackageCheck size={13} /><div><strong>Merge Evidence 已封存</strong><small>{mergeEvent.payload.strategy === 'host_merge' ? `GitHub 合并 · ${String((mergeEvent.payload.hostMerge as { contentCheck?: string } | undefined)?.contentCheck ?? '')}` : String(mergeEvent.payload.strategy)} · {String(mergeEvent.payload.mergedSha).slice(0, 12)} · {String(mergeEvent.payload.evidenceDigest)}</small></div></div>}
            {outsideGateEvent && <div className="local-reject-decision local-outside-gate" role="alert"><ShieldAlert size={13} /><div><strong>绕过门禁的合并 · {String(outsideGateEvent.payload.mergedBy ?? '未知')} 在 GitHub 上合并</strong><small>{(outsideGateEvent.payload.reasons as string[] | undefined ?? []).join('；')}。检查分支保护是否把 aperture/gate 设为必需检查。</small></div></div>}
            {hostLink && <div className={`local-host-link ${hostLink.state} gate-${hostLink.gateShaPublished === proposal.headSha ? hostLink.gateStatePublished ?? 'none' : 'none'}`}><GitPullRequest size={13} /><div><strong><a href={hostLink.url} target="_blank" rel="noreferrer">PR #{hostLink.externalId}</a> · {hostLink.state === 'open' ? '打开' : hostLink.state === 'merged' ? '已合并' : '已关闭'} · aperture/gate {hostLink.gateShaPublished === proposal.headSha ? hostLink.gateStatePublished ?? '未发布' : '未发布到当前 Head'}</strong><small>{hostLink.publishedRef} · {hostLink.headShaPublished.slice(0, 12)} · 同步于 {hostLink.syncedAt.slice(0, 16).replace('T', ' ')}{hostLink.gateDescriptionPublished ? ` · ${hostLink.gateDescriptionPublished}` : ''}</small>{hostLink.lastError && <small className="local-form-error">同步失败：{hostLink.lastError}</small>}</div></div>}
            <textarea value={notes[proposal.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [proposal.id]: event.target.value }))} placeholder={humanCriteria.length ? `批准即签署 ${humanCriteria.map((item) => item.label).join('、')}（人工验收）：逐条写明编号与判断，如「${humanCriteria[0].label}：已与安全负责人核对威胁模型」（必填）` : '审查意见；拒绝与推翻门禁时作为理由（必填）'} aria-label="审查意见" />
            <div className="local-proposal-actions"><button className="secondary-button" disabled={busyId === proposal.id || closed} onClick={() => void act(proposal, 'refresh')}><RefreshCw size={13} />刷新 Revision</button><button className="secondary-button" title={assignedTitle || undefined} disabled={!canReview || selfReview || busyId === proposal.id || closed || assignedElsewhere} onClick={() => void act(proposal, 'changes_requested')}>请求修改</button><button className="secondary-button danger" title={!note ? '在意见框写下拒绝理由；拒绝后提案关闭，不能再修订' : '关闭提案：不提供修订路径'} disabled={!canReview || selfReview || busyId === proposal.id || closed || !note} onClick={() => void act(proposal, 'reject')}><X size={13} />拒绝</button><button className="secondary-button" title={!local.agentRunnerId ? 'Agent Runner 未配置' : undefined} disabled={!local.agentRunnerId || busyId === proposal.id || proposal.status !== 'changes_requested' || !(proposal.authorActorId === local.actor?.id || canMerge)} onClick={() => void act(proposal, 'revise')}><Bot size={13} />Agent 修订</button><button className="primary-button" title={assignedTitle || (readiness?.status === 'blocked' ? readiness.blockers.join(' ') : unsignedHumanCriteria.length ? `审查意见须逐条写出对 ${unsignedHumanCriteria.map((item) => item.label).join('、')} 的判断（写明编号）` : policyApprovalBlock || partialApprovalBlock || undefined)} disabled={!canReview || selfReview || busyId === proposal.id || proposal.status === 'approved' || closed || readiness?.status === 'blocked' || unsignedHumanCriteria.length > 0 || Boolean(policyApprovalBlock) || Boolean(partialApprovalBlock) || assignedElsewhere} onClick={() => void act(proposal, 'approved')}><Check size={13} />批准</button>{mergesOnHost && proposal.status !== 'merged' ? (hostLink ? <a className="secondary-button" href={hostLink.url} target="_blank" rel="noreferrer" title="本项目由 GitHub 在分支保护下合并；合并后平台同步并封存 Merge Evidence"><GitPullRequest size={13} />在 GitHub 上合并</a> : <button className="secondary-button" disabled title="尚未发布到 GitHub；等待同步或在项目页点「立即同步」"><GitPullRequest size={13} />等待发布 PR</button>) : <button className="secondary-button" title={!canMerge ? '仅 Owner / Maintainer 可合并' : readiness?.status !== 'ready' ? 'Evidence 尚未就绪' : hostLink ? '合并后推送到 GitHub；远程已前进或被分支保护拒绝时不会封存' : undefined} disabled={!canMerge || busyId === proposal.id || proposal.status !== 'approved' || readiness?.status !== 'ready'} onClick={() => void act(proposal, 'merge')}><GitBranch size={13} />{proposal.status === 'merged' ? '已合并' : hostLink ? '合并并推送' : '合并并封存'}</button>}</div>
            {selfReview && <small className="local-rule-note"><ShieldAlert size={12} />作者自批已由服务端禁止</small>}
          </article>
        })}</div>
      )}
      {error && <p className="local-form-error" role="alert">{error}</p>}
      {evidencePreview && <>
        <button className="local-evidence-overlay" aria-label="关闭证据详情" onClick={() => setEvidencePreview(undefined)} />
        <aside className="local-evidence-drawer">
          <header><div><span className="eyebrow">证据包</span><h3>{evidencePreview.evidencePackage.workItem.title}</h3><p>{evidencePreview.evidencePackage.intent.goal}</p></div><button className="icon-button" onClick={() => setEvidencePreview(undefined)} aria-label="关闭"><X size={15} /></button></header>
          <div className="local-evidence-digest"><ShieldCheck size={15} /><div><strong>{evidencePreview.evidencePackage.packageDigest}</strong><small>已校验并记录查看 · {evidencePreview.view.viewedAt}</small></div></div>
          <section><span>Revision</span><code>{evidencePreview.evidencePackage.git.baseSha.slice(0, 12)} → {evidencePreview.evidencePackage.git.headSha.slice(0, 12)}</code><small>{evidencePreview.evidencePackage.git.changedFiles} files · +{evidencePreview.evidencePackage.git.additions} −{evidencePreview.evidencePackage.git.deletions}</small></section>
          {evidencePreview.evidencePackage.projectManifest && <section>
            <span>Project Manifest</span>
            <code>{evidencePreview.evidencePackage.projectManifest.path} · {evidencePreview.evidencePackage.projectManifest.digest}</code>
            <small>{evidencePreview.evidencePackage.projectManifest.schemaVersion} · max risk {evidencePreview.evidencePackage.projectManifest.policy.maximumRisk} · unisolated runtime {String(evidencePreview.evidencePackage.projectManifest.policy.allowUnisolatedRuntime)}</small>
            {evidencePreview.evidencePackage.projectManifest.evaluation && <div className="local-evidence-evaluation-binding">
              <strong>{evidencePreview.evidencePackage.projectManifest.evaluation.profile}</strong>
              <small>{evidencePreview.evidencePackage.projectManifest.evaluation.datasetPath ?? 'repository checks'} · {evidencePreview.evidencePackage.projectManifest.evaluation.datasetDigest ?? 'no dataset digest'}</small>
            </div>}
          </section>}
          <section><span>Acceptance Criteria · 起草时声明的验证方式</span><small className="local-evidence-criteria-note">这里是起草时的声明。逐条的证据状态、推翻记录与人工签署要求见审查队列中的「验收标准证据」。</small>{evidencePreview.evidencePackage.intent.acceptanceCriteria.map((criterion) => <div className="local-evidence-criterion" key={criterion.id}><CircleDot size={12} /><p>{criterion.statement}</p><em>声明 · {criterion.criticality} · {criterion.verificationType}</em></div>)}</section>
          {testProvenance && <section className={`local-evidence-provenance ${independentPassingConclusion ? 'independent' : 'self-authored'}`}>
            <span>测试独立性</span>
            <div className="local-provenance-head">
              {independentPassingConclusion ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
              <div>
                <strong>{independentPassingConclusion ? '存在不由本次变更出题的通过结论' : testProvenance.declaredTestPaths.length ? '没有独立的通过结论；关键验收标准不能只靠这些 Check' : 'Manifest 未声明 testPaths，无法判定任何结论的来源'}</strong>
                <small>{testProvenance.agentModifiedTestFiles.length ? `本次运行改动了 ${testProvenance.agentModifiedTestFiles.length} 个声明的测试文件` : '本次运行未改动任何声明的测试文件'}</small>
              </div>
            </div>
            <div className="local-provenance-columns">
              <div><small>Head（含本次新增 / 修改的测试）</small>{testProvenance.headConclusions.map((item) => <code key={`head-${item.name}`}>{item.name} · {item.conclusion}</code>)}</div>
              <div><small>Baseline（测试目录重置回 {testProvenance.baseSha.slice(0, 8)}）</small>{testProvenance.baselineConclusions.length ? testProvenance.baselineConclusions.map((item) => <code key={`base-${item.name}`}>{item.name} · {item.conclusion}</code>)  : <code>未重跑</code>}</div>
            </div>
            {testProvenance.agentModifiedTestFiles.length > 0 && <div className="local-provenance-files">{testProvenance.agentModifiedTestFiles.map((path) => <code key={path}>{path}</code>)}</div>}
            <small>{testProvenance.note}</small>
            <small>声明的测试路径：{testProvenance.declaredTestPaths.length ? testProvenance.declaredTestPaths.join(' · ') : 'Manifest 未声明 testPaths，无法区分既有与新增测试'}</small>
          </section>}
          <section><span>Checks</span>{evidencePreview.evidencePackage.checks.length ? evidencePreview.evidencePackage.checks.map((check) => <article className={`local-evidence-check ${check.conclusion}`} key={check.id}>
            <div><strong>{check.name}</strong><em>{check.kind ?? 'test'} · {check.conclusion} · {check.durationMs}ms · exit {check.exitCode ?? 'n/a'}</em>{check.provenance && <span className={`local-check-provenance ${check.provenance}`} title={check.provenance === 'pre_existing' ? '测试目录已重置回 Base，本次变更无法影响这条结论' : check.provenance === 'all_tests' ? '包含本次变更自带的测试，不能单独作为关键验收标准的证据' : 'Manifest 未声明 testPaths，无法判定来源'}>{check.provenance === 'pre_existing' ? '既有测试' : check.provenance === 'all_tests' ? '含本次新增' : '来源未验证'}</span>}</div>
            {check.metrics && <div className="local-evidence-metrics">{Object.entries(check.metrics).map(([metric, value]) => <span key={metric}><small>{metric}</small><strong>{value}</strong></span>)}</div>}
            {check.thresholdResults?.map((threshold) => <div className={`local-evidence-threshold ${threshold.passed ? 'passed' : 'failed'}`} key={`${check.id}-${threshold.metric}`}><span>{threshold.metric}</span><code>{threshold.actual ?? 'missing'} {threshold.operator} {threshold.threshold}</code><strong>{threshold.passed ? 'PASS' : 'BLOCK'}</strong></div>)}
            {check.stdoutExcerpt && <pre>{check.stdoutExcerpt}</pre>}{check.stderrExcerpt && <pre className="stderr">{check.stderrExcerpt}</pre>}<code>{check.stdoutDigest}</code>
          </article>) : <p className="local-evidence-empty">没有配置自动 Check；中高风险变更不能批准。</p>}</section>
          {evidencePreview.evidencePackage.artifacts && <section><span>Build Provenance</span>{evidencePreview.evidencePackage.artifacts.length ? evidencePreview.evidencePackage.artifacts.map((artifact) => <div className="local-evidence-artifact" key={artifact.path}><div><strong>{artifact.path}</strong><small>{artifact.sizeBytes} bytes · generated by {artifact.generatedByCheck}</small></div><code>{artifact.sha256}</code><em>source {artifact.sourceCommitSha.slice(0, 12)} · production eligible {String(artifact.productionEligible)}</em></div>) : <p className="local-evidence-empty">Manifest 声明了构建产物，但没有产物通过 Attestation。</p>}</section>}
          <section><span>Runtime</span><div className="local-evidence-runtime"><code>{evidencePreview.evidencePackage.run.adapterId}</code><small>{evidencePreview.evidencePackage.run.isolation} · {evidencePreview.evidencePackage.run.networkEgress} egress · production eligible {String(evidencePreview.evidencePackage.run.productionEligible)}</small></div></section>
        </aside>
      </>}
    </section>
  )
}

function LocalReleaseCandidates() {
  const local = useLocalControlPlane()
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  if (local.status !== 'ready') return null
  const canManage = Boolean(local.actor && ['owner', 'maintainer'].includes(local.currentProjectRole ?? ''))
  const candidatesByProposal = new Map(local.releaseCandidates.map((candidate) => [candidate.changeProposalId, candidate]))
  const mergedProposals = local.changeProposals.filter((proposal) => proposal.status === 'merged')
  const createCandidate = async (proposalId: string) => {
    setBusyId(proposalId)
    setError(undefined)
    try { await local.createReleaseCandidate(proposalId) } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) } finally { setBusyId(undefined) }
  }
  const approveCandidate = async (candidateId: string) => {
    setBusyId(candidateId)
    setError(undefined)
    try { await local.approveReleaseCandidate(candidateId, 'Merge Evidence 与 Source Snapshot Digest 已复验，批准该发布候选。') } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) } finally { setBusyId(undefined) }
  }
  return <section className="panel local-release-candidates"><div className="local-core-heading"><div><span className="eyebrow">真实数据 · 本地发布</span><h2>Merged Revision → Source Snapshot</h2><p>当前只封存 Source Tree Digest 与独立发布批准；不执行部署，也不冒充二进制制品证明。</p></div><span>{local.releaseCandidates.filter((candidate) => candidate.status === 'approved').length} approved</span></div>{mergedProposals.length === 0 ? <div className="local-empty"><PackageCheck size={18} /><p>尚无已合并 Change Proposal；Release Candidate 必须从 Merge Evidence 创建。</p></div> : <div className="local-release-list">{mergedProposals.map((proposal) => { const candidate = candidatesByProposal.get(proposal.id); const selfApproval = candidate?.createdByActorId === local.actor?.id; return <article key={proposal.id}><div><span className={`local-status ${candidate?.status ?? 'review_ready'}`}>{candidate?.status ?? 'not_created'}</span><strong>{workItemLabel(local.workItems.find((item) => item.id === proposal.workItemId)) ?? proposal.workItemId}</strong><small>{proposal.id} · commit {proposal.headSha.slice(0, 12)}</small></div>{candidate ? <><div className="local-release-digests"><code title={candidate.sourceTreeDigest}>{candidate.sourceTreeDigest}</code><small>{candidate.sourceFileCount} source files · {candidate.contentDigest}</small></div><div className="local-release-actions">{candidate.approval ? <span><ShieldCheck size={13} />{candidate.approval.approverActorId.slice(-8)} · approved</span> : <button className="approve-button" disabled={!canManage || selfApproval || busyId === candidate.id} onClick={() => void approveCandidate(candidate.id)}><Check size={13} />{selfApproval ? '需要独立 Maintainer' : '批准候选'}</button>}</div></> : <button className="secondary-button" disabled={!canManage || busyId === proposal.id} onClick={() => void createCandidate(proposal.id)}><Plus size={13} />{busyId === proposal.id ? '封存中' : '创建候选'}</button>}</article> })}</div>}{error && <p className="local-form-error" role="alert">{error}</p>}</section>
}

function ReleasePage() {
  const { releaseApproved, releaseApprovalTarget, releaseApprovedBy, approveRelease, deployments, deployRelease, rollbacks, rollbackDeployment, liveRun, githubPullRequests, currentActorId, teamMembers, canCurrentActor, recordAutonomyDecision } = useWorkbench()
  const [deploying, setDeploying] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const releaseDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('/', '.')
  const liveCandidate = liveRun?.reviewDecision === 'approved' ? liveRun : null
  const authoritativePullRequest = githubPullRequests[0]
  const candidateId = liveCandidate ? `RC-${releaseDate}-${liveCandidate.runId.slice(-4)}-${authoritativePullRequest?.headSha.slice(0, 7) ?? 'local'}` : `RC-${releaseDate}-3-${authoritativePullRequest?.headSha.slice(0, 7) ?? 'sample'}`
  const approved = releaseApproved && releaseApprovalTarget === candidateId
  const deployment = deployments.find((item) => item.releaseCandidateId === candidateId && item.environment === 'production' && item.status === 'succeeded')
  const rollback = deployment ? rollbacks.find((item) => item.deploymentId === deployment.deploymentId && item.status === 'succeeded') : undefined
  const evaluation = liveCandidate?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const evaluationDiagnosis = liveCandidate?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_diagnosed' }> => event.type === 'evaluation_diagnosed')
  const sandboxAttestation = liveCandidate?.events.find((event): event is Extract<AgentRunEvent, { type: 'sandbox_attested' }> => event.type === 'sandbox_attested')
  const artifacts = liveCandidate?.events.filter((event) => event.type === 'artifact_created') ?? []
  const ciEvidence = liveCandidate?.events.filter((event) => event.type === 'ci_evidence_ingested') ?? []
  const policyDenials = liveCandidate?.events.filter((event) => event.type === 'policy_decided' && event.decision.decision === 'deny') ?? []
  const pullRequestChecksPassed = authoritativePullRequest ? authoritativePullRequest.checks.every((check) => check.status === 'completed' && check.conclusion !== 'failure' && check.conclusion !== 'cancelled') : true
  const pullRequestGateReady = !authoritativePullRequest || (authoritativePullRequest.reviewDecision === 'approved' && pullRequestChecksPassed)
  const evidenceGateReady = liveCandidate ? Boolean(liveCandidate.integrityValid && liveCandidate.evidencePackage?.repositoryVerified) : authoritativePullRequest ? Boolean(authoritativePullRequest.evidenceUri) : true
  const proposedContract = liveCandidate?.events.find((event) => event.type === 'work_contract_proposed')
  const contractReview = liveCandidate?.events.find((event) => event.type === 'work_contract_reviewed')
  const contractGateReady = !proposedContract || Boolean(contractReview?.decision === 'accepted' && contractReview.contractId === proposedContract.contractId && contractReview.contractDigest === proposedContract.contractDigest && contractReview.evaluatorRef !== contractReview.generatorRef)
  const managedCandidate = liveCandidate?.events.some((event) => event.type === 'runtime_bound') ?? false
  const sandboxGateReady = !managedCandidate || Boolean(sandboxAttestation?.status === 'verified' && sandboxAttestation.ephemeral && sandboxAttestation.networkEgress !== 'unrestricted' && sandboxAttestation.secretMounts.length === 0)
  const releasePreconditionsReady = pullRequestGateReady && evidenceGateReady && contractGateReady && sandboxGateReady
  const autonomyRun = liveCandidate ?? liveRun
  const autonomyEvaluation = autonomyRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const autonomyCiFailed = autonomyRun?.events.filter((event) => event.type === 'ci_evidence_ingested' && event.status === 'failed').length ?? 0
  const autonomySandbox = autonomyRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'sandbox_attested' }> => event.type === 'sandbox_attested')
  const autonomyInput: AutonomyDecisionInput = {
    candidateId,
    programPhase: 'human_approval',
    riskTier: (autonomyEvaluation?.failed ?? 0) > 0 || policyDenials.length > 0 ? 'medium' : 'low',
    repositoryOnly: true,
    sandboxVerified: autonomyRun ? Boolean(autonomySandbox?.status === 'verified' && autonomySandbox.ephemeral && autonomySandbox.networkEgress !== 'unrestricted' && autonomySandbox.secretMounts.length === 0) : true,
    sessionIntegrityValid: autonomyRun?.integrityValid ?? true,
    evidenceVerified: autonomyRun ? Boolean(autonomyRun.evidencePackage?.repositoryVerified) : true,
    evaluationFailed: autonomyEvaluation?.failed ?? 0,
    ciFailed: autonomyCiFailed,
    unresolvedPolicyDenials: 0,
    externalEgress: autonomySandbox?.networkEgress === 'unrestricted',
    destructiveChange: false,
    productionImpact: false,
    identityAnchored: autonomyRun?.attestation?.verification.identityAnchored ?? false,
    humanReviewApproved: autonomyRun?.reviewDecision === 'approved',
  }
  const autonomyDecision = new LocalAutonomyDecisionProvider().evaluate(autonomyInput)
  useEffect(() => { recordAutonomyDecision(autonomyInput, autonomyDecision) }, [autonomyDecision.decisionDigest])
  const releaseActor = teamMembers.find((member) => member.id === currentActorId)
  const releasePermissionReady = canCurrentActor('approve_release')
  const executeDeployment = async () => {
    setDeploying(true)
    try { await deployRelease(candidateId) } finally { setDeploying(false) }
  }
  const executeRollback = async () => {
    if (!deployment) return
    setRollingBack(true)
    try { await rollbackDeployment(deployment.deploymentId, '人工确认生产异常，恢复上一稳定 Artifact') } finally { setRollingBack(false) }
  }
  const gates = [
    { label: 'Intent 与工作契约', detail: liveCandidate ? contractGateReady ? `${proposedContract?.criteria.length ?? 0} 条标准 · ${contractReview?.evaluatorRef ?? 'independent evaluator'} 已确认` : '生成者与独立评估者尚未确认同一契约' : '4 / 4 Critical AC 已关联证据', state: contractGateReady ? 'passed' : 'pending' },
    { label: 'Evaluation 门禁', detail: liveCandidate ? `${evaluation?.passed ?? 0} passed · ${evaluation?.failed ?? 0} failed · ${evaluationDiagnosis ? evaluationDiagnosis.failures.map((failure) => failure.category).join(' / ') : '等待失败归因'} 已在运行门禁确认` : 'pass@3 93% · pass³ 71%', state: 'passed' },
    { label: 'Tests + Docs + Evidence', detail: liveCandidate ? `${artifacts.filter((event) => event.type === 'artifact_created' && event.artifactType === 'test').length} test · ${artifacts.filter((event) => event.type === 'artifact_created' && event.artifactType === 'documentation').length} docs · ${ciEvidence.length} CI · ${liveCandidate.evidencePackage?.repositoryVerified ? 'repository verified' : 'evidence unverified'}` : authoritativePullRequest ? authoritativePullRequest.evidenceUri ?? 'PR 尚未回写 Evidence URI' : '142 tests passed · 3 docs updated', state: evidenceGateReady ? 'passed' : 'pending' },
    { label: '安全与策略', detail: liveCandidate ? sandboxGateReady ? `${sandboxAttestation?.isolation} · ${sandboxAttestation?.networkEgress} · ${policyDenials.length} 个越界请求已阻断` : 'Sandbox Attestation 未通过' : '2 warnings 已接受 · 0 blockers', state: sandboxGateReady ? 'passed' : 'pending' },
    { label: 'GitHub Review 与 Checks', detail: authoritativePullRequest ? `PR #${authoritativePullRequest.externalId} · ${authoritativePullRequest.reviewDecision} · ${authoritativePullRequest.checks.filter((check) => check.conclusion === 'success').length}/${authoritativePullRequest.checks.length} success` : liveCandidate ? 'Wangzhen 已批准变更' : 'Mia Chen + Alex Wu 已批准', state: authoritativePullRequest && (authoritativePullRequest.reviewDecision !== 'approved' || !pullRequestChecksPassed) ? 'pending' : 'passed' },
    { label: '生产写入授权', detail: approved ? `${releaseApprovedBy ?? 'unknown identity'} 已批准` : releasePermissionReady ? `等待 ${releaseActor?.name ?? 'Owner'} 具名批准` : `${releaseActor?.name ?? '当前角色'} 无生产授权权限`, state: approved ? 'passed' : 'pending' },
  ]

  return (
    <>
      <PageHeader
        title="发布"
        description="Control Plane 不替代部署系统，但负责确认什么可以进入下一环境，以及凭什么。"
      />

      <LocalReleaseCandidates />
      <DemoRegion title="自治、部署与回滚" note="以下自治、部署与回滚区域仍为 Lab 演示，不读取本地 Release Candidate 作为生产授权。">

        <section className={`panel autonomy-posture ${autonomyDecision.decision}`}><span><Zap size={19} /></span><div><h2>{autonomyDecision.decision === 'blocked' ? '自治路径被确定性控制阻断' : autonomyDecision.decision === 'auto_merge_eligible' ? '满足低风险自动合并资格' : '当前阶段必须具名人工审批'}</h2><p>{autonomyDecision.reasons.join(' · ')}</p></div><div><span>{autonomyDecision.riskTier} risk · {autonomyDecision.policyId}@{autonomyDecision.policyVersion}</span><code>{autonomyDecision.decisionDigest}</code><small>{autonomyDecision.requiredControls.join(' · ')}</small></div></section>

        <section className={`release-readiness panel ${approved ? 'ready' : ''} ${deployment ? 'deployed' : ''} ${rollback ? 'rolled-back' : ''}`}>
          <div className="release-score"><strong>{gates.filter((gate) => gate.state === 'passed').length}/6</strong><span>Release Gates</span></div>
          <div className="release-readiness-copy"><span className="eyebrow">{candidateId}</span><h2>{rollback ? 'Production 已恢复上一稳定版本' : deployment ? 'Production 部署已完成' : approved ? '已满足生产发布条件' : releasePreconditionsReady ? '发布候选等待最后授权' : !sandboxGateReady ? 'Sandbox Attestation 未通过' : !contractGateReady ? '工作契约尚未独立确认' : !pullRequestGateReady ? 'GitHub 权威门禁未通过' : 'Evidence Repository 未复验'}</h2><p>{rollback ? `${rollback.rollbackId} · ${rollback.requestedBy} · restored` : deployment ? `${deployment.deploymentId} · ${deployment.providerId} · rollback ready` : authoritativePullRequest ? `PR #${authoritativePullRequest.externalId} · ${authoritativePullRequest.headSha.slice(0, 7)} · ${authoritativePullRequest.reviewDecision}` : liveCandidate ? `${liveCandidate.label} · ${liveCandidate.runId} · Session Evidence ready` : '企业 SSO 登录 · INT-142 · PR #428 · commit 8f3a2c1'}</p></div>
          <div className="release-readiness-actions"><span className={approved ? 'release-status ready' : 'release-status waiting'}>{rollback ? 'Rolled back' : deployment ? 'Deployed' : approved ? 'Ready to ship' : !releasePermissionReady ? 'Owner required' : releasePreconditionsReady ? 'Approval required' : !sandboxGateReady ? 'Sandbox blocked' : !contractGateReady ? 'Contract blocked' : !pullRequestGateReady ? 'PR blocked' : 'Evidence blocked'}</span>{!approved && <button className="approve-button" disabled={!releasePreconditionsReady || !releasePermissionReady} onClick={() => approveRelease(candidateId)}><Check size={15} />{!releasePermissionReady ? '需要 Owner 授权' : releasePreconditionsReady ? '批准生产发布' : !sandboxGateReady ? '等待 Sandbox 复验' : !contractGateReady ? '等待契约确认' : !pullRequestGateReady ? '等待 PR 通过' : '等待 Evidence 复验'}</button>}{approved && !deployment && <button className="approve-button" disabled={deploying} onClick={() => void executeDeployment()}><ServerCog size={15} />{deploying ? '部署中' : '部署到 Production'}</button>}</div>
        </section>

        <section className="release-layout">
          <div className="panel release-gates">
            <div className="release-heading"><div><h2>发布门禁</h2><p>由 Evidence、Policy 和具名审批共同决定</p></div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><FileCheck2 size={14} />查看证据包</button></div>
            {gates.map((gate) => <div className="release-gate-row" key={gate.label}><span className={gate.state}>{gate.state === 'passed' ? <Check size={14} /> : <Clock3 size={14} />}</span><div><strong>{gate.label}</strong><small>{gate.detail}</small></div><em className={gate.state}>{gate.state === 'passed' ? '通过' : '等待'}</em></div>)}
          </div>

          <aside className="release-side">
            <div className="panel environment-progress">
              <div className="release-heading"><div><h2>环境推进</h2><p>外部部署系统状态投影</p></div><ServerCog size={17} /></div>
              {[
                ['Build', '完成', '2m 14s', 'done'], ['Staging', '完成', '8m 42s', 'done'], ['Verification', '完成', '6m 08s', 'done'], ['Production', rollback ? '已回滚' : deployment ? '部署完成' : approved ? '可以部署' : '等待授权', rollback ? rollback.rollbackId : deployment ? deployment.deploymentId : approved ? 'Ready' : 'Blocked', rollback ? 'blocked' : deployment ? 'done' : approved ? 'ready' : 'blocked'],
              ].map(([stage, state, time, tone], index) => <div className={`environment-row ${tone}`} key={stage}><span>{tone === 'done' ? <Check size={13} /> : index + 1}</span><div><strong>{stage}</strong><small>{state}</small></div><em>{time}</em></div>)}
            </div>
            <div className="panel rollback-card">
              <div className="release-heading"><div><h2>回滚计划</h2><p>在发布前验证恢复路径</p></div><Undo2 size={17} /></div>
              <div className="rollback-body"><span><PackageCheck size={16} /></span><div><strong>{deployment ? '部署 Artifact 与回滚引用已封存' : 'Artifact 已签名并保留'}</strong><p>{deployment ? deployment.rollbackRef : '上一稳定版本 v0.8.14，可在 3 分钟内恢复。'}</p></div></div>
              <div className="rollback-meta"><span>数据库变更</span><strong>Backward compatible</strong></div><div className="rollback-meta"><span>回滚演练</span><strong>2 天前通过</strong></div>
              {deployment && !rollback && <button className="secondary-button rollback-action" disabled={!releasePermissionReady || rollingBack} onClick={() => void executeRollback()}><Undo2 size={14} />{!releasePermissionReady ? '需要 Owner 回滚' : rollingBack ? '回滚中' : '执行 Production 回滚'}</button>}
              {rollback && <div className="rollback-complete"><Check size={14} /><span>{rollback.rollbackId} · {rollback.restoredArtifactDigest}</span></div>}
            </div>
          </aside>
        </section>
      </DemoRegion>
    </>
  )
}

function EvaluationPage() {
  const { convertedSignals, regressionAssets, liveRun, convertSignal } = useWorkbench()
  const [scope, setScope] = useState<'全部' | '回归' | '发布门禁'>('全部')
  const [selectedTask, setSelectedTask] = useState<EvalTaskItem | null>(null)
  const derivedRegressions = convertedSignals.filter((signal) => signal.outputType === 'regression')
  const liveEvaluation = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const liveDiagnosis = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_diagnosed' }> => event.type === 'evaluation_diagnosed')
  const liveExperiment = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_experiment_bound' }> => event.type === 'evaluation_experiment_bound')
  const liveTrace = liveRun?.traceProjection?.document
  const liveHarnessSelection = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'harness_profile_selected' }> => event.type === 'harness_profile_selected')
  const diagnosisLabels = { agent: 'Agent failure', task: 'Task ambiguity', grader: 'Grader defect', harness: 'Harness failure', infrastructure: 'Infrastructure noise' } as const
  const diagnosisTones = { agent: 'rose', task: 'violet', grader: 'amber', harness: 'blue', infrastructure: 'amber' } as const
  const liveFailureTasks: EvalTaskItem[] = liveRun && liveDiagnosis ? liveDiagnosis.failures.map((failure) => ({ id: failure.taskId, title: failure.summary, kind: diagnosisLabels[failure.category], detail: `${Math.round(failure.confidence * 100)}% confidence · ${failure.evidenceRefs.length} evidence refs`, tone: diagnosisTones[failure.category], liveRunId: liveRun.runId, remediationType: failure.category === 'infrastructure' || failure.category === 'harness' ? 'intent' : 'regression' })) : liveRun && liveEvaluation?.failed ? [{ id: `TASK-${liveRun.runId}`, title: `${liveRun.label}评估失败`, kind: 'Unattributed failure', detail: `${liveEvaluation.failed}/${liveEvaluation.passed + liveEvaluation.failed + liveEvaluation.unknown} aggregate results failed`, tone: 'rose', liveRunId: liveRun.runId, remediationType: 'regression' }] : []
  const suites = [
    { id: 'EVS-014', title: '企业 SSO 行为评估', tasks: 42, trials: 126, passAt3: 93, pass3: 71, grader: 'Tests + Model', status: 'attention', scope: '发布门禁' },
    { id: 'EVS-011', title: 'Agent 权限边界回归', tasks: 36, trials: 108, passAt3: 98, pass3: 89, grader: 'Deterministic', status: 'healthy', scope: '回归' },
    { id: 'EVS-009', title: 'Evidence Summary 可读性', tasks: 24, trials: 72, passAt3: 88, pass3: 62, grader: 'Model + Human', status: 'attention', scope: '全部' },
    { id: 'EVS-006', title: 'GitHub 同步可靠性', tasks: 31, trials: 93, passAt3: 96, pass3: 84, grader: 'Deterministic', status: 'healthy', scope: '回归' },
  ]
  const failureTasks: EvalTaskItem[] = [
    { id: 'TASK-SSO-018', title: '多租户身份冲突处理', kind: 'Agent failure', detail: '2/3 trials failed', tone: 'rose' },
    { id: 'TASK-POL-027', title: '符号链接目录逃逸', kind: 'Grader bug', detail: 'Expected state ambiguous', tone: 'amber' },
    { id: 'TASK-EVD-011', title: '摘要遗漏新增测试来源', kind: 'Regression', detail: 'Blocked release', tone: 'violet' },
  ]
  const visibleSuites = suites.filter((suite) => scope === '全部' || suite.scope === scope)
  const harnessCandidates = liveHarnessSelection?.candidates ?? [
    { profileId: 'single-session-v1', executionMode: 'prompt_chain' as const, contextResetPolicy: 'continuous' as const, passRate: 0.78, p95DurationSeconds: 520, estimatedCostUsd: 2.1, evidenceRef: 'eval://harness-ablation/sample/single-session' },
    { profileId: 'evaluator-loop-v2', executionMode: 'evaluator_optimizer' as const, contextResetPolicy: 'fresh_session_per_phase' as const, passRate: 0.93, p95DurationSeconds: 690, estimatedCostUsd: 4.8, evidenceRef: 'eval://harness-ablation/sample/evaluator-loop' },
    { profileId: 'orchestrator-workers-v3', executionMode: 'orchestrator_workers' as const, contextResetPolicy: 'phase_boundary_compaction' as const, passRate: 0.96, p95DurationSeconds: 680, estimatedCostUsd: 5.42, evidenceRef: 'eval://harness-ablation/sample/orchestrator-workers' },
  ]
  const selectedHarnessId = liveHarnessSelection?.profileId ?? 'orchestrator-workers-v3'

  return (
    <>
      <PageHeader
        title="评估"
        description="把真实任务、独立试验、Grader 和 Transcript 变成持续维护的质量系统。"
      />
      <DemoRegion title="评估套件" note="本页评估套件与阈值为演示数据；真实的 Check 结论、阈值判定与测试独立性标注在「评审队列」的证据包中。">

        <section className="metric-grid eval-metrics">
          <MetricCard icon={FlaskConical} label="活跃 Eval Suites" value="14" change="+2 本月" tone="violet" />
          <MetricCard icon={CheckCircle2} label="pass@3" value="94%" change="至少一次成功" tone="green" />
          <MetricCard icon={ShieldCheck} label="pass³" value="76%" change="连续三次成功" tone="blue" />
          <MetricCard icon={ShieldAlert} label="回归失败" value={String(3 + (liveEvaluation?.failed ?? 0))} change={liveEvaluation?.failed ? `${liveRun?.runId} 新增 ${liveEvaluation.failed} 项` : '2 项阻断发布'} tone="amber" />
        </section>

        <section className="panel evaluation-experiment-strip"><span><Database size={18} /></span><div><h2>{liveExperiment ? liveExperiment.experimentId : '等待 Managed Run 绑定 Evaluation Experiment'}</h2><p>{liveExperiment ? `${liveExperiment.datasetRef}@${liveExperiment.datasetVersion} · ${liveExperiment.graderRefs.length} graders · ${liveExperiment.trialCount} trials` : '评估结果必须绑定版本化 Dataset、Candidate、Trace、Grader 和隔离环境摘要。'}</p></div><div><span>{liveTrace ? `Sanitized OTel projection · ${liveTrace.spans.length} spans` : 'Trace / Environment'}</span><code>{liveExperiment ? `${liveTrace?.traceId ?? liveExperiment.traceRef} · ${liveExperiment.environmentDigest}` : 'not bound'}</code></div></section>

        <section className="eval-pipeline panel">
          <div className="eval-pipeline-copy"><h2>Task → Trial → Grader → Transcript → Regression</h2><p>先定义成功，再运行 Agent；把失败分类为能力、任务、评分器或环境问题。</p></div>
          <div className="eval-pipeline-steps">
            {[
              { label: 'Tasks', value: String(133 + liveFailureTasks.length), icon: FileText }, { label: 'Trials', value: '399', icon: GitBranch }, { label: 'Graders', value: '27', icon: CheckCircle2 }, { label: 'Transcripts', value: String(399 + (liveRun ? 1 : 0)), icon: FileCode2 }, { label: 'Regressions', value: String(3 + derivedRegressions.length), icon: RefreshCw },
            ].map(({ label, value, icon: Icon }, index, array) => (
              <div className="eval-pipeline-step" key={label}><span><Icon size={15} /></span><strong>{value}</strong><small>{label}</small>{index < array.length - 1 && <ChevronRight size={14} />}</div>
            ))}
          </div>
        </section>

        <section className="harness-ablation panel">
          <div className="harness-ablation-heading"><div><h2>用可靠性、成本与模型上下文能力选择编排</h2><p>{liveHarnessSelection?.selectionReason ?? '样例基线：候选 Profile 使用相同任务集与独立 Grader 比较。'}</p></div><span>{liveHarnessSelection ? `${liveHarnessSelection.modelContextBehavior} context · ${liveHarnessSelection.candidateCount} candidates` : 'sample evidence'}</span></div>
          <div className="harness-ablation-grid"><div className="harness-ablation-head"><span>Profile</span><span>Mode / Reset</span><span>Reliability</span><span>P95</span><span>Cost</span><span>Decision</span></div>{harnessCandidates.map((candidate) => { const selected = candidate.profileId === selectedHarnessId; return <div className={`harness-ablation-row ${selected ? 'selected' : ''}`} key={candidate.profileId}><span><strong>{candidate.profileId}</strong><small>{candidate.evidenceRef}</small></span><span><strong>{candidate.executionMode}</strong><small>{candidate.contextResetPolicy}</small></span><span>{Math.round(candidate.passRate * 100)}%</span><span>{candidate.p95DurationSeconds}s</span><span>${candidate.estimatedCostUsd.toFixed(2)}</span><span>{selected ? <><Check size={13} />Selected</> : 'Compared'}</span></div> })}</div>
        </section>

        {liveDiagnosis && <section className="eval-diagnosis-banner panel"><div><h3>失败先归因，再决定改 Agent、Task、Grader、Harness 或环境</h3><p>{liveDiagnosis.failures.map((failure) => `${failure.category} ${Math.round(failure.confidence * 100)}%`).join(' · ')}</p></div><div><span>Transcript</span><strong>{liveDiagnosis.transcriptReviewed ? '已人工检查' : '待检查'}</strong></div><div><span>Environment</span><strong>{liveDiagnosis.environment.cleanStart ? 'Clean start' : 'Contaminated'}</strong><small>{liveDiagnosis.environment.sharedStateDetected ? 'shared state detected' : 'no shared state'}</small></div><div><span>Image digest</span><code>{liveDiagnosis.environment.imageDigest}</code></div></section>}

        <div className="eval-layout">
          <section className="panel eval-suites">
            <div className="eval-toolbar">
              <div><h2>Eval Suites</h2><p>最近一次基线运行</p></div>
              <div className="segmented-control">
                {(['全部', '回归', '发布门禁'] as const).map((item) => <button className={scope === item ? 'active' : ''} onClick={() => setScope(item)} key={item}>{item}</button>)}
              </div>
            </div>
            <div className="eval-suite-head eval-suite-grid"><span>评估套件</span><span>Tasks / Trials</span><span>Grader</span><span>pass@3</span><span>pass³</span><span>状态</span></div>
            {visibleSuites.map((suite) => (
              <button className="eval-suite-row eval-suite-grid" key={suite.id} disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">
                <span className="eval-suite-title"><FlaskConical size={15} /><span><strong>{suite.title}</strong><small>{suite.id}</small></span></span>
                <span>{suite.tasks} / {suite.trials}</span><span>{suite.grader}</span><span>{suite.passAt3}%</span><span>{suite.pass3}%</span>
                <span className={`eval-health ${suite.status}`}>{suite.status === 'healthy' ? '健康' : '需关注'}</span>
              </button>
            ))}
          </section>

          <aside className="panel eval-failures">
            <div className="eval-toolbar"><div><h2>需要诊断</h2><p>按影响和置信度排序</p></div><span className="eval-count">{3 + derivedRegressions.length + liveFailureTasks.length}</span></div>
            {liveFailureTasks.map((task) => { const signalId = `EVAL-${liveRun?.runId}-${task.id}`; const converted = convertedSignals.find((signal) => signal.signalId === signalId); const remediationType = task.remediationType ?? 'regression'; return <div className="eval-live-failure" key={task.id}><span className={`eval-failure-icon ${task.tone}`}>!</span><button className="eval-live-main" onClick={() => setSelectedTask(task)}><strong>{task.title}</strong><small>{task.id} · {task.kind}</small><em>{task.detail}</em></button><button className={`signal-action ${converted ? 'done' : ''}`} disabled={Boolean(converted)} onClick={() => convertSignal(signalId, `${liveRun?.label}：${task.title}`, remediationType)}>{converted ? `${converted.outputId} 已创建` : remediationType === 'intent' ? '创建修复 Intent' : '创建 Regression'}</button></div> })}
            {derivedRegressions.map((regression) => { const asset = regressionAssets.find((item) => item.outputId === regression.outputId); const task: EvalTaskItem = { id: regression.outputId, title: regression.title, kind: 'Regression asset', detail: asset?.baselineCaptured ? `${asset.trialsRun} Trials · pass@3 ${asset.passAtK}% · pass³ ${asset.passPowerK}%` : '等待补齐 Evaluation Contract', tone: asset?.passPowerK === 100 ? 'green' : 'amber', derived: true, regressionId: regression.outputId }; return <button className="eval-failure-row derived" key={regression.outputId} onClick={() => setSelectedTask(task)}><span className={`eval-failure-icon ${asset?.passPowerK === 100 ? 'green' : 'amber'}`}><RefreshCw size={12} /></span><span><strong>{regression.title}</strong><small>{regression.outputId} · Regression asset</small><em>{asset?.baselineCaptured ? `${asset.trialsRun} Trials · pass@3 ${asset.passAtK}% · pass³ ${asset.passPowerK}%` : `${[asset?.fixtureReady, asset?.graderReady, asset?.referenceReady].filter(Boolean).length} / 3 合同组件已准备`}</em></span><ChevronRight size={15} /></button> })}
            {failureTasks.map((task) => (
              <button className="eval-failure-row" key={task.id} onClick={() => setSelectedTask(task)}><span className={`eval-failure-icon ${task.tone}`}>!</span><span><strong>{task.title}</strong><small>{task.id} · {task.kind}</small><em>{task.detail}</em></span><ChevronRight size={15} /></button>
            ))}
            <div className="eval-guidance"><Sparkles size={15} /><p><strong>诊断建议</strong>先阅读失败 Trial 的 Transcript，再决定修改 Agent、Task、Grader 或环境。</p></div>
          </aside>
        </div>
        {selectedTask && <EvalTaskDrawer task={selectedTask} onClose={() => setSelectedTask(null)} />}
      </DemoRegion>
    </>
  )
}

function EvidencePage() {
  const { liveRun } = useWorkbench()
  const [lastPackageDigest, setLastPackageDigest] = useState<string | null>(null)
  const repositoryVerified = liveRun?.evidencePackage?.repositoryVerified ?? false
  const attestation = liveRun?.attestation
  const attestationValid = attestation?.verification.valid ?? false
  const traceProjection = liveRun?.traceProjection
  const liveEvaluation = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const liveArtifacts = liveRun?.events.filter((event) => event.type === 'artifact_created') ?? []
  const liveCiEvidence = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'ci_evidence_ingested' }> => event.type === 'ci_evidence_ingested') ?? []
  const liveDenied = liveRun?.events.filter((event) => event.type === 'policy_decided' && event.decision.decision === 'deny') ?? []
  const liveConsumed = liveRun?.events.filter((event) => event.type === 'context_consumed') ?? []
  const liveBlocked = liveRun?.events.filter((event) => event.type === 'context_requested' && !event.declared) ?? []
  const liveNotes = liveRun?.events.filter((event) => event.type === 'context_note_written') ?? []
  const liveCompactions = liveRun?.events.filter((event) => event.type === 'context_compacted') ?? []
  const healthScore = liveEvaluation ? Math.round((liveEvaluation.passed / Math.max(liveEvaluation.passed + liveEvaluation.failed + liveEvaluation.unknown, 1)) * 100) : undefined
  const evidence = liveRun ? [
    ['Tests + Docs 产物', `${liveArtifacts.length} artifacts`, 'Patch · Test · Documentation', 'green'],
    ['CI Evidence', `${liveCiEvidence.length} reports`, liveCiEvidence.map((event) => `${event.kind}:${event.status}`).join(' · ') || '等待 JUnit / SARIF / Coverage', liveCiEvidence.some((event) => event.status === 'failed') ? 'amber' : 'green'],
    ['Evaluation', `${liveEvaluation?.passed ?? 0} passed`, `${liveEvaluation?.failed ?? 0} failed · ${liveEvaluation?.unknown ?? 0} unknown`, liveEvaluation?.failed ? 'amber' : 'green'],
    ['上下文工程', `${liveConsumed.length} consumed`, `${liveBlocked.length} blocked · ${liveNotes.length} notes · ${liveCompactions.length} compaction`, 'blue'],
    ['策略判定', `${liveDenied.length} denied`, 'Preventive policy decisions', 'violet'],
    ['Trace Projection', traceProjection ? `${traceProjection.document.spans.length} spans` : 'pending', traceProjection ? `${traceProjection.document.providerId} · sanitized attributes only` : '等待终态事件链生成脱敏投影', traceProjection ? 'blue' : 'amber'],
    ['Evidence Attestation', attestationValid ? 'signature valid' : attestation ? 'verification failed' : 'pending', attestation ? `${attestation.document.trustLevel} · identity unanchored` : '等待 Evidence Package 封存', attestationValid ? 'green' : 'amber'],
  ] : [
    ['单元与集成测试', '142 passed', '既有 + 本次新增', 'green'],
    ['安全扫描', '2 warnings', 'SARIF · Semgrep', 'amber'],
    ['上下文对账', '94% matched', 'Manifest / Actual', 'blue'],
    ['策略判定', '18 allowed · 3 denied', 'OPA decision log', 'violet'],
  ]
  const exportPackage = async () => {
    if (!liveRun) return
    const payload = createEvidencePackage(liveRun)
    const contentDigest = await sha256Hex(JSON.stringify(payload))
    const evidencePackage = { ...payload, integrity: { algorithm: 'SHA-256', scope: 'canonical JSON payload without integrity field', contentDigest } }
    setLastPackageDigest(contentDigest)
    downloadArtifact(`${liveRun.runId.toLowerCase()}-evidence-package.json`, JSON.stringify(evidencePackage, null, 2), 'application/json')
  }
  return (
    <>
      <PageHeader title="证据中心" description="用可移植、可追溯的事实支持每一次接受或拒绝决策。" />
      <DemoRegion title="证据列表" note="本页证据列表为演示数据；真实证据包由本地 Run 生成，入口在「评审队列」的“查看证据”。" actions={liveRun && <button className="secondary-button" onClick={exportPackage}><Archive size={13} />导出演示 Run 证据包</button>}>
        <div className="evidence-hero panel"><div><h2>{repositoryVerified ? `${liveRun?.runId} 证据包已持久封存` : liveRun?.evidencePackage ? `${liveRun.runId} 仓库复验失败` : liveRun ? `${liveRun.runId} 证据正在聚合` : '样例证据列表'}</h2><p>{lastPackageDigest ? `最近导出 SHA-256：${lastPackageDigest.slice(0, 16)}…${lastPackageDigest.slice(-8)}` : repositoryVerified ? `${liveRun?.events.length} 条追加写事件已由离线 Evidence Repository 重新加载并验证。` : liveRun?.evidencePackage ? 'Package 引用存在，但本地仓库内容、摘要链或包摘要不一致。' : liveRun ? `${liveRun.events.length} 条 Session 事件已投影为 Context、Policy、Artifact、Checkpoint、Evaluation 与 Review Evidence。` : '下列数字是手写的样例，不来自任何 Run；没有真实评估结果时不显示通过率。'}</p></div>{healthScore !== undefined && <div className="health-score-wrap"><div className="health-score" style={{ '--score': `${healthScore}%` } as React.CSSProperties}><strong>{healthScore}</strong><span>%</span></div><small>评估通过率</small></div>}</div>
        {liveRun && <div className={`evidence-package-status panel ${repositoryVerified ? 'sealed' : liveRun.evidencePackage ? 'failed' : 'pending'}`}><span>{repositoryVerified ? <PackageCheck size={19} /> : liveRun.evidencePackage ? <ShieldAlert size={19} /> : <Clock3 size={19} />}</span><div><strong>{repositoryVerified ? '本地 Evidence Repository 已复验' : liveRun.evidencePackage ? 'Evidence Repository 校验失败' : '等待终态封存'}</strong><p>{liveRun.evidencePackage?.uri ?? 'Run 结束且事件链验证通过后生成可复验 Package 引用。'}</p></div><div><span>{liveRun.evidencePackage ? `${liveRun.evidencePackage.finalizedAt} · ${repositoryVerified ? 'offline persisted' : 'verification failed'}` : 'append-only validation'}</span><code>{liveRun.evidencePackage?.digest ?? liveRun.events.at(-1)?.eventDigest ?? 'genesis'}</code></div></div>}
        {liveRun?.evidencePackage && <div className={`evidence-package-status attestation-status panel ${attestationValid ? 'sealed' : attestation ? 'failed' : 'pending'}`}><span>{attestationValid ? <Fingerprint size={19} /> : attestation ? <ShieldAlert size={19} /> : <Clock3 size={19} />}</span><div><strong>{attestationValid ? 'Evidence Attestation 密码学签名有效' : attestation ? 'Evidence Attestation 复验失败' : '等待生成 Evidence Attestation'}</strong><p>{attestation ? `${attestation.document.statement._type} · ${attestation.document.statement.predicateType}` : '封存后使用本地临时 ECDSA P-256 密钥签署 in-toto 风格声明。'}</p></div><div><span>{attestation ? `${attestation.verifiedAt} · ${attestation.document.trustLevel} · identity unanchored` : 'signature pending'}</span><code>{attestation?.document.keyId ?? 'no signer key'}</code></div></div>}
        {liveRun && <div className={`evidence-package-status trace-projection-status panel ${traceProjection ? 'sealed' : 'pending'}`}><span>{traceProjection ? <Activity size={19} /> : <Clock3 size={19} />}</span><div><strong>{traceProjection ? 'Trace Projection 已从签名事件链生成' : '等待生成 Trace Projection'}</strong><p>{traceProjection ? '仅导出 OTel 风格结构化属性；Prompt、Context 内容和 Tool Output 默认不导出。' : 'Run 终态且事件链通过协议校验后，生成可复验的脱敏追踪投影。'}</p></div><div><span>{traceProjection ? `${traceProjection.projectedAt} · ${traceProjection.document.spans.length} sanitized spans` : 'projection pending'}</span><code>{traceProjection?.document.traceId ?? 'no trace id'}</code></div></div>}
        <div className="evidence-grid">
          {evidence.map(([title, value, meta, tone]) => <article className={`evidence-card ${tone}`} key={title}><h3>{title}</h3><strong>{value}</strong><p>{meta}</p></article>)}
        </div>
        <div className="panel evidence-matrix"><PanelHeading title="验收标准证据矩阵" subtitle="样例变更，非真实数据" /><div className="matrix-row matrix-head"><span>验收标准</span><span>测试</span><span>扫描</span><span>人工审查</span><span>状态</span></div>{['企业账号可绑定身份', '会话撤销及时生效', '敏感目录不可读取', '异常操作可审计'].map((label, index) => <div className="matrix-row" key={label}><strong>{label}</strong><span><Check size={14} /></span><span className={index === 1 ? 'empty' : ''}>{index === 1 ? '—' : <Check size={14} />}</span><span>{index > 1 ? <Clock3 size={14} /> : <Check size={14} />}</span><span className={`matrix-status ${index > 1 ? 'pending' : 'passed'}`}>{index > 1 ? '待确认' : '已覆盖'}</span></div>)}</div>
      </DemoRegion>
    </>
  )
}

function TraceabilityPage() {
  const { events, releaseApproved, releaseApprovalTarget, convertedSignals, liveRun, githubPullRequests, telemetryExports, convertSignal, recordTelemetryExport, canCurrentActor } = useWorkbench()
  const local = useLocalControlPlane()
  const [traceScope, setTraceScope] = useState<'all' | 'tool' | 'policy' | 'evaluation'>('all')
  const today = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const liveRuntime = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'runtime_bound' }> => event.type === 'runtime_bound')
  const livePolicyBundle = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'policy_bundle_bound' }> => event.type === 'policy_bundle_bound')
  const liveEvaluation = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const liveContext = liveRun?.events.filter((event) => event.type === 'context_consumed') ?? []
  const livePackage = liveRun?.evidencePackage
  const liveTrace = liveRun?.traceProjection
  const traceSpans = liveTrace?.document.spans ?? []
  const scopedTraceSpans = traceSpans.filter((span) => traceScope === 'all'
    || (traceScope === 'tool' && typeof span.attributes['gen_ai.tool.name'] === 'string')
    || (traceScope === 'policy' && typeof span.attributes['aperture.policy.decision'] === 'string')
    || (traceScope === 'evaluation' && typeof span.attributes['aperture.evaluation.suite_id'] === 'string'))
  const visibleTraceSpans = scopedTraceSpans.slice(0, 8)
  const latestTelemetryExport = telemetryExports.find((record) => record.runId === liveRun?.runId && record.traceId === liveTrace?.document.traceId)
  const canExportTelemetry = canCurrentActor('export_telemetry')
  const exportTelemetry = () => {
    if (!liveTrace || !canExportTelemetry) return
    const bundle = new LocalOtlpFileExportProvider().prepare({ projection: liveTrace.document, serviceName: 'aperture-control-plane', environment: 'local' })
    recordTelemetryExport(bundle)
    downloadArtifact(bundle.fileName, JSON.stringify(bundle, null, 2), bundle.contentType)
  }
  const authoritativePullRequest = githubPullRequests[0]
  const chain = [
    { label: 'Intent', id: 'INT-142', icon: CircleDot, status: 'complete', meta: 'v3 · 4 AC' },
    { label: 'Context', id: 'CTX-142-v3', icon: FolderTree, status: liveRun && !liveContext.length ? 'pending' : 'complete', meta: liveRun ? `${liveContext.length} sources consumed` : '54.2K tokens' },
    { label: 'Run', id: liveRun?.runId ?? 'RUN-8821', icon: Bot, status: liveRun && !liveRun.events.some((event) => event.type === 'run_completed') ? 'attention' : 'complete', meta: liveRun?.status ?? '3 workers' },
    { label: 'Evaluation', id: liveEvaluation?.suiteId ?? 'EVS-014', icon: FlaskConical, status: liveEvaluation?.failed ? 'attention' : liveEvaluation ? 'complete' : 'pending', meta: liveEvaluation ? `${liveEvaluation.failed} failed · ${liveEvaluation.unknown} unknown` : '2 failed trials' },
    { label: 'Evidence', id: livePackage ? livePackage.uri.split('/').at(-1)?.replace('.json', '') ?? 'package' : liveRun ? 'pending' : 'EVD-8821', icon: FileCheck2, status: livePackage?.repositoryVerified && liveRun?.attestation?.verification.valid ? 'complete' : livePackage ? 'attention' : 'pending', meta: liveRun?.attestation?.verification.valid ? 'signed · identity unanchored' : livePackage?.repositoryVerified ? 'repository verified · signature pending' : livePackage ? 'verification failed' : 'awaiting terminal event' },
    { label: 'Review', id: authoritativePullRequest ? `PR #${authoritativePullRequest.externalId}` : liveRun?.reviewDecision ? liveRun.runId : 'PR #428', icon: GitPullRequest, status: authoritativePullRequest ? authoritativePullRequest.reviewDecision === 'approved' && authoritativePullRequest.checks.every((check) => check.conclusion !== 'failure') ? 'complete' : 'attention' : liveRun?.reviewDecision ? 'complete' : liveRun?.approved ? 'attention' : liveRun ? 'pending' : 'complete', meta: authoritativePullRequest ? `${authoritativePullRequest.reviewDecision} · ${authoritativePullRequest.headSha.slice(0, 7)}` : liveRun?.reviewDecision ?? (liveRun?.approved ? 'awaiting decision' : '2 approvals') },
    { label: 'Release', id: releaseApprovalTarget ?? `RC-${new Intl.DateTimeFormat('en-CA').format(new Date())}-3`, icon: Rocket, status: releaseApproved ? 'complete' : 'pending', meta: releaseApproved ? 'authorized' : 'awaiting owner' },
    { label: 'Feedback', id: `${23 + convertedSignals.length} signals`, icon: RadioTower, status: convertedSignals.length ? 'attention' : 'pending', meta: `${convertedSignals.length} converted` },
  ]
  const staticAudit = [
    { time: '10:08', actor: 'github:wangzhen', action: 'IntentVersionCreated', object: 'INT-142-v3', result: 'accepted', digest: '0bf3…8a21' },
    { time: '10:10', actor: 'control-plane', action: 'ContextCompiled', object: 'CTX-142-v3', result: '94% match', digest: '36d1…ea02' },
    { time: '10:12', actor: 'agent:claude-code', action: 'RunStarted', object: 'RUN-8821', result: 'containerized', digest: '61ac…c933' },
    { time: '10:14', actor: 'policy-engine', action: 'ToolAccessDenied', object: 'oauth.internal.yml', result: 'prevented', digest: 'a09e…74bc' },
    { time: '10:18', actor: 'eval-engine', action: 'EvalSuiteCompleted', object: 'EVS-014', result: '40/42 passed', digest: '79e2…01fd' },
    { time: '10:21', actor: 'github:mia', action: 'ReviewApproved', object: 'PR #428', result: 'security approved', digest: 'b34c…ae19' },
  ]
  const dynamicAudit = events.map((event) => ({ time: event.createdAt, actor: event.kind === 'deployment' ? 'mock-deployment@0.1' : event.kind === 'telemetry' ? event.detail.split(' · ')[1] ?? 'unknown' : event.kind === 'autonomy' ? 'autonomy://local-deterministic-v1' : 'github:wangzhen', action: event.kind === 'approval' ? 'GateApproved' : event.kind === 'review' ? 'ReviewDecisionRecorded' : event.kind === 'evaluation' ? 'RegressionCreated' : event.kind === 'deployment' ? 'DeploymentCompleted' : event.kind === 'telemetry' ? 'TelemetryExported' : event.kind === 'autonomy' ? 'AutonomyEvaluated' : 'IntentDerived', object: event.detail.split(' · ')[0], result: event.title, digest: event.kind === 'telemetry' || event.kind === 'autonomy' ? event.detail.split(' · ').at(-1) ?? `${event.id.slice(-4)}…local` : `${event.id.slice(-4)}…local` }))
  const localAudit = local.events.map((event) => ({ time: event.recordedAt.slice(11, 16), actor: event.actorId ?? 'system', action: event.eventType, object: `${event.aggregateType}:${event.aggregateId}`, result: `v${event.aggregateVersion}`, digest: event.eventDigest.slice(0, 18) }))
  const auditRows = [...localAudit, ...dynamicAudit, ...staticAudit]

  return (
    <>
      <PageHeader title="全链路追溯" description="从业务意图到生产反馈，验证每个对象、身份、决策和证据来自哪里。" />
      <DemoRegion title="追溯链路" note="本页链路为演示数据；真实的 Intent → Run → Proposal → Review → Merge 链路记录在本地 Event Log 中。">
        <section className="trace-summary">
          <article className="panel"><span><Route size={17} /></span><div><strong>8 / 8</strong><p>生命周期对象已关联</p></div></article>
          <article className="panel"><span><Fingerprint size={17} /></span><div><strong>100%</strong><p>关键动作具名或可归因</p></div></article>
          <article className="panel"><span><ShieldCheck size={17} /></span><div><strong>1</strong><p>策略阻断已证明</p></div></article>
          <article className="panel"><span><FileCheck2 size={17} /></span><div><strong>91%</strong><p>Critical AC 证据覆盖</p></div></article>
        </section>

        <section className="panel trace-chain-panel">
          <div className="trace-heading"><div><h2>Intent-to-Production Chain</h2><p>INT-142 · 企业 SSO 登录 · 截至 {today}</p></div><span className={`trace-integrity ${liveRun && !liveRun.integrityValid ? 'failed' : ''}`}><Fingerprint size={14} />{liveRun && !liveRun.integrityValid ? 'Chain failed' : 'Chain verified'}</span></div>
          <div className="trace-chain">{chain.map(({ label, id, icon: Icon, status, meta }, index) => <div className="trace-chain-step" key={label}><div className={`trace-chain-node ${status}`}><span><Icon size={16} /></span><strong>{label}</strong><code>{id}</code><small>{meta}</small></div>{index < chain.length - 1 && <ArrowRight size={15} />}</div>)}</div>
        </section>

        <section className="panel trace-explorer">
          <div className="trace-heading"><div><h2>Sanitized Trace Explorer</h2><p>从签名事件链派生 · Prompt、Context 内容和 Tool Output 默认不导出</p></div><div className="trace-explorer-controls"><div className="trace-scope-tabs">{([['all', '全部'], ['tool', 'Tool'], ['policy', 'Policy'], ['evaluation', 'Evaluation']] as const).map(([scopeId, label]) => <button className={traceScope === scopeId ? 'active' : ''} key={scopeId} onClick={() => setTraceScope(scopeId)}>{label}</button>)}</div><button className="secondary-button" disabled={!liveTrace || !canExportTelemetry} onClick={exportTelemetry}><Archive size={14} />{canExportTelemetry ? '导出 OTLP Bundle' : '需要 Maintainer 权限'}</button></div></div>
          {liveTrace ? <><div className="trace-explorer-meta"><span><Activity size={14} />{liveTrace.document.spans.length} spans</span><span><Fingerprint size={14} />{latestTelemetryExport ? `${latestTelemetryExport.exportedSpanCount} exported · ${latestTelemetryExport.droppedSpanCount} dropped · ${latestTelemetryExport.exportedBy}` : liveTrace.document.projectionDigest}</span><code title={latestTelemetryExport?.exportDigest ?? liveTrace.document.traceId}>{latestTelemetryExport?.exportDigest ?? liveTrace.document.traceId}</code></div><div className="trace-span-list">{visibleTraceSpans.map((span) => { const durationMs = Math.max(0, Date.parse(span.endedAt) - Date.parse(span.startedAt)); const denied = span.attributes['aperture.policy.decision'] === 'deny'; const failed = typeof span.attributes['error.type'] === 'string'; const evaluationFailed = Number(span.attributes['aperture.evaluation.failed'] ?? 0) > 0; const eventType = span.attributes['aperture.event.type']; const eventSequence = span.attributes['aperture.event.sequence']; const signalId = `TRACE-${liveRun?.runId}-${span.spanId}`; const converted = convertedSignals.find((signal) => signal.signalId === signalId); const canCapture = failed || evaluationFailed; return <article className={`trace-span-row ${denied || failed || evaluationFailed ? 'attention' : ''}`} key={span.spanId}><span className="trace-span-kind">{span.kind}</span><div><strong>{span.name}</strong><p>{typeof eventType === 'string' ? eventType : 'derived root span'}{typeof eventSequence === 'number' ? ` · event ${eventSequence}` : ''}</p></div><div><span>{durationMs} ms</span><code>{span.spanId}</code></div><div className="trace-span-action"><em>{denied ? 'denied' : failed ? 'error' : evaluationFailed ? 'failed' : 'recorded'}</em>{canCapture && <button disabled={Boolean(converted)} onClick={() => convertSignal(signalId, `${liveRun?.label ?? 'Agent Run'}：${span.name}`, 'regression', { kind: 'trace_span', runId: liveRun?.runId, traceId: liveTrace.document.traceId, spanId: span.spanId, projectionDigest: liveTrace.document.projectionDigest, eventDigest: typeof span.attributes['aperture.event.digest'] === 'string' ? span.attributes['aperture.event.digest'] : undefined })}>{converted ? `${converted.outputId} 已创建` : '创建回归'}</button>}</div></article> })}{!visibleTraceSpans.length && <div className="trace-span-empty">当前筛选没有可显示的脱敏 Span。</div>}</div></> : <div className="trace-span-empty">Run 终态封存后生成本地 Trace Projection；它不是新的事实源。</div>}
        </section>

        <section className="trace-layout">
          <div className="panel audit-ledger">
            <div className="trace-heading"><div><h2>事件账本</h2><p>追加写入 · 时间、Actor、对象和结果不可省略</p></div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><ListFilter size={14} />筛选</button></div>
            <div className="audit-grid audit-head"><span>时间</span><span>Actor</span><span>事件</span><span>对象</span><span>结果</span><span>Digest</span></div>
            {auditRows.map((row, index) => <div className="audit-grid audit-row" key={`${row.action}-${row.time}-${index}`}><time>{row.time}</time><code>{row.actor}</code><strong>{row.action}</strong><span>{row.object}</span><em>{row.result}</em><code>{row.digest}</code></div>)}
          </div>

          <aside className="trace-side">
            <div className="panel provenance-card">
              <div className="trace-heading"><div><h2>Provenance</h2><p>当前变更的权威来源</p></div></div>
              {[
                ['Human identity', 'github:wangzhen', 'verified'], ['GitHub head', authoritativePullRequest?.headSha ?? 'not projected', authoritativePullRequest ? `PR #${authoritativePullRequest.externalId}` : 'sample'], ['Model', liveRuntime?.modelRef ?? 'claude-code@2.4', liveRuntime ? 'runtime bound' : 'digest locked'], ['Harness', liveRuntime?.harnessRef ?? 'control-plane-v0.1', liveRuntime ? 'runtime bound' : 'repository'], ['Policy bundle', livePolicyBundle?.bundleDigest ?? 'not bound', livePolicyBundle ? `${livePolicyBundle.bundleId}@${livePolicyBundle.bundleVersion} · default deny` : 'pending'], ['Session', liveRuntime?.sessionRef ?? 'session:example', liveRuntime?.appendOnlyLog ? 'append-only' : 'sample'], ['Trace projection', liveTrace?.document.traceId ?? 'not projected', liveTrace ? `${liveTrace.document.providerId} · ${liveTrace.document.spans.length} sanitized spans` : 'pending'], ['Telemetry export', latestTelemetryExport?.exportDigest ?? 'not exported', latestTelemetryExport ? `${latestTelemetryExport.exportedBy} · ${latestTelemetryExport.policyId}@${latestTelemetryExport.policyVersion}` : 'pending'], ['Evidence repository', livePackage?.uri ?? 'not finalized', livePackage?.repositoryVerified ? 'verified' : livePackage ? 'failed' : 'pending'],
              ].map(([label, value, state]) => <div className="provenance-row" key={label}><span>{label}</span><strong title={value}>{value}</strong><em>{state}</em></div>)}
            </div>
            <div className={`panel integrity-card ${livePackage?.repositoryVerified ? 'sealed' : livePackage ? 'failed' : 'pending'}`}><span>{livePackage?.repositoryVerified ? <PackageCheck size={20} /> : livePackage ? <ShieldAlert size={20} /> : <Clock3 size={20} />}</span><h3>{livePackage?.repositoryVerified ? 'Evidence Package 已持久复验' : livePackage ? 'Evidence Package 复验失败' : 'Evidence Package 待封存'}</h3><p>{livePackage?.repositoryVerified ? '离线 Repository 已重新加载事件、验证摘要链并核对 Package Digest。' : livePackage ? 'Package 引用存在，但仓库内容或摘要校验不一致，后续门禁应视为不可信。' : '运行终态、事件顺序和摘要链全部通过后才允许封存。'}</p><div><span>{livePackage ? 'Repository package URI' : 'Current chain head'}</span><code title={livePackage?.uri ?? liveRun?.events.at(-1)?.eventDigest}>{livePackage?.uri ?? liveRun?.events.at(-1)?.eventDigest ?? 'no live run'}</code></div><div><span>{livePackage ? 'Repository digest' : 'Session integrity'}</span><code title={livePackage?.digest}>{livePackage?.digest ?? (liveRun ? liveRun.integrityValid ? 'verified' : 'failed' : 'sample only')}</code></div><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">{livePackage?.repositoryVerified ? '查看持久封存' : livePackage ? '调查校验失败' : '等待封存'}<ArrowRight size={14} /></button></div>
          </aside>
        </section>
      </DemoRegion>
    </>
  )
}

function PolicyPage() {
  const { liveRun, releaseApprovalTarget } = useWorkbench()
  const sandboxAttestation = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'sandbox_attested' }> => event.type === 'sandbox_attested')
  const policyBundle = liveRun?.events.find((event): event is Extract<AgentRunEvent, { type: 'policy_bundle_bound' }> => event.type === 'policy_bundle_bound')
  const policyDecisions = liveRun?.events.filter((event): event is Extract<AgentRunEvent, { type: 'policy_decided' }> => event.type === 'policy_decided') ?? []
  const toolRequests = liveRun?.events.filter((event) => event.type === 'tool_requested') ?? []
  const allowedDecisions = policyDecisions.filter((event) => event.decision.decision === 'allow')
  const deniedDecisions = policyDecisions.filter((event) => event.decision.decision === 'deny')
  const untrustedRequests = liveRun?.events.filter((event) => event.type === 'context_requested' && event.trust === 'untrusted') ?? []
  const untrustedConsumed = liveRun?.events.filter((event) => event.type === 'context_consumed' && event.trust === 'untrusted') ?? []
  const runtimeBound = liveRun?.events.some((event) => event.type === 'runtime_bound') ?? false
  const usageReport = liveRun?.events.slice().reverse().find((event): event is Extract<AgentRunEvent, { type: 'usage_reported' }> => event.type === 'usage_reported')
  const humanGateCount = Number(Boolean(liveRun?.approved)) + Number(Boolean(liveRun?.reviewDecision)) + Number(Boolean(releaseApprovalTarget))
  const approvalLoad = toolRequests.length ? (humanGateCount / toolRequests.length).toFixed(2) : '0.00'
  const policies = [
    ['敏感目录保护', '禁止 Agent 读取或修改密钥及生产配置', '强制', '12 条规则'],
    ['命令执行边界', '限制危险 Shell 命令与提权操作', '强制', '28 条规则'],
    ['网络访问控制', '仅允许访问批准的域名和服务', '强制', '9 条规则'],
    ['运行预算', '限制 Token、时长和并行资源消耗', '监测', '6 条规则'],
    ['审查与批准', '按风险等级要求具名人员审批', '强制', '8 条规则'],
  ]
  return (
    <>
      <PageHeader title="策略" description="通过环境、模型和外部内容三层防线限制 Agent 的实际爆炸半径。" />
      <DemoRegion title="策略配置" note="本页策略均为演示配置，不会影响真实 Run；真实约束只来自服务端 Project Manifest 与运行时能力。">
        <section className="panel policy-bundle-strip"><span><ShieldCheck size={18} /></span><div><h2>{policyBundle ? `${policyBundle.bundleId}@${policyBundle.bundleVersion}` : '等待 Managed Run 绑定 Policy Bundle'}</h2><p>{policyBundle ? `${policyBundle.providerRef} · ${policyBundle.ruleCount} rules · default ${policyBundle.defaultDecision}` : '策略求值与 Agent 执行解耦，Bundle、输入摘要、决定和原因进入同一事件链。'}</p></div><div><span>Bundle Digest</span><code>{policyBundle?.bundleDigest ?? 'not bound'}</code></div></section>
        <section className="containment-overview panel">
          <div className="containment-copy"><h2>审批是最后一道门，不是唯一安全机制</h2><p>低风险操作由确定性边界自动处理，高风险动作才消耗人工决策带宽。</p></div>
          <div className="blast-radius"><div><span>当前 Blast Radius</span><strong>{runtimeBound ? 'Sandbox / Repository' : 'Repository'}</strong><small>{releaseApprovalTarget ? `生产授权仅绑定 ${releaseApprovalTarget}` : '无生产写权限'}</small></div><i><b /></i><em>低</em></div>
        </section>
        <section className="containment-grid">
          {[
            { title: 'Environment', detail: '容器、文件系统、凭证和网络边界', icon: ShieldCheck, state: sandboxAttestation?.status === 'verified' ? 'healthy' : 'attention', controls: ['Sandbox Attestation', 'Ephemeral Workspace', 'Egress Allowlist'], metric: sandboxAttestation ? `${sandboxAttestation.isolation} · ${sandboxAttestation.networkEgress} · ${sandboxAttestation.secretMounts.length} secrets` : runtimeBound ? 'awaiting attestation' : 'sample boundary' },
            { title: 'Model', detail: '系统策略、分类器与行为探针', icon: Bot, state: 'healthy', controls: ['危险动作分类', 'Prompt Injection Probe', '工具调用约束'], metric: liveRun ? `${policyDecisions.length} decisions recorded` : '97.8% auto-classified' },
            { title: 'External Content', detail: 'MCP、插件、网页与仓库内容信任', icon: ShieldAlert, state: untrustedConsumed.length ? 'attention' : 'healthy', controls: ['来源信任等级', '内容隔离', '工具输出扫描'], metric: liveRun ? `${untrustedRequests.length} untrusted · ${untrustedConsumed.length} consumed` : '1 untrusted source' },
          ].map(({ title, detail, icon: Icon, state, controls, metric }) => <article className="containment-card panel" key={title}><div className="containment-card-top"><span className={`containment-icon ${state}`}><Icon size={18} /></span><span className={`containment-state ${state}`}>{state === 'healthy' ? '正常' : '需关注'}</span></div><h3>{title}</h3><p>{detail}</p><ul>{controls.map((control) => <li key={control}><Check size={12} />{control}</li>)}</ul><div><span>最近 24h</span><strong>{metric}</strong></div></article>)}
        </section>
        <section className={`budget-enforcement panel ${usageReport?.decision.status ?? 'idle'}`}><div><h2>{usageReport ? `${usageReport.decision.status.toUpperCase()} · ${usageReport.decision.action}` : '等待 Runtime Usage'}</h2><p>{usageReport?.decision.reasons.join('；') ?? 'Token、工具调用、时长和成本由 Harness 上报，Policy Guard 独立判定。'}</p></div><div className="budget-enforcement-metrics"><span><strong>{usageReport ? `${((usageReport.usage.inputTokens + usageReport.usage.outputTokens) / 1_000).toFixed(1)}K` : '—'}</strong><small>Tokens / {usageReport ? `${usageReport.budget.maxTokens / 1_000}K` : '80K'}</small></span><span><strong>{usageReport?.usage.toolCalls ?? '—'}</strong><small>Tool calls / {usageReport?.budget.maxToolCalls ?? 100}</small></span><span><strong>{usageReport ? `${usageReport.usage.elapsedSeconds}s` : '—'}</strong><small>Duration / {usageReport?.budget.maxDurationSeconds ?? 1800}s</small></span><span><strong>{usageReport ? `$${usageReport.usage.estimatedCostUsd.toFixed(2)}` : '—'}</strong><small>Cost / ${usageReport?.budget.maxCostUsd?.toFixed(2) ?? '8.00'}</small></span></div></section>
        <section className="approval-routing panel"><div><h2>只把不可逆、高影响决策交给人</h2><p>读取仓库、阻断 Secrets 与隔离未信任内容由确定性策略自动完成；运行门禁、变更评审和生产授权保留具名人工责任。</p></div><div className="approval-routing-metrics"><span><strong>{policyDecisions.length || 21}</strong><small>自动策略决策</small></span><span><strong>{humanGateCount}</strong><small>人工门禁</small></span><span><strong>{approvalLoad}</strong><small>每工具调用审批负载</small></span></div></section>
        <div className="policy-list">{policies.map(([title, description, mode, count], index) => <article className="policy-card panel" key={title}><div className={`policy-icon p${index}`}><LockKeyhole size={18} /></div><div><h3>{title}</h3><p>{description}</p></div><span className={mode === '强制' ? 'enforced' : 'observed'}>{mode}</span><small>{count}</small><button className="icon-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更" aria-label="查看详情（原型控件，未接入）"><ChevronRight size={17} /></button></article>)}</div>
      </DemoRegion>
    </>
  )
}

function FeedbackPage() {
  const { convertedSignals, convertSignal } = useWorkbench()
  const signals = [
    { id: 'SIG-204', source: 'Sentry', title: 'OIDC 回调超时率升高', outputTitle: '修复 OIDC 回调超时与重试策略', detail: 'Release 2026.09.22 · p95 由 1.2s 升至 3.8s', severity: 'high', confidence: '98%', action: '创建修复 Intent', outputType: 'intent' as const },
    { id: 'SIG-201', source: 'Support', title: '管理员无法区分失效与未绑定账号', outputTitle: '改善企业身份状态的管理端表达', detail: '7 条相似反馈 · 过去 24 小时', severity: 'medium', confidence: '86%', action: '创建产品 Intent', outputType: 'intent' as const },
    { id: 'SIG-198', source: 'Eval', title: '符号链接隔离任务出现回归', outputTitle: '符号链接目录逃逸回归任务', detail: 'EVS-011 · 2/3 trials failed', severity: 'high', confidence: '100%', action: '加入回归门禁', outputType: 'regression' as const },
    { id: 'SIG-192', source: 'Usage', title: '证据详情展开率持续下降', outputTitle: '研究审查者不展开证据的原因', detail: '63% → 48% · 最近 14 天', severity: 'low', confidence: '74%', action: '创建研究任务', outputType: 'research' as const },
  ]

  return (
    <>
      <PageHeader
        title="反馈闭环"
        description="把生产信号、用户反馈和评估失败转化为修复、回归任务与新 Intent。"
      />
      <DemoRegion title="反馈闭环" note="本页生产信号与转化漏斗为演示数据，尚未接入任何真实运行时。">

        <section className="feedback-loop panel">
          <div className="feedback-loop-copy"><h2>从发布结果回到可执行意图</h2><p>信号只有被归因、验证并进入下一轮工程工作时，才构成真正的学习闭环。</p></div>
          <div className="feedback-loop-flow">
            {[
              { label: 'Observe', value: '23 signals', icon: RadioTower, tone: 'blue' }, { label: 'Triage', value: '4 need action', icon: ListFilter, tone: 'amber' }, { label: 'Remediate', value: '2 active', icon: Bot, tone: 'violet' }, { label: 'Verify', value: '3 regressions', icon: FlaskConical, tone: 'green' },
            ].map(({ label, value, icon: Icon, tone }, index, array) => <div className="feedback-loop-step" key={label}><span className={tone}><Icon size={16} /></span><strong>{label}</strong><small>{value}</small>{index < array.length - 1 && <ArrowRight size={15} />}</div>)}
          </div>
        </section>

        <section className="feedback-layout">
          <div className="panel signal-inbox">
            <div className="feedback-heading"><div><h2>信号收件箱</h2><p>按严重性、置信度和用户影响排序</p></div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><ListFilter size={14} />筛选</button></div>
            <div className="signal-head signal-grid"><span>信号</span><span>来源</span><span>置信度</span><span>状态</span><span /></div>
            {signals.map((signal) => {
              const done = convertedSignals.some((converted) => converted.signalId === signal.id)
              return <div className="signal-row signal-grid" key={signal.id}>
                <div className="signal-title"><span className={`signal-severity ${signal.severity}`} /><div><strong>{signal.title}</strong><small>{signal.id} · {signal.detail}</small></div></div>
                <span className="signal-source">{signal.source}</span><span>{signal.confidence}</span><span className={done ? 'signal-converted' : 'signal-new'}>{done ? '已回流' : '待处理'}</span>
                <button className={done ? 'signal-action done' : 'signal-action'} onClick={() => convertSignal(signal.id, signal.outputTitle, signal.outputType)}>{done ? <><Check size={13} />已创建</> : <>{signal.action}<ArrowRight size={13} /></>}</button>
              </div>
            })}
          </div>

          <aside className="feedback-side">
            <div className="panel remediation-card">
              <div className="feedback-heading"><div><h2>Agent-assisted Remediation</h2><p>自动准备，人类批准</p></div><Bot size={18} /></div>
              <div className="remediation-run"><span className="remediation-status"><i />分析中</span><strong>OIDC 回调延迟诊断</strong><p>正在关联 Trace、最近 Release、配置差异与历史 Incident。</p><div className="remediation-progress"><i /></div><small>已完成 4 / 6 个诊断步骤</small></div>
              <div className="remediation-boundary"><ShieldCheck size={15} /><p><strong>当前边界</strong>只读生产遥测；禁止修改配置、重启服务或部署。</p></div>
            </div>
            <div className="panel learning-card">
              <div className="feedback-heading"><div><h2>本月学习产出</h2><p>从真实信号沉淀</p></div></div>
              <div><span>新增 Regression Tasks</span><strong>11</strong></div><div><span>派生修复 Intents</span><strong>8</strong></div><div><span>更新 Policy Rules</span><strong>3</strong></div><div><span>关闭无效告警</span><strong>17</strong></div>
            </div>
          </aside>
        </section>
      </DemoRegion>
    </>
  )
}

/** Endpoint presets, so the common providers do not have to be typed from memory. Every field stays editable. */
const providerPresets: Record<string, { providerId: string; model: string; baseUrl: string; wireApi: 'responses' | 'chat'; note: string }> = {
  deepseek: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat', note: 'OpenAI 兼容 Chat Completions。' },
  openai: { providerId: 'openai', model: 'gpt-5.1-codex', baseUrl: 'https://api.openai.com/v1', wireApi: 'responses', note: 'Responses API。' },
  ica: { providerId: 'ica', model: 'gpt-5.6-sol', baseUrl: 'https://api.servicesessentials.ibm.com/v1', wireApi: 'responses', note: '当前 codex 全局配置使用的内网网关。' },
  anthropic: { providerId: 'anthropic', model: 'claude-opus-5', baseUrl: 'https://api.anthropic.com', wireApi: 'chat', note: '由 Claude Code 引擎执行（服务需以 --claude 启动）：base_url 与密钥以 ANTHROPIC_* 环境变量注入。' },
}

/**
 * Which LLM writes the code is review information, not an operator's local detail: before this panel the
 * model came from whatever the agent CLI's own user-level config happened to point at, so it could not be
 * changed from the Control Plane and did not appear in any run's attestation. Saving here takes effect on
 * the next admitted run; runs already in flight keep the model they were attested with.
 */
function LocalAgentProviderPanel() {
  const local = useLocalControlPlane()
  const current = local.agentProvider
  const [input, setInput] = useState({ providerId: current?.providerId ?? '', model: current?.model ?? '', baseUrl: current?.baseUrl ?? '', wireApi: current?.wireApi ?? 'responses' as 'responses' | 'chat', apiKeyEnv: current?.apiKeyEnv ?? '', reasoningEffort: current?.reasoningEffort ?? '' })
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  if (local.status !== 'ready' || !local.agentProviderReadable) return null
  const canEdit = local.actor?.role === 'owner'
  const applyPreset = (key: string) => {
    const preset = providerPresets[key]
    if (!preset) return
    setInput((value) => ({ ...value, providerId: preset.providerId, model: preset.model, baseUrl: preset.baseUrl, wireApi: preset.wireApi }))
    setNotice(preset.note)
  }
  const save = async (clearKey: boolean) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      // An untouched key field means "keep what is stored"; only an explicit clear sends an empty string.
      await local.saveAgentProvider({
        providerId: input.providerId.trim(),
        model: input.model.trim(),
        baseUrl: input.baseUrl.trim(),
        wireApi: input.wireApi,
        apiKey: clearKey ? '' : (apiKey.trim() || undefined),
        apiKeyEnv: input.apiKeyEnv.trim() || undefined,
        reasoningEffort: input.reasoningEffort ? input.reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' : undefined,
      })
      setApiKey('')
      setNotice(clearKey ? '已清除存储的密钥；下一次 Run 将改用环境变量或 Agent CLI 自身凭证。' : '已保存。下一次受理的 Run 生效，进行中的 Run 仍用原模型。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  // Mirrors scripts/agents/builder.mjs, which picks the engine from these same fields at each run.
  const anthropicProvider = input.providerId.trim() === 'anthropic' || /(^|\.)anthropic\.com(\/|:|$)/u.test(input.baseUrl.replace(/^https?:\/\//u, ''))
  const engineNote = anthropicProvider ? 'Anthropic API → Claude Code 引擎：服务启动参数需含 --claude <路径>。' : input.wireApi === 'responses' ? 'Responses API → Codex 引擎：服务启动参数需含 --codex <路径>；新版 Codex 只支持 responses。' : 'Chat Completions → 内置 Chat Builder：直接调用 Base URL 的 /chat/completions，不依赖任何 Agent CLI，适用于 DeepSeek、Qwen、OpenAI、vLLM、Ollama 等 OpenAI 兼容接口。'
  const keySource = current?.apiKeySet ? `Control Plane 已存密钥 · 以 ${local.agentProviderKeyVariable} 注入` : current?.apiKeyEnv ? `读取服务进程环境变量 ${current.apiKeyEnv}` : '无密钥：回退到 Agent CLI 自身凭证'
  return <section className="panel local-provider-panel">
    <div className="local-core-heading">
      <div>
        <span className="eyebrow">真实配置 · LLM Provider</span>
        <h2>Builder Agent 使用的模型</h2>
        <p>由 Control Plane 决定，不再依赖 Agent CLI 的用户级配置。保存后的 model / provider / base_url 会写入每个 Run 的运行证明并进入证据包，密钥只写入 Agent 进程环境，不进事件、不进证据、不回读。</p>
      </div>
      <span className={`local-agent-capability ${current ? 'ready' : 'disabled'}`}><i />{current ? `${current.model} · ${current.providerId}` : '未配置 · 回退 CLI 配置'}</span>
    </div>
    <div className="local-provider-form">
      <label>预设<select defaultValue="" disabled={!canEdit} onChange={(event) => applyPreset(event.target.value)}><option value="">选择以填充</option>{Object.entries(providerPresets).map(([key, preset]) => <option key={key} value={key}>{preset.providerId} · {preset.model}</option>)}</select></label>
      <label>Provider ID<input value={input.providerId} disabled={!canEdit} onChange={(event) => setInput((value) => ({ ...value, providerId: event.target.value }))} placeholder="deepseek" /></label>
      <label>Model<input value={input.model} disabled={!canEdit} onChange={(event) => setInput((value) => ({ ...value, model: event.target.value }))} placeholder="deepseek-chat" /></label>
      <label>Base URL<input value={input.baseUrl} disabled={!canEdit} onChange={(event) => setInput((value) => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.deepseek.com/v1" /></label>
      <label>Wire API<select value={input.wireApi} disabled={!canEdit} onChange={(event) => setInput((value) => ({ ...value, wireApi: event.target.value as 'responses' | 'chat' }))}><option value="responses">responses</option><option value="chat">chat</option></select></label>
      <label>Reasoning effort<select value={input.reasoningEffort} disabled={!canEdit} onChange={(event) => setInput((value) => ({ ...value, reasoningEffort: event.target.value }))}><option value="">默认</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
      <label>API Key<input type="password" value={apiKey} disabled={!canEdit} onChange={(event) => setApiKey(event.target.value)} placeholder={current?.apiKeySet ? '已存储，留空则保持不变' : '留空则不存密钥'} autoComplete="off" /></label>
      <label>或：密钥所在环境变量<input value={input.apiKeyEnv} disabled={!canEdit} onChange={(event) => setInput((value) => ({ ...value, apiKeyEnv: event.target.value }))} placeholder="DEEPSEEK_API_KEY" /></label>
    </div>
    <div className="local-provider-actions">
      <button className="primary-button" disabled={!canEdit || busy || !input.providerId.trim() || !input.model.trim() || !input.baseUrl.trim()} onClick={() => void save(false)}><Save size={13} />{busy ? '保存中' : '保存 Provider'}</button>
      {current?.apiKeySet && <button className="secondary-button" disabled={!canEdit || busy} onClick={() => void save(true)}><X size={12} />清除已存密钥</button>}
      <small><KeyRound size={11} />{keySource}</small>
    </div>
    <p className="local-run-notice" role="status"><Bot size={11} />执行引擎按此配置自动选择：{engineNote}</p>
    {!canEdit && <p className="local-run-notice" role="status"><ShieldAlert size={11} />只有 Owner 能修改 Provider；当前角色为只读。</p>}
    {current && <p className="local-run-notice" role="status"><Clock3 size={11} />当前配置由 {local.actors.find((item) => item.id === current.updatedByActorId)?.displayName ?? current.updatedByActorId} 于 {new Date(current.updatedAt).toLocaleString()} 保存；密钥以明文存于本地 SQLite，若不希望落盘请改用环境变量字段。</p>}
    {error && <p className="local-form-error" role="alert">{error}</p>}
    {notice && !error && <p className="local-run-notice" role="status"><Check size={11} />{notice}</p>}
  </section>
}

function IntegrationsPage() {
  const { resetPrototype, githubImports, githubPullRequests, importGitHubIssue, importGitHubPullRequest } = useWorkbench()
  const [catalogFilter, setCatalogFilter] = useState<'all' | ProviderStage>('all')
  const [issueId, setIssueId] = useState('#155')
  const [pullRequestId, setPullRequestId] = useState('#428')
  const [githubImportState, setGitHubImportState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [pullRequestImportState, setPullRequestImportState] = useState<'idle' | 'loading' | 'error'>('idle')
  const importIssue = async () => {
    setGitHubImportState('loading')
    try {
      await importGitHubIssue(issueId)
      setGitHubImportState('idle')
    } catch {
      setGitHubImportState('error')
    }
  }
  const importPullRequest = async () => {
    setPullRequestImportState('loading')
    try {
      await importGitHubPullRequest(pullRequestId)
      setPullRequestImportState('idle')
    } catch {
      setPullRequestImportState('error')
    }
  }
  const latestPullRequest = githubPullRequests[0]
  const catalogSummary = summarizeProviderCatalog()
  const visibleProviders = providerCatalog.filter((provider) => catalogFilter === 'all' || provider.stage === catalogFilter)
  const stageLabel: Record<ProviderStage, string> = { prototype: '原型接入', next: '下一阶段', research: '研究中' }
  const decisionLabel = { adopt: 'Adopt', integrate: 'Integrate', reference: 'Reference', build: 'Build' } as const
  const integrations = [
    { title: 'GitHub', type: 'Source of truth', detail: 'Issues、Pull Requests、Checks、Reviews', icon: GitPullRequest, tone: 'violet', status: 'connected', meta: `${githubImports.length} issues · ${githubPullRequests.length} PR snapshots` },
    { title: 'Claude Code', type: 'Agent adapter', detail: '本机 CLI · Hooks · Tool permissions', icon: Bot, tone: 'amber', status: 'connected', meta: 'v2.4 · last run 8m ago' },
    { title: 'GitHub Actions', type: 'CI provider', detail: 'JUnit、SARIF、Coverage、Artifacts', icon: Workflow, tone: 'blue', status: 'connected', meta: '4 workflows · 12 checks' },
    { title: 'Slack', type: 'Notification', detail: '审查分配、门禁失败、发布状态', icon: Webhook, tone: 'green', status: 'attention', meta: 'Webhook latency 4.2s' },
    { title: 'Internal Model Gateway', type: 'Model provider', detail: 'OpenAI-compatible endpoint · 私有模型', icon: Network, tone: 'cyan', status: 'pending', meta: 'Waiting for credentials' },
  ]

  return (
    <>
      <PageHeader title="集成" description="附着现有研发系统，明确每个系统的权威边界、数据流和离线替代方案。" />
      <LocalAgentProviderPanel />
      <DemoRegion title="集成状态" note="以下集成状态为演示数据；本页唯一真实生效的配置是上方的 LLM Provider。">
        <section className="integration-summary">
          <article className="panel integration-health"><span className="integration-health-icon"><Cable size={18} /></span><div><span>连接健康</span><strong>4 / 5</strong><p>一个模型网关等待凭证</p></div></article>
          <article className="panel integration-health"><span className="integration-health-icon offline"><CloudOff size={18} /></span><div><span>离线就绪度</span><strong>80%</strong><p>通知通道仍依赖公网 Slack</p></div></article>
          <article className="panel integration-health"><span className="integration-health-icon secure"><KeyRound size={18} /></span><div><span>密钥治理</span><strong>Healthy</strong><p>0 个明文凭证 · 5 个短期 Token</p></div></article>
        </section>

        <section className="panel provider-catalog">
          <div className="integration-heading provider-catalog-heading">
            <div><h2>Provider Catalog</h2><p>借鉴 Backstage 的声明式目录，但以可替换契约、私有化和证据边界为中心</p></div>
            <div className="catalog-filters">
              {([['all', '全部'], ['prototype', '原型接入'], ['next', '下一阶段'], ['research', '研究中']] as const).map(([value, label]) => <button className={catalogFilter === value ? 'active' : ''} key={value} onClick={() => setCatalogFilter(value)}>{label}</button>)}
            </div>
          </div>
          <div className="catalog-metrics">
            <span><strong>{catalogSummary.contracts}</strong> Provider Contracts</span>
            <span><strong>{catalogSummary.prototypes}</strong> 原型接入</span>
            <span><strong>{catalogSummary.next}</strong> 下一阶段</span>
            <span><strong>{catalogSummary.offlineReady}</strong> 私有化 / 离线就绪</span>
          </div>
          <div className="provider-table">
            <div className="provider-table-head"><span>能力与实现</span><span>稳定契约</span><span>借鉴机制</span><span>部署</span><span>阶段</span></div>
            {visibleProviders.map((provider) => <article className="provider-row" key={provider.id} title={`不照搬：${provider.avoidPattern}`}>
              <div className="provider-identity"><span><Boxes size={15} /></span><div><strong>{provider.name}</strong><small>{provider.category} · {provider.inspiration}</small></div></div>
              <code>{provider.contractRef}</code>
              <p>{provider.borrowedPattern}</p>
              <div className="provider-deployments">{provider.deployments.map((deployment) => <span key={deployment}>{deployment === 'self_hosted' ? 'Self-hosted' : deployment === 'embedded' ? 'Embedded' : 'Managed'}</span>)}{provider.offlineReady && <em>Offline</em>}</div>
              <div className="provider-stage"><span className={provider.stage}>{stageLabel[provider.stage]}</span><small>{decisionLabel[provider.decision]}</small></div>
            </article>)}
          </div>
          <footer className="catalog-footnote"><ShieldCheck size={14} /><span>目录不是静态选型清单：每个 Provider 必须同时声明“不照搬什么”和 Evidence Boundary，避免外部产品反向绑架核心领域模型。</span></footer>
        </section>

        <section className="integration-layout">
          <div className="panel integration-list">
            <div className="integration-heading"><div><h2>已配置集成</h2><p>连接状态和权威职责</p></div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><RefreshCw size={14} />检查连接</button></div>
            {integrations.map((integration) => {
              const Icon = integration.icon
              return <button className="integration-row" key={integration.title} disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><span className={`integration-icon ${integration.tone}`}><Icon size={17} /></span><div><strong>{integration.title}</strong><small>{integration.type}</small></div><p>{integration.detail}</p><span className={`integration-state ${integration.status}`}>{integration.status === 'connected' ? '已连接' : integration.status === 'attention' ? '需关注' : '待配置'}</span><em>{integration.meta}</em><ChevronRight size={15} /></button>
            })}
          </div>

          <aside className="integration-side">
            <div className="panel github-intake">
              <div className="integration-heading"><div><h2>GitHub Issue Intake</h2><p>读取权威 Issue，创建 Intent 投影</p></div><GitPullRequest size={17} /></div>
              <div className="github-import-form"><input value={issueId} onChange={(event) => setIssueId(event.target.value)} placeholder="#155" aria-label="GitHub Issue 编号" /><button className="secondary-button" disabled={githubImportState === 'loading'} onClick={() => void importIssue()}>{githubImportState === 'loading' ? '导入中…' : '导入 Issue'}</button></div>
              {githubImportState === 'error' && <p className="github-import-error" role="alert">Mock Provider 中未找到该 Issue，可尝试 #142 或 #155。</p>}
              <div className="github-import-list">{githubImports.length ? githubImports.slice(0, 3).map((item) => <div key={item.externalId}><span className="passed"><Check size={13} /></span><div><strong>{item.intentId} · {item.title}</strong><small>Issue #{item.externalId} · {item.state} · {item.importedAt}</small></div><em>{item.projectionWritten ? 'projection written' : 'local only'}</em></div>) : <div className="github-import-empty"><GitPullRequest size={18} /><p>输入 #155 导入示例 Issue。GitHub 保留标题与状态权威，Control Plane 管理 AC、Eval 和 Evidence。</p></div>}</div>
            </div>
            <div className="panel github-intake github-pr-projection">
              <div className="integration-heading"><div><h2>GitHub PR Projection</h2><p>读取 Review 与 Checks，回写 Run / Evidence 引用</p></div><GitBranch size={17} /></div>
              <div className="github-import-form"><input value={pullRequestId} onChange={(event) => setPullRequestId(event.target.value)} placeholder="#428" aria-label="GitHub PR 编号" /><button className="secondary-button" disabled={pullRequestImportState === 'loading'} onClick={() => void importPullRequest()}>{pullRequestImportState === 'loading' ? '同步中…' : '同步 PR'}</button></div>
              {pullRequestImportState === 'error' && <p className="github-import-error" role="alert">Mock Provider 中未找到该 PR，可尝试 #428 或 #512。</p>}
              {latestPullRequest ? <div className="github-pr-snapshot"><div className="github-pr-title"><span className={latestPullRequest.reviewDecision === 'approved' ? 'passed' : 'warning'}>{latestPullRequest.reviewDecision === 'approved' ? <Check size={13} /> : <ShieldAlert size={13} />}</span><div><strong>PR #{latestPullRequest.externalId} · {latestPullRequest.title}</strong><small>{latestPullRequest.headRef} → {latestPullRequest.baseRef} · {latestPullRequest.headSha.slice(0, 7)} · {latestPullRequest.importedAt}</small></div><em>{latestPullRequest.reviewDecision}</em></div><div className="github-pr-checks">{latestPullRequest.checks.map((check) => <div className={check.conclusion === 'failure' ? 'failed' : check.status !== 'completed' ? 'pending' : 'passed'} key={check.name}><span>{check.conclusion === 'failure' ? '!' : check.status === 'completed' ? <Check size={11} /> : <Clock3 size={11} />}</span><div><strong>{check.name}</strong><small>{check.status} · {check.conclusion ?? 'pending'}</small></div></div>)}</div><div className="github-pr-link"><span>{latestPullRequest.linkedRunId ?? '未关联 Run'}</span><code>{latestPullRequest.evidenceUri ?? 'Evidence 尚未封存，已回写占位引用'}</code><em>{latestPullRequest.projectionWritten ? 'projection written' : 'read only'}</em></div></div> : <div className="github-import-empty"><GitBranch size={18} /><p>输入 #428 同步批准且 Checks 通过的 PR；#512 展示 Changes Requested 与失败 Check。</p></div>}
            </div>
            <div className="panel authority-map">
              <div className="integration-heading"><div><h2>权威边界</h2><p>避免多系统状态冲突</p></div></div>
              {[
                ['Issue title / state', 'GitHub'], ['Acceptance Criteria', 'Control Plane'], ['Code & Review Decision', 'GitHub'], ['Eval Definition', 'Repository'], ['Evidence Package', 'Control Plane'], ['Deployment State', 'CI / CD'],
              ].map(([domain, authority]) => <div className="authority-row" key={domain}><span>{domain}</span><strong>{authority}</strong></div>)}
            </div>
            <div className="panel offline-readiness">
              <div className="integration-heading"><div><h2>完全离线部署</h2><p>当前缺口与替代方案</p></div><CloudOff size={17} /></div>
              <div className="offline-check"><span className="done"><Check size={13} /></span><div><strong>本地 Git 与容器镜像</strong><small>Ready</small></div></div>
              <div className="offline-check"><span className="done"><Check size={13} /></span><div><strong>内部模型 Gateway</strong><small>Endpoint 已定义</small></div></div>
              <div className="offline-check"><span className="done"><Check size={13} /></span><div><strong>本地 Artifact 存储</strong><small>S3-compatible</small></div></div>
              <div className="offline-check"><span className="pending"><Clock3 size={13} /></span><div><strong>通知替代通道</strong><small>需要支持邮件或内部 IM</small></div></div>
              <button className="reset-prototype" onClick={() => { if (window.confirm('重置所有 Mock 审批、回流和通知状态？')) resetPrototype() }}>重置 Mock 原型状态</button>
            </div>
          </aside>
        </section>
      </DemoRegion>
    </>
  )
}

type ProjectForm = { slug: string; name: string; description: string; codeHost: LocalProject['codeHost']; repositoryPath: string; defaultBranch: string; mergeMode: LocalProject['mergeMode']; owner: string; repo: string; apiBase: string; webBase: string; tokenEnv: string; transport: 'https' | 'ssh'; remoteUrl: string }
// New projects default to the team's GitHub account (https://github.com/u2pia).
const emptyProjectForm: ProjectForm = { slug: '', name: '', description: '', codeHost: 'github', repositoryPath: '', defaultBranch: 'main', mergeMode: 'control_plane', owner: 'u2pia', repo: '', apiBase: '', webBase: '', tokenEnv: 'APERTURE_GITHUB_TOKEN', transport: 'https', remoteUrl: '' }

function projectFormFrom(project: LocalProject): ProjectForm {
  const config = project.codeHostConfig
  return { slug: project.slug, name: project.name, description: project.description, codeHost: project.codeHost, repositoryPath: project.codeHost === 'local' ? project.repositoryPath ?? '' : '', defaultBranch: project.defaultBranch, mergeMode: project.mergeMode, owner: config.owner ?? '', repo: config.repo ?? '', apiBase: config.apiBase ?? '', webBase: config.webBase ?? '', tokenEnv: config.tokenEnv ?? '', transport: config.transport ?? 'https', remoteUrl: config.remoteUrl ?? '' }
}

/** The host config carries the *name* of the token variable, never a token; the server reads the value at use. */
function projectInputFrom(form: ProjectForm): LocalProjectInput {
  const base = { name: form.name.trim(), description: form.description.trim(), codeHost: form.codeHost, defaultBranch: form.defaultBranch.trim() || 'main', mergeMode: form.mergeMode }
  if (form.codeHost === 'local') return { ...base, repositoryPath: form.repositoryPath.trim() || null, mergeMode: 'control_plane' }
  const config: LocalProject['codeHostConfig'] = { owner: form.owner.trim(), repo: form.repo.trim(), tokenEnv: form.tokenEnv.trim(), transport: form.transport }
  if (form.apiBase.trim()) config.apiBase = form.apiBase.trim()
  if (form.webBase.trim()) config.webBase = form.webBase.trim()
  if (form.remoteUrl.trim()) config.remoteUrl = form.remoteUrl.trim()
  return { ...base, codeHostConfig: config }
}

function ProjectHostFields({ form, onChange, disabled, creating }: { form: ProjectForm; onChange: (patch: Partial<ProjectForm>) => void; disabled: boolean; creating: boolean }) {
  return <div className="local-provider-form project-form">
    {creating && <label>Slug<input value={form.slug} disabled={disabled} onChange={(event) => onChange({ slug: event.target.value })} placeholder="payments-api" /></label>}
    <label>名称<input value={form.name} disabled={disabled} onChange={(event) => onChange({ name: event.target.value })} placeholder="支付服务" /></label>
    <label>说明<input value={form.description} disabled={disabled} onChange={(event) => onChange({ description: event.target.value })} placeholder="可选" /></label>
    <label>代码托管<select value={form.codeHost} disabled={disabled} onChange={(event) => onChange({ codeHost: event.target.value as ProjectForm['codeHost'], mergeMode: 'control_plane' })}><option value="local">本地 Git 仓库</option><option value="github">GitHub / GitHub Enterprise</option></select></label>
    <label>默认分支<input value={form.defaultBranch} disabled={disabled} onChange={(event) => onChange({ defaultBranch: event.target.value })} placeholder="main" /></label>
    {form.codeHost === 'local' ? <label className="wide">仓库绝对路径<input value={form.repositoryPath} disabled={disabled} onChange={(event) => onChange({ repositoryPath: event.target.value })} placeholder="/Users/me/code/payments-api（服务端校验必须是 Git 仓库顶层）" /></label> : <>
      <label>Owner / 组织<input value={form.owner} disabled={disabled} onChange={(event) => onChange({ owner: event.target.value })} placeholder="u2pia（账号或组织名，不是域名）" /></label>
      <label>仓库<input value={form.repo} disabled={disabled} onChange={(event) => onChange({ repo: event.target.value })} placeholder="banking-kyc（与 GitHub 地址中的仓库名完全一致）" /></label>
      <label>Token 环境变量名<input value={form.tokenEnv} disabled={disabled} onChange={(event) => onChange({ tokenEnv: event.target.value })} placeholder="APERTURE_GITHUB_TOKEN" autoComplete="off" /></label>
      <label>Git 传输<select value={form.transport} disabled={disabled} onChange={(event) => onChange({ transport: event.target.value as ProjectForm['transport'] })}><option value="https">HTTPS（token 认证）</option><option value="ssh">SSH（本机密钥，token 只用于 API）</option></select></label>
      <label>合并方式<select value={form.mergeMode} disabled={disabled} onChange={(event) => onChange({ mergeMode: event.target.value as ProjectForm['mergeMode'] })}><option value="control_plane">平台合并后推送</option><option value="host_protected">GitHub 分支保护下合并，平台同步</option></select></label>
      <label>API 地址（Enterprise）<input value={form.apiBase} disabled={disabled} onChange={(event) => onChange({ apiBase: event.target.value })} placeholder="https://api.github.com" /></label>
      <label>Web 地址（Enterprise）<input value={form.webBase} disabled={disabled} onChange={(event) => onChange({ webBase: event.target.value })} placeholder="留空即 https://github.com；只填站点根地址" /></label>
      <label>远程 URL 覆盖<input value={form.remoteUrl} disabled={disabled} onChange={(event) => onChange({ remoteUrl: event.target.value })} placeholder="可选，默认按 Web 地址推导" /></label>
    </>}
  </div>
}

/** A full-width coloured title bar, so each region of the Projects page is told apart by its header alone. */
function RegionBand({ tone, icon, title, subtitle }: { tone: 'team' | 'create'; icon: React.ReactNode; title: string; subtitle: string }) {
  return <header className={`region-band ${tone}`}><span className="region-band-icon">{icon}</span><div><h2>{title}</h2><p>{subtitle}</p></div></header>
}

function ProjectsPage() {
  const local = useLocalControlPlane()
  const [createForm, setCreateForm] = useState<ProjectForm>(emptyProjectForm)
  const [editForm, setEditForm] = useState<ProjectForm>()
  const [editingId, setEditingId] = useState<string>()
  const [connection, setConnection] = useState<{ projectId: string; result: LocalCodeHostConnection }>()
  const [memberChoice, setMemberChoice] = useState<{ actorId: string; role: LocalProjectRole }>({ actorId: '', role: 'developer' })
  // One project open at a time; it opens on the current project because the members panel lives inside it.
  const [expandedId, setExpandedId] = useState<string | undefined>(local.currentProjectId)
  const [newMember, setNewMember] = useState<{ username: string; displayName: string; password: string; role: LocalProjectRole }>({ username: '', displayName: '', password: '', role: 'developer' })
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  if (local.status !== 'ready' || !local.actor) return <><PageHeader title="项目" description="项目 = 一个仓库 + 一个代码托管 + 一组按项目授予的角色。" /><section className="panel local-empty"><KeyRound size={20} /><p>请先登录本地 Control Plane。</p></section></>
  const isOwner = local.actor.role === 'owner'
  const run = async (key: string, action: () => Promise<void>, done?: string) => {
    setBusy(key)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      if (done) setNotice(done)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }
  const current = local.currentProject
  const nonOwners = local.actors.filter((actor) => actor.role !== 'owner' && actor.status !== 'disabled')
  const candidates = nonOwners.filter((actor) => !local.projectMembers.some((member) => member.actorId === actor.id))
  const membersPanel = current && <section className="project-members" aria-label="成员与角色">
    <RegionBand tone="team" icon={<Users size={15} />} title={`${TEAM_NAME} · 成员与角色`} subtitle={`项目 ${current.name}。${projectRoleLabels.owner} 隐式拥有所有项目；其他人的权限只来自这里。授予、变更、移除都会记录授权人身份。`} />
    <div className="region-body">
    <div className="member-row"><span className="member-avatar">OW</span><div><strong>{local.actors.filter((actor) => actor.role === 'owner').map((actor) => actor.displayName).join('、')}</strong><small>平台 Owner · 隐式 Owner</small></div></div>
    {local.projectMembers.length === 0 && <p className="local-run-notice"><Users size={11} />除 Owner 外暂无成员。</p>}
    {local.projectMembers.map((member) => <div className="member-row" key={member.actorId}><span className="member-avatar">{member.displayName.slice(0, 2).toUpperCase()}</span><div><strong>{member.displayName}</strong><small>local:{member.username} · 加入于 {new Date(member.addedAt).toLocaleDateString()}</small></div>
      {isOwner ? <><select value={member.role} disabled={busy === `member:${member.actorId}`} onChange={(event) => void run(`member:${member.actorId}`, () => local.setProjectMember(current.id, member.actorId, event.target.value as LocalProjectRole), `${member.displayName} 在 ${current.slug} 的角色已改为 ${projectRoleLabels[event.target.value as LocalProjectRole]}。`)}>{(['maintainer', 'reviewer', 'developer'] as const).map((value) => <option key={value} value={value}>{projectRoleLabels[value]}</option>)}</select><button className="secondary-button" title={current.id === DEMO_PROJECT_ID ? '所有成员都在演示项目中，不能移出' : undefined} disabled={busy === `member:${member.actorId}` || current.id === DEMO_PROJECT_ID} onClick={() => void run(`member:${member.actorId}`, () => local.removeProjectMember(current.id, member.actorId), `${member.displayName} 已移出 ${current.slug}。`)}><X size={12} />移出</button></> : <span className="online">{projectRoleLabels[member.role]}</span>}
    </div>)}
    {isOwner && <div className="local-provider-actions"><select value={memberChoice.actorId} onChange={(event) => setMemberChoice((value) => ({ ...value, actorId: event.target.value }))}><option value="">{candidates.length ? '选择成员加入本项目' : '所有成员都已加入'}</option>{candidates.map((actor) => <option key={actor.id} value={actor.id}>{actor.displayName} · local:{actor.username}</option>)}</select><select value={memberChoice.role} onChange={(event) => setMemberChoice((value) => ({ ...value, role: event.target.value as LocalProjectRole }))}>{assignableRoleOptions}</select><button className="primary-button" disabled={!memberChoice.actorId || busy === 'member:add'} onClick={() => void run('member:add', async () => { await local.setProjectMember(current.id, memberChoice.actorId, memberChoice.role); setMemberChoice((value) => ({ ...value, actorId: '' })) }, '成员已加入。')}><Plus size={12} />加入项目</button></div>}
    {isOwner && <>
      {candidates.length === 0 && <p className="local-run-notice"><Users size={11} />所有已注册成员都已在本项目。要加入新的 {projectRoleLabels.developer}，在下面直接创建账号。</p>}
      {/* Creates the account and grants it this project only; the role chosen here is both its default and its role in this project. */}
      <div className="local-provider-actions project-member-create">
        <input value={newMember.username} onChange={(event) => setNewMember((value) => ({ ...value, username: event.target.value }))} placeholder="用户名" autoComplete="off" />
        <input value={newMember.displayName} onChange={(event) => setNewMember((value) => ({ ...value, displayName: event.target.value }))} placeholder="显示名称" autoComplete="off" />
        <input type="password" value={newMember.password} onChange={(event) => setNewMember((value) => ({ ...value, password: event.target.value }))} placeholder="至少 12 位密码" autoComplete="new-password" />
        <select value={newMember.role} onChange={(event) => setNewMember((value) => ({ ...value, role: event.target.value as LocalProjectRole }))}>{assignableRoleOptions}</select>
        <button className="primary-button" disabled={busy === 'member:create' || !newMember.username.trim() || !newMember.displayName.trim() || newMember.password.length < 12} onClick={() => void run('member:create', async () => { await local.createActor({ username: newMember.username.trim(), displayName: newMember.displayName.trim(), password: newMember.password, role: newMember.role, projectIds: [current.id] }); setNewMember({ username: '', displayName: '', password: '', role: 'developer' }) }, `${newMember.displayName.trim()} 已创建，并以 ${projectRoleLabels[newMember.role]} 加入 ${current.slug}。`)}><Plus size={12} />{busy === 'member:create' ? '创建中' : '新建成员并加入本项目'}</button>
      </div>
    </>}
    </div>
  </section>
  return <>
    <PageHeader eyebrow="设置与集成" title="项目" description="每个项目绑定一个仓库与代码托管方式；成员按项目授予角色，非成员看不到项目内的任何工作。Run 与提案只使用项目配置的仓库。" />
    {error && <p className="local-form-error" role="alert">{error}</p>}
    {notice && !error && <p className="local-run-notice" role="status"><Check size={11} />{notice}</p>}
    <span className="project-section-tag projects"><FolderGit2 size={12} />项目 · {local.projects.length}</span>
    <section className="project-list">
      {local.projects.length === 0 && <div className="panel local-empty"><FolderGit2 size={20} /><p>你还不是任何项目的成员。请联系 Owner。</p></div>}
      {/* The open project moves to the top; the rest keep their order below it. */}
      {[...local.projects].sort((left, right) => Number(right.id === expandedId) - Number(left.id === expandedId)).map((project) => {
        const editing = editingId === project.id && editForm
        const tested = connection?.projectId === project.id ? connection.result : undefined
        const open = expandedId === project.id
        // Opening a project closes the others and makes it current, since members load for the current project only.
        // The card being edited can't be collapsed, and leaving it for another asks first, so unsaved changes aren't lost silently.
        const toggle = () => {
          if (open) return setExpandedId(undefined)
          if (editingId && !window.confirm('放弃未保存的项目配置修改？')) return
          setEditingId(undefined)
          setExpandedId(project.id)
          if (project.id !== local.currentProjectId) void run(`select:${project.id}`, () => local.selectProject(project.id))
        }
        return <article key={project.id} className={`panel project-card ${project.id === local.currentProjectId ? 'current' : ''} ${project.status} ${open ? 'open' : 'collapsed'}`}>
          <button type="button" className="project-card-heading" aria-expanded={open} aria-controls={`project-body-${project.id}`} disabled={Boolean(editing)} onClick={toggle}>
            <span className="project-icon">{project.slug.slice(0, 2).toUpperCase()}</span>
            <div><h2>{project.name}{project.id === DEMO_PROJECT_ID && <em className="project-demo-tag">演示</em>}</h2><small>{project.slug} · {codeHostLabels[project.codeHost]} · {mergeModeLabels[project.mergeMode]} · 你的角色 {projectRoleLabels[local.projectRoles[project.id] ?? 'developer']}{project.id === local.currentProjectId ? ' · 当前项目' : ''}</small></div>
            <span className={`local-status ${project.status === 'active' ? 'approved' : 'closed'}`}>{project.status === 'active' ? '活跃' : '已归档'}</span>
            {open ? <ChevronDown size={16} className="project-card-chevron" /> : <ChevronRight size={16} className="project-card-chevron" />}
          </button>
          {open && <div className="project-card-body" id={`project-body-${project.id}`}>
          <dl className="project-facts"><div><dt>仓库</dt><dd><code>{projectLocation(project)}</code></dd></div><div><dt>默认分支</dt><dd><code>{project.defaultBranch}</code></dd></div>{project.codeHost === 'github' && <div><dt>Token 变量</dt><dd><code>{project.codeHostConfig.tokenEnv ?? '—'}</code></dd></div>}{project.codeHost === 'github' && project.id === local.currentProjectId && <div><dt>最近同步</dt><dd>{local.lastSync ? `${local.lastSync.syncedAt.slice(0, 16).replace('T', ' ')}${local.lastSync.errors.length ? ` · ${local.lastSync.errors.length} 个错误：${local.lastSync.errors[0].code}` : ' · 正常'}` : '服务启动后尚未同步'}</dd></div>}{project.description && <div><dt>说明</dt><dd>{project.description}</dd></div>}</dl>
          {tested && <p className={tested.ok ? 'local-run-notice' : 'local-form-error'} role="status">{tested.ok ? <Check size={11} /> : <ShieldAlert size={11} />}{tested.message}{tested.missingPermissions.length > 0 && ` · 缺少权限：${tested.missingPermissions.join(', ')}`}{!tested.credentialPresent && ' · 服务进程中没有该 token 环境变量'}</p>}
          {editing && <><ProjectHostFields form={editForm} onChange={(patch) => setEditForm((value) => value && ({ ...value, ...patch }))} disabled={busy === `edit:${project.id}`} creating={false} /><p className="local-rule-note"><ShieldAlert size={12} />仓库、托管方式或默认分支的变更需要项目内没有未关闭的提案和进行中的 Run。</p></>}
          <div className="local-provider-actions">
            {(isOwner || local.projectRoles[project.id] === 'maintainer') && <button className="secondary-button" disabled={busy === `test:${project.id}`} onClick={() => void run(`test:${project.id}`, async () => setConnection({ projectId: project.id, result: await local.testProjectConnection(project.id) }))}><Cable size={12} />{busy === `test:${project.id}` ? '检测中' : '测试连接'}</button>}
            {project.codeHost === 'github' && project.status === 'active' && (isOwner || local.projectRoles[project.id] === 'maintainer') && <button className="secondary-button" disabled={busy === `sync:${project.id}`} title="推送提案分支、开 PR、导入 GitHub Checks、回写 aperture/gate；服务端也会定时同步" onClick={() => void run(`sync:${project.id}`, async () => { const report = await local.syncProject(project.id); if (report.errors.length) throw new Error(`同步完成但有 ${report.errors.length} 个错误：${report.errors.map((item) => `${item.proposalId ? `${item.proposalId} ` : ''}${item.code}`).join('；')}`); setNotice(`${project.slug} 已同步：发布 ${report.published} · 导入检查 ${report.checksImported} · 门禁更新 ${report.gateUpdates} · 合并 ${report.merged} · 关闭 ${report.closed}`) })}><RefreshCw size={12} />{busy === `sync:${project.id}` ? '同步中' : '立即同步'}</button>}
            {isOwner && project.status === 'active' && !editing && <button className="secondary-button" onClick={() => { setEditingId(project.id); setEditForm(projectFormFrom(project)) }}><Settings size={12} />编辑配置</button>}
            {isOwner && editing && <><button className="primary-button" disabled={busy === `edit:${project.id}` || !editForm.name.trim()} onClick={() => void run(`edit:${project.id}`, async () => { await local.updateProject(project.id, projectInputFrom(editForm)); setEditingId(undefined) }, `${project.slug} 已更新，配置变更已记入事件日志。`)}><Save size={12} />保存</button><button className="secondary-button" onClick={() => setEditingId(undefined)}><X size={12} />取消</button></>}
            {isOwner && project.status === 'active' && project.id !== DEMO_PROJECT_ID && <button className="secondary-button danger" disabled={busy === `archive:${project.id}`} onClick={() => { if (window.confirm(`归档 ${project.name}？归档后不能再创建 Work Item 或启动 Run。`)) void run(`archive:${project.id}`, () => local.archiveProject(project.id), `${project.slug} 已归档。`) }}><Archive size={12} />归档</button>}
          </div>
          {project.id === current?.id ? membersPanel : <p className="local-run-notice" role="status"><RefreshCw size={11} />正在切换到此项目…</p>}
          </div>}
        </article>
      })}
    </section>
    {isOwner && <section className="panel project-create">
      <RegionBand tone="create" icon={<Plus size={15} />} title="新建项目" subtitle="默认 GitHub · https://github.com/u2pia。本地仓库由服务端校验为 Git 仓库顶层且包含默认分支；GitHub 项目只保存 token 所在的环境变量名。" />
      <div className="region-body">
      <ProjectHostFields form={createForm} onChange={(patch) => setCreateForm((value) => ({ ...value, ...patch }))} disabled={busy === 'create'} creating />
      <div className="local-provider-actions"><button className="primary-button" disabled={busy === 'create' || !createForm.slug.trim() || !createForm.name.trim()} onClick={() => void run('create', async () => { const project = await local.createProject({ ...projectInputFrom(createForm), slug: createForm.slug.trim(), name: createForm.name.trim() }); setCreateForm(emptyProjectForm); await local.selectProject(project.id) }, '项目已创建，所有非 Owner 成员已按默认角色加入，可在上方调整。')}><Plus size={13} />{busy === 'create' ? '创建中' : '创建项目'}</button><small><KeyRound size={11} />不会保存、回显或记录任何 token 值</small></div>
      </div>
    </section>}
  </>
}

function TeamPage() {
  const local = useLocalControlPlane()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'maintainer' | 'reviewer' | 'developer'>('developer')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const [memberEdit, setMemberEdit] = useState<{ actorId: string; displayName: string; role: LocalActor['role']; password: string }>()
  const [memberBusy, setMemberBusy] = useState<string>()
  const [memberError, setMemberError] = useState<string>()
  const [memberNotice, setMemberNotice] = useState<string>()
  const permissions = [
    { capability: '管理成员与集成', owner: 'allow', maintainer: 'allow', reviewer: 'deny', developer: 'deny' },
    { capability: '修改 Policy', owner: 'allow', maintainer: 'approval', reviewer: 'deny', developer: 'deny' },
    { capability: '启动 Agent Run', owner: 'allow', maintainer: 'allow', reviewer: 'allow', developer: 'allow' },
    { capability: '批准普通变更', owner: 'allow', maintainer: 'allow', reviewer: 'allow', developer: 'deny' },
    { capability: '批准高风险变更', owner: 'allow', maintainer: 'allow', reviewer: 'approval', developer: 'deny' },
    { capability: '授权生产发布', owner: 'allow', maintainer: 'approval', reviewer: 'deny', developer: 'deny' },
  ]

  const permissionMark = (state: string) => state === 'allow' ? <span className="permission-allow"><Check size={13} />允许</span> : state === 'approval' ? <span className="permission-approval"><Users size={13} />双人批准</span> : <span className="permission-deny">—</span>

  if (local.status !== 'ready' || !local.actor) return <><PageHeader title="团队" description="本地身份由 SQLite Service 与 HttpOnly Session 管理。" /><section className="panel local-empty"><KeyRound size={20} /><p>请先完成上方本地 Control Plane 初始化或登录。</p></section></>
  const initials = (name: string) => name.split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase()

  return (
    <>
      <PageHeader title={`团队 · ${TEAM_NAME}`} description="管理本地可信身份、角色能力和具名责任。" action={<button className="secondary-button" onClick={() => void local.logout()}>退出登录</button>} />
      <section className="active-actor panel"><span className="member-avatar">{initials(local.actor.displayName)}</span><div><span className="eyebrow">当前登录身份</span><h2>{local.actor.displayName} · {projectRoleLabels[local.actor.role]}{local.currentProject ? ` · ${local.currentProject.slug}: ${local.currentProjectRole ? projectRoleLabels[local.currentProjectRole] : '非成员'}` : ''}</h2><p>local:{local.actor.username} · {local.actor.authMethod === 'github' ? `本次 Session 由 GitHub 证明（github:${local.actor.identity?.login}）` : '本次 Session 由本地密码登录'} · 客户端不能切换</p>{local.actor.authMethod !== 'github' && local.actor.identity && local.githubConfigured && <a className="text-button" href="/api/auth/github/start">用 GitHub 重新登录</a>}<IdentityNotice /></div><div className="active-actor-capabilities"><span className={local.actor.role !== 'developer' ? 'allowed' : 'denied'}>{local.actor.role !== 'developer' ? <Check size={12} /> : <X size={12} />}Review</span><span className={local.actor.role === 'owner' ? 'allowed' : 'denied'}>{local.actor.role === 'owner' ? <Check size={12} /> : <X size={12} />}Manage team</span></div></section>
      <TrustModePanel />
      <section className="team-summary">
        <article className="panel"><span><Users size={17} /></span><div><strong>{local.actors.length}</strong><p>本地成员</p></div></article>
        <article className="panel"><span><Inbox size={17} /></span><div><strong>{local.changeProposals.filter((item) => item.status === 'review_ready').length}</strong><p>待审变更</p></div></article>
        <article className="panel"><span><ShieldCheck size={17} /></span><div><strong>Session</strong><p>服务端身份</p></div></article>
        <article className="panel"><span><Route size={17} /></span><div><strong>{local.events.length}</strong><p>领域事件</p></div></article>
      </section>
      <div className="team-layout"><div className="panel member-list"><PanelHeading title={`${TEAM_NAME} · 团队成员`} subtitle={`${local.actors.length} 名服务端身份 · 禁止浏览器切换 Actor`} />{memberError && <p className="local-form-error" role="alert">{memberError}</p>}{memberNotice && !memberError && <p className="local-run-notice" role="status"><Check size={11} />{memberNotice}</p>}{local.actors.map((member, index) => {
        const isOwnerActor = local.actor?.role === 'owner'
        const editing = memberEdit?.actorId === member.id ? memberEdit : undefined
        const disabled = member.status === 'disabled'
        // Every change goes through the server, which records it as the owner's decision; nothing here is optimistic.
        const act = (key: string, input: LocalActorUpdate, done: string) => void (async () => { setMemberBusy(key); setMemberError(undefined); setMemberNotice(undefined); try { await local.updateActor(member.id, input); setMemberNotice(done); if (key.startsWith('save:')) setMemberEdit(undefined) } catch (caught) { setMemberError(caught instanceof Error ? caught.message : String(caught)) } finally { setMemberBusy(undefined) } })()
        const save = () => {
          if (!editing) return
          const input: LocalActorUpdate = {}
          if (editing.displayName.trim() !== member.displayName) input.displayName = editing.displayName.trim()
          if (editing.role !== member.role && editing.role !== 'owner') input.role = editing.role
          if (editing.password) input.password = editing.password
          if (!Object.keys(input).length) return setMemberEdit(undefined)
          act(`save:${member.id}`, input, `${editing.displayName.trim()} 已更新${input.password ? '，密码已重置' : ''}，变更已记入事件日志。`)
        }
        return <div className={`member-row-wrap ${disabled ? 'disabled' : ''}`} key={member.id}><div className={`member-row ${member.id === local.actor?.id ? 'active' : ''}`}><span className={`member-avatar m${index}`}>{initials(member.displayName)}</span><div><strong>{member.displayName}{disabled && <em className="member-disabled-tag">已停用</em>}</strong><small>local:{member.username} · 默认 {projectRoleLabels[member.role]} · 本项目 {member.role === 'owner' ? `${projectRoleLabels.owner}（隐式）` : (() => { const projectRole = local.projectMembers.find((item) => item.actorId === member.id)?.role; return projectRole ? projectRoleLabels[projectRole] : '非成员' })()}</small><MemberIdentity member={member} /></div>{isOwnerActor && !editing ? <button className="secondary-button" onClick={() => { setMemberError(undefined); setMemberNotice(undefined); setMemberEdit({ actorId: member.id, displayName: member.displayName, role: member.role, password: '' }) }}><Settings size={12} />编辑</button> : <span className="online">{member.id === local.actor?.id ? '当前 Session' : disabled ? '已停用' : '已注册'}</span>}</div>
          {editing && <div className="member-edit">
            <label>显示名称<input value={editing.displayName} onChange={(event) => setMemberEdit({ ...editing, displayName: event.target.value })} /></label>
            <label>默认角色{member.role === 'owner' ? <input value={`${projectRoleLabels.owner}（平台 Owner，不可修改）`} disabled /> : <select value={editing.role} onChange={(event) => setMemberEdit({ ...editing, role: event.target.value as LocalActor['role'] })}>{assignableRoleOptions}</select>}</label>
            <label>重置密码<input type="password" value={editing.password} onChange={(event) => setMemberEdit({ ...editing, password: event.target.value })} placeholder="留空则不修改；至少 12 位" autoComplete="new-password" /></label>
            <p className="local-rule-note"><ShieldAlert size={12} />默认角色只决定以后加入新项目时的角色；已加入项目的角色请在「项目 · 成员与角色」里改。{member.id !== local.actor?.id && '重置密码或停用后，此成员当前登录会立即失效。'}</p>
            <div className="local-provider-actions">
              <button className="primary-button" disabled={memberBusy === `save:${member.id}` || !editing.displayName.trim() || (editing.password.length > 0 && editing.password.length < 12)} onClick={save}><Save size={12} />{memberBusy === `save:${member.id}` ? '保存中' : '保存'}</button>
              <button className="secondary-button" onClick={() => setMemberEdit(undefined)}><X size={12} />取消</button>
              {member.role !== 'owner' && member.id !== local.actor?.id && (disabled
                ? <button className="secondary-button" disabled={memberBusy === `status:${member.id}`} onClick={() => act(`status:${member.id}`, { status: 'active' }, `${member.displayName} 已重新启用。`)}><Check size={12} />重新启用</button>
                : <button className="secondary-button danger" disabled={memberBusy === `status:${member.id}`} onClick={() => { if (window.confirm(`停用 ${member.displayName}？停用后不能登录，也不能被分配审查；历史记录保留。`)) act(`status:${member.id}`, { status: 'disabled' }, `${member.displayName} 已停用。`) }}><LockKeyhole size={12} />停用</button>)}
            </div>
          </div>}
        </div>
      })}</div>{local.actor.role === 'owner' ? <div className="panel local-member-form"><PanelHeading title="创建成员" subtitle="密码只在服务端以 scrypt hash 保存；新成员以所选角色加入全部活跃项目，可在「项目」页调整" /><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" /><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示名称" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 位密码" /><select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>{assignableRoleOptions}</select><button className="primary-button" disabled={creating || !username || !displayName || password.length < 12} onClick={() => void (async () => { setCreating(true); setError(undefined); try { await local.createActor({ username, displayName, password, role }); setUsername(''); setDisplayName(''); setPassword('') } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) } finally { setCreating(false) } })()}><Plus size={14} />{creating ? '创建中…' : '创建成员'}</button>{error && <small className="local-form-error" role="alert">{error}</small>}</div> : <div className="panel local-empty"><LockKeyhole size={19} /><p>只有 Owner 可以创建本地成员。</p></div>}</div>
      <DemoRegion title="权限矩阵" note="下表为设计中的角色能力，不是服务端实际执行的规则；真实约束只有“作者不能自批”“Owner/Maintainer 才能合并”等已在服务端强制的部分。">
        <section className="panel permission-matrix"><div className="team-permission-heading"><div><h2>角色权限矩阵</h2><p>能力来自外部身份绑定和项目角色，Agent 不能为自己授予权限。</p></div><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><Settings size={14} />管理角色</button></div><div className="permission-row permission-head"><span>能力</span>{(['owner', 'maintainer', 'reviewer', 'developer'] as const).map((value) => <span key={value}>{projectRoleLabels[value]}</span>)}</div>{permissions.map((permission) => <div className="permission-row" key={permission.capability}><strong>{permission.capability}</strong>{permissionMark(permission.owner)}{permissionMark(permission.maintainer)}{permissionMark(permission.reviewer)}{permissionMark(permission.developer)}</div>)}</section>
      </DemoRegion>
    </>
  )
}

/**
 * The product charter's own falsification criteria (§8.1), computed from the local Event Log. Rates are shown
 * next to their numerator/denominator because these numbers exist to kill or keep the product hypothesis, and
 * a rate over two approvals cannot do either. Active Review Time is not instrumented, so it says so.
 */
function LocalFalsificationMetrics() {
  const local = useLocalControlPlane()
  if (local.status !== 'ready') return <div className="data-source-note"><span>未连接</span><p>本地 Control Plane 未连接，本页无法给出真实证伪指标。</p></div>
  const metrics = local.reviewMetrics
  const rate = (numerator: number, denominator: number) => denominator === 0 ? undefined : numerator / denominator
  const expansion = rate(metrics.evidenceExpandedApprovalCount, metrics.approvalDecisionCount)
  const firstPass = rate(metrics.firstPassApprovalCount, metrics.decidedProposalCount)
  const rework = rate(metrics.reworkedProposalCount, metrics.decidedProposalCount)
  const show = (value?: number) => value === undefined ? '无样本' : `${Math.round(value * 100)}%`
  const width = (value?: number) => `${Math.round((value ?? 0) * 100)}%`
  const cards = [
    {
      label: '证据展开率',
      value: show(expansion),
      detail: `${metrics.evidenceExpandedApprovalCount} / ${metrics.approvalDecisionCount} 次批准在决策前打开了该 Revision 的证据包`,
      target: expansion === undefined ? '目标 ≥ 70%' : expansion >= 0.7 ? '≥ 70% · 假设暂时成立' : expansion < 0.5 ? '< 50% · 核心假设被推翻' : '目标 ≥ 70%',
      tone: expansion === undefined ? 'violet' : expansion >= 0.7 ? 'green' : expansion < 0.5 ? 'rose' : 'amber',
      bar: width(expansion),
    },
    { label: '首次通过率', value: show(firstPass), detail: `${metrics.firstPassApprovalCount} / ${metrics.decidedProposalCount} 个提案的首个终局决策是批准`, target: '无目标，仅观察', tone: 'violet', bar: width(firstPass) },
    { label: '返工率', value: show(rework), detail: `${metrics.reworkedProposalCount} / ${metrics.decidedProposalCount} 个提案至少被请求修改一次`, target: '无目标，仅观察', tone: 'amber', bar: width(rework) },
    { label: '审查人时 / 已接受变更', value: '未测量', detail: `北极星指标未被采集：没有 Review 会话计时。当前已接受变更 ${metrics.acceptedChangeCount} 个，首个决策中位数 ${formatReviewDuration(metrics.medianDecisionLatencySeconds)}（不等于人时）`, target: '待埋点', tone: 'rose', bar: '0%' },
  ]
  return (
    <>
      <div className="data-source-note live"><span>真实数据 · 本地 Event Log</span><p>以下四项直接来自本地 Event Log 与 evidence_views；比率旁边给出分子/分母，样本过小不能作为结论。</p></div>
      <section className="agentic-metric-grid">{cards.map((card) => <article className="agentic-metric panel" key={card.label}>
        <div><span>{card.label}</span><em className={card.tone}>{card.target}</em></div>
        <strong>{card.value}</strong>
        <p>{card.detail}</p>
        <i><b className={card.tone} style={{ width: card.bar }} /></i>
      </article>)}</section>
    </>
  )
}

function MetricsPage() {
  const agenticMetrics = [
    { label: 'Context Drift', value: '4.2%', detail: '声明与实际读取不一致', target: '目标 < 5%', tone: 'green' },
    { label: 'Reliability Gap', value: '23pt', detail: 'pass@3 94% − pass³ 71%', target: '目标 < 15pt', tone: 'amber' },
    { label: 'Approval Load', value: '0.8', detail: '每个 Run 的人工权限提示', target: '目标 < 1.0', tone: 'green' },
    { label: 'Feedback Conversion', value: '78%', detail: '高价值信号进入 Intent / Eval', target: '目标 > 70%', tone: 'violet' },
  ]

  return (
    <>
      <PageHeader title="度量" description="同时观察审查成本、Agent 可靠性、上下文质量、审批负担和生产学习效率。" />
      <LocalFalsificationMetrics />
      <DemoRegion title="Agentic 指标" note="以下 Agentic 指标、趋势图与漏斗仍为静态演示数据，尚未接入本地 Event Log，不能用于判断产品假设。">
        <section className="agentic-metric-grid">{agenticMetrics.map((metric) => <article className="agentic-metric panel" key={metric.label}><div><span>{metric.label}</span><em className={metric.tone}>{metric.target}</em></div><strong>{metric.value}</strong><p>{metric.detail}</p><i><b className={metric.tone} style={{ width: metric.label === 'Reliability Gap' ? '68%' : metric.label === 'Context Drift' ? '42%' : metric.label === 'Approval Load' ? '56%' : '78%' }} /></i></article>)}</section>
        <div className="metrics-layout">
          <div className="panel trend-panel"><PanelHeading title="审查人时趋势" subtitle="过去 8 周" /><div className="line-chart"><div className="grid-lines"><i/><i/><i/><i/></div><svg viewBox="0 0 600 210" preserveAspectRatio="none" role="img" aria-label="审查人时趋势（样例）：W29 到 W36 持续下降"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f7bff" stopOpacity=".34"/><stop offset="100%" stopColor="#2f7bff" stopOpacity="0"/></linearGradient></defs><path className="area" d="M0,42 C70,62 70,92 140,82 S220,126 290,112 S370,148 430,126 S520,168 600,150 L600,210 L0,210 Z"/><path className="line" d="M0,42 C70,62 70,92 140,82 S220,126 290,112 S370,148 430,126 S520,168 600,150"/></svg><div className="axis-labels"><span>W29</span><span>W30</span><span>W31</span><span>W32</span><span>W33</span><span>W34</span><span>W35</span><span>W36</span></div></div></div>
          <div className="panel outcomes"><PanelHeading title="决策结果" subtitle="最近 30 天" />{[
            { label: '直接通过', value: 61, tone: 'green' }, { label: '请求修改', value: 24, tone: 'amber' }, { label: '终止变更', value: 9, tone: 'rose' }, { label: '仍在等待', value: 6, tone: 'violet' },
          ].map(({ label, value, tone }) => <div className="outcome-row" key={label}><div><span className={`dot ${tone}`} />{label}</div><strong>{value}%</strong><i><b className={tone} style={{ width: `${value}%` }} /></i></div>)}</div>
        </div>
        <section className="panel learning-funnel"><div><h2>生产学习漏斗</h2><p>过去 30 天信号如何转化为工程资产</p></div><div className="funnel-steps">{[
          { label: 'Signals', value: 124, width: '100%' }, { label: 'Triaged', value: 46, width: '76%' }, { label: 'Actionable', value: 28, width: '58%' }, { label: 'Intent / Eval', value: 22, width: '44%' }, { label: 'Verified', value: 17, width: '32%' },
        ].map((step) => <div key={step.label}><span>{step.label}</span><i style={{ width: step.width }} /><strong>{step.value}</strong></div>)}</div></section>
      </DemoRegion>
    </>
  )
}

function ReviewDrawer({ item, onClose }: { item: ReviewItem; onClose: () => void }) {
  const { liveRun, decideLiveReview, canCurrentActor } = useWorkbench()
  const isLiveReview = liveRun?.runId === item.id && liveRun.approved
  const canReview = canCurrentActor('review_change')
  return (
    <><button className="drawer-overlay" onClick={onClose} aria-label="关闭详情" /><aside className="review-drawer"><div className="drawer-header"><div><span>{item.id}</span><RiskBadge risk={item.risk} /></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="drawer-body"><h2>{item.title}</h2><p className="drawer-summary">{item.summary}</p><div className="drawer-meta"><span><GitPullRequest size={14} />{item.files} files</span><span className="additions">+{item.additions}</span><span className="deletions">−{item.deletions}</span><span><Clock3 size={14} />{item.updated}</span></div><section><div className="section-heading"><h3>验收标准</h3><span>{item.coverage}% 有证据</span></div><div className="criteria-list">{item.criteria.map((criterion) => <div key={criterion.label}><span className={criterion.state}>{criterion.state === 'passed' ? <Check size={14} /> : criterion.state === 'warning' ? '!' : '?'}</span><strong>{criterion.label}</strong><small>{criterion.state === 'passed' ? '已通过' : criterion.state === 'warning' ? '需关注' : '未知'}</small></div>)}</div></section><section><div className="section-heading"><h3>关键证据</h3><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">查看完整证据包</button></div><div className="evidence-callout"><FileCheck2 size={18} /><div><strong>{item.evidenceHeadline ?? '142 项测试通过，2 项安全告警'}</strong><p>{item.evidenceDetail ?? '一项关键 AC 目前仅由本次新增测试证明。'}</p></div><ChevronRight size={16} /></div></section><section><div className="section-heading"><h3>上下文差异</h3><span>{item.contextDetail ? '1 个请求已阻断' : '2 个未声明读取'}</span></div>{item.contextDetail ? <div className="evidence-callout"><ShieldCheck size={18} /><div><strong>预防性边界生效</strong><p>{item.contextDetail}</p></div></div> : <div className="context-diff"><span>实际读取</span><code>src/auth/session.ts</code><code className="warning">config/oauth.internal.yml</code></div>}</section></div><div className="drawer-footer"><button className="secondary-button" disabled={!canReview || !isLiveReview || liveRun.reviewDecision === 'changes_requested'} onClick={() => isLiveReview && decideLiveReview(item.id, 'changes_requested')}>{!canReview ? '无评审权限' : liveRun?.reviewDecision === 'changes_requested' ? `已请求修改 · ${liveRun.reviewDecisionBy ?? 'unknown identity'}` : '请求修改'}</button><button className="approve-button" disabled={!canReview || !isLiveReview || liveRun.reviewDecision === 'approved'} onClick={() => isLiveReview && decideLiveReview(item.id, 'approved')}><Check size={16} />{!canReview ? '需要 Reviewer' : liveRun?.reviewDecision === 'approved' ? `变更已批准 · ${liveRun.reviewDecisionBy ?? 'unknown identity'}` : '批准变更'}</button></div></aside></>
  )
}

function describeRunEvent(event: AgentRunEvent) {
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(event.occurredAt))
  if (event.type === 'run_started') return { actor: 'Control Plane', time, text: `通过 ${event.adapterId} 启动运行，请求摘要 ${event.requestDigest}。`, type: 'plan' }
  if (event.type === 'runtime_bound') return { actor: 'Runtime Manager', time, text: `绑定 Model ${event.modelRef}、Harness ${event.harnessRef}、Sandbox ${event.sandboxRef} 和 Session ${event.sessionRef}。`, type: 'plan' }
  if (event.type === 'sandbox_attested') return { actor: 'Sandbox Attestor', time, text: `${event.attestorRef} 将 ${event.sandboxRef} 判定为 ${event.status}：${event.isolation}、${event.networkEgress} egress、${event.writablePaths.length} writable、${event.secretMounts.length} secret mounts，摘要 ${event.attestationDigest}。`, type: event.status === 'verified' ? 'eval' : 'deny' }
  if (event.type === 'harness_profile_selected') return { actor: 'Harness Policy', time, text: `基于 ${event.candidateCount} 个 Eval 候选与 ${event.modelContextBehavior} 上下文能力，为 ${event.modelRef} 选择 ${event.profileId} / ${event.executionMode}，Reset 策略 ${event.contextResetPolicy}。`, type: 'plan' }
  if (event.type === 'workflow_bound') return { actor: 'Workflow Runtime', time, text: `绑定 ${event.workflowId} 到 ${event.providerRef} / ${event.taskQueue}；${event.replayMode} replay，最多 ${event.retryPolicy.maxAttempts} attempts，Human Resume ${event.humanResume}。`, type: 'plan' }
  if (event.type === 'policy_bundle_bound') return { actor: 'Policy Runtime', time, text: `绑定 ${event.bundleId}@${event.bundleVersion} 到 ${event.providerRef}；${event.ruleCount} 条规则，默认 ${event.defaultDecision}，摘要 ${event.bundleDigest}。`, type: 'plan' }
  if (event.type === 'roadmap_created') return { actor: 'Planner', time, text: `创建 Roadmap ${event.roadmapId}：${event.goal}；${event.milestones.length} 个里程碑，摘要 ${event.roadmapDigest}。`, type: 'plan' }
  if (event.type === 'roadmap_updated') return { actor: 'Planner', time, text: `基于 ${event.basedOnRunId} 的评估反馈更新 Roadmap：${event.milestoneUpdates.map((update) => `${update.id}=${update.status}`).join('、')}；下一 Sprint：${event.nextSprintObjective}。`, type: 'plan' }
  if (event.type === 'sprint_planned') return { actor: 'Planner', time, text: `规划 Sprint ${event.sprintId}：${event.objective}；绑定 ${event.milestoneIds.join('、')} 与 ${event.taskIds.length} 个任务，Reset 边界 ${event.contextResetBoundary}。`, type: 'plan' }
  if (event.type === 'plan_created') return { actor: 'Orchestrator', time, text: `生成 ${event.steps.length} 步执行计划：${event.steps.join(' → ')}。`, type: 'plan' }
  if (event.type === 'work_contract_proposed') return { actor: 'Generator', time, text: `提出工作契约 ${event.contractId}：${event.criteria.length} 条验收标准，${event.nonGoals.length} 项非目标，摘要 ${event.contractDigest}。`, type: 'plan' }
  if (event.type === 'work_contract_reviewed') return { actor: 'Independent Evaluator', time, text: `${event.evaluatorRef} 对契约 ${event.contractId} 给出 ${event.decision}；${event.findings.join('；')}。`, type: event.decision === 'accepted' && event.evaluatorRef !== event.generatorRef ? 'eval' : 'deny' }
  if (event.type === 'context_scope_created') return { actor: 'Context Compiler', time, text: `为 ${event.worker} 创建隔离 Scope ${event.scopeId}，预算 ${event.maxTokens.toLocaleString()} tokens，仅允许 ${event.allowedSources.join('、')}。`, type: 'plan' }
  if (event.type === 'context_requested') return { actor: 'Context Gateway', time, text: `请求${event.declared ? '已声明' : '未声明'}上下文 ${event.source}；信任 ${event.trust}，敏感性 ${event.sensitivity}，等待策略决策。`, type: event.declared && event.trust !== 'untrusted' ? 'tool' : 'deny' }
  if (event.type === 'context_consumed') return { actor: 'Context Compiler', time, text: `${event.declared ? '按 Manifest 读取' : '检测到未声明读取'} ${event.source}；信任 ${event.trust}，敏感性 ${event.sensitivity}，内容摘要 ${event.digest}。`, type: event.declared && event.trust !== 'untrusted' ? 'tool' : 'deny' }
  if (event.type === 'context_note_written') return { actor: 'Session Memory', time, text: `写入${event.durable ? '持久' : '临时'} ${event.category} Note ${event.noteRef}，内容摘要 ${event.contentDigest}。`, type: 'docs' }
  if (event.type === 'context_reset_decided') return { actor: 'Context Reset Controller', time, text: `${event.policyId} 因 ${event.trigger} 决定 ${event.action}；${event.usedTokens.toLocaleString()} / ${event.maxTokens.toLocaleString()} tokens。${event.reason}`, type: event.action === 'continue' ? 'plan' : 'docs' }
  if (event.type === 'context_compacted') return { actor: 'Context Compiler', time, text: `使用 ${event.strategy} 将上下文从 ${event.beforeTokens.toLocaleString()} 压缩到 ${event.afterTokens.toLocaleString()} tokens，保留 ${event.preservedNoteRefs.length} 个结构化 Notes。`, type: 'docs' }
  if (event.type === 'usage_reported') return { actor: 'Runtime Budget Guard', time, text: `Usage ${(event.usage.inputTokens + event.usage.outputTokens).toLocaleString()} tokens、${event.usage.toolCalls} tools、${event.usage.elapsedSeconds}s、$${event.usage.estimatedCostUsd.toFixed(2)}；判定 ${event.decision.status}，动作 ${event.decision.action}（${event.decision.reasons.join('；')}）。`, type: event.decision.status === 'exceeded' ? 'deny' : event.decision.status === 'warning' ? 'docs' : 'eval' }
  if (event.type === 'activity_attempt_started') return { actor: 'Workflow Runtime', time, text: `启动 ${event.activityType} Activity ${event.activityId} attempt ${event.attempt}；副作用 ${event.sideEffect}，Timeout ${event.timeoutSeconds}s。`, type: 'plan' }
  if (event.type === 'tool_requested') return { actor: 'Tool Gateway', time, text: `${event.activityId} attempt ${event.attempt} 请求工具 ${event.tool}，所需能力 ${event.capability}，输入摘要 ${event.inputDigest}。`, type: 'tool' }
  if (event.type === 'policy_decided') return { actor: 'Policy Engine', time, text: `${event.decision.decision.toUpperCase()} ${event.tool}：${event.decision.reason}（${event.decision.policyId}@${event.decision.policyVersion}）。`, type: event.decision.decision === 'deny' ? 'deny' : 'tool' }
  if (event.type === 'activity_failed') return { actor: 'Workflow Runtime', time, text: `${event.activityId} attempt ${event.attempt} 因 ${event.errorType} 失败；${event.retryable ? '允许按策略重试' : '不可重试'}，摘要 ${event.errorDigest}。`, type: event.retryable ? 'docs' : 'deny' }
  if (event.type === 'activity_retry_scheduled') return { actor: 'Workflow Runtime', time, text: `${event.activityId} 从 attempt ${event.failedAttempt} 调度到 ${event.nextAttempt}，退避 ${event.backoffSeconds}s；${event.reason}。`, type: 'docs' }
  if (event.type === 'activity_completed') return { actor: 'Workflow Runtime', time, text: `${event.activityId} attempt ${event.attempt} 完成，输出摘要 ${event.outputDigest}。`, type: 'eval' }
  if (event.type === 'artifact_created') return { actor: event.artifactType === 'documentation' ? 'Docs Worker' : event.artifactType === 'test' ? 'Test Worker' : 'Code Worker', time, text: `生成 ${event.artifactType} 产物 ${event.uri}，摘要 ${event.digest}。`, type: event.artifactType === 'documentation' ? 'docs' : 'tool' }
  if (event.type === 'ci_evidence_ingested') return { actor: 'CI Evidence Adapter', time, text: `归一化 ${event.kind.toUpperCase()} 报告 ${event.sourceUri}：${formatCiEvidenceSummary(event)}，状态 ${event.status}。`, type: event.status === 'failed' ? 'deny' : event.status === 'warning' ? 'docs' : 'eval' }
  if (event.type === 'checkpoint_saved') return { actor: 'Session Manager', time, text: `保存检查点 ${event.checkpointRef}；已完成 ${event.completedSteps.length} 步，下一步 ${event.nextStep}，工作区摘要 ${event.workspaceDigest}。`, type: 'docs' }
  if (event.type === 'checkpoint_restored') return { actor: 'Session Manager', time, text: `从 ${event.parentRunId} 恢复检查点 ${event.checkpointRef}，工作区摘要 ${event.workspaceDigest}。`, type: 'docs' }
  if (event.type === 'evaluation_experiment_bound') return { actor: 'Evaluation Provider', time, text: `绑定 Experiment ${event.experimentId}：${event.datasetRef}@${event.datasetVersion}、${event.trialCount} Trials、${event.graderRefs.length} Graders、Trace ${event.traceRef}。`, type: 'eval' }
  if (event.type === 'evaluation_completed') return { actor: 'Evaluator', time, text: `${event.suiteId} 完成：${event.passed} passed，${event.failed} failed，${event.unknown} unknown。`, type: event.failed > 0 ? 'deny' : 'eval' }
  if (event.type === 'evaluation_diagnosed') return { actor: 'Eval Investigator', time, text: `已检查 Transcript 与隔离环境，将 ${event.failures.length} 个失败归因为 ${event.failures.map((failure) => `${failure.taskId}:${failure.category}@${Math.round(failure.confidence * 100)}%`).join('、')}；clean start ${event.environment.cleanStart ? 'yes' : 'no'}，shared state ${event.environment.sharedStateDetected ? 'detected' : 'clear'}。`, type: event.failures.some((failure) => failure.category === 'infrastructure' || failure.category === 'harness') ? 'docs' : 'eval' }
  return { actor: 'Control Plane', time, text: `运行以 ${event.status} 状态结束，输出摘要 ${event.outputDigest}。`, type: event.status === 'succeeded' ? 'eval' : 'deny' }
}

function formatCiEvidenceSummary(event: Extract<AgentRunEvent, { type: 'ci_evidence_ingested' }>) {
  if (event.kind === 'junit') return `${event.summary.passed ?? 0}/${event.summary.tests ?? 0} passed · ${event.summary.failed ?? 0} failed`
  if (event.kind === 'sarif') return `${event.summary.errors ?? 0} errors · ${event.summary.warnings ?? 0} warnings`
  return `${event.summary.lineCoverage ?? 0}% line · ${event.summary.branchCoverage ?? 0}% branch coverage`
}

function RunDrawer({ run, onClose }: { run: RunItem; onClose: () => void }) {
  const [tab, setTab] = useState<'概览' | 'Transcript' | 'Evidence'>('概览')
  const { liveRun, approveLiveRun, cancelLiveRun, resumeMockRun, restartInterruptedRun, canCurrentActor } = useWorkbench()
  const liveEvents = liveRun?.runId === run.id ? liveRun.events : null
  const staticTranscript = [
    { actor: 'Orchestrator', time: '10:12:04', text: '将任务拆分为实现、测试和文档三个隔离子任务。', type: 'plan' },
    { actor: 'Code Worker', time: '10:12:18', text: '读取身份绑定规范与现有 OIDC provider，准备修改 8 个文件。', type: 'tool' },
    { actor: 'Policy', time: '10:14:33', text: '拒绝读取 config/oauth.internal.yml：资源未在 Context Manifest 中声明。', type: 'deny' },
    { actor: 'Test Worker', time: '10:17:09', text: '执行 42 个评估任务，40 passed，2 need review。', type: 'eval' },
    { actor: 'Docs Worker', time: '10:18:41', text: '更新身份绑定说明、运行手册和变更日志。', type: 'docs' },
  ]
  const transcript = liveEvents ? liveEvents.map(describeRunEvent) : staticTranscript
  const roadmap = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'roadmap_created' }> => event.type === 'roadmap_created')
  const roadmapUpdate = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'roadmap_updated' }> => event.type === 'roadmap_updated').at(-1)
  const sprint = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'sprint_planned' }> => event.type === 'sprint_planned')
  const planEvent = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'plan_created' }> => event.type === 'plan_created')
  const selectedHarness = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'harness_profile_selected' }> => event.type === 'harness_profile_selected')
  const workflow = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'workflow_bound' }> => event.type === 'workflow_bound')
  const activityAttempts = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'activity_attempt_started' }> => event.type === 'activity_attempt_started') ?? []
  const activityRetries = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'activity_retry_scheduled' }> => event.type === 'activity_retry_scheduled') ?? []
  const proposedContract = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'work_contract_proposed' }> => event.type === 'work_contract_proposed')
  const contractReview = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'work_contract_reviewed' }> => event.type === 'work_contract_reviewed')
  const contractAccepted = Boolean(proposedContract && contractReview?.decision === 'accepted' && contractReview.contractId === proposedContract.contractId && contractReview.contractDigest === proposedContract.contractDigest && contractReview.evaluatorRef !== contractReview.generatorRef)
  const artifacts = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'artifact_created' }> => event.type === 'artifact_created') ?? []
  const ciEvidence = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'ci_evidence_ingested' }> => event.type === 'ci_evidence_ingested') ?? []
  const evaluation = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const checkpoints = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'checkpoint_saved' }> => event.type === 'checkpoint_saved') ?? []
  const restoredCheckpoints = liveEvents?.filter((event): event is Extract<AgentRunEvent, { type: 'checkpoint_restored' }> => event.type === 'checkpoint_restored') ?? []
  const contextReads = liveEvents?.filter((event) => event.type === 'context_consumed') ?? []
  const contextRequests = liveEvents?.filter((event) => event.type === 'context_requested') ?? []
  const toolRequests = liveEvents?.filter((event) => event.type === 'tool_requested') ?? []
  const usageReport = liveEvents?.slice().reverse().find((event): event is Extract<AgentRunEvent, { type: 'usage_reported' }> => event.type === 'usage_reported')
  const policyDenials = liveEvents?.filter((event) => event.type === 'policy_decided' && event.decision.decision === 'deny') ?? []
  const undeclaredRequests = contextRequests.filter((event) => event.type === 'context_requested' && !event.declared)
  const completed = liveEvents?.some((event) => event.type === 'run_completed') ?? false
  const interrupted = liveEvents ? Boolean(liveRun?.interrupted) : false
  const integrityValid = liveEvents ? Boolean(liveRun?.integrityValid) : true
  const sealedEvidence = liveEvents ? liveRun?.evidencePackage : undefined
  const sealedEvidenceVerified = sealedEvidence?.repositoryVerified ?? false
  const canApproveRun = canCurrentActor('approve_run')
  const livePlan = (planEvent?.steps ?? ['compile context', 'implement change', 'run tests', 'update docs', 'evaluate']).map((step, index) => {
    const reached = [contextReads.length > 0, artifacts.some((event) => event.artifactType === 'patch'), artifacts.some((event) => event.artifactType === 'test'), artifacts.some((event) => event.artifactType === 'documentation'), Boolean(evaluation)]
    const done = completed || reached[index]
    const active = !done && (index === 0 || reached[index - 1])
    return [step, done ? 'done' : active ? 'active' : 'pending'] as const
  })
  const plan = liveEvents ? livePlan : [
    ['理解 Intent 与约束', 'done'], ['编译并校验上下文', 'done'], ['实现 + Tests + Docs', 'done'], ['运行 Evaluation Suite', 'active'], ['生成 Evidence Package', 'pending'],
  ] as const
  const exportTranscript = () => {
    if (!liveEvents) return
    downloadArtifact(`${run.id.toLowerCase()}-events.jsonl`, liveEvents.map((event) => JSON.stringify(event)).join('\n'), 'application/x-ndjson')
  }

  return (
    <>
      <button className="drawer-overlay" onClick={onClose} aria-label="关闭运行详情" />
      <aside className="run-drawer">
        <div className="drawer-header"><div><span>{run.id}</span><span className={`state-pill ${run.tone}`}>{run.state}</span></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <div className="run-drawer-title"><div className={`run-icon ${run.tone}`}><Bot size={18} /></div><div><h2>{run.label}</h2><p>{run.agent} · {run.duration}</p></div></div>
        <div className="drawer-tabs">{(['概览', 'Transcript', 'Evidence'] as const).map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
        <div className="run-drawer-body">
          {tab === '概览' && <>
            <section className="run-detail-section"><div className="section-heading"><h3>Roadmap → Sprint</h3><span>{sprint?.contextResetBoundary ?? 'after evaluation'}</span></div><div className="planning-chain"><div><span>Roadmap</span><strong>{roadmap?.goal ?? '交付可审计的企业身份绑定变更'}</strong><small>{roadmap ? `${roadmap.milestones.length} milestones · ${roadmap.roadmapId}` : '3 milestones · sample roadmap'}</small></div><ArrowRight size={15} /><div><span>Sprint</span><strong>{sprint?.objective ?? '实现、测试、文档与独立评估'}</strong><small>{sprint ? `${sprint.taskIds.length} tasks · ${sprint.sprintId}` : '3 tasks · sample sprint'}</small></div></div>{roadmapUpdate && <div className="roadmap-next"><RefreshCw size={13} /><div><span>Evaluator feedback → next sprint</span><strong>{roadmapUpdate.nextSprintObjective}</strong></div><code>{roadmapUpdate.roadmapDigest}</code></div>}</section>
            <section className="run-detail-section"><div className="section-heading"><h3>执行计划</h3><span>{plan.filter(([, state]) => state === 'done').length} / {plan.length} steps</span></div><div className="execution-plan">{plan.map(([label, state], index) => <div className={state} key={label}><span>{state === 'done' ? <Check size={13} /> : index + 1}</span><strong>{label}</strong><small>{state === 'done' ? '完成' : state === 'active' ? '进行中' : '等待'}</small></div>)}</div></section>
            <section className="run-detail-section"><div className="section-heading"><h3>工作契约</h3><span>{liveEvents ? contractAccepted ? 'independently accepted' : 'not accepted' : 'sample contract'}</span></div><div className={`work-contract-card ${contractAccepted || !liveEvents ? 'accepted' : 'blocked'}`}><div><strong>{proposedContract?.objective ?? '生成者与评估者先确认可测试的完成定义'}</strong><p>{proposedContract ? `${proposedContract.criteria.length} 条验收标准 · ${proposedContract.nonGoals.length} 项非目标` : '3 条验收标准 · 2 项非目标'}</p></div><span>{contractAccepted ? <Check size={15} /> : <ShieldAlert size={15} />}{contractReview?.evaluatorRef ?? 'independent evaluator'}</span><code>{proposedContract?.contractDigest ?? 'fnv1a:sample-contract'}</code></div></section>
            <section className="run-detail-section"><div className="section-heading"><h3>编排拓扑</h3><span>{selectedHarness?.profileId ?? '3 workers'}</span></div><div className="mini-topology"><div><Workflow size={15} /><strong>Orchestrator</strong></div><ArrowRight size={14} /><div className="mini-workers"><span>Code</span><span>Test</span><span>Docs</span></div><ArrowRight size={14} /><div><FlaskConical size={15} /><strong>Evaluator</strong></div></div></section>
            <section className="run-detail-section"><div className="section-heading"><h3>Durable Workflow</h3><span>{workflow?.replayMode ?? 'event history'}</span></div><div className="run-boundary-grid"><div><span>Workflow</span><strong>{workflow?.workflowId ?? 'workflow://sample-run'}</strong></div><div><span>Provider</span><strong>{workflow?.providerRef ?? 'embedded history'}</strong></div><div><span>Activity Attempts</span><strong>{liveEvents ? activityAttempts.length : 5}</strong></div><div><span>Retries</span><strong className={activityRetries.length ? 'warning-text' : ''}>{liveEvents ? activityRetries.length : 1}</strong></div><div><span>Max Attempts</span><strong>{workflow?.retryPolicy.maxAttempts ?? 3}</strong></div><div><span>Human Resume</span><strong>{workflow?.humanResume ?? 'approval_required'}</strong></div></div></section>
            <section className="run-detail-section"><div className="section-heading"><h3>边界与消耗</h3><span>{usageReport ? `${usageReport.decision.status} · ${usageReport.decision.action}` : liveEvents ? '等待 Usage 事件' : '样例快照'}</span></div><div className="run-boundary-grid"><div><span>上下文读取</span><strong>{liveEvents ? `${contextReads.length} sources` : '54.2K / 80K'}</strong></div><div><span>累计 Tokens</span><strong className={usageReport?.decision.status !== 'within' ? 'warning-text' : ''}>{usageReport ? `${((usageReport.usage.inputTokens + usageReport.usage.outputTokens) / 1_000).toFixed(1)}K / ${(usageReport.budget.maxTokens / 1_000).toFixed(0)}K` : '—'}</strong></div><div><span>工具调用</span><strong>{usageReport ? `${usageReport.usage.toolCalls} / ${usageReport.budget.maxToolCalls}` : liveEvents ? toolRequests.length : 37}</strong></div><div><span>运行时长</span><strong>{usageReport ? `${usageReport.usage.elapsedSeconds}s / ${usageReport.budget.maxDurationSeconds}s` : '—'}</strong></div><div><span>估算成本</span><strong>{usageReport ? `$${usageReport.usage.estimatedCostUsd.toFixed(2)} / $${usageReport.budget.maxCostUsd?.toFixed(2) ?? '—'}` : '—'}</strong></div><div><span>策略拒绝 / 未声明</span><strong className={policyDenials.length || undeclaredRequests.length ? 'warning-text' : ''}>{liveEvents ? `${policyDenials.length} / ${undeclaredRequests.length}` : '1 / 2'}</strong></div></div></section>
          </>}

          {tab === 'Transcript' && <section className="run-detail-section transcript-section"><div className="section-heading"><h3>运行轨迹</h3><button disabled={!liveEvents} onClick={exportTranscript}>{liveEvents ? `导出 ${liveEvents.length} 条 JSONL` : '样例轨迹'}</button></div><div className="transcript-list">{transcript.map((event, index) => <div className={`transcript-event ${event.type}`} key={`${event.time}-${event.actor}-${index}`}><span className="transcript-line" /><div><span><strong>{event.actor}</strong><time>{event.time}</time></span><p>{event.text}</p></div></div>)}</div></section>}

          {tab === 'Evidence' && <>
            <section className="run-detail-section"><div className="section-heading"><h3>Tests + Docs + Evidence</h3><span>{liveEvents ? `${artifacts.length} 个产物 · ${ciEvidence.length} 个 CI 报告` : '本次运行产物'}</span></div><div className="run-evidence-list">{liveEvents ? <><div><span className={integrityValid ? 'passed' : 'warning'}>{integrityValid ? <Fingerprint size={14} /> : <ShieldAlert size={14} />}</span><div><strong>Session 事件摘要链</strong><p>{integrityValid ? `${liveEvents.length} 个事件顺序、前序摘要与事件摘要均已验证` : '检测到序列、前序摘要或事件摘要不一致，所有后续门禁已阻断'}</p></div><em>{liveEvents.at(-1)?.eventDigest ?? 'no chain head'}</em></div><div><span className={sealedEvidenceVerified ? 'passed' : sealedEvidence ? 'warning' : 'pending'}>{sealedEvidenceVerified ? <PackageCheck size={14} /> : sealedEvidence ? <ShieldAlert size={14} /> : <Clock3 size={14} />}</span><div><strong>{sealedEvidenceVerified ? 'Evidence Repository 已持久复验' : sealedEvidence ? 'Evidence Repository 复验失败' : 'Evidence Repository 等待终态'}</strong><p>{sealedEvidence?.uri ?? '逐事件验证通过且 Run 结束后写入离线仓库。'}</p></div><em>{sealedEvidence?.digest ?? 'not finalized'}</em></div>{artifacts.map((artifact) => <div key={artifact.digest}><span className="passed"><Check size={14} /></span><div><strong>{artifact.artifactType === 'test' ? '自动化测试' : artifact.artifactType === 'documentation' ? '文档同步' : artifact.artifactType === 'patch' ? '代码补丁' : '运行报告'}</strong><p>{artifact.uri}</p></div><em>{artifact.digest}</em></div>)}{ciEvidence.map((report) => <div key={`${report.kind}-${report.digest}`}><span className={report.status === 'passed' ? 'passed' : 'warning'}>{report.status === 'passed' ? <Check size={14} /> : <ShieldAlert size={14} />}</span><div><strong>{report.kind === 'junit' ? 'JUnit 测试结果' : report.kind === 'sarif' ? 'SARIF 安全扫描' : 'LCOV 覆盖率'}</strong><p>{report.tool} · {formatCiEvidenceSummary(report)} · {report.sourceUri}</p></div><em>{report.digest}</em></div>)}{checkpoints.map((checkpoint) => <div key={checkpoint.checkpointRef}><span className="passed"><Archive size={14} /></span><div><strong>可恢复检查点</strong><p>下一步：{checkpoint.nextStep} · {checkpoint.completedSteps.length} steps completed</p></div><em>{checkpoint.workspaceDigest}</em></div>)}{restoredCheckpoints.map((checkpoint) => <div key={`${checkpoint.parentRunId}-${checkpoint.checkpointRef}`}><span className="passed"><RefreshCw size={14} /></span><div><strong>已恢复检查点</strong><p>继承自 {checkpoint.parentRunId}</p></div><em>{checkpoint.workspaceDigest}</em></div>)}{policyDenials.map((event) => event.type === 'policy_decided' && <div key={`${event.sequence}-${event.decision.policyId}`}><span className="warning"><ShieldAlert size={14} /></span><div><strong>策略阻断已生效</strong><p>{event.decision.reason}</p></div><em>{event.decision.policyId}@{event.decision.policyVersion}</em></div>)}</> : <><div><span className="passed"><Check size={14} /></span><div><strong>自动化测试</strong><p>142 passed · 2 warnings · 0 failed</p></div><em>既有 + 新增</em></div><div><span className="passed"><Check size={14} /></span><div><strong>文档同步</strong><p>身份规范、运行手册、CHANGELOG</p></div><em>3 / 3 updated</em></div><div><span className="warning"><ShieldAlert size={14} /></span><div><strong>证明来源独立性</strong><p>1 条 Critical AC 仅由本次新增测试覆盖</p></div><em>需人工确认</em></div></>}</div></section>
            <section className="run-detail-section"><div className="section-heading"><h3>Evaluation</h3><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">打开 Eval Suite</button></div><div className="evaluation-summary"><div><strong>{evaluation ? `${Math.round((evaluation.passed / Math.max(evaluation.passed + evaluation.failed + evaluation.unknown, 1)) * 100)}%` : '93%'}</strong><span>通过率</span></div><div><strong>{evaluation?.passed ?? 40}</strong><span>passed</span></div><div><strong>{evaluation?.failed ?? 2}</strong><span>failed</span></div></div></section>
          </>}
        </div>
        <div className="drawer-footer"><button className="secondary-button" disabled={!liveEvents || !integrityValid || (!interrupted && completed && checkpoints.length === 0)} onClick={() => { if (!liveEvents) return; if (interrupted) { const checkpoint = checkpoints.at(-1); if (checkpoint) void resumeMockRun(run.id, checkpoint.checkpointRef, checkpoint.workspaceDigest); else void restartInterruptedRun(run.id); onClose(); return } if (!completed) cancelLiveRun(run.id); else if (checkpoints.at(-1)) { const checkpoint = checkpoints.at(-1)!; void resumeMockRun(run.id, checkpoint.checkpointRef, checkpoint.workspaceDigest); onClose() } }}>{!integrityValid ? '完整性失败' : interrupted ? checkpoints.length ? '恢复中断 Run' : '封存并重新开始' : completed ? checkpoints.length ? '从检查点恢复' : 'Run 已结束' : '取消 Run'}</button><button className="approve-button" disabled={interrupted || !canApproveRun || !liveEvents || !integrityValid || !completed || !liveRun?.reviewRequired || liveRun.approved} onClick={() => liveEvents && approveLiveRun(run.id)}><Check size={16} />{interrupted ? '中断 Run 不可审批' : !canApproveRun ? '无运行审批权限' : !integrityValid ? '门禁已阻断' : liveRun?.approved ? `已批准 · ${liveRun.runGateApprovedBy ?? 'unknown identity'}` : liveRun?.reviewRequired ? '批准进入评审' : '无需额外批准'}</button></div>
      </aside>
    </>
  )
}

function EvalTaskDrawer({ task, onClose }: { task: EvalTaskItem; onClose: () => void }) {
  const [tab, setTab] = useState<'Task' | 'Trials' | 'Graders' | 'Transcript'>('Task')
  const { liveRun, regressionAssets, advanceRegressionAsset, runRegressionTrials } = useWorkbench()
  const liveEvents = task.liveRunId && liveRun?.runId === task.liveRunId ? liveRun.events : null
  const liveEvaluation = liveEvents?.find((event): event is Extract<AgentRunEvent, { type: 'evaluation_completed' }> => event.type === 'evaluation_completed')
  const regressionAsset = task.regressionId ? regressionAssets.find((asset) => asset.outputId === task.regressionId) : undefined
  const regressionReady = Boolean(regressionAsset?.fixtureReady && regressionAsset.graderReady && regressionAsset.referenceReady)
  const trials = regressionAsset?.trials.length ? regressionAsset.trials : task.derived || liveEvents ? [] : [
    { id: 'TRL-01', batch: 1, seed: 'a18f', result: 'failed' as const, durationSeconds: 222, reason: '账号冲突后重复创建 IdentityBinding' },
    { id: 'TRL-02', batch: 1, seed: 'bc41', result: 'passed' as const, durationSeconds: 198, reason: '所有断言通过' },
    { id: 'TRL-03', batch: 1, seed: 'd902', result: 'failed' as const, durationSeconds: 246, reason: '恢复流程遗漏审计事件' },
  ]
  const latestBatch = regressionAsset?.trials.at(-1)?.batch
  const visibleTrials = latestBatch ? trials.filter((trial) => trial.batch === latestBatch) : trials
  const trialMetric = regressionAsset?.baselineCaptured ? `pass@3 ${regressionAsset.passAtK}% · pass³ ${regressionAsset.passPowerK}%` : visibleTrials.length ? `${visibleTrials.filter((trial) => trial.result === 'passed').length} / ${visibleTrials.length} passed` : liveEvaluation ? `${liveEvaluation.passed + liveEvaluation.failed + liveEvaluation.unknown} aggregate results` : 'not started'

  return (
    <>
      <button className="drawer-overlay" onClick={onClose} aria-label="关闭评估任务详情" />
      <aside className="eval-task-drawer">
        <div className="drawer-header"><div><span>{task.id}</span><span className={`eval-task-kind ${task.derived ? 'derived' : ''}`}>{task.kind}</span></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <div className="eval-task-title"><div className={`eval-failure-icon ${task.tone}`}>{task.derived ? <RefreshCw size={13} /> : '!'}</div><div><h2>{task.title}</h2><p>{task.detail}</p></div></div>
        <div className="drawer-tabs">{(['Task', 'Trials', 'Graders', 'Transcript'] as const).map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
        <div className="eval-task-body">
          {tab === 'Task' && <>
            <section className="eval-detail-section"><span className="intent-label">任务定义</span><p className="eval-task-description">{liveEvents ? `诊断 ${task.liveRunId} 的聚合 Evaluation 失败；先阅读真实 Session Transcript，再决定是 Agent、Task、Grader 还是环境问题。` : `在隔离工作区中复现“${task.title}”，要求 Agent 在不扩大权限和不修改评估夹具的前提下完成修复。`}</p></section>
            {regressionAsset?.sourceRef?.kind === 'trace_span' && <section className="eval-detail-section"><div className="section-heading"><h3>Trace Evidence Source</h3><span>human captured</span></div><div className="regression-source-grid"><div><span>Run</span><code>{regressionAsset.sourceRef.runId ?? 'unknown'}</code></div><div><span>Trace</span><code>{regressionAsset.sourceRef.traceId ?? 'unknown'}</code></div><div><span>Span</span><code>{regressionAsset.sourceRef.spanId ?? 'unknown'}</code></div><div><span>Projection</span><code>{regressionAsset.sourceRef.projectionDigest ?? 'unknown'}</code></div><div><span>Event</span><code>{regressionAsset.sourceRef.eventDigest ?? 'unknown'}</code></div></div></section>}
            <section className="eval-detail-section"><div className="section-heading"><h3>成功条件</h3><span>{task.derived || liveEvents ? '待固化' : '4 assertions'}</span></div><div className="eval-assertions">{(task.derived || liveEvents ? ['提取失败输入与环境快照', '定义确定性失败断言', '补充 Reference Solution'] : ['冲突账号不会产生重复身份绑定', '原有权限和审查关系保持不变', '失败与恢复均写入审计事件', '所有修改限制在批准目录']).map((assertion, index) => <div key={assertion}><span className={task.derived || liveEvents ? 'pending' : 'passed'}>{task.derived || liveEvents ? index + 1 : <Check size={13} />}</span><strong>{assertion}</strong></div>)}</div></section>
            {regressionAsset && <section className="eval-detail-section"><div className="section-heading"><h3>Regression Contract</h3><span>{regressionReady ? 'ready for trials' : `${[regressionAsset.fixtureReady, regressionAsset.graderReady, regressionAsset.referenceReady].filter(Boolean).length} / 3 ready`}</span></div><div className="regression-contract-list">{[
              ['Fixture', regressionAsset.fixtureReady, '失败输入、环境与依赖快照'], ['Deterministic Grader', regressionAsset.graderReady, '可重复判定原始失败是否出现'], ['Reference Solution', regressionAsset.referenceReady, '用于校准任务与 Grader 正确性'],
            ].map(([label, ready, detail]) => <div className={ready ? 'ready' : ''} key={String(label)}><span>{ready ? <Check size={13} /> : <Clock3 size={13} />}</span><div><strong>{label}</strong><small>{detail}</small></div><em>{ready ? '已准备' : '待配置'}</em></div>)}</div></section>}
            <section className="eval-detail-section"><div className="section-heading"><h3>环境与夹具</h3><span>{liveEvents ? 'captured from run' : 'reproducible'}</span></div><div className="eval-fixture-grid"><div><span>Run</span><code>{task.liveRunId ?? 'sha256:61ac…c933'}</code></div><div><span>Session events</span><code>{liveEvents?.length ?? '8f3a2c1'}</code></div><div><span>Dataset</span><code>{task.derived || liveEvents ? 'not-created' : 'sso-conflict-v4'}</code></div><div><span>Reference</span><code>{task.derived || liveEvents ? 'missing' : 'ref/identity-merge.ts'}</code></div></div></section>
          </>}

          {tab === 'Trials' && <section className="eval-detail-section"><div className="section-heading"><h3>独立 Trials</h3><span>{trialMetric}</span></div>{regressionAsset?.baselineCaptured && <div className="trial-metric-strip"><div><strong>{regressionAsset.passAtK}%</strong><span>pass@3 · 至少一次成功</span></div><div className={regressionAsset.passPowerK < 100 ? 'attention' : ''}><strong>{regressionAsset.passPowerK}%</strong><span>pass³ · 三次全部成功</span></div><div><strong>{latestBatch}</strong><span>当前 Trial Batch</span></div></div>}{visibleTrials.length ? <div className="trial-list">{visibleTrials.map((trial) => <div key={trial.id}><span className={trial.result}>{trial.result === 'passed' ? <Check size={13} /> : '!'}</span><div><strong>{trial.id}</strong><small>batch {trial.batch} · seed {trial.seed} · {Math.floor(trial.durationSeconds / 60)}m {String(trial.durationSeconds % 60).padStart(2, '0')}s</small></div><em>{trial.reason}</em><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更" aria-label="查看详情（原型控件，未接入）"><ChevronRight size={14} /></button></div>)}</div> : <div className="eval-empty-state"><FlaskConical size={20} /><strong>{liveEvaluation ? 'Adapter 仅上报聚合结果' : '尚未运行 Trial'}</strong><p>{liveEvaluation ? '创建 Regression 后补齐独立 Trial、Seed、Fixture 和失败原因，不能用聚合数字替代可复现任务。' : '先补齐任务定义、确定性 Grader 和 Reference Solution。'}</p></div>}</section>}

          {tab === 'Graders' && <section className="eval-detail-section"><div className="section-heading"><h3>Grader 组合</h3><span>{task.derived ? 'incomplete' : '3 graders'}</span></div><div className="grader-list"><div><span className="deterministic"><CheckCircle2 size={15} /></span><div><strong>Deterministic assertions</strong><p>数据库状态、审计事件、权限不变量</p></div><em>{task.derived ? '待配置' : '70%'}</em></div><div><span className="model"><Sparkles size={15} /></span><div><strong>Model grader</strong><p>检查修复解释和残余风险是否完整</p></div><em>{task.derived ? '可选' : '20%'}</em></div><div><span className="human"><Users size={15} /></span><div><strong>Human calibration</strong><p>抽样复核模型评分和任务歧义</p></div><em>{task.derived ? '待分配' : '10%'}</em></div></div><div className="grader-warning"><ShieldAlert size={15} /><p>模型 Grader 不能成为 Critical Acceptance Criterion 的唯一证明。</p></div></section>}

          {tab === 'Transcript' && <section className="eval-detail-section"><div className="section-heading"><h3>失败 Trial Transcript</h3><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">打开完整 Trace</button></div>{task.derived ? <div className="eval-empty-state"><FileText size={20} /><strong>尚无 Transcript</strong><p>首轮 Trial 完成后，将在这里显示 Agent 推理轨迹、工具调用和环境结果。</p></div> : liveEvents ? <div className="eval-transcript">{liveEvents.map((event) => { const entry = describeRunEvent(event); return <div className={entry.type === 'deny' ? 'warning' : ''} key={event.sequence}><time>{entry.time}</time><span>{entry.actor}</span><p>{entry.text}</p></div> })}</div> : <div className="eval-transcript"><div><time>00:14</time><span>Agent</span><p>检测到两个用户记录共享相同 email，准备合并 IdentityBinding。</p></div><div><time>00:37</time><span>Tool</span><p>读取 `src/auth/identity-binding.ts` 和既有迁移逻辑。</p></div><div className="warning"><time>01:52</time><span>Grader</span><p>失败：创建了第二条绑定记录，违反唯一性不变量。</p></div><div><time>02:08</time><span>Agent</span><p>尝试回滚，但没有写入 `identity.binding.rollback` 审计事件。</p></div></div>}</section>}
        </div>
        <div className="drawer-footer">{regressionAsset ? <><button className="secondary-button" disabled={regressionReady} onClick={() => advanceRegressionAsset(regressionAsset.outputId)}>{regressionReady ? '合同已完整' : '配置下一项'}</button><button className="primary-button" disabled={!regressionReady} onClick={() => runRegressionTrials(regressionAsset.outputId)}><Play size={15} />{regressionAsset.trialsRun ? `再次运行 3 Trials` : '运行 3 Trials'}</button></> : <><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">编辑 Task</button><button className="primary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更"><Play size={15} />运行 3 Trials</button></>}</div>
      </aside>
    </>
  )
}

function IntentDrawer({ intent, onClose }: { intent: IntentItem; onClose: () => void }) {
  const [tab, setTab] = useState<'意图' | '验收标准' | '关系'>('意图')
  const localDate = new Intl.DateTimeFormat('en-CA').format(new Date())
  const isSsoIntent = intent.id === 'INT-142'
  const isGitHubSource = intent.source?.startsWith('github:#') ?? false
  const sourceIssueId = isGitHubSource ? intent.source?.replace('github:#', '') : isSsoIntent ? '142' : null
  const goal = isSsoIntent
    ? '让使用企业身份系统的小团队能够统一登录、撤销访问，并保留 Control Plane 中已有的成员和审查关系。'
    : `解决“${intent.title}”对应的真实用户或生产问题，并把结果转化为可验证、可回归的软件能力。`
  const outcomes = isSsoIntent
    ? ['管理员在 10 分钟内完成 OIDC 配置', '成员首次登录自动绑定现有账号', '身份异常产生可追溯审计事件']
    : ['问题可以被确定性方式复现', '修复结果拥有至少一项独立证据', '同类失败被加入持续回归评估']
  const constraints = isSsoIntent
    ? ['Self-hosted', 'Offline compatible', '不存储 IdP 密码', '现有 GitHub 身份不失效']
    : ['不扩大生产写权限', '保留现有行为兼容性', '必须关联原始生产信号', '新增回归任务']
  const unknowns = isSsoIntent
    ? ['一个用户是否允许同时绑定多个企业身份？', '离线环境的 Metadata 更新由谁触发？']
    : ['当前信号的根因是否唯一？', '修复是否需要数据或配置迁移？']
  const criteria = isSsoIntent ? [
    { id: 'AC-01', text: '企业管理员可以为工作区配置一个 OIDC Provider', criticality: 'Critical', evidence: 'EVS-014 / TASK-01', state: 'linked' },
    { id: 'AC-02', text: '现有用户可以在不丢失权限的情况下绑定企业身份', criticality: 'Critical', evidence: 'EVS-014 / TASK-08', state: 'linked' },
    { id: 'AC-03', text: '管理员撤销会话后 60 秒内全局生效', criticality: 'Required', evidence: 'EVS-014 / TASK-18', state: 'linked' },
    { id: 'AC-04', text: '离线部署环境可使用本地身份提供方完成登录', criticality: 'Required', evidence: '尚未定义', state: 'missing' },
  ] : [
    { id: 'AC-01', text: `${intent.title}的触发条件可以稳定复现`, criticality: 'Critical', evidence: '尚未定义', state: 'missing' },
    { id: 'AC-02', text: '修复后关键用户路径恢复到基线范围', criticality: 'Critical', evidence: '尚未定义', state: 'missing' },
    { id: 'AC-03', text: '新增 Regression Task 可阻止同类问题再次发布', criticality: 'Required', evidence: '待创建 Eval Task', state: 'missing' },
  ]

  return (
    <>
      <button className="drawer-overlay" onClick={onClose} aria-label="关闭 Intent 详情" />
      <aside className="intent-drawer">
        <div className="drawer-header"><div><span>{intent.id}</span><StageBadge stage={intent.stage} /></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <div className="intent-drawer-title"><div><span className={`intent-risk risk-${intent.risk}`}>{intent.risk}风险</span><h2>{intent.title}</h2><p>{sourceIssueId ? `GitHub Issue #${sourceIssueId}` : intent.source ? `Production Signal ${intent.source}` : 'Local Intent'} · Owner {intent.owner} · Version 3</p></div><div className="intent-quality"><strong>82</strong><span>意图质量</span></div></div>
        <div className="drawer-tabs">{(['意图', '验收标准', '关系'] as const).map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
        <div className="intent-drawer-body">
          {tab === '意图' && <>
            <section className="intent-section"><span className="intent-label">业务目标</span><p className="intent-goal">{goal}</p></section>
            <section className="intent-section"><span className="intent-label">成功结果</span><div className="outcome-list">{outcomes.map((outcome) => <div key={outcome}><Check size={13} /><span>{outcome}</span></div>)}</div></section>
            <section className="intent-section"><span className="intent-label">约束</span><div className="constraint-tags">{constraints.map((constraint) => <span key={constraint}>{constraint}</span>)}</div></section>
            <section className="intent-section"><div className="section-heading"><h3>未决问题</h3><span>{unknowns.length}</span></div><div className="unknown-list">{unknowns.map((unknown) => <div key={unknown}><span>?</span><p>{unknown}</p></div>)}</div></section>
            <section className="intent-readiness"><div><Sparkles size={16} /><span><strong>{isSsoIntent ? '可以进入 Context Engineering' : '需要先完成 Intent Refinement'}</strong><small>{isSsoIntent ? '关键目标和约束已明确，但 AC-04 尚无 Evaluation。' : '该 Intent 来自生产信号，验收标准和 Evaluation 尚未冻结。'}</small></span></div><button disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">完善缺口<ArrowRight size={14} /></button></section>
          </>}

          {tab === '验收标准' && <section className="intent-section"><div className="section-heading"><h3>Acceptance Criteria</h3><span>{intent.criteria} 已定义</span></div><div className="acceptance-list">{criteria.map((criterion) => <div key={criterion.id}><span className={criterion.state}>{criterion.state === 'linked' ? <Check size={13} /> : '!'}</span><div><strong>{criterion.text}</strong><small>{criterion.id} · {criterion.criticality}</small></div><em className={criterion.state}>{criterion.evidence}</em></div>)}</div></section>}

          {tab === '关系' && <>
            <section className="intent-section"><div className="section-heading"><h3>追溯关系</h3><span>8 linked objects</span></div><div className="traceability-map"><div className="trace-node source"><CircleDot size={14} /><span><strong>{intent.id}</strong><small>Intent</small></span></div><ArrowRight size={14} /><div className="trace-column"><div><FolderTree size={13} />CTX-142-v3</div><div><Bot size={13} />RUN-8821</div><div><FlaskConical size={13} />EVS-014</div></div><ArrowRight size={14} /><div className="trace-column"><div><FileCheck2 size={13} />EVD-8821</div><div><GitPullRequest size={13} />PR #428</div><div><Rocket size={13} />RC-{localDate}</div></div></div></section>
            <section className="intent-section"><span className="intent-label">权威来源</span><div className="authority-card"><GitPullRequest size={16} /><div><strong>{sourceIssueId ? `GitHub Issue #${sourceIssueId}` : intent.source ? `Production Signal ${intent.source}` : 'Local Intent'}</strong><p>{sourceIssueId ? '标题、状态、讨论和负责人以 GitHub 为准；Control Plane 维护验收标准、约束、Eval 和 Evidence 投影。' : intent.source ? '该 Intent 由生产信号派生；完成分诊后应创建或关联外部 Issue。' : '该 Intent 尚未关联外部权威对象。'}</p></div><span>{sourceIssueId ? 'Projection 已回写' : intent.source ? '待关联 Issue' : '仅本地'}</span></div></section>
          </>}
        </div>
        <div className="drawer-footer"><button className="secondary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">打开 GitHub Issue</button><button className="primary-button" disabled title="原型控件：尚未接入本地 Control Plane，点击不会产生任何状态变更">编辑 Intent</button></div>
      </aside>
    </>
  )
}

const intentVersionStatusLabels: Record<LocalIntentVersion['status'], string> = { draft: '待批准', approved: '已批准', superseded: '已被取代' }
const riskShort: Record<LocalIntentVersion['riskLevel'], '高' | '中' | '低'> = { high: '高', medium: '中', low: '低' }

/** Stage of a real Intent, in the demo's vocabulary, from what actually exists for it. */
function localIntentStage(intent: LocalIntentVersion | undefined, runs: Array<{ status: string }>, proposals: LocalChangeProposal[], released: boolean) {
  if (released) return 'Released'
  if (proposals.some((proposal) => proposal.status === 'merged')) return 'Merged'
  if (proposals.some((proposal) => proposal.status !== 'closed')) return 'Review'
  if (runs.some((run) => run.status === 'running' || run.status === 'queued')) return 'Execution'
  return intent?.status === 'approved' ? 'Context' : 'Intent'
}

type LocalIntentApproval = { can: (intent: LocalIntentVersion) => boolean; title: (intent: LocalIntentVersion) => string; approvingId?: string; error?: string; approve: (intentVersionId: string) => Promise<void> }

/** A real Intent in the demo drawer's layout. Every number and list comes from the local Control Plane or the draft checker. */
function LocalIntentDrawer({ workItemId, onClose, approval }: { workItemId: string; onClose: () => void; approval: LocalIntentApproval }) {
  const local = useLocalControlPlane()
  const [tab, setTab] = useState<'意图' | '验收标准' | '关系'>('意图')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const workItem = local.workItems.find((item) => item.id === workItemId)
  if (!workItem) return null
  const versions = local.intentVersions.filter((intent) => intent.workItemId === workItemId).sort((left, right) => right.version - left.version)
  const intent = versions[0]
  const runs = local.agentRuns.filter((run) => run.workItemId === workItemId)
  const proposals = local.changeProposals.filter((proposal) => proposal.workItemId === workItemId)
  const proposal = proposals.find((item) => item.status !== 'closed') ?? proposals[0]
  const readiness = proposal ? local.reviewReadiness.find((item) => item.changeProposalId === proposal.id) : undefined
  const link = proposal ? local.codeHostLinks.find((item) => item.changeProposalId === proposal.id) : undefined
  const releases = local.releaseCandidates.filter((candidate) => proposals.some((item) => item.id === candidate.changeProposalId))
  const release = releases.find((candidate) => candidate.status === 'approved') ?? releases[0]
  const latestRun = runs[0]
  const actorName = (actorId?: string) => local.actors.find((candidate) => candidate.id === actorId)?.displayName ?? actorId ?? '—'
  const criteria = intent?.acceptanceCriteria ?? []
  // The same checker that runs while the Intent is drafted, applied to what was stored.
  const lint = intent ? lintIntentDraft({ goal: intent.goal, constraints: intent.constraints, riskLevel: intent.riskLevel, criteria: criteria.map((criterion) => ({ statement: criterion.statement, criticality: criterion.criticality, verificationType: criterion.verificationType, warnings: inspectStatement(criterion.statement, criterion.verificationType) })) }) : { blockers: [], warnings: [] }
  const criterionWarnings = criteria.flatMap((criterion, index) => inspectStatement(criterion.statement, criterion.verificationType).map((warning) => `AC-${String(index + 1).padStart(2, '0')}：${warning}`))
  const unknowns = [...lint.blockers, ...lint.warnings.filter((warning) => !warning.includes('条验收标准仍有待补充')), ...criterionWarnings]
  const quality = Math.max(0, 100 - lint.blockers.length * 25 - (lint.warnings.length + criterionWarnings.length) * 8)
  const qualityTitle = `由 Intent 起草检查计算：${lint.blockers.length} 项阻断（每项 −25）、${lint.warnings.length + criterionWarnings.length} 项提示（每项 −8），满分 100`
  const stage = localIntentStage(intent, runs, proposals, release?.status === 'approved')
  const source = workItem.authorityProvider === 'local' ? 'Local Intent' : `${workItem.authorityProvider} · ${workItem.authorityRef}`
  const criterionState = (criterionId: string) => readiness?.criteria.find((item) => item.criterionId === criterionId)
  const coveredCount = criteria.filter((criterion) => ['passed', 'overridden'].includes(criterionState(criterion.id)?.status ?? '')).length
  const readinessView = !intent ? { title: '尚无 Intent 版本', detail: '创建 Intent 版本后才能启动 Run。' }
    : intent.status === 'draft' ? { title: '等待批准后才能启动 Run', detail: `${riskLabels[intent.riskLevel]} Intent 需要作者以外的 owner、maintainer 或 reviewer 批准内容摘要 ${intent.contentDigest.slice(0, 19)}…` }
    : proposal?.status === 'merged' ? { title: '已合并', detail: `${proposal.id} 已合并到 ${proposal.baseRef}${release ? `；发布候选 ${release.id} ${release.status === 'approved' ? '已批准' : '待批准'}` : '；尚未创建发布候选'}。` }
    : proposal ? { title: readiness?.status === 'ready' ? '证据齐备，可以审查' : '正在审查', detail: readiness ? `${coveredCount}/${criteria.length} 条验收标准有独立证据${readiness.blockers.length ? `；${readiness.blockers[0]}` : ''}` : `${proposal.id} 等待门禁计算。` }
    : lint.blockers.length ? { title: '已批准，但起草检查仍有阻断项', detail: lint.blockers[0] }
    : { title: '可以启动 Agent Run', detail: `已批准${intent.approval?.basis === 'low_risk_rule' ? '（低风险规则）' : `（${actorName(intent.approval?.actorId)}）`}；到 Agent Runs 页选择这个 Work Item 启动。` }
  const traceCount = [intent, latestRun, readiness?.evidence.length ? readiness : undefined, proposal, link, release].filter(Boolean).length + Math.max(0, versions.length - 1)
  return (
    <>
      <button className="drawer-overlay" onClick={onClose} aria-label="关闭 Intent 详情" />
      <aside className="intent-drawer" role="dialog" aria-label={`Intent ${workItemLabel(workItem)}`}>
        <div className="drawer-header"><div><span>{workItem.sequence ? `#${workItem.sequence} · ` : ''}{workItem.id}</span><StageBadge stage={stage} /></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <div className="intent-drawer-title"><div>{intent && <span className={`intent-risk risk-${riskShort[intent.riskLevel]}`}>{riskShort[intent.riskLevel]}风险</span>}<h2>{workItem.title}</h2><p>{source} · Owner {actorName(workItem.ownerActorId)} · Version {intent?.version ?? '—'}{intent ? ` · ${intentVersionStatusLabels[intent.status]}` : ''}</p></div>{intent && <div className="intent-quality" title={qualityTitle} style={{ background: `radial-gradient(circle closest-side, #0c1d3a 74%, transparent 76%), conic-gradient(${quality >= 80 ? '#4190f8' : quality >= 60 ? '#e4a84a' : '#e86179'} ${quality}%, #17376f 0)` }}><strong>{quality}</strong><span>意图质量</span></div>}</div>
        <div className="drawer-tabs">{(['意图', '验收标准', '关系'] as const).map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
        <div className="intent-drawer-body">
          {tab === '意图' && <>
            <section className="intent-section"><span className="intent-label">业务目标</span><p className="intent-goal">{intent?.goal ?? workItem.description}</p></section>
            <section className="intent-section"><span className="intent-label">成功结果 · 关键验收标准</span>{criteria.some((criterion) => criterion.criticality === 'critical') ? <div className="outcome-list">{criteria.filter((criterion) => criterion.criticality === 'critical').map((criterion) => <div key={criterion.id}><Check size={13} /><span>{criterion.statement}</span></div>)}</div> : <p className="local-intent-empty">没有关键验收标准，这个 Intent 不会阻塞任何审批。</p>}</section>
            <section className="intent-section"><span className="intent-label">约束</span>{intent?.constraints.length ? <div className="constraint-tags">{intent.constraints.map((constraint) => <span key={constraint}>{constraint}</span>)}</div> : <p className="local-intent-empty">未声明约束</p>}</section>
            <section className="intent-section"><div className="section-heading"><h3>未决问题</h3><span>{unknowns.length}</span></div>{unknowns.length ? <div className="unknown-list">{unknowns.map((unknown) => <div key={unknown}><span>?</span><p>{unknown}</p></div>)}</div> : <p className="local-intent-empty">起草检查没有发现问题。</p>}</section>
            <section className="intent-readiness"><div><Sparkles size={16} /><span><strong>{readinessView.title}</strong><small>{readinessView.detail}</small></span></div></section>
            {versions.length > 1 && <section className="intent-section"><div className="section-heading"><h3>版本历史</h3><span>{versions.length}</span></div><div className="local-intent-rows">{versions.map((version) => <div key={version.id}><span className={`local-status ${version.status}`}>v{version.version}</span><div><strong>{intentVersionStatusLabels[version.status]} · {riskLabels[version.riskLevel]} · {version.acceptanceCriteria.length} 条标准</strong><small>{version.contentDigest.slice(0, 19)} · {actorName(version.createdBy)} · {version.createdAt.slice(0, 16).replace('T', ' ')}</small></div></div>)}</div></section>}
          </>}

          {tab === '验收标准' && <section className="intent-section"><div className="section-heading"><h3>Acceptance Criteria</h3><span>{proposal ? `${coveredCount}/${criteria.length} 有证据` : `${criteria.length} 已定义`}</span></div>{criteria.length ? <div className="acceptance-list">{criteria.map((criterion, index) => { const state = criterionState(criterion.id); const linked = state?.status === 'passed' || state?.status === 'overridden'; return <div key={criterion.id}><span className={linked ? 'linked' : 'missing'}>{linked ? <Check size={13} /> : '!'}</span><div><strong>{criterion.statement}</strong><small>AC-{String(index + 1).padStart(2, '0')} · {criterion.criticality === 'critical' ? 'Critical' : 'Required'} · {verificationLabels[criterion.verificationType]}验证</small></div><em className={linked ? 'linked' : 'missing'}>{state ? `${criterionStatusLabels[state.status]}${state.checkNames.length ? ` · ${state.checkNames.join(', ')}` : ''}` : proposal ? '等待门禁计算' : '尚无 Change Proposal'}</em></div> })}</div> : <p className="local-intent-empty">尚无验收标准</p>}</section>}

          {tab === '关系' && <>
            <section className="intent-section"><div className="section-heading"><h3>追溯关系</h3><span>{traceCount} linked objects</span></div><div className="traceability-map"><div className="trace-node source"><CircleDot size={14} /><span><strong>{workItem.sequence ? `#${workItem.sequence}` : workItem.id}</strong><small>Intent</small></span></div><ArrowRight size={14} /><div className="trace-column"><div title={intent?.contentDigest}><FolderTree size={13} />{intent ? `${intent.id} · v${intent.version}` : '无 Intent 版本'}</div><div title={latestRun?.errorMessage}><Bot size={13} />{latestRun ? `${latestRun.id} · ${latestRun.status}` : '尚无 Run'}{runs.length > 1 ? ` (+${runs.length - 1})` : ''}</div><div><FlaskConical size={13} />{readiness ? `${readiness.successfulCheckCount} 通过 / ${readiness.failedCheckCount} 失败` : '尚无检查'}</div></div><ArrowRight size={14} /><div className="trace-column"><div><FileCheck2 size={13} />{readiness?.evidence[0]?.id ?? '尚无 Evidence'}</div><div><GitPullRequest size={13} />{link ? <a href={link.url} target="_blank" rel="noreferrer">PR #{link.externalId}</a> : proposal ? proposal.id : '尚无提案'}</div><div><Rocket size={13} />{release ? `${release.id}` : '尚无发布'}</div></div></div></section>
            {runs.length > 0 && <section className="intent-section"><div className="section-heading"><h3>Agent Runs</h3><span>{runs.length}</span></div><div className="local-intent-rows">{runs.map((run) => <div key={run.id}><span className={`local-status ${run.status}`}>{run.status}</span><div><strong>{run.id} · Intent v{versions.find((version) => version.id === run.intentVersionId)?.version ?? '?'}</strong><small>{run.startedAt?.slice(0, 16).replace('T', ' ') ?? '—'}{run.changeProposalId ? ` · ${run.changeProposalId}` : ''}</small>{run.status === 'failed' && run.errorMessage && <small className="local-run-error" title={run.errorMessage}>{run.errorMessage.trim().split('\n').at(-1)}</small>}</div></div>)}</div></section>}
            <section className="intent-section"><span className="intent-label">权威来源</span><div className="authority-card"><GitPullRequest size={16} /><div><strong>{source}</strong><p>{workItem.authorityProvider === 'local' ? '该 Intent 在 Control Plane 中创建，尚未关联外部 Issue；目标、约束、验收标准以这里的版本化内容为准。' : '标题与讨论以外部系统为准；Control Plane 维护验收标准、约束与 Evidence。'}</p></div><span>{workItem.authorityProvider === 'local' ? '仅本地' : '已关联'}</span></div></section>
          </>}
        </div>
        {approval.error && <p className="local-form-error" role="alert" style={{ margin: '0 17px 8px' }}>{approval.error}</p>}
        <div className="drawer-footer">{link ? <a className="secondary-button" href={link.url} target="_blank" rel="noreferrer">打开 Pull Request #{link.externalId}</a> : <button className="secondary-button" disabled title="这个 Intent 还没有发布到代码托管的 Change Proposal">打开 Pull Request</button>}{intent?.status === 'draft' ? <button className="primary-button" disabled={approval.approvingId === intent.id || !approval.can(intent)} title={approval.title(intent)} onClick={() => void approval.approve(intent.id)}><ShieldCheck size={15} />{approval.approvingId === intent.id ? '批准中' : '批准 Intent'}</button> : <button className="primary-button" disabled title="修改目标、约束或验收标准会产生新版本并需要重新批准；编辑界面尚未提供">编辑 Intent</button>}</div>
      </aside>
    </>
  )
}

function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (page: Page) => void }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const items = navigation.flatMap((section) => section.items)
  const filteredItems = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => setActiveIndex(0), [query])

  const onCommandKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => filteredItems.length ? (current + 1) % filteredItems.length : 0)
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => filteredItems.length ? (current - 1 + filteredItems.length) % filteredItems.length : 0)
    }
    if (event.key === 'Enter' && filteredItems[activeIndex]) {
      event.preventDefault()
      onNavigate(filteredItems[activeIndex].label)
    }
  }

  return <><button className="command-overlay" onClick={onClose} aria-label="关闭命令菜单" /><div className="command-palette"><div className="command-input"><Search size={18} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onCommandKeyDown} placeholder="搜索页面或输入命令..." /><kbd>ESC</kbd></div><div className="command-section"><p>{query ? '搜索结果' : '快速前往'}</p>{filteredItems.map((item, index) => { const Icon = item.icon; return <button className={activeIndex === index ? 'active' : ''} key={item.label} onMouseEnter={() => setActiveIndex(index)} onClick={() => onNavigate(item.label)}><Icon size={16} /><span>{item.label}</span><small>打开页面</small></button> })}{filteredItems.length === 0 && <div className="command-empty"><Search size={18} /><strong>没有匹配结果</strong><span>尝试搜索“评估”、“上下文”或“发布”</span></div>}</div><div className="command-footer"><span><Command size={13} />K 打开</span><span>↑↓ 选择</span><span>↵ 确认</span></div></div></>
}

export default App
