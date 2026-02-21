import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {AIProvider} from './aiProvider.js';
import {nowISO, generateSessionId, getConfigDir} from './utils.js';

const MAX_AGENT_TOOL_ITERATIONS = 100;

export class AgentManager {
    constructor(settings, toolRegistry, memory = null, extensionPath = null) {
        this._settings = settings;
        this._toolRegistry = toolRegistry;
        this._memory = memory;
        this._extensionPath = extensionPath;
        // Snapshot the original execute method so that monkey-patching in
        // overlay.js (which wraps execute with UI code) never affects agents.
        this._toolExecute = toolRegistry.execute.bind(toolRegistry);
        this._runs = new Map();
        this._onStateChange = null;
    }

    setOnStateChange(callback) {
        this._onStateChange = callback;
    }

    getAgentConfigs() {
        try {
            return JSON.parse(this._settings.get_string('agent-configs') || '{}');
        } catch {
            return {};
        }
    }

    async spawnAgent(agentConfigId, task) {
        const configs = this.getAgentConfigs();
        const agentCfg = configs[agentConfigId];
        if (!agentCfg)
            throw new Error(`No agent configuration found with ID "${agentConfigId}". Available: ${Object.keys(configs).join(', ') || 'none'}`);

        let providerConfigs;
        try {
            providerConfigs = JSON.parse(this._settings.get_string('providers') || '{}');
        } catch {
            providerConfigs = {};
        }

        const provCfg = providerConfigs[agentCfg.providerId];
        if (!provCfg)
            throw new Error(`Provider "${agentCfg.providerId}" not found. Configure it in Settings > Providers.`);

        const provider = new AIProvider(
            agentCfg.providerId,
            provCfg.name,
            provCfg.apiKey,
            provCfg.baseUrl
        );
        provider.setModel(agentCfg.modelId);

        const runId = generateSessionId();
        const defaultPrompt = `You are a powerful autonomous AI agent running on a Fedora Linux desktop with GNOME. You have FULL unrestricted access to the entire system — including sudo/root, all shell commands, package managers (dnf, pip, npm, cargo, etc.), compilers, interpreters, and every tool installed on the system.

ENVIRONMENT:
- OS: Fedora Linux with GNOME desktop
- Access: Full sudo/root, no restrictions, no approval needed
- Shell: bash with full PATH (git, gcc, python3, node, docker, etc.)
- File system: Full read/write access everywhere
- Network: Full internet access

AVAILABLE TOOLS:
- run_command: Execute ANY bash command. Use working_directory for project context. Use background=true for long builds/installs, then check_command to poll results.
- read_file: Read files with optional line offset and max_lines for efficient partial reads. Use line_numbers=true to see exact line numbers for editing.
- edit_file: Surgically edit files with find/replace. Provide exact old_string to match and new_string to replace. Supports multiple edits per call. ALWAYS prefer this over write_file for existing files.
- write_file: Create new files or fully overwrite existing ones.
- list_directory: List directory contents.
- check_command: Check status/output of background commands.
- web_search: Search the web for documentation, solutions, etc.
- All other registered tools (clipboard, system info, app launcher, memory, todos).

WORKFLOW:
1. Call plan_tasks with a short list of steps (keep it to 3-8 steps).
2. Work through each step using tools. Call complete_task after each step.
3. When ALL steps are done, you MUST call the finish tool with your summary.

CODING BEST PRACTICES:
- ALWAYS use read_file with line_numbers=true before editing, so you can see exact text to match.
- Use edit_file for surgical changes — never rewrite entire files with write_file unless creating from scratch.
- Use run_command for grep, find, git, tests, builds — the full Linux toolchain is available.
- For long operations (builds, installs, large git clones), use background=true and poll with check_command.
- If something fails, read the error carefully (output keeps head + tail), diagnose, and fix.

TESTING — CRITICAL:
- ALWAYS prefix test commands with the Linux "timeout" command (in seconds) to prevent deadlocked tests from hanging forever. Example: "timeout 60 python3 -m pytest tests/ -v --tb=short". Exit code 124 means the timeout was hit.
- If a test times out (exit code 124), it means a test is hanging (deadlock, infinite loop). This IS a bug in the code you wrote — diagnose and fix it.
- After writing code, you MUST run the tests and READ the output carefully.
- If ANY tests fail: read the error, fix the code, rerun. Repeat until ALL tests pass.
- NEVER call finish if tests are failing. Your task is not done until tests pass.
- If you wrote tests, run them. If the project has existing tests, run those too.
- Use "--tb=short" or "--tb=line" flags for concise failure output.

MEMORY — USE IT:
- You have persistent memory across runs via memory_store and memory_recall tools.
- Use memory_recall to search for relevant past learnings BEFORE starting unfamiliar work.
- When in doubt about the meaning of a task, a term, or a convention — check memory first. Previous runs may have stored clarifications or context.
- When you discover something useful (a gotcha, a pattern, a project convention, a fix for a tricky bug), store it with memory_store using type "agent_learning" and descriptive keywords.
- Keep memories concise and actionable — future you should understand them instantly.
- On completion, your key learnings are auto-saved. But store important discoveries as you go — don't wait until the end.

KEEP MOVING — NEVER STALL:
- Every response you give MUST include at least one tool call. Never respond with just text.
- If you say "Let me do X", DO X in that same response with a tool call. Do not just announce plans.
- If you've gathered enough information, ACT on it immediately — write the file, run the command, etc.
- Do NOT batch-complete tasks without doing the actual work. complete_task means you DID the work.
- If you are stuck or unsure, call finish with what you have rather than going silent.

RULES:
- Be concise and efficient. Do NOT repeat work you already did.
- Do NOT re-read files you already read unless they changed.
- Only call finish when your work is VERIFIED — tests pass, builds succeed, output is correct.
- If a tool returns an error, try an alternative approach, then move on or finish with what you have.`;

        // Recall relevant memories from previous runs
        let memoriesText = '';
        if (this._memory) {
            try {
                const memories = await this._memory.recall(task, 8);
                if (memories.length > 0) {
                    memoriesText = '\n\nRELEVANT MEMORIES FROM PREVIOUS RUNS:\n'
                        + memories.map(m => `- [${m.type}] ${m.content}`).join('\n');
                }
            } catch {
                // Memory recall failure is non-fatal
            }
        }

        // Choose the right default prompt based on agent type.
        // Computer use agents get a vision-specific prompt with screenshot→act→verify workflow.
        // Repair agents always get the default coding prompt (they fix code, not use the mouse).
        const isRepairTask = task.startsWith('AUTO-REPAIR:');
        const isComputerUseAgent = !isRepairTask
            && (agentConfigId === 'computer-use'
                || (agentCfg.name || '').toLowerCase().includes('computer use'));
        let basePrompt;
        if (isComputerUseAgent) {
            // CU agents ALWAYS get the CU prompt — it contains critical workflow rules.
            // Any custom systemPrompt is appended as extra instructions.
            basePrompt = this._getComputerUsePrompt();
            if (agentCfg.systemPrompt && agentCfg.systemPrompt !== defaultPrompt)
                basePrompt += `\n\nAdditional instructions:\n${agentCfg.systemPrompt}`;
        } else if (agentCfg.systemPrompt && !isRepairTask) {
            basePrompt = agentCfg.systemPrompt;
        } else {
            basePrompt = defaultPrompt;
        }

        const systemPrompt = basePrompt
            + memoriesText
            + `\n\nCurrent date and time: ${nowISO()}`;

        const run = {
            id: runId,
            agentName: agentCfg.name || agentConfigId,
            agentConfigId,
            task,
            state: 'running',
            result: null,
            error: null,
            todos: [],
            toolCallCount: 0,
            processLog: [{
                type: 'system',
                timestamp: nowISO(),
                content: `Started with model ${agentCfg.modelId}`,
            }],
            messages: [{role: 'user', content: task}],
            systemPrompt,
            provider,
            cancellable: new Gio.Cancellable(),
            startedAt: nowISO(),
            completedAt: null,
            _isRepairAgent: isRepairTask,
            _repairTargetRunId: null,
            _logPath: null,
            _healthCheckSourceId: 0,
            _providerConfig: {providerId: agentCfg.providerId, provCfg, modelId: agentCfg.modelId},
            _repeatedErrors: new Map(), // errorMsg → consecutive count
            _isComputerUse: isComputerUseAgent,
            _screenshots: [],           // stored screenshots for the agent indicator viewer
            _lastActionKey: null,       // tracks last action tool+args for repetition detection
            _consecutiveSameAction: 0,  // how many times the same action was repeated without screenshot
        };

        this._runs.set(runId, run);
        this._notifyStateChange(run);

        // Start periodic health check (first check after 60s)
        this._scheduleHealthCheck(run);

        this._executeAgentLoop(run).catch(e => {
            console.error(`[Aether] Agent run ${runId} uncaught error: ${e.message}`);
        });

        return runId;
    }

    cancelAgent(runId) {
        const run = this._runs.get(runId);
        if (!run || run.state !== 'running')
            return false;

        if (run.cancellable)
            run.cancellable.cancel();

        run.state = 'error';
        run.error = 'Cancelled by user';
        run.completedAt = nowISO();
        run.processLog.push({
            type: 'system',
            timestamp: nowISO(),
            content: 'Cancelled by user',
        });
        if (run.provider) {
            run.provider.destroy();
            run.provider = null;
        }
        this._notifyStateChange(run);
        return true;
    }

    _getAgentTodoSchemas() {
        return [
            {
                type: 'function',
                function: {
                    name: 'plan_tasks',
                    description: 'Create your task plan. Call this FIRST before doing any work. Replaces any existing plan.',
                    parameters: {
                        type: 'object',
                        properties: {
                            tasks: {
                                type: 'array',
                                items: {type: 'string'},
                                description: 'List of task descriptions in order of execution.',
                            },
                        },
                        required: ['tasks'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'complete_task',
                    description: 'Mark a task as done by its index (0-based). Call this after finishing each step.',
                    parameters: {
                        type: 'object',
                        properties: {
                            index: {type: 'integer', description: 'The 0-based task index to mark done.'},
                        },
                        required: ['index'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'finish',
                    description: 'Signal that you are DONE with the task. You MUST call this when finished. Provide a summary of what you accomplished.',
                    parameters: {
                        type: 'object',
                        properties: {
                            summary: {type: 'string', description: 'A concise summary of what was accomplished.'},
                        },
                        required: ['summary'],
                    },
                },
            },
        ];
    }

    _executeAgentTodo(run, toolName, toolArgs) {
        if (toolName === 'plan_tasks') {
            run.todos = (toolArgs.tasks || []).map(t => ({text: t, done: false}));
            const list = run.todos.map((t, i) => `${i}. [ ] ${t.text}`).join('\n');
            return `Plan created with ${run.todos.length} tasks:\n${list}`;
        }
        if (toolName === 'complete_task') {
            const idx = toolArgs.index;
            if (idx < 0 || idx >= run.todos.length)
                return `Invalid task index ${idx}. Valid range: 0-${run.todos.length - 1}.`;
            run.todos[idx].done = true;
            const done = run.todos.filter(t => t.done).length;
            return `Task ${idx} marked done (${done}/${run.todos.length} complete): ${run.todos[idx].text}`;
        }
        if (toolName === 'finish') {
            // Check for signs that tests weren't verified or are failing
            const warnings = [];

            // Check if last run_command had test failures
            if (run._lastTestResult) {
                const r = run._lastTestResult;
                if (r.exitCode !== 0)
                    warnings.push(`WARNING: Your last test run FAILED (exit code ${r.exitCode}). Fix the failures before finishing.`);
                if (r.timedOut)
                    warnings.push(`WARNING: Your last test run TIMED OUT — likely a deadlock or infinite loop. This is a bug, fix it.`);
            }

            // Check for incomplete tasks
            const incomplete = run.todos.filter(t => !t.done);
            if (incomplete.length > 0)
                warnings.push(`WARNING: ${incomplete.length} task(s) still incomplete: ${incomplete.map(t => t.text).join(', ')}`);

            if (warnings.length > 0) {
                // Don't finish — push back to the agent
                return `FINISH REJECTED.\n${warnings.join('\n')}\n\nYou must fix these issues before calling finish. Go back and address them.`;
            }

            // All clear — actually finish
            run._finished = true;
            run.result = toolArgs.summary || '';

            // Auto-store a learning memory from this run
            if (this._memory && run.result) {
                try {
                    const taskExcerpt = run.task.slice(0, 100);
                    const summary = run.result.slice(0, 500);
                    const keywords = taskExcerpt.replace(/[^a-zA-Z0-9\s]/g, ' ')
                        .split(/\s+/).filter(w => w.length > 3).slice(0, 8).join(', ');
                    this._memory.store(
                        'agent_learning',
                        `Task: ${taskExcerpt}\nOutcome: ${summary}`,
                        keywords,
                        6
                    ).catch(() => {}); // fire and forget
                } catch {
                    // Memory store failure is non-fatal
                }
            }

            return 'Agent finished.';
        }
        return null;
    }

    _getComputerUsePrompt() {
        return `You are a Computer Use agent running inside a GNOME Shell desktop on Fedora Linux.
You can SEE the screen via screenshots and CONTROL it via mouse and keyboard tools.
You also have full access to shell commands, file operations, and all other system tools.

═══════════════════════════════════════════════════
 MANDATORY WORKFLOW — YOU MUST FOLLOW THIS EXACTLY
═══════════════════════════════════════════════════

Every interaction with the screen follows this strict cycle:

  SCREENSHOT → THINK → ONE ACTION → SCREENSHOT → THINK → ONE ACTION → ...

Step by step:
1. Call screenshot to see the current screen
2. Describe what you see — identify the UI element you need and its approximate (x, y) coordinates
3. Perform exactly ONE action: mouse_click, keyboard_type, keyboard_shortcut, scroll, or mouse_move
4. Call screenshot AGAIN to verify the action worked
5. Describe what changed — did it work? If not, why?
6. Repeat from step 3 with a new action

ABSOLUTE RULES (violations will be caught and flagged):
• After EVERY mouse_click, keyboard_type, keyboard_shortcut, or scroll, your VERY NEXT tool call MUST be screenshot (or wait then screenshot). NO EXCEPTIONS.
• NEVER call the same action tool twice in a row without a screenshot in between.
• NEVER click the same coordinates twice. If a click didn't visibly change the screen, the coordinates were wrong or the element doesn't respond to clicks — try something different.
• If you see a "SYSTEM:" message telling you to take a screenshot, DO IT IMMEDIATELY.

═══════════════════════════════════════════════════
 AVAILABLE TOOLS
═══════════════════════════════════════════════════

Screen & Input:
• screenshot — Capture the full screen. Returns screen dimensions. The image appears in your conversation.
• click_at_text — Find visible text on screen via OCR and click its center. MUCH more reliable than guessing coordinates. Use for buttons, links, labels, menu items. Params: text (string), occurrence (int, default 1), button, double_click. PREFER THIS over mouse_click when clicking on readable text.
• mouse_click — Click at (x, y). Params: x, y (integers), button (left/right/middle), double_click (bool). Use when clicking on icons, images, or specific coordinates.
• mouse_move — Move cursor to (x, y) without clicking.
• keyboard_type — Type text into the focused input (uses clipboard paste for reliability).
• keyboard_shortcut — Press key combos: "ctrl+c", "alt+tab", "ctrl+l" (focus URL bar), "enter", "escape", "super".
• scroll — Scroll up/down/left/right at current or specified position.
• wait — Wait for animations/loading (ms, default 1000). Use before screenshot if expecting changes.

System (also available):
• run_command — Execute any bash command. Useful for opening URLs: xdg-open "https://..."
• read_file, write_file, edit_file, list_directory — File operations.
• launch_app — Launch applications by name.
• web_search — Search the web.

═══════════════════════════════════════════════════
 COORDINATES
═══════════════════════════════════════════════════

• (0, 0) = top-left corner of screen
• screenshot reports screen_width and screen_height
• Screenshots have a coordinate grid overlay with (x,y) pixel labels at intersections.
  E.g. a label "200,300" means that point is at x=200, y=300.
  X axis values are shown along the top, Y axis values along the left.
  Use these numbers DIRECTLY in mouse_click({"x": 200, "y": 300}).
• For clickable TEXT (buttons, links, labels): use click_at_text instead of guessing coordinates
• Click the CENTER of buttons/icons/text, not edges
• Tool arguments must be proper JSON integers: {"x": 500, "y": 300}
• If coordinates seem wrong, re-examine the screenshot carefully

═══════════════════════════════════════════════════
 WHEN THINGS DON'T WORK
═══════════════════════════════════════════════════

If your action didn't produce the expected result:
1. Take a screenshot to see what actually happened
2. Try a DIFFERENT approach — don't repeat the same thing:
   • Wrong coordinates? Look at the screenshot more carefully, pick new ones
   • Click didn't open a menu? Try double-click, or right-click, or keyboard shortcut
   • Can't find a UI element? Scroll to reveal it, or use keyboard navigation
   • Need to navigate to a URL? Use keyboard_shortcut("ctrl+l") then keyboard_type the URL, then keyboard_shortcut("enter")
   • App not responding? Try run_command to launch it differently
3. After 2 failed attempts at the same thing, switch to a completely different strategy

═══════════════════════════════════════════════════
 TASK MANAGEMENT
═══════════════════════════════════════════════════

1. Call plan_tasks with 3-8 steps for your approach
2. Start with screenshot to see the desktop
3. Work through each step: action → screenshot → verify → next
4. Call complete_task after each step
5. Call finish with a summary when done

KEEP MOVING — every response MUST include at least one tool call.`;
    }

    /**
     * Annotate a base64 PNG screenshot with a red crosshair at (cx, cy).
     * Returns the annotated base64 PNG, or the original on failure.
     */
    _annotateScreenshot(base64Png, cx, cy) {
        try {
            const rawBytes = GLib.base64_decode(base64Png);
            const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(rawBytes));
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null).copy();
            stream.close(null);

            const w = pixbuf.get_width();
            const h = pixbuf.get_height();
            const pixels = pixbuf.get_pixels();
            const rowstride = pixbuf.get_rowstride();
            const nc = pixbuf.get_n_channels();

            // Blend a color onto a pixel
            const blend = (px, py, r, g, b, alpha) => {
                if (px < 0 || px >= w || py < 0 || py >= h) return;
                const off = py * rowstride + px * nc;
                pixels[off]     = Math.round(pixels[off]     * (1 - alpha) + r * alpha);
                pixels[off + 1] = Math.round(pixels[off + 1] * (1 - alpha) + g * alpha);
                pixels[off + 2] = Math.round(pixels[off + 2] * (1 - alpha) + b * alpha);
            };

            // Crosshair lines (thin red lines extending from center)
            const lineLen = 40, lineW = 3;
            for (let i = -lineLen; i <= lineLen; i++) {
                for (let t = -Math.floor(lineW / 2); t <= Math.floor(lineW / 2); t++) {
                    blend(cx + i, cy + t, 255, 40, 40, 0.7);  // horizontal
                    blend(cx + t, cy + i, 255, 40, 40, 0.7);  // vertical
                }
            }

            // Center circle: white border ring + red fill
            const outerR = 14, innerR = 10;
            for (let dy = -outerR; dy <= outerR; dy++) {
                for (let dx = -outerR; dx <= outerR; dx++) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= innerR)
                        blend(cx + dx, cy + dy, 255, 40, 40, 0.85);
                    else if (dist <= outerR)
                        blend(cx + dx, cy + dy, 255, 255, 255, 0.9);
                }
            }

            // Reconstruct pixbuf from modified pixels and save
            const modBytes = new GLib.Bytes(pixels);
            const modPixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
                modBytes, GdkPixbuf.Colorspace.RGB,
                pixbuf.get_has_alpha(), 8, w, h, rowstride
            );
            const [success, buffer] = modPixbuf.save_to_bufferv('png', [], []);
            if (!success) return base64Png;
            return GLib.base64_encode(buffer);
        } catch (e) {
            log(`[Aether] Failed to annotate screenshot: ${e.message}`);
            return base64Png;
        }
    }

    /**
     * Draw a labeled coordinate grid overlay on a base64 PNG screenshot.
     * Uses a Python subprocess with pycairo (GJS cairo bindings lack create_from_png).
     * Columns labeled A-Z, rows labeled 1-N.
     * Returns the overlaid base64 PNG, or the original on failure.
     */
    _drawGridOverlay(base64Png) {
        try {
            const spacing = this._settings.get_int('computer-use-grid-spacing') || 100;

            // Write input PNG to temp file
            const rawBytes = GLib.base64_decode(base64Png);
            const tmpIn = '/tmp/.aether-grid-src.png';
            const tmpOut = '/tmp/.aether-grid-out.png';
            const tmpFile = Gio.File.new_for_path(tmpIn);
            tmpFile.replace_contents(rawBytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            // Python script that draws the grid using pycairo + PangoCairo
            // Labels show actual (x, y) pixel coordinates at each intersection
            const script = `
import cairo, sys, math, gi
gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import Pango, PangoCairo

spacing = int(sys.argv[1])
src = sys.argv[2]
dst = sys.argv[3]

surface = cairo.ImageSurface.create_from_png(src)
w, h = surface.get_width(), surface.get_height()
cr = cairo.Context(surface)

cols = w // spacing
rows = h // spacing

# Grid lines with 5 alternating colors
colors = [
    (0.3, 0.5, 0.9, 0.35),
    (0.2, 0.75, 0.5, 0.35),
    (0.8, 0.4, 0.2, 0.35),
    (0.6, 0.3, 0.8, 0.35),
    (0.8, 0.7, 0.2, 0.35),
]
cr.set_line_width(1)
for c in range(1, cols + 1):
    cr.set_source_rgba(*colors[(c - 1) % 5])
    cr.move_to(c * spacing, 0)
    cr.line_to(c * spacing, h)
    cr.stroke()
for r in range(1, rows + 1):
    cr.set_source_rgba(*colors[(r - 1) % 5])
    cr.move_to(0, r * spacing)
    cr.line_to(w, r * spacing)
    cr.stroke()

# Coordinate labels at intersections — show actual (x, y) pixel values
layout = PangoCairo.create_layout(cr)
layout.set_font_description(Pango.FontDescription.from_string('Sans Bold 8'))
# Only label every other intersection to avoid clutter
step = 2 if spacing < 80 else 1
for c in range(1, cols + 1, step):
    for r in range(1, rows + 1, step):
        cx, cy = c * spacing, r * spacing
        label = f"{cx},{cy}"
        layout.set_text(label, -1)
        ink, log = layout.get_pixel_extents()
        tw, th = log.width, log.height
        px, py = 3, 1
        bw, bh = tw + px * 2, th + py * 2
        bx, by = cx - bw / 2, cy - bh / 2
        rad = 4
        cr.new_path()
        cr.arc(bx + rad, by + rad, rad, math.pi, 1.5 * math.pi)
        cr.arc(bx + bw - rad, by + rad, rad, 1.5 * math.pi, 2 * math.pi)
        cr.arc(bx + bw - rad, by + bh - rad, rad, 0, 0.5 * math.pi)
        cr.arc(bx + rad, by + bh - rad, rad, 0.5 * math.pi, math.pi)
        cr.close_path()
        cr.set_source_rgba(0, 0, 0, 0.55)
        cr.fill()
        cr.set_source_rgba(1, 1, 1, 0.9)
        cr.move_to(bx + px, by + py)
        PangoCairo.show_layout(cr, layout)

# Axis label bg colors — match each to its grid line color (darker version)
axis_bg = [
    (0.15, 0.25, 0.55, 0.8),
    (0.1, 0.45, 0.3, 0.8),
    (0.5, 0.2, 0.1, 0.8),
    (0.35, 0.15, 0.5, 0.8),
    (0.5, 0.4, 0.1, 0.8),
]

# X-axis labels (pixel values along top)
layout.set_font_description(Pango.FontDescription.from_string('Sans Bold 9'))
for c in range(1, cols + 1):
    px_val = str(c * spacing)
    cx = c * spacing
    layout.set_text(px_val, -1)
    ink, log = layout.get_pixel_extents()
    pw, ph = log.width + 6, log.height + 4
    cr.set_source_rgba(*axis_bg[(c - 1) % 5])
    cr.rectangle(cx - pw / 2, 2, pw, ph)
    cr.fill()
    cr.set_source_rgba(1, 1, 1, 0.95)
    cr.move_to(cx - log.width / 2, 4)
    PangoCairo.show_layout(cr, layout)

# Y-axis labels (pixel values along left)
for r in range(1, rows + 1):
    px_val = str(r * spacing)
    cy = r * spacing
    layout.set_text(px_val, -1)
    ink, log = layout.get_pixel_extents()
    pw, ph = log.width + 6, log.height + 4
    cr.set_source_rgba(*axis_bg[(r - 1) % 5])
    cr.rectangle(2, cy - ph / 2, pw, ph)
    cr.fill()
    cr.set_source_rgba(1, 1, 1, 0.95)
    cr.move_to(5, cy - log.height / 2)
    PangoCairo.show_layout(cr, layout)

surface.write_to_png(dst)
`;

            const proc = Gio.Subprocess.new(
                ['python3', '-c', script, String(spacing), tmpIn, tmpOut],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const [, , stderrBytes] = proc.communicate(null, null);
            proc.wait(null);

            if (proc.get_exit_status() !== 0) {
                const errStr = stderrBytes
                    ? new TextDecoder().decode(stderrBytes.get_data()) : 'unknown';
                log(`[Aether] Grid overlay python error: ${errStr.slice(0, 300)}`);
                return base64Png;
            }

            const outFile = Gio.File.new_for_path(tmpOut);
            const [, outBytes] = outFile.load_contents(null);
            return GLib.base64_encode(outBytes);
        } catch (e) {
            log(`[Aether] Grid overlay failed: ${e.message}`);
            return base64Png;
        }
    }

    async _executeAgentLoop(run) {
        const agentTodoNames = new Set(['plan_tasks', 'complete_task', 'finish']);

        try {
            const registryTools = this._toolRegistry.getToolSchemas().filter(
                t => t.function.name !== 'spawn_agent' && t.function.name !== 'check_agent'
            );
            const tools = [...registryTools, ...this._getAgentTodoSchemas()];
            let iterations = 0;

            // Start debug log with run header
            this._debugLog(run, [
                `${'═'.repeat(60)}`,
                `AGENT RUN DEBUG LOG`,
                `${'═'.repeat(60)}`,
                `Agent: ${run.agentName} (${run.agentConfigId})`,
                `Run ID: ${run.id}`,
                `Model: ${run._providerConfig?.modelId || '?'}`,
                `Provider: ${run._providerConfig?.providerId || '?'}`,
                `Task: ${run.task}`,
                `Computer Use: ${run._isComputerUse}`,
                `Tools registered: ${tools.map(t => t.function.name).join(', ')}`,
                `Started: ${nowISO()}`,
                ``,
            ].join('\n'));
            console.log(`[Aether] Debug log: ${run._debugLogPath}`);

            // Computer use: auto-take an initial screenshot so the model
            // starts with visual context and stays in vision mode.
            if (run._isComputerUse) {
                const screenshotTool = this._toolRegistry._tools.get('screenshot');
                if (screenshotTool) {
                    try {
                        let initImage = null;
                        screenshotTool._injectImage = (b64) => { initImage = b64; };
                        await screenshotTool.execute({});
                        screenshotTool._injectImage = null;

                        if (initImage) {
                            // Apply grid overlay if enabled
                            const gridEnabled = this._settings.get_boolean('computer-use-grid-overlay');
                            const displayImage = gridEnabled
                                ? this._drawGridOverlay(initImage) : initImage;

                            // Store screenshot with grid for viewer
                            run._screenshots.push({
                                timestamp: nowISO(),
                                base64: displayImage,
                                context: 'initial',
                                actionCoords: null,
                            });

                            const detail = this._settings.get_string('computer-use-screenshot-detail') || 'low';
                            const gridSpacing = this._settings.get_int('computer-use-grid-spacing') || 100;
                            const gridNote = gridEnabled
                                ? `\n\nA coordinate grid is overlaid on the screenshot. Grid lines are ${gridSpacing}px apart. Each intersection is labeled with its (x,y) pixel coordinates — e.g. "${gridSpacing},${gridSpacing}" means x=${gridSpacing}, y=${gridSpacing}. The X axis labels are along the top edge, Y axis labels along the left edge. Use these coordinates directly in mouse_click({"x": ..., "y": ...}) calls.`
                                : '';
                            run.messages.push({
                                role: 'user',
                                content: [
                                    {type: 'text', text: `Here is the current desktop. Use the screenshot, mouse, and keyboard tools to complete your task visually. Start by examining this screenshot:${gridNote}`},
                                    {type: 'image_url', image_url: {
                                        url: `data:image/png;base64,${displayImage}`,
                                        detail,
                                    }},
                                ],
                            });
                            this._debugLogImageInjection(run, 0, 1, gridEnabled,
                                'initial', `Here is the current desktop...${gridNote.slice(0, 100)}`,
                                displayImage.length);

                            run.processLog.push({
                                type: 'tool_result',
                                timestamp: nowISO(),
                                content: '[initial screenshot captured for computer-use agent]',
                            });
                        }
                    } catch (e) {
                        log(`[Aether] Initial screenshot failed: ${e.message}`);
                    }
                }
            }

            while (iterations < MAX_AGENT_TOOL_ITERATIONS) {
                iterations++;

                const apiMessages = [
                    {role: 'system', content: run.systemPrompt},
                    ...run.messages,
                ];

                // Debug log: full API request
                this._debugLogApiRequest(run, iterations, apiMessages, tools.length);

                // Retry API call at agent-loop level in case aiProvider retry
                // doesn't catch the error (e.g. GJS socket-level exceptions).
                let response;
                const LOOP_RETRIES = 3;
                for (let apiAttempt = 0; apiAttempt <= LOOP_RETRIES; apiAttempt++) {
                    try {
                        response = await run.provider.chat(
                            apiMessages, tools, null, run.cancellable
                        );
                        break;
                    } catch (apiErr) {
                        if (run.cancellable?.is_cancelled())
                            throw apiErr;
                        const errMsg = apiErr.message || String(apiErr);
                        const isTransient = /timeout|timed out|socket|connection|reset|IOError|broken pipe/i.test(errMsg);
                        if (!isTransient || apiAttempt === LOOP_RETRIES)
                            throw apiErr;
                        const delay = 5000 * Math.pow(2, apiAttempt); // 5s, 10s, 20s, 40s
                        console.log(`[Aether] Agent loop API retry ${apiAttempt + 1}/${LOOP_RETRIES}: ${errMsg.slice(0, 100)} — waiting ${delay / 1000}s`);
                        run.processLog.push({
                            type: 'system',
                            timestamp: nowISO(),
                            content: `API retry ${apiAttempt + 1}: ${errMsg.slice(0, 80)}`,
                        });
                        await new Promise(resolve => {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                resolve();
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                    }
                }

                // Debug log: API response
                this._debugLogApiResponse(run, iterations, response);

                const assistantMsg = {role: 'assistant', content: response.content || ''};
                if (response.tool_calls && response.tool_calls.length > 0)
                    assistantMsg.tool_calls = response.tool_calls;
                run.messages.push(assistantMsg);

                const hasContent = response.content && response.content.length > 0;
                const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;

                // Only log text responses (not empty intermediary responses during tool calling)
                if (hasContent) {
                    run.processLog.push({
                        type: 'response',
                        timestamp: nowISO(),
                        content: response.content.length > 500
                            ? response.content.slice(0, 500) + '...'
                            : response.content,
                    });
                }

                // If no tool calls, agent is done
                if (!hasToolCalls) {
                    run.result = response.content || '';
                    run.state = 'completed';
                    run.completedAt = nowISO();
                    if (run.provider) {
                        run.provider.destroy();
                        run.provider = null;
                    }
                    this._writeRunLog(run);
                    this._notifyStateChange(run);
                    return;
                }

                // Set up screenshot image injection callback.
                // The screenshot tool pushes base64 images here; we inject
                // the last one as a multimodal user message after tool results.
                let pendingImages = [];
                const screenshotTool = this._toolRegistry._tools.get('screenshot');
                const clickAtTextTool = this._toolRegistry._tools.get('click_at_text');
                if (screenshotTool) {
                    screenshotTool._injectImage = (base64) => pendingImages.push(base64);
                }
                if (clickAtTextTool) {
                    clickAtTextTool._injectImage = (base64) => pendingImages.push(base64);
                }

                // Execute tool calls in parallel where possible.
                // Agent-scoped tools (plan_tasks, complete_task, finish) run
                // sequentially since they mutate shared state. All others
                // run concurrently via Promise.all.
                const todoCallIndices = new Set();

                for (let i = 0; i < response.tool_calls.length; i++) {
                    const tc = response.tool_calls[i];
                    if (agentTodoNames.has(tc.function.name))
                        todoCallIndices.add(i);
                }

                // Log all tool calls upfront
                const parsedArgs = response.tool_calls.map(tc => {
                    let toolArgs = {};
                    try { toolArgs = JSON.parse(tc.function.arguments); } catch {}
                    const argsPreview = JSON.stringify(toolArgs);
                    run.toolCallCount = (run.toolCallCount || 0) + 1;
                    run.processLog.push({
                        type: 'tool_call',
                        timestamp: nowISO(),
                        content: `${tc.function.name}(${argsPreview.length > 200 ? argsPreview.slice(0, 200) + '...' : argsPreview})`,
                    });
                    return toolArgs;
                });
                this._notifyStateChange(run);

                // Execute all non-todo tools in parallel
                const toolResults = new Array(response.tool_calls.length);
                const parallelPromises = [];

                for (let i = 0; i < response.tool_calls.length; i++) {
                    if (todoCallIndices.has(i))
                        continue;
                    const tc = response.tool_calls[i];
                    const idx = i;

                    // Guard: skip tool calls with missing/empty function name
                    // (some models like ZAI/GLM occasionally return tool_calls without a name)
                    const toolName = tc.function?.name;
                    if (!toolName) {
                        toolResults[idx] = JSON.stringify({
                            error: 'Unknown tool: undefined',
                            hint: 'Your tool call was missing a function name. Please specify which tool you want to use.',
                        });
                        continue;
                    }

                    parallelPromises.push(
                        (async () => {
                            try {
                                toolResults[idx] = await this._toolExecute(toolName, parsedArgs[idx]);

                                // Track test results so finish can validate
                                if (toolName === 'run_command') {
                                    const cmd = (parsedArgs[idx].command || '').toLowerCase();
                                    const isTest = /pytest|unittest|jest|mocha|cargo test|go test|npm test|make test/i.test(cmd);
                                    if (isTest) {
                                        try {
                                            const parsed = JSON.parse(toolResults[idx]);
                                            run._lastTestResult = {
                                                command: cmd,
                                                exitCode: parsed.exit_code ?? -1,
                                                timedOut: !!(parsed.error && /timed? ?out/i.test(parsed.error)),
                                            };
                                        } catch { /* not JSON, skip */ }
                                    }
                                }
                            } catch (toolErr) {
                                toolResults[idx] = JSON.stringify({error: toolErr.message || String(toolErr)});
                            }
                        })()
                    );
                }

                // Wait for all parallel tools to finish
                if (parallelPromises.length > 0)
                    await Promise.all(parallelPromises);

                // Now execute todo tools sequentially (they depend on order)
                for (let i = 0; i < response.tool_calls.length; i++) {
                    if (!todoCallIndices.has(i))
                        continue;
                    const tc = response.tool_calls[i];
                    try {
                        toolResults[i] = this._executeAgentTodo(run, tc.function.name, parsedArgs[i]);
                    } catch (toolErr) {
                        toolResults[i] = JSON.stringify({error: toolErr.message || String(toolErr)});
                    }
                }

                // Push all results to messages in order
                for (let i = 0; i < response.tool_calls.length; i++) {
                    const tc = response.tool_calls[i];
                    const toolResult = toolResults[i];
                    const resultPreview = typeof toolResult === 'string'
                        ? toolResult : JSON.stringify(toolResult);
                    run.processLog.push({
                        type: 'tool_result',
                        timestamp: nowISO(),
                        content: resultPreview.length > 500
                            ? resultPreview.slice(0, 500) + '...'
                            : resultPreview,
                    });

                    run.messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                    });
                }

                // Debug log: tool results
                this._debugLogToolResults(run, iterations, run.messages.slice(-response.tool_calls.length));

                // ── Computer use: auto-screenshot after actions ──
                // If the model performed an action (click, type, etc.) without
                // explicitly calling screenshot, we:
                //   1. Annotate the previous screenshot with a red dot at click coords
                //   2. Auto-capture a new screenshot showing the result
                // This gives the model two views: "you clicked HERE" + "this is what happened"
                const CU_ACTION_TOOLS = new Set([
                    'mouse_click', 'mouse_move', 'keyboard_type',
                    'keyboard_shortcut', 'scroll', 'click_at_text',
                ]);

                if (run._isComputerUse && screenshotTool) {
                    const calledNames = response.tool_calls.map(tc => tc.function.name);
                    const hadAction = calledNames.some(n => CU_ACTION_TOOLS.has(n));
                    const hadScreenshot = calledNames.includes('screenshot');

                    // Track repeated identical actions
                    if (hadScreenshot || pendingImages.length > 0) {
                        run._consecutiveSameAction = 0;
                        run._lastActionKey = null;
                    }
                    if (hadAction) {
                        const actionCalls = response.tool_calls.filter(
                            tc => CU_ACTION_TOOLS.has(tc.function.name)
                        );
                        const lastAct = actionCalls[actionCalls.length - 1];
                        const actionKey = `${lastAct.function.name}:${lastAct.function.arguments}`;
                        if (actionKey === run._lastActionKey)
                            run._consecutiveSameAction++;
                        else
                            run._consecutiveSameAction = 1;
                        run._lastActionKey = actionKey;
                    }

                    if (hadAction && !hadScreenshot) {
                        // Find last action coordinates from tool results
                        let clickX = null, clickY = null, actionName = '';
                        for (let i = response.tool_calls.length - 1; i >= 0; i--) {
                            const tc = response.tool_calls[i];
                            if (CU_ACTION_TOOLS.has(tc.function.name)) {
                                actionName = tc.function.name;
                                try {
                                    const res = JSON.parse(toolResults[i]);
                                    if (typeof res.x === 'number' && typeof res.y === 'number') {
                                        clickX = res.x;
                                        clickY = res.y;
                                    }
                                } catch {}
                                break;
                            }
                        }

                        // Annotate previous screenshot with click dot
                        if (clickX !== null && clickY !== null) {
                            // Update the last stored screenshot's actionCoords
                            if (run._screenshots.length > 0)
                                run._screenshots[run._screenshots.length - 1].actionCoords = {x: clickX, y: clickY};
                            for (let mi = run.messages.length - 1; mi >= 0; mi--) {
                                const msg = run.messages[mi];
                                if (!Array.isArray(msg.content)) continue;
                                const imgPart = msg.content.find(p => p.type === 'image_url');
                                if (imgPart?.image_url?.url?.startsWith('data:image/png;base64,')) {
                                    const oldB64 = imgPart.image_url.url.slice('data:image/png;base64,'.length);
                                    const annotated = this._annotateScreenshot(oldB64, clickX, clickY);
                                    imgPart.image_url.url = `data:image/png;base64,${annotated}`;
                                    // Update text to describe the click
                                    const textPart = msg.content.find(p => p.type === 'text');
                                    if (textPart)
                                        textPart.text = `You clicked at coordinates (${clickX}, ${clickY}) as shown by the red crosshair in this image:`;
                                    break;
                                }
                            }
                        }

                        // Wait for UI to settle after the action
                        const actionDelay = this._settings.get_int('computer-use-action-delay') || 100;
                        await new Promise(resolve => {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(actionDelay, 200), () => {
                                resolve();
                                return GLib.SOURCE_REMOVE;
                            });
                        });

                        // Auto-take new screenshot (_injectImage callback still active)
                        try {
                            await screenshotTool.execute({});
                        } catch (e) {
                            log(`[Aether] Auto-screenshot failed: ${e.message}`);
                        }

                        // Log the auto-screenshot
                        run.processLog.push({
                            type: 'tool_result',
                            timestamp: nowISO(),
                            content: `[auto-screenshot after ${actionName}]`,
                        });
                    }
                }

                // Inject screenshot images as multimodal user messages.
                // Include a text prompt to guide the model's analysis.
                if (pendingImages.length > 0) {
                    const lastImage = pendingImages[pendingImages.length - 1];
                    const detail = this._settings.get_string('computer-use-screenshot-detail') || 'low';

                    // Apply grid overlay if enabled
                    const gridEnabled = run._isComputerUse
                        && this._settings.get_boolean('computer-use-grid-overlay');
                    const displayImage = gridEnabled
                        ? this._drawGridOverlay(lastImage) : lastImage;

                    // Store screenshot with grid for the agent indicator viewer
                    run._screenshots.push({
                        timestamp: nowISO(),
                        base64: displayImage,
                        context: pendingImages.length > 1 ? 'auto-after-click' : 'manual',
                        actionCoords: null,
                    });

                    // Build the text prompt based on context
                    let prompt;
                    const count = run._consecutiveSameAction || 0;
                    if (count >= 3) {
                        prompt = `SYSTEM WARNING: You repeated the exact same action ${count} times. This is NOT working. Look at this screenshot carefully. Try a COMPLETELY DIFFERENT approach — different coordinates, keyboard shortcuts, URL navigation, etc.

Current screen state:`;
                    } else if (count >= 2) {
                        prompt = `You repeated the same action twice. Look carefully — did anything change? If not, try a different approach.

Current screen state:`;
                    } else {
                        prompt = 'This is the current screen state. Examine what you see, then decide your next action:';
                    }

                    run.messages.push({
                        role: 'user',
                        content: [
                            {type: 'text', text: prompt},
                            {type: 'image_url', image_url: {
                                url: `data:image/png;base64,${displayImage}`,
                                detail,
                            }},
                        ],
                    });
                    const imgContext = pendingImages.length > 1 ? 'auto-after-click' : 'manual';
                    this._debugLogImageInjection(run, iterations, pendingImages.length,
                        gridEnabled, imgContext, prompt, displayImage.length);

                    pendingImages = [];

                    // Evict old screenshots beyond the max to prevent context overflow
                    const maxImages = this._settings.get_int('computer-use-max-images') || 3;
                    let imageCount = 0;
                    for (let mi = run.messages.length - 1; mi >= 0; mi--) {
                        const msg = run.messages[mi];
                        if (Array.isArray(msg.content) &&
                            msg.content.some(p => p.type === 'image_url')) {
                            imageCount++;
                            if (imageCount > maxImages) {
                                msg.content = msg.content.map(p =>
                                    p.type === 'image_url'
                                        ? {type: 'text', text: '[older screenshot removed — refer to your more recent screenshots]'}
                                        : p
                                );
                            }
                        }
                    }
                }

                // Clean up screenshot callbacks
                if (screenshotTool)
                    screenshotTool._injectImage = null;
                if (clickAtTextTool)
                    clickAtTextTool._injectImage = null;

                // Detect repeated tool errors — if the same error appears 3+
                // times, the tool infrastructure is broken, not the agent.
                const REPEAT_ERROR_THRESHOLD = 3;
                const currentErrors = new Map();
                for (let i = 0; i < response.tool_calls.length; i++) {
                    if (todoCallIndices.has(i)) continue;
                    const res = toolResults[i];
                    if (typeof res === 'string') {
                        try {
                            const parsed = JSON.parse(res);
                            if (parsed.error) {
                                const key = parsed.error.slice(0, 200);
                                currentErrors.set(key, (currentErrors.get(key) || 0) + 1);
                            }
                        } catch { /* not JSON */ }
                    }
                }
                // Update running tally — reset for errors not seen this round
                for (const [errMsg, count] of currentErrors) {
                    run._repeatedErrors.set(errMsg,
                        (run._repeatedErrors.get(errMsg) || 0) + count);
                }
                for (const key of run._repeatedErrors.keys()) {
                    if (!currentErrors.has(key))
                        run._repeatedErrors.delete(key);
                }
                // Check if any error hit the threshold
                for (const [errMsg, total] of run._repeatedErrors) {
                    if (total >= REPEAT_ERROR_THRESHOLD && !run._isRepairAgent) {
                        console.log(`[Aether] Repeated tool error (${total}x): ${errMsg.slice(0, 100)}`);
                        run.state = 'error';
                        run.error = `Repeated tool failure (${total}x): ${errMsg.slice(0, 150)}`;
                        run.completedAt = nowISO();
                        run.processLog.push({
                            type: 'error',
                            timestamp: nowISO(),
                            content: `Auto-stopped: tool error repeated ${total} times: ${errMsg.slice(0, 150)}`,
                        });
                        if (run.provider) { run.provider.destroy(); run.provider = null; }
                        this._writeRunLog(run);
                        this._notifyStateChange(run);
                        this._attemptAutoRepair(run);
                        return;
                    }
                }

                if (run._finished) {
                    run.state = 'completed';
                    run.completedAt = nowISO();
                    run.processLog.push({
                        type: 'system',
                        timestamp: nowISO(),
                        content: 'Agent called finish — task complete.',
                    });
                    if (run.provider) {
                        run.provider.destroy();
                        run.provider = null;
                    }
                    this._writeRunLog(run);
                    this._notifyStateChange(run);
                    return;
                }

                this._notifyStateChange(run);
            }

            // Max iterations reached — mark as error so the user knows it didn't finish
            const lastAssistant = run.messages.filter(m => m.role === 'assistant').pop();
            run.result = lastAssistant?.content || '';
            run.state = 'error';
            run.error = `Stopped: max iterations (${MAX_AGENT_TOOL_ITERATIONS}) reached`;
            run.completedAt = nowISO();
            run.processLog.push({
                type: 'error',
                timestamp: nowISO(),
                content: `Stopped: max iterations (${MAX_AGENT_TOOL_ITERATIONS}) reached.`,
            });
            if (run.provider) {
                run.provider.destroy();
                run.provider = null;
            }
            this._writeRunLog(run);
            this._notifyStateChange(run);
            this._attemptAutoRepair(run);

        } catch (e) {
            const errorMsg = e.message || String(e);
            const isCancelled = run.cancellable?.is_cancelled()
                || (errorMsg.includes('ancelled') && !errorMsg.includes('timed out') && !errorMsg.includes('timeout'));
            if (!isCancelled)
                console.error(`[Aether] Agent ${run.agentName} error: ${errorMsg}`);

            // Don't overwrite if already set by cancelAgent()
            if (run.state === 'running') {
                run.state = 'error';
                run.error = isCancelled ? 'Cancelled' : errorMsg;
                run.completedAt = nowISO();
                run.processLog.push({
                    type: 'error',
                    timestamp: nowISO(),
                    content: isCancelled ? 'Cancelled' : errorMsg,
                });
                if (run.provider) {
                    run.provider.destroy();
                    run.provider = null;
                }
                this._writeRunLog(run);
                this._notifyStateChange(run);
                if (!isCancelled && !run._isRepairAgent)
                    this._attemptAutoRepair(run);
            }
        }
    }

    checkAgent(runId) {
        const run = this._runs.get(runId);
        if (!run)
            return {error: `No agent run found with ID "${runId}"`};

        return {
            id: run.id,
            agentName: run.agentName,
            task: run.task,
            state: run.state,
            result: run.result,
            error: run.error,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            toolCallCount: run.processLog.filter(l => l.type === 'tool_call').length,
            processLog: run.processLog.slice(-10).map(l => `[${l.type}] ${l.content}`),
        };
    }

    listAgents() {
        return [...this._runs.values()].map(run => ({
            id: run.id,
            agentName: run.agentName,
            task: run.task,
            state: run.state,
            result: run.result,
            todos: run.todos || [],
            toolCallCount: run.toolCallCount || 0,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
        }));
    }

    getRunLog(runId) {
        const run = this._runs.get(runId);
        return run ? run.processLog : [];
    }

    getRunScreenshots(runId) {
        const run = this._runs.get(runId);
        return run ? run._screenshots : [];
    }

    getRunningCount() {
        let count = 0;
        for (const run of this._runs.values()) {
            if (run.state === 'running')
                count++;
        }
        return count;
    }

    _scheduleHealthCheck(run) {
        // Repair agents get a hard timeout instead of AI-based checks
        const intervalMs = run._isRepairAgent ? 300000 : 60000; // 5min vs 1min

        run._healthCheckSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            intervalMs,
            () => {
                run._healthCheckSourceId = 0;
                if (run.state !== 'running') return GLib.SOURCE_REMOVE;

                if (run._isRepairAgent) {
                    // Hard timeout for repair agents — no second chances
                    const elapsed = Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000);
                    console.log(`[Aether] Repair agent timeout after ${elapsed}s — force-cancelling`);
                    if (run.cancellable) run.cancellable.cancel();
                    run.state = 'error';
                    run.error = `Repair agent timed out after ${elapsed}s`;
                    run.completedAt = nowISO();
                    run.processLog.push({
                        type: 'error', timestamp: nowISO(),
                        content: `Repair agent hard-timeout at ${elapsed}s`,
                    });
                    if (run.provider) { run.provider.destroy(); run.provider = null; }
                    this._writeRunLog(run);
                    this._notifyStateChange(run);
                } else {
                    this._performHealthCheck(run);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelHealthCheck(run) {
        if (run._healthCheckSourceId > 0) {
            GLib.source_remove(run._healthCheckSourceId);
            run._healthCheckSourceId = 0;
        }
    }

    async _performHealthCheck(run) {
        if (run.state !== 'running') return;

        console.log(`[Aether] Health check for agent "${run.agentName}" (${run.id.slice(0, 8)})`);

        // Build a summary of timestamps and activity
        const toolCalls = run.processLog.filter(l => l.type === 'tool_call');
        const errors = run.processLog.filter(l => l.type === 'error');
        const startTime = new Date(run.startedAt).getTime();
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        const timestampLog = run.processLog.slice(-30).map(l =>
            `[${l.timestamp}] [${l.type}] ${l.content.slice(0, 200)}`
        ).join('\n');

        // Calculate time since last activity
        const lastLogTime = run.processLog.length > 0
            ? new Date(run.processLog[run.processLog.length - 1].timestamp).getTime() : startTime;
        const silentSeconds = Math.round((Date.now() - lastLogTime) / 1000);

        const checkPrompt = `You are a health-check monitor. Decide if this agent is stuck.

AGENT: "${run.agentName}"
TASK: ${run.task.slice(0, 300)}
ELAPSED: ${elapsed}s | SILENT FOR: ${silentSeconds}s (no tool calls)
TOOL CALLS: ${toolCalls.length} | ERRORS: ${errors.length}
ITERATIONS: ${run.toolCallCount || 0} / ${MAX_AGENT_TOOL_ITERATIONS}

RECENT LOG (last 30 entries):
${timestampLog}

CANCEL if ANY of these are true:
- Silent for >60s with no new tool calls (model stalled or API hung)
- Agent announced an action ("Let me write/create...") but never made the tool call
- Same error repeating 3+ times
- Agent is just reading files without producing output for the task

CONTINUE only if there are recent tool calls (within last 30s) making real progress.

Reply: VERDICT:CONTINUE or VERDICT:CANCEL plus a one-line reason.`;

        try {
            // Create a temporary provider for the health check call
            const pc = run._providerConfig;
            const checkProvider = new AIProvider(
                pc.providerId, pc.provCfg.name, pc.provCfg.apiKey, pc.provCfg.baseUrl
            );
            checkProvider.setModel(pc.modelId);

            const response = await checkProvider.chat(
                [{role: 'system', content: 'You are a concise diagnostic assistant. Respond only with VERDICT and reason.'},
                 {role: 'user', content: checkPrompt}],
                [], null, null
            );
            checkProvider.destroy();

            const text = response.content || '';
            console.log(`[Aether] Health check result for "${run.agentName}": ${text.slice(0, 200)}`);

            if (text.includes('VERDICT:CANCEL')) {
                console.log(`[Aether] Health check: CANCELLING stuck agent "${run.agentName}"`);
                run.processLog.push({
                    type: 'system',
                    timestamp: nowISO(),
                    content: `Health check cancelled agent: ${text.slice(0, 200)}`,
                });

                // Cancel and trigger auto-repair
                if (run.cancellable) run.cancellable.cancel();
                run.state = 'error';
                run.error = `Health check: agent appears stuck after ${elapsed}s`;
                run.completedAt = nowISO();
                if (run.provider) { run.provider.destroy(); run.provider = null; }
                this._writeRunLog(run);
                this._notifyStateChange(run);
                this._attemptAutoRepair(run);
            } else {
                // Agent is making progress — schedule next check
                run.processLog.push({
                    type: 'system',
                    timestamp: nowISO(),
                    content: `Health check: continuing (${elapsed}s elapsed, ${toolCalls.length} tool calls)`,
                });
                this._scheduleHealthCheck(run);
            }
        } catch (healthErr) {
            console.warn(`[Aether] Health check API error (non-fatal): ${healthErr.message}`);
            // If health check itself fails, reschedule anyway
            this._scheduleHealthCheck(run);
        }
    }

    _attemptAutoRepair(run) {
        // Don't repair a repair agent (no infinite loops)
        if (run._isRepairAgent) return;

        // Don't repair if there's already a repair agent for this run
        for (const r of this._runs.values()) {
            if (r._repairTargetRunId === run.id && r.state === 'running')
                return;
        }

        // Tar backup before repair (git stash reverts un-committed files
        // which destroys synced dev→installed changes — use tar instead)
        const extPath = this._extensionPath;
        if (extPath) {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupPath = `/tmp/aether-autorepair-backup-${timestamp}.tar.gz`;
                const proc = Gio.Subprocess.new(
                    ['tar', '-czf', backupPath, '-C', extPath, '.'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.wait(null);
                if (proc.get_exit_status() === 0)
                    console.log(`[Aether] Auto-repair backup created: ${backupPath}`);
                else
                    console.warn(`[Aether] Auto-repair backup tar failed (continuing)`);
            } catch (backupErr) {
                console.warn(`[Aether] Auto-repair backup failed (continuing): ${backupErr.message}`);
            }
        }

        // Build the repair task with full context
        const errorSummary = run.error || 'Unknown error';
        const stateDesc = run.state === 'error' && run.error?.includes('max iterations')
            ? 'max_iterations' : 'error';
        const lastAssistant = run.messages.filter(m => m.role === 'assistant').pop();
        const lastAssistantContent = lastAssistant?.content
            ? lastAssistant.content.slice(0, 2000) : '(none)';
        const recentLog = run.processLog.slice(-20)
            .map(l => `[${l.timestamp}] [${l.type}] ${l.content}`).join('\n');
        const logPath = run._logPath || '(log not written)';

        const repairTask = `AUTO-REPAIR: A previous agent failed. Diagnose the root cause and fix it if possible. You have 5 MINUTES MAX.

YOUR JOB:
1. Read the log file to understand exactly what went wrong
2. If you find a fixable bug in the extension source code — FIX IT with edit_file
3. If the issue is in how agents are prompted or configured — fix the relevant code
4. If it's a transient error (API timeout, network issue) — report not_relevant
5. Call finish with your outcome

WHAT YOU CAN FIX:
- Code bugs in extension JS files (tool implementations, agent manager, prompts, etc.)
- Tool argument handling issues (parsing, validation, error messages)
- Agent behavioral issues caused by code (missing enforcement, wrong prompt selection)
- Configuration problems in the extension

WHAT YOU SHOULD NOT DO:
- Do NOT redo or retry the original task
- Do NOT spend more than ~10 tool calls total — diagnose fast, fix if you can, finish
- Do NOT read files unrelated to the error

FAILED AGENT: ${run.agentName}
ERROR: ${errorSummary}
FAILURE MODE: ${stateDesc}
ORIGINAL TASK (for context only — do NOT attempt it): ${run.task.slice(0, 300)}

EXTENSION SOURCE: ${extPath || '(unknown)'}
LOG FILE: ${logPath}

RECENT LOG (last 20 entries):
${recentLog}

LAST AI MESSAGE BEFORE FAILURE:
${lastAssistantContent}

After diagnosing (and fixing if applicable), call finish with EXACTLY one of:
- "OUTCOME:fixed REASON:<what you fixed and in which file>" — you found AND fixed a code/config bug
- "OUTCOME:not_relevant REASON:<explanation>" — transient error (API timeout, network, model stall)
- "OUTCOME:failed REASON:<what's wrong and why you couldn't fix it>" — found a bug but couldn't fix it`;

        // Save the task for potential retry after re-login
        if (this._memory) {
            this._memory.saveTask(run.agentConfigId, run.task, errorSummary)
                .then(() => console.log(`[Aether] Saved failed task for retry`))
                .catch(e => console.warn(`[Aether] Failed to save task: ${e.message}`));
        }

        // Send GNOME notification that repair is starting
        try {
            Main.notify(
                'Aether Auto-Repair',
                `Repairing agent "${run.agentName}": ${errorSummary.slice(0, 100)}`
            );
        } catch { /* notification failure is non-fatal */ }

        // Spawn the repair agent using the same agent config
        this.spawnAgent(run.agentConfigId, repairTask).then(repairRunId => {
            const repairRun = this._runs.get(repairRunId);
            if (repairRun) {
                repairRun._isRepairAgent = true;
                repairRun._repairTargetRunId = run.id;
            }
            console.log(`[Aether] Auto-repair agent spawned: ${repairRunId} for failed run ${run.id}`);
        }).catch(err => {
            console.error(`[Aether] Failed to spawn auto-repair agent: ${err.message}`);
            try {
                Main.notify(
                    'Aether Auto-Repair Failed',
                    `Could not spawn repair agent: ${err.message.slice(0, 100)}`
                );
            } catch { /* notification failure is non-fatal */ }
        });
    }

    _onRepairComplete(repairRun) {
        const originalRun = this._runs.get(repairRun._repairTargetRunId);
        const result = repairRun.result || '';

        // Parse outcome from the repair agent's finish summary
        let outcome = 'failed';
        let reason = result;
        const outcomeMatch = result.match(/OUTCOME:(\w+)/);
        const reasonMatch = result.match(/REASON:([\s\S]*)/);
        if (outcomeMatch) outcome = outcomeMatch[1].toLowerCase();
        if (reasonMatch) reason = reasonMatch[1].trim();

        const originalTask = originalRun
            ? originalRun.task.slice(0, 80) : '(unknown)';

        if (outcome === 'fixed') {
            console.log(`[Aether] Auto-repair succeeded for "${originalTask}": ${reason.slice(0, 200)}`);
            // Mark saved task as retried (no longer pending)
            if (this._memory && originalRun) {
                this._memory.getSavedTasks().then(tasks => {
                    const match = tasks.find(t =>
                        t.agent_config_id === originalRun.agentConfigId
                        && t.task === originalRun.task && t.status === 'pending');
                    if (match)
                        this._memory.updateSavedTaskStatus(match.id, 'retried').catch(() => {});
                }).catch(() => {});
            }
            try {
                Main.notify(
                    'Aether Auto-Repair Succeeded',
                    reason.slice(0, 150)
                );
            } catch { /* non-fatal */ }
        } else if (outcome === 'not_relevant') {
            console.log(`[Aether] Auto-repair: not relevant for "${originalTask}": ${reason.slice(0, 200)}`);
            try {
                Main.notify(
                    'Aether Auto-Repair: Not Relevant',
                    reason.slice(0, 150)
                );
            } catch { /* non-fatal */ }
        } else {
            console.log(`[Aether] Auto-repair failed for "${originalTask}": ${reason.slice(0, 200)}`);
            try {
                Main.notify(
                    'Aether Auto-Repair Failed',
                    reason.slice(0, 150)
                );
            } catch { /* non-fatal */ }
        }
    }

    _writeRunLog(run) {
        try {
            const logsDir = GLib.build_filenamev([getConfigDir(), 'logs']);
            const dir = Gio.File.new_for_path(logsDir);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);

            const date = new Date().toISOString().slice(0, 10);
            const safeAgent = (run.agentName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = `${date}_${safeAgent}_${run.id.slice(0, 8)}.log`;
            const logPath = GLib.build_filenamev([logsDir, filename]);
            run._logPath = logPath;

            const lines = [
                `=== Agent Run Log ===`,
                `Agent: ${run.agentName} (${run.agentConfigId})`,
                `Run ID: ${run.id}`,
                `State: ${run.state}`,
                `Started: ${run.startedAt}`,
                `Completed: ${run.completedAt || 'N/A'}`,
                `Tool calls: ${run.toolCallCount || 0}`,
                `Task: ${run.task}`,
                ``,
                `--- Result ---`,
                run.result || '(no result)',
                ``,
                run.error ? `--- Error ---\n${run.error}\n` : '',
                `--- Process Log (${run.processLog.length} entries) ---`,
                ...run.processLog.map(l => `[${l.timestamp}] [${l.type}] ${l.content}`),
                ``,
                `--- Full Messages (${run.messages.length}) ---`,
                ...run.messages.map(m => {
                    let line = `[${m.role}] `;
                    if (Array.isArray(m.content)) {
                        // Multimodal content — summarize each part
                        const parts = m.content.map(p => {
                            if (p.type === 'text')
                                return p.text?.length > 200 ? p.text.slice(0, 200) + '...' : p.text;
                            if (p.type === 'image_url')
                                return `[image: ${p.image_url?.detail || 'auto'} detail, ${(p.image_url?.url?.length || 0)} chars]`;
                            return JSON.stringify(p).slice(0, 100);
                        });
                        line += parts.join(' | ');
                    } else if (m.content) {
                        line += m.content.length > 2000 ? m.content.slice(0, 2000) + '...' : m.content;
                    }
                    if (m.tool_calls)
                        line += `\n  tool_calls: ${JSON.stringify(m.tool_calls).slice(0, 1000)}`;
                    if (m.tool_call_id)
                        line += `(tool_call_id: ${m.tool_call_id})`;
                    return line;
                }),
            ];

            const file = Gio.File.new_for_path(logPath);
            const bytes = new TextEncoder().encode(lines.join('\n'));
            file.replace_contents(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            console.log(`[Aether] Agent log saved: ${logPath}`);
        } catch (e) {
            console.error(`[Aether] Failed to write agent log: ${e.message}`);
        }
    }

    /**
     * Incremental debug logging — appends to a per-run debug file so the user
     * can `tail -f` it during execution to see exactly what the AI receives.
     */
    _debugLog(run, text) {
        try {
            if (!run._debugLogPath) {
                const logsDir = GLib.build_filenamev([getConfigDir(), 'logs']);
                const dir = Gio.File.new_for_path(logsDir);
                if (!dir.query_exists(null))
                    dir.make_directory_with_parents(null);
                run._debugLogPath = GLib.build_filenamev([
                    logsDir, `debug_${run.id.slice(0, 8)}.log`,
                ]);
            }
            const file = Gio.File.new_for_path(run._debugLogPath);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(text + '\n'), null);
            stream.close(null);
        } catch (e) {
            console.error(`[Aether] Debug log write failed: ${e.message}`);
        }
    }

    /**
     * Log the full messages array being sent to the API.
     */
    _debugLogApiRequest(run, iteration, apiMessages, toolCount) {
        const sep = '═'.repeat(60);
        const lines = [];
        lines.push(`\n${sep}`);
        lines.push(`ITERATION ${iteration} — API REQUEST  [${nowISO()}]`);
        lines.push(sep);

        // Count images
        let imageCount = 0;
        for (const m of apiMessages) {
            if (Array.isArray(m.content)) {
                for (const p of m.content) {
                    if (p.type === 'image_url') imageCount++;
                }
            }
        }
        lines.push(`Messages: ${apiMessages.length}, Images: ${imageCount}, Tools: ${toolCount}`);
        lines.push('');

        for (let i = 0; i < apiMessages.length; i++) {
            const m = apiMessages[i];
            if (m.role === 'system') {
                // Log system prompt fully on first iteration, summary otherwise
                if (iteration === 1) {
                    lines.push(`[SYSTEM PROMPT]`);
                    lines.push(m.content);
                } else {
                    lines.push(`[SYSTEM PROMPT] (${m.content.length} chars, same as iteration 1)`);
                }
            } else if (m.role === 'user') {
                if (Array.isArray(m.content)) {
                    lines.push(`[USER #${i}] (multimodal)`);
                    for (const part of m.content) {
                        if (part.type === 'text') {
                            lines.push(`  Text: ${part.text}`);
                        } else if (part.type === 'image_url') {
                            const url = part.image_url?.url || '';
                            const detail = part.image_url?.detail || 'auto';
                            if (url.startsWith('data:image')) {
                                const b64Len = url.length - url.indexOf(',') - 1;
                                lines.push(`  Image: [BASE64 PNG, ${b64Len} chars, detail: ${detail}]`);
                            } else {
                                lines.push(`  Image: [placeholder/removed]`);
                            }
                        }
                    }
                } else {
                    lines.push(`[USER #${i}] ${m.content}`);
                }
            } else if (m.role === 'assistant') {
                lines.push(`[ASSISTANT #${i}]`);
                if (m.content)
                    lines.push(`  Content: ${m.content}`);
                if (m.tool_calls) {
                    for (const tc of m.tool_calls) {
                        const fn = tc.function || {};
                        lines.push(`  Tool call: ${fn.name}(${fn.arguments || ''})`);
                    }
                }
            } else if (m.role === 'tool') {
                const content = m.content || '';
                lines.push(`[TOOL RESULT #${i}] (call_id: ${m.tool_call_id || '?'})`);
                lines.push(`  ${content.length > 1000 ? content.slice(0, 1000) + '...' : content}`);
            }
            lines.push('');
        }

        this._debugLog(run, lines.join('\n'));
    }

    /**
     * Log the API response.
     */
    _debugLogApiResponse(run, iteration, response) {
        const sep = '─'.repeat(60);
        const lines = [];
        lines.push(`${sep}`);
        lines.push(`ITERATION ${iteration} — API RESPONSE  [${nowISO()}]`);
        lines.push(sep);
        if (response.content)
            lines.push(`Content: ${response.content}`);
        else
            lines.push(`Content: (empty)`);

        if (response.tool_calls && response.tool_calls.length > 0) {
            lines.push(`Tool calls: ${response.tool_calls.length}`);
            for (const tc of response.tool_calls) {
                const fn = tc.function || {};
                lines.push(`  → ${fn.name}(${fn.arguments || ''})`);
            }
        } else {
            lines.push(`Tool calls: none (finish_reason: ${response.finish_reason || '?'})`);
        }

        if (response.usage) {
            const u = response.usage;
            lines.push(`Usage: prompt=${u.prompt_tokens || '?'}, completion=${u.completion_tokens || '?'}, total=${u.total_tokens || '?'}`);
        }
        lines.push('');
        this._debugLog(run, lines.join('\n'));
    }

    /**
     * Log tool execution results.
     */
    _debugLogToolResults(run, iteration, results) {
        const lines = [];
        lines.push(`── ITERATION ${iteration} — TOOL RESULTS ──`);
        for (const r of results) {
            const content = r.content || '';
            lines.push(`  → [${r.tool_call_id || '?'}] ${content.length > 500 ? content.slice(0, 500) + '...' : content}`);
        }
        lines.push('');
        this._debugLog(run, lines.join('\n'));
    }

    /**
     * Log image injection into messages.
     */
    _debugLogImageInjection(run, iteration, pendingCount, gridApplied, context, promptText, b64Length) {
        const lines = [];
        lines.push(`── ITERATION ${iteration} — IMAGE INJECTION ──`);
        lines.push(`  Pending images: ${pendingCount}`);
        lines.push(`  Grid overlay applied: ${gridApplied}`);
        lines.push(`  Context: ${context}`);
        lines.push(`  Image: [BASE64 PNG, ${b64Length} chars]`);
        lines.push(`  Prompt: ${promptText.slice(0, 300)}${promptText.length > 300 ? '...' : ''}`);
        lines.push('');
        this._debugLog(run, lines.join('\n'));
    }

    _notifyStateChange(run) {
        // Cancel health check timer when agent finishes
        if (run.state !== 'running')
            this._cancelHealthCheck(run);

        // If a repair agent just completed, handle its result
        if (run._isRepairAgent && (run.state === 'completed' || run.state === 'error')) {
            if (run.state === 'completed') {
                this._onRepairComplete(run);
            } else {
                // Repair agent itself errored
                const originalRun = this._runs.get(run._repairTargetRunId);
                const originalTask = originalRun?.task?.slice(0, 80) || '(unknown)';
                console.error(`[Aether] Auto-repair agent itself failed for "${originalTask}": ${run.error}`);
                try {
                    Main.notify(
                        'Aether Auto-Repair Failed',
                        `Repair agent errored: ${(run.error || '').slice(0, 100)}`
                    );
                } catch { /* non-fatal */ }
            }
        }

        if (this._onStateChange)
            this._onStateChange(run.id, run);
    }

    async getSavedTasks() {
        if (!this._memory) return [];
        try {
            return await this._memory.getSavedTasks();
        } catch {
            return [];
        }
    }

    async retryTask(savedTaskId) {
        if (!this._memory) throw new Error('Memory not available');
        const tasks = await this._memory.getSavedTasks();
        const task = tasks.find(t => t.id === savedTaskId);
        if (!task) throw new Error(`Saved task ${savedTaskId} not found`);

        // Mark as retried
        await this._memory.updateSavedTaskStatus(savedTaskId, 'retried');

        // Spawn the agent with the original task
        return this.spawnAgent(task.agent_config_id, task.task);
    }

    async dismissTask(savedTaskId) {
        if (!this._memory) throw new Error('Memory not available');
        await this._memory.updateSavedTaskStatus(savedTaskId, 'dismissed');
    }

    destroy() {
        for (const run of this._runs.values()) {
            if (run.cancellable)
                run.cancellable.cancel();
            if (run.provider) {
                run.provider.destroy();
                run.provider = null;
            }
        }
        this._runs.clear();
        this._onStateChange = null;
    }
}
