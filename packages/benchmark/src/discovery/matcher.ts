import type {
  DiscoveryCategory,
  DiscoveryEvent,
  SuppliedContextReference,
  SuppliedContextType,
} from './types.js';

/**
 * Known tools that strictly execute, mutate, test, build, or communicate,
 * and therefore never qualify as repository discovery actions.
 */
export const NON_QUALIFYING_TOOLS: ReadonlySet<string> = new Set([
  // File modifications & deletions
  'write_file',
  'edit_file',
  'replace_file_content',
  'delete_file',
  'rm',
  // Execution & subprocess tooling
  'run_command',
  'execute_command',
  // Verification & build validation
  'run_tests',
  'test',
  'build',
  'typecheck',
  'lint',
  // Version control mutations
  'commit',
  'git commit',
  'git add',
  'git checkout',
  'push',
  'git push',
  // Human communication
  'ask_question',
  'prompt_user',
  'send_message_to_user',
]);

/**
 * Valid qualifying discovery categories according to the frozen contract.
 */
export const VALID_DISCOVERY_CATEGORIES: ReadonlySet<DiscoveryCategory> = new Set<DiscoveryCategory>([
  'FILE_READ',
  'FILE_LIST',
  'SEARCH',
  'SYMBOL_LOOKUP',
  'GIT_STATE',
  'GIT_HISTORY',
  'GIT_DIFF',
]);

/**
 * Valid types for structured context references supplied to Agent B.
 */
export const VALID_SUPPLIED_CONTEXT_TYPES: ReadonlySet<SuppliedContextType> = new Set<SuppliedContextType>([
  'TASK',
  'FILE',
  'DIRECTORY',
  'SYMBOL',
  'DECISION',
  'FACT',
  'VERIFICATION',
  'HANDOFF',
  'GIT_STATE',
  'GIT_HISTORY',
  'GIT_DIFF',
]);

/**
 * Unwraps single or double quotes enclosing a string, trimming surrounding whitespace.
 */
export function unwrapQuotes(s: string): string {
  let str = s.trim();
  if (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'"))
  ) {
    if (str.length >= 2) {
      str = str.slice(1, -1).trim();
    }
  }
  return str;
}

/**
 * Normalizes a file path:
 * 1. Trim whitespace and unwrap quotes.
 * 2. Replace backslashes `\` with forward slashes `/`.
 * 3. Strip leading slashes and `./` prefixes.
 * 4. Strip trailing slashes for files (e.g. "src/auth.ts/" -> "src/auth.ts").
 * 5. Collapse duplicate forward slashes.
 */
export function normalizePath(p: string): string {
  let cleaned = unwrapQuotes(p);
  cleaned = cleaned.replace(/\\+/g, '/');
  cleaned = cleaned.replace(/^(\.\/|\/)+/, '');
  cleaned = cleaned.replace(/\/+$/, '');
  cleaned = cleaned.replace(/\/+/g, '/');
  if (cleaned === '.' || cleaned === './') {
    return '';
  }
  return cleaned;
}

/**
 * Normalizes a directory path:
 * 1. Trim whitespace and unwrap quotes.
 * 2. Replace backslashes `\` with forward slashes `/`.
 * 3. Strip leading slashes and `./` prefixes.
 * 4. Ensure a trailing slash `/` (e.g. "src" -> "src/", "" -> "./", "src/" -> "src/").
 */
export function normalizeDir(p: string): string {
  let cleaned = unwrapQuotes(p);
  cleaned = cleaned.replace(/\\+/g, '/');
  cleaned = cleaned.replace(/^(\.\/|\/)+/, '');
  cleaned = cleaned.replace(/\/+/g, '/');
  if (cleaned === '' || cleaned === '.' || cleaned === './') {
    return './';
  }
  if (!cleaned.endsWith('/')) {
    cleaned = cleaned + '/';
  }
  return cleaned;
}

/**
 * Extracts the filename component from a path string after normalization.
 */
export function basename(p: string): string {
  const norm = normalizePath(p);
  if (!norm) return '';
  const lastSlash = norm.lastIndexOf('/');
  return lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
}

/**
 * Returns true if a tool name is known to be non-qualifying.
 */
export function isNonQualifyingTool(toolName: string): boolean {
  return NON_QUALIFYING_TOOLS.has(toolName.trim().toLowerCase());
}

/**
 * Checks whether a single discovery event matches a supplied context reference
 * according to the exact, type-aware matching matrix in Section 5.1 of DISCOVERY_MEASUREMENT.md.
 */
export function matchesSuppliedReference(
  reference: SuppliedContextReference,
  event: DiscoveryEvent
): boolean {
  switch (event.category) {
    case 'FILE_READ': {
      if (reference.type !== 'FILE') return false;
      const target = event.target ?? '';
      if (!target.trim() || !reference.value.trim()) return false;
      return normalizePath(reference.value) === normalizePath(target);
    }

    case 'FILE_LIST': {
      if (reference.type !== 'DIRECTORY') return false;
      const target = event.target ?? '';
      return normalizeDir(reference.value) === normalizeDir(target);
    }

    case 'SEARCH': {
      const target = event.target ?? '';
      if (!target.trim()) return false;

      if (reference.type === 'SYMBOL') {
        return reference.value === target;
      }

      if (reference.type === 'FILE') {
        if (!reference.value.trim()) return false;
        const normRef = normalizePath(reference.value);
        const normTarget = normalizePath(target);
        const baseRef = basename(reference.value);
        const unwrappedTarget = unwrapQuotes(target);
        return (
          (normRef.length > 0 && normTarget.length > 0 && normRef === normTarget) ||
          baseRef === target ||
          baseRef === unwrappedTarget
        );
      }

      return false;
    }

    case 'SYMBOL_LOOKUP': {
      if (reference.type !== 'SYMBOL') return false;
      const target = event.target ?? '';
      if (!target.trim() || !reference.value.trim()) return false;
      return reference.value === target;
    }

    case 'GIT_STATE': {
      return reference.type === 'GIT_STATE';
    }

    case 'GIT_HISTORY': {
      if (reference.type !== 'GIT_HISTORY') return false;
      const refVal = reference.value.trim();
      const target = (event.target ?? '').trim();
      return refVal === '' || refVal === target;
    }

    case 'GIT_DIFF': {
      if (reference.type !== 'GIT_DIFF') return false;
      const refVal = reference.value.trim();
      const target = (event.target ?? '').trim();
      return refVal === '' || refVal === target;
    }

    default:
      return false;
  }
}

/**
 * Checks whether an event is exempt from discovery by matching at least one
 * supplied context reference.
 */
export function isExemptFromDiscovery(
  event: DiscoveryEvent,
  suppliedContext: readonly SuppliedContextReference[]
): boolean {
  for (const ref of suppliedContext) {
    if (matchesSuppliedReference(ref, event)) {
      return true;
    }
  }
  return false;
}
