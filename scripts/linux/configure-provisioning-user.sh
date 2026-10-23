#!/bin/bash
set -euo pipefail

SERVICE_USER="${1:-multi-site-provisioning}"
SERVICE_GROUP="${2:-$SERVICE_USER}"
PROJECT_DIRECTORY="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OPERATOR_USER="${4:-${SUDO_USER:-}}"
NGINX_SITES_AVAILABLE_DIRECTORY="/etc/nginx/sites-available"
NGINX_SITES_ENABLED_DIRECTORY="/etc/nginx/sites-enabled"
ACME_WEBROOT="/var/lib/multi-site/acme"
MULTI_SITE_STATE_DIRECTORY="/var/lib/multi-site"
LIBEXEC_DIRECTORY="/usr/local/libexec/multi-site"
BIN_DIRECTORY="/usr/local/bin"
SUDOERS_FILE="/etc/sudoers.d/multi-site-provisioning"
NGINX_INCLUDE_FILE="/etc/nginx/conf.d/multi-site-managed.conf"
CERTBOT_DEPLOY_HOOK_DIRECTORY="/etc/letsencrypt/renewal-hooks/deploy"
CERTBOT_DEPLOY_HOOK="$CERTBOT_DEPLOY_HOOK_DIRECTORY/multi-site-nginx-reload"

require_root() {
  [[ "$EUID" -eq 0 ]] || { echo "Скрипт нужно запускать от root" >&2; exit 1; }
}

validate_name() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || { echo "Некорректное имя пользователя или группы: $1" >&2; exit 64; }
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Не найдена обязательная команда: $1" >&2; exit 1; }
}

require_root
validate_name "$SERVICE_USER"
validate_name "$SERVICE_GROUP"
require_command sudo
require_command visudo
[[ -x /usr/bin/flock ]] || { echo "Не найден /usr/bin/flock" >&2; exit 1; }
[[ -x /usr/sbin/nginx ]] || { echo "Не найден /usr/sbin/nginx" >&2; exit 1; }
[[ -x /usr/bin/certbot ]] || { echo "Не найден /usr/bin/certbot" >&2; exit 1; }
[[ -x /usr/bin/openssl ]] || { echo "Не найден /usr/bin/openssl" >&2; exit 1; }
[[ -x /usr/bin/dig ]] || { echo "Не найден /usr/bin/dig" >&2; exit 1; }

[[ -f "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-nginx-root" ]] || { echo "Не найден nginx wrapper в $PROJECT_DIRECTORY" >&2; exit 1; }
[[ -f "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-certbot-root" ]] || { echo "Не найден certbot wrapper в $PROJECT_DIRECTORY" >&2; exit 1; }
[[ -f "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-certificates-root" ]] || { echo "Не найден certificates wrapper в $PROJECT_DIRECTORY" >&2; exit 1; }
[[ -f "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-certbot-deploy-hook-root" ]] || { echo "Не найден deploy hook Certbot в $PROJECT_DIRECTORY" >&2; exit 1; }

if [[ -n "$OPERATOR_USER" && "$OPERATOR_USER" != "root" ]]; then
  validate_name "$OPERATOR_USER"
  id "$OPERATOR_USER" >/dev/null 2>&1 || { echo "Пользователь запуска init не найден: $OPERATOR_USER" >&2; exit 1; }
fi

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir /var/lib/multi-site --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g root -m 0755 "$LIBEXEC_DIRECTORY"
install -d -o root -g root -m 0755 "$CERTBOT_DEPLOY_HOOK_DIRECTORY"
[[ -d "$BIN_DIRECTORY" ]] || { echo "Не найден системный каталог $BIN_DIRECTORY" >&2; exit 1; }
install -d -o root -g root -m 0755 "$NGINX_SITES_AVAILABLE_DIRECTORY" "$NGINX_SITES_ENABLED_DIRECTORY"
install -d -o root -g root -m 0755 "$MULTI_SITE_STATE_DIRECTORY" "$ACME_WEBROOT"

install -o root -g root -m 0755 "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-nginx-root" "$LIBEXEC_DIRECTORY/nginx"
install -o root -g root -m 0755 "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-certbot-root" "$LIBEXEC_DIRECTORY/certbot"
install -o root -g root -m 0755 "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-certificates-root" "$LIBEXEC_DIRECTORY/certificates"
install -o root -g root -m 0755 "$PROJECT_DIRECTORY/scripts/linux/libexec/multi-site-certbot-deploy-hook-root" "$CERTBOT_DEPLOY_HOOK"

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

cat > "$temporary_directory/multi-site-nginx" <<'EOF'
#!/bin/bash
exec /usr/bin/sudo -n /usr/local/libexec/multi-site/nginx "$@"
EOF

cat > "$temporary_directory/multi-site-certbot" <<'EOF'
#!/bin/bash
exec /usr/bin/sudo -n /usr/local/libexec/multi-site/certbot "$@"
EOF

cat > "$temporary_directory/multi-site-certificates" <<'EOF'
#!/bin/bash
exec /usr/bin/sudo -n /usr/local/libexec/multi-site/certificates "$@"
EOF

cat > "$temporary_directory/sudoers" <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: $LIBEXEC_DIRECTORY/nginx *, $LIBEXEC_DIRECTORY/certbot *, $LIBEXEC_DIRECTORY/certificates *
EOF

if [[ -n "$OPERATOR_USER" && "$OPERATOR_USER" != "root" && "$OPERATOR_USER" != "$SERVICE_USER" ]]; then
  echo "$OPERATOR_USER ALL=(root) NOPASSWD: $LIBEXEC_DIRECTORY/nginx *, $LIBEXEC_DIRECTORY/certbot *, $LIBEXEC_DIRECTORY/certificates *" >> "$temporary_directory/sudoers"
fi

install -o root -g root -m 0755 "$temporary_directory/multi-site-nginx" "$BIN_DIRECTORY/multi-site-nginx"
install -o root -g root -m 0755 "$temporary_directory/multi-site-certbot" "$BIN_DIRECTORY/multi-site-certbot"
install -o root -g root -m 0755 "$temporary_directory/multi-site-certificates" "$BIN_DIRECTORY/multi-site-certificates"
install -o root -g root -m 0440 "$temporary_directory/sudoers" "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE"
rm -f -- "$NGINX_INCLUDE_FILE"
nginx -t

echo "Права Provisioning Service настроены для пользователя $SERVICE_USER."
echo "Укажите в services/provisioning/.prod.env:"
echo "VAR_PROVISIONING_NGINX_EXECUTABLE=$BIN_DIRECTORY/multi-site-nginx"
echo "VAR_PROVISIONING_CERTBOT_EXECUTABLE=$BIN_DIRECTORY/multi-site-certbot"
echo "VAR_PROVISIONING_DIG_EXECUTABLE=/usr/bin/dig"
echo "VAR_PROVISIONING_ACME_WEBROOT=$ACME_WEBROOT"
echo "VAR_PROVISIONING_CERTIFICATE_DIRECTORY=/etc/letsencrypt/live"
echo "VAR_PROVISIONING_CERTIFICATE_INSPECTOR_EXECUTABLE=$BIN_DIRECTORY/multi-site-certificates"
echo "VAR_PROVISIONING_CERTIFICATE_MIN_VALIDITY_SECONDS=2592000"
if [[ -n "$OPERATOR_USER" && "$OPERATOR_USER" != "root" ]]; then
  echo "Пользователь $OPERATOR_USER может вызывать ограниченные nginx, Certbot и certificate wrapper'ы."
fi
