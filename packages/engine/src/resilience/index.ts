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
