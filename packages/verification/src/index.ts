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

export {
  validateRelativeImportsInContent,
  detectRepositoryModuleResolutionRule,
  verifyModuleResolution,
  type ModuleResolutionCheckOptions,
  type ModuleResolutionIssue,
  type ModuleResolutionReport,
} from './esm-verifier.js';

export {
  computeSourceSnapshot,
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_FILE_PATTERNS,
  normalizeRelPath,
  type SourceFileEntry,
  type SourceSnapshotIdentity,
  type SourceSnapshotOptions,
} from '@orchestrate/workspace';
