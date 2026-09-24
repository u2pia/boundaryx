import type { AgentRunEvent } from './contracts'

export function digestValue(value: string) {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function computeEventDigest(event: Omit<AgentRunEvent, 'eventDigest'>) {
  return digestValue(JSON.stringify(event))
}

export function verifyEventChain(events: AgentRunEvent[]) {
  let previousEventDigest = 'genesis'
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const { eventDigest, ...unsignedEvent } = event
    if (event.sequence !== index + 1 || event.previousEventDigest !== previousEventDigest || computeEventDigest(unsignedEvent) !== eventDigest) return false
    previousEventDigest = eventDigest
  }
  return true
}

export function validateEventProtocol(events: AgentRunEvent[]) {
  const violations: string[] = []
  const runtimeIndex = events.findIndex((event) => event.type === 'runtime_bound')
  const sandboxIndex = events.findIndex((event) => event.type === 'sandbox_attested')
  const harnessIndex = events.findIndex((event) => event.type === 'harness_profile_selected')
  const workflowIndex = events.findIndex((event) => event.type === 'workflow_bound')
  const policyBundleIndex = events.findIndex((event) => event.type === 'policy_bundle_bound')
  const roadmapIndex = events.findIndex((event) => event.type === 'roadmap_created')
  const sprintIndex = events.findIndex((event) => event.type === 'sprint_planned')
  const planIndex = events.findIndex((event) => event.type === 'plan_created')
  const proposedIndex = events.findIndex((event) => event.type === 'work_contract_proposed')
  const reviewedIndex = events.findIndex((event) => event.type === 'work_contract_reviewed')
  const proposed = proposedIndex >= 0 ? events[proposedIndex] : undefined
  const reviewed = reviewedIndex >= 0 ? events[reviewedIndex] : undefined

  const runtime = runtimeIndex >= 0 ? events[runtimeIndex] : undefined
  const sandbox = sandboxIndex >= 0 ? events[sandboxIndex] : undefined
  let sandboxVerified = false
  if (sandbox?.type === 'sandbox_attested') {
    const attestationContent = { sandboxRef: sandbox.sandboxRef, attestorRef: sandbox.attestorRef, isolation: sandbox.isolation, workspaceRoot: sandbox.workspaceRoot, writablePaths: sandbox.writablePaths, readonlyPaths: sandbox.readonlyPaths, networkEgress: sandbox.networkEgress, allowedHosts: sandbox.allowedHosts, secretMounts: sandbox.secretMounts, ephemeral: sandbox.ephemeral, status: sandbox.status }
    if (!runtime || runtime.type !== 'runtime_bound' || sandboxIndex <= runtimeIndex || sandbox.sandboxRef !== runtime.sandboxRef) violations.push('Sandbox attestation must follow and bind the runtime sandbox')
    if (sandbox.attestationDigest !== digestValue(JSON.stringify(attestationContent))) violations.push('Sandbox attestation digest does not match its canonical content')
    sandboxVerified = sandbox.status === 'verified' && sandbox.ephemeral && sandbox.networkEgress !== 'unrestricted' && sandbox.secretMounts.length === 0
    if (sandbox.status === 'verified' && !sandboxVerified) violations.push('Verified sandbox violates the minimum containment policy')
  }

  if (harnessIndex >= 0) {
    const harness = events[harnessIndex]
    if (runtimeIndex < 0 || harnessIndex <= runtimeIndex) violations.push('Harness selection must follow runtime binding')
    if (!sandboxVerified || sandboxIndex >= harnessIndex) violations.push('Harness selection requires a verified sandbox attestation')
    if (planIndex >= 0 && harnessIndex >= planIndex) violations.push('Harness selection must precede planning')
    if (harness.type === 'harness_profile_selected') {
      const selected = harness.candidates.find((candidate) => candidate.profileId === harness.profileId)
      if (harness.candidateCount !== harness.candidates.length || !selected) violations.push('Harness selection must reference a declared candidate set')
      else if (selected.executionMode !== harness.executionMode || selected.contextResetPolicy !== harness.contextResetPolicy || selected.evidenceRef !== harness.evidenceRef) violations.push('Harness selection does not match the selected candidate evidence')
    }
  }

  const workflow = workflowIndex >= 0 ? events[workflowIndex] : undefined
  if (workflow?.type === 'workflow_bound') {
    if (harnessIndex < 0 || workflowIndex <= harnessIndex) violations.push('Workflow binding must follow harness selection')
    if (roadmapIndex >= 0 && workflowIndex >= roadmapIndex) violations.push('Workflow binding must precede roadmap planning')
    if (!workflow.workflowId || !workflow.providerRef || !workflow.taskQueue || !workflow.idempotencyKey) violations.push('Workflow binding requires stable identity and routing fields')
    if (workflow.retryPolicy.maxAttempts < 1 || workflow.retryPolicy.initialBackoffSeconds < 0 || workflow.retryPolicy.maxBackoffSeconds < workflow.retryPolicy.initialBackoffSeconds) violations.push('Workflow retry policy is invalid')
  }

  const policyBundle = policyBundleIndex >= 0 ? events[policyBundleIndex] : undefined
  if (policyBundle?.type === 'policy_bundle_bound') {
    if (workflowIndex < 0 || policyBundleIndex <= workflowIndex) violations.push('Policy bundle binding must follow workflow binding')
    if (roadmapIndex >= 0 && policyBundleIndex >= roadmapIndex) violations.push('Policy bundle binding must precede roadmap planning')
    const bundleContent = { providerRef: policyBundle.providerRef, bundleId: policyBundle.bundleId, bundleVersion: policyBundle.bundleVersion, defaultDecision: policyBundle.defaultDecision, rules: policyBundle.ruleIds }
    if (policyBundle.bundleDigest !== digestValue(JSON.stringify(bundleContent))) violations.push('Policy bundle digest does not match its canonical content')
    if (policyBundle.ruleCount !== policyBundle.ruleIds.length || new Set(policyBundle.ruleIds).size !== policyBundle.ruleIds.length) violations.push('Policy bundle rule inventory is invalid')
  }

  const roadmap = roadmapIndex >= 0 ? events[roadmapIndex] : undefined
  const sprint = sprintIndex >= 0 ? events[sprintIndex] : undefined
  if (roadmap?.type === 'roadmap_created') {
    const expectedDigest = digestValue(JSON.stringify({ roadmapId: roadmap.roadmapId, intentVersionId: roadmap.intentVersionId, plannerRef: roadmap.plannerRef, goal: roadmap.goal, milestones: roadmap.milestones }))
    if (roadmap.roadmapDigest !== expectedDigest) violations.push('Roadmap digest does not match its canonical content')
  }
  let currentRoadmapDigest = roadmap?.type === 'roadmap_created' ? roadmap.roadmapDigest : undefined
  events.forEach((event, index) => {
    if (event.type !== 'roadmap_updated') return
    const diagnosisIndex = events.slice(0, index).map((candidate) => candidate.type).lastIndexOf('evaluation_diagnosed')
    const updateContent = { roadmapId: event.roadmapId, plannerRef: event.plannerRef, basedOnRunId: event.basedOnRunId, previousRoadmapDigest: event.previousRoadmapDigest, milestoneUpdates: event.milestoneUpdates, nextSprintObjective: event.nextSprintObjective, feedbackRefs: event.feedbackRefs }
    if (!roadmap || roadmap.type !== 'roadmap_created' || event.roadmapId !== roadmap.roadmapId || event.plannerRef !== roadmap.plannerRef) violations.push('Roadmap update must bind the active roadmap and planner')
    if (!currentRoadmapDigest || event.previousRoadmapDigest !== currentRoadmapDigest || event.roadmapDigest !== digestValue(JSON.stringify(updateContent))) violations.push('Roadmap update digest chain is invalid')
    if (event.basedOnRunId !== event.runId || diagnosisIndex < 0 || !event.feedbackRefs.length) violations.push('Roadmap update must follow evaluation diagnosis with feedback evidence')
    if (roadmap?.type === 'roadmap_created' && event.milestoneUpdates.some((update) => !roadmap.milestones.some((milestone) => milestone.id === update.id))) violations.push('Roadmap update references an unknown milestone')
    currentRoadmapDigest = event.roadmapDigest
  })
  if (sprint?.type === 'sprint_planned') {
    if (!roadmap || roadmap.type !== 'roadmap_created' || sprintIndex <= roadmapIndex || sprint.roadmapId !== roadmap.roadmapId || sprint.plannerRef !== roadmap.plannerRef) violations.push('Sprint must follow and bind the active roadmap')
    else if (sprint.milestoneIds.some((milestoneId) => !roadmap.milestones.some((milestone) => milestone.id === milestoneId))) violations.push('Sprint references milestones outside the active roadmap')
  }

  if (proposed?.type === 'work_contract_proposed') {
    const expectedDigest = digestValue(JSON.stringify({ contractId: proposed.contractId, sprintId: proposed.sprintId, intentVersionId: proposed.intentVersionId, generatorRef: proposed.generatorRef, objective: proposed.objective, criteria: proposed.criteria, nonGoals: proposed.nonGoals }))
    if (proposed.contractDigest !== expectedDigest) violations.push('Work contract digest does not match its canonical content')
    if (sprint?.type === 'sprint_planned' && proposed.sprintId !== sprint.sprintId) violations.push('Work contract must bind the active sprint')
  }

  let acceptedContract = false
  if (reviewed?.type === 'work_contract_reviewed') {
    if (!proposed || proposed.type !== 'work_contract_proposed' || reviewedIndex <= proposedIndex) violations.push('Work contract review must follow a proposal')
    else if (reviewed.contractId !== proposed.contractId || reviewed.contractDigest !== proposed.contractDigest || reviewed.generatorRef !== proposed.generatorRef) violations.push('Work contract review must bind the proposed contract identity and digest')
    if (reviewed.decision === 'accepted' && reviewed.evaluatorRef === reviewed.generatorRef) violations.push('Generator cannot self-approve a work contract')
    acceptedContract = Boolean(proposed && proposed.type === 'work_contract_proposed' && reviewed.decision === 'accepted' && reviewed.contractId === proposed.contractId && reviewed.contractDigest === proposed.contractDigest && reviewed.generatorRef === proposed.generatorRef && reviewed.evaluatorRef !== reviewed.generatorRef)
  }

  const managedRun = runtimeIndex >= 0 || harnessIndex >= 0
  if (managedRun && (roadmapIndex >= 0 || planIndex >= 0) && !sandboxVerified) violations.push('Managed planning requires a verified sandbox attestation')
  if (managedRun && roadmapIndex >= 0 && (!workflow || workflow.type !== 'workflow_bound')) violations.push('Managed planning requires a durable workflow binding')
  if (managedRun && roadmapIndex >= 0 && (!policyBundle || policyBundle.type !== 'policy_bundle_bound')) violations.push('Managed planning requires a bound policy bundle')
  if (managedRun && planIndex >= 0 && (!roadmap || roadmap.type !== 'roadmap_created' || !sprint || sprint.type !== 'sprint_planned' || roadmapIndex >= sprintIndex || sprintIndex >= planIndex)) violations.push('Managed planning requires Roadmap then Sprint before the execution plan')
  const executionTypes = new Set<AgentRunEvent['type']>(['context_scope_created', 'context_requested', 'context_consumed', 'activity_attempt_started', 'tool_requested', 'policy_decided', 'activity_failed', 'activity_retry_scheduled', 'activity_completed', 'artifact_created', 'ci_evidence_ingested', 'usage_reported', 'context_reset_decided', 'context_compacted', 'checkpoint_saved', 'checkpoint_restored', 'evaluation_experiment_bound', 'evaluation_completed', 'evaluation_diagnosed'])
  const firstExecutionIndex = events.findIndex((event) => executionTypes.has(event.type))
  if (managedRun && firstExecutionIndex >= 0 && (!acceptedContract || reviewedIndex >= firstExecutionIndex)) violations.push('Managed execution cannot begin before an independently accepted work contract')

  events.forEach((event, index) => {
    if (event.type !== 'context_compacted') return
    const resetDecision = events.slice(0, index).reverse().find((candidate) => candidate.type === 'context_reset_decided')
    if (!resetDecision || resetDecision.type !== 'context_reset_decided' || resetDecision.action !== 'compact') violations.push('Context compaction requires a preceding compact decision')
  })

  const activityStates = new Map<string, { idempotencyKey: string; lastAttempt: number; openAttempt?: number; failedAttempt?: number; failedRetryable?: boolean; retryScheduledFor?: number; completed: boolean }>()
  events.forEach((event, index) => {
    if (event.type === 'activity_attempt_started') {
      if (!workflow || workflow.type !== 'workflow_bound' || index <= workflowIndex) violations.push('Activity attempt requires a preceding workflow binding')
      const current = activityStates.get(event.activityId)
      if (event.attempt < 1 || event.timeoutSeconds <= 0) violations.push('Activity attempt requires a positive attempt and timeout')
      if (!current) {
        if (event.attempt !== 1) violations.push('First activity attempt must be attempt 1')
        activityStates.set(event.activityId, { idempotencyKey: event.idempotencyKey, lastAttempt: event.attempt, openAttempt: event.attempt, completed: false })
        return
      }
      if (current.completed) violations.push('Completed activity cannot be attempted again')
      if (current.openAttempt !== undefined) violations.push('Activity cannot start a new attempt while another attempt is open')
      if (event.idempotencyKey !== current.idempotencyKey) violations.push('Activity retry must preserve the idempotency key')
      if (event.attempt !== current.lastAttempt + 1 || current.retryScheduledFor !== event.attempt) violations.push('Activity retry must follow an explicit retry schedule')
      current.lastAttempt = event.attempt
      current.openAttempt = event.attempt
      current.retryScheduledFor = undefined
      return
    }

    if (event.type === 'tool_requested') {
      const current = activityStates.get(event.activityId)
      if (!current || current.openAttempt !== event.attempt || current.idempotencyKey !== event.idempotencyKey) violations.push('Tool request must bind an open activity attempt and idempotency key')
      return
    }

    if (event.type === 'policy_decided') {
      const current = activityStates.get(event.activityId)
      if (!current || current.openAttempt !== event.attempt) violations.push('Policy decision must bind an open activity attempt')
      if (!policyBundle || policyBundle.type !== 'policy_bundle_bound' || event.decision.policyVersion !== policyBundle.bundleVersion) violations.push('Policy decision must bind the active policy bundle version')
      if (!event.decision.inputDigest.startsWith('fnv1a:')) violations.push('Policy decision requires a canonical input digest')
      return
    }

    if (event.type === 'activity_failed') {
      const current = activityStates.get(event.activityId)
      if (!current || current.openAttempt !== event.attempt) {
        violations.push('Activity failure must close the matching open attempt')
        return
      }
      if (workflow?.type === 'workflow_bound' && workflow.retryPolicy.nonRetryableErrors.includes(event.errorType) && event.retryable) violations.push('Configured non-retryable error cannot be marked retryable')
      current.openAttempt = undefined
      current.failedAttempt = event.attempt
      current.failedRetryable = event.retryable
      return
    }

    if (event.type === 'activity_retry_scheduled') {
      const current = activityStates.get(event.activityId)
      if (!current || current.openAttempt !== undefined || current.failedAttempt !== event.failedAttempt || !current.failedRetryable) {
        violations.push('Activity retry requires a retryable failed attempt')
        return
      }
      if (event.nextAttempt !== event.failedAttempt + 1 || event.backoffSeconds < 0) violations.push('Activity retry schedule has an invalid next attempt or backoff')
      if (workflow?.type === 'workflow_bound' && event.nextAttempt > workflow.retryPolicy.maxAttempts) violations.push('Activity retry exceeds the workflow retry policy')
      current.retryScheduledFor = event.nextAttempt
      return
    }

    if (event.type === 'activity_completed') {
      const current = activityStates.get(event.activityId)
      if (!current || current.openAttempt !== event.attempt) {
        violations.push('Activity completion must close the matching open attempt')
        return
      }
      current.openAttempt = undefined
      current.completed = true
    }
  })

  const runCompleted = events.some((event) => event.type === 'run_completed')
  if (runCompleted && [...activityStates.values()].some((state) => state.openAttempt !== undefined || state.retryScheduledFor !== undefined)) violations.push('Run cannot complete with open or scheduled activity attempts')

  events.forEach((event, index) => {
    if (event.type !== 'evaluation_experiment_bound') return
    const canonical = { providerRef: event.providerRef, experimentId: event.experimentId, suiteId: event.suiteId, datasetRef: event.datasetRef, datasetVersion: event.datasetVersion, candidateRef: event.candidateRef, traceRef: event.traceRef, graderRefs: event.graderRefs, trialCount: event.trialCount, environmentDigest: event.environmentDigest }
    if (event.experimentDigest !== digestValue(JSON.stringify(canonical))) violations.push('Evaluation experiment digest does not match its canonical content')
    if (event.trialCount < 1 || !event.datasetRef || !event.datasetVersion || !event.traceRef) violations.push('Evaluation experiment requires a versioned dataset, trace, and positive trial count')
    if (!event.graderRefs.length || new Set(event.graderRefs.map((grader) => `${grader.graderId}@${grader.version}`)).size !== event.graderRefs.length) violations.push('Evaluation experiment requires a unique grader inventory')
    const priorExperiment = events.slice(0, index).find((candidate) => candidate.type === 'evaluation_experiment_bound' && candidate.experimentId === event.experimentId)
    if (priorExperiment) violations.push('Evaluation experiment ID must be unique within a run')
  })

  events.forEach((event, index) => {
    if (event.type !== 'evaluation_completed') return
    const experiment = events.slice(0, index).reverse().find((candidate) => candidate.type === 'evaluation_experiment_bound' && candidate.suiteId === event.suiteId)
    if (managedRun && (!experiment || experiment.type !== 'evaluation_experiment_bound')) violations.push('Managed evaluation requires a bound experiment')
    else if (experiment?.type === 'evaluation_experiment_bound' && event.passed + event.failed + event.unknown !== experiment.trialCount) violations.push('Evaluation result count must match the bound experiment trial count')
  })

  events.forEach((event, index) => {
    if (event.type !== 'evaluation_diagnosed') return
    const evaluation = events.slice(0, index).reverse().find((candidate) => candidate.type === 'evaluation_completed')
    if (!evaluation || evaluation.type !== 'evaluation_completed' || evaluation.suiteId !== event.suiteId) violations.push('Evaluation diagnosis must follow the matching evaluation result')
    const experiment = events.slice(0, index).reverse().find((candidate) => candidate.type === 'evaluation_experiment_bound' && candidate.suiteId === event.suiteId)
    if (managedRun && (!experiment || experiment.type !== 'evaluation_experiment_bound')) violations.push('Evaluation diagnosis requires a bound experiment')
    else if (experiment?.type === 'evaluation_experiment_bound' && experiment.environmentDigest !== event.environment.imageDigest) violations.push('Evaluation diagnosis environment must match the bound experiment')
    if (event.failures.some((failure) => failure.confidence < 0 || failure.confidence > 1 || !failure.evidenceRefs.length)) violations.push('Evaluation diagnosis requires bounded confidence and evidence references')
  })

  const eventTypes = events.map((event) => event.type)
  const diagnosisIndex = eventTypes.lastIndexOf('evaluation_diagnosed')
  const completionIndex = eventTypes.lastIndexOf('run_completed')
  const roadmapUpdateIndex = eventTypes.lastIndexOf('roadmap_updated')
  if (managedRun && diagnosisIndex >= 0 && completionIndex >= 0 && (roadmapUpdateIndex <= diagnosisIndex || roadmapUpdateIndex >= completionIndex)) violations.push('Managed run completion requires a roadmap update after diagnosis')

  return violations
}

export function verifyEventProtocol(events: AgentRunEvent[]) {
  return validateEventProtocol(events).length === 0
}
