import Gio from 'gi://Gio';
import {AIProvider} from './aiProvider.js';
import {nowISO, generateSessionId} from './utils.js';

const MAX_AGENT_TOOL_ITERATIONS = 50;

export class AgentManager {
    constructor(settings, toolRegistry) {
        this._settings = settings;
        this._toolRegistry = toolRegistry;
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

    spawnAgent(agentConfigId, task) {
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
        const defaultPrompt = `You are a background AI agent. Complete the assigned task thoroughly.

IMPORTANT WORKFLOW:
1. FIRST, call the plan_tasks tool with a list of steps you will take. This creates your task plan.
2. THEN, work through each step one by one using the available tools.
3. After completing each step, call complete_task with the step index to mark it done.
4. Continue until all tasks are complete, then give your final summary.

Always plan before acting. Never skip the planning step.`;

        const systemPrompt = (agentCfg.systemPrompt || defaultPrompt)
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
        };

        this._runs.set(runId, run);
        this._notifyStateChange(run);

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
        return null;
    }

    async _executeAgentLoop(run) {
        const agentTodoNames = new Set(['plan_tasks', 'complete_task']);

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

                const response = await run.provider.chat(
                    apiMessages, tools, null, run.cancellable
                );

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
                    this._notifyStateChange(run);
                    return;
                }

                // Execute tool calls
                for (const tc of response.tool_calls) {
                    let toolArgs = {};
                    try {
                        toolArgs = JSON.parse(tc.function.arguments);
                    } catch {}

                    const argsPreview = JSON.stringify(toolArgs);
                    run.processLog.push({
                        type: 'tool_call',
                        timestamp: nowISO(),
                        content: `${tc.function.name}(${argsPreview.length > 200 ? argsPreview.slice(0, 200) + '...' : argsPreview})`,
                    });
                    this._notifyStateChange(run);

                    // Handle agent-scoped todo tools locally
                    let toolResult;
                    if (agentTodoNames.has(tc.function.name)) {
                        toolResult = this._executeAgentTodo(run, tc.function.name, toolArgs);
                    } else {
                        toolResult = await this._toolRegistry.execute(tc.function.name, toolArgs);
                    }

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
                        content: toolResult,
                    });
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
            this._notifyStateChange(run);

        } catch (e) {
            const errorMsg = e.message || String(e);
            const isCancelled = errorMsg.includes('ancelled') || errorMsg.includes('IOErrorEnum');
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
                this._notifyStateChange(run);
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

    _notifyStateChange(run) {
        if (this._onStateChange)
            this._onStateChange(run.id, run);
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
