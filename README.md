# CUBE TEST copy (local-only)

This checkout is safety-locked to DynamoDB Local at
`http://127.0.0.1:8000`. It must never be used to connect to AWS or GovCloud.

## What is wired up

| Concern | How it works |
| --- | --- |
| Authentication | Forced local session; Cognito values are ignored and replaced with loopback-only placeholders |
| Styling | Tailwind v4 with shadcn/ui in `components/ui` |
| Data | DynamoDB document client fixed to `http://127.0.0.1:8000` with dummy credentials |
| Models | No Bedrock client or model call exists in this copy |
| Credentials | Hard-coded dummy DynamoDB credentials; shell AWS credentials and profiles are ignored |

## Running it

Start DynamoDB Local separately on port 8000, then run:

```bash
npm install
npm run dev
```

The app is served at `http://127.0.0.1:3000`. No table creation or data import is
performed by these steps.

`scripts/load-env.sh` is intentionally disabled because it previously contacted
AWS Secrets Manager. If DynamoDB Local is stopped or unreachable, data operations
fail with a local-unavailable error; there is no AWS endpoint fallback.

For an optimized local build:

```bash
npm run build
npm start
```

## Isolation controls

- `lib/dynamo.ts` uses a literal loopback endpoint, literal dummy credentials, one
  request attempt, and a request middleware guard that rejects any other host/port.
- `lib/auth-mode.ts` always selects local auth, including optimized builds.
- `lib/auth.ts` ignores Cognito environment variables and has no reachable AWS URL.
- `scripts/load-env.sh` exits without invoking the AWS CLI.
- The standalone RCBL integration script is also fixed to DynamoDB Local.

Do not replace these literals with environment-driven AWS values in this test copy.

Run the offline source guard at any time with:

```bash
npm run verify:isolation
```

## Table naming

Existing table names and the `p72_*` prefix are preserved for application
compatibility, but they are resolved only inside DynamoDB Local. This configuration
does not create tables or import data.
