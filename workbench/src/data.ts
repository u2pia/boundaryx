export type ReviewItem = {
  id: string
  title: string
  project: string
  author: string
  risk: '高风险' | '中风险' | '低风险'
  status: '待审查' | '审查中' | '需修改'
  coverage: number
  files: number
  additions: number
  deletions: number
  updated: string
  summary: string
  evidenceHeadline?: string
  evidenceDetail?: string
  contextDetail?: string
  criteria: Array<{ label: string; state: 'passed' | 'warning' | 'unknown' }>
}

export type IntentItem = {
  id: string
  title: string
  stage: string
  risk: '高' | '中' | '低'
  owner: string
  criteria: string
  updated: string
  source?: string
}

export const reviews: ReviewItem[] = [
  {
    id: 'INT-142',
    title: '为企业工作区增加 SSO 登录',
    project: 'Control Plane',
    author: 'Mia Chen',
    risk: '高风险',
    status: '待审查',
    coverage: 86,
    files: 18,
    additions: 642,
    deletions: 118,
    updated: '8 分钟前',
    summary: '增加 OIDC 登录流程、身份绑定与会话撤销机制。涉及认证边界，需要安全与代码双重审查。',
    criteria: [
      { label: '现有账号可绑定企业身份', state: 'passed' },
      { label: '会话撤销在 60 秒内生效', state: 'passed' },
      { label: '异常登录写入审计事件', state: 'warning' },
      { label: '离线部署兼容性', state: 'unknown' },
    ],
  },
  {
    id: 'INT-138',
    title: '优化 Evidence Summary 的信息密度',
    project: 'Control Plane',
    author: 'Alex Wu',
    risk: '低风险',
    status: '审查中',
    coverage: 100,
    files: 7,
    additions: 214,
    deletions: 96,
    updated: '24 分钟前',
    summary: '重构证据摘要布局，优先展示失败项、未知项和本次新增证明。',
    criteria: [
      { label: '关键证据首屏可见', state: 'passed' },
      { label: '支持键盘展开详情', state: 'passed' },
      { label: '移动端降级可读', state: 'passed' },
    ],
  },
  {
    id: 'INT-133',
    title: '限制 Agent 对 secrets 目录的访问',
    project: 'Runtime',
    author: 'Noah Li',
    risk: '高风险',
    status: '需修改',
    coverage: 71,
    files: 11,
    additions: 328,
    deletions: 42,
    updated: '1 小时前',
    summary: '通过容器挂载和策略判定双层限制敏感目录读取，目前存在一个绕过路径。',
    criteria: [
      { label: '禁止直接读取 secrets', state: 'passed' },
      { label: '阻断符号链接绕过', state: 'warning' },
      { label: '所有拒绝均产生审计事件', state: 'passed' },
    ],
  },
]

export const runs = [
  { id: 'RUN-8821', label: 'SSO 身份绑定实现', agent: 'Claude Code', state: '评估中', progress: 78, duration: '18m 42s', tone: 'violet' },
  { id: 'RUN-8819', label: 'Evidence Summary 重构', agent: 'Codex', state: '等待审批', progress: 100, duration: '12m 06s', tone: 'amber' },
  { id: 'RUN-8818', label: '策略解析器性能优化', agent: 'OpenHands', state: '执行中', progress: 44, duration: '7m 31s', tone: 'cyan' },
  { id: 'RUN-8812', label: 'GitHub Check 状态同步', agent: 'Codex', state: '已完成', progress: 100, duration: '9m 14s', tone: 'green' },
]

export const activity = [
  { person: 'MC', color: 'violet', text: 'Mia 创建了变更提案', target: 'INT-142', time: '8m' },
  { person: 'AI', color: 'cyan', text: 'Agent 完成 16/18 项评估', target: 'RUN-8821', time: '12m' },
  { person: 'NW', color: 'amber', text: 'Noah 请求修改', target: 'INT-133', time: '1h' },
  { person: 'AW', color: 'blue', text: 'Alex 展开了完整证据包', target: 'INT-138', time: '2h' },
  { person: 'GH', color: 'green', text: 'GitHub 合并变更', target: 'PR #428', time: '3h' },
]

export const intents: IntentItem[] = [
  { id: 'INT-142', title: '为企业工作区增加 SSO 登录', stage: 'Review', risk: '高', owner: 'MC', criteria: '3/4', updated: '8m' },
  { id: 'INT-141', title: '支持 GitLab Merge Request 同步', stage: 'Context', risk: '中', owner: 'JL', criteria: '5/5', updated: '18m' },
  { id: 'INT-140', title: 'Agent 运行预算预警', stage: 'Execution', risk: '中', owner: 'NW', criteria: '4/4', updated: '32m' },
  { id: 'INT-139', title: '审查队列支持领域标签', stage: 'Intent', risk: '低', owner: 'AW', criteria: '2/3', updated: '51m' },
  { id: 'INT-138', title: '优化 Evidence Summary 的信息密度', stage: 'Review', risk: '低', owner: 'AW', criteria: '3/3', updated: '1h' },
  { id: 'INT-137', title: '增加 SARIF 结果聚合器', stage: 'Evaluation', risk: '中', owner: 'MC', criteria: '6/7', updated: '2h' },
  { id: 'INT-136', title: '容器执行环境缓存', stage: 'Released', risk: '中', owner: 'JL', criteria: '5/5', updated: '1d' },
]
