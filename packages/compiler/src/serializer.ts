import type { CompiledContext } from './types.js';

/**
 * Escapes XML-sensitive characters for safe inclusion in formatted context.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Pure, deterministic serializer that converts a CompiledContext object into
 * structured XML formatted markdown suitable for injection into an agent's prompt.
 */
export class ContextSerializer {
  public static serialize(context: CompiledContext): string {
    const lines: string[] = [];

    lines.push('<orchestrate_context>');
    lines.push('  <evidence_hierarchy_rule>');
    lines.push('    Precedence: CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS');
    lines.push(
      '    If current repository code conflicts with a recorded Brain fact or agent claim, current repository code is authoritative.'
    );
    lines.push('  </evidence_hierarchy_rule>');

    // ------------------------------------------------------------------------
    // Architectural Decisions
    // ------------------------------------------------------------------------
    if (context.decisions.length > 0) {
      lines.push('  <architectural_decisions>');
      for (const d of context.decisions) {
        const supersedesAttr = d.supersedes ? ` supersedes="${escapeXml(d.supersedes)}"` : '';
        lines.push(`    <decision id="${escapeXml(d.id)}"${supersedesAttr}>`);
        lines.push(`      <statement>${escapeXml(d.statement)}</statement>`);
        lines.push(`      <rationale>${escapeXml(d.rationale)}</rationale>`);
        lines.push('    </decision>');
      }
      if (context.metadata.truncatedDecisions) {
        lines.push(
          '    <truncation_notice>Additional active decisions were omitted due to budget limits.</truncation_notice>'
        );
      }
      lines.push('  </architectural_decisions>');
    }

    // ------------------------------------------------------------------------
    // Verified Facts
    // ------------------------------------------------------------------------
    if (context.facts.length > 0) {
      lines.push('  <verified_facts>');
      for (const f of context.facts) {
        lines.push(
          `    <fact key="${escapeXml(f.key)}" provenance="${escapeXml(f.provenance)}">${escapeXml(
            f.value
          )}</fact>`
        );
      }
      if (context.metadata.truncatedFacts) {
        lines.push(
          '    <truncation_notice>Additional verified facts were omitted due to budget limits.</truncation_notice>'
        );
      }
      lines.push('  </verified_facts>');
    }

    // ------------------------------------------------------------------------
    // Upstream Work
    // ------------------------------------------------------------------------
    if (context.upstreamWork) {
      const up = context.upstreamWork;
      const titleAttr = up.title ? ` title="${escapeXml(up.title)}"` : '';
      lines.push(
        `  <upstream_work task_id="${escapeXml(up.taskId)}" trust_state="${escapeXml(
          up.trustState
        )}" attempt="${up.attemptNumber}"${titleAttr}>`
      );

      // Files affected
      if (up.filesAffected.length > 0) {
        lines.push('    <files_affected>');
        for (const file of up.filesAffected) {
          lines.push(`      <file>${escapeXml(file)}</file>`);
        }
        lines.push('    </files_affected>');
      }

      // Verification checks (Level 2: VERIFICATION EVIDENCE)
      if (up.verificationChecks.length > 0) {
        lines.push('    <verification_checks>');
        for (const c of up.verificationChecks) {
          const status = c.passed ? 'PASSED' : 'FAILED';
          const exitAttr = c.exitCode !== null ? ` exit_code="${c.exitCode}"` : '';
          lines.push(
            `      <check id="${escapeXml(c.checkId)}" status="${status}" duration_ms="${
              c.durationMs
            }"${exitAttr}>`
          );
          lines.push(`        <name>${escapeXml(c.name)}</name>`);
          lines.push(`        <command>${escapeXml(c.command)}</command>`);
          if (c.stderrSnippet) {
            lines.push(`        <stderr_snippet>${escapeXml(c.stderrSnippet)}</stderr_snippet>`);
          }
          lines.push('      </check>');
        }
        lines.push('    </verification_checks>');
      }

      // Quarantined Agent Notes (Level 4: AGENT CLAIMS)
      if (up.unverifiedAgentNotes) {
        const notes = up.unverifiedAgentNotes;
        lines.push('    <unverified_agent_notes>');
        lines.push(
          '      <warning>The following notes were reported by an upstream agent and are UNVERIFIED CLAIMS.</warning>'
        );
        if (notes.summary) {
          lines.push(`      <summary>${escapeXml(notes.summary)}</summary>`);
        }
        if (notes.changes) {
          lines.push(`      <changes>${escapeXml(notes.changes)}</changes>`);
        }
        if (notes.limitations && notes.limitations.length > 0) {
          lines.push('      <limitations>');
          for (const lim of notes.limitations) {
            lines.push(`        <item>${escapeXml(lim)}</item>`);
          }
          lines.push('      </limitations>');
        }
        if (notes.assumptions && notes.assumptions.length > 0) {
          lines.push('      <assumptions>');
          for (const asm of notes.assumptions) {
            lines.push(`        <item>${escapeXml(asm)}</item>`);
          }
          lines.push('      </assumptions>');
        }
        lines.push('    </unverified_agent_notes>');
      }

      lines.push('  </upstream_work>');
    }

    // ------------------------------------------------------------------------
    // Git State (Level 1: CODE)
    // ------------------------------------------------------------------------
    if (context.gitState) {
      const git = context.gitState;
      const branchAttr = git.branch ? ` branch="${escapeXml(git.branch)}"` : '';
      lines.push(`  <git_state${branchAttr}>`);

      if (git.headCommit) {
        lines.push(
          `    <head_commit hash="${escapeXml(git.headCommit.hash)}" author="${escapeXml(
            git.headCommit.author
          )}">${escapeXml(git.headCommit.subject)}</head_commit>`
        );
      }

      if (git.stagedFiles.length > 0) {
        lines.push('    <staged_files>');
        for (const f of git.stagedFiles) {
          lines.push(`      <file>${escapeXml(f)}</file>`);
        }
        lines.push('    </staged_files>');
      }

      if (git.unstagedFiles.length > 0) {
        lines.push('    <unstaged_files>');
        for (const f of git.unstagedFiles) {
          lines.push(`      <file>${escapeXml(f)}</file>`);
        }
        lines.push('    </unstaged_files>');
      }

      if (git.untrackedFiles.length > 0) {
        lines.push('    <untracked_files>');
        for (const f of git.untrackedFiles) {
          lines.push(`      <file>${escapeXml(f)}</file>`);
        }
        lines.push('    </untracked_files>');
      }

      if (git.diff) {
        const truncAttr = git.diffTruncated ? ' truncated="true"' : '';
        lines.push(`    <diff${truncAttr}>`);
        lines.push(escapeXml(git.diff));
        lines.push('    </diff>');
      }

      lines.push('  </git_state>');
    }

    lines.push('</orchestrate_context>');

    return lines.join('\n');
  }
}
