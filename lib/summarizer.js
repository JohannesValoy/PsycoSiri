import {estimateTotalTokens, isOverThreshold, estimateTokens} from './tokenCounter.js';

const KEEP_RECENT_MESSAGES = 10;

const SUMMARIZE_PROMPT = `Summarize the following conversation history concisely. Preserve:
- Key facts and decisions made
- Important context about the user's goals
- Results of any tool calls
- Any unresolved questions or ongoing tasks

Be thorough but concise. This summary will replace the original messages to save context space.`;

const AGENT_KEEP_FIRST = 4;   // user task + plan_tasks + result + first assistant
const AGENT_KEEP_RECENT = 20;

const AGENT_SUMMARIZE_PROMPT = `Summarize the following section of an AI agent's work history. Preserve:
- Key actions taken and their results
- Files created, modified, or read (with paths)
- Commands run and their outcomes
- Errors encountered and how they were resolved
- Current state of the task and what remains to be done

Be thorough but concise. This summary replaces the original messages to save context.`;

export class ContextSummarizer {
    constructor(providerManager, memory, settings) {
        this._providerManager = providerManager;
        this._memory = memory;
        this._settings = settings;
    }

    /**
     * Check if summarization is needed and perform it (main conversation).
     */
    async checkAndSummarize(conversation) {
        if (!this._settings.get_boolean('auto-summarize'))
            return;

        // Use per-model maxContext from registry if available
        const maxTokens = this._providerManager.activeMaxContext
            || this._settings.get_int('max-context-tokens');
        const threshold = this._settings.get_double('summarize-threshold');
        const messages = conversation.messages;

        if (!isOverThreshold(messages, maxTokens, threshold))
            return;

        if (messages.length <= KEEP_RECENT_MESSAGES)
            return; // Not enough messages to summarize

        const provider = this._providerManager.active;
        if (!provider)
            return;

        // Split messages: old ones to summarize, recent ones to keep
        const oldMessages = messages.slice(0, -KEEP_RECENT_MESSAGES);
        const oldTokens = estimateTotalTokens(oldMessages);

        // Format old messages for summarization
        const conversationText = oldMessages.map(m => {
            let line = `[${m.role}]: ${m.content || ''}`;
            if (m.tool_calls)
                line += `\n  Tool calls: ${JSON.stringify(m.tool_calls)}`;
            return line;
        }).join('\n');

        // Ask the AI to summarize
        const summaryResponse = await provider.chat([
            {role: 'system', content: SUMMARIZE_PROMPT},
            {role: 'user', content: conversationText},
        ]);

        const summary = summaryResponse.content;
        const newTokens = estimateTokens(summary);
        const tokensSaved = oldTokens - newTokens;

        // Store the summary in the database
        await this._memory.storeSummary(
            conversation.sessionId,
            summary,
            oldMessages.length,
            tokensSaved
        );

        // Apply the summary to the conversation
        conversation.applySummary(summary, KEEP_RECENT_MESSAGES);

        log(`[Aether] Summarized ${oldMessages.length} messages, saved ~${tokensSaved} tokens`);
    }

    /**
     * Summarize agent messages when context exceeds the model's limit.
     * Mutates the messages array in place.
     *
     * @param {AIProvider} provider - The agent's AI provider
     * @param {Array} messages - The agent's message array (mutated in place)
     * @param {number} maxContext - The model's max context window in tokens
     * @param {number} threshold - Fraction of maxContext to trigger (0.0-1.0)
     * @returns {boolean} Whether summarization was performed
     */
    static async summarizeAgentContext(provider, messages, maxContext, threshold = 0.7) {
        if (!isOverThreshold(messages, maxContext, threshold))
            return false;

        const minMessages = AGENT_KEEP_FIRST + AGENT_KEEP_RECENT;
        if (messages.length <= minMessages)
            return false;

        const keepFirst = Math.min(AGENT_KEEP_FIRST, messages.length);
        const keepRecent = Math.min(AGENT_KEEP_RECENT, messages.length - keepFirst);

        const firstMessages = messages.slice(0, keepFirst);
        const middleMessages = messages.slice(keepFirst, messages.length - keepRecent);
        const recentMessages = messages.slice(messages.length - keepRecent);

        if (middleMessages.length === 0)
            return false;

        // Format middle messages for the summarization request
        const conversationText = middleMessages.map(m => {
            let line = `[${m.role}]`;
            if (m.role === 'tool') {
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                line += `: ${content.length > 500 ? content.slice(0, 500) + '...' : content}`;
            } else if (Array.isArray(m.content)) {
                // Multimodal — extract text, note images
                const texts = m.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
                const imgCount = m.content.filter(p => p.type === 'image_url').length;
                line += `: ${texts}${imgCount > 0 ? ` [${imgCount} image(s)]` : ''}`;
            } else {
                line += `: ${m.content || ''}`;
            }
            if (m.tool_calls)
                line += `\n  Tool calls: ${JSON.stringify(m.tool_calls).slice(0, 300)}`;
            return line;
        }).join('\n');

        const summaryResponse = await provider.chat([
            {role: 'system', content: AGENT_SUMMARIZE_PROMPT},
            {role: 'user', content: conversationText},
        ]);

        const summary = summaryResponse.content;
        const oldTokens = estimateTotalTokens(middleMessages);
        const newTokens = estimateTokens(summary);

        console.log(`[Aether] Agent summarization: ${middleMessages.length} msgs (${oldTokens} tok) → summary (${newTokens} tok), saved ~${oldTokens - newTokens}`);

        const summaryMessage = {
            role: 'user',
            content: `[CONTEXT SUMMARY — ${middleMessages.length} messages compressed]\n${summary}`,
        };

        // Mutate in place
        messages.length = 0;
        messages.push(...firstMessages, summaryMessage, ...recentMessages);
        return true;
    }
}
