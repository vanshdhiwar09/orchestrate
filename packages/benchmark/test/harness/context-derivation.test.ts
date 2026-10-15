import { describe, expect, it } from 'vitest';
import {
  deriveSuppliedContext,
  validateSuppliedContext,
  resolveSuppliedContextForArm,
  validateXmlWellFormedness,
} from '../../src/harness/context-derivation.js';
import { DiscoveryEvaluationError } from '../../src/discovery/types.js';
import type { TreatmentContextEnvelope } from '../../src/harness/types.js';

describe('Context Derivation and Validation (M7 Fix 1)', () => {
  const createEnvelope = (
    armId: 'ARM_B_UNVERIFIED_HANDOFF' | 'ARM_C_ORCHESTRATE',
    rawPayload: string,
    formattedBlock?: string
  ): TreatmentContextEnvelope => ({
    armId,
    rawPayload,
    formattedBlock: formattedBlock ?? `<block>\n${rawPayload}\n</block>`,
    treatmentPayloadHash: 'dummy-hash',
  });

  describe('deriveSuppliedContext', () => {
    describe('Arm A (Baseline)', () => {
      it('derives no references (empty array) when envelope is null', () => {
        const refs = deriveSuppliedContext('ARM_A_BASELINE', null);
        expect(refs).toEqual([]);
      });

      it('throws DiscoveryEvaluationError if envelope is not null for Arm A', () => {
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', 'some content');
        expect(() =>
          deriveSuppliedContext('ARM_A_BASELINE', envelope)
        ).toThrow(DiscoveryEvaluationError);
      });
    });

    describe('Arm B (Unverified Handoff)', () => {
      it('fails clearly on missing or empty envelope', () => {
        expect(() => deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', null)).toThrow(
          DiscoveryEvaluationError
        );
        expect(() =>
          deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', createEnvelope('ARM_B_UNVERIFIED_HANDOFF', ''))
        ).toThrow(DiscoveryEvaluationError);
        expect(() =>
          deriveSuppliedContext(
            'ARM_B_UNVERIFIED_HANDOFF',
            createEnvelope('ARM_B_UNVERIFIED_HANDOFF', '   \n  ')
          )
        ).toThrow(DiscoveryEvaluationError);
      });

      it('derives files, symbols, and directories from structured JSON handoff', () => {
        const jsonPayload = JSON.stringify({
          summary: 'Created auth middleware',
          filesAffected: ['src/middleware/auth.ts', 'src/types.ts'],
          symbols: ['authenticateToken', 'AuthRequest'],
          directories: ['src/middleware'],
          decisionsCreated: ['dec-001'],
          facts: ['fact-jwt'],
        });
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', jsonPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        expect(refs).toEqual([
          { type: 'FILE', value: 'src/middleware/auth.ts' },
          { type: 'FILE', value: 'src/types.ts' },
          { type: 'SYMBOL', value: 'authenticateToken' },
          { type: 'SYMBOL', value: 'AuthRequest' },
          { type: 'DIRECTORY', value: 'src/middleware/' },
          { type: 'DECISION', value: 'dec-001' },
          { type: 'FACT', value: 'fact-jwt' },
        ]);
      });

      it('derives from JSON wrapped in markdown code fence', () => {
        const markdownPayload =
          'Here is the handoff:\n```json\n{\n  "filesAffected": ["src/jwt.ts"]\n}\n```';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', markdownPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        expect(refs).toEqual([{ type: 'FILE', value: 'src/jwt.ts' }]);
      });

      it('fails clearly on malformed JSON payload in Arm B', () => {
        const malformedJson = '{\n  "filesAffected": ["src/jwt.ts",\n';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', malformedJson);
        expect(() =>
          deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope)
        ).toThrow(DiscoveryEvaluationError);
      });

      it('derives from XML tags in Arm B handoff', () => {
        const xmlPayload =
          '<files_affected><file>src/service.ts</file></files_affected><symbol>runService</symbol>';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', xmlPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        expect(refs).toEqual([
          { type: 'FILE', value: 'src/service.ts' },
          { type: 'SYMBOL', value: 'runService' },
        ]);
      });

      it('derives explicit relative file paths from plain text handoff', () => {
        const textPayload =
          'Task A completed JWT middleware and created src/jwt.ts and updated src/routes/auth.ts.';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', textPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        expect(refs).toEqual([
          { type: 'FILE', value: 'src/jwt.ts' },
          { type: 'FILE', value: 'src/routes/auth.ts' },
        ]);
      });

      it('extracts consecutive space-separated, quoted, and comma-separated relative file paths exactly once', () => {
        const textPayload =
          'created src/a.ts src/b.ts and modified "src/c.ts" \'src/d.ts\' (src/e.ts, src/f.ts) and src/a.ts';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', textPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        expect(refs).toEqual([
          { type: 'FILE', value: 'src/a.ts' },
          { type: 'FILE', value: 'src/b.ts' },
          { type: 'FILE', value: 'src/c.ts' },
          { type: 'FILE', value: 'src/d.ts' },
          { type: 'FILE', value: 'src/e.ts' },
          { type: 'FILE', value: 'src/f.ts' },
        ]);
      });

      it('does not match invalid boundaries, operator divisions, URLs, or extensionless paths', () => {
        const textPayload =
          'Values: total / count.val, pkg/noext, standalone.ts, https://github.com/repo/file.ts, user@example.com/dir/file.ts';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', textPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        expect(refs).toEqual([]);
      });

      it('does NOT infer symbols from plain text handoff (symbols require explicit structuring)', () => {
        const textPayload =
          'Task A created verifyToken function in src/jwt.ts with secretKey.';
        const envelope = createEnvelope('ARM_B_UNVERIFIED_HANDOFF', textPayload);
        const refs = deriveSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope);

        // Only the file is extracted, words like verifyToken or secretKey are not assumed to be symbols
        expect(refs).toEqual([{ type: 'FILE', value: 'src/jwt.ts' }]);
        expect(refs.some((r) => r.type === 'SYMBOL')).toBe(false);
      });
    });

    describe('Arm C (Orchestrate Compiled Context)', () => {
      it('fails clearly on missing or empty envelope', () => {
        expect(() => deriveSuppliedContext('ARM_C_ORCHESTRATE', null)).toThrow(
          DiscoveryEvaluationError
        );
        expect(() =>
          deriveSuppliedContext('ARM_C_ORCHESTRATE', createEnvelope('ARM_C_ORCHESTRATE', ''))
        ).toThrow(DiscoveryEvaluationError);
      });

      it('derives files, symbols, git state, decisions, and facts from serialized context XML', () => {
        const compiledXml = `
<orchestrate_context>
  <architectural_decisions>
    <decision id="dec-jwt">
      <statement>Use RS256 for tokens</statement>
    </decision>
  </architectural_decisions>
  <verified_facts>
    <fact key="auth.port" provenance="CODE">8080</fact>
  </verified_facts>
  <upstream_work task_id="task-a" trust_state="VERIFIED" attempt="1">
    <files_affected>
      <file>src/jwt.ts</file>
      <file path="src/keys.ts" />
    </files_affected>
  </upstream_work>
  <git_state branch="main">
    <head_commit hash="abcdef1234567890" author="tester">Initial commit</head_commit>
    <staged_files>
      <file>src/staged.ts</file>
    </staged_files>
    <diff>
      + new line
    </diff>
  </git_state>
  <symbols>
    <symbol>verifyToken</symbol>
    <symbol name="SignOptions" />
  </symbols>
  <directories>
    <directory>src/utils</directory>
  </directories>
</orchestrate_context>
        `.trim();

        const envelope: TreatmentContextEnvelope = {
          armId: 'ARM_C_ORCHESTRATE',
          rawPayload: compiledXml,
          formattedBlock: compiledXml,
          treatmentPayloadHash: 'hash-c',
        };

        const refs = deriveSuppliedContext('ARM_C_ORCHESTRATE', envelope);

        expect(refs).toContainEqual({ type: 'FILE', value: 'src/jwt.ts' });
        expect(refs).toContainEqual({ type: 'FILE', value: 'src/keys.ts' });
        expect(refs).toContainEqual({ type: 'FILE', value: 'src/staged.ts' });
        expect(refs).toContainEqual({ type: 'SYMBOL', value: 'verifyToken' });
        expect(refs).toContainEqual({ type: 'SYMBOL', value: 'SignOptions' });
        expect(refs).toContainEqual({ type: 'DIRECTORY', value: 'src/utils/' });
        expect(refs).toContainEqual({ type: 'DECISION', value: 'dec-jwt' });
        expect(refs).toContainEqual({ type: 'FACT', value: 'auth.port' });
        expect(refs).toContainEqual({ type: 'GIT_STATE', value: 'status' });
        expect(refs).toContainEqual({ type: 'GIT_HISTORY', value: 'abcdef1234567890' });
        expect(refs).toContainEqual({ type: 'GIT_HISTORY', value: 'HEAD' });
        expect(refs).toContainEqual({ type: 'GIT_DIFF', value: '' });
      });

      it('normalizes file paths and directory paths and unescapes XML entities', () => {
        const xml = `
<orchestrate_context>
  <files_affected>
    <file>src\\windows\\path.ts</file>
    <file>./relative/path.ts/</file>
    <file>&quot;quoted/file.ts&quot;</file>
    <file>path&amp;name.ts</file>
  </files_affected>
</orchestrate_context>
        `.trim();

        const envelope = createEnvelope('ARM_C_ORCHESTRATE', xml);
        const refs = deriveSuppliedContext('ARM_C_ORCHESTRATE', envelope);

        expect(refs).toContainEqual({ type: 'FILE', value: 'src/windows/path.ts' });
        expect(refs).toContainEqual({ type: 'FILE', value: 'relative/path.ts' });
        expect(refs).toContainEqual({ type: 'FILE', value: 'quoted/file.ts' });
        expect(refs).toContainEqual({ type: 'FILE', value: 'path&name.ts' });
      });

      it('fails clearly on malformed XML with unclosed tags', () => {
        const badXml = '<orchestrate_context><files_affected><file>src/jwt.ts</orchestrate_context>';
        const envelope = createEnvelope('ARM_C_ORCHESTRATE', badXml);
        expect(() => deriveSuppliedContext('ARM_C_ORCHESTRATE', envelope)).toThrow(
          DiscoveryEvaluationError
        );
      });

      it('fails clearly on mismatched XML closing tags', () => {
        const badXml = '<orchestrate_context><file>src/jwt.ts</wrong></orchestrate_context>';
        const envelope = createEnvelope('ARM_C_ORCHESTRATE', badXml);
        expect(() => deriveSuppliedContext('ARM_C_ORCHESTRATE', envelope)).toThrow(
          DiscoveryEvaluationError
        );
      });

      it('fails clearly on unclosed bracket', () => {
        const badXml = '<orchestrate_context><file src/jwt.ts';
        const envelope = createEnvelope('ARM_C_ORCHESTRATE', badXml);
        expect(() => deriveSuppliedContext('ARM_C_ORCHESTRATE', envelope)).toThrow(
          DiscoveryEvaluationError
        );
      });
    });
  });

  describe('validateSuppliedContext & resolveSuppliedContextForArm', () => {
    it('Arm A rejects explicit references when non-empty', () => {
      expect(() =>
        validateSuppliedContext('ARM_A_BASELINE', null, [
          { type: 'FILE', value: 'src/auth.ts' },
        ])
      ).toThrow(DiscoveryEvaluationError);
    });

    it('Arm A accepts empty [] explicit suppliedContext', () => {
      const res = validateSuppliedContext('ARM_A_BASELINE', null, []);
      expect(res).toEqual([]);
    });

    it('rejects explicit reference claiming a FILE absent from Arm B envelope', () => {
      const envelope = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        JSON.stringify({ filesAffected: ['src/jwt.ts'] })
      );
      expect(() =>
        validateSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope, [
          { type: 'FILE', value: 'src/jwt.ts' },
          { type: 'FILE', value: 'src/absent.ts' },
        ])
      ).toThrow(DiscoveryEvaluationError);
    });

    it('accepts explicit references when all are present in Arm B envelope', () => {
      const envelope = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        JSON.stringify({ filesAffected: ['src/jwt.ts'] })
      );
      const res = validateSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope, [
        { type: 'FILE', value: 'src/jwt.ts' },
      ]);
      expect(res).toEqual([{ type: 'FILE', value: 'src/jwt.ts' }]);
    });

    it('rejects explicit reference claiming a FILE absent from Arm C envelope', () => {
      const envelope = createEnvelope(
        'ARM_C_ORCHESTRATE',
        '<orchestrate_context><file>src/jwt.ts</file></orchestrate_context>'
      );
      expect(() =>
        validateSuppliedContext('ARM_C_ORCHESTRATE', envelope, [
          { type: 'FILE', value: 'src/other.ts' },
        ])
      ).toThrow(DiscoveryEvaluationError);
    });

    it('rejects explicit symbol when handoff is plain text (symbols cannot be inferred from plain text)', () => {
      const envelope = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        'Task completed and exported verifyToken in src/jwt.ts.'
      );
      expect(() =>
        validateSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope, [
          { type: 'SYMBOL', value: 'verifyToken' },
        ])
      ).toThrow(DiscoveryEvaluationError);
    });

    it('accepts explicit symbol when structured in JSON or XML handoff', () => {
      const envelopeJson = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        JSON.stringify({ symbols: ['verifyToken'] })
      );
      const resJson = validateSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelopeJson, [
        { type: 'SYMBOL', value: 'verifyToken' },
      ]);
      expect(resJson).toEqual([{ type: 'SYMBOL', value: 'verifyToken' }]);

      const envelopeXml = createEnvelope(
        'ARM_C_ORCHESTRATE',
        '<orchestrate_context><symbols><symbol>verifyToken</symbol></symbols></orchestrate_context>'
      );
      const resXml = validateSuppliedContext('ARM_C_ORCHESTRATE', envelopeXml, [
        { type: 'SYMBOL', value: 'verifyToken' },
      ]);
      expect(resXml).toEqual([{ type: 'SYMBOL', value: 'verifyToken' }]);
    });

    it('rejects explicit FILE reference when path only appears in prose summary (e.g. "We avoided modifying src/sensitive.ts")', () => {
      const envelope = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        JSON.stringify({
          summary: 'We avoided modifying src/sensitive.ts and created auth middleware',
          filesAffected: ['src/jwt.ts'],
        })
      );
      expect(() =>
        validateSuppliedContext('ARM_B_UNVERIFIED_HANDOFF', envelope, [
          { type: 'FILE', value: 'src/sensitive.ts' },
        ])
      ).toThrow(DiscoveryEvaluationError);
    });

    it('resolveSuppliedContextForArm derives automatically when explicit is undefined', () => {
      const envelope = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        JSON.stringify({ filesAffected: ['src/jwt.ts'] })
      );
      const res = resolveSuppliedContextForArm('ARM_B_UNVERIFIED_HANDOFF', envelope, undefined);
      expect(res).toEqual([{ type: 'FILE', value: 'src/jwt.ts' }]);
    });

    it('resolveSuppliedContextForArm validates explicit when provided', () => {
      const envelope = createEnvelope(
        'ARM_B_UNVERIFIED_HANDOFF',
        JSON.stringify({ filesAffected: ['src/jwt.ts'] })
      );
      const res = resolveSuppliedContextForArm('ARM_B_UNVERIFIED_HANDOFF', envelope, [
        { type: 'FILE', value: 'src/jwt.ts' },
      ]);
      expect(res).toEqual([{ type: 'FILE', value: 'src/jwt.ts' }]);
    });
  });

  describe('validateXmlWellFormedness', () => {
    it('passes on valid nested XML', () => {
      expect(() =>
        validateXmlWellFormedness(
          '<root><child id="1"><subchild>text</subchild></child><empty /></root>'
        )
      ).not.toThrow();
    });

    it('throws on mismatched tags', () => {
      expect(() =>
        validateXmlWellFormedness('<root><child></root></child>')
      ).toThrow(DiscoveryEvaluationError);
    });

    it('throws on unclosed tag', () => {
      expect(() =>
        validateXmlWellFormedness('<root><child>text</root>')
      ).toThrow(DiscoveryEvaluationError);
    });
  });
});
