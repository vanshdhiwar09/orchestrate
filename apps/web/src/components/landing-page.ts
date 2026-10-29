import { router } from '../services/router.js';

/**
 * Public marketing homepage for Orchestrate (route: #/).
 *
 * Implements the exact visual design from the official hero reference:
 * - Panoramic sunrise mountain summit background on right, fading to white/cream on left.
 * - Full-width spacious navigation with brand on left, links, and action buttons on right.
 * - Eyebrow: BUILT FOR DEVELOPERS | PLAN. BUILD. VERIFY. SHIP.
 * - Headline: Turn ideas into shipped software. (with electric blue gradient).
 * - Subtitle: Orchestrate gives your AI agents the context, tools, and feedback loops they need to do meaningful work — together.
 * - CTAs: [Get started →] and [▶ Watch demo (3 min)]
 * - 4 Bottom Hero Feature Items: Project context, Multi-model orchestration, Independent verification, Open and extensible.
 * - Partner strip: WORKS WITH THE BEST | NVIDIA · NEBIUS · Tavily · LangChain · GitHub · Open Source.
 * - Seamless integration with existing application routes, Project Brain, and Task Workspace.
 */

export const REPOSITORY_URL = 'https://github.com/vanshdhiwar09/orchestrate';
export const DOCS_URL = `${REPOSITORY_URL}/tree/main/docs`;
export const HERO_MOUNTAIN_SRC = '/assets/hero-mountain.jpg';
export const APP_ENTRY_ROUTE = '#/projects';

const ICONS = {
  arrow: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#141413"/><polygon points="10,8 16,12 10,16" fill="#ffffff"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5 10-10"/></svg>`,
  logo: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/></svg>`,
  database: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`,
  multiModel: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  shieldCheck: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>`,
  cube: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 16-9 5-9-5V8l9-5 9 5v8z"/><path d="m3.27 7.96 8.73 4.93 8.73-4.93"/><path d="M12 22.08V12.89"/></svg>`,
  github: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"/></svg>`,
  langchain: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  tavily: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="2.5"/><circle cx="12" cy="20" r="2.5"/><circle cx="4" cy="12" r="2.5"/><circle cx="20" cy="12" r="2.5"/><circle cx="6.34" cy="6.34" r="2"/><circle cx="17.66" cy="17.66" r="2"/><circle cx="6.34" cy="17.66" r="2"/><circle cx="17.66" cy="6.34" r="2"/></svg>`,
  nvidia: `<svg width="22" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.9 7.7c-1.8 0-3.3 1.5-3.3 3.3v4.6c0 1.8 1.5 3.3 3.3 3.3h6.2c1.8 0 3.3-1.5 3.3-3.3V11c0-1.8-1.5-3.3-3.3-3.3H8.9zm0 1.6h6.2c.9 0 1.7.8 1.7 1.7v4.6c0 .9-.8 1.7-1.7 1.7H8.9c-.9 0-1.7-.8-1.7-1.7V11c0-.9.8-1.7 1.7-1.7z"/></svg>`,
  openSource: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-5 18.66V13a5 5 0 0 1 10 0v7.66A10 10 0 0 0 12 2z"/></svg>`,
  plan: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>`,
  research: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  implement: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  verify: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>`,
  ship: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
};

interface WorkflowStep {
  key: keyof typeof ICONS;
  title: string;
  subtitle: string;
  text: string;
  badge: string;
  badgeClass: string;
}

const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    key: 'plan',
    title: 'Plan',
    subtitle: 'Lead Planner · GLM-5.3-Flash',
    text: 'Analyzes project specifications, targets file boundaries, and establishes unambiguous acceptance criteria.',
    badge: 'PLANNER',
    badgeClass: 'badge-plan',
  },
  {
    key: 'research',
    title: 'Compile Context',
    subtitle: 'Context Compiler · Project Brain',
    text: 'Selects authoritative conventions and verified SQLite project facts without polluting model prompt limits.',
    badge: 'BRAIN',
    badgeClass: 'badge-brain',
  },
  {
    key: 'implement',
    title: 'Implement',
    subtitle: 'Implementer · Kimi-K2.6',
    text: 'Executes within an isolated workspace sandbox using strictly authorized file tools and verified ESM imports.',
    badge: 'EXECUTION',
    badgeClass: 'badge-impl',
  },
  {
    key: 'verify',
    title: 'Verify',
    subtitle: 'Independent Test Runner',
    text: 'Runs configured acceptance checks independently. Agent claims are never trusted blindly without test proof.',
    badge: 'VERIFIED',
    badgeClass: 'badge-verif',
  },
  {
    key: 'ship',
    title: 'Review & Handoff',
    subtitle: 'Code Reviewer · Nemotron-3.5',
    text: 'Performs independent architectural review and persists verifiable evidence into the Project Brain.',
    badge: 'HANDOFF',
    badgeClass: 'badge-handoff',
  },
];

// Interactive Sandbox Tab Code Snippets
const SANDBOX_SNIPPETS: Record<string, { badge: string; code: string }> = {
  implementation: {
    badge: '+86 lines · TypeScript',
    code: `<span class="code-kw">import type</span> { <span class="code-type">ValidationResult</span>, <span class="code-type">UserProfile</span> } <span class="code-kw">from</span> <span class="code-str">'./types.ts'</span>;
<span class="code-kw">import</span> { isValidEmail } <span class="code-kw">from</span> <span class="code-str">'./email-validator.ts'</span>;

<span class="code-kw">export function</span> <span class="code-fn">validateProfile</span>(input: <span class="code-type">unknown</span>): <span class="code-type">ValidationResult</span> {
  <span class="code-kw">const</span> errors: <span class="code-type">string</span>[] = [];
  <span class="code-kw">if</span> (!input || <span class="code-kw">typeof</span> input !== <span class="code-str">'object'</span>) {
    <span class="code-kw">return</span> { valid: <span class="code-kw">false</span>, errors: [<span class="code-str">'Profile must be an object'</span>] };
  }
  <span class="code-kw">const</span> p = input <span class="code-kw">as</span> Record&lt;<span class="code-type">string</span>, <span class="code-type">unknown</span>&gt;;
  <span class="code-kw">if</span> (!p.name || <span class="code-kw">typeof</span> p.name !== <span class="code-str">'string'</span>) errors.push(<span class="code-str">'Name is required'</span>);
  <span class="code-kw">if</span> (!p.email || !isValidEmail(String(p.email))) errors.push(<span class="code-str">'Valid email is required'</span>);
  <span class="code-kw">return</span> { valid: errors.length === <span class="code-num">0</span>, errors };
}`,
  },
  tests: {
    badge: '14 test cases · node --test',
    code: `<span class="code-kw">import</span> { describe, it } <span class="code-kw">from</span> <span class="code-str">'node:test'</span>;
<span class="code-kw">import</span> assert <span class="code-kw">from</span> <span class="code-str">'node:assert/strict'</span>;
<span class="code-kw">import</span> { validateProfile } <span class="code-kw">from</span> <span class="code-str">'../src/validate-profile.ts'</span>;

<span class="code-fn">describe</span>(<span class="code-str">'validateProfile acceptance suite'</span>, () =&gt; {
  <span class="code-fn">it</span>(<span class="code-str">'passes on valid profile with correct types'</span>, () =&gt; {
    <span class="code-kw">const</span> res = <span class="code-fn">validateProfile</span>({ name: <span class="code-str">'Ada Lovelace'</span>, email: <span class="code-str">'ada@engine.dev'</span> });
    assert.equal(res.valid, <span class="code-kw">true</span>);
    assert.deepEqual(res.errors, []);
  });

  <span class="code-fn">it</span>(<span class="code-str">'rejects missing name and malformed email'</span>, () =&gt; {
    <span class="code-kw">const</span> res = <span class="code-fn">validateProfile</span>({ name: <span class="code-str">''</span>, email: <span class="code-str">'bad-email'</span> });
    assert.equal(res.valid, <span class="code-kw">false</span>);
    assert.equal(res.errors.length, <span class="code-num">2</span>);
  });
});`,
  },
  diff: {
    badge: '1 target file · git diff',
    code: `<span class="code-diff-hdr">diff --git a/src/validate-profile.ts b/src/validate-profile.ts</span>
<span class="code-diff-hdr">new file mode 100644</span>
<span class="code-diff-hdr">--- /dev/null</span>
<span class="code-diff-hdr">+++ b/src/validate-profile.ts</span>
<span class="code-diff-range">@@ -0,0 +1,14 @@</span>
<span class="code-diff-add">+import type { ValidationResult, UserProfile } from './types.ts';</span>
<span class="code-diff-add">+import { isValidEmail } from './email-validator.ts';</span>
<span class="code-diff-add">+</span>
<span class="code-diff-add">+export function validateProfile(input: unknown): ValidationResult {</span>
<span class="code-diff-add">+  const errors: string[] = [];</span>
<span class="code-diff-add">+  if (!input || typeof input !== 'object') {</span>
<span class="code-diff-add">+    return { valid: false, errors: ['Profile must be an object'] };</span>
<span class="code-diff-add">+  }</span>
<span class="code-diff-add">+  const p = input as Record&lt;string, unknown&gt;;</span>
<span class="code-diff-add">+  if (!p.name || typeof p.name !== 'string') errors.push('Name is required');</span>
<span class="code-diff-add">+  if (!p.email || !isValidEmail(String(p.email))) errors.push('Valid email is required');</span>
<span class="code-diff-add">+  return { valid: errors.length === 0, errors };</span>
<span class="code-diff-add">+}</span>`,
  },
};

export function renderLandingPage(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'landing';
  page.id = 'landing-page';

  page.innerHTML = `
    <button type="button" class="landing-skip" data-scroll-to="landing-main">Skip to content</button>

    <!-- TOP NAVIGATION BAR (Matching Reference) -->
    <header class="landing-nav" role="banner">
      <div class="landing-nav-inner">
        <!-- Left: Brand Logo & Navigation Links -->
        <div class="landing-nav-left">
          <button type="button" class="landing-brand" data-scroll-to="landing-top" aria-label="Orchestrate — back to top">
            <span class="landing-brand-icon">${ICONS.logo}</span>
            <span class="landing-brand-text">Orchestrate</span>
          </button>

          <nav class="landing-nav-links" aria-label="Primary navigation">
            <button type="button" data-scroll-to="landing-preview">Product</button>
            <button type="button" data-scroll-to="landing-workflow">Workflow</button>
            <a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">Docs</a>
            <button type="button" data-scroll-to="landing-stack">Pricing</button>
            <button type="button" data-scroll-to="landing-why">Community</button>
          </nav>
        </div>

        <!-- Right: Teaser, Sign In, and CTA Button -->
        <div class="landing-nav-actions">
          <button type="button" class="landing-nav-teaser" data-scroll-to="landing-workflow">
            <span>Agents for real work.</span>
            <span class="teaser-chevron">&gt;</span>
          </button>
          <button type="button" class="landing-nav-link-btn" data-action="open-app">
            Sign in
          </button>
          <button type="button" class="landing-btn landing-btn-pill" data-action="open-app">
            Get started ${ICONS.arrow}
          </button>
        </div>
      </div>
    </header>

    <main id="landing-main" tabindex="-1">
      <!-- HERO SECTION (Panoramic Sunrise Alpine Mountain Background) -->
      <section class="landing-hero" id="landing-top" aria-labelledby="landing-hero-title">
        <div class="landing-hero-bg-overlay"></div>

        <div class="landing-container landing-hero-container">
          <div class="landing-hero-content">
            <!-- Eyebrow Pill -->
            <div class="landing-hero-eyebrow landing-reveal" style="--d: 0ms;">
              <span class="eyebrow-dot" aria-hidden="true"></span>
              <span class="eyebrow-bold">BUILT FOR DEVELOPERS</span>
              <span class="eyebrow-pipe">|</span>
              <span class="eyebrow-tracking">PLAN. BUILD. VERIFY. SHIP.</span>
            </div>

            <!-- Main Headline -->
            <h1 class="landing-hero-title landing-reveal" id="landing-hero-title" style="--d: 80ms;">
              Turn ideas into<br />
              <span class="gradient-text">shipped software.</span>
            </h1>

            <!-- Subtitle -->
            <p class="landing-hero-sub landing-reveal" style="--d: 160ms;">
              Orchestrate gives your AI agents the context, tools, and feedback loops they need to do meaningful work — together.
            </p>

            <!-- Hero Action Buttons -->
            <div class="landing-hero-ctas landing-reveal" style="--d: 240ms;">
              <button type="button" class="landing-btn landing-btn-hero-primary" data-action="open-app" id="landing-hero-get-started">
                Get started ${ICONS.arrow}
              </button>
              <a href="https://drive.google.com/file/d/1trRBt1jwyZcwi9cSWrrHRki2ZIA__Zi6/view?usp=sharing" target="_blank" rel="noopener noreferrer" class="landing-btn landing-btn-hero-demo" id="landing-hero-watch-demo">
                ${ICONS.play}
                <span>Watch demo</span>
                <span class="demo-pill-time">3 min</span>
              </a>
            </div>

            <!-- 4 Bottom Feature Points (Matching Reference Exactly) -->
            <div class="landing-hero-features landing-reveal" style="--d: 320ms;" aria-label="Core architecture pillars">
              <div class="hero-feature-item">
                <span class="feature-icon">${ICONS.database}</span>
                <div class="feature-text">
                  <div class="feature-title">Project context</div>
                  <div class="feature-desc">Persistent memory</div>
                </div>
              </div>

              <div class="hero-feature-item">
                <span class="feature-icon">${ICONS.multiModel}</span>
                <div class="feature-text">
                  <div class="feature-title">Multi-model orchestration</div>
                  <div class="feature-desc">Planner, implementer, reviewer</div>
                </div>
              </div>

              <div class="hero-feature-item">
                <span class="feature-icon">${ICONS.shieldCheck}</span>
                <div class="feature-text">
                  <div class="feature-title">Independent verification</div>
                  <div class="feature-desc">Evidence over claims</div>
                </div>
              </div>

              <div class="hero-feature-item">
                <span class="feature-icon">${ICONS.cube}</span>
                <div class="feature-text">
                  <div class="feature-title">Open and extensible</div>
                  <div class="feature-desc">Bring your own tools</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- LOGO / PARTNERS STRIP (Works with the best) -->
      <section class="landing-partners-bar" aria-label="Supported platforms and integrations">
        <div class="landing-container landing-partners-inner">
          <div class="partners-label">
            <span class="partners-pipe">|</span> WORKS WITH THE BEST
          </div>
          <div class="partners-list">
            <div class="partner-item nvidia">
              ${ICONS.nvidia}
              <span class="partner-name">NVIDIA</span>
            </div>
            <div class="partner-item nebius">
              <span class="partner-name-bold">NEBIUS</span>
            </div>
            <div class="partner-item tavily">
              ${ICONS.tavily}
              <span class="partner-name">Tavily</span>
            </div>
            <div class="partner-item langchain">
              ${ICONS.langchain}
              <span class="partner-name">LangChain</span>
            </div>
            <div class="partner-item github">
              ${ICONS.github}
              <span class="partner-name">GitHub</span>
            </div>
            <div class="partner-item opensource">
              ${ICONS.openSource}
              <span class="partner-name">Open Source</span>
            </div>
          </div>
        </div>
      </section>

      <!-- LIVE WORKSPACE PREVIEW CARD (Interactive Sandbox) -->
      <section class="landing-section" id="landing-preview" aria-labelledby="landing-preview-title">
        <div class="landing-container">
          <div class="landing-section-head">
            <div class="landing-label">Engine Experience</div>
            <h2 class="landing-h2" id="landing-preview-title">Real multi-agent coordination. Not just a chatbot.</h2>
            <p class="landing-lead">
              Every task runs through distinct, accountable model roles with isolated git checkouts, automated file scoping, and deterministic test execution.
            </p>
          </div>

          <div class="sandbox-showcase-card landing-reveal-on-scroll">
            <div class="sandbox-card-header">
              <div class="sandbox-card-title-group">
                <span class="sandbox-window-dot red"></span>
                <span class="sandbox-window-dot yellow"></span>
                <span class="sandbox-window-dot green"></span>
                <span class="sandbox-header-label">orchestrate://workspace/profile-validation</span>
              </div>
              <div class="sandbox-header-badges">
                <span class="badge-verif">✓ VERIFIED</span>
                <span class="sandbox-header-att">Attempt 5</span>
              </div>
            </div>

            <!-- Workspace Stepper -->
            <div class="sandbox-stepper">
              <div class="sandbox-step-item done">
                <div class="sandbox-step-circle">✓</div>
                <div class="sandbox-step-meta">
                  <div class="sandbox-step-num">STAGE 1</div>
                  <div class="sandbox-step-name">Plan (GLM-5.3-Flash)</div>
                </div>
              </div>
              <div class="sandbox-step-connector done"></div>
              <div class="sandbox-step-item done">
                <div class="sandbox-step-circle">✓</div>
                <div class="sandbox-step-meta">
                  <div class="sandbox-step-num">STAGE 2</div>
                  <div class="sandbox-step-name">Context (Project Brain)</div>
                </div>
              </div>
              <div class="sandbox-step-connector done"></div>
              <div class="sandbox-step-item done">
                <div class="sandbox-step-circle">✓</div>
                <div class="sandbox-step-meta">
                  <div class="sandbox-step-num">STAGE 3</div>
                  <div class="sandbox-step-name">Implement (Kimi-K2.6)</div>
                </div>
              </div>
              <div class="sandbox-step-connector done"></div>
              <div class="sandbox-step-item done">
                <div class="sandbox-step-circle">✓</div>
                <div class="sandbox-step-meta">
                  <div class="sandbox-step-num">STAGE 4</div>
                  <div class="sandbox-step-name">Review (Nemotron-3.5)</div>
                </div>
              </div>
              <div class="sandbox-step-connector done"></div>
              <div class="sandbox-step-item active">
                <div class="sandbox-step-circle">✓</div>
                <div class="sandbox-step-meta">
                  <div class="sandbox-step-num">STAGE 5</div>
                  <div class="sandbox-step-name">Verify (Test Runner)</div>
                </div>
              </div>
            </div>

            <!-- Sandbox Grid Content -->
            <div class="sandbox-grid">
              <div class="sandbox-panel-code">
                <!-- Interactive Code Tabs -->
                <div class="sandbox-panel-tabs-bar">
                  <div class="sandbox-tabs-group" role="tablist" aria-label="Code previews">
                    <button type="button" class="sandbox-tab-btn active" data-code-tab="implementation" role="tab" aria-selected="true">
                      <span>src/validate-profile.ts</span>
                    </button>
                    <button type="button" class="sandbox-tab-btn" data-code-tab="tests" role="tab" aria-selected="false">
                      <span>test/validate-profile.test.ts</span>
                    </button>
                    <button type="button" class="sandbox-tab-btn" data-code-tab="diff" role="tab" aria-selected="false">
                      <span>git diff (sandbox)</span>
                    </button>
                  </div>
                  <span class="sandbox-code-badge" id="sandbox-tab-badge">+86 lines · TypeScript</span>
                </div>
                <pre class="sandbox-code-block"><code id="sandbox-code-content">${SANDBOX_SNIPPETS.implementation.code}</code></pre>
              </div>

              <div class="sandbox-panel-evidence">
                <div class="sandbox-panel-tab">
                  <span style="font-weight: 600; font-size: 12.5px;">Independent Verification Evidence</span>
                  <span class="badge-verif">14/14 PASS</span>
                </div>
                <div class="sandbox-evidence-list">
                  <div class="sandbox-evidence-item">
                    <span class="evidence-icon ok">✓</span>
                    <div class="evidence-body">
                      <div class="evidence-title">Workspace Integrity Check (git status)</div>
                      <div class="evidence-sub">Working tree clean · Isolated branch checkout · 35ms</div>
                    </div>
                  </div>
                  <div class="sandbox-evidence-item">
                    <span class="evidence-icon ok">✓</span>
                    <div class="evidence-body">
                      <div class="evidence-title">node_next_module_resolution_gate</div>
                      <div class="evidence-sub">Strict ESM import specifiers with .ts resolution · 61ms</div>
                    </div>
                  </div>
                  <div class="sandbox-evidence-item">
                    <span class="evidence-icon ok">✓</span>
                    <div class="evidence-body">
                      <div class="evidence-title">Unit Acceptance Test Gate (node --test)</div>
                      <div class="evidence-sub">14 passing · 0 failing · 42ms runtime</div>
                    </div>
                  </div>
                  <div class="sandbox-evidence-item">
                    <span class="evidence-icon ok">✓</span>
                    <div class="evidence-body">
                      <div class="evidence-title">Node 24 ESM Type-Stripping Execution</div>
                      <div class="evidence-sub">Zero runtime syntax errors on interface imports</div>
                    </div>
                  </div>
                  <div class="sandbox-evidence-item">
                    <span class="evidence-icon ok">✓</span>
                    <div class="evidence-body">
                      <div class="evidence-title">Brain Handoff State Recorded</div>
                      <div class="evidence-sub">Persisted in SQLite with authoritative VERIFIED tag</div>
                    </div>
                  </div>
                </div>

                <div class="sandbox-cta-row">
                  <button type="button" class="landing-btn landing-btn-primary landing-btn-sm" data-action="open-app">
                    Open in Orchestrate Studio →
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- WORKFLOW SECTION -->
      <section class="landing-section landing-section-alt" id="landing-workflow" aria-labelledby="landing-workflow-title">
        <div class="landing-container">
          <div class="landing-section-head">
            <div class="landing-label">Lifecycle</div>
            <h2 class="landing-h2" id="landing-workflow-title">From request to results.</h2>
            <p class="landing-lead">A structured, transparent workflow for multi-agent software engineering.</p>
          </div>

          <div class="landing-steps-grid">
            ${WORKFLOW_STEPS.map(
              (s, i) => `
              <div class="landing-step-card landing-reveal-on-scroll step-${s.key}" style="--d: ${i * 70}ms;">
                <div class="landing-step-header">
                  <span class="landing-step-icon">${ICONS[s.key]}</span>
                  <span class="${s.badgeClass}">${s.badge}</span>
                </div>
                <div class="landing-step-index">STEP 0${i + 1}</div>
                <h3 class="landing-step-title">${s.title}</h3>
                <div class="landing-step-subtitle">${s.subtitle}</div>
                <p class="landing-step-text">${s.text}</p>
              </div>`
            ).join('')}
          </div>

          <p class="landing-footnote">
            Explanatory workflow stages — Orchestrate evaluates each step with real models, local workspaces, and independent verification.
          </p>
        </div>
      </section>

      <!-- DIFFERENTIATION SECTION -->
      <section class="landing-section" id="landing-why" aria-labelledby="landing-why-title">
        <div class="landing-container">
          <div class="landing-section-head">
            <div class="landing-label">Differentiators</div>
            <h2 class="landing-h2" id="landing-why-title">More than agents.<br />A system for getting work done.</h2>
            <p class="landing-lead">
              Coding agents are capable, but without boundaries they drift, hallucinate success, and forget project rules. Orchestrate adds the persistent context, strict workspace boundaries, and independent evaluation needed for real engineering.
            </p>
          </div>

          <div class="landing-pillars">
            <article class="landing-pillar-card landing-reveal-on-scroll" style="--d: 0ms;">
              <div class="landing-pillar-icon-wrap blue">${ICONS.research}</div>
              <h3>Shared project context</h3>
              <p>Agents start from relevant repository conventions and persistent Project Brain facts instead of guessing or rediscovering the codebase from scratch.</p>
              <div class="landing-pillar-tag">Persistent SQLite Knowledge</div>
            </article>

            <article class="landing-pillar-card landing-reveal-on-scroll" style="--d: 80ms;">
              <div class="landing-pillar-icon-wrap teal">${ICONS.implement}</div>
              <h3>Traceable execution</h3>
              <p>Inspect every single action: tool arguments, command exit codes, git diffs, agent handoffs, and full attempt history across every iteration.</p>
              <div class="landing-pillar-tag">Bounded Sandboxes &amp; Clean Diffs</div>
            </article>

            <article class="landing-pillar-card landing-reveal-on-scroll" style="--d: 160ms;">
              <div class="landing-pillar-icon-wrap green">${ICONS.verify}</div>
              <h3>Evidence-backed verification</h3>
              <p>Agent claims and reviewer outputs are kept strictly separate from tests that actually ran. Work is only marked VERIFIED when acceptance tests pass.</p>
              <div class="landing-pillar-tag">Zero Unverified Claims</div>
            </article>
          </div>

          <!-- The Source of Truth Hierarchy -->
          <div class="landing-trust landing-reveal-on-scroll" aria-labelledby="landing-trust-title">
            <div class="landing-trust-head">
              <div>
                <div class="landing-label" id="landing-trust-title">Source-of-Truth Hierarchy</div>
                <h3 class="landing-trust-title">What Orchestrate trusts, in order</h3>
              </div>
              <p>When sources disagree, the higher one wins. An agent saying "done" is a claim, not verification evidence.</p>
            </div>

            <ol class="landing-trust-chain">
              <li class="trust-item code">
                <span class="trust-badge code">1. CODE</span>
                <span class="trust-title">Repository Source</span>
                <span class="trust-desc">Authoritative files in the workspace git repo</span>
              </li>
              <li aria-hidden="true" class="landing-trust-arrow">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
              </li>
              <li class="trust-item verif">
                <span class="trust-badge verif">2. VERIFICATION</span>
                <span class="trust-title">Independent Evidence</span>
                <span class="trust-desc">Checks that executed independently with real exit codes</span>
              </li>
              <li aria-hidden="true" class="landing-trust-arrow">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
              </li>
              <li class="trust-item brain">
                <span class="trust-badge brain">3. PROJECT BRAIN</span>
                <span class="trust-title">Structured Facts</span>
                <span class="trust-desc">Persisted decisions, contracts, and revision lineage</span>
              </li>
              <li aria-hidden="true" class="landing-trust-arrow">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
              </li>
              <li class="trust-item claims">
                <span class="trust-badge claims">4. AGENT CLAIMS</span>
                <span class="trust-title">Unverified Claims</span>
                <span class="trust-desc">What model turns state before evidence confirms them</span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <!-- INFERENCE & STACK SECTION -->
      <section class="landing-section landing-section-alt" id="landing-stack" aria-labelledby="landing-stack-title">
        <div class="landing-container">
          <div class="landing-section-head landing-section-head-row">
            <div>
              <div class="landing-label">Inference Engine</div>
              <h2 class="landing-h2 landing-h2-sm" id="landing-stack-title">Powered by Nebius Token Factory.</h2>
            </div>
            <p class="landing-lead landing-lead-sm">
              High-throughput open-weights models running on NVIDIA GPU clusters for specialized multi-agent roles.
            </p>
          </div>

          <div class="landing-stack-grid">
            <div class="landing-stack-card">
              <div class="stack-card-role-pill planner">PLANNING ROLE</div>
              <div class="stack-card-model">GLM-5.3-Flash</div>
              <div class="stack-card-provider">Nebius Token Factory · us-north1</div>
              <p class="stack-card-desc">Decomposes complex requests into targeted file boundaries and acceptance criteria.</p>
              <div class="stack-card-specs">
                <span>131K Context</span>
                <span>Fast Tool Calling</span>
                <span>Structured JSON</span>
              </div>
            </div>

            <div class="landing-stack-card highlight">
              <div class="stack-card-role-pill coder">IMPLEMENTATION ROLE</div>
              <div class="stack-card-model">Kimi-K2.6</div>
              <div class="stack-card-provider">Nebius Token Factory · us-central1</div>
              <p class="stack-card-desc">Writes production-grade TypeScript with strict ESM imports and zero runtime hallucinations.</p>
              <div class="stack-card-specs">
                <span>256K Context</span>
                <span>60 Tok/s</span>
                <span>Workspace Sandboxing</span>
              </div>
            </div>

            <div class="landing-stack-card">
              <div class="stack-card-role-pill reviewer">REVIEW ROLE</div>
              <div class="stack-card-model">Nemotron-3.5-Super-VL</div>
              <div class="stack-card-provider">Nebius Token Factory · us-north1</div>
              <p class="stack-card-desc">NVIDIA open model evaluating code changes, finding edge cases, and checking regressions.</p>
              <div class="stack-card-specs">
                <span>1,024K Context</span>
                <span>282 Tok/s</span>
                <span>BF16 Precision</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- FINAL CALL TO ACTION -->
      <section class="landing-cta" aria-labelledby="landing-cta-title">
        <div class="landing-container landing-cta-inner">
          <div class="landing-cta-copy">
            <div class="landing-eyebrow-pill on-dark">
              <span>● Production-Ready Architecture</span>
            </div>
            <h2 class="landing-cta-title" id="landing-cta-title">
              Build with context.<br />
              Ship with confidence.
            </h2>
            <p class="landing-cta-lead">
              Open your local repository folder, define the task, and watch Orchestrate coordinate agents with real verification evidence.
            </p>
          </div>
          <div class="landing-cta-actions">
            <button type="button" class="landing-btn landing-btn-primary-inverse" data-action="open-app" id="landing-cta-get-started">
              Get started ${ICONS.arrow}
            </button>
            <a class="landing-btn landing-btn-secondary-inverse" href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">
              ${ICONS.github} View on GitHub
            </a>
          </div>
        </div>
      </section>
    </main>

    <!-- FOOTER -->
    <footer class="landing-footer">
      <div class="landing-container landing-footer-inner">
        <div class="landing-footer-brand">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="landing-brand-icon">${ICONS.logo}</span>
            <span class="landing-brand-text">Orchestrate</span>
          </div>
          <span class="landing-footer-tag">Evidence-backed AI Engineering System</span>
        </div>
        <div class="landing-footer-status">
          <span class="landing-footer-dot"></span>
          <span>Engine Connected: Local Engine v0.1.0 · All 1,006 Suite Tests Passing</span>
        </div>
        <nav class="landing-footer-links" aria-label="Footer links">
          <button type="button" data-action="open-app">Open App</button>
          <button type="button" data-scroll-to="landing-workflow">Workflow</button>
          <button type="button" data-scroll-to="landing-preview">Sandbox</button>
          <a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">Docs</a>
          <a href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
      </div>
    </footer>
  `;

  wireLandingInteractions(page);
  return page;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function wireLandingInteractions(root: HTMLElement): void {
  // 1. Navigation & CTA click bindings
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // "Open App" or "Get started" or "Sign in"
    const openAppBtn = target.closest<HTMLElement>('[data-action="open-app"]');
    if (openAppBtn) {
      event.preventDefault();
      router.navigate('/projects');
      return;
    }

    // Interactive Code Tabs in Live Sandbox
    const tabBtn = target.closest<HTMLButtonElement>('[data-code-tab]');
    if (tabBtn) {
      event.preventDefault();
      const tabKey = tabBtn.getAttribute('data-code-tab') || 'implementation';
      const snippet = SANDBOX_SNIPPETS[tabKey];
      if (snippet) {
        root.querySelectorAll('.sandbox-tab-btn').forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        tabBtn.classList.add('active');
        tabBtn.setAttribute('aria-selected', 'true');

        const codeEl = root.querySelector('#sandbox-code-content');
        if (codeEl) codeEl.innerHTML = snippet.code;

        const badgeEl = root.querySelector('#sandbox-tab-badge');
        if (badgeEl) badgeEl.textContent = snippet.badge;
      }
      return;
    }

    // In-page smooth scrolling anchors
    const scrollBtn = target.closest<HTMLElement>('[data-scroll-to]');
    if (scrollBtn) {
      event.preventDefault();
      const targetId = scrollBtn.getAttribute('data-scroll-to');
      if (targetId) {
        const dest = root.querySelector(`#${targetId}`);
        if (dest && typeof dest.scrollIntoView === 'function') {
          dest.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'start',
          });
        }
      }
    }
  });

  // 2. IntersectionObserver reveal animations
  if (typeof IntersectionObserver !== 'undefined' && !prefersReducedMotion()) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    root.querySelectorAll('.landing-reveal-on-scroll').forEach((el) => {
      observer.observe(el);
    });
  } else {
    // If reduced motion or no observer, reveal immediately
    root.querySelectorAll('.landing-reveal-on-scroll').forEach((el) => {
      el.classList.add('is-visible');
    });
  }
}
