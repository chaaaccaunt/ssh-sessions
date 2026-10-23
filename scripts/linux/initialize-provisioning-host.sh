#!/bin/bash
set -euo pipefail

SERVICE_USER="${1:-multi-site-provisioning}"
SERVICE_GROUP="${2:-$SERVICE_USER}"
PROJECT_DIRECTORY="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OPERATOR_USER="${4:-${SUDO_USER:-}}"
CONFIGURE_SCRIPT="$PROJECT_DIRECTORY/scripts/linux/configure-provisioning-user.sh"
VERIFY_SCRIPT="$PROJECT_DIRECTORY/scripts/linux/verify-provisioning-user.sh"

require_root() {
  [[ "$EUID" -eq 0 ]] || { echo "Скрипт нужно запускать от root" >&2; exit 1; }
}

validate_operating_system() {
  [[ -r /etc/os-release ]] || { echo "Не найден /etc/os-release" >&2; exit 1; }

  # shellcheck disable=SC1091
  source /etc/os-release
  local compatible_ids=" ${ID:-} ${ID_LIKE:-} "
  [[ "$compatible_ids" == *" debian "* || "$compatible_ids" == *" ubuntu "* ]] || {
    echo "Поддерживаются только Debian и Ubuntu с пакетным менеджером apt" >&2
    exit 1
  }
}

install_system_dependencies() {
  [[ -x /usr/bin/apt-get ]] || { echo "Не найден /usr/bin/apt-get" >&2; exit 1; }

  DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update
  DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y --no-install-recommends \
    ca-certificates \
    certbot \
    dnsutils \
    nginx \
    openssl \
    sudo
}

configure_certbot_renewal() {
  if [[ -x /usr/bin/systemctl && -d /run/systemd/system ]]; then
    /usr/bin/systemctl enable --now certbot.timer
    return
  fi

  echo "Systemd недоступен: автоматическое продление Certbot нужно настроить отдельным планировщиком." >&2
}

configure_nginx_service() {
  /usr/sbin/nginx -t

  if [[ -x /usr/bin/systemctl && -d /run/systemd/system ]]; then
    /usr/bin/systemctl enable nginx.service
    if /usr/bin/systemctl is-active --quiet nginx.service; then
      /usr/bin/systemctl reload nginx.service
    else
      /usr/bin/systemctl start nginx.service
    fi
    return
  fi

  echo "Systemd недоступен: nginx настроен и проверен, но его нужно запустить вручную."
}

require_root
validate_operating_system
[[ "$PROJECT_DIRECTORY" == /* ]] || { echo "Путь проекта должен быть абсолютным: $PROJECT_DIRECTORY" >&2; exit 64; }
[[ -f "$CONFIGURE_SCRIPT" ]] || { echo "Не найден $CONFIGURE_SCRIPT" >&2; exit 1; }
[[ -f "$VERIFY_SCRIPT" ]] || { echo "Не найден $VERIFY_SCRIPT" >&2; exit 1; }

install_system_dependencies
/bin/bash "$CONFIGURE_SCRIPT" "$SERVICE_USER" "$SERVICE_GROUP" "$PROJECT_DIRECTORY" "$OPERATOR_USER"
configure_certbot_renewal
/bin/bash "$VERIFY_SCRIPT" "$SERVICE_USER" "$OPERATOR_USER"
configure_nginx_service

echo "Provisioning host полностью подготовлен."
