import St from 'gi://St';

export class ClipboardReadTool {
    constructor() {
        this.name = 'clipboard_read';
        this.description = 'Read the current contents of the system clipboard.';
        this.parameters = {
            type: 'object',
            properties: {},
        };
    }

    execute() {
        return new Promise((resolve) => {
            const clipboard = St.Clipboard.get_default();
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (clip, text) => {
                if (text)
                    resolve(text);
                else
                    resolve('(clipboard is empty or contains non-text content)');
            });
        });
    }
}

export class ClipboardWriteTool {
    constructor() {
        this.name = 'clipboard_write';
        this.description = 'Write text to the system clipboard.';
        this.parameters = {
            type: 'object',
            properties: {
                text: {type: 'string', description: 'Text to copy to clipboard'},
            },
            required: ['text'],
        };
    }

    execute(args) {
        return new Promise((resolve) => {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, args.text);
            resolve(`Copied ${args.text.length} characters to clipboard.`);
        });
    }
}
