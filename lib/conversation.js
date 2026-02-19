import Gio from 'gi://Gio';
import {estimateMessageTokens} from './tokenCounter.js';
import {nowISO} from './utils.js';

const MAX_TOOL_ITERATIONS = 10;

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
        const basePrompt = this._settings.get_string('system-prompt');
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
     * Build the messages array for the API call.
     */
    async _buildApiMessages() {
        const systemPrompt = await this._buildSystemPrompt();
        return [
            {role: 'system', content: systemPrompt},
            ...this._messages,
        ];
    }

    /**
     * Send a user message and get the AI response.
     * @param {string} userInput - The user's message
     * @param {Function} onChunk - Callback for streamed text chunks
     * @returns {Promise<string>} The final assistant response
     */
    async send(userInput, onChunk = null) {
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

        // Cancel any previous in-flight request
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        const provider = this._providerManager.active;
        if (!provider)
            throw new Error('No active AI provider configured. Open Aether settings to add one.');

        const tools = this._toolRegistry.getToolSchemas();
        let finalContent = '';
        let iterations = 0;

        // Tool call loop: keep going while the AI wants to call tools
        while (iterations < MAX_TOOL_ITERATIONS) {
            iterations++;

            const apiMessages = await this._buildApiMessages();

            // Always pass onChunk — we want to stream every response,
            // especially the final one after tool calls complete.
            const response = await provider.chat(apiMessages, tools, onChunk, this._cancellable);

            // Add assistant message
            const assistantMsg = {role: 'assistant', content: response.content || ''};
            if (response.tool_calls && response.tool_calls.length > 0)
                assistantMsg.tool_calls = response.tool_calls;
            this._messages.push(assistantMsg);

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

                const toolResult = await this._toolRegistry.execute(tc.function.name, toolArgs);

                // Add tool result message
                this._messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: toolResult,
                });
            }

            // After executing tools, the loop continues — the AI will
            // see the tool results and can decide to call more tools
            // or produce a final text response. onChunk is preserved
            // so streaming works for the final answer.
        }

        // Store assistant response
        try {
            await this._memory.storeMessage(
                this._sessionId, 'assistant', finalContent, null,
                estimateMessageTokens({content: finalContent})
            );
        } catch (e) {
            console.error(`[Aether] Memory store error (non-fatal): ${e.message}`);
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
}
