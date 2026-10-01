import {
  isExemptFromDiscovery,
  isNonQualifyingTool,
  VALID_DISCOVERY_CATEGORIES,
  VALID_SUPPLIED_CONTEXT_TYPES,
} from './matcher.js';
import {
  DiscoveryEvaluationError,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationReport,
  type DiscoveryEvaluator,
  type DiscoveryEvent,
  type UnclassifiedEvent,
} from './types.js';

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj as Readonly<T>;
}

/**
 * Pure deterministic evaluator for the benchmark metric `discovery_actions`.
 * Transforms recorded tool retrieval events and structured supplied context
 * into a frozen DiscoveryEvaluationReport.
 */
export function evaluateDiscovery(
  input: DiscoveryEvaluationInput
): Readonly<DiscoveryEvaluationReport> {
  if (!input || typeof input !== 'object') {
    throw new DiscoveryEvaluationError('evaluateDiscovery: input must be a non-null object.');
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    throw new DiscoveryEvaluationError('evaluateDiscovery: input.taskId must be a non-empty string.');
  }

  if (!Array.isArray(input.suppliedContext)) {
    throw new DiscoveryEvaluationError('evaluateDiscovery: input.suppliedContext must be an array.');
  }

  if (!Array.isArray(input.events)) {
    throw new DiscoveryEvaluationError('evaluateDiscovery: input.events must be an array.');
  }

  for (let i = 0; i < input.suppliedContext.length; i++) {
    const ref = input.suppliedContext[i];
    if (!ref || typeof ref !== 'object') {
      throw new DiscoveryEvaluationError(
        `evaluateDiscovery: suppliedContext[${i}] must be a non-null object.`
      );
    }
    if (!VALID_SUPPLIED_CONTEXT_TYPES.has(ref.type)) {
      throw new DiscoveryEvaluationError(
        `evaluateDiscovery: suppliedContext[${i}].type '${ref.type}' is not a recognized SuppliedContextType.`
      );
    }
    if (typeof ref.value !== 'string') {
      throw new DiscoveryEvaluationError(
        `evaluateDiscovery: suppliedContext[${i}].value must be a string.`
      );
    }
  }

  if (input.unclassifiedEvents !== undefined && !Array.isArray(input.unclassifiedEvents)) {
    throw new DiscoveryEvaluationError(
      'evaluateDiscovery: input.unclassifiedEvents must be an array if provided.'
    );
  }

  const qualifyingEvents: DiscoveryEvent[] = [];
  const suppliedHits: DiscoveryEvent[] = [];
  const unclassified: UnclassifiedEvent[] = [];

  if (input.unclassifiedEvents) {
    for (const un of input.unclassifiedEvents) {
      unclassified.push(un);
    }
  }

  // Sort events strictly by sequence index (monotonically increasing)
  const sortedEvents = [...input.events].sort((a, b) => a.sequence - b.sequence);

  for (const event of sortedEvents) {
    if (!event || typeof event !== 'object') {
      throw new DiscoveryEvaluationError(
        'evaluateDiscovery: events array contains a null or non-object item.'
      );
    }

    if (
      typeof event.sequence !== 'number' ||
      !Number.isInteger(event.sequence) ||
      event.sequence < 1
    ) {
      unclassified.push({
        sequence: typeof event.sequence === 'number' ? event.sequence : 0,
        toolName: event.toolName || 'unknown',
        rawInput: event.target,
        reason: 'Invalid or non-positive sequence number.',
      });
      continue;
    }

    if (typeof event.toolName !== 'string' || event.toolName.trim().length === 0) {
      unclassified.push({
        sequence: event.sequence,
        toolName: '',
        rawInput: event.target,
        reason: 'Missing or empty toolName.',
      });
      continue;
    }

    if (isNonQualifyingTool(event.toolName)) {
      unclassified.push({
        sequence: event.sequence,
        toolName: event.toolName,
        rawInput: event.target,
        reason: `Tool '${event.toolName}' is an excluded non-qualifying execution tool.`,
      });
      continue;
    }

    if (!VALID_DISCOVERY_CATEGORIES.has(event.category)) {
      unclassified.push({
        sequence: event.sequence,
        toolName: event.toolName,
        rawInput: event.target,
        reason: `Category '${event.category}' is not a valid qualifying discovery category.`,
      });
      continue;
    }

    // Check exact type-aware context exemption
    if (isExemptFromDiscovery(event, input.suppliedContext)) {
      suppliedHits.push(event);
    } else {
      qualifyingEvents.push(event);
    }
  }

  // Sort unclassified events deterministically by sequence index
  unclassified.sort((a, b) => a.sequence - b.sequence);

  const report: DiscoveryEvaluationReport = {
    taskId: input.taskId,
    discovery_actions: qualifyingEvents.length,
    qualifyingEvents,
    suppliedHits,
    unclassified,
    summary: {
      totalEventsEvaluated: qualifyingEvents.length + suppliedHits.length + unclassified.length,
      qualifyingCount: qualifyingEvents.length,
      suppliedHitCount: suppliedHits.length,
      unclassifiedCount: unclassified.length,
    },
  };

  return deepFreeze(report);
}

/**
 * Default implementation of DiscoveryEvaluator.
 */
export class DefaultDiscoveryEvaluator implements DiscoveryEvaluator {
  evaluate(input: DiscoveryEvaluationInput): Readonly<DiscoveryEvaluationReport> {
    return evaluateDiscovery(input);
  }
}

export const DefaultDiscoveryMeasurementEvaluator = DefaultDiscoveryEvaluator;
export const evaluateDiscoveryMeasurement = evaluateDiscovery;
