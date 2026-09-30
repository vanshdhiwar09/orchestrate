export type {
  VerificationCheck,
  VerificationPlan,
  VerificationEvidence,
  VerificationStatus,
  VerificationResult,
  VerificationEngineOptions,
} from './types.js';

export {
  VerificationEngine,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  ALLOWED_VERIFICATION_COMMANDS,
} from './engine.js';
