# Claude Code hosting: auth test kit

Three pretend customers. Each one gets its own container with its own home volume,
which is what each real customer would get on the VPS. Logins survive restarts
(the volume keeps them) and never leave that customer's volume.

## Claude plan vs Console account

|                  | Claude plan (option 1)                         | Console account (options 2 and 3)            |
|------------------|------------------------------------------------|----------------------------------------------|
| Website          | claude.ai                                      | platform.claude.com                          |
| Made for         | people using Claude                            | developers building on the API               |
| Price            | flat monthly fee (Pro, Max, Team, Enterprise)  | pay per token from prepaid credits           |
| Limits           | plan usage limits that reset over time         | API rate limits by spend tier                |
| Shared with      | Claude chat, the Claude apps, Claude Code      | everything using that org's API keys         |

Options 2 and 3 are the same account and the same bill. Only the credential differs:

- **Option 2, API key:** a static `sk-ant-...` secret. Your platform keeps it in a vault and
  hands it to the container through `apiKeyHelper`. It works until the customer revokes it.
- **Option 3, Console sign-in:** the customer signs in through Anthropic's page and Claude Code
  saves a login that refreshes itself. Nothing for you to store, but it can expire and then
  needs `/login` again.

## Run the tests

Docker runs through Colima on this Mac (`colima start` if it is stopped).

```bash
./test.sh build
```

**Option 1, Claude plan**

```bash
./test.sh plan
```

Pick a theme, then the Claude account (subscription) login. There is no browser in the
container, so select the URL it prints with the mouse, open it, approve, and paste the code
back at `Paste code here if prompted`. Run `/status`, then `/exit`.

**Option 2, API key**

```bash
./test.sh apikey
```

Uses `ANTHROPIC_API_KEY` from `Humanlike-node/.env.local`, copied to a 0600 temp file for
this run only. To test another key: `KEY_FILE=~/path/to/keyfile ./test.sh apikey`.

**Option 3, Console sign-in**

```bash
./test.sh console
```

At the login screen pick the Anthropic Console account, then
**Sign in with your Console account (recommended)**, not "Create an API key". Same
copy-URL, paste-code flow as option 1.

## Check each customer

```bash
./test.sh status plan
./test.sh check plan
```

`status` shows which credential that customer is on. `check` sends one headless prompt
(`--model haiku`), the way an unattended job on the VPS would. Swap `plan` for `apikey` or
`console`.

`./test.sh reset <option>` deletes that customer's volume, which logs them out.
`colima stop` when you are done.
