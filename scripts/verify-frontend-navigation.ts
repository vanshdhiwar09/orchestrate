import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://127.0.0.1:3000';
const SCREENSHOTS_DIR = join(process.cwd(), 'docs', 'screenshots');

const routesToTest = [
  {
    name: '01_projects_index',
    path: '#/projects',
    expectedContent: ['Projects', 'Create Project', 'Orchestrate'],
  },
  {
    name: '02_settings',
    path: '#/settings',
    expectedContent: ['Settings', 'Engine Configuration', 'Engine Provider'],
  },
  {
    name: '03_project_overview',
    path: '#/projects/profile-validation/overview',
    expectedContent: ['Evidence-backed project workspace', 'Repository', 'New Task'],
  },
  {
    name: '04_tasks_explorer',
    path: '#/projects/profile-validation/tasks',
    expectedContent: [
      'Tasks',
      'Task Explorer',
      'New Task',
      'modal-backdrop',
      'modal-dialog',
      'role="dialog"',
      'aria-modal="true"',
      'Create New Task',
    ],
  },
  {
    name: '04b_task_detail',
    path: '#/projects/profile-validation/tasks?task=task-email-validator',
    expectedContent: [
      'Task Detail',
      'Autonomous Agent Execution',
      'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      'task-detail-timeline-container',
      'task-detail-run-btn',
      'task-detail-diff-section',
    ],
  },
  {
    name: '05_handoffs_verifications',
    path: '#/projects/profile-validation/handoffs',
    expectedContent: ['Handoffs', 'Verifications'],
  },
  {
    name: '06_context_compiler',
    path: '#/projects/profile-validation/context',
    expectedContent: ['Compiled context', 'Target task', 'Inspect the evidence-backed context'],
  },
  {
    name: '07_project_brain',
    path: '#/projects/profile-validation/brain',
    expectedContent: ['Project Brain', 'Facts'],
  },
];

async function captureRoute(name: string, urlPath: string) {
  const fullUrl = `${BASE_URL}/${urlPath}`;
  const screenshotFile = join(SCREENSHOTS_DIR, `${name}.png`);

  console.log(`\nNavigating to: ${fullUrl}`);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--virtual-time-budget=3000',
    '--window-size=1400,900',
    `--screenshot=${screenshotFile}`,
    '--dump-dom',
    fullUrl,
  ];

  try {
    const { stdout, stderr } = await execFileAsync(CHROME_PATH, args, { maxBuffer: 10 * 1024 * 1024 });
    const dom = stdout || '';

    const hasScreenshot = existsSync(screenshotFile);
    console.log(`  ✓ Screenshot saved: ${screenshotFile} (${hasScreenshot ? 'OK' : 'MISSING'})`);

    return { dom, screenshotFile };
  } catch (err) {
    console.error(`  ✗ Error navigating to ${fullUrl}:`, (err as Error).message);
    throw err;
  }
}

async function run() {
  console.log('===============================================================');
  console.log(' Orchestrate Live Frontend Verification via Real Chrome');
  console.log(` Base URL: ${BASE_URL}`);
  console.log('===============================================================');

  const results: Array<{ route: string; status: 'PASSED' | 'FAILED'; checks: string[] }> = [];

  for (const route of routesToTest) {
    try {
      const { dom } = await captureRoute(route.name, route.path);
      const passedChecks: string[] = [];
      const failedChecks: string[] = [];

      for (const expected of route.expectedContent) {
        if (dom.includes(expected)) {
          passedChecks.push(`Found text "${expected}"`);
        } else {
          failedChecks.push(`Missing text "${expected}"`);
        }
      }

      if (dom.includes('status-dot connected') || dom.includes('Connected')) {
        passedChecks.push('Engine connection indicator verified');
      }

      if (failedChecks.length === 0) {
        console.log(`  ✓ Route passed all ${passedChecks.length} visual / content checks.`);
        results.push({ route: route.path, status: 'PASSED', checks: passedChecks });
      } else {
        console.log(`  ✗ Route failed checks:`, failedChecks);
        results.push({ route: route.path, status: 'FAILED', checks: failedChecks });
      }
    } catch (err) {
      results.push({ route: route.path, status: 'FAILED', checks: [(err as Error).message] });
    }
  }

  console.log('\n===============================================================');
  console.log(' Frontend Route Verification Summary');
  console.log('===============================================================');
  let allPassed = true;
  for (const r of results) {
    console.log(`[${r.status}] ${r.route} (${r.checks.length} assertions)`);
    if (r.status === 'FAILED') allPassed = false;
  }

  if (allPassed) {
    console.log('\nAll frontend routes rendered and verified successfully in Chrome!');
    process.exit(0);
  } else {
    console.error('\nSome frontend routes failed verification.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Frontend navigation script failed:', err);
  process.exit(1);
});
