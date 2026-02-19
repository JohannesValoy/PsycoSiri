import {sqlEscape} from './utils.js';

export class TodoManager {
    constructor(memory) {
        this._memory = memory;
    }

    async add(content, priority = 5) {
        await this._memory._exec(
            `INSERT INTO todos (content, priority) VALUES (${sqlEscape(content)}, ${priority});`
        );
        // Return the new ID
        const rows = await this._memory._query('SELECT last_insert_rowid() as id;');
        return rows[0]?.id ?? -1;
    }

    async list(status = null) {
        let sql = 'SELECT * FROM todos';
        if (status)
            sql += ` WHERE status = ${sqlEscape(status)}`;
        sql += ' ORDER BY priority DESC, created_at ASC;';
        return this._memory._query(sql);
    }

    async update(id, fields) {
        const sets = [];
        if (fields.content !== undefined)
            sets.push(`content = ${sqlEscape(fields.content)}`);
        if (fields.status !== undefined) {
            sets.push(`status = ${sqlEscape(fields.status)}`);
            if (fields.status === 'completed')
                sets.push(`completed_at = datetime('now')`);
        }
        if (fields.priority !== undefined)
            sets.push(`priority = ${parseInt(fields.priority)}`);

        if (sets.length === 0)
            return;

        await this._memory._exec(
            `UPDATE todos SET ${sets.join(', ')} WHERE id = ${parseInt(id)};`
        );
    }

    async complete(id) {
        await this.update(id, {status: 'completed'});
    }

    async remove(id) {
        await this._memory._exec(`DELETE FROM todos WHERE id = ${parseInt(id)};`);
    }

    async getActive() {
        return this._memory._query(
            `SELECT * FROM todos WHERE status != 'completed'
             ORDER BY priority DESC, created_at ASC;`
        );
    }

    async formatForPrompt() {
        const todos = await this.getActive();
        if (todos.length === 0)
            return 'No active todos.';
        return todos.map((t, i) =>
            `${i + 1}. [${t.status}] (p${t.priority}) ${t.content}`
        ).join('\n');
    }
}
