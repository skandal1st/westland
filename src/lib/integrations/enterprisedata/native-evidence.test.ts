import { expect, it } from 'vitest'
import { nativeFixture } from '../../../../tests/fixtures/enterprisedata-native'
import { nativeEvidenceDigest, validateNativeReferences } from './native-evidence'
it('validates linked native objects and retains native provenance, not an ED receipt', () => {
  const { input, evidence, oldId } = nativeFixture()
  expect(validateNativeReferences(input, evidence)).toMatchObject({ originalDocumentId: oldId, provenance: 'user-supplied-native', sourceDigest: input.references.evidenceSha256 })
})
it('rejects edited evidence even when its external references are unchanged', () => {
  const { input, evidence } = nativeFixture()
  evidence.order = Buffer.concat([evidence.order, Buffer.from(' ')])
  expect(() => validateNativeReferences(input, evidence)).toThrow('ed_native_evidence_mismatch')
})
it('rejects unrelated buyers and tax/unit substitutions even after recomputing a bundle hash', () => {
  for (const [key, from, to] of [['counterparty', 'ИП Вымышленный &amp; Тестовый', 'Другой ИП'], ['product', '<ИспользоватьУпаковки>false', '<ИспользоватьУпаковки>true'], ['confirmation', '"vatRate":22', '"vatRate":20']] as const) {
    const { input, evidence } = nativeFixture()
    evidence[key] = Buffer.from(evidence[key].toString().replace(from, to))
    input.references.evidenceSha256 = nativeEvidenceDigest(evidence)
    expect(() => validateNativeReferences(input, evidence)).toThrow()
  }
})
