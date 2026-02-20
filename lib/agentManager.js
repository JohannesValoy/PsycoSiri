import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {AIProvider} from './aiProvider.js';
import {nowISO, generateSessionId, getConfigDir} from './utils.js';

const MAX_AGENT_TOOL_ITERATIONS = 100;

export class AgentManager {
    constructor(settings, toolRegistry, memory = null, extensionPath = null) {
        this._settings = settings;
        this._toolRegistry = toolRegistry;
        this._memory = memory;
        this._extensionPath = extensionPath;
        // Snapshot the original execute method so that monkey-patching in
        // overlay.js (which wraps execute with UI code) never affects agents.
        this._toolExecute = toolRegistry.execute.bind(toolRegistry);
        this._runs = new Map();
        this._onStateChange = null;
    }

    setOnStateChange(callback) {
        this._onStateChange = callback;
    }

    getAgentConfigs() {
        try {
            return JSON.parse(this._settings.get_string('agent-configs') || '{}');
        } catch {
            return {};
        }
    }

    async spawnAgent(agentConfigId, task) {
        const configs = this.getAgentConfigs();
        const agentCfg = configs[agentConfigId];
        if (!agentCfg)
            throw new Error(`No agent configuration found with ID "${agentConfigId}". Available: ${Object.keys(configs).join(', ') || 'none'}`);

        let providerConfigs;
        try {
            providerConfigs = JSON.parse(this._settings.get_string('providers') || '{}');
        } catch {
            providerConfigs = {};
        }

        const provCfg = providerConfigs[agentCfg.providerId];
        if (!provCfg)
            throw new Error(`Provider "${agentCfg.providerId}" not found. Configure it in Settings > Providers.`);

        const provider = new AIProvider(
            agentCfg.providerId,
            provCfg.name,
            provCfg.apiKey,
            provCfg.baseUrl
        );
        provider.setModel(agentCfg.modelId);

        const runId = generateSessionId();
        const defaultPrompt = `You are a powerful autonomous AI agent running on a Fedora Linux desktop with GNOME. You have FULL unrestricted access to the entire system — including sudo/root, all shell commands, package managers (dnf, pip, npm, cargo, etc.), compilers, interpreters, and every tool installed on the system.

ENVIRONMENT:
- OS: Fedora Linux with GNOME desktop
- Access: Full sudo/root, no restrictions, no approval needed
- Shell: bash with full PATH (git, gcc, python3, node, docker, etc.)
- File system: Full read/write access everywhere
- Network: Full internet access

AVAILABLE TOOLS:
- run_command: Execute ANY bash command. Use working_directory for project context. Use background=true for long builds/installs, then check_command to poll results.
- read_file: Read files with optional line offset and max_lines for efficient partial reads. Use line_numbers=true to see exact line numbers for editing.
- edit_file: Surgically edit files with find/replace. Provide exact old_string to match and new_string to replace. Supports multiple edits per call. ALWAYS prefer this over write_file for existing files.
- write_file: Create new files or fully overwrite existing ones.
- list_directory: List directory contents.
- check_command: Check status/output of background commands.
- web_search: Search the web for documentation, solutions, etc.
- All other registered tools (clipboard, system info, app launcher, memory, todos).

WORKFLOW:
1. Call plan_tasks with a short list of steps (keep it to 3-8 steps).
2. Work through each step using tools. Call complete_task after each step.
3. When ALL steps are done, you MUST call the finish tool with your summary.

CODING BEST PRACTICES:
- ALWAYS use read_file with line_numbers=true before editing, so you can see exact text to match.
- Use edit_file for surgical changes — never rewrite entire files with write_file unless creating from scratch.
- Use run_command for grep, find, git, tests, builds — the full Linux toolchain is available.
- For long operations (builds, installs, large git clones), use background=true and poll with check_command.
- If something fails, read the error carefully (output keeps head + tail), diagnose, and fix.

TESTING — CRITICAL:
- ALWAYS prefix test commands with the Linux "timeout" command (in seconds) to prevent deadlocked tests from hanging forever. Example: "timeout 60 python3 -m pytest tests/ -v --tb=short". Exit code 124 means the timeout was hit.
- If a test times out (exit code 124), it means a test is hanging (deadlock, infinite loop). This IS a bug in the code you wrote — diagnose and fix it.
- After writing code, you MUST run the tests and READ the output carefully.
- If ANY tests fail: read the error, fix the code, rerun. Repeat until ALL tests pass.
- NEVER call finish if tests are failing. Your task is not done until tests pass.
- If you wrote tests, run them. If the project has existing tests, run those too.
- Use "--tb=short" or "--tb=line" flags for concise failure output.

MEMORY — USE IT:
- You have persistent memory across runs via memory_store and memory_recall tools.
- Use memory_recall to search for relevant past learnings BEFORE starting unfamiliar work.
- When in doubt about the meaning of a task, a term, or a convention — check memory first. Previous runs may have stored clarifications or context.
- When you discover something useful (a gotcha, a pattern, a project convention, a fix for a tricky bug), store it with memory_store using type "agent_learning" and descriptive keywords.
- Keep memories concise and actionable — future you should understand them instantly.
- On completion, your key learnings are auto-saved. But store important discoveries as you go — don't wait until the end.

RULES:
- Be concise and efficient. Do NOT repeat work you already did.
- Do NOT re-read files you already read unless they changed.
- Only call finish when your work is VERIFIED — tests pass, builds succeed, output is correct.
- If a tool returns an error, try an alternative approach, then move on or finish with what you have.`;

        // Recall relevant memories from previous runs
        let memoriesText = '';
        if (this._memory) {
            try {
                const memories = await this._memory.recall(task, 8);
                if (memories.length > 0) {
                    memoriesText = '\n\nRELEVANT MEMORIES FROM PREVIOUS RUNS:\n'
                        + memories.map(m => `- [${m.type}] ${m.content}`).join('\n');
                }
            } catch {
                // Memory recall failure is non-fatal
            }
        }

        const systemPrompt = (agentCfg.systemPrompt || defaultPrompt)
            + memoriesText
            + `\n\nCurrent date and time: ${nowISO()}`;

        const run = {
            id: runId,
            agentName: agentCfg.name || agentConfigId,
            agentConfigId,
            task,
            state: 'running',
            result: null,
            error: null,
            todos: [],
            toolCallCount: 0,
            processLog: [{
                type: 'system',
                timestamp: nowISO(),
                content: `Started with model ${agentCfg.modelId}`,
            }],
            messages: [{role: 'user', content: task}],
            systemPrompt,
            provider,
            cancellable: new Gio.Cancellable(),
            startedAt: nowISO(),
            completedAt: null,
            _isRepairAgent: false,
            _repairTargetRunId: null,
            _logPath: null,
            _healthCheckSourceId: 0,
            _providerConfig: {providerId: agentCfg.providerId, provCfg, modelId: agentCfg.modelId},
        };

        this._runs.set(runId, run);
        this._notifyStateChange(run);

        // Start periodic health check (first check after 60s)
        this._scheduleHealthCheck(run);

        this._executeAgentLoop(run).catch(e => {
            console.error(`[Aether] Agent run ${runId} uncaught error: ${e.message}`);
        });

        return runId;
    }

    cancelAgent(runId) {
        const run = this._runs.get(runId);
        if (!run || run.state !== 'running')
            return false;

        if (run.cancellable)
            run.cancellable.cancel();

        run.state = 'error';
        run.error = 'Cancelled by user';
        run.completedAt = nowISO();
        run.processLog.push({
            type: 'system',
            timestamp: nowISO(),
            content: 'Cancelled by user',
        });
        if (run.provider) {
            run.provider.destroy();
            run.provider = null;
        }
        this._notifyStateChange(run);
        return true;
    }

    _getAgentTodoSchemas() {
        return [
            {
                type: 'function',
                function: {
                    name: 'plan_tasks',
                    description: 'Create your task plan. Call this FIRST before doing any work. Replaces any existing plan.',
                    parameters: {
                        type: 'object',
                        properties: {
                            tasks: {
                                type: 'array',
                                items: {type: 'string'},
                                description: 'List of task descriptions in order of execution.',
                            },
                        },
                        required: ['tasks'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'complete_task',
                    description: 'Mark a task as done by its index (0-based). Call this after finishing each step.',
                    parameters: {
                        type: 'object',
                        properties: {
                            index: {type: 'integer', description: 'The 0-based task index to mark done.'},
                        },
                        required: ['index'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'finish',
                    description: 'Signal that you are DONE with the task. You MUST call this when finished. Provide a summary of what you accomplished.',
                    parameters: {
                        type: 'object',
                        properties: {
                            summary: {type: 'string', description: 'A concise summary of what was accomplished.'},
                        },
                        required: ['summary'],
                    },
                },
            },
        ];
    }

    _executeAgentTodo(run, toolName, toolArgs) {
        if (toolName === 'plan_tasks') {
            run.todos = (toolArgs.tasks || []).map(t => ({text: t, done: false}));
            const list = run.todos.map((t, i) => `${i}. [ ] ${t.text}`).join('\n');
            return `Plan created with ${run.todos.length} tasks:\n${list}`;
        }
        if (toolName === 'complete_task') {
            const idx = toolArgs.index;
            if (idx < 0 || idx >= run.todos.length)
                return `Invalid task index ${idx}. Valid range: 0-${run.todos.length - 1}.`;
            run.todos[idx].done = true;
            const done = run.todos.filter(t => t.done).length;
            return `Task ${idx} marked done (${done}/${run.todos.length} complete): ${run.todos[idx].text}`;
        }
        if (toolName === 'finish') {
            // Check for signs that tests weren't verified or are failing
            const warnings = [];

            // Check if last run_command had test failures
            if (run._lastTestResult) {
                const r = run._lastTestResult;
                if (r.exitCode !== 0)
                    warnings.push(`WARNING: Your last test run FAILED (exit code ${r.exitCode}). Fix the failures before finishing.`);
                if (r.timedOut)
                    warnings.push(`WARNING: Your last test run TIMED OUT — likely a deadlock or infinite loop. This is a bug, fix it.`);
            }

            // Check for incomplete tasks
            const incomplete = run.todos.filter(t => !t.done);
            if (incomplete.length > 0)
                warnings.push(`WARNING: ${incomplete.length} task(s) still incomplete: ${incomplete.map(t => t.text).join(', ')}`);

            if (warnings.length > 0) {
                // Don't finish — push back to the agent
                return `FINISH REJECTED.\n${warnings.join('\n')}\n\nYou must fix these issues before calling finish. Go back and address them.`;
            }

            // All clear — actually finish
            run._finished = true;
            run.result = toolArgs.summary || '';

            // Auto-store a learning memory from this run
            if (this._memory && run.result) {
                try {
                    const taskExcerpt = run.task.slice(0, 100);
                    const summary = run.result.slice(0, 500);
                    const keywords = taskExcerpt.replace(/[^a-zA-Z0-9\s]/g, ' ')
                        .split(/\s+/).filter(w => w.length > 3).slice(0, 8).join(', ');
                    this._memory.store(
                        'agent_learning',
                        `Task: ${taskExcerpt}\nOutcome: ${summary}`,
                        keywords,
                        6
                    ).catch(() => {}); // fire and forget
                } catch {
                    // Memory store failure is non-fatal
                }
            }

            return 'Agent finished.';
        }
        return null;
    }

    async _executeAgentLoop(run) {
        const agentTodoNames = new Set(['plan_tasks', 'complete_task', 'finish']);

        try {
            const registryTools = this._toolRegistry.getToolSchemas().filter(
                t => t.function.name !== 'spawn_agent' && t.function.name !== 'check_agent'
            );
            const tools = [...registryTools, ...this._getAgentTodoSchemas()];
            let iterations = 0;

            while (iterations < MAX_AGENT_TOOL_ITERATIONS) {
                iterations++;

                const apiMessages = [
                    {role: 'system', content: run.systemPrompt},
                    ...run.messages,
                ];

                // Retry API call at agent-loop level in case aiProvider retry
                // doesn't catch the error (e.g. GJS socket-level exceptions).
                let response;
                const LOOP_RETRIES = 3;
                for (let apiAttempt = 0; apiAttempt <= LOOP_RETRIES; apiAttempt++) {
                    try {
                        response = await run.provider.chat(
                            apiMessages, tools, null, run.cancellable
                        );
                        break;
                    } catch (apiErr) {
                        if (run.cancellable?.is_cancelled())
                            throw apiErr;
                        const errMsg = apiErr.message || String(apiErr);
                        const isTransient = /timeout|timed out|socket|connection|reset|IOError|broken pipe/i.test(errMsg);
                        if (!isTransient || apiAttempt === LOOP_RETRIES)
                            throw apiErr;
                        const delay = 5000 * Math.pow(2, apiAttempt); // 5s, 10s, 20s, 40s
                        console.log(`[Aether] Agent loop API retry ${apiAttempt + 1}/${LOOP_RETRIES}: ${errMsg.slice(0, 100)} — waiting ${delay / 1000}s`);
                        run.processLog.push({
                            type: 'system',
                            timestamp: nowISO(),
                            content: `API retry ${apiAttempt + 1}: ${errMsg.slice(0, 80)}`,
                        });
                        await new Promise(resolve => {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                resolve();
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                    }
                }

                const assistantMsg = {role: 'assistant', content: response.content || ''};
                if (response.tool_calls && response.tool_calls.length > 0)
                    assistantMsg.tool_calls = response.tool_calls;
                run.messages.push(assistantMsg);

                const hasContent = response.content && response.content.length > 0;
                const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;

                // Only log text responses (not empty intermediary responses during tool calling)
                if (hasContent) {
                    run.processLog.push({
                        type: 'response',
                        timestamp: nowISO(),
                        content: response.content.length > 500
                            ? response.content.slice(0, 500) + '...'
                            : response.content,
                    });
                }

                // If no tool calls, agent is done
                if (!hasToolCalls) {
                    run.result = response.content || '';
                    run.state = 'completed';
                    run.completedAt = nowISO();
                    if (run.provider) {
                        run.provider.destroy();
                        run.provider = null;
                    }
                    this._writeRunLog(run);
                    this._notifyStateChange(run);
                    return;
                }

                // Execute tool calls in parallel where possible.
                // Agent-scoped tools (plan_tasks, complete_task, finish) run
                // sequentially since they mutate shared state. All others
                // run concurrently via Promise.all.
                const todoCallIndices = new Set();

                for (let i = 0; i < response.tool_calls.length; i++) {
                    const tc = response.tool_calls[i];
                    if (agentTodoNames.has(tc.function.name))
                        todoCallIndices.add(i);
                }

                // Log all tool calls upfront
                const parsedArgs = response.tool_calls.map(tc => {
                    let toolArgs = {};
                    try { toolArgs = JSON.parse(tc.function.arguments); } catch {}
                    const argsPreview = JSON.stringify(toolArgs);
                    run.toolCallCount = (run.toolCallCount || 0) + 1;
                    run.processLog.push({
                        type: 'tool_call',
                        timestamp: nowISO(),
                        content: `${tc.function.name}(${argsPreview.length > 200 ? argsPreview.slice(0, 200) + '...' : argsPreview})`,
                    });
                    return toolArgs;
                });
                this._notifyStateChange(run);

                // Execute all non-todo tools in parallel
                const toolResults = new Array(response.tool_calls.length);
                const parallelPromises = [];

                for (let i = 0; i < response.tool_calls.length; i++) {
                    if (todoCallIndices.has(i))
                        continue;
                    const tc = response.tool_calls[i];
                    const idx = i;
                    parallelPromises.push(
                        (async () => {
                            try {
                                toolResults[idx] = await this._toolExecute(tc.function.name, parsedArgs[idx]);

                                // Track test results so finish can validate
                                if (tc.function.name === 'run_command') {
                                    const cmd = (parsedArgs[idx].command || '').toLowerCase();
                                    const isTest = /pytest|unittest|jest|mocha|cargo test|go test|npm test|make test/i.test(cmd);
                                    if (isTest) {
                                        try {
                                            const parsed = JSON.parse(toolResults[idx]);
                                            run._lastTestResult = {
                                                command: cmd,
                                                exitCode: parsed.exit_code ?? -1,
                                                timedOut: !!(parsed.error && /timed? ?out/i.test(parsed.error)),
                                            };
                                        } catch { /* not JSON, skip */ }
                                    }
                                }
                            } catch (toolErr) {
                                toolResults[idx] = JSON.stringify({error: toolErr.message || String(toolErr)});
                            }
                        })()
                    );
                }

                // Wait for all parallel tools to finish
                if (parallelPromises.length > 0)
                    await Promise.all(parallelPromises);

                // Now execute todo tools sequentially (they depend on order)
                for (let i = 0; i < response.tool_calls.length; i++) {
                    if (!todoCallIndices.has(i))
                        continue;
                    const tc = response.tool_calls[i];
                    try {
                        toolResults[i] = this._executeAgentTodo(run, tc.function.name, parsedArgs[i]);
                    } catch (toolErr) {
                        toolResults[i] = JSON.stringify({error: toolErr.message || String(toolErr)});
                    }
                }

                // Push all results to messages in order
                for (let i = 0; i < response.tool_calls.length; i++) {
                    const tc = response.tool_calls[i];
                    const toolResult = toolResults[i];
                    const resultPreview = typeof toolResult === 'string'
                        ? toolResult : JSON.stringify(toolResult);
                    run.processLog.push({
                        type: 'tool_result',
                        timestamp: nowISO(),
                        content: resultPreview.length > 500
                            ? resultPreview.slice(0, 500) + '...'
                            : resultPreview,
                    });

                    run.messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                    });
                }

                if (run._finished) {
                    run.state = 'completed';
                    run.completedAt = nowISO();
                    run.processLog.push({
                        type: 'system',
                        timestamp: nowISO(),
                        content: 'Agent called finish — task complete.',
                    });
                    if (run.provider) {
                        run.provider.destroy();
                        run.provider = null;
                    }
                    this._writeRunLog(run);
                    this._notifyStateChange(run);
                    return;
                }

                this._notifyStateChange(run);
            }

            // Max iterations reached — mark as error so the user knows it didn't finish
            const lastAssistant = run.messages.filter(m => m.role === 'assistant').pop();
            run.result = lastAssistant?.content || '';
            run.state = 'error';
            run.error = `Stopped: max iterations (${MAX_AGENT_TOOL_ITERATIONS}) reached`;
            run.completedAt = nowISO();
            run.processLog.push({
                type: 'error',
                timestamp: nowISO(),
                content: `Stopped: max iterations (${MAX_AGENT_TOOL_ITERATIONS}) reached.`,
            });
            if (run.provider) {
                run.provider.destroy();
                run.provider = null;
            }
            this._writeRunLog(run);
            this._notifyStateChange(run);
            this._attemptAutoRepair(run);

        } catch (e) {
            const errorMsg = e.message || String(e);
            const isCancelled = run.cancellable?.is_cancelled()
                || (errorMsg.includes('ancelled') && !errorMsg.includes('timed out') && !errorMsg.includes('timeout'));
            if (!isCancelled)
                console.error(`[Aether] Agent ${run.agentName} error: ${errorMsg}`);

            // Don't overwrite if already set by cancelAgent()
            if (run.state === 'running') {
                run.state = 'error';
                run.error = isCancelled ? 'Cancelled' : errorMsg;
                run.completedAt = nowISO();
                run.processLog.push({
                    type: 'error',
                    timestamp: nowISO(),
                    content: isCancelled ? 'Cancelled' : errorMsg,
                });
                if (run.provider) {
                    run.provider.destroy();
                    run.provider = null;
                }
                this._writeRunLog(run);
                this._notifyStateChange(run);
                if (!isCancelled && !run._isRepairAgent)
                    this._attemptAutoRepair(run);
            }
        }
    }

    checkAgent(runId) {
        const run = this._runs.get(runId);
        if (!run)
            return {error: `No agent run found with ID "${runId}"`};

        return {
            id: run.id,
            agentName: run.agentName,
            task: run.task,
            state: run.state,
            result: run.result,
            error: run.error,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            toolCallCount: run.processLog.filter(l => l.type === 'tool_call').length,
            processLog: run.processLog.slice(-10).map(l => `[${l.type}] ${l.content}`),
        };
    }

    listAgents() {
        return [...this._runs.values()].map(run => ({
            id: run.id,
            agentName: run.agentName,
            task: run.task,
            state: run.state,
            result: run.result,
            todos: run.todos || [],
            toolCallCount: run.toolCallCount || 0,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
        }));
    }

    getRunLog(runId) {
        const run = this._runs.get(runId);
        return run ? run.processLog : [];
    }

    getRunningCount() {
        let count = 0;
        for (const run of this._runs.values()) {
            if (run.state === 'running')
                count++;
        }
        return count;
    }

    _scheduleHealthCheck(run) {
        // Don't health-check repair agents (they're already a recovery mechanism)
        if (run._isRepairAgent) return;

        const HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute
        run._healthCheckSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            HEALTH_CHECK_INTERVAL_MS,
            () => {
                run._healthCheckSourceId = 0;
                if (run.state !== 'running') return GLib.SOURCE_REMOVE;
                this._performHealthCheck(run);
                return GLib.SOURCE_REMOVE; // One-shot; re-scheduled if continuing
            }
        );
    }

    _cancelHealthCheck(run) {
        if (run._healthCheckSourceId > 0) {
            GLib.source_remove(run._healthCheckSourceId);
            run._healthCheckSourceId = 0;
        }
    }

    async _performHealthCheck(run) {
        if (run.state !== 'running') return;

        console.log(`[Aether] Health check for agent "${run.agentName}" (${run.id.slice(0, 8)})`);

        // Build a summary of timestamps and activity
        const toolCalls = run.processLog.filter(l => l.type === 'tool_call');
        const toolResults = run.processLog.filter(l => l.type === 'tool_result');
        const errors = run.processLog.filter(l => l.type === 'error');
        const startTime = new Date(run.startedAt).getTime();
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        const timestampLog = run.processLog.slice(-30).map(l =>
            `[${l.timestamp}] [${l.type}] ${l.content.slice(0, 200)}`
        ).join('\n');

        const checkPrompt = `You are a health-check monitor for an autonomous AI agent. Analyze its activity and decide if it's stuck or making progress.

AGENT: "${run.agentName}"
TASK: ${run.task.slice(0, 500)}
ELAPSED TIME: ${elapsed} seconds
TOOL CALLS SO FAR: ${toolCalls.length}
TOOL RESULTS: ${toolResults.length}
ERRORS: ${errors.length}
ITERATIONS USED: ${run.toolCallCount || 0} / ${MAX_AGENT_TOOL_ITERATIONS}

RECENT ACTIVITY LOG (last 30 entries with timestamps):
${timestampLog}

Based on the timestamps and activity:
- Is the agent making meaningful progress (new tool calls, reading files, running commands)?
- Or is it stuck (repeating the same action, no new activity, errors looping, long gaps between actions)?

Respond with EXACTLY one of:
VERDICT:CONTINUE — if the agent appears to be making progress
VERDICT:CANCEL — if the agent appears stuck, looping, or unresponsive

Then a brief reason on the next line.`;

        try {
            // Create a temporary provider for the health check call
            const pc = run._providerConfig;
            const checkProvider = new AIProvider(
                pc.providerId, pc.provCfg.name, pc.provCfg.apiKey, pc.provCfg.baseUrl
            );
            checkProvider.setModel(pc.modelId);

            const response = await checkProvider.chat(
                [{role: 'system', content: 'You are a concise diagnostic assistant. Respond only with VERDICT and reason.'},
                 {role: 'user', content: checkPrompt}],
                [], null, null
            );
            checkProvider.destroy();

            const text = response.content || '';
            console.log(`[Aether] Health check result for "${run.agentName}": ${text.slice(0, 200)}`);

            if (text.includes('VERDICT:CANCEL')) {
                console.log(`[Aether] Health check: CANCELLING stuck agent "${run.agentName}"`);
                run.processLog.push({
                    type: 'system',
                    timestamp: nowISO(),
                    content: `Health check cancelled agent: ${text.slice(0, 200)}`,
                });

                // Cancel and trigger auto-repair
                if (run.cancellable) run.cancellable.cancel();
                run.state = 'error';
                run.error = `Health check: agent appears stuck after ${elapsed}s`;
                run.completedAt = nowISO();
                if (run.provider) { run.provider.destroy(); run.provider = null; }
                this._writeRunLog(run);
                this._notifyStateChange(run);
                this._attemptAutoRepair(run);
            } else {
                // Agent is making progress — schedule next check
                run.processLog.push({
                    type: 'system',
                    timestamp: nowISO(),
                    content: `Health check: continuing (${elapsed}s elapsed, ${toolCalls.length} tool calls)`,
                });
                this._scheduleHealthCheck(run);
            }
        } catch (healthErr) {
            console.warn(`[Aether] Health check API error (non-fatal): ${healthErr.message}`);
            // If health check itself fails, reschedule anyway
            this._scheduleHealthCheck(run);
        }
    }

    _attemptAutoRepair(run) {
        // Don't repair a repair agent (no infinite loops)
        if (run._isRepairAgent) return;

        // Don't repair if there's already a repair agent for this run
        for (const r of this._runs.values()) {
            if (r._repairTargetRunId === run.id && r.state === 'running')
                return;
        }

        // Git backup before repair
        const extPath = this._extensionPath;
        if (extPath) {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const proc = Gio.Subprocess.new(
                    ['git', '-C', extPath, 'stash', 'push', '-m', `aether-autorepair-backup-${timestamp}`],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.wait(null);
                console.log(`[Aether] Auto-repair git backup created`);
            } catch (gitErr) {
                console.warn(`[Aether] Auto-repair git backup failed (continuing): ${gitErr.message}`);
            }
        }

        // Build the repair task with full context
        const errorSummary = run.error || 'Unknown error';
        const stateDesc = run.state === 'error' && run.error?.includes('max iterations')
            ? 'max_iterations' : 'error';
        const lastAssistant = run.messages.filter(m => m.role === 'assistant').pop();
        const lastAssistantContent = lastAssistant?.content
            ? lastAssistant.content.slice(0, 2000) : '(none)';
        const recentLog = run.processLog.slice(-20)
            .map(l => `[${l.timestamp}] [${l.type}] ${l.content}`).join('\n');
        const logPath = run._logPath || '(log not written)';

        const repairTask = `AUTO-REPAIR TASK: A previous agent failed and needs diagnosis.

ORIGINAL TASK: ${run.task}
ERROR: ${errorSummary}
AGENT STATE: ${stateDesc}
AGENT NAME: ${run.agentName}

EXTENSION SOURCE CODE: ${extPath || '(unknown)'}
  Key files to investigate:
  - ${extPath}/lib/agentManager.js — agent loop, retry logic
  - ${extPath}/lib/aiProvider.js — API call retry
  - ${extPath}/tools/shellCommand.js — command execution
  - ${extPath}/tools/fileOps.js — file operations

LOG FILE: ${logPath}

LAST 20 PROCESS LOG ENTRIES:
${recentLog}

LAST ASSISTANT MESSAGE:
${lastAssistantContent}

INSTRUCTIONS:
1. Read the log file and error details above.
2. Determine the root cause:
   - If it's a CODE BUG in the extension or in code the previous agent wrote: read the relevant source files, diagnose, fix with edit_file. Call finish with: "OUTCOME:fixed REASON:<what you fixed>"
   - If it's a TRANSIENT ERROR (API outage, network timeout, rate limit): Call finish with: "OUTCOME:not_relevant REASON:<explanation>"
   - If you CANNOT FIX IT: Call finish with: "OUTCOME:failed REASON:<what you tried and why it didn't work>"
3. If you make code changes to the extension, the files are at ${extPath}. Changes will take effect after the user re-logs into GNOME.
4. Your finish summary MUST start with one of: "OUTCOME:fixed", "OUTCOME:not_relevant", or "OUTCOME:failed" followed by "REASON:".`;

        // Save the task for potential retry after re-login
        if (this._memory) {
            this._memory.saveTask(run.agentConfigId, run.task, errorSummary)
                .then(() => console.log(`[Aether] Saved failed task for retry`))
                .catch(e => console.warn(`[Aether] Failed to save task: ${e.message}`));
        }

        // Send GNOME notification that repair is starting
        try {
            Main.notify(
                'Aether Auto-Repair',
                `Repairing agent "${run.agentName}": ${errorSummary.slice(0, 100)}`
            );
        } catch { /* notification failure is non-fatal */ }

        // Spawn the repair agent using the same agent config
        this.spawnAgent(run.agentConfigId, repairTask).then(repairRunId => {
            const repairRun = this._runs.get(repairRunId);
            if (repairRun) {
                repairRun._isRepairAgent = true;
                repairRun._repairTargetRunId = run.id;
            }
            console.log(`[Aether] Auto-repair agent spawned: ${repairRunId} for failed run ${run.id}`);
        }).catch(err => {
            console.error(`[Aether] Failed to spawn auto-repair agent: ${err.message}`);
            try {
                Main.notify(
                    'Aether Auto-Repair Failed',
                    `Could not spawn repair agent: ${err.message.slice(0, 100)}`
                );
            } catch { /* notification failure is non-fatal */ }
        });
    }

    _onRepairComplete(repairRun) {
        const originalRun = this._runs.get(repairRun._repairTargetRunId);
        const result = repairRun.result || '';

        // Parse outcome from the repair agent's finish summary
        let outcome = 'failed';
        let reason = result;
        const outcomeMatch = result.match(/OUTCOME:(\w+)/);
        const reasonMatch = result.match(/REASON:([\s\S]*)/);
        if (outcomeMatch) outcome = outcomeMatch[1].toLowerCase();
        if (reasonMatch) reason = reasonMatch[1].trim();

        const originalTask = originalRun
            ? originalRun.task.slice(0, 80) : '(unknown)';

        if (outcome === 'fixed') {
            console.log(`[Aether] Auto-repair succeeded for "${originalTask}": ${reason.slice(0, 200)}`);
            // Mark saved task as retried (no longer pending)
            if (this._memory && originalRun) {
                this._memory.getSavedTasks().then(tasks => {
                    const match = tasks.find(t =>
                        t.agent_config_id === originalRun.agentConfigId
                        && t.task === originalRun.task && t.status === 'pending');
                    if (match)
                        this._memory.updateSavedTaskStatus(match.id, 'retried').catch(() => {});
                }).catch(() => {});
            }
            try {
                Main.notify(
                    'Aether Auto-Repair Succeeded',
                    reason.slice(0, 150)
                );
            } catch { /* non-fatal */ }
        } else if (outcome === 'not_relevant') {
            console.log(`[Aether] Auto-repair: not relevant for "${originalTask}": ${reason.slice(0, 200)}`);
            try {
                Main.notify(
                    'Aether Auto-Repair: Not Relevant',
                    reason.slice(0, 150)
                );
            } catch { /* non-fatal */ }
        } else {
            console.log(`[Aether] Auto-repair failed for "${originalTask}": ${reason.slice(0, 200)}`);
            try {
                Main.notify(
                    'Aether Auto-Repair Failed',
                    reason.slice(0, 150)
                );
            } catch { /* non-fatal */ }
        }
    }

    _writeRunLog(run) {
        try {
            const logsDir = GLib.build_filenamev([getConfigDir(), 'logs']);
            const dir = Gio.File.new_for_path(logsDir);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);

            const date = new Date().toISOString().slice(0, 10);
            const safeAgent = (run.agentName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = `${date}_${safeAgent}_${run.id.slice(0, 8)}.log`;
            const logPath = GLib.build_filenamev([logsDir, filename]);
            run._logPath = logPath;

            const lines = [
                `=== Agent Run Log ===`,
                `Agent: ${run.agentName} (${run.agentConfigId})`,
                `Run ID: ${run.id}`,
                `State: ${run.state}`,
                `Started: ${run.startedAt}`,
                `Completed: ${run.completedAt || 'N/A'}`,
                `Tool calls: ${run.toolCallCount || 0}`,
                `Task: ${run.task}`,
                ``,
                `--- Result ---`,
                run.result || '(no result)',
                ``,
                run.error ? `--- Error ---\n${run.error}\n` : '',
                `--- Process Log (${run.processLog.length} entries) ---`,
                ...run.processLog.map(l => `[${l.timestamp}] [${l.type}] ${l.content}`),
                ``,
                `--- Full Messages (${run.messages.length}) ---`,
                ...run.messages.map(m => {
                    let line = `[${m.role}] `;
                    if (m.content)
                        line += m.content.length > 2000 ? m.content.slice(0, 2000) + '...' : m.content;
                    if (m.tool_calls)
                        line += `\n  tool_calls: ${JSON.stringify(m.tool_calls).slice(0, 1000)}`;
                    if (m.tool_call_id)
                        line += `(tool_call_id: ${m.tool_call_id})`;
                    return line;
                }),
            ];

            const file = Gio.File.new_for_path(logPath);
            const bytes = new TextEncoder().encode(lines.join('\n'));
            file.replace_contents(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            console.log(`[Aether] Agent log saved: ${logPath}`);
        } catch (e) {
            console.error(`[Aether] Failed to write agent log: ${e.message}`);
        }
    }

    _notifyStateChange(run) {
        // Cancel health check timer when agent finishes
        if (run.state !== 'running')
            this._cancelHealthCheck(run);

        // If a repair agent just completed, handle its result
        if (run._isRepairAgent && (run.state === 'completed' || run.state === 'error')) {
            if (run.state === 'completed') {
                this._onRepairComplete(run);
            } else {
                // Repair agent itself errored
                const originalRun = this._runs.get(run._repairTargetRunId);
                const originalTask = originalRun?.task?.slice(0, 80) || '(unknown)';
                console.error(`[Aether] Auto-repair agent itself failed for "${originalTask}": ${run.error}`);
                try {
                    Main.notify(
                        'Aether Auto-Repair Failed',
                        `Repair agent errored: ${(run.error || '').slice(0, 100)}`
                    );
                } catch { /* non-fatal */ }
            }
        }

        if (this._onStateChange)
            this._onStateChange(run.id, run);
    }

    async getSavedTasks() {
        if (!this._memory) return [];
        try {
            return await this._memory.getSavedTasks();
        } catch {
            return [];
        }
    }

    async retryTask(savedTaskId) {
        if (!this._memory) throw new Error('Memory not available');
        const tasks = await this._memory.getSavedTasks();
        const task = tasks.find(t => t.id === savedTaskId);
        if (!task) throw new Error(`Saved task ${savedTaskId} not found`);

        // Mark as retried
        await this._memory.updateSavedTaskStatus(savedTaskId, 'retried');

        // Spawn the agent with the original task
        return this.spawnAgent(task.agent_config_id, task.task);
    }

    async dismissTask(savedTaskId) {
        if (!this._memory) throw new Error('Memory not available');
        await this._memory.updateSavedTaskStatus(savedTaskId, 'dismissed');
    }

    destroy() {
        for (const run of this._runs.values()) {
            if (run.cancellable)
                run.cancellable.cancel();
            if (run.provider) {
                run.provider.destroy();
                run.provider = null;
            }
        }
        this._runs.clear();
        this._onStateChange = null;
    }
}
