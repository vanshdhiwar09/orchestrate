import { escapeHtml } from '../services/engine-client.js';

/**
 * Strips heavy markdown formatting symbols to produce a clean single-line preview.
 */
export function stripMarkdownFormatting(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/^#+\s+/gm, '') // Strip headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Bold
    .replace(/\*([^*]+)\*/g, '$1') // Italic
    .replace(/`([^`]+)`/g, '$1') // Inline code
    .replace(/^\s*[-*+]\s+/gm, '') // Bullet points
    .replace(/^\s*>\s+/gm, '') // Blockquotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links
    .replace(/\s+/g, ' ') // Collapse whitespace/newlines
    .trim();
}

/**
 * Formats a clean, readable summary preview truncated to a maximum length.
 */
export function formatSummaryPreview(text: string, maxLen = 140): string {
  if (!text || typeof text !== 'string') return '';
  const clean = stripMarkdownFormatting(text);
  if (clean.length <= maxLen) return clean;
  const truncated = clean.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

/**
 * Safely parses JSON string if it begins with an object or array literal.
 */
export function tryParseJson<T = any>(val: string): T | null {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Renders a compact, line-clamped fact value suitable for table and card rows.
 * Detects structured JSON payloads (plans, reviews, configs) and renders clear previews.
 */
export function renderCompactFactValueHtml(key: string, value: string): string {
  if (!value) {
    return `<span style="color: var(--text-muted); font-size: 12px; font-style: italic;">(empty)</span>`;
  }

  const parsed = tryParseJson<any>(value);

  // 1. Structured Architectural Plan
  if (parsed && (key.includes('plan') || parsed.targetFiles || (parsed.summary && parsed.acceptanceCriteria))) {
    const summary = formatSummaryPreview(parsed.summary || '', 100);
    const filesCount = Array.isArray(parsed.targetFiles) ? parsed.targetFiles.length : 0;
    return `
      <div class="line-clamp-2" style="font-size: 12.5px; color: var(--text-primary); line-height: 1.45;">
        <span class="badge" style="font-size: 9.5px; padding: 1.5px 6px; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 4px; font-weight: 600; margin-right: 6px; vertical-align: middle;">PLAN</span>
        <span>${escapeHtml(summary || 'Plan established')}</span>
        ${filesCount > 0 ? `<span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-left: 6px;">(${filesCount} ${filesCount === 1 ? 'file' : 'files'})</span>` : ''}
      </div>
    `;
  }

  // 2. Structured Code Review
  if (parsed && (key.includes('review') || parsed.verdict || (parsed.summary && parsed.findings))) {
    const isApproved = parsed.verdict === 'APPROVED';
    const bg = isApproved ? '#dcfce7' : '#fee2e2';
    const fg = isApproved ? '#15803d' : '#b91c1c';
    const border = isApproved ? '#bbf7d0' : '#fecaca';
    const summary = formatSummaryPreview(parsed.summary || '', 100);
    return `
      <div class="line-clamp-2" style="font-size: 12.5px; color: var(--text-primary); line-height: 1.45;">
        <span class="badge" style="font-size: 9.5px; padding: 1.5px 6px; background: ${bg}; color: ${fg}; border: 1px solid ${border}; border-radius: 4px; font-weight: 600; margin-right: 6px; vertical-align: middle;">${escapeHtml(parsed.verdict || 'REVIEW')}</span>
        <span>${escapeHtml(summary || 'Review completed')}</span>
      </div>
    `;
  }

  // 3. Generic Structured JSON
  if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    return `
      <div class="line-clamp-2" style="font-size: 12px; font-family: var(--font-mono); color: var(--text-secondary); line-height: 1.4;">
        <span class="badge" style="font-size: 9.5px; padding: 1.5px 6px; background: var(--bg-surface); color: var(--text-secondary); border: 1px solid var(--border-default); border-radius: 4px; font-weight: 600; margin-right: 6px; vertical-align: middle;">JSON</span>
        <span>${escapeHtml(keys.join(', '))}</span>
      </div>
    `;
  }

  // 4. Regular Text (Cleaned & Clamped to 2 lines)
  const isLong = value.length > 90 || value.includes('\n');
  return `
    <div class="${isLong ? 'line-clamp-2' : ''}" style="font-size: 13px; font-weight: 500; color: var(--text-primary); line-height: 1.45; word-break: break-word;">
      ${escapeHtml(stripMarkdownFormatting(value))}
    </div>
  `;
}

/**
 * Renders full, readable progressive disclosure detail for a fact value.
 * Formats Plans and Reviews into structured sections and provides bounded scroll panels for JSON.
 */
export function renderDetailFactValueHtml(key: string, value: string): string {
  if (!value) {
    return `<div style="font-size: 12.5px; color: var(--text-muted); font-style: italic;">(empty value)</div>`;
  }

  const parsed = tryParseJson<any>(value);

  // 1. Structured Architectural Plan Detail
  if (parsed && (key.includes('plan') || parsed.targetFiles || (parsed.summary && parsed.acceptanceCriteria))) {
    const targetFiles = Array.isArray(parsed.targetFiles) ? parsed.targetFiles : [];
    const acceptance = Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [];
    const steps = Array.isArray(parsed.implementationSteps) ? parsed.implementationSteps : [];
    const risks = Array.isArray(parsed.risks) ? parsed.risks : [];

    return `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div style="padding: 14px; border-radius: 8px; background: var(--bg-surface); border: 1px solid var(--border-default);">
          <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">
            Plan Summary (Role: Lead Planner)
          </div>
          <div style="font-size: 13.5px; color: var(--text-primary); line-height: 1.55;">
            ${escapeHtml(parsed.summary || 'No summary recorded')}
          </div>
        </div>

        ${targetFiles.length > 0 ? `
          <div>
            <div style="font-size: 11.5px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;">
              Target Files (${targetFiles.length})
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
              ${targetFiles.map((f: string) => `<code style="font-family: var(--font-mono); font-size: 11.5px; padding: 3px 8px; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary);">${escapeHtml(f)}</code>`).join('')}
            </div>
          </div>
        ` : ''}

        ${acceptance.length > 0 ? `
          <div>
            <div style="font-size: 11.5px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;">
              Acceptance Criteria (${acceptance.length})
            </div>
            <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; display: flex; flex-direction: column; gap: 4px;">
              ${acceptance.map((c: string) => `<li>${escapeHtml(c)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${steps.length > 0 ? `
          <div>
            <div style="font-size: 11.5px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;">
              Implementation Steps (${steps.length})
            </div>
            <ol style="margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; display: flex; flex-direction: column; gap: 4px;">
              ${steps.map((s: string) => `<li>${escapeHtml(s)}</li>`).join('')}
            </ol>
          </div>
        ` : ''}

        ${risks.length > 0 ? `
          <div style="padding: 10px 12px; border-radius: 8px; background: #fffbeb; border: 1px solid #fde68a;">
            <div style="font-size: 11.5px; font-weight: 700; color: #92400e; margin-bottom: 4px;">Identified Risks</div>
            <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: #78350f; line-height: 1.45;">
              ${risks.map((r: string) => `<li>${escapeHtml(r)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <details style="margin-top: 6px;">
          <summary style="font-size: 11.5px; font-weight: 600; color: var(--brand-blue); cursor: pointer; user-select: none;">
            Inspect Raw Plan JSON Payload
          </summary>
          <pre class="bounded-scroll-panel" style="margin-top: 8px; font-family: var(--font-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>
        </details>
      </div>
    `;
  }

  // 2. Structured Code Review Detail
  if (parsed && (key.includes('review') || parsed.verdict || (parsed.summary && parsed.findings))) {
    const isApproved = parsed.verdict === 'APPROVED';
    const bg = isApproved ? '#f0fdf4' : '#fef2f2';
    const border = isApproved ? '#bbf7d0' : '#fecaca';
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const regressions = Array.isArray(parsed.potentialRegressions) ? parsed.potentialRegressions : [];

    return `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div style="padding: 14px; border-radius: 8px; background: ${bg}; border: 1px solid ${border};">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
            <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: ${isApproved ? '#166534' : '#991b1b'};">
              Independent Code Review Verdict
            </span>
            <span class="badge" style="font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 6px; background: ${isApproved ? '#dcfce7' : '#fee2e2'}; color: ${isApproved ? '#15803d' : '#b91c1c'}; border: 1px solid ${border};">
              ${escapeHtml(parsed.verdict || 'REVIEWED')}
            </span>
          </div>
          <div style="font-size: 13.5px; color: var(--text-primary); line-height: 1.55;">
            ${escapeHtml(parsed.summary || 'No review summary provided.')}
          </div>
        </div>

        ${findings.length > 0 ? `
          <div>
            <div style="font-size: 11.5px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;">
              Review Findings (${findings.length})
            </div>
            <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; display: flex; flex-direction: column; gap: 4px;">
              ${findings.map((f: string) => `<li>${escapeHtml(f)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${regressions.length > 0 ? `
          <div style="padding: 10px 12px; border-radius: 8px; background: #fff7ed; border: 1px solid #fed7aa;">
            <div style="font-size: 11.5px; font-weight: 700; color: #9a3412; margin-bottom: 4px;">Potential Regressions</div>
            <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: #7c2d12; line-height: 1.45;">
              ${regressions.map((r: string) => `<li>${escapeHtml(r)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <details style="margin-top: 6px;">
          <summary style="font-size: 11.5px; font-weight: 600; color: var(--brand-blue); cursor: pointer; user-select: none;">
            Inspect Raw Review JSON Payload
          </summary>
          <pre class="bounded-scroll-panel" style="margin-top: 8px; font-family: var(--font-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>
        </details>
      </div>
    `;
  }

  // 3. Generic JSON Detail
  if (parsed && typeof parsed === 'object') {
    return `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 11px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
          Structured Configuration Payload
        </div>
        <pre class="bounded-scroll-panel" style="font-family: var(--font-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-all; margin: 0;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>
      </div>
    `;
  }

  // 4. Plain Text Detail with Progressive Disclosure
  const isMultiLine = value.length > 200 || value.includes('\n');
  if (isMultiLine) {
    return `
      <div class="expandable-text-wrapper" style="position: relative;">
        <div class="line-clamp-3 expandable-text-target" style="font-size: 13px; color: var(--text-primary); line-height: 1.55; white-space: pre-wrap; word-break: break-word;">
          ${escapeHtml(value)}
        </div>
        <button type="button" class="btn-disclosure-toggle" aria-expanded="false" onclick="
          const target = this.previousElementSibling;
          if (target.classList.contains('line-clamp-expanded')) {
            target.classList.remove('line-clamp-expanded');
            target.classList.add('line-clamp-3');
            this.textContent = 'Show more ▾';
            this.setAttribute('aria-expanded', 'false');
          } else {
            target.classList.remove('line-clamp-3');
            target.classList.add('line-clamp-expanded');
            this.textContent = 'Show less ▴';
            this.setAttribute('aria-expanded', 'true');
          }
        ">Show more ▾</button>
      </div>
    `;
  }

  return `
    <div style="font-size: 13px; color: var(--text-primary); line-height: 1.55; word-break: break-word;">
      ${escapeHtml(value)}
    </div>
  `;
}

/**
 * Wraps long monospaced log or stdout/stderr text inside a bounded container with expand toggle.
 */
export function renderBoundedLogBoxHtml(logText: string, options?: { maxHeight?: string; id?: string }): string {
  if (!logText || !logText.trim()) {
    return `<div class="mono-code-box" style="color: var(--text-muted); font-style: italic;">(no output recorded)</div>`;
  }

  const maxHeight = options?.maxHeight || '240px';
  const idAttr = options?.id ? `id="${escapeHtml(options.id)}"` : '';

  return `
    <div class="bounded-log-wrapper" style="display: flex; flex-direction: column; gap: 4px;">
      <pre class="bounded-scroll-panel" ${idAttr} style="max-height: ${maxHeight}; font-family: var(--font-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; margin: 0;">${escapeHtml(logText)}</pre>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" class="btn-disclosure-toggle" aria-expanded="false" onclick="
          const pre = this.parentElement.previousElementSibling;
          if (pre.style.maxHeight === 'none') {
            pre.style.maxHeight = '${maxHeight}';
            this.textContent = 'Expand log ▾';
            this.setAttribute('aria-expanded', 'false');
          } else {
            pre.style.maxHeight = 'none';
            this.textContent = 'Collapse log ▴';
            this.setAttribute('aria-expanded', 'true');
          }
        ">Expand log ▾</button>
      </div>
    </div>
  `;
}

/**
 * Intelligently formats live tool invocation arguments and results into clean,
 * bounded cards with syntax highlighting and expandable audit inspection drawers.
 */
export function formatActivityDetailHtml(detail: string): string {
  if (!detail || !detail.trim()) return '';

  const trimmed = detail.trim();

  // 1. Tool Invocation Arguments ("Arguments: {...}")
  if (trimmed.startsWith('Arguments: ')) {
    const rawArgs = trimmed.slice('Arguments: '.length).trim();
    const parsed = tryParseJson<any>(rawArgs);
    if (parsed && typeof parsed === 'object') {
      if (parsed.path && parsed.content !== undefined) {
        const lineCount = (String(parsed.content).match(/\n/g) || []).length + 1;
        const charCount = String(parsed.content).length;
        return `
          <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 2px;">
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; flex-wrap: wrap;">
              <span style="color: var(--text-muted);">Write to</span>
              <code style="font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-primary); font-weight: 600;">${escapeHtml(String(parsed.path))}</code>
              <span style="color: var(--text-muted); font-size: 10.5px;">(${lineCount} lines, ${charCount} chars)</span>
            </div>
            <details style="margin-top: 2px;">
              <summary style="font-size: 10px; color: var(--brand-blue); cursor: pointer; user-select: none;">Inspect Written File Content</summary>
              <pre class="bounded-scroll-panel" style="margin-top: 4px; max-height: 160px; font-family: var(--font-mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(String(parsed.content))}</pre>
            </details>
          </div>
        `;
      }

      if (parsed.path) {
        return `
          <div style="font-size: 11px; display: flex; align-items: center; gap: 6px; margin-top: 2px;">
            <span style="color: var(--text-muted);">Path:</span>
            <code style="font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-primary); font-weight: 600;">${escapeHtml(String(parsed.path))}</code>
          </div>
        `;
      }

      if (parsed.command) {
        const fullCmd = [String(parsed.command), ...(Array.isArray(parsed.args) ? parsed.args.map(String) : [])].join(' ');
        return `
          <div style="font-size: 11px; display: flex; align-items: center; gap: 6px; margin-top: 2px;">
            <span style="color: var(--text-muted);">Command:</span>
            <code style="font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 4px; color: var(--brand-blue); font-weight: 600;">${escapeHtml(fullCmd)}</code>
          </div>
        `;
      }
    }
  }

  // 2. Tool Completed JSON
  const durationMatch = trimmed.match(/\((\d+ms)\)$/);
  const duration = durationMatch ? durationMatch[1] : '';
  const cleanJsonCandidate = trimmed.replace(/\s*\(\d+ms\)$/, '').trim();
  const parsedJson = tryParseJson<any>(cleanJsonCandidate);

  if (parsedJson && typeof parsedJson === 'object') {
    if ('exitCode' in parsedJson) {
      const isSuccess = parsedJson.exitCode === 0;
      const stdout = String(parsedJson.stdout || '').trim();
      const stderr = String(parsedJson.stderr || '').trim();
      const previewText = stdout ? formatSummaryPreview(stdout, 100) : (stderr ? formatSummaryPreview(stderr, 100) : 'Process completed');
      return `
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 2px;">
          <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; flex-wrap: wrap;">
            <span class="badge" style="font-size: 9.5px; padding: 1px 6px; border-radius: 4px; font-weight: 700; background: ${isSuccess ? '#dcfce7' : '#fee2e2'}; color: ${isSuccess ? '#15803d' : '#b91c1c'}; border: 1px solid ${isSuccess ? '#bbf7d0' : '#fecaca'};">
              ${isSuccess ? 'EXIT 0' : `EXIT ${parsedJson.exitCode}`}
            </span>
            <span class="line-clamp-1" style="color: var(--text-secondary); flex: 1; min-width: 0;">${escapeHtml(previewText)}</span>
            ${duration ? `<span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted);">${escapeHtml(duration)}</span>` : ''}
          </div>
          ${(stdout || stderr) ? `
            <details style="margin-top: 2px;">
              <summary style="font-size: 10px; color: var(--brand-blue); cursor: pointer; user-select: none;">Inspect Output Stream</summary>
              <pre class="bounded-scroll-panel" style="margin-top: 4px; max-height: 140px; font-family: var(--font-mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all;">${escapeHtml([stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n\n'))}</pre>
            </details>
          ` : ''}
        </div>
      `;
    }

    if (parsedJson.path && parsedJson.content !== undefined) {
      const lineCount = (String(parsedJson.content).match(/\n/g) || []).length + 1;
      const charCount = String(parsedJson.content).length;
      return `
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 2px;">
          <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; flex-wrap: wrap;">
            <span style="color: var(--text-muted);">Read</span>
            <code style="font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-primary); font-weight: 600;">${escapeHtml(String(parsedJson.path))}</code>
            <span style="color: var(--text-muted); font-size: 10.5px;">(${lineCount} lines, ${charCount} chars)</span>
            ${duration ? `<span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); margin-left: auto;">${escapeHtml(duration)}</span>` : ''}
          </div>
          <details style="margin-top: 2px;">
            <summary style="font-size: 10px; color: var(--brand-blue); cursor: pointer; user-select: none;">Inspect Read File Content</summary>
            <pre class="bounded-scroll-panel" style="margin-top: 4px; max-height: 160px; font-family: var(--font-mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(String(parsedJson.content))}</pre>
          </details>
        </div>
      `;
    }
  }

  // 3. Regular Text with Clamping & Inspection Toggle if long
  if (trimmed.length > 90 || trimmed.includes('\n')) {
    const cleanPreview = formatSummaryPreview(trimmed, 120);
    return `
      <div style="display: flex; flex-direction: column; gap: 3px; margin-top: 2px;">
        <div class="line-clamp-2" style="font-size: 11px; color: var(--text-secondary); line-height: 1.45; word-break: break-word;">${escapeHtml(cleanPreview)}</div>
        <details style="margin-top: 2px;">
          <summary style="font-size: 10px; color: var(--brand-blue); cursor: pointer; user-select: none;">Inspect Details</summary>
          <pre class="bounded-scroll-panel" style="margin-top: 4px; max-height: 140px; font-family: var(--font-mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(trimmed)}</pre>
        </details>
      </div>
    `;
  }

  return `<div style="font-size: 11px; color: var(--text-secondary); line-height: 1.4; margin-top: 2px;">${escapeHtml(trimmed)}</div>`;
}
