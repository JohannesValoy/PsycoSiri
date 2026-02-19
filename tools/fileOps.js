import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class ReadFileTool {
    constructor() {
        this.name = 'read_file';
        this.description = 'Read the contents of a file at the given path.';
        this.parameters = {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Absolute path to the file'},
                max_lines: {type: 'integer', description: 'Max lines to read (default: all)'},
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

                    if (args.max_lines) {
                        const lines = text.split('\n');
                        text = lines.slice(0, args.max_lines).join('\n');
                        if (lines.length > args.max_lines)
                            text += `\n... (${lines.length - args.max_lines} more lines)`;
                    }

                    // Truncate very large files
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

export class WriteFileTool {
    constructor() {
        this.name = 'write_file';
        this.description = 'Write content to a file, creating it if it does not exist.';
        this.parameters = {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'Absolute path to the file'},
                content: {type: 'string', description: 'Content to write'},
                append: {type: 'boolean', description: 'Append instead of overwrite (default: false)'},
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

                if (args.append) {
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
                show_hidden: {type: 'boolean', description: 'Include hidden files (default: false)'},
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
                    if (!args.show_hidden && name.startsWith('.'))
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
