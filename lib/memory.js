import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {runSubprocess, sqlEscape, readFileAsync, getConfigDir} from './utils.js';

export class MemoryManager {
    constructor(dbPath, extensionPath) {
        this._dbPath = dbPath;
        this._extensionPath = extensionPath;
    }

    async init() {
        // Ensure config directory exists
        getConfigDir();

        // Check if DB exists; if not, initialize schema
        const dbFile = Gio.File.new_for_path(this._dbPath);
        if (!dbFile.query_exists(null)) {
            const sqlPath = GLib.build_filenamev([this._extensionPath, 'data', 'init.sql']);
            const sql = await readFileAsync(sqlPath);
            await this._exec(sql);
        }
    }

    /**
     * Execute raw SQL against the database.
     */
    async _exec(sql) {
        const {stdout, stderr, exitStatus} = await runSubprocess(
            ['sqlite3', this._dbPath],
            sql
        );
        if (exitStatus !== 0)
            throw new Error(`sqlite3 error: ${stderr}`);
        return stdout;
    }

    /**
     * Execute SQL and return results as JSON array.
     */
    async _query(sql) {
        const {stdout, stderr, exitStatus} = await runSubprocess(
            ['sqlite3', '-json', this._dbPath, sql]
        );
        if (exitStatus !== 0)
            throw new Error(`sqlite3 error: ${stderr}`);
        if (!stdout.trim())
            return [];
        try {
            return JSON.parse(stdout);
        } catch {
            return [];
        }
    }

    // --- Memories ---

    async store(type, content, keywords = '', importance = 5) {
        const sql = `INSERT INTO memories (type, content, keywords, importance)
            VALUES (${sqlEscape(type)}, ${sqlEscape(content)}, ${sqlEscape(keywords)}, ${importance});`;
        await this._exec(sql);
    }

    async recall(query, limit = 10) {
        const escaped = sqlEscape(`%${query}%`);
        const sql = `SELECT * FROM memories
            WHERE content LIKE ${escaped} OR keywords LIKE ${escaped}
            ORDER BY importance DESC, created_at DESC
            LIMIT ${limit};`;
        return this._query(sql);
    }

    async getAllMemories(limit = 50) {
        return this._query(
            `SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ${limit};`
        );
    }

    async deleteMemory(id) {
        await this._exec(`DELETE FROM memories WHERE id = ${parseInt(id)};`);
    }

    // --- Conversations ---

    async storeMessage(sessionId, role, content, toolCalls = null, tokenEstimate = 0) {
        const tcJson = toolCalls ? sqlEscape(JSON.stringify(toolCalls)) : 'NULL';
        const sql = `INSERT INTO conversations (session_id, role, content, tool_calls, token_estimate)
            VALUES (${sqlEscape(sessionId)}, ${sqlEscape(role)}, ${sqlEscape(content)}, ${tcJson}, ${tokenEstimate});`;
        await this._exec(sql);
    }

    async getRecentConversations(sessionId, limit = 50) {
        return this._query(
            `SELECT * FROM conversations WHERE session_id = ${sqlEscape(sessionId)}
             ORDER BY created_at ASC LIMIT ${limit};`
        );
    }

    // --- Context Summaries ---

    async storeSummary(sessionId, summary, messagesSummarized, tokensSaved) {
        const sql = `INSERT INTO context_summaries (session_id, summary, messages_summarized, tokens_saved)
            VALUES (${sqlEscape(sessionId)}, ${sqlEscape(summary)}, ${messagesSummarized}, ${tokensSaved});`;
        await this._exec(sql);
    }

    async getLatestSummary(sessionId) {
        const rows = await this._query(
            `SELECT * FROM context_summaries WHERE session_id = ${sqlEscape(sessionId)}
             ORDER BY created_at DESC LIMIT 1;`
        );
        return rows.length > 0 ? rows[0] : null;
    }

    // --- Export / Import ---

    async exportJSON(outputPath) {
        const memories = await this._query('SELECT * FROM memories;');
        const todos = await this._query('SELECT * FROM todos;');
        const conversations = await this._query('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 500;');
        const summaries = await this._query('SELECT * FROM context_summaries;');

        const data = JSON.stringify({memories, todos, conversations, summaries}, null, 2);
        const file = Gio.File.new_for_path(outputPath);
        file.replace_contents(
            new TextEncoder().encode(data),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        );
    }

    async importJSON(inputPath) {
        const contents = await readFileAsync(inputPath);
        const data = JSON.parse(contents);

        if (data.memories) {
            for (const m of data.memories)
                await this.store(m.type, m.content, m.keywords || '', m.importance || 5);
        }
        if (data.todos) {
            for (const t of data.todos) {
                await this._exec(
                    `INSERT INTO todos (content, status, priority) VALUES
                    (${sqlEscape(t.content)}, ${sqlEscape(t.status || 'pending')}, ${t.priority || 5});`
                );
            }
        }
    }
}
