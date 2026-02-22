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
        } else {
            await this._migrateIfNeeded();
        }
    }

    async _migrateIfNeeded() {
        // Add 'agent_learning' type if the CHECK constraint doesn't include it.
        // SQLite doesn't support ALTER CHECK, so we recreate the table.
        try {
            const schema = await this._exec(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories';"
            );
            if (!schema.includes('agent_learning')) {
                await this._exec(`
                    BEGIN TRANSACTION;
                    ALTER TABLE memories RENAME TO _memories_old;
                    CREATE TABLE memories (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        type TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'procedure', 'note', 'agent_learning')),
                        content TEXT NOT NULL,
                        keywords TEXT,
                        created_at TEXT DEFAULT (datetime('now')),
                        updated_at TEXT DEFAULT (datetime('now')),
                        importance INTEGER DEFAULT 5
                    );
                    INSERT INTO memories SELECT * FROM _memories_old;
                    DROP TABLE _memories_old;
                    CREATE INDEX IF NOT EXISTS idx_memories_keywords ON memories(keywords);
                    COMMIT;
                `);
            }
        } catch (e) {
            console.error(`[Aether] Memory migration error: ${e.message}`);
        }

        // Ensure saved_tasks table exists (runs every init, CREATE IF NOT EXISTS is idempotent)
        try {
            await this._exec(`
                CREATE TABLE IF NOT EXISTS saved_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_config_id TEXT NOT NULL,
                    task TEXT NOT NULL,
                    error TEXT,
                    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'retried', 'dismissed')),
                    created_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_saved_tasks_status ON saved_tasks(status);
            `);
        } catch (e) {
            console.error(`[Aether] saved_tasks migration error: ${e.message}`);
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

    async getSessionList(limit = 30) {
        return this._query(
            `SELECT c.session_id,
                    MIN(c.created_at) as started_at,
                    COUNT(*) as message_count,
                    (SELECT content FROM conversations c2
                     WHERE c2.session_id = c.session_id AND c2.role = 'user'
                     ORDER BY c2.created_at ASC LIMIT 1) as first_message
             FROM conversations c
             GROUP BY c.session_id
             ORDER BY started_at DESC
             LIMIT ${limit};`
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

    // --- Saved Tasks (for retry after re-login) ---

    async saveTask(agentConfigId, task, error = '') {
        const sql = `INSERT INTO saved_tasks (agent_config_id, task, error)
            VALUES (${sqlEscape(agentConfigId)}, ${sqlEscape(task)}, ${sqlEscape(error)});`;
        await this._exec(sql);
    }

    async getSavedTasks() {
        return this._query(
            `SELECT * FROM saved_tasks WHERE status = 'pending' ORDER BY created_at DESC;`
        );
    }

    async updateSavedTaskStatus(id, status) {
        await this._exec(
            `UPDATE saved_tasks SET status = ${sqlEscape(status)} WHERE id = ${parseInt(id)};`
        );
    }

    async deleteSavedTask(id) {
        await this._exec(`DELETE FROM saved_tasks WHERE id = ${parseInt(id)};`);
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
