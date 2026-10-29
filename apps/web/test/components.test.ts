import { describe, expect, it, beforeEach } from 'vitest';
import { renderStatusBadge } from '../src/components/status-badge.js';
import { renderButton } from '../src/components/button.js';
import { renderBreadcrumbs } from '../src/components/breadcrumbs.js';
import { renderCard } from '../src/components/card.js';
import { renderDivider } from '../src/components/divider.js';

// Simple lightweight DOM mock for Node environment tests
class MockHTMLElement {
  public tagName: string;
  public className: string = '';
  public innerHTML: string = '';
  public textContent: string = '';
  public style: Record<string, string> = {};
  public children: MockHTMLElement[] = [];
  public attributes: Record<string, string> = {};
  public eventListeners: Record<string, Function[]> = {};
  public type?: string;
  public disabled?: boolean;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public appendChild(child: MockHTMLElement): MockHTMLElement {
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public addEventListener(event: string, handler: Function): void {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(handler);
  }

  public click(): void {
    const handlers = this.eventListeners['click'] ?? [];
    for (const h of handlers) {
      h({ preventDefault: () => {} });
    }
  }
}

describe('Shared UI Components', () => {
  beforeEach(() => {
    (global as any).document = {
      createElement: (tag: string) => new MockHTMLElement(tag),
    };
  });

  describe('renderStatusBadge', () => {
    it('renders verified badge with correct icon and text', () => {
      const badge = renderStatusBadge({ status: 'VERIFIED' });
      expect(badge.className).toContain('status-badge');
      expect(badge.className).toContain('verified');
      expect(badge.innerHTML).toContain('✓');
      expect(badge.innerHTML).toContain('Verified');
    });

    it('renders claimed badge with amber styling and icon', () => {
      const badge = renderStatusBadge({ status: 'CLAIMED' });
      expect(badge.className).toContain('claimed');
      expect(badge.innerHTML).toContain('◔');
      expect(badge.innerHTML).toContain('Claimed');
    });

    it('renders failed badge with red styling and cross icon', () => {
      const badge = renderStatusBadge({ status: 'FAILED' });
      expect(badge.className).toContain('failed');
      expect(badge.innerHTML).toContain('✕');
      expect(badge.innerHTML).toContain('Failed');
    });

    it('renders blocked needs human badge with exclamation icon', () => {
      const badge = renderStatusBadge({ status: 'BLOCKED_NEEDS_HUMAN' });
      expect(badge.className).toContain('blocked');
      expect(badge.innerHTML).toContain('!');
      expect(badge.innerHTML).toContain('Blocked · needs human');
    });

    it('renders unverified status gracefully as default', () => {
      const badge = renderStatusBadge({ status: 'UNVERIFIED' });
      expect(badge.className).toContain('unverified');
      expect(badge.innerHTML).toContain('○');
    });
  });

  describe('renderButton', () => {
    it('creates button with default secondary variant and md size', () => {
      const btn = renderButton({ label: 'Click Me' }) as unknown as MockHTMLElement;
      expect(btn.className).toContain('btn');
      expect(btn.className).toContain('btn-secondary');
      expect(btn.className).toContain('btn-md');
      expect(btn.innerHTML).toContain('Click Me');
    });

    it('applies primary variant and disabled state', () => {
      const btn = renderButton({
        label: 'Submit',
        variant: 'primary',
        size: 'lg',
        disabled: true,
      }) as unknown as MockHTMLElement;

      expect(btn.className).toContain('btn-primary');
      expect(btn.className).toContain('btn-lg');
      expect(btn.disabled).toBe(true);
    });

    it('triggers onClick handler on click event', () => {
      let clicked = false;
      const btn = renderButton({
        label: 'Action',
        onClick: () => {
          clicked = true;
        },
      }) as unknown as MockHTMLElement;

      btn.click();
      expect(clicked).toBe(true);
    });
  });

  describe('renderBreadcrumbs', () => {
    it('renders breadcrumb items with separators', () => {
      const crumbs = renderBreadcrumbs({
        items: [
          { label: 'Projects', path: '#/projects' },
          { label: 'Orchestrate Benchmark', path: '#/projects/bench/overview' },
          { label: 'Tasks' },
        ],
        separator: '>',
      }) as unknown as MockHTMLElement;

      expect(crumbs.className).toContain('app-breadcrumbs');
      expect(crumbs.children.length).toBe(5); // 3 items + 2 separators
      expect(crumbs.children[0].textContent).toBe('Projects');
      expect(crumbs.children[1].textContent).toBe('>');
      expect(crumbs.children[2].textContent).toBe('Orchestrate Benchmark');
      expect(crumbs.children[3].textContent).toBe('>');
      expect(crumbs.children[4].textContent).toBe('Tasks');
      expect(crumbs.children[4].className).toBe('current');
    });
  });

  describe('renderCard', () => {
    it('renders card with title, subtitle, and body', () => {
      const card = renderCard({
        title: 'Project Facts',
        subtitle: 'Facts from codebase and verifications',
        bodyContent: '<p>Fact 1</p>',
      }) as unknown as MockHTMLElement;

      expect(card.className).toContain('card');
      expect(card.children.length).toBe(2); // header and body
      expect(card.children[0].className).toBe('card-header');
      expect(card.children[1].className).toBe('card-body');
      expect(card.children[1].innerHTML).toBe('<p>Fact 1</p>');
    });
  });

  describe('renderDivider', () => {
    it('renders divider with divider class', () => {
      const divider = renderDivider('my-divider') as unknown as MockHTMLElement;
      expect(divider.tagName).toBe('HR');
      expect(divider.className).toContain('divider');
      expect(divider.className).toContain('my-divider');
    });
  });
});
