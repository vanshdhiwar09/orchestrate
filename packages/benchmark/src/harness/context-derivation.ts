import {
  type BenchmarkArmId,
  type TreatmentContextEnvelope,
} from './types.js';
import {
  type SuppliedContextReference,
  DiscoveryEvaluationError,
} from '../discovery/index.js';
import { normalizeDir, normalizePath } from '../discovery/matcher.js';

/**
 * Unescapes standard XML entities in parsed text.
 */
function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Validates XML tag balance and structural well-formedness.
 * Throws DiscoveryEvaluationError if tags are mismatched, unclosed, or corrupted.
 */
export function validateXmlWellFormedness(xml: string): void {
  const tagRegex =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/)?([a-zA-Z0-9_:-]+)([^>]*?)(\/)?>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const fullMatch = match[0];
    if (
      fullMatch.startsWith('<!--') ||
      fullMatch.startsWith('<![CDATA[') ||
      fullMatch.startsWith('<?')
    ) {
      continue;
    }
    const isClosing = match[1] === '/';
    const tagName = match[2];
    const isSelfClosing = match[4] === '/' || fullMatch.endsWith('/>');

    if (isSelfClosing) {
      continue;
    }

    if (isClosing) {
      if (stack.length === 0) {
        throw new DiscoveryEvaluationError(
          `Malformed XML context envelope: unexpected closing tag </${tagName}> without matching opening tag.`
        );
      }
      const top = stack.pop();
      if (top !== tagName) {
        throw new DiscoveryEvaluationError(
          `Malformed XML context envelope: mismatched closing tag </${tagName}>, expected </${top}>.`
        );
      }
    } else {
      stack.push(tagName);
    }
  }

  if (stack.length > 0) {
    throw new DiscoveryEvaluationError(
      `Malformed XML context envelope: unclosed tag <${stack[stack.length - 1]}>.`
    );
  }

  const lastOpen = xml.lastIndexOf('<');
  if (lastOpen >= 0) {
    const afterLastOpen = xml.slice(lastOpen);
    if (!afterLastOpen.includes('>')) {
      throw new DiscoveryEvaluationError(
        `Malformed XML context envelope: unclosed tag bracket starting at index ${lastOpen}.`
      );
    }
  }
}

/**
 * Extracts structured references from an XML string payload.
 */
function extractFromXml(xml: string): SuppliedContextReference[] {
  validateXmlWellFormedness(xml);

  const refs: SuppliedContextReference[] = [];

  // Files: <file>...</file> or <file path="..." />
  const fileTagRegex = /<file(?:\s+[^>]*)?>([^<]*?)<\/file>/g;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileTagRegex.exec(xml)) !== null) {
    const rawVal = unescapeXml(fileMatch[1]).trim();
    if (rawVal) {
      refs.push({ type: 'FILE', value: normalizePath(rawVal) });
    }
  }

  const filePathAttrRegex = /<file\b[^>]*?\spath=["']([^"']+)["']/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = filePathAttrRegex.exec(xml)) !== null) {
    const rawVal = unescapeXml(attrMatch[1]).trim();
    if (rawVal) {
      refs.push({ type: 'FILE', value: normalizePath(rawVal) });
    }
  }

  // Symbols: <symbol>...</symbol> or <symbol name="..." />
  const symbolTagRegex = /<symbol(?:\s+[^>]*)?>([^<]*?)<\/symbol>/g;
  let symMatch: RegExpExecArray | null;
  while ((symMatch = symbolTagRegex.exec(xml)) !== null) {
    const rawVal = unescapeXml(symMatch[1]).trim();
    if (rawVal) {
      refs.push({ type: 'SYMBOL', value: rawVal });
    }
  }

  const symAttrRegex = /<symbol\b[^>]*?\sname=["']([^"']+)["']/g;
  let symAttrMatch: RegExpExecArray | null;
  while ((symAttrMatch = symAttrRegex.exec(xml)) !== null) {
    const rawVal = unescapeXml(symAttrMatch[1]).trim();
    if (rawVal) {
      refs.push({ type: 'SYMBOL', value: rawVal });
    }
  }

  // Directories: <directory>...</directory> or <directory path="..." />
  const dirTagRegex = /<directory(?:\s+[^>]*)?>([^<]*?)<\/directory>/g;
  let dirMatch: RegExpExecArray | null;
  while ((dirMatch = dirTagRegex.exec(xml)) !== null) {
    const rawVal = unescapeXml(dirMatch[1]).trim();
    if (rawVal) {
      refs.push({ type: 'DIRECTORY', value: normalizeDir(rawVal) });
    }
  }

  const dirAttrRegex = /<directory\b[^>]*?\spath=["']([^"']+)["']/g;
  let dirAttrMatch: RegExpExecArray | null;
  while ((dirAttrMatch = dirAttrRegex.exec(xml)) !== null) {
    const rawVal = unescapeXml(dirAttrMatch[1]).trim();
    if (rawVal) {
      refs.push({ type: 'DIRECTORY', value: normalizeDir(rawVal) });
    }
  }

  // Decisions: <decision id="..." />
  const decisionRegex = /<decision\b[^>]*?\bid=["']([^"']+)["']/g;
  let decMatch: RegExpExecArray | null;
  while ((decMatch = decisionRegex.exec(xml)) !== null) {
    const id = unescapeXml(decMatch[1]).trim();
    if (id) {
      refs.push({ type: 'DECISION', value: id });
    }
  }

  // Facts: <fact key="..." />
  const factRegex = /<fact\b[^>]*?\bkey=["']([^"']+)["']/g;
  let factMatch: RegExpExecArray | null;
  while ((factMatch = factRegex.exec(xml)) !== null) {
    const key = unescapeXml(factMatch[1]).trim();
    if (key) {
      refs.push({ type: 'FACT', value: key });
    }
  }

  // Git State: <git_state>
  if (/<git_state\b/i.test(xml)) {
    refs.push({ type: 'GIT_STATE', value: 'status' });
  }

  // Git History: <head_commit hash="..." />
  const headCommitRegex = /<head_commit\b[^>]*?\bhash=["']([^"']+)["']/g;
  let commitMatch: RegExpExecArray | null;
  while ((commitMatch = headCommitRegex.exec(xml)) !== null) {
    const hash = unescapeXml(commitMatch[1]).trim();
    if (hash) {
      refs.push({ type: 'GIT_HISTORY', value: hash });
      refs.push({ type: 'GIT_HISTORY', value: 'HEAD' });
    }
  }

  // Git Diff: <diff>
  if (/<diff\b/i.test(xml)) {
    refs.push({ type: 'GIT_DIFF', value: '' });
  }

  return refs;
}

/**
 * Extracts structured references from a parsed JSON object.
 */
function extractFromJsonObject(obj: Record<string, unknown>): SuppliedContextReference[] {
  const refs: SuppliedContextReference[] = [];

  // Files: filesAffected or files
  const filesList = Array.isArray(obj.filesAffected)
    ? obj.filesAffected
    : Array.isArray(obj.files)
      ? obj.files
      : [];

  for (const item of filesList) {
    if (typeof item === 'string' && item.trim()) {
      refs.push({ type: 'FILE', value: normalizePath(item) });
    } else if (item && typeof item === 'object' && typeof (item as any).path === 'string') {
      refs.push({ type: 'FILE', value: normalizePath((item as any).path) });
    }
  }

  if (typeof obj.file === 'string' && obj.file.trim()) {
    refs.push({ type: 'FILE', value: normalizePath(obj.file) });
  }

  // Symbols
  const symbolsList = Array.isArray(obj.symbols) ? obj.symbols : [];
  for (const item of symbolsList) {
    if (typeof item === 'string' && item.trim()) {
      refs.push({ type: 'SYMBOL', value: item.trim() });
    } else if (item && typeof item === 'object' && typeof (item as any).name === 'string') {
      refs.push({ type: 'SYMBOL', value: (item as any).name.trim() });
    }
  }
  if (typeof obj.symbol === 'string' && obj.symbol.trim()) {
    refs.push({ type: 'SYMBOL', value: obj.symbol.trim() });
  }

  // Directories
  const dirList = Array.isArray(obj.directories) ? obj.directories : [];
  for (const item of dirList) {
    if (typeof item === 'string' && item.trim()) {
      refs.push({ type: 'DIRECTORY', value: normalizeDir(item) });
    }
  }
  if (typeof obj.directory === 'string' && obj.directory.trim()) {
    refs.push({ type: 'DIRECTORY', value: normalizeDir(obj.directory) });
  }

  // Decisions
  const decList = Array.isArray(obj.decisionsCreated)
    ? obj.decisionsCreated
    : Array.isArray(obj.decisions)
      ? obj.decisions
      : [];
  for (const item of decList) {
    if (typeof item === 'string' && item.trim()) {
      refs.push({ type: 'DECISION', value: item.trim() });
    }
  }

  // Facts
  const factList = Array.isArray(obj.facts) ? obj.facts : [];
  for (const item of factList) {
    if (typeof item === 'string' && item.trim()) {
      refs.push({ type: 'FACT', value: item.trim() });
    } else if (item && typeof item === 'object' && typeof (item as any).key === 'string') {
      refs.push({ type: 'FACT', value: (item as any).key.trim() });
    }
  }

  return refs;
}

/**
 * Extracts explicit relative file paths mentioned in unstructured plain text.
 * Uses non-consuming lookbehind and lookahead boundaries so consecutive or adjacent
 * paths are not skipped during global regex execution.
 * Note: Symbols are NOT inferred from unstructured text.
 */
function extractFilePathsFromText(text: string): SuppliedContextReference[] {
  const refs: SuppliedContextReference[] = [];
  // Matches relative paths with directory separators and common file extensions.
  // Leading boundary: start of string or whitespace/delimiter character.
  // Trailing boundary: lookahead for end of string or delimiter character.
  const pathRegex =
    /(?<=^|[\s"'`(\[<,])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]+)(?=$|[\s"'`)\]>:,.])/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    const p = match[1].trim();
    if (p) {
      refs.push({ type: 'FILE', value: normalizePath(p) });
    }
  }
  return refs;
}

/**
 * Deduplicates supplied context references by (type, value).
 */
function deduplicateRefs(refs: readonly SuppliedContextReference[]): SuppliedContextReference[] {
  const seen = new Set<string>();
  const deduped: SuppliedContextReference[] = [];
  for (const r of refs) {
    const key = `${r.type}:${r.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  return deduped;
}

/**
 * Derives structured supplied context references from the exact context envelope delivered to an agent.
 *
 * Rules:
 * - Arm A has no injected context and derives `[]`.
 * - Arm B derives references from its actual injected handoff, including only information actually present.
 * - Arm C derives references from its actual serialized compiled-context envelope, including only files and symbols explicitly represented.
 * - Fails with DiscoveryEvaluationError if a context-bearing arm has a missing or malformed envelope.
 */
export function deriveSuppliedContext(
  armId: BenchmarkArmId,
  contextEnvelope: TreatmentContextEnvelope | null
): SuppliedContextReference[] {
  if (armId === 'ARM_A_BASELINE') {
    if (contextEnvelope !== null) {
      throw new DiscoveryEvaluationError(
        `ARM_A_BASELINE must have null contextEnvelope, received: ${JSON.stringify(contextEnvelope)}`
      );
    }
    return [];
  }

  if (!contextEnvelope || typeof contextEnvelope.rawPayload !== 'string' || !contextEnvelope.rawPayload.trim()) {
    throw new DiscoveryEvaluationError(
      `Context-bearing arm ${armId} has a missing or empty context envelope.`
    );
  }

  const rawPayload = contextEnvelope.rawPayload.trim();

  if (armId === 'ARM_B_UNVERIFIED_HANDOFF') {
    // 1. Check if JSON payload (direct JSON or inside ```json code block)
    let jsonStr: string | null = null;
    if (rawPayload.startsWith('{')) {
      jsonStr = rawPayload;
    } else {
      const codeBlockMatch = rawPayload.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
    }

    if (jsonStr !== null) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed !== 'object' || parsed === null) {
          throw new DiscoveryEvaluationError(
            `ARM_B_UNVERIFIED_HANDOFF context envelope contains non-object JSON payload.`
          );
        }
        return deduplicateRefs(extractFromJsonObject(parsed));
      } catch (err: unknown) {
        if (err instanceof DiscoveryEvaluationError) throw err;
        throw new DiscoveryEvaluationError(
          `ARM_B_UNVERIFIED_HANDOFF context envelope contains malformed JSON payload.`,
          err
        );
      }
    }

    // 2. Check if XML structure (starts with < or has explicit tags)
    if (
      rawPayload.startsWith('<') ||
      /<(?:files_affected|file|symbol|directory)\b/.test(rawPayload)
    ) {
      return deduplicateRefs(extractFromXml(rawPayload));
    }

    // 3. Fallback: Unstructured text or Markdown list
    // Extracts explicit file paths present in the handoff. Symbols are NOT inferred from plain text.
    return deduplicateRefs(extractFilePathsFromText(rawPayload));
  }

  if (armId === 'ARM_C_ORCHESTRATE') {
    // Arm C envelope is structured XML serialized by ContextSerializer or wrapped in formatArmCTreatmentBlock
    const xmlToParse = contextEnvelope.formattedBlock || rawPayload;
    return deduplicateRefs(extractFromXml(xmlToParse));
  }

  throw new DiscoveryEvaluationError(`Unrecognized benchmark armId "${armId}".`);
}

/**
 * Validates explicitly supplied context references against the actual delivered envelope.
 *
 * Rules:
 * - Arm A: Rejects any explicit references (must be empty []).
 * - Arm B / Arm C: Ensures every explicit reference is actually represented in the deterministically
 *   derived reference set using canonical normalizers.
 *   Rejects any claim of absent or unverifiable context with DiscoveryEvaluationError.
 */
export function validateSuppliedContext(
  armId: BenchmarkArmId,
  contextEnvelope: TreatmentContextEnvelope | null,
  explicitSuppliedContext: readonly SuppliedContextReference[]
): SuppliedContextReference[] {
  if (armId === 'ARM_A_BASELINE') {
    if (explicitSuppliedContext.length > 0) {
      throw new DiscoveryEvaluationError(
        `Arm ARM_A_BASELINE has no context envelope, but explicit suppliedContext claims ${explicitSuppliedContext.length} reference(s).`
      );
    }
    return [];
  }

  // Derive all references justifiable by the actual envelope
  const derived = deriveSuppliedContext(armId, contextEnvelope);

  for (const ref of explicitSuppliedContext) {
    let isJustified = false;

    if (ref.type === 'FILE') {
      const normVal = normalizePath(ref.value);
      isJustified = derived.some(
        (d) => d.type === 'FILE' && normalizePath(d.value) === normVal
      );
    } else if (ref.type === 'DIRECTORY') {
      const normVal = normalizeDir(ref.value);
      isJustified = derived.some(
        (d) => d.type === 'DIRECTORY' && normalizeDir(d.value) === normVal
      );
    } else if (ref.type === 'SYMBOL') {
      isJustified = derived.some(
        (d) => d.type === 'SYMBOL' && d.value === ref.value
      );
    } else if (ref.type === 'GIT_STATE') {
      isJustified = derived.some((d) => d.type === 'GIT_STATE');
    } else if (ref.type === 'GIT_HISTORY') {
      isJustified = derived.some(
        (d) =>
          d.type === 'GIT_HISTORY' &&
          (d.value === '' || d.value === ref.value || ref.value === '' || ref.value === 'HEAD')
      );
    } else if (ref.type === 'GIT_DIFF') {
      isJustified = derived.some(
        (d) =>
          d.type === 'GIT_DIFF' &&
          (d.value === '' || d.value === ref.value || ref.value === '')
      );
    } else {
      isJustified = derived.some(
        (d) => d.type === ref.type && d.value === ref.value
      );
    }

    if (!isJustified) {
      throw new DiscoveryEvaluationError(
        `Explicit suppliedContext for ${armId} claims ${ref.type} "${ref.value}" which is absent from the delivered context envelope.`
      );
    }
  }

  return [...explicitSuppliedContext];
}

/**
 * Resolves supplied context references for an arm execution:
 * - If explicit suppliedContext is provided, validates that no absent context is claimed.
 * - Otherwise, automatically derives references from the delivered context envelope.
 */
export function resolveSuppliedContextForArm(
  armId: BenchmarkArmId,
  contextEnvelope: TreatmentContextEnvelope | null,
  explicitSuppliedContext?: readonly SuppliedContextReference[]
): SuppliedContextReference[] {
  if (explicitSuppliedContext !== undefined) {
    return validateSuppliedContext(armId, contextEnvelope, explicitSuppliedContext);
  }
  return deriveSuppliedContext(armId, contextEnvelope);
}
