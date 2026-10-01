# Security

## Reporting a vulnerability

Email **support@privacyfixed.com** with "Security" in the subject. Please don't open a public
issue.

## What this action handles

| Data | Where it goes |
| --- | --- |
| Your API key | Sent only to the `api-url` host, which must be `https://api.privacyfixed.com`, in the `Authorization` header. Masked in logs and removed from the job summary and outputs. |
| `url`, `baseline-url` | Sent to PrivacyFixed to scan, and saved in your account's scan history. The action's own messages show them without the query string or fragment, but GitHub's runner prints every step input at the start of the step, so never put a secret in them. |
| Your saved scans | The learned baseline reads the company names your own saved scans of `baseline-url` recorded (`GET /v1/public/baseline`). The API returns only the key's own account's scans. |
| Your repository | Not read and not sent. The action needs no `GITHUB_TOKEN` permissions. |

## Hardening

- No runtime dependencies. `dist/index.cjs` is built from `src/` with esbuild and contains only
  this project's code and Node's built-in modules. CI rebuilds it and fails if it differs from
  the committed file.
- Redirects are never followed, so the `Authorization` header can't be carried to another host.
- Text from the API or a scanned page is escaped before it reaches the log (so it can't issue
  runner commands) or the job summary (so it can't inject Markdown or HTML).
- Outputs use the runner's file protocol with a random delimiter, so a value can't set other
  outputs.
