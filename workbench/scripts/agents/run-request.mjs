// The parts of a Builder prompt every engine shares, built from the run request the Control Plane wrote. The engine
// wrappers only add how their engine works.

const list = (items, empty) => items?.length ? items.map((item) => `- ${item}`).join('\n') : empty

/** The task: the approved Intent, and on a revision the feedback it has to address. */
export function taskPrompt(request) {
  const intent = request.intent
  const criteria = (intent.acceptanceCriteria ?? []).map((criterion) => `- [${criterion.criticality}/${criterion.verificationType}] ${criterion.statement}`).join('\n')
  const examples = (intent.examples ?? []).map((example, index) => `Example ${index + 1}\nInput:\n${example.input}\nExpected:\n${example.expected}`).join('\n\n')
  const revisionFeedback = request.revision?.feedback?.map((feedback) => `- ${feedback.reviewerDisplayName}: ${feedback.comment || 'Changes requested without an additional comment.'}`).join('\n')
  return `You are the Builder Agent for an AI Native SDLC Control Plane run.

Target product type: ${request.workItem.productType}
Work item: ${request.workItem.title}
Goal: ${intent.goal}

Constraints:
${list(intent.constraints, '- None declared')}
${intent.nonGoals?.length ? `
Out of scope — do not do any of these, even where it looks helpful:
${list(intent.nonGoals)}
` : ''}
Acceptance criteria:
${criteria}
${examples ? `
Examples of the intended behaviour (illustrations; the acceptance criteria decide):
${examples}
` : ''}
${request.revision ? `This is a revision of Change Proposal ${request.revision.changeProposalId} at ${request.revision.previousHeadSha}.
Review feedback that must be addressed:
${revisionFeedback || '- Review requested changes; inspect the current implementation and acceptance criteria.'}` : 'This is the initial implementation run.'}`
}

/**
 * The declared context, as the Control Plane compiled it from the base revision: the Builder is given these contents,
 * not whatever the worktree holds at the same paths, which a previous revision may have changed without review.
 */
export function declaredContextSections(request) {
  const context = request.declaredContext
  if (!context) return []
  const sections = context.entries.map((entry) => `\n## Declared context: ${entry.path}${entry.truncatedAt === null ? '' : ` (first ${entry.truncatedAt} of ${entry.fileBytes} bytes; the rest did not fit the prompt budget)`}\n\n${entry.content}`)
  const leftOut = context.omitted.filter((omission) => omission.reason === 'budget').map((omission) => omission.path)
  if (!sections.length && !leftOut.length) return []
  return [
    `\nThe declared context below is taken from the base revision ${context.baseSha.slice(0, 12)}. Where a file in the working directory differs from it, the version here is the reviewed one.`,
    ...sections,
    ...(leftOut.length ? [`\nDeclared context left out because the prompt budget was spent: ${leftOut.join(', ')}. Read them from the working directory if you need them.`] : []),
  ]
}
