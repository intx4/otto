# Privacy policy

Last updated: 2026-11-27

OttO: Organizer of Tabs, Too Overpowered ("OttO") is a browser extension. This policy describes what data OttO handles and where it goes.

## Data OttO sends

OttO sends the **title** and **URL** of tabs in a browser window to the LLM provider that you configure on the options page. It sends nothing else: no page content, cookies, history, form data or identifiers.

OttO sends tab data only in these cases:

- You click **Organize this window** or press the keyboard shortcut. OttO sends the non-pinned tabs of that window.
- **Auto-organize new tabs** is on and a new tab finishes loading. OttO sends the new tab and up to three tabs from each existing group in that window.

By default OttO removes the query string and fragment from each URL before it sends it. If you turn on **Send full URLs**, OttO sends URLs unchanged.

The provider receives this data under its own privacy policy. Anthropic, Amazon Bedrock and OpenAI are the built-in providers. If you enter a custom base URL, the data goes to that server.

## Data OttO stores

OttO stores your settings, including API keys and, if you use Amazon Bedrock with access keys, your AWS access key ID, secret access key and session token, in `chrome.storage.local` on your device. Chrome does not sync this storage. OttO does not encrypt it, so anyone with access to your browser profile can read these credentials. OttO also stores daily totals of the tokens and requests each provider reported, per provider and model, in `chrome.storage.local` for up to 400 days, to show them on the options page. OttO keeps the result of the last run and the duplicate suggestions in `chrome.storage.session`, which Chrome clears when the browser closes.

## Data OttO does not collect

OttO has no server. The developer receives no data from OttO. OttO has no analytics, telemetry, advertising or tracking. OttO does not sell or transfer data to anyone except the provider you choose, for the purpose described above.

## Contact

Open an issue in the project's GitHub repository.
