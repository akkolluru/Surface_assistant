"""Isolated tests for system and deployment shell scripts."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tarfile
import textwrap
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SYSTEM_SCRIPTS_DIR = REPO_ROOT / "system" / "scripts"
PIPEWIRE_DIR = REPO_ROOT / "system" / "pipewire-rules"
SCRIPTS_DIR = REPO_ROOT / "scripts"
SWAY_CONFIG = REPO_ROOT / "system" / "sway" / "config"

EXPECTED_SHELL_SCRIPTS = sorted(
    [
        SYSTEM_SCRIPTS_DIR / "return-home.sh",
        SYSTEM_SCRIPTS_DIR / "run-kiosk-browser.sh",
        SYSTEM_SCRIPTS_DIR / "setup-kiosk-autologin.sh",
        SYSTEM_SCRIPTS_DIR / "verify-surface.sh",
        SYSTEM_SCRIPTS_DIR / "volume-rocker.sh",
        SYSTEM_SCRIPTS_DIR / "waybar-home-state.sh",
        PIPEWIRE_DIR / "init-sinks.sh",
        SCRIPTS_DIR / "deploy-surface.sh",
        SCRIPTS_DIR / "simulate-mac.sh",
        SCRIPTS_DIR / "sync-wallpapers.sh",
        REPO_ROOT / "system" / "setup-surface.sh",
    ]
)

ALL_SHELL_SCRIPTS = sorted(
    list((REPO_ROOT / "system").rglob("*.sh")) + list(SCRIPTS_DIR.rglob("*.sh"))
)


@dataclass
class ScriptSandbox:
    """Isolated temp-dir execution environment with PATH shims."""

    tmp_path: Path
    home: Path = field(init=False)
    runtime_dir: Path = field(init=False)
    bin_dir: Path = field(init=False)
    state_dir: Path = field(init=False)
    log_dir: Path = field(init=False)

    def __post_init__(self) -> None:
        self.home = self.tmp_path / "home"
        self.runtime_dir = self.tmp_path / "run"
        self.bin_dir = self.tmp_path / "bin"
        self.state_dir = self.tmp_path / "state"
        self.log_dir = self.tmp_path / "logs"
        for directory in (self.home, self.runtime_dir, self.bin_dir, self.state_dir, self.log_dir):
            directory.mkdir(parents=True, exist_ok=True)
        # Ensure `python3` resolves to the active test interpreter inside isolated PATH.
        python3_link = self.bin_dir / "python3"
        if not python3_link.exists():
            python3_link.symlink_to(Path(sys.executable))

    def env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """Build an isolated environment dict without host Sway/Wayland/HOME leaks."""
        env_vars = {
            "HOME": str(self.home),
            "XDG_RUNTIME_DIR": str(self.runtime_dir),
            "PATH": f"{self.bin_dir}:/usr/bin:/bin",
            "USER": "surface-test",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "SANDBOX_STATE_DIR": str(self.state_dir),
            "SANDBOX_LOG_DIR": str(self.log_dir),
        }
        if extra:
            env_vars.update(extra)
        return env_vars

    def install_python_shim(self, name: str, body: str) -> Path:
        """Install an executable Python shim in `bin_dir`."""
        shim_path = self.bin_dir / name
        content = f"#!{sys.executable}\n{textwrap.dedent(body).lstrip()}"
        shim_path.write_text(content, encoding="utf-8")
        shim_path.chmod(0o755)
        return shim_path

    def install_bash_shim(self, name: str, body: str) -> Path:
        """Install an executable Bash shim in `bin_dir`."""
        shim_path = self.bin_dir / name
        content = f"#!/usr/bin/env bash\n{textwrap.dedent(body).lstrip()}"
        shim_path.write_text(content, encoding="utf-8")
        shim_path.chmod(0o755)
        return shim_path

    def install_static_shim(
        self,
        name: str,
        *,
        exit_code: int = 0,
        stdout: str = "",
        stderr: str = "",
    ) -> Path:
        """Install a fast pure-Bash static shim without Python startup overhead."""
        lines: list[str] = []
        if stdout:
            lines.append(f"cat <<'__SHIM_STDOUT__'\n{stdout.rstrip(chr(10))}\n__SHIM_STDOUT__")
        if stderr:
            lines.append(f"cat <<'__SHIM_STDERR__' >&2\n{stderr.rstrip(chr(10))}\n__SHIM_STDERR__")
        lines.append(f"exit {exit_code}")
        return self.install_bash_shim(name, "\n".join(lines) + "\n")

    def install_recorder(
        self,
        name: str,
        *,
        exit_code: int = 0,
        stdout: str = "",
        stderr: str = "",
    ) -> Path:
        """Install a shim that appends each invocation to `logs/<name>.jsonl`."""
        return self.install_python_shim(
            name,
            f"""
            import json
            import os
            import sys
            from pathlib import Path

            log_path = Path(os.environ["SANDBOX_LOG_DIR"]) / {name + ".jsonl"!r}
            record = {{"argv": sys.argv[1:]}}
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\\n")
            if {stdout!r}:
                sys.stdout.write({stdout!r})
            if {stderr!r}:
                sys.stderr.write({stderr!r})
            sys.exit({exit_code})
            """,
        )

    def read_records(self, name: str) -> list[dict[str, Any]]:
        """Read structured JSONL call records for a shimmed binary."""
        log_path = self.log_dir / f"{name}.jsonl"
        if not log_path.exists():
            return []
        lines = [line for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [json.loads(line) for line in lines]

    def read_calls(self, name: str) -> list[list[str]]:
        """Read argv lists logged for a shimmed binary."""
        return [list(rec["argv"]) for rec in self.read_records(name)]

    def run(
        self,
        script: Path,
        args: Sequence[str] = (),
        *,
        extra_env: dict[str, str] | None = None,
        timeout: float = 10.0,
    ) -> subprocess.CompletedProcess[str]:
        """Run a shell script inside the isolated sandbox."""
        return subprocess.run(
            ["bash", str(script), *args],
            env=self.env(extra_env),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def popen(
        self,
        script: Path,
        args: Sequence[str] = (),
        *,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.Popen[str]:
        """Start a shell script asynchronously inside the isolated sandbox."""
        return subprocess.Popen(
            ["bash", str(script), *args],
            env=self.env(extra_env),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )


def install_jq_shim(sandbox: ScriptSandbox) -> Path:
    """Install a Python `jq` shim supporting the Sway workspace and tree queries."""
    return sandbox.install_python_shim(
        "jq",
        """
        import json
        import sys
        from collections.abc import Iterator
        from typing import Any

        args = sys.argv[1:]
        expr = ""
        for arg in args:
            if not arg.startswith("-"):
                expr = arg
                break

        raw = sys.stdin.read().strip()
        data: Any = json.loads(raw) if raw else None

        def iter_objects(node: Any) -> Iterator[dict[str, Any]]:
            if isinstance(node, dict):
                yield node
                for value in node.values():
                    yield from iter_objects(value)
            elif isinstance(node, list):
                for item in node:
                    yield from iter_objects(item)

        def has_kiosk(tree: Any) -> bool:
            for obj in iter_objects(tree):
                if obj.get("app_id") == "surface-kiosk":
                    return True
                props = obj.get("window_properties")
                if isinstance(props, dict) and props.get("class") == "surface-kiosk":
                    return True
            return False

        def count_media_leaves(tree: Any) -> int:
            def walk_leaves(node: dict[str, Any]) -> int:
                sub = list(node.get("nodes") or []) + list(node.get("floating_nodes") or [])
                if not sub:
                    return 1
                return sum(walk_leaves(child) for child in sub if isinstance(child, dict))

            total = 0
            for obj in iter_objects(tree):
                if obj.get("type") == "workspace" and obj.get("name") == "2:media":
                    children = list(obj.get("nodes") or []) + list(
                        obj.get("floating_nodes") or []
                    )
                    for child in children:
                        if isinstance(child, dict):
                            total += walk_leaves(child)
            return total

        if "select(.focused == true)" in expr:
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and item.get("focused") is True:
                        name = item.get("name")
                        if isinstance(name, str):
                            print(name)
            sys.exit(0)

        if "length > 0 | tostring" in expr and "2:media" in expr:
            kiosk = "true" if has_kiosk(data) else "false"
            print(f"{kiosk} {count_media_leaves(data)}")
            sys.exit(0)

        if "length > 0" in expr and "surface-kiosk" in expr:
            print("true" if has_kiosk(data) else "false")
            sys.exit(0)

        sys.stderr.write(f"Unsupported jq filter in test shim: {expr}\\n")
        sys.exit(2)
        """,
    )


def install_flock_shim(sandbox: ScriptSandbox) -> Path:
    """Install a real `fcntl.flock` shim supporting `flock -n <fd>`."""
    return sandbox.install_python_shim(
        "flock",
        """
        import fcntl
        import sys

        non_blocking = "-n" in sys.argv[1:] or "--nonblock" in sys.argv[1:]
        fd_arg = next((arg for arg in reversed(sys.argv[1:]) if arg.isdigit()), None)
        if fd_arg is None:
            sys.stderr.write("flock shim requires a numeric fd argument\\n")
            sys.exit(2)
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if non_blocking else 0)
        try:
            fcntl.flock(int(fd_arg), flags)
        except BlockingIOError:
            sys.exit(1)
        """,
    )


def test_all_expected_shell_scripts_discovered() -> None:
    assert ALL_SHELL_SCRIPTS == EXPECTED_SHELL_SCRIPTS


@pytest.mark.parametrize(
    "script_path",
    ALL_SHELL_SCRIPTS,
    ids=lambda p: str(p.relative_to(REPO_ROOT)),
)
def test_shell_scripts_pass_bash_syntax_and_are_executable(script_path: Path) -> None:
    assert os.access(script_path, os.X_OK), f"{script_path} must be executable"
    result = subprocess.run(
        ["bash", "-n", str(script_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"bash -n failed for {script_path}: {result.stderr}"


def test_sway_config_script_references_exist() -> None:
    config_text = SWAY_CONFIG.read_text(encoding="utf-8")
    referenced = re.findall(r"\$scripts/(?:\.\./)?([A-Za-z0-9_./-]+\.sh)", config_text)
    assert referenced == [
        "volume-rocker.sh",
        "volume-rocker.sh",
        "volume-rocker.sh",
        "pipewire-rules/init-sinks.sh",
        "run-kiosk-browser.sh",
    ]
    for rel_path in set(referenced):
        if "/" in rel_path:
            target = REPO_ROOT / "system" / rel_path
        else:
            target = SYSTEM_SCRIPTS_DIR / rel_path
        assert target.is_file(), f"Missing script referenced by sway config: {target}"


# ---------------------------------------------------------------------------
# Sway Helpers & Shared Shims
# ---------------------------------------------------------------------------


def make_workspaces(focused: str) -> list[dict[str, Any]]:
    """Construct a minimal Sway `get_workspaces` payload."""
    return [
        {"name": "1:hub", "focused": focused == "1:hub"},
        {"name": "2:media", "focused": focused == "2:media"},
    ]


def make_sway_tree(
    *,
    kiosk_mode: Literal["app_id", "class", "none"] = "app_id",
    media_windows: int = 0,
) -> dict[str, Any]:
    """Construct a minimal Sway `get_tree` payload."""
    hub_nodes: list[dict[str, Any]] = []
    if kiosk_mode == "app_id":
        hub_nodes.append({"type": "con", "app_id": "surface-kiosk", "nodes": []})
    elif kiosk_mode == "class":
        hub_nodes.append(
            {
                "type": "con",
                "app_id": None,
                "window_properties": {"class": "surface-kiosk"},
                "nodes": [],
            }
        )

    media_nodes = [
        {"type": "con", "app_id": f"media-{idx}", "nodes": [], "floating_nodes": []}
        for idx in range(media_windows)
    ]
    return {
        "type": "root",
        "nodes": [
            {"type": "workspace", "name": "1:hub", "nodes": hub_nodes, "floating_nodes": []},
            {"type": "workspace", "name": "2:media", "nodes": media_nodes, "floating_nodes": []},
        ],
    }


def write_sway_state(
    sandbox: ScriptSandbox,
    *,
    focused: str = "1:hub",
    kiosk_mode: Literal["app_id", "class", "none"] = "app_id",
    media_windows: int = 0,
    version_ok: bool = True,
    inputs: list[dict[str, Any]] | None = None,
    subscribe_steps: list[dict[str, Any]] | None = None,
) -> Path:
    """Write the JSON state read by `install_swaymsg_shim`."""
    state_path = sandbox.state_dir / "swaymsg_state.json"
    payload = {
        "version_ok": version_ok,
        "workspaces": make_workspaces(focused),
        "tree": make_sway_tree(kiosk_mode=kiosk_mode, media_windows=media_windows),
        "inputs": inputs or [],
        "subscribe_steps": subscribe_steps or [],
    }
    state_path.write_text(json.dumps(payload), encoding="utf-8")
    return state_path


def install_swaymsg_shim(sandbox: ScriptSandbox) -> Path:
    """Install a state-file-driven `swaymsg` shim supporting queries and subscribe."""
    return sandbox.install_python_shim(
        "swaymsg",
        """
        import json
        import os
        import sys
        import time
        from pathlib import Path

        state_dir = Path(os.environ["SANDBOX_STATE_DIR"])
        log_path = Path(os.environ["SANDBOX_LOG_DIR"]) / "swaymsg.jsonl"
        state_path = state_dir / "swaymsg_state.json"
        counter_path = state_dir / "swaymsg_tree_calls.txt"

        argv = sys.argv[1:]
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"argv": argv}) + "\\n")

        def read_state() -> dict:
            return json.loads(state_path.read_text(encoding="utf-8"))

        def write_state(data: dict) -> None:
            tmp = state_path.with_name(f"{state_path.name}.tmp.{os.getpid()}")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, state_path)

        def get_tree_calls() -> int:
            if not counter_path.exists():
                return 0
            return int(counter_path.read_text(encoding="utf-8").strip() or "0")

        def bump_tree_calls() -> int:
            val = get_tree_calls() + 1
            tmp = counter_path.with_name(f"{counter_path.name}.tmp.{os.getpid()}")
            tmp.write_text(str(val), encoding="utf-8")
            os.replace(tmp, counter_path)
            return val

        def wait_for_tree_calls(target: int, timeout: float = 3.0) -> None:
            deadline = time.monotonic() + timeout
            while get_tree_calls() < target:
                if time.monotonic() > deadline:
                    return
                time.sleep(0.005)

        if "-t" in argv:
            msg_type = argv[argv.index("-t") + 1]
            state = read_state()
            if msg_type == "get_version":
                if state.get("version_ok", True):
                    print('{"human_readable": "1.9"}')
                    sys.exit(0)
                sys.exit(1)
            if msg_type == "get_workspaces":
                print(json.dumps(state.get("workspaces", [])))
                sys.exit(0)
            if msg_type == "get_tree":
                bump_tree_calls()
                print(json.dumps(state.get("tree", {})))
                sys.exit(0)
            if msg_type == "get_inputs":
                print(json.dumps(state.get("inputs", [])))
                sys.exit(0)
            if msg_type == "subscribe":
                steps = state.get("subscribe_steps", [])
                for idx, step in enumerate(steps):
                    wait_for_tree_calls(idx + 1)
                    cur = read_state()
                    if "workspaces" in step:
                        cur["workspaces"] = step["workspaces"]
                    if "tree" in step:
                        cur["tree"] = step["tree"]
                    write_state(cur)
                    sys.stdout.write(json.dumps(step.get("event", {})) + "\\n")
                    sys.stdout.flush()
                if steps:
                    wait_for_tree_calls(len(steps) + 1)
                sys.exit(0)

        sys.exit(0)
        """,
    )


# ---------------------------------------------------------------------------
# waybar-home-state.sh
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("focused", "kiosk_mode", "expected"),
    [
        (
            "2:media",
            "app_id",
            {"text": "⌂ Home", "class": "visible", "tooltip": "Return to Ambient Hub"},
        ),
        (
            "2:media",
            "none",
            {"text": "⌂ Home", "class": "visible", "tooltip": "Return to Ambient Hub"},
        ),
        (
            "1:hub",
            "none",
            {"text": "↻ Open Hub", "class": "recover", "tooltip": "Reopen Ambient Hub"},
        ),
        (
            "1:hub",
            "app_id",
            {"text": "", "class": "hidden"},
        ),
        (
            "1:hub",
            "class",
            {"text": "", "class": "hidden"},
        ),
    ],
)
def test_waybar_home_state_initial_emissions(
    tmp_path: Path,
    focused: str,
    kiosk_mode: Literal["app_id", "class", "none"],
    expected: dict[str, str],
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused=focused, kiosk_mode=kiosk_mode)

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "waybar-home-state.sh")
    assert result.returncode == 0, result.stderr
    lines = [json.loads(line) for line in result.stdout.strip().splitlines()]
    assert lines == [expected]


def test_waybar_home_state_reacts_to_subscription_events(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(
        sandbox,
    )
    write_sway_state(
        sandbox,
        focused="1:hub",
        kiosk_mode="app_id",
        subscribe_steps=[
            {
                "event": {"change": "focus", "current": {"name": "2:media"}},
                "workspaces": make_workspaces("2:media"),
                "tree": make_sway_tree(kiosk_mode="app_id", media_windows=1),
            },
            {
                "event": {"change": "close", "container": {"app_id": "surface-kiosk"}},
                "workspaces": make_workspaces("1:hub"),
                "tree": make_sway_tree(kiosk_mode="none", media_windows=0),
            },
        ],
    )

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "waybar-home-state.sh")
    assert result.returncode == 0, result.stderr
    lines = [json.loads(line) for line in result.stdout.strip().splitlines()]
    assert lines == [
        {"text": "", "class": "hidden"},
        {"text": "⌂ Home", "class": "visible", "tooltip": "Return to Ambient Hub"},
        {"text": "↻ Open Hub", "class": "recover", "tooltip": "Reopen Ambient Hub"},
    ]
    sway_calls = sandbox.read_calls("swaymsg")
    assert ["-t", "subscribe", "-m", '["workspace","window"]'] in sway_calls


# ---------------------------------------------------------------------------
# return-home.sh
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kiosk_mode", ["app_id", "class"])
def test_return_home_posts_to_daemon_when_kiosk_present(
    tmp_path: Path, kiosk_mode: Literal["app_id", "class"]
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="2:media", kiosk_mode=kiosk_mode)
    sandbox.install_recorder("curl", exit_code=0)
    sandbox.install_recorder("playerctl", exit_code=0)

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "return-home.sh")
    assert result.returncode == 0, result.stderr

    assert sandbox.read_calls("curl") == [
        ["-fsS", "-X", "POST", "http://127.0.0.1:8000/api/media/home"]
    ]
    assert sandbox.read_calls("playerctl") == []
    assert sandbox.read_calls("swaymsg") == [["-t", "get_tree", "-r"]]


def test_return_home_falls_back_to_playerctl_and_swaymsg_on_curl_failure(
    tmp_path: Path,
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="2:media", kiosk_mode="app_id")
    sandbox.install_recorder("curl", exit_code=22)
    sandbox.install_recorder("playerctl", exit_code=0)

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "return-home.sh")
    assert result.returncode == 0, result.stderr

    assert len(sandbox.read_calls("curl")) == 1
    assert sandbox.read_calls("playerctl") == [["-a", "pause"]]
    assert sandbox.read_calls("swaymsg") == [
        ["-t", "get_tree", "-r"],
        ['workspace "1:hub"'],
    ]


@pytest.mark.parametrize(
    ("kiosk_mode", "args"),
    [
        ("none", ()),
        ("app_id", ("--relaunch",)),
    ],
)
def test_return_home_spawns_kiosk_runner_when_missing_or_relaunch(
    tmp_path: Path,
    kiosk_mode: Literal["app_id", "none"],
    args: tuple[str, ...],
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="1:hub", kiosk_mode=kiosk_mode)
    sandbox.install_recorder("curl", exit_code=0)
    sandbox.install_recorder("playerctl", exit_code=0)

    installed_runner = (
        sandbox.home
        / ".local"
        / "share"
        / "surface-assistant"
        / "scripts"
        / "run-kiosk-browser.sh"
    )
    installed_runner.parent.mkdir(parents=True, exist_ok=True)
    marker_file = sandbox.state_dir / "runner_spawned.txt"
    installed_runner.write_text(
        f"#!/usr/bin/env bash\nprintf 'spawned\\n' > '{marker_file}'\n",
        encoding="utf-8",
    )
    installed_runner.chmod(0o755)

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "return-home.sh", args)
    assert result.returncode == 0, result.stderr

    deadline = time.monotonic() + 2.0
    while not marker_file.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert marker_file.exists(), "Expected return-home.sh to spawn run-kiosk-browser.sh"
    assert sandbox.read_calls("curl") == []
    assert ['workspace "1:hub"'] in sandbox.read_calls("swaymsg")


def test_return_home_help_and_invalid_option(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)

    help_res = sandbox.run(SYSTEM_SCRIPTS_DIR / "return-home.sh", ["--help"])
    assert help_res.returncode == 0
    assert "Usage:" in help_res.stdout

    bad_res = sandbox.run(SYSTEM_SCRIPTS_DIR / "return-home.sh", ["--invalid"])
    assert bad_res.returncode == 1
    assert "Unknown option: --invalid" in bad_res.stderr


# ---------------------------------------------------------------------------
# run-kiosk-browser.sh
# ---------------------------------------------------------------------------


def _install_kiosk_curl_shim(sandbox: ScriptSandbox, *, fail_first_n: int = 0) -> Path:
    """Install a `curl` shim that fails `fail_first_n` times before succeeding."""
    return sandbox.install_python_shim(
        "curl",
        f"""
        import json
        import os
        import sys
        from pathlib import Path

        state_dir = Path(os.environ["SANDBOX_STATE_DIR"])
        log_path = Path(os.environ["SANDBOX_LOG_DIR"]) / "curl.jsonl"
        counter_path = state_dir / "curl_count.txt"
        count = int(counter_path.read_text(encoding="utf-8")) + 1 if counter_path.exists() else 1
        counter_path.write_text(str(count), encoding="utf-8")
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({{"argv": sys.argv[1:], "count": count}}) + "\\n")
        if count <= {fail_first_n}:
            sys.exit(7)
        print('{{"status":"ok"}}')
        sys.exit(0)
        """,
    )


def _install_kiosk_brave_shim(
    sandbox: ScriptSandbox,
    *,
    exit_codes: Sequence[int] = (0,),
    stop_sway_on_call: int | None = 1,
    block_until_file: Path | None = None,
) -> Path:
    """Install a configurable `brave-browser` shim for kiosk launcher tests."""
    codes_literal = repr(list(exit_codes))
    block_str = repr(str(block_until_file)) if block_until_file else "None"
    started_file = repr(str(sandbox.state_dir / "brave_started.txt"))
    return sandbox.install_python_shim(
        "brave-browser",
        f"""
        import json
        import os
        import sys
        import time
        from pathlib import Path

        state_dir = Path(os.environ["SANDBOX_STATE_DIR"])
        log_path = Path(os.environ["SANDBOX_LOG_DIR"]) / "brave-browser.jsonl"
        counter_path = state_dir / "brave_count.txt"
        count = int(counter_path.read_text(encoding="utf-8")) + 1 if counter_path.exists() else 1
        counter_path.write_text(str(count), encoding="utf-8")
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({{"argv": sys.argv[1:], "count": count}}) + "\\n")

        Path({started_file}).write_text(str(count), encoding="utf-8")

        block_target = {block_str}
        if block_target is not None:
            deadline = time.monotonic() + 5.0
            while not Path(block_target).exists() and time.monotonic() < deadline:
                time.sleep(0.01)

        stop_on = {stop_sway_on_call!r}
        if stop_on is not None and count >= stop_on:
            sway_state = state_dir / "swaymsg_state.json"
            data = json.loads(sway_state.read_text(encoding="utf-8"))
            data["version_ok"] = False
            sway_state.write_text(json.dumps(data), encoding="utf-8")

        codes = {codes_literal}
        rc = codes[count - 1] if count - 1 < len(codes) else codes[-1]
        sys.exit(rc)
        """,
    )


def test_run_kiosk_browser_single_instance_flock(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_flock_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, version_ok=True)
    _install_kiosk_curl_shim(sandbox)
    sandbox.install_recorder("pgrep", exit_code=1)
    sandbox.install_bash_shim("sleep", "exit 0")

    release_file = sandbox.state_dir / "release_brave.txt"
    _install_kiosk_brave_shim(
        sandbox,
        exit_codes=(0,),
        stop_sway_on_call=1,
        block_until_file=release_file,
    )

    fast_env = {
        "HEALTH_POLL_INTERVAL": "0",
        "HEALTH_RETRY_DELAY": "0",
        "RESPAWN_DELAY": "0",
    }
    first_proc = sandbox.popen(SYSTEM_SCRIPTS_DIR / "run-kiosk-browser.sh", extra_env=fast_env)
    started_file = sandbox.state_dir / "brave_started.txt"
    try:
        deadline = time.monotonic() + 4.0
        while not started_file.exists() and time.monotonic() < deadline:
            assert first_proc.poll() is None, first_proc.stderr.read() if first_proc.stderr else ""
            time.sleep(0.01)
        assert started_file.exists(), "First kiosk launcher never started brave-browser"

        second_res = sandbox.run(SYSTEM_SCRIPTS_DIR / "run-kiosk-browser.sh", extra_env=fast_env)
        assert second_res.returncode == 0
        assert len(sandbox.read_calls("brave-browser")) == 1
    finally:
        release_file.write_text("go", encoding="utf-8")
        out, err = first_proc.communicate(timeout=5.0)
    assert first_proc.returncode == 0, f"stdout={out} stderr={err}"
    assert len(sandbox.read_calls("brave-browser")) == 1


def test_run_kiosk_browser_cleans_stale_files_updates_prefs_and_passes_flags(
    tmp_path: Path,
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_flock_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, version_ok=True)
    _install_kiosk_curl_shim(sandbox)
    sandbox.install_recorder("pgrep", exit_code=1)
    sandbox.install_bash_shim("sleep", "exit 0")
    _install_kiosk_brave_shim(sandbox, exit_codes=(0,), stop_sway_on_call=1)

    kiosk_profile = sandbox.home / ".local" / "share" / "surface-assistant" / "kiosk-profile"
    sessions_dir = kiosk_profile / "Default" / "Sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "Session_1337").write_text("stale", encoding="utf-8")
    for singleton in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        (kiosk_profile / singleton).write_text("stale", encoding="utf-8")

    prefs_path = kiosk_profile / "Default" / "Preferences"
    prefs_path.write_text(
        json.dumps(
            {
                "browser": {"has_seen_welcome_page": True},
                "profile": {
                    "name": "SurfaceKiosk",
                    "exit_type": "Crashed",
                    "exited_cleanly": False,
                    "default_content_setting_values": {
                        "notifications": 2,
                        "popups": 1,
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    result = sandbox.run(
        SYSTEM_SCRIPTS_DIR / "run-kiosk-browser.sh",
        extra_env={
            "HEALTH_POLL_INTERVAL": "0",
            "HEALTH_RETRY_DELAY": "0",
            "RESPAWN_DELAY": "0",
        },
    )
    assert result.returncode == 0, result.stderr

    assert not sessions_dir.exists()
    assert list(kiosk_profile.glob("Singleton*")) == []

    updated_prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
    assert updated_prefs["browser"]["has_seen_welcome_page"] is True
    assert updated_prefs["profile"]["name"] == "SurfaceKiosk"
    assert updated_prefs["profile"]["exit_type"] == "Normal"
    assert updated_prefs["profile"]["exited_cleanly"] is True
    assert updated_prefs["profile"]["default_content_setting_values"] == {
        "notifications": 2,
        "popups": 2,
    }

    brave_calls = sandbox.read_calls("brave-browser")
    assert len(brave_calls) == 1
    argv = brave_calls[0]
    assert f"--user-data-dir={kiosk_profile}" in argv
    kiosk_idx = argv.index("--kiosk")
    assert argv[kiosk_idx + 1] == "http://127.0.0.1:8000"
    for expected_flag in (
        "--class=surface-kiosk",
        "--ozone-platform=wayland",
        "--touch-events=enabled",
        "--password-store=basic",
        "--disable-features=Vulkan",
        "--enable-features=VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks",
        "--overscroll-history-navigation=0",
        "--disable-pinch",
        "--no-first-run",
        "--noerrdialogs",
        "--disable-session-crashed-bubble",
    ):
        assert expected_flag in argv


def test_run_kiosk_browser_skips_cleanup_when_running_and_recovers_corrupt_prefs(
    tmp_path: Path,
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_flock_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, version_ok=True)
    _install_kiosk_curl_shim(sandbox)
    sandbox.install_recorder("pgrep", exit_code=0)
    sandbox.install_bash_shim("sleep", "exit 0")
    _install_kiosk_brave_shim(sandbox, exit_codes=(0,), stop_sway_on_call=1)

    kiosk_profile = sandbox.home / ".local" / "share" / "surface-assistant" / "kiosk-profile"
    (kiosk_profile / "Default").mkdir(parents=True)
    singleton_lock = kiosk_profile / "SingletonLock"
    singleton_lock.write_text("active", encoding="utf-8")
    prefs_path = kiosk_profile / "Default" / "Preferences"
    prefs_path.write_text("{corrupt json", encoding="utf-8")

    result = sandbox.run(
        SYSTEM_SCRIPTS_DIR / "run-kiosk-browser.sh",
        extra_env={"RESPAWN_DELAY": "0"},
    )
    assert result.returncode == 0, result.stderr
    assert singleton_lock.exists()

    recovered = json.loads(prefs_path.read_text(encoding="utf-8"))
    assert recovered == {
        "profile": {
            "exit_type": "Normal",
            "exited_cleanly": True,
            "default_content_setting_values": {"popups": 2},
        }
    }


def test_run_kiosk_browser_respawns_after_exit_until_sway_stops(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_flock_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, version_ok=True)
    _install_kiosk_curl_shim(sandbox, fail_first_n=2)
    sandbox.install_recorder("pgrep", exit_code=1)
    sandbox.install_bash_shim("sleep", "exit 0")
    _install_kiosk_brave_shim(sandbox, exit_codes=(1, 0), stop_sway_on_call=2)

    result = sandbox.run(
        SYSTEM_SCRIPTS_DIR / "run-kiosk-browser.sh",
        extra_env={
            "HEALTH_MAX_ATTEMPTS": "5",
            "HEALTH_POLL_INTERVAL": "0",
            "HEALTH_RETRY_DELAY": "0",
            "RESPAWN_DELAY": "0",
        },
    )
    assert result.returncode == 0, result.stderr
    assert len(sandbox.read_calls("brave-browser")) == 2
    assert len(sandbox.read_calls("curl")) >= 3
    assert "brave-browser exited with status 1; respawning" in result.stderr


# ---------------------------------------------------------------------------
# volume-rocker.sh & pipewire init-sinks.sh
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_args", [(), ("louder",)])
def test_volume_rocker_rejects_invalid_action(tmp_path: Path, bad_args: tuple[str, ...]) -> None:
    sandbox = ScriptSandbox(tmp_path)
    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "volume-rocker.sh", bad_args)
    assert result.returncode != 0
    assert "Usage:" in result.stderr


@pytest.mark.parametrize("action", ["up", "down", "mute"])
def test_volume_rocker_posts_to_daemon_on_hub(tmp_path: Path, action: str) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="1:hub")
    sandbox.install_recorder("curl", exit_code=0)
    sandbox.install_recorder("pactl", exit_code=0)

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "volume-rocker.sh", [action])
    assert result.returncode == 0, result.stderr
    assert sandbox.read_calls("curl") == [
        [
            "-fsS",
            "-X",
            "POST",
            "http://127.0.0.1:8000/api/audio/rocker",
            "-H",
            "Content-Type: application/json",
            "-d",
            f'{{"action":"{action}"}}',
        ]
    ]
    assert sandbox.read_calls("pactl") == []


@pytest.mark.parametrize(
    ("action", "expected_pactl_tail"),
    [
        ("up", [["set-sink-mute", "media-sink", "0"], ["set-sink-volume", "media-sink", "+5%"]]),
        ("down", [["set-sink-volume", "media-sink", "-5%"]]),
        ("mute", [["set-sink-mute", "media-sink", "toggle"]]),
    ],
)
def test_volume_rocker_falls_back_to_pactl_when_daemon_unreachable(
    tmp_path: Path,
    action: str,
    expected_pactl_tail: list[list[str]],
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="1:hub")
    sandbox.install_recorder("curl", exit_code=22)
    sandbox.install_recorder("pactl", exit_code=0, stdout="42\tmedia-sink\tPipeWire\n")

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "volume-rocker.sh", [action])
    assert result.returncode == 0, result.stderr
    assert len(sandbox.read_calls("curl")) == 1
    assert sandbox.read_calls("pactl") == [["list", "short", "sinks"], *expected_pactl_tail]


def test_volume_rocker_media_workspace_uses_default_sink_and_swayosd(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    install_jq_shim(sandbox)
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="2:media")
    sandbox.install_recorder("curl", exit_code=0)
    sandbox.install_recorder("pactl", exit_code=0, stdout="10\talsa_output.pci\tPipeWire\n")

    res_pactl = sandbox.run(SYSTEM_SCRIPTS_DIR / "volume-rocker.sh", ["up"])
    assert res_pactl.returncode == 0, res_pactl.stderr
    assert sandbox.read_calls("curl") == []
    assert sandbox.read_calls("pactl") == [
        ["list", "short", "sinks"],
        ["set-sink-mute", "@DEFAULT_SINK@", "0"],
        ["set-sink-volume", "@DEFAULT_SINK@", "+5%"],
    ]

    sandbox.install_recorder("swayosd-client", exit_code=0)
    res_osd = sandbox.run(SYSTEM_SCRIPTS_DIR / "volume-rocker.sh", ["down"])
    assert res_osd.returncode == 0, res_osd.stderr
    assert sandbox.read_calls("swayosd-client") == [
        ["--device", "@DEFAULT_SINK@", "--output-volume", "lower", "--max-volume", "100"]
    ]


def test_init_sinks_waits_and_configures_virtual_sinks(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_bash_shim("sleep", "exit 0")
    sandbox.install_python_shim(
        "pactl",
        """
        import json
        import os
        import sys
        from pathlib import Path

        state_dir = Path(os.environ["SANDBOX_STATE_DIR"])
        log_path = Path(os.environ["SANDBOX_LOG_DIR"]) / "pactl.jsonl"
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"argv": sys.argv[1:]}) + "\\n")

        if sys.argv[1:4] == ["list", "short", "sinks"]:
            cnt_path = state_dir / "pactl_list_count.txt"
            cnt = int(cnt_path.read_text(encoding="utf-8")) + 1 if cnt_path.exists() else 1
            cnt_path.write_text(str(cnt), encoding="utf-8")
            if cnt >= 2:
                print("1\\talarm-sink\\n2\\ttts-sink\\n3\\tmedia-sink")
        """,
    )

    result = sandbox.run(PIPEWIRE_DIR / "init-sinks.sh")
    assert result.returncode == 0, result.stderr
    calls = sandbox.read_calls("pactl")
    assert ["set-default-sink", "media-sink"] in calls
    assert ["set-sink-volume", "alarm-sink", "100%"] in calls
    assert ["set-sink-volume", "tts-sink", "50%"] in calls
    assert ["set-sink-volume", "media-sink", "60%"] in calls
    assert ["set-sink-mute", "alarm-sink", "0"] in calls
    assert ["set-sink-mute", "tts-sink", "0"] in calls
    assert ["set-sink-mute", "media-sink", "0"] in calls


def test_init_sinks_exits_cleanly_when_sinks_unavailable(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_bash_shim("sleep", "exit 0")
    sandbox.install_recorder("pactl", exit_code=0, stdout="")

    result = sandbox.run(PIPEWIRE_DIR / "init-sinks.sh")
    assert result.returncode == 0
    assert "PipeWire virtual sinks not found" in result.stderr
    assert all(call[0] == "list" for call in sandbox.read_calls("pactl"))


# ---------------------------------------------------------------------------
# verify-surface.sh
# ---------------------------------------------------------------------------


def _install_verify_linux_shims(
    sandbox: ScriptSandbox,
    *,
    uname_s: str = "Linux",
    kernel_rel: str = "6.14.0-surface",
    vainfo_ok: bool = True,
    vainfo_out: str = (
        "libva info: Driver version Intel iHD driver\n"
        "VAProfileH264Main : VAEntrypointVLD\n"
    ),
    groups: str = "surface-test video docker",
    sinks_out: str = "1\talarm-sink\n2\ttts-sink\n3\tmedia-sink\n",
    daemon_active: bool = True,
    wyoming_active: bool = True,
    iptsd_active: bool = True,
    curl_ok: bool = True,
    stremio_flatpak_wrapper: bool = True,
    flatpak_ok: bool = True,
    docker_ok: bool = True,
    linger: str = "Linger=yes",
    kiosk_mode: Literal["app_id", "class", "none"] = "app_id",
    touchscreen_present: bool = True,
    waybar_running: bool = True,
) -> None:
    """Install all Linux environment shims used by `verify-surface.sh`."""
    sandbox.install_bash_shim(
        "uname",
        f"""
        case "${{1:--s}}" in
          -r) printf '%s\\n' '{kernel_rel}' ;;
          *) printf '%s\\n' '{uname_s}' ;;
        esac
        """,
    )
    sandbox.install_static_shim(
        "vainfo",
        exit_code=0 if vainfo_ok else 1,
        stdout=vainfo_out if vainfo_ok else "",
    )
    sandbox.install_bash_shim(
        "id",
        f"""
        case "${{1:-}}" in
          -u) printf '1000\\n' ;;
          -nG) printf '%s\\n' '{groups}' ;;
          *) printf 'uid=1000(surface-test)\\n' ;;
        esac
        """,
    )
    sandbox.install_static_shim("pactl", exit_code=0, stdout=sinks_out)
    daemon_rc = 0 if daemon_active else 3
    wyoming_rc = 0 if wyoming_active else 3
    iptsd_line = (
        "printf 'iptsd@dev-hidraw0.service loaded active running IPTSD\\n'"
        if iptsd_active
        else ":"
    )
    sandbox.install_bash_shim(
        "systemctl",
        f"""
        case "$*" in
          *"is-active"*"surface-daemon.service"*) exit {daemon_rc} ;;
          *"is-active"*"surface-wyoming-satellite.service"*) exit {wyoming_rc} ;;
          *"list-units"*) {iptsd_line}; exit 0 ;;
          *) exit 0 ;;
        esac
        """,
    )
    sandbox.install_static_shim(
        "curl",
        exit_code=0 if curl_ok else 7,
        stdout='{"status":"ok"}\n' if curl_ok else "",
    )
    sandbox.install_static_shim("brave-browser", exit_code=0)
    if stremio_flatpak_wrapper:
        sandbox.install_bash_shim(
            "stremio",
            'exec flatpak run com.stremio.Stremio "$@"\n',
        )
    else:
        sandbox.install_bash_shim("stremio", "exit 0\n")
    sandbox.install_static_shim("flatpak", exit_code=0 if flatpak_ok else 1)
    sandbox.install_static_shim(
        "docker",
        exit_code=0 if docker_ok else 1,
        stdout="Docker Compose version v2.29.0\n" if docker_ok else "",
    )
    sandbox.install_static_shim("loginctl", exit_code=0, stdout=f"{linger}\n")
    sandbox.install_static_shim("pgrep", exit_code=0 if waybar_running else 1, stdout="4321\n")

    inputs = (
        [{"name": "IPTSD_Virtual_Touchscreen", "type": "touch"}]
        if touchscreen_present
        else [{"name": "AT Translated Set 2 keyboard", "type": "keyboard"}]
    )
    install_swaymsg_shim(sandbox)
    write_sway_state(sandbox, focused="1:hub", kiosk_mode=kiosk_mode, inputs=inputs)


def test_verify_surface_rejects_non_linux(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_bash_shim("uname", "echo Darwin\n")

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "verify-surface.sh")
    assert result.returncode == 1
    assert "must be run on Linux" in result.stderr


def test_verify_surface_passing_checks_under_mocked_linux(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    _install_verify_linux_shims(sandbox)

    (sandbox.home / "Surface_assistant").mkdir(parents=True)
    runner = (
        sandbox.home
        / ".local"
        / "share"
        / "surface-assistant"
        / "scripts"
        / "run-kiosk-browser.sh"
    )
    runner.parent.mkdir(parents=True)
    runner.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    runner.chmod(0o755)
    (sandbox.runtime_dir / "sway-ipc.1000.sock").write_text("", encoding="utf-8")

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "verify-surface.sh")

    for expected_pass in (
        "[PASS] linux-surface kernel active (6.14.0-surface)",
        "[PASS] Intel VA-API available",
        "[PASS] User 'surface-test' belongs to 'video' group",
        "[PASS] PipeWire virtual sink active: alarm-sink",
        "[PASS] PipeWire virtual sink active: tts-sink",
        "[PASS] PipeWire virtual sink active: media-sink",
        "[PASS] surface-daemon.service is active",
        "[PASS] Daemon /api/health responded",
        "[PASS] surface-wyoming-satellite.service is active",
        "[PASS] brave-browser installed",
        "[PASS] stremio installed",
        "[PASS] Stremio Flatpak installed (com.stremio.Stremio)",
        "[PASS] Docker Compose available",
        "[PASS] Repository path exists",
        "[PASS] systemd user linger enabled",
        "[PASS] Kiosk browser launcher installed and executable",
        "[PASS] Sway compositor IPC active",
        "[PASS] Brave kiosk window (surface-kiosk) running on native Wayland (xdg_shell)",
        "[PASS] IPTSD Virtual Touchscreen registered in Sway",
        "[PASS] waybar overlay process is running",
        "[PASS] iptsd templated touch service is active",
    ):
        assert expected_pass in result.stdout

    assert "[WARN]" not in result.stdout
    fail_lines = [line for line in result.stdout.splitlines() if line.startswith("[FAIL]")]
    # On non-Surface hosts (macOS/CI), only hardcoded /sys hardware checks may fail.
    for fail_line in fail_lines:
        assert "No ALS device found" in fail_line or "Backlight device missing" in fail_line
    assert "Summary:" in result.stdout
    if not Path("/sys/class/backlight/intel_backlight/brightness").exists():
        assert result.returncode == 1
    else:
        assert result.returncode == 0


def test_verify_surface_failing_and_warning_checks_under_mocked_linux(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    _install_verify_linux_shims(
        sandbox,
        kernel_rel="6.8.0-generic",
        vainfo_ok=False,
        groups="surface-test",
        sinks_out="1\talarm-sink\n2\ttts-sink\n",
        daemon_active=False,
        wyoming_active=False,
        iptsd_active=False,
        curl_ok=False,
        stremio_flatpak_wrapper=True,
        flatpak_ok=False,
        docker_ok=False,
        linger="Linger=no",
        kiosk_mode="class",
        touchscreen_present=False,
        waybar_running=False,
    )

    runner = (
        sandbox.home
        / ".local"
        / "share"
        / "surface-assistant"
        / "scripts"
        / "run-kiosk-browser.sh"
    )
    runner.parent.mkdir(parents=True)
    runner.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    runner.chmod(0o644)  # Present, but intentionally NOT executable.
    (sandbox.runtime_dir / "sway-ipc.1000.sock").write_text("", encoding="utf-8")

    result = sandbox.run(SYSTEM_SCRIPTS_DIR / "verify-surface.sh")
    assert result.returncode == 1

    for expected_line in (
        "[FAIL] Expected -surface kernel, found '6.8.0-generic'",
        "[FAIL] vainfo failed to query VA-API device",
        "[FAIL] User 'surface-test' does NOT belong to 'video' group",
        "[FAIL] PipeWire virtual sink missing: media-sink",
        "[FAIL] surface-daemon.service is NOT active",
        "[FAIL] Daemon /api/health unreachable",
        "[FAIL] stremio uses Flatpak, but 'flatpak info com.stremio.Stremio' failed",
        "[FAIL] docker compose is unavailable",
        "[FAIL] IPTSD Virtual Touchscreen missing from Sway inputs",
        "[WARN] surface-wyoming-satellite.service is not active",
        "[WARN] systemd user linger is not enabled",
        "but is not executable",
        "[WARN] Brave kiosk window detected, but not on native Wayland app_id (XWayland fallback)",
        "[WARN] waybar is not running",
        "[WARN] iptsd@*.service is not active",
    ):
        assert expected_line in result.stdout

    # Removing run-kiosk-browser.sh triggers the missing launcher warning.
    runner.unlink()
    missing_res = sandbox.run(SYSTEM_SCRIPTS_DIR / "verify-surface.sh")
    assert missing_res.returncode == 1
    assert "[WARN] Kiosk browser launcher missing at" in missing_res.stdout


# ---------------------------------------------------------------------------
# setup-kiosk-autologin.sh & system/setup-surface.sh guards/CLI
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "script_path",
    [
        SYSTEM_SCRIPTS_DIR / "setup-kiosk-autologin.sh",
        REPO_ROOT / "system" / "setup-surface.sh",
    ],
    ids=lambda p: p.name,
)
def test_setup_scripts_guards_and_cli(tmp_path: Path, script_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)

    sandbox.install_bash_shim("uname", "echo Darwin\n")
    non_linux = sandbox.run(script_path, ["--help"])
    assert non_linux.returncode == 1
    assert "must be run on Linux" in non_linux.stderr or "Ubuntu" in non_linux.stderr

    sandbox.install_bash_shim("uname", "echo Linux\n")
    sandbox.install_bash_shim("id", "echo 0\n")
    as_root = sandbox.run(script_path, ["--help"])
    assert as_root.returncode == 1
    assert "regular user" in as_root.stderr

    sandbox.install_bash_shim("id", "echo 1000\n")
    help_res = sandbox.run(script_path, ["--help"])
    assert help_res.returncode == 0
    assert "Usage:" in help_res.stdout

    bad_res = sandbox.run(script_path, ["--bogus"])
    assert bad_res.returncode == 1
    assert "Unknown option: --bogus" in bad_res.stderr


# ---------------------------------------------------------------------------
# deploy-surface.sh & sync-wallpapers.sh
# ---------------------------------------------------------------------------


def test_deploy_surface_help_and_unknown_option(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_recorder("ssh", exit_code=99)
    sandbox.install_recorder("rsync", exit_code=99)

    help_res = sandbox.run(SCRIPTS_DIR / "deploy-surface.sh", ["--help"])
    assert help_res.returncode == 0
    assert "Usage: ./scripts/deploy-surface.sh [OPTIONS]" in help_res.stdout
    for opt in ("--sync-system", "--sync-wallpapers", "--restart", "--dry-run", "SURFACE_USER"):
        assert opt in help_res.stdout

    bad_res = sandbox.run(SCRIPTS_DIR / "deploy-surface.sh", ["--unknown-flag"])
    assert bad_res.returncode == 1
    assert "Error: Unknown option '--unknown-flag'" in bad_res.stderr
    assert sandbox.read_calls("ssh") == []
    assert sandbox.read_calls("rsync") == []


def test_deploy_surface_dry_run_never_runs_ssh_and_passes_dry_run_to_rsync(
    tmp_path: Path,
) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_recorder("ssh", exit_code=99)
    sandbox.install_recorder("rsync", exit_code=0)

    basic_res = sandbox.run(SCRIPTS_DIR / "deploy-surface.sh", ["--dry-run"])
    assert basic_res.returncode == 0, basic_res.stderr
    assert sandbox.read_calls("ssh") == []
    assert (
        '[dry-run] Would ensure remote directory: ssh time-master@192.168.0.100 '
        'mkdir -p "$HOME"/Surface_assistant'
    ) in basic_res.stdout

    rsync_calls = sandbox.read_calls("rsync")
    assert len(rsync_calls) == 1
    argv = rsync_calls[0]
    assert "--dry-run" in argv
    assert "--delete" in argv
    assert "--exclude=.git/" in argv
    assert argv[-1] == "time-master@192.168.0.100:Surface_assistant/"

    full_res = sandbox.run(
        SCRIPTS_DIR / "deploy-surface.sh",
        ["--dry-run", "--sync-system", "--sync-wallpapers", "--restart"],
        extra_env={
            "SURFACE_USER": "kiosk",
            "SURFACE_HOST": "10.0.0.5",
            "SURFACE_DIR": "~/custom/surface/",
        },
    )
    assert full_res.returncode == 0, full_res.stderr
    assert sandbox.read_calls("ssh") == []
    assert "[dry-run] Would sync system configs/units on kiosk@10.0.0.5" in full_res.stdout
    assert "[dry-run] Would ensure remote directories: ssh kiosk@10.0.0.5" in full_res.stdout
    assert (
        "[dry-run] Would refresh running daemon wallpaper index via POST /api/wallpapers/refresh"
        in full_res.stdout
    )
    assert (
        "[dry-run] Would run over SSH: ssh kiosk@10.0.0.5 "
        "'systemctl --user restart surface-daemon.service'"
    ) in full_res.stdout
    assert "Deploy complete." in full_res.stdout

    all_rsync = sandbox.read_calls("rsync")
    assert len(all_rsync) >= 2
    assert all("--dry-run" in call for call in all_rsync)
    assert all_rsync[1][-1] == "kiosk@10.0.0.5:custom/surface/"


def test_deploy_surface_executes_ssh_and_rsync_when_not_dry_run(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_recorder("ssh", exit_code=0)
    sandbox.install_recorder("rsync", exit_code=0)

    result = sandbox.run(
        SCRIPTS_DIR / "deploy-surface.sh",
        ["--sync-system", "--restart"],
        extra_env={
            "SURFACE_USER": "kiosk",
            "SURFACE_HOST": "10.0.0.7",
            "SURFACE_DIR": "~/Surface_assistant",
        },
    )
    assert result.returncode == 0, result.stderr

    ssh_calls = sandbox.read_calls("ssh")
    assert len(ssh_calls) == 3
    assert ssh_calls[0] == ["kiosk@10.0.0.7", 'mkdir -p "$HOME"/Surface_assistant']
    assert ssh_calls[1][0] == "kiosk@10.0.0.7"
    assert 'cp "$REPO_DIR/system/sway/config"' in ssh_calls[1][1]
    assert 'chmod +x "$DATA_DIR/pipewire-rules/init-sinks.sh"' in ssh_calls[1][1]
    assert ssh_calls[2] == ["kiosk@10.0.0.7", "systemctl --user restart surface-daemon.service"]

    rsync_calls = sandbox.read_calls("rsync")
    assert len(rsync_calls) == 1
    assert "--dry-run" not in rsync_calls[0]


def test_sync_wallpapers_help_dry_run_and_minimalistic_extract(tmp_path: Path) -> None:
    sandbox = ScriptSandbox(tmp_path)
    sandbox.install_recorder("ssh", exit_code=0)
    sandbox.install_recorder("rsync", exit_code=0)

    help_res = sandbox.run(SCRIPTS_DIR / "sync-wallpapers.sh", ["--help"])
    assert help_res.returncode == 0
    assert "--with-minimalistic" in help_res.stdout

    bad_res = sandbox.run(SCRIPTS_DIR / "sync-wallpapers.sh", ["--bad"])
    assert bad_res.returncode == 1
    assert "Error: Unknown option '--bad'" in bad_res.stderr

    dry_res = sandbox.run(
        SCRIPTS_DIR / "sync-wallpapers.sh",
        ["--dry-run", "--with-minimalistic"],
    )
    assert dry_res.returncode == 0, dry_res.stderr
    assert "[dry-run] Would download" in dry_res.stdout
    assert sandbox.read_calls("ssh") == []
    dry_rsync_count = len(sandbox.read_calls("rsync"))
    if (REPO_ROOT / "wallpapers").is_dir():
        assert dry_rsync_count == 1
        assert "--dry-run" in sandbox.read_calls("rsync")[0]
    else:
        assert dry_rsync_count == 0

    # Build a tiny tar.gz archive in tmp_path and serve it from the mocked curl shim.
    archive_path = sandbox.state_dir / "minimalistic.tar.gz"
    sample_img = sandbox.state_dir / "night.png"
    sample_img.write_bytes(b"\x89PNG\r\n\x1a\n")
    readme = sandbox.state_dir / "README.md"
    readme.write_text("ignore me", encoding="utf-8")
    with tarfile.open(archive_path, "w:gz") as tf:
        tf.add(sample_img, arcname="minimalistic-main/images/night.png")
        tf.add(readme, arcname="minimalistic-main/README.md")

    sandbox.install_python_shim(
        "curl",
        f"""
        import shutil
        import sys
        from pathlib import Path

        args = sys.argv[1:]
        out_idx = args.index("-o") + 1
        shutil.copyfile({str(archive_path)!r}, Path(args[out_idx]))
        """,
    )

    extract_res = sandbox.run(SCRIPTS_DIR / "sync-wallpapers.sh", ["--only-minimalistic"])
    assert extract_res.returncode == 0, extract_res.stderr
    assert "Extracted 1 minimalistic wallpapers." in extract_res.stdout
    new_rsync_calls = sandbox.read_calls("rsync")[dry_rsync_count:]
    assert len(new_rsync_calls) == 1
    assert new_rsync_calls[0][-1] == "time-master@192.168.0.100:wallpapers/static/"
    ssh_calls = sandbox.read_calls("ssh")
    assert len(ssh_calls) == 2
    assert "/api/wallpapers/refresh" in ssh_calls[1][1]
