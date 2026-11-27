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

Click **Options** in the popup, or right-click the toolbar icon and choose **Options**. Each provider keeps its own base URL, credentials and model, so switching provider does not mix them.

| Setting | Notes |
| --- | --- |
| Provider | **Anthropic** (default), **Amazon Bedrock (Claude)** or **OpenAI-compatible**. |
| Base URL | Optional for every provider. Leave it empty to use the default shown in the field. |
| Model | Default `claude-haiku-5-5` for Anthropic, `anthropic.claude-haiku-5-5` for Bedrock and `gpt-4.1-mini` for OpenAI-compatible. Any model name the provider accepts works. |
| Max groups | A hint to the model. `0` means no limit. |
| Send full URLs | Off by default. See [Privacy](#privacy). |

Click **Test connection** to send a two-tab sample request with the values in the form. Click **Save** to store them.

When the base URL points at a host other than `api.anthropic.com` or `api.openai.com`, Chrome asks you to allow access to that host when you save. Otto asks only for that host. Without this access, servers that do not accept cross-origin requests from extensions block the call.

### Anthropic

Enter an Anthropic API key. Otto calls `https://api.anthropic.com/v1/messages`.

### Anthropic through a gateway or proxy

Select **Anthropic** and set **Base URL** to the gateway's Anthropic endpoint, without `/v1/messages`. Otto appends `/v1/messages` and sends the API key as `x-api-key`. Use this for LiteLLM, Cloudflare AI Gateway, a corporate proxy, or any server that serves the Anthropic Messages API.

### Amazon Bedrock

Select **Amazon Bedrock (Claude)** and enter the **AWS region**, for example `us-east-1`. Otto calls Claude in Amazon Bedrock at `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`. A base URL, if you set one, replaces that endpoint. Model IDs start with `anthropic.`, for example `anthropic.claude-sonnet-5-5`.

Choose one authentication mode:

- **Bedrock API key.** Otto sends the key as `Authorization: Bearer <key>`. The identity behind the key needs `bedrock-mantle:CreateInference` and `bedrock-mantle:CallWithBearerToken`.
- **AWS access keys (SigV4).** Enter an access key ID and secret access key, and a session token if the credentials are temporary. Otto signs each request with Signature Version 4 for the service `bedrock-mantle`. The IAM identity needs `bedrock-mantle:CreateInference`.

Otto stores these credentials unencrypted in `chrome.storage.local`, in your browser profile. Prefer a Bedrock API key, or short-lived credentials from an IAM user scoped to the actions above.

### OpenAI-compatible

Leave **Base URL** empty for OpenAI, or set it to another server that serves the Chat Completions API: `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio). The API key is optional for local servers.

The model must support structured JSON output. Anthropic and Bedrock requests use structured outputs. OpenAI-compatible requests ask for a JSON schema response, and Otto also accepts JSON wrapped in prose or a code fence.

## Privacy

Otto sends the title and URL of tabs to the provider you configure, and nothing else. It sends them only when you click **Organize**, press the shortcut, or a new tab loads while auto-organize is on. By default Otto removes the query string and fragment from every URL before it sends it, so `https://mail.example.com/inbox/42?token=abc#msg` becomes `https://mail.example.com/inbox/42`. Turn on **Send full URLs** to send them unchanged.

Your settings and credentials stay in `chrome.storage.local` on this device. Chrome does not sync them. Otto has no server, no analytics and no telemetry. See [PRIVACY.md](PRIVACY.md).

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | Read tab titles and URLs, and close duplicates when you click **Close**. |
| `tabGroups` | Create, name and color tab groups. |
| `storage` | Save your settings on this device. |
| `https://api.anthropic.com/*`, `https://api.openai.com/*` | Call the built-in providers. |
| `<all_urls>` (optional) | Requested only for the single host Otto calls when it is not one of the above: your Bedrock region's endpoint or a custom base URL. Chrome asks when you save or test. |

## Development

```sh
npm test            # unit tests (node --test, no dependencies), including AWS SigV4 test vectors
npm run check       # manifest parses, every referenced file exists, every JS file parses
npm install         # installs puppeteer (dev only) for the end-to-end test
npm run e2e         # loads the extension into Chrome for Testing against a local mock provider
npm run icons       # regenerates icons/ with the Python standard library
```

The end-to-end test needs Chrome for Testing, which `npm install` downloads through puppeteer. Chrome stable ignores `--load-extension`. Set `HEADFUL=1` to watch the browser.

### Layout

- `src/plan.js` holds the pure logic. It builds prompts, validates the model's reply into a plan, normalizes URLs and detects duplicates. It uses no Chrome APIs.
- `src/llm.js` has one `complete()` function over a registry of providers. `src/sigv4.js` signs Bedrock requests with WebCrypto.
- `src/settings.js` stores one config per provider and migrates the original flat settings.
- `src/apply.js` applies a validated plan with `chrome.tabs.group` and `chrome.tabGroups.update`.
- `src/background.js` is the service worker. It handles events, the per-window run lock and the debounce.
- `popup/` and `options/` are the two extension pages.

To add a provider, add an entry to `PROVIDERS` in `src/llm.js`. Its `defaults` keys are the config fields, and the options page needs an input whose `id` matches each key.

## License

MIT. See [LICENSE](LICENSE).
