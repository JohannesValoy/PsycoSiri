import Gio from 'gi://Gio';
import {estimateMessageTokens} from './tokenCounter.js';
import {nowISO} from './utils.js';

const MAX_TOOL_ITERATIONS = 10;
const DEFAULT_SYSTEM_PROMPT = 'You are Aether, an AI assistant embedded in the GNOME desktop on Fedora. You have access to tools to execute commands, manage files, search the web, and more. Always be concise.';

export class Conversation {
    constructor(sessionId, providerManager, toolRegistry, memory, todoManager, summarizer, settings) {
        this._sessionId = sessionId;
        this._providerManager = providerManager;
        this._toolRegistry = toolRegistry;
        this._memory = memory;
        this._todoManager = todoManager;
        this._summarizer = summarizer;
        this._settings = settings;

        this._messages = [];
        this._summary = '';
        this._cancellable = null;
    }

    get messages() {
        return this._messages;
    }

    get sessionId() {
        return this._sessionId;
    }

    /**
     * Build the system prompt with dynamic context.
     */
    async _buildSystemPrompt() {
        // Use custom prompt if set, otherwise fall back to default
        const customPrompt = this._settings.get_string('custom-main-prompt');
        let basePrompt = customPrompt || this._settings.get_string('system-prompt') || DEFAULT_SYSTEM_PROMPT;

        // Add agent names list if enabled
        const includeAgents = this._settings.get_boolean('include-agents-in-prompt');
        if (includeAgents) {
            const agentNamesText = await this._getAvailableAgentNames();
            if (agentNamesText) {
                basePrompt += `\n\nAvailable agents that can be spawned:\n${agentNamesText}`;
            }
        }

        const todosText = await this._todoManager.formatForPrompt();

        // Retrieve relevant memories (use last user message as query)
        let memoriesText = '';
        const lastUserMsg = [...this._messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
            try {
                const memories = await this._memory.recall(lastUserMsg.content, 5);
                if (memories.length > 0) {
                    memoriesText = memories.map(m =>
                        `[${m.type}] ${m.content}`
                    ).join('\n');
                }
            } catch {
                // Memory recall failure is non-fatal
            }
        }

        let prompt = basePrompt;
        prompt += `\n\nCurrent date and time: ${nowISO()}`;
        prompt += `\n\nActive todos:\n${todosText}`;
        if (memoriesText)
            prompt += `\n\nRelevant memories:\n${memoriesText}`;
        if (this._summary)
            prompt += `\n\nPrevious conversation summary:\n${this._summary}`;

        return prompt;
    }

    /**
     * Get a formatted list of available agent names.
     */
    async _getAvailableAgentNames() {
        try {
            const agentConfigs = JSON.parse(this._settings.get_string('agent-configs') || '{}');
            const agentIds = Object.keys(agentConfigs);

            if (agentIds.length === 0) {
                return '';
            }

            // Format: "- agent_name (id): brief description from system prompt"
            const agentList = agentIds.map(id => {
                const cfg = agentConfigs[id];
                const name = cfg.name || id;
                // Extract a brief description from the system prompt (first sentence or first line)
                let description = '';
                if (cfg.systemPrompt) {
                    const firstLine = cfg.systemPrompt.split(/[.\n]/)[0];
                    description = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
                }
                const desc = description ? ` - ${description}` : '';
                return `- ${name} (${id})${desc}`;
            });

            return agentList.join('\n');
        } catch (e) {
            console.error(`[Aether] Error getting agent names: ${e.message}`);
            return '';
        }
    }

    /**
     * Build the messages array for the API call.
     */
    async _buildApiMessages() {
        const systemPrompt = await this._buildSystemPrompt();

        // Validate: ensure every assistant tool_call has a matching tool response
        const msgs = [...this._messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
                const expectedIds = new Set(m.tool_calls.map(tc => tc.id));
                // Check following messages for matching tool results
                for (let j = i + 1; j < msgs.length && expectedIds.size > 0; j++) {
                    if (msgs[j].role === 'tool' && expectedIds.has(msgs[j].tool_call_id))
                        expectedIds.delete(msgs[j].tool_call_id);
                }
                if (expectedIds.size > 0) {
                    // Strip tool_calls from this message to avoid 422
                    console.log(`[Aether] _buildApiMessages: removing ${expectedIds.size} orphaned tool_calls`);
                    msgs[i] = {role: 'assistant', content: m.content || '(tool call interrupted)'};
                    // Also remove any orphaned tool results that referenced this message
                    for (let j = msgs.length - 1; j > i; j--) {
                        if (msgs[j].role === 'tool' && m.tool_calls.some(tc => tc.id === msgs[j].tool_call_id))
                            msgs.splice(j, 1);
                    }
                }
            }
        }

        return [
            {role: 'system', content: systemPrompt},
            ...msgs,
        ];
    }

    /**
     * Send a user message and get the AI response.
     * @param {string} userInput - The user's message
     * @param {Function} onChunk - Callback for streamed text chunks
     * @returns {Promise<string>} The final assistant response
     */
    async send(userInput, onChunk = null) {
        const _t0 = Date.now();
        // Add user message
        this._messages.push({role: 'user', content: userInput});
        try {
            await this._memory.storeMessage(
                this._sessionId, 'user', userInput, null,
                estimateMessageTokens({content: userInput})
            );
        } catch (e) {
            console.error(`[Aether] Memory store error (non-fatal): ${e.message}`);
        }
        console.log(`[Aether][TIMING] storeMessage: ${Date.now() - _t0}ms`);

        // Cancel any previous in-flight request
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        const provider = this._providerManager.active;
        if (!provider)
            throw new Error('No active AI provider configured. Open Aether settings to add one.');

        const tools = this._toolRegistry.getToolSchemas();
        console.log(`[Aether][TIMING] setup: ${Date.now() - _t0}ms, tools: ${tools.length}`);
        let finalContent = '';
        let iterations = 0;

        // Tool call loop: keep going while the AI wants to call tools
        while (iterations < MAX_TOOL_ITERATIONS) {
            iterations++;

            const _t1 = Date.now();
            const apiMessages = await this._buildApiMessages();
            console.log(`[Aether][TIMING] buildApiMessages: ${Date.now() - _t1}ms, msgs: ${apiMessages.length}`);

            // Always pass onChunk — we want to stream every response,
            // especially the final one after tool calls complete.
            let response;
            const _t2 = Date.now();
            try {
                response = await provider.chat(apiMessages, tools, onChunk, this._cancellable);
            } catch (primaryErr) {
                // Try backup provider if configured and different from primary
                const backupProvider = this._providerManager.backup;
                if (backupProvider && backupProvider !== provider) {
                    console.log(`[Aether] Primary provider failed: ${(primaryErr.message || '').slice(0, 100)} — falling back to backup`);
                    try {
                        response = await backupProvider.chat(apiMessages, tools, onChunk, this._cancellable);
                    } catch (backupErr) {
                        throw new Error(
                            `Primary failed: ${(primaryErr.message || '').slice(0, 150)}. ` +
                            `Backup also failed: ${(backupErr.message || '').slice(0, 150)}`
                        );
                    }
                } else {
                    throw primaryErr;
                }
            }

            console.log(`[Aether][TIMING] provider.chat: ${Date.now() - _t2}ms`);

            // Add assistant message
            const assistantMsg = {role: 'assistant', content: response.content || ''};
            if (response.tool_calls && response.tool_calls.length > 0)
                assistantMsg.tool_calls = response.tool_calls;
            this._messages.push(assistantMsg);

            // Store assistant message (including tool_calls if present)
            try {
                await this._memory.storeMessage(
                    this._sessionId, 'assistant', response.content || '',
                    assistantMsg.tool_calls || null,
                    estimateMessageTokens({content: response.content || ''})
                );
            } catch (e) {
                console.error(`[Aether] Memory store error (non-fatal): ${e.message}`);
            }

            // If no tool calls, we're done — this is the final response
            if (!response.tool_calls || response.tool_calls.length === 0) {
                finalContent = response.content || '';
                break;
            }

            // Execute tool calls
            for (const tc of response.tool_calls) {
                let toolArgs = {};
                try {
                    toolArgs = JSON.parse(tc.function.arguments);
                } catch {
                    toolArgs = {};
                }

                let toolResult;
                try {
                    toolResult = await this._toolRegistry.execute(tc.function.name, toolArgs);
                } catch (e) {
                    toolResult = JSON.stringify({error: `Tool execution failed: ${e.message}`});
                }

                // Add tool result message
                this._messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: toolResult,
                });

                // Store tool result message
                try {
                    await this._memory.storeMessage(
                        this._sessionId, 'tool', toolResult, null, 0, tc.id
                    );
                } catch (e) {
                    console.error(`[Aether] Memory store error (non-fatal): ${e.message}`);
                }
            }

            // After executing tools, the loop continues — the AI will
            // see the tool results and can decide to call more tools
            // or produce a final text response. onChunk is preserved
            // so streaming works for the final answer.
        }

        // Auto-summarize if needed
        try {
            await this._summarizer.checkAndSummarize(this);
        } catch (e) {
            console.error(`[Aether] Summarization error: ${e.message}`);
        }

        return finalContent;
    }

    /**
     * Called by the summarizer when context is compressed.
     */
    applySummary(summary, keepCount) {
        this._summary = summary;
        // Keep only the most recent messages
        if (keepCount < this._messages.length)
            this._messages = this._messages.slice(-keepCount);
    }

    /**
     * Remove trailing assistant messages with tool_calls that have no
     * matching tool result messages. This prevents HTTP 422 errors from
     * the API when a session is restored after an interrupted tool call.
     */
    _stripOrphanedToolCalls() {
        // Walk backwards from the end of messages
        while (this._messages.length > 0) {
            const last = this._messages[this._messages.length - 1];
            if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
                // Check if all tool_call_ids have matching tool responses
                const expectedIds = new Set(last.tool_calls.map(tc => tc.id));
                // Look at messages after this assistant message (there are none since it's last)
                // So this is definitely orphaned — remove it
                console.log(`[Aether] Stripping orphaned assistant message with ${expectedIds.size} unresolved tool_calls`);
                this._messages.pop();
            } else if (last.role === 'tool') {
                // Orphaned tool result without its preceding assistant message — remove
                // (this shouldn't happen, but be safe)
                const hasParent = this._messages.some(m =>
                    m.role === 'assistant' && m.tool_calls &&
                    m.tool_calls.some(tc => tc.id === last.tool_call_id)
                );
                if (!hasParent) {
                    console.log(`[Aether] Stripping orphaned tool message (tool_call_id: ${last.tool_call_id})`);
                    this._messages.pop();
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    /**
     * Cancel the current in-flight request.
     */
    cancel() {
        if (this._cancellable)
            this._cancellable.cancel();
    }

    /**
     * Reset conversation state for a new session.
     */
    reset(newSessionId) {
        this._sessionId = newSessionId;
        this._messages = [];
        this._summary = '';
        this.cancel();
    }

    /**
     * Restore a previous session from the database.
     * Loads messages and summary back into memory for continued conversation.
     */
    async restoreSession(sessionId) {
        this._sessionId = sessionId;
        this._messages = [];
        this._summary = '';

        // Restore summary if available
        try {
            const summary = await this._memory.getLatestSummary(sessionId);
            if (summary)
                this._summary = summary.summary;
        } catch {
            // Non-fatal
        }

        // Restore messages
        try {
            const rows = await this._memory.getRecentConversations(sessionId, 200);
            for (const row of rows) {
                const msg = {role: row.role, content: row.content};
                if (row.tool_calls) {
                    try {
                        msg.tool_calls = JSON.parse(row.tool_calls);
                    } catch {
                        // Ignore malformed tool_calls
                    }
                }
                if (row.tool_call_id)
                    msg.tool_call_id = row.tool_call_id;
                this._messages.push(msg);
            }

            // Safety: strip any trailing assistant message with tool_calls
            // that has no matching tool responses (prevents 422 errors)
            this._stripOrphanedToolCalls();
        } catch (e) {
            console.error(`[Aether] Failed to restore session ${sessionId}: ${e.message}`);
        }
    }
}
