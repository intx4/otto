# Otto: Organizer of Tabs Too Overpowered

Otto is a Chrome extension that sorts the tabs in your window into Chrome tab groups by topic. It sends each tab's title and URL to an LLM provider you choose, then creates named, colored groups from the reply. It also lists duplicate tabs you can close.

## What it does

- **Organize this window.** Click the toolbar icon, then **Organize this window**. Otto regroups every non-pinned tab in the current window. It sends the names of your existing groups to the model, so group names stay the same between runs. Tabs that fit no topic end up ungrouped.
- **Auto-organize new tabs.** When a new tab finishes loading, Otto waits 3 seconds for more tabs, then places only the new ungrouped tabs. A new tab joins an existing group, starts a new group, or stays ungrouped. Otto never moves a tab you already put in a group. Turn this off in the popup or on the options page. It is on by default.
- **Duplicates.** Otto finds tabs with the same URL after it removes the fragment, tracking parameters (`utm_*`, `fbclid`, `gclid` and similar) and the trailing slash. The model can also flag tabs that show the same page under different URLs. The popup lists the duplicates with a **Close** button for each and a **Close all duplicates** button. Otto keeps the active or most recently used tab. It never closes a tab unless you click a button. After a run, the toolbar badge shows the number of duplicates.
- **Keyboard shortcut.** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> organizes the current window. Change it at `chrome://extensions/shortcuts`.

If something fails (no API key, an HTTP error, a reply that is not valid JSON), the popup shows the message and the badge shows a red `!`.

## Install from source

Otto has no build step and no runtime dependencies.

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one that contains `manifest.json`).
4. Pin Otto from the extensions menu so the toolbar icon is visible.

## Configure a provider

Click **Options** in the popup, or right-click the toolbar icon and choose **Options**.

| Setting | Notes |
| --- | --- |
| Provider | **Anthropic** (default) or **OpenAI-compatible**. |
| Base URL | OpenAI-compatible only. Leave empty for OpenAI. Examples: `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (Ollama), `http://localhost:1234/v1` (LM Studio). |
| API key | Required for Anthropic. Optional for local servers. |
| Model | Default `claude-haiku-5-5` for Anthropic and `gpt-4.1-mini` for OpenAI-compatible. Any model name the provider accepts works. |
| Max groups | A hint to the model. `0` means no limit. |
| Send full URLs | Off by default. See [Privacy](#privacy). |

Click **Test connection** to send a two-tab sample request with the values in the form. Click **Save** to store them.

When you save a custom base URL, Chrome asks you to allow access to that host. Otto needs this access to call a local server such as Ollama or LM Studio, because those servers do not accept cross-origin requests from extensions by default. Otto asks only for the host you entered.

The model must support structured JSON output. Anthropic requests use structured outputs. OpenAI-compatible requests ask for a JSON schema response, and Otto also accepts JSON wrapped in prose or a code fence.

## Privacy

Otto sends the title and URL of tabs to the provider you configure, and nothing else. It sends them only when you click **Organize**, press the shortcut, or a new tab loads while auto-organize is on. By default Otto removes the query string and fragment from every URL before it sends it, so `https://mail.example.com/inbox/42?token=abc#msg` becomes `https://mail.example.com/inbox/42`. Turn on **Send full URLs** to send them unchanged.

Your settings and API key stay in `chrome.storage.local` on this device. Chrome does not sync them. Otto has no server, no analytics and no telemetry. See [PRIVACY.md](PRIVACY.md).

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | Read tab titles and URLs, and close duplicates when you click **Close**. |
| `tabGroups` | Create, name and color tab groups. |
| `storage` | Save your settings on this device. |
| `https://api.anthropic.com/*`, `https://api.openai.com/*` | Call the built-in providers. |
| `<all_urls>` (optional) | Requested only for the single host of a custom base URL, when you save it. |

## Development

```sh
npm test            # unit tests for src/plan.js (node --test, no dependencies)
npm run check       # manifest parses, every referenced file exists, every JS file parses
npm install         # installs puppeteer (dev only) for the end-to-end test
npm run e2e         # loads the extension into Chrome for Testing against a local mock provider
npm run icons       # regenerates icons/ with the Python standard library
```

The end-to-end test needs Chrome for Testing, which `npm install` downloads through puppeteer. Chrome stable ignores `--load-extension`. Set `HEADFUL=1` to watch the browser.

### Layout

- `src/plan.js` holds the pure logic. It builds prompts, validates the model's reply into a plan, normalizes URLs and detects duplicates. It uses no Chrome APIs.
- `src/llm.js` has one `complete()` function over a registry of providers.
- `src/apply.js` applies a validated plan with `chrome.tabs.group` and `chrome.tabGroups.update`.
- `src/background.js` is the service worker. It handles events, the per-window run lock and the debounce.
- `popup/` and `options/` are the two extension pages.

To add a provider, add an entry to `PROVIDERS` in `src/llm.js`.

## License

MIT. See [LICENSE](LICENSE).
