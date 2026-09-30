import { describe, expect, it } from 'vitest';
import { ContextCompilerCore } from '../src/core.js';
import { ContextSerializer } from '../src/serializer.js';
import { createMockSnapshot } from './fixtures.js';

describe('ContextSerializer', () => {
  it('serializes compiled context into clean XML with evidence hierarchy banner', () => {
    const snapshot = createMockSnapshot();
    const compiled = ContextCompilerCore.compile(snapshot);
    const serialized = ContextSerializer.serialize(compiled);

    expect(serialized).toContain('<orchestrate_context>');
    expect(serialized).toContain('</orchestrate_context>');
    expect(serialized).toContain('<evidence_hierarchy_rule>');
    expect(serialized).toContain('Precedence: CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS');
    expect(serialized).toContain(
      'If current repository code conflicts with a recorded Brain fact or agent claim, current repository code is authoritative.'
    );
    expect(serialized).toContain('<architectural_decisions>');
    expect(serialized).toContain('<verified_facts>');
    expect(serialized).toContain('<upstream_work');
    expect(serialized).toContain('<verification_checks>');
    expect(serialized).toContain('<unverified_agent_notes>');
    expect(serialized).toContain('<git_state');
  });

  it('escapes XML special characters in values', () => {
    const snapshot = createMockSnapshot({
      activeDecisions: [
        {
          id: 'dec-xml',
          projectId: 'proj-1',
          statement: 'Condition: a < 10 && b > 20 "quoted"',
          rationale: "Escaping & checking 'single'",
          status: 'ACTIVE',
          createdAt: '2026-09-30T09:00:00.000Z',
        },
      ],
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    const serialized = ContextSerializer.serialize(compiled);

    expect(serialized).toContain('&lt; 10 &amp;&amp; b &gt; 20 &quot;quoted&quot;');
    expect(serialized).toContain('&amp; checking &apos;single&apos;');
  });

  it('clearly marks unverified agent notes with a warning', () => {
    const snapshot = createMockSnapshot();
    const compiled = ContextCompilerCore.compile(snapshot);
    const serialized = ContextSerializer.serialize(compiled);

    expect(serialized).toContain('<warning>The following notes were reported by an upstream agent and are UNVERIFIED CLAIMS.</warning>');
    expect(serialized).toContain('<summary>Implemented basic auth provider</summary>');
  });

  it('produces byte-for-byte identical serialized text across runs with no timestamps', () => {
    const snapshot = createMockSnapshot();
    const compiled1 = ContextCompilerCore.compile(snapshot);
    const compiled2 = ContextCompilerCore.compile(snapshot);

    const s1 = ContextSerializer.serialize(compiled1);
    const s2 = ContextSerializer.serialize(compiled2);

    expect(s1).toBe(s2);
    // Ensure no dynamic timestamps like Date.now() or new Date().toISOString() were introduced
    expect(s1).not.toMatch(/compiled_at/i);
    expect(s1).not.toMatch(/generated_at/i);
  });

  it('renders truncation notices when sections were truncated', () => {
    const snapshot = createMockSnapshot();
    const compiled = ContextCompilerCore.compile(snapshot, {
      maxDecisions: 1,
      maxFacts: 1,
    });
    const serialized = ContextSerializer.serialize(compiled);

    expect(serialized).toContain('Additional active decisions were omitted due to budget limits.');
    expect(serialized).toContain('Additional verified facts were omitted due to budget limits.');
  });
});
