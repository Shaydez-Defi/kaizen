/**
 * Proof-of-Resilience (Phase 9): chain-bound, signed run certificates and
 * per-validator resilience scores. See docs/RESILIENCE_SCORE.md and DEC-029.
 */

export {
  CHAIN_EVIDENCE_VERSION,
  CHAIN_EVIDENCE_PHASES,
  DEFAULT_EXPECTED_BLOCK_TIME_MS,
  ChainEvidenceRecorder,
  computeRecoveryMetrics,
  isBlockRef,
} from './evidence';
export type {
  BlockRef,
  ChainEvidence,
  ChainEvidenceGap,
  ChainEvidencePhase,
  ChainEvidenceRecorderOptions,
  ChainObservation,
  HeadReader,
  RecoveryMetrics,
} from './evidence';
export { ChainUnreachableError, createHttpChainReader } from './rpc';
export type { ChainReader, FetchLike, HttpChainReaderOptions } from './rpc';
export {
  KAIZEN_CERTIFICATE_VERSION,
  certificateDocument,
  certificateMessage,
  checkCertificateSignature,
  computeCertificateFingerprint,
  issueCertificate,
} from './certificate';
export type { CertificateSignature, ResilienceCertificate, SignatureCheck } from './certificate';
export {
  DEV_RESILIENCE_SIGNER_URI,
  RESILIENCE_SIGNER_ENV_KEY,
  RESILIENCE_SIGNER_FILE_ENV_KEY,
  loadResilienceSigner,
  resilienceSignerConfigured,
} from './signer';
export type { LoadResilienceSignerOptions, ResilienceSigner, ResilienceSignerSource } from './signer';
export { verifyCertificate, verifyChainEvidence } from './verify';
export type { BlockCheck, CertificateVerification, ChainCheck, ChainCheckStatus } from './verify';
export { RESILIENCE_SCORE_PARAMS, RESILIENCE_SCORE_VERSION, computeResilienceScore, scoreRun } from './score';
export type { ResilienceScore, ScoredRun, ScoredRunInput } from './score';
export {
  CERTIFICATE_RECORDED_TOPIC,
  EVIDENCE_FLAGS,
  RESILIENCE_REGISTRY_SIGNATURES,
  UNKNOWN_U16,
  UNKNOWN_U32,
  decodeCertOf,
  decodeScore,
  encodeCertOfCall,
  encodeGetScoreCall,
  encodeRecordCall,
  encodeRecordedCall,
  recordInputFromCertificate,
  validatorKey,
} from './registry-abi';
export type { OnChainCertificate, RecordCallInput } from './registry-abi';
export { KAIZEN_RESILIENCE_REGISTRY_ARTIFACT } from './registry-artifact';
export {
  RESILIENCE_REGISTRY_ENV_KEY,
  ResilienceRegistryService,
  certificateSignatureHolds,
} from './onchain';
export type {
  ResilienceAnchorReceipt,
  ResilienceChainJournalEntry,
  ResilienceChainReceipt,
  ResilienceOnChainRead,
  ResilienceRegistryDeployment,
  ResilienceRegistryServiceOptions,
} from './onchain';
export { RESILIENCE_CAPTURE_ENV_KEY, ResilienceService } from './service';
export type { ResilienceServiceOptions } from './service';
export {
  DEFAULT_DRILL_CATALOGUE,
  DEFAULT_DRILL_SEED_BOUNDS,
  DRILL_SEED_DOMAIN,
  deriveDrill,
} from './drill-seed';
export type { DeriveDrillInput, DerivedDrill, DrillSeedBounds } from './drill-seed';
