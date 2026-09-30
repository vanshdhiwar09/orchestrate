import type {
  Decision,
  ProjectFact,
} from '@orchestrate/brain';
import { sanitizeText } from './sanitize.js';
import {
  type CompilationSnapshot,
  type CompiledCheckEvidence,
  type CompiledContext,
  type CompiledContextMetadata,
  type CompiledDecision,
  type CompiledFact,
  type CompiledGitState,
  type CompiledUpstreamWork,
  type CompilerConfig,
  DEFAULT_COMPILER_CONFIG,
  type QuarantinedAgentClaims,
} from './types.js';

/**
 * Filter diff patches that match any excluded patterns (e.g. lockfiles).
 */
function filterDiff(diff: string, excludePatterns: string[]): string {
  if (!diff.trim() || excludePatterns.length === 0) {
    return diff;
  }

  // Split diff into per-file chunks starting with "diff --git "
  const chunks = diff.split(/(?=diff --git )/);
  const keptChunks = chunks.filter((chunk) => {
    return !excludePatterns.some((pattern) => chunk.includes(pattern));
  });

  return keptChunks.join('');
}

/**
 * Pure, deterministic Context Compiler Engine.
 *
 * Enforces:
 * 1. Strict trust boundaries (Hierarchy: Code > Verification > Brain > Claims)
 * 2. Deterministic sorting and stable tie-breaking
 * 3. Strict budgeting on decisions, facts, checks, diff, and stderr
 * 4. Automatic secret sanitization
 * 5. Quarantining of untrusted agent claims
 */
export class ContextCompilerCore {
  /**
   * Compiles a project snapshot into a compact, deterministic, bounded context.
   */
  public static compile(
    snapshot: CompilationSnapshot,
    configOverride?: Partial<CompilerConfig>
  ): CompiledContext {
    const config: CompilerConfig = {
      ...DEFAULT_COMPILER_CONFIG,
      ...(snapshot.request.config || {}),
      ...(configOverride || {}),
    };

    let totalRedactions = 0;

    const sanitize = (text: string): string => {
      const res = sanitizeText(text);
      totalRedactions += res.redactionCount;
      return res.text;
    };

    // ------------------------------------------------------------------------
    // 1. Decisions (Level 3: PROJECT BRAIN)
    // ------------------------------------------------------------------------
    const targetId = snapshot.request.targetTaskId;
    const upstreamId = snapshot.request.upstreamTaskId;

    const activeDecisions = snapshot.activeDecisions
      .filter((d) => {
        if (d.status !== 'ACTIVE') {
          return false;
        }
        // Project-wide decision (no taskId)
        if (!d.taskId) {
          return true;
        }
        // Target-task decision
        if (d.taskId === targetId) {
          return true;
        }
        // Upstream-task decision
        if (upstreamId && d.taskId === upstreamId) {
          return true;
        }
        // Exclude unrelated task-scoped decisions
        return false;
      })
      .sort((a, b) => {
        const timeDiff = a.createdAt.localeCompare(b.createdAt);
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });

    const totalDecisionsCount = activeDecisions.length;
    const compiledDecisions: CompiledDecision[] = [];
    let decisionsChars = 0;
    let truncatedDecisions = false;

    for (const d of activeDecisions) {
      if (compiledDecisions.length >= config.maxDecisions) {
        truncatedDecisions = true;
        break;
      }

      const item: CompiledDecision = {
        id: d.id,
        statement: sanitize(d.statement),
        rationale: sanitize(d.rationale),
        status: d.status,
        ...(d.supersedes ? { supersedes: d.supersedes } : {}),
      };

      const itemLength = item.statement.length + item.rationale.length;
      if (decisionsChars + itemLength > config.maxDecisionsChars && compiledDecisions.length > 0) {
        truncatedDecisions = true;
        break;
      }

      decisionsChars += itemLength;
      compiledDecisions.push(item);
    }

    if (totalDecisionsCount > compiledDecisions.length) {
      truncatedDecisions = true;
    }

    // ------------------------------------------------------------------------
    // 2. Facts (Level 3: PROJECT BRAIN)
    // ------------------------------------------------------------------------
    // Only VERIFIED facts are compiled.
    let candidateFacts = snapshot.projectFacts.filter((f) => f.status === 'VERIFIED');

    if (snapshot.request.tags && snapshot.request.tags.length > 0) {
      const tags = snapshot.request.tags.map((t) => t.toLowerCase());
      candidateFacts = candidateFacts.filter((f) => {
        const key = f.key.toLowerCase();
        // Admit global facts using global. or global:
        if (key.startsWith('global.') || key.startsWith('global:')) {
          return true;
        }
        // Admit tagged facts only when fact key starts with ${tag}. or ${tag}:
        return tags.some((tag) => key.startsWith(`${tag}.`) || key.startsWith(`${tag}:`));
      });
    } else {
      // If request.tags is absent or empty:
      // DO NOT broadcast all verified facts.
      // Admit only facts whose keys start with global. or global:
      candidateFacts = candidateFacts.filter((f) => {
        const key = f.key.toLowerCase();
        return key.startsWith('global.') || key.startsWith('global:');
      });
    }

    candidateFacts.sort((a, b) => {
      const keyDiff = a.key.localeCompare(b.key);
      if (keyDiff !== 0) return keyDiff;
      return a.recordedAt.localeCompare(b.recordedAt);
    });

    const totalFactsCount = candidateFacts.length;
    const compiledFacts: CompiledFact[] = [];
    let factsChars = 0;
    let truncatedFacts = false;

    for (const f of candidateFacts) {
      if (compiledFacts.length >= config.maxFacts) {
        truncatedFacts = true;
        break;
      }

      const item: CompiledFact = {
        key: sanitize(f.key),
        value: sanitize(f.value),
        provenance: f.provenance,
        status: f.status,
      };

      const itemLength = item.key.length + item.value.length;
      if (factsChars + itemLength > config.maxFactsChars && compiledFacts.length > 0) {
        truncatedFacts = true;
        break;
      }

      factsChars += itemLength;
      compiledFacts.push(item);
    }

    if (totalFactsCount > compiledFacts.length) {
      truncatedFacts = true;
    }

    // ------------------------------------------------------------------------
    // 3. Upstream Work (Level 2: VERIFICATION EVIDENCE & Level 4: AGENT CLAIMS)
    // ------------------------------------------------------------------------
    let upstreamWork: CompiledUpstreamWork | undefined;

    if (snapshot.upstreamTask || snapshot.request.upstreamTaskId) {
      const taskId = snapshot.upstreamTask?.id || snapshot.request.upstreamTaskId!;
      const trustState = snapshot.upstreamTrustState || 'UNVERIFIED';

      // Pick latest attempt
      const attempts = [...snapshot.upstreamAttempts].sort(
        (a, b) => b.attemptNumber - a.attemptNumber
      );
      const latestAttempt = attempts[0];

      const checksEvidence: CompiledCheckEvidence[] = [];
      let unverifiedNotes: QuarantinedAgentClaims | undefined;
      const filesAffectedSet = new Set<string>();

      if (latestAttempt) {
        const verification = latestAttempt.verification || latestAttempt.verificationRecord;
        if (verification && verification.result && Array.isArray(verification.result.checks)) {
          const checks = [...verification.result.checks].sort((a, b) =>
            a.checkId.localeCompare(b.checkId)
          );

          let verificationChars = 0;
          for (const c of checks) {
            if (checksEvidence.length >= config.maxVerificationChecks) {
              break;
            }

            let stderrSnippet: string | undefined;
            if (!c.passed && c.stderr) {
              const lines = c.stderr.split('\n').slice(-config.maxStderrLines);
              let trimmedStderr = lines.join('\n');
              if (trimmedStderr.length > config.maxStderrChars) {
                trimmedStderr = trimmedStderr.slice(-config.maxStderrChars);
              }
              stderrSnippet = sanitize(trimmedStderr);
            }

            const item: CompiledCheckEvidence = {
              checkId: c.checkId,
              name: sanitize(c.name),
              command: sanitize(c.command),
              passed: c.passed,
              exitCode: c.exitCode,
              durationMs: c.durationMs,
              ...(stderrSnippet ? { stderrSnippet } : {}),
            };

            const itemLength = item.name.length + item.command.length + (stderrSnippet?.length || 0);
            if (
              verificationChars + itemLength > config.maxVerificationChars &&
              checksEvidence.length > 0
            ) {
              break;
            }

            verificationChars += itemLength;
            checksEvidence.push(item);
          }
        }

        // Handoff (Quarantined Agent Claims)
        if (latestAttempt.handoff) {
          const handoff = latestAttempt.handoff;
          if (Array.isArray(handoff.filesAffected)) {
            for (const f of handoff.filesAffected) {
              filesAffectedSet.add(f);
            }
          }

          unverifiedNotes = {
            ...(handoff.summary ? { summary: sanitize(handoff.summary) } : {}),
            ...(handoff.changes ? { changes: sanitize(handoff.changes) } : {}),
            ...(Array.isArray(handoff.limitations) && handoff.limitations.length > 0
              ? { limitations: handoff.limitations.map((l) => sanitize(l)) }
              : {}),
            ...(Array.isArray(handoff.assumptions) && handoff.assumptions.length > 0
              ? { assumptions: handoff.assumptions.map((a) => sanitize(a)) }
              : {}),
          };
        }
      }

      const filesAffected = Array.from(filesAffectedSet).sort((a, b) => a.localeCompare(b));

      upstreamWork = {
        taskId,
        ...(snapshot.upstreamTask?.title ? { title: sanitize(snapshot.upstreamTask.title) } : {}),
        trustState,
        attemptNumber: latestAttempt?.attemptNumber || 0,
        filesAffected,
        verificationChecks: checksEvidence,
        ...(unverifiedNotes ? { unverifiedAgentNotes: unverifiedNotes } : {}),
      };
    }

    // ------------------------------------------------------------------------
    // 4. Git State (Level 1: CODE)
    // ------------------------------------------------------------------------
    let gitState: CompiledGitState | undefined;

    if (snapshot.git) {
      const git = snapshot.git;
      const status = git.status;

      const stagedFiles = (status.staged || [])
        .map((s) => s.path)
        .sort((a, b) => a.localeCompare(b));

      const unstagedFiles = (status.unstaged || [])
        .map((u) => u.path)
        .sort((a, b) => a.localeCompare(b));

      const untrackedFiles = config.includeUntrackedFiles
        ? (status.untracked || []).slice().sort((a, b) => a.localeCompare(b))
        : [];

      let headCommit: CompiledGitState['headCommit'] = null;
      if (git.headCommit) {
        headCommit = {
          hash: git.headCommit.hash,
          subject: sanitize(git.headCommit.subject),
          author: sanitize(git.headCommit.author),
        };
      }

      let diff: string | undefined;
      let diffTruncated = false;

      if (config.includeGitDiff && git.diff) {
        const filtered = filterDiff(git.diff, config.excludePatterns);
        const lines = filtered.split('\n');

        if (lines.length > config.maxDiffLines) {
          diffTruncated = true;
          const cappedLines = lines.slice(0, config.maxDiffLines);
          diff = cappedLines.join('\n');
        } else {
          diff = filtered;
        }

        if (diff.length > config.maxDiffChars) {
          diffTruncated = true;
          diff = diff.slice(0, config.maxDiffChars);
        }

        if (diffTruncated) {
          diff = `${diff}\n[...diff truncated...]`;
        }

        diff = sanitize(diff);
      }

      gitState = {
        branch: status.branch,
        headCommit,
        stagedFiles,
        unstagedFiles,
        untrackedFiles,
        ...(diff ? { diff, diffTruncated } : {}),
      };
    }

    // ------------------------------------------------------------------------
    // 5. Metadata
    // ------------------------------------------------------------------------
    const metadata: CompiledContextMetadata = {
      projectId: snapshot.request.projectId,
      targetTaskId: snapshot.request.targetTaskId,
      ...(snapshot.request.upstreamTaskId
        ? { upstreamTaskId: snapshot.request.upstreamTaskId }
        : {}),
      totalDecisionsCount,
      totalFactsCount,
      truncatedDecisions,
      truncatedFacts,
      redactionCount: totalRedactions,
    };

    return {
      metadata,
      decisions: compiledDecisions,
      facts: compiledFacts,
      ...(upstreamWork ? { upstreamWork } : {}),
      ...(gitState ? { gitState } : {}),
    };
  }
}
