#!/usr/bin/env bash
set -euo pipefail

echo "Refusing to load AWS Secrets Manager configuration: this TEST copy is local-only." >&2
echo "Use the checked-in .env.example values; DynamoDB is fixed at http://127.0.0.1:8000." >&2
exit 1
