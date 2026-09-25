import { appendFileSync } from 'node:fs'

// A running Builder reports what it is doing, one line per step, to the file the runner names in
// APERTURE_PROGRESS_FILE; the Control Plane shows the latest lines on the running Intent. It is the Builder's own
// account, labelled as such, and never evidence. Reporting must not fail a run, so every error is swallowed.
export function progress(summary) {
  const path = process.env.APERTURE_PROGRESS_FILE
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), summary: String(summary).replace(/\s+/gu, ' ').trim().slice(0, 200) })}\n`)
  } catch {
    // Progress is a courtesy to the reader; the run goes on without it.
  }
}
