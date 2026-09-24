import type { AttestationProvider, AttestationRequest, AttestationVerification, EvidenceAttestation, InTotoStatement } from './contracts.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array) {
  return Uint8Array.from(bytes).buffer
}

function preAuthenticationEncoding(payloadType: string, payload: Uint8Array) {
  const typeBytes = encoder.encode(payloadType)
  const prefix = encoder.encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `)
  const encoded = new Uint8Array(prefix.length + payload.length)
  encoded.set(prefix)
  encoded.set(payload, prefix.length)
  return encoded
}

async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class LocalEphemeralAttestationProvider implements AttestationProvider {
  readonly id = 'attestation://local-ephemeral-ecdsa-p256-v1'

  async attest(request: AttestationRequest): Promise<EvidenceAttestation> {
    const payloadType = 'application/vnd.in-toto+json' as const
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const keyId = `sha256:${await sha256(JSON.stringify(publicKeyJwk))}`
    const statement: InTotoStatement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: request.evidenceUri, digest: { sha256: await sha256(request.content) } }],
      predicateType: 'https://aperture.dev/attestation/evidence-package/v0.1',
      predicate: {
        runId: request.runId,
        evidenceUri: request.evidenceUri,
        repositoryDigest: request.repositoryDigest,
        chainHead: request.chainHead,
        eventCount: request.eventCount,
        workflowId: request.workflowId,
      },
    }
    const payloadBytes = encoder.encode(JSON.stringify(statement))
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, toArrayBuffer(preAuthenticationEncoding(payloadType, payloadBytes)))
    return {
      schemaVersion: 'aperture.attestation/v0.1',
      providerId: this.id,
      trustLevel: 'ephemeral_local',
      identity: 'local://ephemeral-key',
      keyId,
      signedAt: new Date().toISOString(),
      statement,
      envelope: {
        payloadType,
        payload: bytesToBase64Url(payloadBytes),
        signatures: [{ keyid: keyId, sig: bytesToBase64Url(new Uint8Array(signature)) }],
      },
      publicKeyJwk,
    }
  }

  async verify(attestation: EvidenceAttestation, content: string): Promise<AttestationVerification> {
    const reasons: string[] = []
    const payloadBytes = base64UrlToBytes(attestation.envelope.payload)
    const payloadValid = decoder.decode(payloadBytes) === JSON.stringify(attestation.statement)
    if (!payloadValid) reasons.push('Envelope payload does not match the statement')

    const subjectDigestValid = attestation.statement.subject.length === 1
      && attestation.statement.subject[0]?.digest.sha256 === await sha256(content)
    if (!subjectDigestValid) reasons.push('Evidence Package SHA-256 does not match the attested subject')

    const expectedKeyId = `sha256:${await sha256(JSON.stringify(attestation.publicKeyJwk))}`
    const signatureEntry = attestation.envelope.signatures[0]
    const keyIdentityValid = attestation.keyId === expectedKeyId && signatureEntry?.keyid === expectedKeyId
    if (!keyIdentityValid) reasons.push('Public key identity does not match the signature key ID')

    let signatureValid = false
    if (signatureEntry && keyIdentityValid) {
      try {
        const publicKey = await crypto.subtle.importKey('jwk', attestation.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        signatureValid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, toArrayBuffer(base64UrlToBytes(signatureEntry.sig)), toArrayBuffer(preAuthenticationEncoding(attestation.envelope.payloadType, payloadBytes)))
      } catch {
        signatureValid = false
      }
    }
    if (!signatureValid) reasons.push('ECDSA signature verification failed')

    return {
      valid: payloadValid && subjectDigestValid && keyIdentityValid && signatureValid,
      signatureValid,
      subjectDigestValid,
      payloadValid,
      identityAnchored: false,
      reasons: [...reasons, 'Signer identity uses an ephemeral local key and is not anchored to enterprise PKI or Sigstore'],
    }
  }
}
