import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class ReadFileTool {
    constructor() {
        this.name = 'read_file';
        this.description = 'Read the contents of a file. Supports reading specific line ranges with offset and max_lines for efficient partial reads of large files.';
        this.parameters = {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Absolute path to the file'},
                offset: {type: 'number', description: 'Start reading from this line number (0-based, default: 0)'},
                max_lines: {type: 'number', description: 'Max lines to read (default: all)'},
                line_numbers: {description: 'Prefix each line with its line number (default: false). Pass true or false.'},
            },
            required: ['path'],
        };
    }

    execute(args) {
        return new Promise((resolve, reject) => {
            const file = Gio.File.new_for_path(args.path);
            file.load_contents_async(null, (source, result) => {
                try {
                    const [ok, contents] = source.load_contents_finish(result);
                    if (!ok) {
                        resolve(JSON.stringify({error: `Failed to read ${args.path}`}));
                        return;
                    }
                    let text = new TextDecoder().decode(contents);
                    const allLines = text.split('\n');
                    const totalLines = allLines.length;

                    const offset = args.offset || 0;
                    const maxLines = args.max_lines || totalLines;
                    const sliced = allLines.slice(offset, offset + maxLines);

                    if (args.line_numbers === true || args.line_numbers === 'true') {
                        text = sliced.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
                    } else {
                        text = sliced.join('\n');
                    }

                    // Show context about what was read
                    const endLine = Math.min(offset + maxLines, totalLines);
                    if (offset > 0 || endLine < totalLines)
                        text += `\n--- (showing lines ${offset + 1}-${endLine} of ${totalLines}) ---`;

                    // Truncate very large output
                    if (text.length > 50000)
                        text = text.slice(0, 50000) + '\n... (truncated)';

                    resolve(text);
                } catch (e) {
                    resolve(JSON.stringify({error: e.message}));
                }
            });
        });
    }
}

export class EditFileTool {
    constructor() {
        this.name = 'edit_file';
        this.description = 'Edit a file by finding and replacing specific text. Much more reliable than rewriting entire files. Supports multiple replacements in one call. Use read_file with line_numbers first to see the exact text to replace.';
        this.parameters = {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Absolute path to the file'},
                edits: {
                    type: 'array',
                    description: 'Array of {old_string, new_string} replacements to apply in order',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: {type: 'string', description: 'Exact text to find (must match exactly, including whitespace)'},
                            new_string: {type: 'string', description: 'Text to replace it with'},
                        },
                        required: ['old_string', 'new_string'],
                    },
                },
            },
            required: ['path', 'edits'],
        };
    }

    execute(args) {
        return new Promise((resolve) => {
            try {
                const file = Gio.File.new_for_path(args.path);

                if (!file.query_exists(null)) {
                    resolve(JSON.stringify({error: `File not found: ${args.path}`}));
                    return;
                }

                const [ok, contents] = file.load_contents(null);
                if (!ok) {
                    resolve(JSON.stringify({error: `Failed to read ${args.path}`}));
                    return;
                }

                let text = new TextDecoder().decode(contents);
                const results = [];

                for (let i = 0; i < args.edits.length; i++) {
                    const {old_string, new_string} = args.edits[i];
                    const idx = text.indexOf(old_string);
                    if (idx === -1) {
                        results.push(`Edit ${i + 1}: FAILED — old_string not found`);
                        continue;
                    }
                    // Check for ambiguity — multiple matches
                    const secondIdx = text.indexOf(old_string, idx + 1);
                    if (secondIdx !== -1)
                        results.push(`Edit ${i + 1}: WARNING — multiple matches found, replacing first occurrence`);

                    text = text.slice(0, idx) + new_string + text.slice(idx + old_string.length);
                    results.push(`Edit ${i + 1}: OK`);
                }

                const bytes = new TextEncoder().encode(text);
                file.replace_contents(
                    bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );

                resolve(results.join('\n'));
            } catch (e) {
                resolve(JSON.stringify({error: e.message}));
            }
        });
    }
}

export class WriteFileTool {
    constructor() {
        this.name = 'write_file';
        this.description = 'Write content to a file, creating it if it does not exist.';
        this.parameters = {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Absolute path to the file'},
                content: {type: 'string', description: 'Content to write'},
                append: {description: 'Append instead of overwrite (default: false). Pass true or false.'},
            },
            required: ['path', 'content'],
        };
    }

    execute(args) {
        return new Promise((resolve, reject) => {
            try {
                const file = Gio.File.new_for_path(args.path);

                // Ensure parent directory exists
                const parent = file.get_parent();
                if (parent && !parent.query_exists(null))
                    parent.make_directory_with_parents(null);

                if (args.append === true || args.append === 'true') {
                    const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
                    const bytes = new TextEncoder().encode(args.content);
                    stream.write_all(bytes, null);
                    stream.close(null);
                } else {
                    const bytes = new TextEncoder().encode(args.content);
                    file.replace_contents(
                        bytes, null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null
                    );
                }
                resolve(`Successfully wrote ${args.content.length} bytes to ${args.path}`);
            } catch (e) {
                resolve(JSON.stringify({error: e.message}));
            }
        });
    }
}

export class ListDirectoryTool {
    constructor() {
        this.name = 'list_directory';
        this.description = 'List files and directories at the given path.';
        this.parameters = {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Absolute path to the directory'},
                show_hidden: {description: 'Include hidden files (default: false). Pass true or false.'},
            },
            required: ['path'],
        };
    }

    execute(args) {
        return new Promise((resolve) => {
            try {
                const dir = Gio.File.new_for_path(args.path);
                const enumerator = dir.enumerate_children(
                    'standard::name,standard::type,standard::size',
                    Gio.FileQueryInfoFlags.NONE, null
                );

                const entries = [];
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (!(args.show_hidden === true || args.show_hidden === 'true') && name.startsWith('.'))
                        continue;

                    const type = info.get_file_type();
                    entries.push({
                        name,
                        type: type === Gio.FileType.DIRECTORY ? 'directory' : 'file',
                        size: info.get_size(),
                    });
                }

                entries.sort((a, b) => {
                    if (a.type !== b.type)
                        return a.type === 'directory' ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

                resolve(entries.map(e =>
                    `${e.type === 'directory' ? '[DIR]' : '     '} ${e.name}${e.type === 'file' ? ` (${e.size} bytes)` : ''}`
                ).join('\n') || '(empty directory)');
            } catch (e) {
                resolve(JSON.stringify({error: e.message}));
            }
        });
    }
}
