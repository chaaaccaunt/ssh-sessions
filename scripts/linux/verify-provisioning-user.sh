#!/bin/bash
set -euo pipefail

SERVICE_USER="${1:-multi-site-provisioning}"
OPERATOR_USER="${2:-${SUDO_USER:-}}"
NGINX_SITES_AVAILABLE_DIRECTORY="/etc/nginx/sites-available"
NGINX_SITES_ENABLED_DIRECTORY="/etc/nginx/sites-enabled"
CERTBOT_DEPLOY_HOOK="/etc/letsencrypt/renewal-hooks/deploy/multi-site-nginx-reload"

[[ "$EUID" -eq 0 ]] || { echo "Скрипт нужно запускать от root" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Пользователь не найден: $SERVICE_USER" >&2; exit 1; }
[[ -x /usr/bin/dig ]] || { echo "Не найден /usr/bin/dig" >&2; exit 1; }
[[ -x "$CERTBOT_DEPLOY_HOOK" ]] || { echo "Не установлен deploy hook Certbot: $CERTBOT_DEPLOY_HOOK" >&2; exit 1; }
/bin/bash -n "$CERTBOT_DEPLOY_HOOK"

if sudo -n -u "$SERVICE_USER" test -w "$NGINX_SITES_AVAILABLE_DIRECTORY" || sudo -n -u "$SERVICE_USER" test -w "$NGINX_SITES_ENABLED_DIRECTORY"; then
  echo "Ошибка: системный пользователь имеет прямую запись в каталоги nginx" >&2
  exit 1
fi
sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-nginx -t

if sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-nginx -V >/dev/null 2>&1; then
  echo "Ошибка: wrapper nginx разрешил недопустимый аргумент" >&2
  exit 1
fi

if printf 'server {}\n' | sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-nginx apply invalid-uid >/dev/null 2>&1; then
  echo "Ошибка: wrapper nginx принял некорректный uid сайта" >&2
  exit 1
fi

if sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-nginx remove invalid-uid >/dev/null 2>&1; then
  echo "Ошибка: wrapper nginx разрешил удалить конфигурацию по некорректному uid сайта" >&2
  exit 1
fi

if sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-certbot --version >/dev/null 2>&1; then
  echo "Ошибка: wrapper certbot разрешил недопустимый аргумент" >&2
  exit 1
fi

set +e
sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-certificates "does-not-exist.invalid" >/dev/null 2>&1
certificate_not_found_status=$?
sudo -n -u "$SERVICE_USER" /usr/local/bin/multi-site-certificates "../invalid" >/dev/null 2>&1
invalid_hostname_status=$?
set -e

[[ "$certificate_not_found_status" -eq 2 ]] || { echo "Ошибка проверки доступа к certificates wrapper" >&2; exit 1; }
if [[ "$invalid_hostname_status" -ne 64 ]]; then
  echo "Ошибка: certificates wrapper некорректно обработал недопустимый hostname" >&2
  exit 1
fi

if [[ -n "$OPERATOR_USER" && "$OPERATOR_USER" != "root" && "$OPERATOR_USER" != "$SERVICE_USER" ]]; then
  id "$OPERATOR_USER" >/dev/null 2>&1 || { echo "Пользователь запуска init не найден: $OPERATOR_USER" >&2; exit 1; }
  if sudo -n -u "$OPERATOR_USER" test -w "$NGINX_SITES_AVAILABLE_DIRECTORY" || sudo -n -u "$OPERATOR_USER" test -w "$NGINX_SITES_ENABLED_DIRECTORY"; then
    echo "Ошибка: пользователь $OPERATOR_USER имеет прямую запись в каталоги nginx" >&2
    exit 1
  fi
  sudo -n -u "$OPERATOR_USER" /usr/local/bin/multi-site-nginx -t
  set +e
  sudo -n -u "$OPERATOR_USER" /usr/local/bin/multi-site-certbot --version >/dev/null 2>&1
  operator_certbot_status=$?
  sudo -n -u "$OPERATOR_USER" /usr/local/bin/multi-site-certificates "does-not-exist.invalid" >/dev/null 2>&1
  operator_certificate_status=$?
  set -e
  [[ "$operator_certbot_status" -eq 64 ]] || { echo "Пользователь $OPERATOR_USER не может вызвать certbot wrapper" >&2; exit 1; }
  [[ "$operator_certificate_status" -eq 2 ]] || { echo "Пользователь $OPERATOR_USER не может вызвать certificates wrapper" >&2; exit 1; }
fi

if [[ -x /usr/bin/systemctl && -d /run/systemd/system ]]; then
  /usr/bin/systemctl is-enabled --quiet certbot.timer || { echo "certbot.timer не включен" >&2; exit 1; }
  /usr/bin/systemctl is-active --quiet certbot.timer || { echo "certbot.timer не запущен" >&2; exit 1; }
fi

echo "Права пользователя $SERVICE_USER проверены. Certbot намеренно не запускался."
