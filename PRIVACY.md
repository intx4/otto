# Privacy policy

Last updated: 2026-11-27

Otto: Organizer of Tabs Too Overpowered ("Otto") is a browser extension. This policy describes what data Otto handles and where it goes.

## Data Otto sends

Otto sends the **title** and **URL** of tabs in a browser window to the LLM provider that you configure on the options page. It sends nothing else: no page content, cookies, history, form data or identifiers.

Otto sends tab data only in these cases:

- You click **Organize this window** or press the keyboard shortcut. Otto sends the non-pinned tabs of that window.
- **Auto-organize new tabs** is on and a new tab finishes loading. Otto sends the new tab and up to three tabs from each existing group in that window.

By default Otto removes the query string and fragment from each URL before it sends it. If you turn on **Send full URLs**, Otto sends URLs unchanged.

The provider receives this data under its own privacy policy. Anthropic, Amazon Bedrock and OpenAI are the built-in providers. If you enter a custom base URL, the data goes to that server.

## Data Otto stores

Otto stores your settings, including API keys and, if you use Amazon Bedrock with access keys, your AWS access key ID, secret access key and session token, in `chrome.storage.local` on your device. Chrome does not sync this storage. Otto does not encrypt it, so anyone with access to your browser profile can read these credentials. Otto keeps the result of the last run and the duplicate suggestions in `chrome.storage.session`, which Chrome clears when the browser closes.

## Data Otto does not collect

Otto has no server. The developer receives no data from Otto. Otto has no analytics, telemetry, advertising or tracking. Otto does not sell or transfer data to anyone except the provider you choose, for the purpose described above.

## Contact

Open an issue in the project's GitHub repository.
