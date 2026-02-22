import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Linux evdev keycodes for keyboard simulation
const KEY_MAP = {
    'ctrl': 29, 'control': 29,
    'shift': 42,
    'alt': 56,
    'super': 125, 'meta': 125, 'win': 125,
    'enter': 28, 'return': 28,
    'escape': 1, 'esc': 1,
    'tab': 15,
    'backspace': 14,
    'delete': 111, 'del': 111,
    'space': 57,
    'up': 103,
    'down': 108,
    'left': 105,
    'right': 106,
    'home': 102,
    'end': 107,
    'pageup': 104,
    'pagedown': 109,
    'insert': 110,
    'f1': 59, 'f2': 60, 'f3': 61, 'f4': 62,
    'f5': 63, 'f6': 64, 'f7': 65, 'f8': 66,
    'f9': 67, 'f10': 68, 'f11': 87, 'f12': 88,
    'a': 30, 'b': 48, 'c': 46, 'd': 32, 'e': 18,
    'f': 33, 'g': 34, 'h': 35, 'i': 23, 'j': 36,
    'k': 37, 'l': 38, 'm': 50, 'n': 49, 'o': 24,
    'p': 25, 'q': 16, 'r': 19, 's': 31, 't': 20,
    'u': 22, 'v': 47, 'w': 17, 'x': 45, 'y': 21,
    'z': 44,
    '0': 11, '1': 2, '2': 3, '3': 4, '4': 5,
    '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
    'minus': 12, '-': 12,
    'equal': 13, '=': 13,
    'bracketleft': 26, '[': 26,
    'bracketright': 27, ']': 27,
    'semicolon': 39, ';': 39,
    'apostrophe': 40, "'": 40,
    'grave': 41, '`': 41,
    'backslash': 43, '\\': 43,
    'comma': 51, ',': 51,
    'period': 52, '.': 52,
    'slash': 53, '/': 53,
};

/**
 * Parse x/y coordinates from tool args, tolerating malformed model output.
 * Some models (e.g. glm-4.6v) produce garbage like:
 *   {"x":"988</arg_key>\n<arg_key>y</arg_key>\n<arg_value>72"}
 * where y is embedded in x's string value. This extracts both.
 * Also handles normalized 0-1 range coordinates (some models output these
 * instead of pixel values) by multiplying by screen dimensions.
 */
function parseCoords(args) {
    let rawX = typeof args.x === 'number' ? args.x : parseFloat(args.x);
    let rawY = typeof args.y === 'number' ? args.y : parseFloat(args.y);
    let recovered = false;
    let normalized = false;

    // Detect normalized 0-1 coordinates and convert to pixel values.
    // If BOTH x and y are in (0, 1] exclusive, the model almost certainly
    // meant normalized coords (no real UI target is at pixel 0).
    if (!isNaN(rawX) && !isNaN(rawY) && rawX > 0 && rawX <= 1 && rawY > 0 && rawY <= 1) {
        const monitor = Main.layoutManager.primaryMonitor;
        rawX = rawX * monitor.width;
        rawY = rawY * monitor.height;
        normalized = true;
    }

    let x = Math.round(rawX);
    let y = Math.round(rawY);

    // If y is missing/NaN but x is a string, try to extract y from it
    if (isNaN(y) && typeof args.x === 'string') {
        const m = args.x.match(/y[^0-9]*(\d+)/i);
        if (m) {
            y = parseInt(m[1], 10);
            recovered = true;
        }
    }
    // Mirror: if x is missing/NaN but y is a string, try to extract x from it
    if (isNaN(x) && typeof args.y === 'string') {
        const m = args.y.match(/x[^0-9]*(\d+)/i);
        if (m) {
            x = parseInt(m[1], 10);
            recovered = true;
        }
    }

    const valid = !isNaN(x) && !isNaN(y);
    let warning = null;
    if (normalized && valid)
        warning = `Normalized coordinates detected (${args.x}, ${args.y}) — converted to pixels (${x}, ${y}). Use pixel coordinates directly next time: {"x": ${x}, "y": ${y}}`;
    else if (recovered && valid)
        warning = `BAD SYNTAX: your arguments ${JSON.stringify({x: args.x, y: args.y})} were malformed. Interpreted as x=${x}, y=${y}. Use proper JSON: {"x": ${x}, "y": ${y}}`;

    return {x, y, valid, warning};
}

/**
 * Helper: GLib.timeout_add wrapped in a Promise.
 */
function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Get or create a shared virtual pointer device.
 */
let _virtualPointer = null;
function getVirtualPointer() {
    if (!_virtualPointer) {
        const seat = Clutter.get_default_backend().get_default_seat();
        _virtualPointer = seat.create_virtual_device(
            Clutter.InputDeviceType.POINTER_DEVICE
        );
    }
    return _virtualPointer;
}

/**
 * Get or create a shared virtual keyboard device.
 */
let _virtualKeyboard = null;
function getVirtualKeyboard() {
    if (!_virtualKeyboard) {
        const seat = Clutter.get_default_backend().get_default_seat();
        _virtualKeyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );
    }
    return _virtualKeyboard;
}

// ────────────────────────────────────────────────────────────────
// Tool 1: screenshot
// ────────────────────────────────────────────────────────────────

export class ScreenshotTool {
    constructor(settings) {
        this.name = 'screenshot';
        this.description = 'Take a screenshot of the entire screen or a specific region. Returns screen dimensions and injects the image into the conversation so you can see what is on screen. ALWAYS call this before performing mouse/keyboard actions to see current screen state.';
        this.parameters = {
            type: 'object',
            properties: {
                x: {type: 'number', description: 'X coordinate of region top-left (omit for full screen)'},
                y: {type: 'number', description: 'Y coordinate of region top-left (omit for full screen)'},
                width: {type: 'number', description: 'Width of region (omit for full screen)'},
                height: {type: 'number', description: 'Height of region (omit for full screen)'},
            },
        };
        this._settings = settings;
        // Set by agentManager before each tool execution cycle
        this._injectImage = null;
    }

    async execute(args) {
        // Note: overlay is hidden for the entire CU agent run by agentManager,
        // so no per-tool hide/show is needed here.
        const screenshot = new Shell.Screenshot();
        const isRegion = (args.x !== undefined && args.y !== undefined &&
                          args.width !== undefined && args.height !== undefined);

        const monitor = Main.layoutManager.primaryMonitor;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        // Capture screenshot to a Gio.MemoryOutputStream (in-memory PNG)
        const stream = Gio.MemoryOutputStream.new_resizable();

        if (isRegion) {
            await screenshot.screenshot_area(
                args.x, args.y, args.width, args.height, stream
            );
        } else {
            await screenshot.screenshot(false, stream);
        }

        stream.close(null);

        // Extract bytes and base64 encode
        const bytes = stream.steal_as_bytes();
        const base64 = GLib.base64_encode(bytes.get_data());

        // Inject the image into the conversation via callback
        if (this._injectImage)
            this._injectImage(base64);

        return JSON.stringify({
            status: 'screenshot_captured',
            screen_width: monitor.width,
            screen_height: monitor.height,
            scale_factor: scaleFactor,
            region: isRegion
                ? {x: args.x, y: args.y, width: args.width, height: args.height}
                : 'full_screen',
            note: 'The screenshot has been injected into the conversation. You can now see it and determine coordinates for mouse/keyboard actions. Coordinates are in logical pixels from (0,0) at top-left to (screen_width, screen_height).',
        });
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 2: mouse_click
// ────────────────────────────────────────────────────────────────

export class MouseClickTool {
    constructor(settings) {
        this.name = 'mouse_click';
        this.description = 'Click the mouse at specific pixel coordinates. Moves to the position first, waits briefly, then clicks. Supports left, right, middle click and double-click.';
        this.parameters = {
            type: 'object',
            properties: {
                x: {type: 'number', description: 'X coordinate in logical pixels'},
                y: {type: 'number', description: 'Y coordinate in logical pixels'},
                button: {type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)'},
                double_click: {description: 'Double-click instead of single (default: false). Pass true or false.'},
            },
            required: ['x', 'y'],
        };
        this._settings = settings;
    }

    async execute(args) {
        const {x, y, valid, warning} = parseCoords(args);
        if (!valid)
            return JSON.stringify({error: `Invalid coordinates: x=${args.x}, y=${args.y}. Must be integers.`});

        const pointer = getVirtualPointer();
        const buttonMap = {left: 1, right: 3, middle: 2}; // Clutter button codes
        const btn = buttonMap[args.button || 'left'] || 1;
        const dblClick = args.double_click === true || args.double_click === 'true';
        const actionDelay = this._settings.get_int('computer-use-action-delay');

        let timeUs = GLib.get_monotonic_time();
        // Move to target
        pointer.notify_absolute_motion(timeUs, x, y);
        await delay(actionDelay);

        // Click: press + release
        timeUs = GLib.get_monotonic_time();
        pointer.notify_button(timeUs, btn, Clutter.ButtonState.PRESSED);
        await delay(Math.max(30, actionDelay / 3));
        timeUs = GLib.get_monotonic_time();
        pointer.notify_button(timeUs, btn, Clutter.ButtonState.RELEASED);

        if (dblClick) {
            await delay(Math.max(50, actionDelay / 2));
            timeUs = GLib.get_monotonic_time();
            pointer.notify_button(timeUs, btn, Clutter.ButtonState.PRESSED);
            await delay(Math.max(30, actionDelay / 3));
            timeUs = GLib.get_monotonic_time();
            pointer.notify_button(timeUs, btn, Clutter.ButtonState.RELEASED);
        }

        const result = {
            status: 'clicked',
            x,
            y,
            button: args.button || 'left',
            double_click: dblClick,
        };
        if (warning)
            result.warning = warning;
        return JSON.stringify(result);
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 3: mouse_move
// ────────────────────────────────────────────────────────────────

export class MouseMoveTool {
    constructor() {
        this.name = 'mouse_move';
        this.description = 'Move the mouse cursor to specific pixel coordinates without clicking.';
        this.parameters = {
            type: 'object',
            properties: {
                x: {type: 'number', description: 'X coordinate in logical pixels'},
                y: {type: 'number', description: 'Y coordinate in logical pixels'},
            },
            required: ['x', 'y'],
        };
    }

    execute(args) {
        const {x, y, valid, warning} = parseCoords(args);
        if (!valid)
            return JSON.stringify({error: `Invalid coordinates: x=${args.x}, y=${args.y}. Must be integers.`});

        const pointer = getVirtualPointer();
        const timeUs = GLib.get_monotonic_time();
        pointer.notify_absolute_motion(timeUs, x, y);

        const result = {status: 'moved', x, y};
        if (warning)
            result.warning = warning;
        return JSON.stringify(result);
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 4: keyboard_type
// ────────────────────────────────────────────────────────────────

export class KeyboardTypeTool {
    constructor() {
        this.name = 'keyboard_type';
        this.description = 'Type text into the currently focused input field. Uses clipboard paste (Ctrl+V) for reliability across all keyboard layouts. Click on the target field first before calling this.';
        this.parameters = {
            type: 'object',
            properties: {
                text: {type: 'string', description: 'The text to type'},
            },
            required: ['text'],
        };
    }

    async execute(args) {
        const text = args.text;
        if (!text)
            return JSON.stringify({error: 'No text provided'});

        // Copy text to clipboard
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        await delay(50);

        // Simulate Ctrl+V
        const keyboard = getVirtualKeyboard();
        let timeUs = GLib.get_monotonic_time();

        // Press Ctrl
        keyboard.notify_key(timeUs, KEY_MAP['ctrl'], Clutter.KeyState.PRESSED);
        await delay(15);

        // Press V
        timeUs = GLib.get_monotonic_time();
        keyboard.notify_key(timeUs, KEY_MAP['v'], Clutter.KeyState.PRESSED);
        await delay(30);

        // Release V
        timeUs = GLib.get_monotonic_time();
        keyboard.notify_key(timeUs, KEY_MAP['v'], Clutter.KeyState.RELEASED);
        await delay(15);

        // Release Ctrl
        timeUs = GLib.get_monotonic_time();
        keyboard.notify_key(timeUs, KEY_MAP['ctrl'], Clutter.KeyState.RELEASED);

        return JSON.stringify({
            status: 'typed',
            length: text.length,
        });
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 5: keyboard_shortcut
// ────────────────────────────────────────────────────────────────

export class KeyboardShortcutTool {
    constructor() {
        this.name = 'keyboard_shortcut';
        this.description = 'Press a keyboard shortcut or special key. Use "+" to combine keys. Examples: "ctrl+c", "alt+tab", "ctrl+shift+t", "enter", "escape", "tab", "up", "down", "f5", "super".';
        this.parameters = {
            type: 'object',
            properties: {
                keys: {
                    type: 'string',
                    description: 'Key combination with "+" separator. Examples: "ctrl+c", "alt+tab", "enter", "escape", "ctrl+shift+s", "super", "f1"',
                },
            },
            required: ['keys'],
        };
    }

    async execute(args) {
        const keysStr = args.keys;
        if (!keysStr)
            return JSON.stringify({error: 'No keys provided'});

        const keyNames = keysStr.toLowerCase().split('+').map(k => k.trim()).filter(k => k);
        const keycodes = [];

        for (const name of keyNames) {
            const code = KEY_MAP[name];
            if (code === undefined)
                return JSON.stringify({error: `Unknown key: "${name}". Available: ${Object.keys(KEY_MAP).filter(k => k.length > 1).join(', ')}`});
            keycodes.push(code);
        }

        const keyboard = getVirtualKeyboard();

        // Press all keys in order
        for (const code of keycodes) {
            const timeUs = GLib.get_monotonic_time();
            keyboard.notify_key(timeUs, code, Clutter.KeyState.PRESSED);
            await delay(15);
        }

        // Brief hold
        await delay(30);

        // Release in reverse order
        for (let i = keycodes.length - 1; i >= 0; i--) {
            const timeUs = GLib.get_monotonic_time();
            keyboard.notify_key(timeUs, keycodes[i], Clutter.KeyState.RELEASED);
            await delay(15);
        }

        return JSON.stringify({
            status: 'pressed',
            keys: keysStr,
        });
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 6: scroll
// ────────────────────────────────────────────────────────────────

export class ScrollTool {
    constructor() {
        this.name = 'scroll';
        this.description = 'Scroll the mouse wheel at the current position or at specified coordinates. Use to scroll through pages, lists, or documents.';
        this.parameters = {
            type: 'object',
            properties: {
                direction: {type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction'},
                amount: {type: 'number', description: 'Number of scroll steps (default: 3)'},
                x: {type: 'number', description: 'X coordinate to scroll at (optional)'},
                y: {type: 'number', description: 'Y coordinate to scroll at (optional)'},
            },
            required: ['direction'],
        };
    }

    async execute(args) {
        const pointer = getVirtualPointer();
        const amount = Math.min(Math.max(args.amount || 3, 1), 20);
        const directionMap = {
            up: Clutter.ScrollDirection.UP,
            down: Clutter.ScrollDirection.DOWN,
            left: Clutter.ScrollDirection.LEFT,
            right: Clutter.ScrollDirection.RIGHT,
        };
        const dir = directionMap[args.direction];
        if (dir === undefined)
            return JSON.stringify({error: `Invalid direction: ${args.direction}`});

        // Move to target position first if specified
        let coordWarning = null;
        if (args.x !== undefined || args.y !== undefined) {
            const {x: sx, y: sy, valid, warning} = parseCoords(args);
            if (!valid)
                return JSON.stringify({error: `Invalid scroll coordinates: x=${args.x}, y=${args.y}`});
            coordWarning = warning;
            const timeUs = GLib.get_monotonic_time();
            pointer.notify_absolute_motion(timeUs, sx, sy);
            await delay(30);
        }

        // Scroll multiple steps
        for (let i = 0; i < amount; i++) {
            const timeUs = GLib.get_monotonic_time();
            pointer.notify_discrete_scroll(timeUs, dir, Clutter.ScrollSource.WHEEL);
            await delay(50);
        }

        const result = {status: 'scrolled', direction: args.direction, amount};
        if (coordWarning)
            result.warning = coordWarning;
        return JSON.stringify(result);
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 7: wait
// ────────────────────────────────────────────────────────────────

export class WaitTool {
    constructor() {
        this.name = 'wait';
        this.description = 'Wait for a specified duration in milliseconds. Use this to wait for UI animations, page loads, or application startup before taking the next screenshot.';
        this.parameters = {
            type: 'object',
            properties: {
                ms: {type: 'number', description: 'Duration in milliseconds (50-10000, default: 1000)'},
            },
        };
    }

    execute(args) {
        const ms = Math.min(Math.max(args.ms || 1000, 50), 10000);
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve(JSON.stringify({status: 'waited', ms}));
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}

// ────────────────────────────────────────────────────────────────
// Tool 8: click_at_text (OCR-based clicking)
// ────────────────────────────────────────────────────────────────

export class ClickAtTextTool {
    constructor(settings) {
        this.name = 'click_at_text';
        this.description = 'Find visible text on screen via OCR and click its center. More reliable than guessing coordinates for text elements. If multiple matches are found, provide near_x/near_y approximate coordinates to click the one closest to that position. Without near_x/near_y, returns an error listing all matches with their coordinates.';
        this.parameters = {
            type: 'object',
            properties: {
                text: {type: 'string', description: 'The text to find and click (case-insensitive). Can be a single word or short phrase.'},
                near_x: {type: 'number', description: 'Approximate X coordinate to disambiguate when multiple matches exist. The match closest to (near_x, near_y) will be clicked.'},
                near_y: {type: 'number', description: 'Approximate Y coordinate to disambiguate when multiple matches exist. The match closest to (near_x, near_y) will be clicked.'},
                button: {type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)'},
                double_click: {description: 'Double-click instead of single (default: false). Pass true or false.'},
            },
            required: ['text'],
        };
        this._settings = settings;
        // Set by agentManager — pushes screenshot into conversation
        this._injectImage = null;
    }

    async execute(args) {
        const searchText = (args.text || '').trim();
        if (!searchText)
            return JSON.stringify({error: 'No text provided. Specify the text to find and click.'});

        const hasNearCoords = args.near_x !== undefined && args.near_y !== undefined;

        // 1. Check tesseract is installed
        try {
            const whichProc = Gio.Subprocess.new(
                ['which', 'tesseract'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            whichProc.wait(null);
            if (whichProc.get_exit_status() !== 0)
                throw new Error('not found');
        } catch {
            return JSON.stringify({
                error: 'tesseract is not installed. Install it with: sudo dnf install tesseract',
            });
        }

        // 2. Take screenshot and save to temp file
        // Note: overlay is hidden for the entire CU agent run by agentManager
        const screenshot = new Shell.Screenshot();
        const stream = Gio.MemoryOutputStream.new_resizable();
        await screenshot.screenshot(false, stream);
        stream.close(null);
        const bytes = stream.steal_as_bytes();
        const screenshotBase64 = GLib.base64_encode(bytes.get_data());

        // Also write PNG for tesseract
        const pngPath = '/tmp/.aether-ocr.png';
        const pngFile = Gio.File.new_for_path(pngPath);
        pngFile.replace_contents(bytes.get_data(), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        // Inject screenshot into conversation
        if (this._injectImage)
            this._injectImage(screenshotBase64);

        // 3. Pre-process image for OCR: convert to grayscale and invert
        // Dark themes (light text on dark bg) are terrible for tesseract.
        // Inversion makes all text dark-on-light which tesseract expects.
        try {
            const prepProc = Gio.Subprocess.new(
                ['python3', '-c', `
import cairo
surface = cairo.ImageSurface.create_from_png("/tmp/.aether-ocr.png")
w, h = surface.get_width(), surface.get_height()
data = bytearray(surface.get_data())
stride = surface.get_stride()
# Convert to grayscale and invert (BGRA format)
for y in range(h):
    for x in range(w):
        off = y * stride + x * 4
        gray = int(0.299 * data[off+2] + 0.587 * data[off+1] + 0.114 * data[off])
        inv = 255 - gray
        data[off] = data[off+1] = data[off+2] = inv
out = cairo.ImageSurface.create_for_data(data, cairo.FORMAT_ARGB32, w, h, stride)
out.write_to_png("/tmp/.aether-ocr-prep.png")
`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            prepProc.communicate(null, null);
            prepProc.wait(null);
        } catch (e) {
            log(`[Aether] OCR preprocess failed (using raw): ${e.message}`);
        }

        // Use preprocessed image if available, fall back to raw
        const ocrImage = GLib.file_test('/tmp/.aether-ocr-prep.png', GLib.FileTest.EXISTS)
            ? '/tmp/.aether-ocr-prep.png' : '/tmp/.aether-ocr.png';

        // 4. Detect installed tesseract languages and use all of them
        // (e.g. eng+nor for Norwegian ø/å/æ support)
        let langArgs = [];
        try {
            const langProc = Gio.Subprocess.new(
                ['tesseract', '--list-langs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const [, langStdout, langStderr] = langProc.communicate(null, null);
            langProc.wait(null);
            // --list-langs outputs to stderr on most versions
            const langText = new TextDecoder().decode(
                (langStderr?.get_data()?.length > 0 ? langStderr : langStdout).get_data()
            );
            const langs = langText.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0 && l.length < 10 && !l.includes('/') && !l.includes('List'));
            if (langs.length > 0)
                langArgs = ['-l', langs.join('+')];
        } catch {
            // Fall back to default (eng only)
        }

        // 5. Run tesseract OCR (PSM 3 = fully automatic page segmentation)
        let tsvOutput;
        try {
            const proc = Gio.Subprocess.new(
                ['tesseract', ocrImage, 'stdout', '--psm', '3', ...langArgs, 'tsv'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const [, stdoutBytes] = proc.communicate(null, null);
            proc.wait(null);
            tsvOutput = new TextDecoder().decode(stdoutBytes.get_data());
        } catch (e) {
            return JSON.stringify({error: `Tesseract failed: ${e.message}`});
        }

        // 6. Parse TSV → word bounding boxes
        const lines = tsvOutput.split('\n');
        const words = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols.length < 12) continue;
            const conf = parseInt(cols[10], 10);
            const text = (cols[11] || '').trim();
            if (!text || conf < 20) continue;
            words.push({
                left: parseInt(cols[6], 10),
                top: parseInt(cols[7], 10),
                width: parseInt(cols[8], 10),
                height: parseInt(cols[9], 10),
                conf,
                text,
                lineNum: parseInt(cols[4], 10),
                wordNum: parseInt(cols[5], 10),
            });
        }

        // Compute coordinate scaling: OCR returns coordinates in screenshot
        // physical pixels, but the pointer expects logical pixel coordinates.
        // On HiDPI/scaled displays these differ (e.g. 2944x1840 physical vs
        // 1920x1080 logical). Scale = logical / physical.
        const monitor = Main.layoutManager.primaryMonitor;
        let coordScaleX = 1, coordScaleY = 1;
        try {
            const pngPixbuf = GdkPixbuf.Pixbuf.new_from_file(pngPath);
            const pngW = pngPixbuf.get_width();
            const pngH = pngPixbuf.get_height();
            if (pngW > 0 && pngH > 0) {
                coordScaleX = monitor.width / pngW;
                coordScaleY = monitor.height / pngH;
            }
        } catch (e) {
            log(`[Aether] Could not read PNG dims for coord scaling: ${e.message}`);
        }

        if (words.length === 0) {
            return JSON.stringify({
                error: 'OCR found no readable text on screen. The screen may have mostly images/icons, or tesseract may need language data.',
                suggestion: 'Try using mouse_click with coordinates from the screenshot instead.',
            });
        }

        // 6. Match strategies
        const lower = searchText.toLowerCase();
        let matches = [];

        // Strategy 1: exact single-word match
        for (const w of words) {
            if (w.text.toLowerCase() === lower) {
                matches.push({
                    x: w.left + w.width / 2,
                    y: w.top + w.height / 2,
                    matchedText: w.text,
                    matchType: 'exact',
                    conf: w.conf,
                });
            }
        }

        // Strategy 2: word contains search text (substring)
        if (matches.length === 0) {
            for (const w of words) {
                if (w.text.toLowerCase().includes(lower)) {
                    matches.push({
                        x: w.left + w.width / 2,
                        y: w.top + w.height / 2,
                        matchedText: w.text,
                        matchType: 'contains',
                        conf: w.conf,
                    });
                }
            }
        }

        // Strategy 3: multi-word phrase (consecutive words on same line)
        if (matches.length === 0 && lower.includes(' ')) {
            const searchWords = lower.split(/\s+/);
            for (let i = 0; i <= words.length - searchWords.length; i++) {
                let match = true;
                for (let j = 0; j < searchWords.length; j++) {
                    if (words[i + j].text.toLowerCase() !== searchWords[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    // Bounding box spanning all matched words
                    const first = words[i];
                    const last = words[i + searchWords.length - 1];
                    const left = Math.min(first.left, last.left);
                    const top = Math.min(first.top, last.top);
                    const right = Math.max(first.left + first.width, last.left + last.width);
                    const bottom = Math.max(first.top + first.height, last.top + last.height);
                    matches.push({
                        x: (left + right) / 2,
                        y: (top + bottom) / 2,
                        matchedText: words.slice(i, i + searchWords.length).map(w => w.text).join(' '),
                        matchType: 'phrase',
                        conf: Math.min(...words.slice(i, i + searchWords.length).map(w => w.conf)),
                    });
                }
            }
        }

        // Strategy 4: fuzzy — search text appears across consecutive words
        if (matches.length === 0) {
            for (const w of words) {
                if (lower.includes(w.text.toLowerCase()) && w.text.length >= 3) {
                    matches.push({
                        x: w.left + w.width / 2,
                        y: w.top + w.height / 2,
                        matchedText: w.text,
                        matchType: 'partial',
                        conf: w.conf,
                    });
                }
            }
        }

        if (matches.length === 0) {
            // Return sample of recognized text to help the model adjust
            const sample = words.slice(0, 40).map(w => w.text).join(' ');
            return JSON.stringify({
                error: `Text "${searchText}" not found on screen.`,
                recognized_text_sample: sample.slice(0, 500),
                suggestion: 'Try a different search term based on the recognized text, or use mouse_click with coordinates.',
            });
        }

        // Disambiguate multiple matches
        let target;
        if (matches.length === 1) {
            target = matches[0];
        } else if (hasNearCoords) {
            // Pick the match closest to the approximate coordinates
            const nearX = parseFloat(args.near_x);
            const nearY = parseFloat(args.near_y);
            let bestDist = Infinity;
            let bestIdx = 0;
            for (let i = 0; i < matches.length; i++) {
                const mx = matches[i].x * coordScaleX;
                const my = matches[i].y * coordScaleY;
                const dist = Math.hypot(mx - nearX, my - nearY);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = i;
                    target = matches[i];
                }
            }
            target._nearDist = Math.round(bestDist);
            target._selectedIndex = bestIdx + 1;
        } else {
            // Multiple matches, no approximate coordinates — return error with locations
            const matchList = matches.map((m, i) => ({
                index: i + 1,
                x: Math.round(m.x * coordScaleX),
                y: Math.round(m.y * coordScaleY),
                matched_text: m.matchedText,
            }));
            return JSON.stringify({
                error: `Multiple matches found for "${searchText}" (${matches.length} occurrences). Provide near_x and near_y to click the one closest to your intended target.`,
                matches: matchList,
                suggestion: `Call click_at_text with near_x and near_y set to the approximate position of the one you want, e.g.: {"text": "${searchText}", "near_x": ${matchList[0].x}, "near_y": ${matchList[0].y}}. Or use mouse_click with exact coordinates.`,
            });
        }
        // Scale from physical screenshot pixels to logical pointer pixels
        const x = Math.round(target.x * coordScaleX);
        const y = Math.round(target.y * coordScaleY);

        // 7. Click at the matched position
        const pointer = getVirtualPointer();
        const buttonMap = {left: 1, right: 3, middle: 2};
        const btn = buttonMap[args.button || 'left'] || 1;
        const actionDelay = this._settings.get_int('computer-use-action-delay');

        let timeUs = GLib.get_monotonic_time();
        pointer.notify_absolute_motion(timeUs, x, y);
        await delay(actionDelay);

        timeUs = GLib.get_monotonic_time();
        pointer.notify_button(timeUs, btn, Clutter.ButtonState.PRESSED);
        await delay(Math.max(30, actionDelay / 3));
        timeUs = GLib.get_monotonic_time();
        pointer.notify_button(timeUs, btn, Clutter.ButtonState.RELEASED);

        const dblClick = args.double_click === true || args.double_click === 'true';
        if (dblClick) {
            await delay(Math.max(50, actionDelay / 2));
            timeUs = GLib.get_monotonic_time();
            pointer.notify_button(timeUs, btn, Clutter.ButtonState.PRESSED);
            await delay(Math.max(30, actionDelay / 3));
            timeUs = GLib.get_monotonic_time();
            pointer.notify_button(timeUs, btn, Clutter.ButtonState.RELEASED);
        }

        const result = {
            status: 'clicked',
            x,
            y,
            matched_text: target.matchedText,
            match_type: target.matchType,
            confidence: target.conf,
            total_matches: matches.length,
            button: args.button || 'left',
            double_click: dblClick,
        };
        if (target._selectedIndex)
            result.selected = `Match ${target._selectedIndex} of ${matches.length} (${target._nearDist}px from near_x/near_y)`;
        return JSON.stringify(result);
    }
}

/**
 * Clean up virtual devices on extension disable.
 */
export function destroyVirtualDevices() {
    _virtualPointer = null;
    _virtualKeyboard = null;
}
