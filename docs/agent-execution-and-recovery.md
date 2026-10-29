# Orchestrate — Agent Execution, Recovery & Loop Control

## 1. Root Cause Analysis of Loop Exhaustion

In prior iterations, the agent loop terminated abruptly with:
`AgentRunner reached maximum loop iterations (10) without reaching a final response.`

Investigation revealed four contributing causes:
1. **Finish Reason Misalignment**: When providers returned `finishReason: 'stop'` alongside `toolCalls`, or when tool output was returned without an explicit final response trigger, the runner could fail to recognize completion.
2. **Missing Progress Signals**: Models had no feedback indicating whether written files had satisfied tests. As a result, the model continued calling read/write or search tools repeatedly until hitting turn 10.
3. **Repeated Failing Calls**: When tool arguments encountered syntax validation errors, the model repeated identical or near-identical tool invocations.
4. **Unhandled Runtime Exceptions**: When `AgentRunner` threw an `AgentExecutionError`, `Orchestrator` rethrew the exception without checking if files were modified in the workspace, resulting in a raw 500 error instead of running independent verification.

## 2. Recovery Architecture & Bounded Loops

1. **Strict Tool Call Detection**:
   Evaluates `hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0`. If false, the model's textual answer is immediately returned as a final response.

2. **Progress & Verification Hints**:
   The runner tracks `filesWritten: Set<string>` and test execution results (`lastCheckPassed`). Once files are created and tests pass exit 0, a verification notice is injected:
   `[Notice: Workspace files have been modified and verification checks passed. Please provide your final summary and finish without calling further tools.]`

3. **Circuit Breaking for Duplicate Calls & Errors**:
   - Consecutive identical tool signatures are flagged; after 2 consecutive rounds, the loop breaks gracefully.
   - Consecutive tool errors (>= 3) break gracefully, preserving workspace state for independent evaluation.

4. **Orchestrator Evidence Preservation**:
   In `Orchestrator.executeTask()`, if an `AgentExecutionError` occurs but files were modified in the workspace, a Handoff (`status: 'CLAIMED'`) is constructed. The `VerificationEngine` runs independently. If verification checks pass, the task transitions to `VERIFIED` pursuant to the rule:
   `CODE -> VERIFICATION EVIDENCE -> PROJECT BRAIN -> AGENT CLAIMS`.
