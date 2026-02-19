import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

export class AppLauncherTool {
    constructor() {
        this.name = 'launch_app';
        this.description = 'Launch a desktop application by name. Searches installed .desktop files.';
        this.parameters = {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Application name to search for (e.g., "firefox", "chrome", "files", "terminal")',
                },
            },
            required: ['name'],
        };
    }

    execute(args) {
        return new Promise((resolve) => {
            const searchName = args.name.toLowerCase();

            try {
                // Use Shell.AppSystem to find installed apps
                const appSystem = Shell.AppSystem.get_default();
                const allApps = appSystem.get_installed();

                let bestMatch = null;
                let bestScore = 0;

                for (const appInfo of allApps) {
                    const appName = (appInfo.get_name() || '').toLowerCase();
                    const appId = (appInfo.get_id() || '').toLowerCase();

                    // Exact match
                    if (appName === searchName || appId === searchName ||
                        appId === `${searchName}.desktop`) {
                        bestMatch = appInfo;
                        bestScore = 100;
                        break;
                    }

                    // Partial match
                    let score = 0;
                    if (appName.includes(searchName))
                        score = 50 + (searchName.length / appName.length) * 30;
                    if (appId.includes(searchName))
                        score = Math.max(score, 40);

                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = appInfo;
                    }
                }

                if (bestMatch) {
                    const shellApp = appSystem.lookup_app(bestMatch.get_id());
                    if (shellApp) {
                        shellApp.activate();
                        resolve(`Launched: ${bestMatch.get_name()} (${bestMatch.get_id()})`);
                    } else {
                        // Fallback: launch via Gio
                        const gioApp = Gio.DesktopAppInfo.new(bestMatch.get_id());
                        if (gioApp) {
                            gioApp.launch([], null);
                            resolve(`Launched: ${bestMatch.get_name()}`);
                        } else {
                            resolve(JSON.stringify({error: `Found but failed to launch: ${bestMatch.get_name()}`}));
                        }
                    }
                } else {
                    // List some available apps as suggestions
                    const suggestions = allApps
                        .map(a => a.get_name())
                        .filter(Boolean)
                        .slice(0, 10)
                        .join(', ');
                    resolve(`No app found matching "${args.name}". Some available: ${suggestions}`);
                }
            } catch (e) {
                resolve(JSON.stringify({error: e.message}));
            }
        });
    }
}
