import assert from 'node:assert/strict'
import { LocalEphemeralAttestationProvider } from '../src/adapters/local-attestation-provider.ts'

const provider = new LocalEphemeralAttestationProvider()
const content = JSON.stringify({ runId: 'RUN-ATTEST-001', events: [{ sequence: 1, digest: 'fnv1a:abc' }] })
const attestation = await provider.attest({
  runId: 'RUN-ATTEST-001',
  evidenceUri: 'local://evidence/run-attest-001.json',
  repositoryDigest: 'fnv1a:repository',
  chainHead: 'fnv1a:chain-head',
  eventCount: 1,
  workflowId: 'workflow://RUN-ATTEST-001',
  content,
})

assert.equal(attestation.statement._type, 'https://in-toto.io/Statement/v1')
assert.equal(attestation.statement.subject[0]?.name, 'local://evidence/run-attest-001.json')
assert.match(attestation.statement.subject[0]?.digest.sha256 ?? '', /^[a-f0-9]{64}$/)
assert.equal(attestation.trustLevel, 'ephemeral_local')
assert.equal(attestation.envelope.signatures[0]?.keyid, attestation.keyId)

const verification = await provider.verify(attestation, content)
assert.equal(verification.valid, true)
assert.equal(verification.signatureValid, true)
assert.equal(verification.subjectDigestValid, true)
assert.equal(verification.payloadValid, true)
assert.equal(verification.identityAnchored, false)

const contentTamper = await provider.verify(attestation, `${content}tampered`)
assert.equal(contentTamper.valid, false)
assert.equal(contentTamper.subjectDigestValid, false)

const statementTamper = structuredClone(attestation)
statementTamper.statement.predicate.eventCount = 2
const statementVerification = await provider.verify(statementTamper, content)
assert.equal(statementVerification.valid, false)
assert.equal(statementVerification.payloadValid, false)

const signatureTamper = structuredClone(attestation)
signatureTamper.envelope.signatures[0]!.sig = signatureTamper.envelope.signatures[0]!.sig.replace(/^./u, signatureTamper.envelope.signatures[0]!.sig.startsWith('A') ? 'B' : 'A')
const signatureVerification = await provider.verify(signatureTamper, content)
assert.equal(signatureVerification.valid, false)
assert.equal(signatureVerification.signatureValid, false)

console.log(`attestation provider smoke passed · ${attestation.keyId.slice(0, 23)}… · identity intentionally unanchored`)
