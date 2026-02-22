import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Generate a random session ID.
 */
export function generateSessionId() {
    return GLib.uuid_string_random();
}

/**
 * Get the default config directory, creating it if needed.
 */
export function getConfigDir() {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'aether']);
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null))
        dir.make_directory_with_parents(null);
    return path;
}

/**
 * Get the default database path.
 */
export function getDefaultDbPath() {
    return GLib.build_filenamev([getConfigDir(), 'aether.db']);
}

/**
 * Get the agent memory directory, creating it and subdirectories if needed.
 */
export function getMemoryDir() {
    const path = GLib.build_filenamev([getConfigDir(), 'memory']);
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null))
        dir.make_directory_with_parents(null);
    // Ensure projects subdirectory exists
    const projectsDir = Gio.File.new_for_path(GLib.build_filenamev([path, 'projects']));
    if (!projectsDir.query_exists(null))
        projectsDir.make_directory_with_parents(null);
    return path;
}

/**
 * Read a file's contents as UTF-8 string asynchronously.
 */
export function readFileAsync(path) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (ok)
                    resolve(new TextDecoder().decode(contents));
                else
                    reject(new Error(`Failed to read ${path}`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Write string contents to a file asynchronously.
 */
export function writeFileAsync(path, contents) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        const bytes = new TextEncoder().encode(contents);
        file.replace_contents_bytes_async(
            new GLib.Bytes(bytes),
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/**
 * Run a subprocess and return stdout as a string.
 */
export function runSubprocess(argv, input = null) {
    return new Promise((resolve, reject) => {
        try {
            const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
            const proc = new Gio.Subprocess({
                argv: argv,
                flags: input ? flags | Gio.SubprocessFlags.STDIN_PIPE : flags,
            });
            proc.init(null);

            proc.communicate_utf8_async(input, null, (source, result) => {
                try {
                    const [ok, stdout, stderr] = source.communicate_utf8_finish(result);
                    const exitStatus = source.get_exit_status();
                    resolve({stdout: stdout || '', stderr: stderr || '', exitStatus});
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Get current datetime as ISO string.
 */
export function nowISO() {
    return new Date().toISOString();
}

/**
 * Escape a string for safe use in SQL (basic quoting).
 */
export function sqlEscape(str) {
    if (str === null || str === undefined)
        return 'NULL';
    return `'${String(str).replace(/'/g, "''")}'`;
}

/**
 * Debounce a function call.
 */
export function debounce(func, waitMs) {
    let timeoutId = null;
    return function(...args) {
        if (timeoutId !== null)
            GLib.source_remove(timeoutId);
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitMs, () => {
            timeoutId = null;
            func.apply(this, args);
            return GLib.SOURCE_REMOVE;
        });
    };
}
