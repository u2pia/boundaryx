export const corePageLabels = ['总览', 'Intents', '上下文', 'Agent Runs', '评审队列', '发布'] as const
export const administrationPageLabels = ['项目', '团队', '集成'] as const
export const labPageLabels = ['评估', '证据中心', '追溯', '策略', '反馈闭环', '度量'] as const

export type Page = (typeof corePageLabels)[number] | (typeof administrationPageLabels)[number] | (typeof labPageLabels)[number]

export function availablePageLabels(labEnabled: boolean): readonly Page[] {
  return labEnabled ? [...corePageLabels, ...administrationPageLabels, ...labPageLabels] : [...corePageLabels, ...administrationPageLabels]
}
