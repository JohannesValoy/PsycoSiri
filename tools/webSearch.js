import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
const SERPER_IMAGES_URL = 'https://google.serper.dev/images';

export class WebSearchTool {
    constructor(settings) {
        this.name = 'web_search';
        this.description = 'Search the web using Google (via Serper) and return results including images. Requires a Serper API key in settings.';
        this.parameters = {
            type: 'object',
            properties: {
                query: {type: 'string', description: 'The search query'},
                max_results: {type: 'integer', description: 'Max results to return (overrides settings default)'},
            },
            required: ['query'],
        };
        this._settings = settings;
        this._session = new Soup.Session();
    }

    execute(args) {
        const apiKey = this._settings?.get_string('serper-api-key') || '';
        if (!apiKey)
            return Promise.resolve('Error: No Serper API key configured. Go to Aether settings → General → Search to add your key from serper.dev.');

        const maxResults = args.max_results || this._settings?.get_int('search-max-results') || 5;
        const query = args.query;

        // Run web search and image search in parallel
        return Promise.all([
            this._serperRequest(SERPER_SEARCH_URL, query, maxResults, apiKey),
            this._serperRequest(SERPER_IMAGES_URL, query, maxResults, apiKey),
        ]).then(([searchData, imageData]) => {
            return this._formatResults(query, searchData, imageData, maxResults);
        }).catch(e => {
            return `Search failed: ${e.message}`;
        });
    }

    _serperRequest(url, query, num, apiKey) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('POST', url);
            msg.get_request_headers().append('X-API-KEY', apiKey);
            msg.get_request_headers().append('Content-Type', 'application/json');

            const payload = JSON.stringify({q: query, num});
            const bodyBytes = new GLib.Bytes(new TextEncoder().encode(payload));
            msg.set_request_body_from_bytes('application/json', bodyBytes);

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const data = JSON.parse(text);

                    if (data.message)
                        reject(new Error(data.message));
                    else
                        resolve(data);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _formatResults(query, searchData, imageData, maxResults) {
        const sections = [];

        // Knowledge Graph
        if (searchData.knowledgeGraph) {
            const kg = searchData.knowledgeGraph;
            let kgText = `[Knowledge Graph] ${kg.title || ''}`;
            if (kg.type) kgText += ` (${kg.type})`;
            if (kg.description) kgText += `\n${kg.description}`;
            if (kg.attributes) {
                for (const [key, val] of Object.entries(kg.attributes))
                    kgText += `\n  ${key}: ${val}`;
            }
            sections.push(kgText);
        }

        // Answer Box
        if (searchData.answerBox) {
            const ab = searchData.answerBox;
            let abText = '[Answer]';
            if (ab.title) abText += ` ${ab.title}`;
            if (ab.answer) abText += `\n${ab.answer}`;
            else if (ab.snippet) abText += `\n${ab.snippet}`;
            if (ab.link) abText += `\nSource: ${ab.link}`;
            sections.push(abText);
        }

        // Organic results
        if (searchData.organic && searchData.organic.length > 0) {
            sections.push('[Web Results]');
            for (const r of searchData.organic.slice(0, maxResults)) {
                let entry = `• ${r.title || '(no title)'}`;
                if (r.link) entry += `\n  ${r.link}`;
                if (r.snippet) entry += `\n  ${r.snippet}`;
                sections.push(entry);
            }
        }

        // Images from dedicated image search
        const images = imageData?.images || [];
        if (images.length > 0) {
            sections.push('[Image Results]');
            for (const img of images.slice(0, maxResults)) {
                let entry = `• ${img.title || '(image)'}`;
                if (img.imageUrl) entry += `\n  Image: ${img.imageUrl}`;
                if (img.link) entry += `\n  Source: ${img.link}`;
                sections.push(entry);
            }
        }

        if (sections.length === 0)
            return `No results found for "${query}".`;

        return sections.join('\n\n');
    }
}
