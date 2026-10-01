import { describe, expect, it } from 'vitest';
import {
  evaluateRework,
  ReworkEvaluationError,
  type ArtifactManifest,
  type ReworkEvaluationInput,
} from '../src/index.js';

describe('Milestone 3: Rework Evaluator', () => {
  const createFakeWorkspace = (files: Record<string, string> = {}) => ({
    async readFile(filePath: string): Promise<string> {
      if (filePath in files) {
        return files[filePath];
      }
      throw new Error(`File not found in upstreamWorkspace: ${filePath}`);
    },
  });

  const baseManifest: ArtifactManifest = {
    taskId: 'task-auth-api',
    attemptNumber: 1,
    createdAt: '2026-10-01T12:00:00.000Z',
    files: [
      {
        path: 'src/middleware/auth.ts',
        status: 'ADDED',
        symbols: [
          {
            name: 'authenticateToken',
            kind: 'function',
            signature: 'export function authenticateToken(req: any): void',
          },
        ],
      },
      {
        path: 'src/server.ts',
        status: 'MODIFIED',
        symbols: [
          {
            name: 'registerDataRoutes',
            kind: 'function',
            signature: 'export function registerDataRoutes(app: any): void',
          },
        ],
      },
    ],
  };

  // 1. Frozen upstream workspace controls symbol ranges
  it('1. upstreamWorkspace controls symbol ranges and coordinates match oldStart lines', async () => {
    const upstreamSource = [
      '// Server setup',
      'export function helper() { return 1; }', // lines 2
      '',
      'export function registerDataRoutes(app: any): void {', // line 4
      '  app.get("/data", () => "data");', // line 5
      '}', // line 6
      '',
      'export function startServer() {}', // line 8
    ].join('\n');

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -4,3 +4,3 @@
 export function registerDataRoutes(app: any): void {
-  app.get("/data", () => "data");
+  app.get("/data", () => "modified");
 }
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0].id).toBe('rw:src/server.ts:registerDataRoutes');
    expect(report.events[0].reason).toBe('UPSTREAM_MODIFIED_SYMBOL_CHANGED');
  });

  // 2. Post-Task-2 workspace cannot affect boundaries
  it('2. post-Task-2 workspace does not affect upstream symbol boundary calculation', async () => {
    // Upstream has registerDataRoutes at line 4
    const upstreamSource = [
      '// File header',
      '// Line 2',
      '// Line 3',
      'export function registerDataRoutes(app: any): void {',
      '  return;',
      '}',
    ].join('\n');

    // Post-Task-2 workspace could have 50 new lines prepended, but evaluator ignores it
    // because input ONLY accepts upstreamWorkspace!
    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -4,3 +4,4 @@
 export function registerDataRoutes(app: any): void {
+  console.log("new line");
   return;
 }
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0].reason).toBe('UPSTREAM_MODIFIED_SYMBOL_CHANGED');
  });

  // 3. Upstream ADDED file modified -> UPSTREAM_ADDED_FILE_MODIFIED
  it('3. classifies modification of upstream ADDED file as UPSTREAM_ADDED_FILE_MODIFIED', async () => {
    const diff = `
diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
--- a/src/middleware/auth.ts
+++ b/src/middleware/auth.ts
@@ -1,2 +1,3 @@
 export function authenticateToken(req: any): void {
+  // downstream modification
 }
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace(),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0]).toMatchObject({
      id: 'rw:src/middleware/auth.ts',
      filePath: 'src/middleware/auth.ts',
      upstreamStatus: 'ADDED',
      reason: 'UPSTREAM_ADDED_FILE_MODIFIED',
    });
  });

  // 4. Upstream ADDED file deleted -> UPSTREAM_ADDED_FILE_DELETED
  it('4. classifies deletion of upstream ADDED file as UPSTREAM_ADDED_FILE_DELETED', async () => {
    const diff = `
diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
deleted file mode 100644
--- a/src/middleware/auth.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function authenticateToken() {}
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace(),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0]).toMatchObject({
      id: 'rw:src/middleware/auth.ts',
      filePath: 'src/middleware/auth.ts',
      upstreamStatus: 'ADDED',
      reason: 'UPSTREAM_ADDED_FILE_DELETED',
    });
  });

  // 5. Upstream ADDED file renamed -> UPSTREAM_ADDED_FILE_RENAMED with destinationPath
  it('5. classifies rename of upstream ADDED file as UPSTREAM_ADDED_FILE_RENAMED with destinationPath', async () => {
    const diff = `
diff --git a/src/middleware/auth.ts b/src/middleware/new-auth.ts
similarity index 100%
rename from src/middleware/auth.ts
rename to src/middleware/new-auth.ts
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace(),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0]).toMatchObject({
      id: 'rw:src/middleware/auth.ts',
      filePath: 'src/middleware/auth.ts', // remains upstream manifest path!
      upstreamStatus: 'ADDED',
      reason: 'UPSTREAM_ADDED_FILE_RENAMED',
      destinationPath: 'src/middleware/new-auth.ts',
    });
  });

  // 6. Upstream MODIFIED file deleted -> UPSTREAM_MODIFIED_FILE_DELETED
  it('6. classifies deletion of upstream MODIFIED file as UPSTREAM_MODIFIED_FILE_DELETED', async () => {
    const diff = `
diff --git a/src/server.ts b/src/server.ts
deleted file mode 100644
--- a/src/server.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function registerDataRoutes() {}
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace(),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0]).toMatchObject({
      id: 'rw:src/server.ts:file',
      filePath: 'src/server.ts',
      upstreamStatus: 'MODIFIED',
      reason: 'UPSTREAM_MODIFIED_FILE_DELETED',
    });
  });

  // 7. Upstream MODIFIED file renamed -> UPSTREAM_MODIFIED_FILE_RENAMED
  it('7. classifies rename of upstream MODIFIED file as UPSTREAM_MODIFIED_FILE_RENAMED with destinationPath', async () => {
    const diff = `
diff --git a/src/server.ts b/src/app-server.ts
similarity index 90%
rename from src/server.ts
rename to src/app-server.ts
--- a/src/server.ts
+++ b/src/app-server.ts
@@ -1,2 +1,2 @@
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace(),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0]).toMatchObject({
      id: 'rw:src/server.ts:file',
      filePath: 'src/server.ts',
      upstreamStatus: 'MODIFIED',
      reason: 'UPSTREAM_MODIFIED_FILE_RENAMED',
      destinationPath: 'src/app-server.ts',
    });
  });

  // 8. Upstream symbol declaration deleted -> UPSTREAM_MODIFIED_SYMBOL_DELETED
  it('8. classifies deletion of upstream symbol declaration as UPSTREAM_MODIFIED_SYMBOL_DELETED', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  app.get("/data", () => "ok");
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,1 @@
-export function registerDataRoutes(app: any): void {
-  app.get("/data", () => "ok");
-}
+// routes removed
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0]).toMatchObject({
      id: 'rw:src/server.ts:registerDataRoutes',
      reason: 'UPSTREAM_MODIFIED_SYMBOL_DELETED',
    });
  });

  // 9. Upstream symbol body changed -> UPSTREAM_MODIFIED_SYMBOL_CHANGED
  it('9. classifies body alteration of upstream symbol as UPSTREAM_MODIFIED_SYMBOL_CHANGED', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  app.get("/data", () => "ok");
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,3 @@
 export function registerDataRoutes(app: any): void {
-  app.get("/data", () => "ok");
+  app.get("/data", () => "patched");
 }
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(1);
    expect(report.events[0].reason).toBe('UPSTREAM_MODIFIED_SYMBOL_CHANGED');
  });

  // 10. Compound declaration/body edit produces exactly one event
  it('10. compound declaration deletion and body modification collapses to exactly ONE event', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  app.get("/data", () => "ok");
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,2 @@
-export function registerDataRoutes(app: any): void {
-  app.get("/data", () => "ok");
-}
+export function replacement() {}
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    // Exactly one event for registerDataRoutes, with DELETED taking precedence
    expect(report.rework_events).toBe(1);
    expect(report.events[0].id).toBe('rw:src/server.ts:registerDataRoutes');
    expect(report.events[0].reason).toBe('UPSTREAM_MODIFIED_SYMBOL_DELETED');
  });

  // 11. targetSymbol deep/value equality with manifest
  it('11. targetSymbol matches manifest ArtifactSymbol by deep value equality', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,3 @@
 export function registerDataRoutes(app: any): void {
-  return;
+  return 42;
 }
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    const expectedSymbol = baseManifest.files[1].symbols[0];
    expect(report.events[0].targetSymbol).toEqual(expectedSymbol);
    expect(report.events[0].targetSymbol).not.toBeUndefined();
  });

  // 12. New balanced top-level downstream symbol = non-rework
  it('12. adding a self-contained balanced new top-level symbol is classified as NON_REWORK (0 rework)', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -3,0 +4,4 @@
+
+export function getProfile(req: any): any {
+  return { user: "alice" };
+}
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(0);
  });

  // 13. Partial/ambiguous new declaration = ambiguous
  it('13. partial or unbalanced additions at module level are classified as ambiguous (0 rework)', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -3,0 +4,2 @@
+const partialConstant = calculate(
+// unclosed
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0].reason).toBe('MODIFIED_FILE_SHARED_REGION_EDIT');
  });

  // 14. Pre-existing non-manifest symbol modification = non-rework
  it('14. modifying a pre-existing symbol not in the manifest is classified as NON_REWORK', async () => {
    const upstreamSource = `
export function preExistingHelper(): number {
  return 100;
}

export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,3 @@
 export function preExistingHelper(): number {
-  return 100;
+  return 200;
 }
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(0);
  });

  // 15. Import / shared-region edit = ambiguous
  it('15. edits in shared import statements are classified as ambiguous (0 rework)', async () => {
    const upstreamSource = `
import { Router } from 'express';

export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,2 +1,3 @@
-import { Router } from 'express';
+import { Router, Request } from 'express';
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0].reason).toBe('MODIFIED_FILE_SHARED_REGION_EDIT');
  });

  // 16. MODIFIED file with symbols=[] = ambiguous
  it('16. edits in an upstream MODIFIED file with symbols=[] are classified as ambiguous', async () => {
    const manifestWithNoSymbols: ArtifactManifest = {
      taskId: 'task-sql',
      attemptNumber: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      files: [
        {
          path: 'schema.sql',
          status: 'MODIFIED',
          symbols: [],
        },
      ],
    };

    const diff = `
diff --git a/schema.sql b/schema.sql
--- a/schema.sql
+++ b/schema.sql
@@ -1,2 +1,3 @@
 CREATE TABLE users (id TEXT);
+CREATE TABLE profile (id TEXT);
    `.trim();

    const report = await evaluateRework({
      manifest: manifestWithNoSymbols,
      upstreamWorkspace: createFakeWorkspace({ 'schema.sql': 'CREATE TABLE users (id TEXT);' }),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0].reason).toBe('MODIFIED_FILE_NO_UPSTREAM_SYMBOLS');
  });

  // 17. Downstream-created file = non-rework
  it('17. creating a new file not present in upstream manifest is NON_REWORK (0 rework)', async () => {
    const diff = `
diff --git a/src/routes/profile.ts b/src/routes/profile.ts
new file mode 100644
--- /dev/null
+++ b/src/routes/profile.ts
@@ -0,0 +1,3 @@
+export function profileHandler() {
+  return "ok";
+}
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace(),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(0);
  });

  // 18. Malformed diff = ambiguous (DIFF_SYNTAX_UNPARSEABLE)
  it('18. malformed diff syntax emits an ambiguous record and does not throw', async () => {
    const malformedDiff = `
diff --git a/src/server.ts b/src/server.ts
@@ invalid hunk header @@
- some line
+ another line
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': 'some line\n' }),
      diff: malformedDiff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous.some((a) => a.reason === 'DIFF_SYNTAX_UNPARSEABLE')).toBe(true);
  });

  // 19. Unreadable/unparseable upstream source = ambiguous
  it('19. unreadable upstream file in upstreamWorkspace emits MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE', async () => {
    const diff = `
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,2 +1,3 @@
 export function registerDataRoutes() {
+  // edit
 }
    `.trim();

    // upstreamWorkspace does NOT have src/server.ts, causing readFile to throw
    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({}),
      diff,
    });

    expect(report.rework_events).toBe(0);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0].reason).toBe(
      'MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE'
    );
  });

  // 20. Exact summary counter cardinality
  it('20. summary counters strictly adhere to unique-file set cardinality', async () => {
    const upstreamSource = `
import { Router } from 'express';

export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
--- a/src/middleware/auth.ts
+++ b/src/middleware/auth.ts
@@ -1,1 +1,2 @@
+// modified
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,1 +1,2 @@
+// modified imports
diff --git a/src/new-route.ts b/src/new-route.ts
new file mode 100644
--- /dev/null
+++ b/src/new-route.ts
@@ -0,0 +1,1 @@
+export const x = 1;
    `.trim();

    const report = await evaluateRework({
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
    });

    // manifest files: src/middleware/auth.ts, src/server.ts (2)
    // diff files: src/middleware/auth.ts, src/server.ts, src/new-route.ts (3)
    // union: 3
    expect(report.summary.totalFilesEvaluated).toBe(3);
    expect(report.summary.upstreamFilesChecked).toBe(2);
    // rework in src/middleware/auth.ts (1 file)
    expect(report.summary.reworkFilesCount).toBe(1);
    // ambiguous in src/server.ts (1 file)
    expect(report.summary.ambiguousFilesCount).toBe(1);
  });

  // 21. Deterministic repeated evaluation
  it('21. produces byte-for-byte identical serialized output on identical input', async () => {
    const upstreamSource = `
export function registerDataRoutes(app: any): void {
  return;
}
    `.trim();

    const diff = `
diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
--- a/src/middleware/auth.ts
+++ b/src/middleware/auth.ts
@@ -1,1 +1,2 @@
+// edit
    `.trim();

    const input: ReworkEvaluationInput = {
      manifest: baseManifest,
      upstreamWorkspace: createFakeWorkspace({ 'src/server.ts': upstreamSource }),
      diff,
      downstreamTaskId: 'task-profile-route',
    };

    const run1 = await evaluateRework(input);
    const run2 = await evaluateRework(input);

    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    expect(Object.isFrozen(run1)).toBe(true);
    expect(Object.isFrozen(run1.events)).toBe(true);
  });

  // 22. Input validation
  it('22. throws ReworkEvaluationError on invalid input contracts', async () => {
    // @ts-expect-error missing upstreamWorkspace
    await expect(evaluateRework({ manifest: baseManifest, diff: '' })).rejects.toThrow(
      ReworkEvaluationError
    );

    // @ts-expect-error missing manifest
    await expect(evaluateRework({ upstreamWorkspace: createFakeWorkspace(), diff: '' })).rejects.toThrow(
      ReworkEvaluationError
    );
  });
});
