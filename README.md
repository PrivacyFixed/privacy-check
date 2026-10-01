# PrivacyFixed privacy check

A GitHub Action that scans a deploy with [PrivacyFixed](https://privacyfixed.com) and fails the
run when the page:

- **tracks before consent**: a tracking company loads before the visitor has agreed;
- **keeps tracking after reject**: a tracking company still loads after "reject" is clicked;
- **adds a new third party**: a company the live site doesn't use (needs `baseline-url`);
- **is missing security headers** (optional).

Give it your live site as `baseline-url` and it fails only on what the change **added**, so a
site with a known issue can adopt the check today and stop it getting worse.

The results appear in the run's job summary: the checks, what failed each one, and the privacy
score. These are automated technical checks of what the page loads and sends. They are not legal
advice, and a pass is not a compliance certification.

## Requirements

- A PrivacyFixed **Business** or **Agency** plan, and an API key from
  [Console → API keys](https://privacyfixed.com/console/api-keys).
- The deploy must be reachable from the internet without a login. When protection answers
  with an error or sends the scanner to another address (a login page elsewhere), the check
  reports **not measured**. A login form served at the preview's own address with a normal
  response looks like a page to the scanner, so only check previews that are public.
- Never put a secret, such as a protection-bypass token, in `url`. GitHub prints every step
  input at the start of the step, and the URL is saved with the scan in your account's history.

## Setup

1. Add the key as a repository secret named `PRIVACYFIXED_API_KEY`
   (Settings → Secrets and variables → Actions → New repository secret).
2. Add a workflow. Pick the example that matches how you deploy.

### Your workflow deploys the preview

Use the preview URL your deploy step outputs:

```yaml
name: Privacy check
on: pull_request

permissions:
  contents: read

jobs:
  privacy:
    runs-on: ubuntu-latest
    steps:
      # … your existing deploy step, with id: deploy …
      - uses: PrivacyFixed/privacy-check@v1
        with:
          api-key: ${{ secrets.PRIVACYFIXED_API_KEY }}
          url: ${{ steps.deploy.outputs.url }}
          baseline-url: https://www.example.com
```

### Vercel

Vercel sends a `repository_dispatch` event when a deployment succeeds, with its URL in the
payload. The workflow file must be on your default branch for this event to run it.

```yaml
name: Privacy check
on:
  repository_dispatch:
    types: [vercel.deployment.success]

permissions:
  contents: read

jobs:
  privacy:
    runs-on: ubuntu-latest
    steps:
      - uses: PrivacyFixed/privacy-check@v1
        with:
          api-key: ${{ secrets.PRIVACYFIXED_API_KEY }}
          url: ${{ github.event.client_payload.url }}
          baseline-url: https://www.example.com
```

### Check the live site on a schedule

```yaml
name: Nightly privacy check
on:
  schedule:
    - cron: "0 6 * * *"

permissions:
  contents: read

jobs:
  privacy:
    runs-on: ubuntu-latest
    steps:
      - uses: PrivacyFixed/privacy-check@v1
        with:
          api-key: ${{ secrets.PRIVACYFIXED_API_KEY }}
          url: https://www.example.com
          fail-on: trackers-before-consent,trackers-after-reject,missing-security-headers
```

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `api-key` | required | Your API key. Always pass it from a secret. |
| `url` | required | The deploy to check. |
| `baseline-url` | none | The live site to compare with. Checks then fail only on what the deploy added. |
| `baseline-history-days` | `14` | Days of your saved scans of the baseline site to learn what it normally loads (see below). `0` turns it off. |
| `fail-on` | `trackers-before-consent,trackers-after-reject,new-third-parties` | Which checks fail the run. Add `missing-security-headers`, or use `none` to report without failing. `new-third-parties` needs `baseline-url`. |
| `min-score` | none | Also fail when the privacy score (0 to 10) is below this. |
| `on-unmeasured` | `fail` | `fail` or `warn` when the page couldn't be measured: a bot check, an error page, or a scanner outage. A refused key or a used-up daily allowance always fails. |
| `max-wait-seconds` | `600` | How long to wait, including waiting for another scan on your account to finish. 60 to 3600. |
| `api-url` | `https://api.privacyfixed.com` | Only `https://api.privacyfixed.com` is accepted. |

## Outputs

`status` (`passed`, `failed`, `unmeasured`, `skipped` or `error`), `score`, `baseline-samples`
(how many samples of the live site were compared against), `before-consent`,
`after-reject`, `new-third-parties`, `missing-security-headers`, and `varying` (seen in one scan
only, not counted). The name lists are comma-separated.

## How it behaves

- **The baseline is learned, not a single snapshot.** Many sites load some trackers on only
  some visits (sampling, A/B tests, tag-manager rules, ad auctions). A company therefore
  counts as new only if the live site never loaded it: not in today's scan of `baseline-url`,
  and not in any of your saved scans of it from the last `baseline-history-days` (daily
  monitoring saves one a day). Reading saved scans costs no scan. With fewer than 3 saved
  scans, the check scans the live site up to 3 times instead, and the report says which
  baseline it used. **Monitor your live site in PrivacyFixed for the steadiest results.**

- **A failure is confirmed before it fails your pull request.** One page load is one sample, and
  pages that run ad auctions load a different set of companies each time. So when the first
  result would fail, the check scans again. A finding counts only if both scans of the deploy
  show it and, with a baseline, neither scan of the live site does. Anything seen only once is
  listed under **Seen in one scan only (not counted)** and in the `varying` output, and doesn't
  fail the run. A tracker you actually add loads every time, so it's still caught.

- **One scan at a time per account.** If another scan on your account is running, for example
  from a second pull request, the check waits its turn rather than failing.
- **Scans count toward your plan's daily allowance**, the same one your web and API scans use.
  A passing run uses 1 scan, or 2 with a baseline. A run that finds something uses 2, plus 1
  with a learned baseline, or up to 5 when the live site has no saved history, because of the
  confirmation.
- **A page it couldn't measure is never a pass.** A bot check, an error page, a redirect to
  another site, or an incomplete result shows **not measured** and fails the run, unless you
  set `on-unmeasured: warn`.
- **Pull requests from forks** get no repository secrets from GitHub, so the check is skipped
  with a notice instead of failing a contributor's pull request.

## Security

- **Your key goes to PrivacyFixed only.** The action accepts no `api-url` except
  PrivacyFixed's own API addresses over HTTPS, and it never follows a redirect, so the key
  can't be carried to another host.
- **The key never appears in output.** It is masked in the log and removed from the job summary
  and outputs, including from any error message.
- **No third-party code runs.** The action has no runtime dependencies: `dist/index.cjs` is
  our code only and uses Node's built-in modules.
- **Least privilege.** The action needs no `GITHUB_TOKEN` permissions. `contents: read` is
  enough.
- **Pin by commit SHA** for the strongest guarantee, e.g.
  `PrivacyFixed/privacy-check@<full-commit-sha> # v1.0.0`.
- **What is sent:** your key, the `url` and the `baseline-url`. Nothing from your repository is
  read or sent. The scans are saved in your PrivacyFixed account's history, like any API scan.
- **What is read back:** your own scan results, and the company names your own saved scans of
  the baseline site recorded. The API only ever returns your account's data.

Report a vulnerability privately to support@privacyfixed.com. See [SECURITY.md](SECURITY.md).

## License

MIT
