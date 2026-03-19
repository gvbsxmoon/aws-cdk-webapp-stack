#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# cognito-utils.sh — Manage Cognito User Pool users.
#
# Reads USER_POOL_ID and REGION from a .env file in the same directory,
# or from environment variables.
#
# Usage:
#   ./cognito-utils.sh create-user <email>
#   ./cognito-utils.sh update-password <email> <new_password>
#   ./cognito-utils.sh list-users
#   ./cognito-utils.sh delete-user <email>
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
  USER_POOL_ID="${USER_POOL_ID:-$(grep '^USER_POOL_ID=' "$ENV_FILE" | cut -d '=' -f2)}"
  REGION="${REGION:-$(grep '^REGION=' "$ENV_FILE" | cut -d '=' -f2)}"
fi

if [ -z "${USER_POOL_ID:-}" ]; then
  echo "Error: USER_POOL_ID not set. Provide it via .env or environment variable."
  exit 1
fi

if [ -z "${REGION:-}" ]; then
  echo "Error: REGION not set. Provide it via .env or environment variable."
  exit 1
fi

# Resolve the Cognito username (UUID) from an email address.
resolve_username() {
  local email="$1"
  local username
  username=$(aws cognito-idp list-users \
    --user-pool-id "$USER_POOL_ID" \
    --filter "email = \"$email\"" \
    --region "$REGION" \
    --query 'Users[0].Username' \
    --output text)

  if [ -z "$username" ] || [ "$username" = "None" ]; then
    echo "Error: user with email $email not found" >&2
    return 1
  fi

  echo "$username"
}

# Create a new user with a temporary password.
create_user() {
  local email="${1:?Usage: $0 create-user <email>}"

  echo "Creating user $email in pool $USER_POOL_ID..."
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --temporary-password 'TempPass123!' \
    --region "$REGION"

  echo "User created. Temporary password: TempPass123!"
  echo "The user will be prompted to set a permanent password on first sign-in."
}

# Set a permanent password for an existing user.
update_password() {
  local email="${1:?Usage: $0 update-password <email> <new_password>}"
  local password="${2:?Usage: $0 update-password <email> <new_password>}"

  local username
  username=$(resolve_username "$email")

  echo "Setting permanent password for $email (username: $username)..."
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" \
    --password "$password" \
    --permanent \
    --region "$REGION"

  echo "Password updated."
}

# List all users in the pool.
list_users() {
  echo "Users in pool $USER_POOL_ID:"
  aws cognito-idp list-users \
    --user-pool-id "$USER_POOL_ID" \
    --region "$REGION"
}

# Delete a user by email.
delete_user() {
  local email="${1:?Usage: $0 delete-user <email>}"

  local username
  username=$(resolve_username "$email")

  echo "Deleting user $email (username: $username)..."
  aws cognito-idp admin-delete-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" \
    --region "$REGION"

  echo "User deleted."
}

# ── CLI entrypoint ────────────────────────────────────────────────────────
case "${1:-}" in
  create-user)
    create_user "${2:-}"
    ;;
  update-password)
    update_password "${2:-}" "${3:-}"
    ;;
  list-users)
    list_users
    ;;
  delete-user)
    delete_user "${2:-}"
    ;;
  *)
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  create-user <email>              Create a new Cognito user"
    echo "  update-password <email> <pass>   Set a permanent password"
    echo "  list-users                       List all users in the pool"
    echo "  delete-user <email>              Delete a user"
    echo ""
    echo "Configuration (via .env or environment variables):"
    echo "  USER_POOL_ID   Cognito User Pool ID (required)"
    echo "  REGION         AWS region (required)"
    ;;
esac
