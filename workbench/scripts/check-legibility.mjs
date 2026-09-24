// Legibility invariants for src/styles.css. The UI is dense and largely Chinese, which is where the original
// 7-10px type scale and sub-3:1 grey ramp failed hardest, so these are asserted rather than left to review.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

// CJK glyphs carry 2-3x the stroke count of Latin at the same size; below this they stop resolving on a
// standard-density display. Latin-only micro-labels sit at the floor, never under it.
const minimumFontSize = 12
// WCAG 1.4.3 AA for body text. The ramp actually lands well above this; the check guards the floor.
const minimumTextContrast = 4.5
// WCAG 1.4.11 for a control's own boundary, so form fields stay findable.
const minimumControlBorderContrast = 3
// Darkest surface text sits on: clearing it clears every lighter panel too.
const darkestSurface = '0e2142'
// A line box needs roughly this multiple of its font size before ascenders and CJK glyphs get clipped.
const minimumBoxRatio = 1.7

const formControlSelectorPattern = /(?:^|[\s,])(?:input|select|textarea)\b|\.inline-search$/

function toRgb(hex) {
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
}

function linear(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function composite([r, g, b], alpha, over) {
  return [r, g, b].map((channel, index) => channel * alpha + over[index] * (1 - alpha))
}

const surface = toRgb(darkestSurface)
const failures = []

// Declared custom properties must all exist: an undefined var() silently drops the declaration, which is how
// two input borders and a failed-threshold colour ended up invisible.
const declaredTokens = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
for (const token of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))) {
  if (!declaredTokens.has(token)) failures.push(`undefined custom property var(${token})`)
}

// `font:` shorthand counts as much as `font-size:` — the shorthand is where the last 7px monospace IDs hid.
for (const [declaration, size] of css.matchAll(/font(?:-size)?: *([0-9]+)px/g)) {
  if (Number(size) < minimumFontSize) failures.push(`font size below ${minimumFontSize}px: ${declaration}`)
}

// Sizes come from the six-step --text-* scale only. Raw values are how eleven sizes crept in, and the floor
// above is enforced on the scale itself, so a token cannot quietly drop below it either.
const typeScale = new Map([...css.matchAll(/(--text-[a-z0-9]+): *([0-9]+)px/g)].map(([, token, size]) => [token, Number(size)]))
if (typeScale.size !== 6) failures.push(`type scale should have 6 steps, found ${typeScale.size}`)
for (const [token, size] of typeScale) if (size < minimumFontSize) failures.push(`${token} is ${size}px, below ${minimumFontSize}px`)
for (const [declaration] of css.matchAll(/font(?:-size)?: *[0-9.]+(?:px|rem|em)/g)) failures.push(`font size outside the --text-* scale: ${declaration}`)
for (const [, token] of css.matchAll(/font(?:-size)?: *var\((--[a-z0-9-]+)\)/g)) {
  if (!typeScale.has(token)) failures.push(`font size token var(${token}) is not a --text-* step`)
}

for (const [, hex] of css.matchAll(/(?:^|[;{\s])color: *#([0-9a-fA-F]{6})/g)) {
  const ratio = contrast(toRgb(hex.toLowerCase()), surface)
  if (ratio < minimumTextContrast) failures.push(`text colour #${hex} is ${ratio.toFixed(2)}:1 on #${darkestSurface}`)
}

// Tokens are checked through their use, not their declaration: --accent has to stay saturated because borders
// and fills depend on it, so only the ones something actually renders text in are held to the text threshold.
const tokenValues = new Map([...css.matchAll(/(--[a-z0-9-]+): *#([0-9a-fA-F]{6})/g)].map(([, token, hex]) => [token, hex.toLowerCase()]))
for (const [, token] of css.matchAll(/(?:^|[;{\s])color: *var\((--[a-z0-9-]+)\)/g)) {
  const hex = tokenValues.get(token)
  if (!hex) continue
  const ratio = contrast(toRgb(hex), surface)
  if (ratio < minimumTextContrast) failures.push(`var(${token}) = #${hex} renders text at ${ratio.toFixed(2)}:1 on #${darkestSurface}`)
}

// A translucent text colour has no verifiable contrast, because it depends on whatever it happens to sit on.
for (const [declaration] of css.matchAll(/(?:^|[;{\s])color: *rgba?\([^)]*\)/g)) {
  if (!/var\(/.test(declaration)) failures.push(`translucent text colour: ${declaration.trim()}`)
}

const fieldLineAlpha = css.match(/--field-line: *rgba\(255,255,255,(\.[0-9]+)\)/)
if (!fieldLineAlpha) {
  failures.push('--field-line is missing, so form controls have no guaranteed 3:1 boundary')
} else {
  const ratio = contrast(composite([255, 255, 255], Number(fieldLineAlpha[1]), surface), surface)
  if (ratio < minimumControlBorderContrast) failures.push(`--field-line is ${ratio.toFixed(2)}:1, below ${minimumControlBorderContrast}:1`)
}

for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  // Resolve scale tokens too, or this check goes silent the moment sizes stop being written as raw px.
  const fontSize = body.match(/font(?:-size)?: *(?:([0-9]+)px|var\((--text-[a-z0-9]+)\))/)
  if (!fontSize) continue
  const size = fontSize[1] ? Number(fontSize[1]) : typeScale.get(fontSize[2])
  if (!size) continue
  const fixedHeight = body.match(/(?:^|[;\s])height: *([0-9]+)px/)
  const minimumHeight = body.match(/min-height: *([0-9]+)px/)
  const box = fixedHeight ?? minimumHeight
  if (box && Number(box[1]) < size * minimumBoxRatio) {
    failures.push(`${selector.trim()} reserves ${box[1]}px for ${size}px text`)
  }
  if (formControlSelectorPattern.test(selector.trim()) && /border: 1px solid var\(--line\b/.test(body)) {
    failures.push(`${selector.trim()} outlines a control with --line instead of --field-line`)
  }
}

// Keyboard focus has one owner: the global :focus-visible rule. A per-component `outline: 0` wins on specificity
// order and silently removes the ring; that is how every input, select and textarea here lost visible focus.
if (!/:focus-visible\)? *\{ *outline: 2px solid var\(--focus-ring\)/.test(css)) failures.push('the global :focus-visible rule using var(--focus-ring) is missing')
for (const [declaration] of css.matchAll(/outline: *(?:0|none)\b/g)) failures.push(`${declaration} suppresses the focus ring; rely on the global :focus-visible rule`)

// A bare `1fr` track has an automatic minimum equal to its content, so one wide child (the 8-stage flow strip)
// widened every panel on the page to 718px at a 390px viewport. Single-column tracks must be able to shrink.
for (const [declaration] of css.matchAll(/grid-template-columns: *1fr *;/g)) failures.push(`${declaration} lets content force horizontal scroll; use minmax(0,1fr)`)

if (failures.length > 0) {
  console.error(`styles.css legibility check failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('styles.css legibility check passed')
console.log(`  font sizes >= ${minimumFontSize}px, text contrast >= ${minimumTextContrast}:1 on #${darkestSurface}, control borders >= ${minimumControlBorderContrast}:1, focus ring and shrinkable single-column tracks enforced`)
