import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTaskDetailHtml } from '../src/components/placeholder-page.js';
import type { DerivedTaskSummary } from '../src/components/placeholder-page.js';

class MockElement {
  public tagName: string;
  public className: string = '';
  public textContent: string = '';
  public attributes: Record<string, string> = {};
  public children: MockElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public appendChild(child: MockElement): MockElement {
    this.children.push(child);
    return child;
  }
}

describe('Modal & Execution Activity Timeline Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (global as any).document = {
      createElement: (tag: string) => new MockElement(tag),
    };
  });

  it('verifies modal tokens and CSS definitions enforce complete opacity and proper z-index layering', () => {
    const tokensCss = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8');
    const mainCss = readFileSync(resolve(__dirname, '../src/styles/main.css'), 'utf8');

    // --bg-surface must be defined as solid opaque white
    expect(tokensCss).toMatch(/--bg-surface:\s*#ffffff;/i);

    // .modal-backdrop must be fixed with z-index 1000
    expect(mainCss).toMatch(/\.modal-backdrop\s*\{[^}]*position:\s*fixed/);
    expect(mainCss).toMatch(/\.modal-backdrop\s*\{[^}]*z-index:\s*1000/);

    // .modal-dialog must be explicitly opaque white with z-index 1001
    expect(mainCss).toMatch(/\.modal-dialog\s*\{[^}]*background-color:\s*#ffffff\s*!important/i);
    expect(mainCss).toMatch(/\.modal-dialog\s*\{[^}]*z-index:\s*1001/);
    expect(mainCss).toMatch(/\.modal-dialog\s*\{[^}]*max-height:\s*90vh/);
  });

  it('verifies Create Task modal markup in placeholder-page enforces accessibility and opaque dialog structure', () => {
    const pageSource = readFileSync(resolve(__dirname, '../src/components/placeholder-page.ts'), 'utf8');

    // Dialog accessibility attributes
    expect(pageSource).toContain('id="new-task-modal-backdrop" class="modal-backdrop"');
    expect(pageSource).toContain('role="dialog"');
    expect(pageSource).toContain('aria-modal="true"');
    expect(pageSource).toContain('aria-labelledby="modal-task-title"');

    // Dialog card with modal-dialog class
    expect(pageSource).toContain('class="modal-dialog" id="new-task-modal-card"');
    expect(pageSource).toContain('id="modal-task-title"');
    expect(pageSource).toContain('id="modal-close-task-btn" class="modal-close-btn" aria-label="Close dialog"');

    // Form fields
    expect(pageSource).toContain('id="new-task-title-input"');
    expect(pageSource).toContain('id="new-task-desc-input"');
    expect(pageSource).toContain('id="new-task-acceptance-input"');
    expect(pageSource).toContain('id="modal-submit-task-btn"');
    expect(pageSource).toContain('id="modal-cancel-task-btn"');
  });

  it('buildTaskDetailHtml renders the Autonomous Agent Execution card with Nemotron model badge and timeline container', () => {
    const taskSummary: DerivedTaskSummary = {
      taskId: 'task_timeline_test',
      trustState: 'VERIFIED',
      highestAttemptNumber: 1,
      latestAttempt: {
        attemptNumber: 1,
        trustState: 'VERIFIED',
        handoff: {
          id: 'h-1',
          taskId: 'task_timeline_test',
          attemptNumber: 1,
          summary: 'Task completed and verified',
          filesModified: ['src/feature.ts'],
          decisionsCreated: [],
          status: 'COMPLETED',
          createdAt: new Date().toISOString(),
        },
        verificationRecord: {
          id: 'v-1',
          taskId: 'task_timeline_test',
          attemptNumber: 1,
          handoffId: 'h-1',
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'c1',
                name: 'TypeScript Build',
                command: 'npx',
                args: ['tsc', '-b'],
                status: 'PASSED',
                passed: true,
                exitCode: 0,
                durationMs: 450,
              },
            ],
            executedAt: new Date().toISOString(),
            totalDurationMs: 450,
          },
          recordedAt: new Date().toISOString(),
        },
        isBlocked: false,
      },
      hasPassingVerification: true,
      attempts: [],
      isBlocked: false,
      model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      provider: 'nebius',
      isRealInference: true,
    };

    const html = buildTaskDetailHtml('proj-123', taskSummary, 1);

    // Verify Autonomous Agent Execution card
    expect(html).toContain('Autonomous Agent Execution');
    expect(html).toContain('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B (Nebius)');
    expect(html).toContain('id="task-detail-run-btn"');
    expect(html).toContain('id="task-detail-run-feedback"');
    expect(html).toContain('id="task-detail-timeline-container"');
    expect(html).toContain('id="task-detail-diff-section"');
  });
});
