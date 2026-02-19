import {estimateTotalTokens, isOverThreshold, estimateTokens} from './tokenCounter.js';

const KEEP_RECENT_MESSAGES = 10;

const SUMMARIZE_PROMPT = `Summarize the following conversation history concisely. Preserve:
- Key facts and decisions made
- Important context about the user's goals
- Results of any tool calls
- Any unresolved questions or ongoing tasks

Be thorough but concise. This summary will replace the original messages to save context space.`;

export class ContextSummarizer {
    constructor(providerManager, memory, settings) {
        this._providerManager = providerManager;
        this._memory = memory;
        this._settings = settings;
    }

    /**
     * Check if summarization is needed and perform it.
     */
    async checkAndSummarize(conversation) {
        if (!this._settings.get_boolean('auto-summarize'))
            return;

        const maxTokens = this._settings.get_int('max-context-tokens');
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
}
