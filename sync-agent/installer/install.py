#!/usr/bin/env python3
"""Guided, two-phase installer for the Linked Helper sync agent.

This module deliberately uses only the Python standard library. The notebook's
third-party dependencies are installed into its private virtualenv after the
installer has verified the local prerequisites.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import pathlib
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence


HERE = pathlib.Path(__file__).resolve().parent
BUNDLE_ROOT = HERE.parent
RELEASE_PATH = HERE / "release.json"
TEMPLATE_PATH = HERE / "config.template.json"
REQUIREMENTS_PATH = BUNDLE_ROOT / "requirements.txt"

STATE_NAME = ".onboarding-state.json"
REPORT_NAME = "onboarding-report.txt"
INSPECT_NAME = "inspect.txt"
DRY_RUN_NAME = "dry-run.txt"
SYNC_LOG_NAME = "sync.log"
SYNC_ERROR_LOG_NAME = "sync-error.log"
MACOS_LABEL = "dev.ciphercross.lh2-sync"
WINDOWS_TASK_NAME = "LH2 Sync Agent"

TOKEN_RE = re.compile(
    r"lha\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.[A-Za-z0-9_-]{43}"
)
INSTANCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
VERSION_RE = re.compile(r'^AGENT_VERSION = "([^"]+)"', re.MULTILINE)


class InstallerError(RuntimeError):
    """A safe, user-facing stop condition."""


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def combined(self) -> str:
        parts = [part.rstrip() for part in (self.stdout, self.stderr) if part]
        return "\n".join(parts) + ("\n" if parts else "")


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reasons: tuple[str, ...]
    inspect_output: str
    dry_run_output: str
    campaigns: int | None
    leads: int | None


CommandRunner = Callable[[Sequence[str], pathlib.Path | None, int | None], CommandResult]


def default_install_root(system: str | None = None) -> pathlib.Path:
    system = system or platform.system()
    if system not in {"Darwin", "Windows"}:
        raise InstallerError("Поддерживаются только macOS и Windows.")
    return pathlib.Path.home() / "sync-agent"


def venv_python(root: pathlib.Path, system: str | None = None) -> pathlib.Path:
    system = system or platform.system()
    return root / ".venv" / ("Scripts/python.exe" if system == "Windows" else "bin/python")


def load_json(path: pathlib.Path) -> dict:
    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError) as error:
        raise InstallerError(f"Не удалось прочитать {path.name}: {error}") from error
    if not isinstance(value, dict):
        raise InstallerError(f"{path.name} имеет неверный формат.")
    return value


def release_metadata() -> dict:
    metadata = load_json(RELEASE_PATH)
    agent = metadata.get("agent")
    required = {"version", "commit", "url", "sha256", "bytes"}
    if not isinstance(agent, dict) or not required.issubset(agent):
        raise InstallerError("release.json не содержит полные данные агента.")
    if not re.fullmatch(r"[0-9a-f]{40}", str(agent["commit"])):
        raise InstallerError("release.json содержит неверный commit.")
    if f"/{agent['commit']}/" not in str(agent["url"]):
        raise InstallerError("Ссылка агента не закреплена на указанном commit.")
    if not metadata.get("ingest_url") or not metadata.get("release_public_key"):
        raise InstallerError("release.json не содержит endpoint или ключ проверки обновлений.")
    return metadata


def redact(text: str, known_secret: str | None = None) -> str:
    if known_secret:
        text = text.replace(known_secret, "<СКРЫТО>")
    return TOKEN_RE.sub("<СКРЫТО>", text)


def run_command(
    args: Sequence[str],
    cwd: pathlib.Path | None = None,
    timeout: int | None = None,
) -> CommandResult:
    try:
        completed = subprocess.run(
            [str(arg) for arg in args],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
    except subprocess.TimeoutExpired as error:
        raise InstallerError(f"Команда не закончилась за {timeout} секунд.") from error
    except OSError as error:
        raise InstallerError(f"Не удалось запустить {args[0]}: {error}") from error
    return CommandResult(completed.returncode, completed.stdout, completed.stderr)


def secure_write(path: pathlib.Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = pathlib.Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if os.name != "nt":
            os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def windows_principal(runner: CommandRunner = run_command) -> str:
    result = runner(["whoami"], None, 15)
    principal = result.stdout.strip()
    if result.returncode != 0 or not principal:
        raise InstallerError("Windows не сообщил имя текущего пользователя для ACL.")
    return principal


def protect_install_root(
    root: pathlib.Path,
    system: str | None = None,
    runner: CommandRunner = run_command,
) -> None:
    system = system or platform.system()
    root.mkdir(parents=True, exist_ok=True)
    if system == "Darwin":
        os.chmod(root, 0o700)
        return
    if system != "Windows":
        raise InstallerError("Неизвестная платформа для защиты папки агента.")
    principal = windows_principal(runner)
    result = runner(
        ["icacls", str(root), "/inheritance:r", "/grant:r", f"{principal}:(OI)(CI)F"],
        None,
        30,
    )
    if result.returncode != 0:
        raise InstallerError("Не удалось ограничить доступ к папке агента текущим пользователем.")


def protect_secret_file(
    path: pathlib.Path,
    system: str | None = None,
    runner: CommandRunner = run_command,
) -> None:
    system = system or platform.system()
    if system == "Darwin":
        os.chmod(path, 0o600)
        return
    principal = windows_principal(runner)
    result = runner(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{principal}:F"],
        None,
        30,
    )
    if result.returncode != 0:
        raise InstallerError("Не удалось защитить config.yaml. Активация остановлена.")


def validate_instance_id(value: str) -> str:
    value = value.strip()
    if not INSTANCE_RE.fullmatch(value):
        raise InstallerError(
            "Номер ноутбука должен содержать 1–64 латинских букв, цифр, '-' или '_'."
        )
    return value


def validate_token(value: str) -> str:
    value = value.strip()
    if not TOKEN_RE.fullmatch(value):
        raise InstallerError("Ключ имеет неверный формат. Ничего не установлено.")
    return value


def validate_label(value: str, fallback: str) -> str:
    value = value.strip() or fallback
    if len(value) > 120 or any(ord(character) < 32 for character in value):
        raise InstallerError("Название должно быть одной строкой длиной до 120 символов.")
    return value


def render_config(instance_id: str, label: str, token: str) -> str:
    metadata = release_metadata()
    config = load_json(TEMPLATE_PATH)
    config = {
        **config,
        "instance_id": validate_instance_id(instance_id),
        "instance_label": validate_label(label, instance_id),
        "ingest_url": metadata["ingest_url"],
        "ingest_token": validate_token(token),
        "release_public_key": metadata["release_public_key"],
    }
    return json.dumps(config, ensure_ascii=False, indent=2) + "\n"


def verify_release_bytes(data: bytes, metadata: dict) -> str:
    expected_size = int(metadata["bytes"])
    actual_hash = hashlib.sha256(data).hexdigest()
    if len(data) != expected_size:
        raise InstallerError(
            f"Размер agent.py не совпал: {len(data)} вместо {expected_size}."
        )
    if actual_hash != metadata["sha256"]:
        raise InstallerError("SHA-256 agent.py не совпал. Файл не установлен.")
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise InstallerError("agent.py не является корректным UTF-8 файлом.") from error
    match = VERSION_RE.search(source)
    if not match or match.group(1) != metadata["version"]:
        raise InstallerError("Версия внутри agent.py не совпала с release.json.")
    return actual_hash


def download_verified_agent(root: pathlib.Path) -> str:
    agent_metadata = release_metadata()["agent"]
    request = urllib.request.Request(
        agent_metadata["url"], headers={"User-Agent": "CipherCross-LH2-Installer/1"}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(int(agent_metadata["bytes"]) + 1)
    except Exception as error:
        raise InstallerError(f"Не удалось скачать agent.py: {type(error).__name__}.") from error
    digest = verify_release_bytes(data, agent_metadata)

    temporary = root / "agent.py.new"
    secure_write(temporary, data.decode("utf-8"), 0o600)
    python = venv_python(root)
    compiled = run_command([str(python), "-m", "py_compile", str(temporary)], root, 60)
    if compiled.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise InstallerError("Проверка Python-кода agent.py не прошла. Файл не установлен.")
    os.replace(temporary, root / "agent.py")
    return digest


def create_virtualenv(root: pathlib.Path) -> None:
    if not REQUIREMENTS_PATH.is_file():
        raise InstallerError("В наборе установщика нет requirements.txt.")
    python = venv_python(root)
    if not python.is_file():
        result = run_command([sys.executable, "-m", "venv", str(root / ".venv")], root, 180)
        if result.returncode != 0:
            raise InstallerError("Не удалось создать отдельное Python-окружение (.venv).")
    upgrade = run_command([str(python), "-m", "pip", "install", "--upgrade", "pip"], root, 300)
    if upgrade.returncode != 0:
        raise InstallerError("Не удалось обновить pip внутри .venv.")
    install = run_command(
        [str(python), "-m", "pip", "install", "-r", str(REQUIREMENTS_PATH)],
        root,
        600,
    )
    if install.returncode != 0:
        raise InstallerError("Не удалось установить библиотеки агента.")


def write_state(root: pathlib.Path, state: dict) -> None:
    safe = dict(state)
    for forbidden in ("ingest_token", "token", "credential"):
        safe.pop(forbidden, None)
    secure_write(root / STATE_NAME, json.dumps(safe, ensure_ascii=False, indent=2) + "\n")


def read_state(root: pathlib.Path) -> dict | None:
    path = root / STATE_NAME
    return load_json(path) if path.is_file() else None


def config_instance_id(root: pathlib.Path) -> str:
    python = venv_python(root)
    config = root / "config.yaml"
    if not python.is_file() or not config.is_file():
        raise InstallerError("Установка неполная: нет .venv или config.yaml.")
    code = (
        "import json,sys,yaml; "
        "c=yaml.safe_load(open(sys.argv[1],encoding='utf-8')) or {}; "
        "print(json.dumps(c.get('instance_id')))"
    )
    result = run_command([str(python), "-c", code, str(config)], root, 30)
    if result.returncode != 0:
        raise InstallerError("config.yaml больше не является корректным YAML.")
    try:
        identity = json.loads(result.stdout.strip())
    except ValueError as error:
        raise InstallerError("Не удалось проверить instance_id в config.yaml.") from error
    return validate_instance_id(identity or "")


def ensure_identity_unchanged(root: pathlib.Path, state: dict) -> str:
    identity = config_instance_id(root)
    if identity != state.get("instance_id"):
        raise InstallerError(
            "instance_id в config.yaml изменился. Ничего не запущено; напишите Миките."
        )
    return identity


def set_auto_update(root: pathlib.Path, enabled: bool) -> None:
    """Change only auto_update without exposing or re-keying the local config."""
    python = venv_python(root)
    config_path = root / "config.yaml"
    code = (
        "import json,sys,yaml; "
        "p=sys.argv[1]; c=yaml.safe_load(open(p,encoding='utf-8')) or {}; "
        "c['auto_update']=(sys.argv[2]=='true'); "
        "print(json.dumps(c,ensure_ascii=False,indent=2))"
    )
    result = run_command(
        [str(python), "-c", code, str(config_path), "true" if enabled else "false"],
        root,
        30,
    )
    if result.returncode != 0:
        raise InstallerError("Не удалось изменить настройку подписанных обновлений.")
    try:
        parsed = json.loads(result.stdout)
    except ValueError as error:
        raise InstallerError("Не удалось безопасно пересобрать config.yaml.") from error
    if parsed.get("instance_id") != config_instance_id(root):
        raise InstallerError("Проверка instance_id при обновлении config.yaml не прошла.")
    secure_write(config_path, json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", 0o600)
    protect_secret_file(config_path)


def run_agent(
    root: pathlib.Path,
    arguments: Sequence[str],
    runner: CommandRunner = run_command,
    timeout: int | None = None,
) -> CommandResult:
    return runner(
        [str(venv_python(root)), str(root / "agent.py"), *arguments],
        root,
        timeout,
    )


def evaluate_dry_run(inspect: CommandResult, dry_run: CommandResult) -> ValidationResult:
    inspect_output = redact(inspect.combined)
    dry_output = redact(dry_run.combined)
    reasons: list[str] = []
    if inspect.returncode != 0:
        reasons.append("команда inspect завершилась ошибкой")
    if "lh.db" not in inspect_output or "No SQLite databases discovered" in inspect_output:
        reasons.append("база Linked Helper lh.db не найдена")
    if dry_run.returncode != 0:
        reasons.append("пробный запуск завершился ошибкой")
    failure_markers = {
        "Traceback": "пробный запуск содержит Traceback",
        "preview failed": "предпросмотр отправки не построен",
        "PROBLEM(S)": "проверка parity нашла расхождения",
        "ingest_token is malformed": "ключ доступа повреждён",
        "ingest_token is not a well-formed": "ключ доступа повреждён",
        "WARNING: a real sync would report status 'partial'": "часть данных не извлеклась",
    }
    for marker, reason in failure_markers.items():
        if marker in dry_output:
            reasons.append(reason)
    if "ingest gateway — mode 'only', nothing sent" not in dry_output:
        reasons.append("режим отправки не подтверждён как only")
    if not re.search(r"(?m)^\s*parity\s+ok\b", dry_output):
        reasons.append("нет подтверждения parity ok")

    summary = re.search(
        r"(?m)^(\d+) campaigns, (\d+) leads, (\d+) messages, (\d+) steps\.",
        dry_output,
    )
    campaigns = int(summary.group(1)) if summary else None
    leads = int(summary.group(2)) if summary else None
    if not summary:
        reasons.append("не найдена итоговая строка с количеством кампаний")
    elif campaigns == 0 or leads == 0:
        reasons.append("извлечение кампаний или лидов пустое")

    return ValidationResult(
        ok=not reasons,
        reasons=tuple(dict.fromkeys(reasons)),
        inspect_output=inspect_output,
        dry_run_output=dry_output,
        campaigns=campaigns,
        leads=leads,
    )


def perform_validation(
    root: pathlib.Path,
    runner: CommandRunner = run_command,
) -> ValidationResult:
    inspect = run_agent(root, ["inspect"], runner, 180)
    dry_run = run_agent(root, ["sync", "--dry-run"], runner, 600)
    result = evaluate_dry_run(inspect, dry_run)
    secure_write(root / INSPECT_NAME, result.inspect_output, 0o600)
    secure_write(root / DRY_RUN_NAME, result.dry_run_output, 0o600)
    return result


def report_text(state: dict, validation: ValidationResult, status: str) -> str:
    metadata = release_metadata()["agent"]
    reasons = "нет" if not validation.reasons else "; ".join(validation.reasons)
    return (
        "ОТЧЁТ УСТАНОВКИ LH2 SYNC AGENT\n"
        "================================\n"
        f"Статус: {status}\n"
        f"Ноутбук: {state['instance_id']}\n"
        f"ОС: {platform.system()}\n"
        f"Версия агента: {metadata['version']}\n"
        f"SHA-256 проверен: {state.get('agent_sha256') == metadata['sha256']}\n"
        f"Кампаний найдено: {validation.campaigns if validation.campaigns is not None else 'неизвестно'}\n"
        f"Лидов найдено: {validation.leads if validation.leads is not None else 'неизвестно'}\n"
        f"Parity: {'ok' if validation.ok else 'не подтверждён'}\n"
        f"Причины остановки: {reasons}\n"
        "Ключ доступа: сохранён локально, в отчёт не включён\n\n"
        "ПРОБНЫЙ ЗАПУСК — НИЧЕГО НЕ ОТПРАВЛЕНО\n"
        "----------------------------------------\n"
        f"{validation.dry_run_output}"
    )


def write_report(
    root: pathlib.Path,
    state: dict,
    validation: ValidationResult,
    status: str,
) -> pathlib.Path:
    path = root / REPORT_NAME
    secure_write(path, report_text(state, validation, status), 0o600)
    return path


def existing_install_conflict(root: pathlib.Path) -> bool:
    if not root.exists():
        return False
    owned = read_state(root)
    if owned:
        return False
    names = {"agent.py", "config.yaml", ".venv", STATE_NAME}
    return any((root / name).exists() for name in names)


def install_action(root: pathlib.Path) -> None:
    if existing_install_conflict(root):
        raise InstallerError(
            f"В {root} уже есть агент без метки этого установщика. Файлы не изменены."
        )
    state = read_state(root)
    if state:
        if state.get("status") == "installing":
            print("Продолжаю прерванную установку для " + str(state.get("instance_id")) + ".")
            token = validate_token(getpass.getpass("Снова введите ключ lha. (на экране не появится): "))
            complete_install(root, state, token)
            return
        print("Установка уже завершена; повторяю только безопасную проверку.")
        recheck_action(root, state)
        return

    print("Установка только подготовит агент и выполнит пробный запуск.")
    print("Данные не будут отправлены, автозапуск не будет включён.\n")
    instance_id = validate_instance_id(input("Номер ноутбука (например, uitop-1): "))
    label = validate_label(input("Понятное название ноутбука: "), instance_id)
    token = validate_token(getpass.getpass("Ключ lha. (на экране не появится): "))

    state = {
        "schema_version": 1,
        "instance_id": instance_id,
        "instance_label": label,
        "status": "installing",
        "agent_version": release_metadata()["agent"]["version"],
    }
    protect_install_root(root)
    write_state(root, state)
    complete_install(root, state, token)


def complete_install(root: pathlib.Path, state: dict, token: str) -> None:
    """Finish or safely resume an installer-owned partial installation."""
    ensure = validate_instance_id(str(state.get("instance_id") or ""))
    create_virtualenv(root)
    digest = download_verified_agent(root)
    config_path = root / "config.yaml"
    secure_write(
        config_path,
        render_config(
            ensure,
            validate_label(str(state.get("instance_label") or ""), ensure),
            token,
        ),
        0o600,
    )
    protect_secret_file(config_path)
    state["status"] = "software_installed"
    state["agent_sha256"] = digest
    write_state(root, state)
    recheck_action(root, state)


def recheck_action(root: pathlib.Path, state: dict | None = None) -> ValidationResult:
    state = state or read_state(root)
    if not state:
        raise InstallerError("Установка ещё не начата.")
    ensure_identity_unchanged(root, state)
    print("Проверяю Linked Helper. Это может занять несколько минут…")
    validation = perform_validation(root)
    if validation.ok:
        state["status"] = "ready_to_activate"
        status = "ГОТОВО К СОГЛАСОВАНИЮ — НЕ АКТИВИРОВАНО"
    else:
        state["status"] = "software_installed"
        status = "ОСТАНОВЛЕНО — НУЖНА ПОМОЩЬ С НАСТРОЙКАМИ"
    write_state(root, state)
    report = write_report(root, state, validation, status)
    print(f"\nОтчёт: {report}")
    print(f"Диагностика базы: {root / INSPECT_NAME}")
    if validation.ok:
        print("Ничего не отправлено. Пришлите оба файла Миките и дождитесь одобрения.")
    else:
        print("Ничего не отправлено. Причины остановки:")
        for reason in validation.reasons:
            print(f"  - {reason}")
    return validation


def build_launch_agent(root: pathlib.Path) -> bytes:
    payload = {
        "Label": MACOS_LABEL,
        "ProgramArguments": [str(venv_python(root, "Darwin")), str(root / "agent.py"), "sync"],
        "WorkingDirectory": str(root),
        "StartInterval": 1800,
        "ProcessType": "Background",
        "StandardOutPath": str(root / SYNC_LOG_NAME),
        "StandardErrorPath": str(root / SYNC_ERROR_LOG_NAME),
    }
    return plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=False)


def wait_for_sync_log(path: pathlib.Path, offset: int, timeout: int = 180) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            with path.open("rb") as handle:
                handle.seek(min(offset, path.stat().st_size))
                new = handle.read().decode("utf-8", errors="replace")
            if re.search(r"(?m)^sync ok:", redact(new)):
                return True
            if "sync failed:" in new:
                return False
        time.sleep(2)
    return False


def register_macos_schedule(
    root: pathlib.Path,
    runner: CommandRunner = run_command,
    verify: bool = True,
) -> None:
    launch_agents = pathlib.Path.home() / "Library" / "LaunchAgents"
    launch_agents.mkdir(parents=True, exist_ok=True)
    plist = launch_agents / f"{MACOS_LABEL}.plist"
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{MACOS_LABEL}"
    runner(["launchctl", "bootout", domain, str(plist)], None, 30)
    secure_write(plist, build_launch_agent(root).decode("utf-8"), 0o644)
    boot = runner(["launchctl", "bootstrap", domain, str(plist)], None, 30)
    if boot.returncode != 0:
        raise InstallerError(f"Не удалось загрузить LaunchAgent: {boot.stderr.strip()}")
    shown = runner(["launchctl", "print", service], None, 30)
    if shown.returncode != 0:
        raise InstallerError("LaunchAgent создан, но launchctl его не видит.")
    if not verify:
        return
    log = root / SYNC_LOG_NAME
    offset = log.stat().st_size if log.exists() else 0
    kicked = runner(["launchctl", "kickstart", "-k", service], None, 30)
    if kicked.returncode != 0 or not wait_for_sync_log(log, offset):
        runner(["launchctl", "bootout", domain, str(plist)], None, 30)
        plist.unlink(missing_ok=True)
        raise InstallerError("Проверочный запуск LaunchAgent не дал новую строку sync ok.")


def windows_runner_contents() -> str:
    return (
        "@echo off\r\n"
        "set PYTHONUTF8=1\r\n"
        "cd /d \"%~dp0\"\r\n"
        "\".venv\\Scripts\\python.exe\" agent.py sync >> sync.log 2>&1\r\n"
    )


def windows_powershell() -> str:
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    return str(pathlib.Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")


def register_windows_schedule(
    root: pathlib.Path,
    runner: CommandRunner = run_command,
    verify: bool = True,
) -> None:
    helper = BUNDLE_ROOT / "install-windows.ps1"
    if not helper.is_file():
        raise InstallerError("В наборе установщика нет install-windows.ps1.")
    secure_write(root / "run-sync.cmd", windows_runner_contents(), 0o600)
    args = [
        windows_powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(helper), "-RegisterSchedule", "-InstallRoot", str(root),
    ]
    registered = runner(args, None, 60)
    if registered.returncode != 0:
        raise InstallerError(f"Task Scheduler отклонил задание: {registered.stderr.strip()}")
    if not verify:
        return
    log = root / SYNC_LOG_NAME
    offset = log.stat().st_size if log.exists() else 0
    started = runner(
        [windows_powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", str(helper), "-StartSchedule", "-InstallRoot", str(root)],
        None,
        60,
    )
    if started.returncode != 0 or not wait_for_sync_log(log, offset):
        runner(
            [windows_powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(helper), "-UnregisterSchedule", "-InstallRoot", str(root)],
            None,
            60,
        )
        raise InstallerError("Проверочный запуск Task Scheduler не дал новую строку sync ok.")


def unregister_schedule(
    root: pathlib.Path,
    system: str | None = None,
    runner: CommandRunner = run_command,
) -> None:
    system = system or platform.system()
    if system == "Darwin":
        plist = pathlib.Path.home() / "Library" / "LaunchAgents" / f"{MACOS_LABEL}.plist"
        runner(["launchctl", "bootout", f"gui/{os.getuid()}", str(plist)], None, 30)
        plist.unlink(missing_ok=True)
        return
    if system == "Windows":
        helper = BUNDLE_ROOT / "install-windows.ps1"
        runner(
            [windows_powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(helper), "-UnregisterSchedule", "-InstallRoot", str(root)],
            None,
            60,
        )
        return
    raise InstallerError("Неизвестная платформа для отключения автозапуска.")


def register_schedule(
    root: pathlib.Path,
    system: str | None = None,
    runner: CommandRunner = run_command,
    verify: bool = True,
) -> None:
    system = system or platform.system()
    if system == "Darwin":
        register_macos_schedule(root, runner, verify)
    elif system == "Windows":
        register_windows_schedule(root, runner, verify)
    else:
        raise InstallerError("Автозапуск поддерживается только на macOS и Windows.")


def perform_activation(
    root: pathlib.Path,
    state: dict,
    confirmation: str,
    runner: CommandRunner = run_command,
    scheduler: Callable[[pathlib.Path], None] = register_schedule,
    schedule_cleanup: Callable[[pathlib.Path], None] = unregister_schedule,
    update_toggle: Callable[[pathlib.Path, bool], None] = set_auto_update,
) -> CommandResult:
    ensure_identity_unchanged(root, state)
    expected = f"ОДОБРЕНО {state['instance_id']}"
    if confirmation.strip() != expected:
        raise InstallerError("Подтверждение не совпало. Данные не отправлены.")
    # A corrected operator-supplied config may have re-enabled updates. Pin them
    # off again so the build that passed the fresh dry run is exactly the build
    # that performs the first live and scheduler-originated syncs.
    update_toggle(root, False)
    live = run_agent(root, ["sync"], runner, 900)
    output = redact(live.combined)
    with (root / SYNC_LOG_NAME).open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(output)
    if live.returncode != 0 or not re.search(r"(?m)^sync ok:", output):
        raise InstallerError("Первая синхронизация не завершилась строкой sync ok. Автозапуск не включён.")
    scheduler(root)
    try:
        update_toggle(root, True)
    except Exception:
        schedule_cleanup(root)
        raise
    return CommandResult(live.returncode, output, "")


def activate_action(root: pathlib.Path) -> None:
    state = read_state(root)
    if not state:
        raise InstallerError("Сначала выполните установку.")
    if state.get("status") not in {"ready_to_activate", "active"}:
        raise InstallerError("Пробный запуск ещё не одобрен или требует исправления.")
    if state.get("status") == "active":
        print("Агент уже активирован.")
        status_action(root)
        return

    validation = recheck_action(root, state)
    if not validation.ok:
        raise InstallerError("Свежая проверка не прошла. Данные не отправлены.")
    print("\nПродолжайте только после того, как Микита одобрил цифры из отчёта.")
    expected = f"ОДОБРЕНО {state['instance_id']}"
    confirmation = input(f"Введите точно «{expected}»: ")
    live = perform_activation(root, state, confirmation)
    state["status"] = "active"
    write_state(root, state)
    with (root / REPORT_NAME).open("a", encoding="utf-8", newline="\n") as handle:
        handle.write("\nАКТИВАЦИЯ\n----------\nПервая синхронизация: sync ok\nАвтозапуск: включён и проверен\n")
    print(redact(live.stdout).rstrip())
    print("\nГотово: первая синхронизация прошла, автозапуск каждые 30 минут включён.")


def schedule_status(root: pathlib.Path, runner: CommandRunner = run_command) -> str:
    system = platform.system()
    if system == "Darwin":
        service = f"gui/{os.getuid()}/{MACOS_LABEL}"
        result = runner(["launchctl", "print", service], None, 30)
    elif system == "Windows":
        result = runner(["schtasks", "/Query", "/TN", WINDOWS_TASK_NAME], None, 30)
    else:
        return "не поддерживается"
    return "зарегистрирован" if result.returncode == 0 else "не зарегистрирован"


def status_action(root: pathlib.Path) -> None:
    state = read_state(root)
    if not state:
        print("Агент ещё не установлен этим установщиком.")
        return
    identity = ensure_identity_unchanged(root, state)
    print(f"Ноутбук: {identity}")
    print(f"Состояние: {state.get('status', 'неизвестно')}")
    print(f"Автозапуск: {schedule_status(root)}")
    log = root / SYNC_LOG_NAME
    if log.is_file():
        lines = redact(log.read_text(encoding="utf-8", errors="replace")).splitlines()[-8:]
        print("Последние строки журнала:")
        for line in lines:
            print(f"  {line}")


def available_actions(state: dict | None) -> tuple[str, ...]:
    if not state:
        return ("install",)
    status = state.get("status")
    if status == "installing":
        return ("install", "status")
    if status == "software_installed":
        return ("recheck", "status")
    if status == "ready_to_activate":
        return ("activate", "recheck", "status")
    if status == "active":
        return ("status",)
    return ("status",)


ACTION_LABELS = {
    "install": "Установить и выполнить безопасную проверку",
    "recheck": "Повторить безопасную проверку",
    "activate": "Активировать после одобрения Микиты",
    "status": "Показать состояние",
}


def choose_action(root: pathlib.Path) -> str:
    actions = available_actions(read_state(root))
    if len(actions) == 1:
        return actions[0]
    print("Выберите действие:")
    for index, action in enumerate(actions, 1):
        print(f"  {index}. {ACTION_LABELS[action]}")
    answer = input("Номер: ").strip()
    if not answer.isdigit() or not 1 <= int(answer) <= len(actions):
        raise InstallerError("Неизвестный пункт меню.")
    return actions[int(answer) - 1]


def check_python_version() -> None:
    if sys.version_info < (3, 10):
        raise InstallerError(
            f"Нужен Python 3.10 или новее; найден {platform.python_version()}."
        )


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Установка LH2 Sync Agent")
    parser.add_argument("action", nargs="?", choices=("install", "recheck", "activate", "status"))
    parser.add_argument("--install-root", type=pathlib.Path, help=argparse.SUPPRESS)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        check_python_version()
        root = (args.install_root or default_install_root()).expanduser().resolve()
        action = args.action or choose_action(root)
        if action == "install":
            install_action(root)
        elif action == "recheck":
            recheck_action(root)
        elif action == "activate":
            activate_action(root)
        else:
            status_action(root)
        return 0
    except (InstallerError, KeyboardInterrupt, EOFError) as error:
        message = str(error) if str(error) else "Операция отменена."
        print(f"\nОСТАНОВЛЕНО: {redact(message)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
