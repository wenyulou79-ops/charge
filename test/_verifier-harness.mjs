/**
 * Minimal assertion harness for the adversarial verifier scripts.
 * Independent of test/verify.mjs so a defect in that file cannot mask results.
 */

let passed = 0
const failures = []

export function section(title) {
  console.log(`\n[${title}]`)
}

export function note(text) {
  console.log(`  note  ${text}`)
}

export function ok(label) {
  passed += 1
  console.log(`  PASS  ${label}`)
}

export function bad(label, detail) {
  failures.push(`${label} :: ${detail}`)
  console.log(`  FAIL  ${label}\n        ${detail}`)
}

/** Assert a required invariant; a failure is a confirmed defect. */
export function check(label, condition, detail = 'condition is falsy') {
  if (condition) ok(label)
  else bad(label, detail)
}

export function eq(label, actual, expected) {
  check(
    label,
    Object.is(actual, expected),
    `expected ${JSON.stringify(expected)} (${typeof expected}), got ${JSON.stringify(actual)} (${typeof actual})`,
  )
}

export function close(label, actual, expected, relTol = 1e-12) {
  const diff = Math.abs(actual - expected)
  const rel = expected === 0 ? diff : diff / Math.abs(expected)
  check(
    label,
    Number.isFinite(actual) && rel <= relTol,
    `expected ${expected}, got ${actual} (abs ${diff}, rel ${rel}, tol ${relTol})`,
  )
}

export function report(name) {
  console.log(`\n${name}: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log('--- failed invariants (each is a reported defect) ---')
    for (const line of failures) console.log(` * ${line}`)
  }
  process.exitCode = failures.length === 0 ? 0 : 1
  return failures.length
}
