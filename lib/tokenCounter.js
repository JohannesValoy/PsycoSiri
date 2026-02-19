/**
 * Approximate token counter for LLM context management.
 * Since tiktoken isn't available in GJS, we use heuristics.
 */

const CHARS_PER_TOKEN = 4;
const TOKENS_PER_MESSAGE_OVERHEAD = 4; // role, separators, etc.

/**
 * Estimate token count for a plain text string.
 */
export function estimateTokens(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate token count for a single chat message.
 */
export function estimateMessageTokens(message) {
    let tokens = TOKENS_PER_MESSAGE_OVERHEAD;
    tokens += estimateTokens(message.content || '');

    if (message.tool_calls) {
        const calls = typeof message.tool_calls === 'string'
            ? message.tool_calls
            : JSON.stringify(message.tool_calls);
        tokens += estimateTokens(calls);
    }

    return tokens;
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateTotalTokens(messages) {
    let total = 3; // priming tokens
    for (const msg of messages)
        total += estimateMessageTokens(msg);
    return total;
}

/**
 * Check if we've exceeded a threshold of the context window.
 */
export function isOverThreshold(messages, maxTokens, threshold = 0.7) {
    const current = estimateTotalTokens(messages);
    return current > maxTokens * threshold;
}
