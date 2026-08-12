#!/bin/bash

# Double-click entrypoint for a normal macOS user. All onboarding logic lives in
# installer/install.py so macOS and Windows share the same safety gates.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONUTF8=1

if ! command -v python3 >/dev/null 2>&1; then
  echo "ОСТАНОВЛЕНО: Python 3.10 или новее не найден."
  echo "Установите Python с https://www.python.org/downloads/ и запустите файл снова."
  echo
  read -r -p "Нажмите Enter, чтобы закрыть окно…" _unused
  exit 2
fi

python3 "$SCRIPT_DIR/installer/install.py" "$@"
status=$?

echo
read -r -p "Нажмите Enter, чтобы закрыть окно…" _unused
exit "$status"
