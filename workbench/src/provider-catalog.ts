export type ProviderStage = 'prototype' | 'next' | 'research'
export type ProviderDecision = 'adopt' | 'integrate' | 'reference' | 'build'
export type ProviderDeployment = 'embedded' | 'self_hosted' | 'managed'
export type ProviderCategory =
  | 'Source & Work'
  | 'Agent Runtime'
  | 'Workflow'
  | 'Evaluation'
  | 'Governance'
  | 'Evidence'
  | 'Delivery'

export type ProviderCatalogEntry = {
  id: string
  name: string
  category: ProviderCategory
  contractRef: string
  decision: ProviderDecision
  stage: ProviderStage
  deployments: ProviderDeployment[]
  offlineReady: boolean
  inspiration: string
  borrowedPattern: string
  avoidPattern: string
  evidenceBoundary: string
}

export const providerCatalog: ProviderCatalogEntry[] = [
  {
    id: 'github-source',
    name: 'GitHub Source Provider',
    category: 'Source & Work',
    contractRef: 'IssueProvider / PullRequestProvider',
    decision: 'integrate',
    stage: 'prototype',
    deployments: ['managed'],
    offlineReady: false,
    inspiration: 'GitHub Checks / Copilot coding agent',
    borrowedPattern: '外部系统保持权威，Control Plane 只保存绑定 Head SHA 的投影与证据引用。',
    avoidPattern: '不把 GitHub 专有对象直接写入核心领域模型。',
    evidenceBoundary: 'Issue、PR、Review 与 Checks 快照必须记录 external ID、Head SHA 和采集时间。',
  },
  {
    id: 'gitlab-source',
    name: 'GitLab Source Provider',
    category: 'Source & Work',
    contractRef: 'IssueProvider / PullRequestProvider',
    decision: 'integrate',
    stage: 'next',
    deployments: ['self_hosted', 'managed'],
    offlineReady: true,
    inspiration: 'GitLab self-managed',
    borrowedPattern: '用同一 Provider Contract 支持私有仓库、Merge Request 与内部身份。',
    avoidPattern: '不为 GitLab 复制第二套 Intent、Review 或 Release 状态机。',
    evidenceBoundary: '必须证明与 GitHub Adapter 产生等价的 authority projection。',
  },
  {
    id: 'agent-runtime',
    name: 'Agent Runtime Adapter',
    category: 'Agent Runtime',
    contractRef: 'AgentAdapter',
    decision: 'build',
    stage: 'prototype',
    deployments: ['embedded', 'self_hosted'],
    offlineReady: true,
    inspiration: 'OpenHands / SWE-agent',
    borrowedPattern: 'Agent、工具、Sandbox 与 Session 解耦，执行过程输出结构化事件。',
    avoidPattern: '不把单一 Agent 的 Prompt、工具命名或运行进程当成平台协议。',
    evidenceBoundary: '每个 Tool Request、Policy Decision、Artifact 和 Evaluation 必须进入同一事件链。',
  },
  {
    id: 'sandbox-runtime',
    name: 'Sandbox Runtime Provider',
    category: 'Agent Runtime',
    contractRef: 'SandboxProvider / SandboxAttestor',
    decision: 'integrate',
    stage: 'next',
    deployments: ['self_hosted'],
    offlineReady: true,
    inspiration: 'OpenHands runtime isolation',
    borrowedPattern: 'Workspace、网络、凭证和生命周期由实际执行环境强制，而不是依赖 Prompt。',
    avoidPattern: '不把“容器已启动”等同于已经证明最小权限。',
    evidenceBoundary: 'Attestation 必须包含镜像摘要、路径、Egress、Secret Mount 与 Ephemeral 状态。',
  },
  {
    id: 'durable-workflow',
    name: 'Durable Workflow Provider',
    category: 'Workflow',
    contractRef: 'WorkflowProvider',
    decision: 'integrate',
    stage: 'prototype',
    deployments: ['embedded', 'self_hosted'],
    offlineReady: true,
    inspiration: 'Temporal / LangGraph',
    borrowedPattern: '检查点、重放、幂等键、可控重试与人工中断成为运行时语义。',
    avoidPattern: '不在第一阶段引入需要专职平台运维的重型集群。',
    evidenceBoundary: '每次恢复、重试和人工 Resume 必须引用同一 Workflow、Checkpoint 与 Idempotency Key。',
  },
  {
    id: 'evaluation-observability',
    name: 'Evaluation & Trace Provider',
    category: 'Evaluation',
    contractRef: 'EvaluationProvider / TraceProvider',
    decision: 'integrate',
    stage: 'prototype',
    deployments: ['self_hosted', 'managed'],
    offlineReady: true,
    inspiration: 'Langfuse / Arize Phoenix / OpenTelemetry',
    borrowedPattern: 'Dataset、Trial、Trace、Grader 与 Experiment 使用稳定关联键串联。',
    avoidPattern: '不让可观测产品成为发布判定的唯一事实来源。',
    evidenceBoundary: 'Eval 结果必须保存数据集版本、Grader 版本、Trace Ref 与环境摘要。',
  },
  {
    id: 'telemetry-export',
    name: 'Telemetry Export Provider',
    category: 'Evaluation',
    contractRef: 'TelemetryExportProvider',
    decision: 'integrate',
    stage: 'prototype',
    deployments: ['embedded', 'self_hosted'],
    offlineReady: true,
    inspiration: 'OpenTelemetry OTLP / Collector processors',
    borrowedPattern: '使用开放 OTLP 结构，并在出口集中执行采样、属性 Allowlist 与敏感字段删除。',
    avoidPattern: '不默认发送 Prompt、Message、Context 内容或 Tool Output，也不让 Collector 成为运行事实源。',
    evidenceBoundary: '导出包必须绑定源 Projection Digest、采样策略、脱敏策略、Span 数量与独立 Export Digest。',
  },
  {
    id: 'policy-engine',
    name: 'Policy Decision Provider',
    category: 'Governance',
    contractRef: 'PolicyDecisionProvider',
    decision: 'integrate',
    stage: 'prototype',
    deployments: ['embedded', 'self_hosted'],
    offlineReady: true,
    inspiration: 'OPA / Cedar',
    borrowedPattern: '策略求值与业务执行解耦，输入、版本、结果和原因可重放。',
    avoidPattern: '不把 UI 按钮禁用或自然语言规则当成最终授权边界。',
    evidenceBoundary: '每个决定必须记录 Policy ID、Version、Input Digest、Enforcement 与 Reason。',
  },
  {
    id: 'autonomy-decision',
    name: 'Autonomy Decision Provider',
    category: 'Governance',
    contractRef: 'AutonomyDecisionProvider',
    decision: 'build',
    stage: 'prototype',
    deployments: ['embedded', 'self_hosted'],
    offlineReady: true,
    inspiration: 'Anthropic Claude Code auto mode / containment boundaries',
    borrowedPattern: '安全操作走确定性允许路径，未知或高风险操作升级人工，分类器只能作为 Sandbox 内的附加信号。',
    avoidPattern: '不把“AI 判断安全”直接等同于自动合并或生产授权，也不绕过仓库保护规则。',
    evidenceBoundary: '每个自治决定必须保存 Phase、Risk Tier、Control Inputs、Reasons、Required Controls 与 Decision Digest。',
  },
  {
    id: 'local-evidence',
    name: 'Evidence Repository',
    category: 'Evidence',
    contractRef: 'EvidenceSink / EvidenceRepository',
    decision: 'build',
    stage: 'prototype',
    deployments: ['embedded', 'self_hosted'],
    offlineReady: true,
    inspiration: 'in-toto / Sigstore / SLSA',
    borrowedPattern: '证据具有主体、材料、产物、摘要链和可独立复验的 Provenance。',
    avoidPattern: '不把原型校验和宣传为密码学签名或不可篡改存储。',
    evidenceBoundary: '封存时验证事件协议、链头、包级 SHA-256 与责任主体。',
  },
  {
    id: 'attestation-provider',
    name: 'Attestation & Transparency Provider',
    category: 'Evidence',
    contractRef: 'AttestationProvider',
    decision: 'adopt',
    stage: 'prototype',
    deployments: ['self_hosted', 'managed'],
    offlineReady: true,
    inspiration: 'in-toto / Sigstore Rekor',
    borrowedPattern: '对关键 Evidence Package 生成可验证声明，并支持透明日志或企业内证明仓。',
    avoidPattern: '不要求所有低风险本地 Run 都进入公网透明日志。',
    evidenceBoundary: '签名身份、证书链、Statement Predicate 与验证结果必须可导出。',
  },
  {
    id: 'deployment-provider',
    name: 'Deployment Provider',
    category: 'Delivery',
    contractRef: 'DeploymentProvider',
    decision: 'integrate',
    stage: 'prototype',
    deployments: ['self_hosted', 'managed'],
    offlineReady: true,
    inspiration: 'Argo CD / Harness',
    borrowedPattern: '部署和回滚绑定 Release Candidate、Artifact Digest、Evidence 与具名审批。',
    avoidPattern: '不在 Control Plane 内复制完整 CI/CD 编排器和环境控制器。',
    evidenceBoundary: '部署结果必须返回 Provider ID、Artifact Digest、Rollback Ref 和完成时间。',
  },
  {
    id: 'developer-catalog',
    name: 'Provider Catalog',
    category: 'Governance',
    contractRef: 'ProviderDescriptor',
    decision: 'build',
    stage: 'prototype',
    deployments: ['embedded'],
    offlineReady: true,
    inspiration: 'Backstage Software Catalog',
    borrowedPattern: '用声明式目录表达能力、Owner、生命周期、替换边界和运行状态。',
    avoidPattern: '不复制通用开发者门户的信息架构，也不把目录变成静态 Wiki。',
    evidenceBoundary: '每个可执行 Provider 必须声明 Contract、Deployment Mode、Stage 与 Evidence Boundary。',
  },
]

export function summarizeProviderCatalog(entries = providerCatalog) {
  return {
    contracts: new Set(entries.map((entry) => entry.contractRef)).size,
    prototypes: entries.filter((entry) => entry.stage === 'prototype').length,
    offlineReady: entries.filter((entry) => entry.offlineReady).length,
    next: entries.filter((entry) => entry.stage === 'next').length,
  }
}

export function validateProviderCatalog(entries = providerCatalog) {
  const errors: string[] = []
  const ids = new Set<string>()

  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate id: ${entry.id}`)
    ids.add(entry.id)
    if (!entry.contractRef.trim()) errors.push(`missing contract: ${entry.id}`)
    if (!entry.borrowedPattern.trim()) errors.push(`missing borrowed pattern: ${entry.id}`)
    if (!entry.avoidPattern.trim()) errors.push(`missing avoid pattern: ${entry.id}`)
    if (!entry.evidenceBoundary.trim()) errors.push(`missing evidence boundary: ${entry.id}`)
    if (entry.offlineReady && !entry.deployments.some((deployment) => deployment !== 'managed')) {
      errors.push(`offline-ready provider has managed-only deployment: ${entry.id}`)
    }
  }

  return errors
}
