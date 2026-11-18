"""Validation tests for Home Assistant YAML configs, intents, and surface_knowledge component."""

from __future__ import annotations

import importlib
import json
import sys
import types
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

import pytest
import yaml

from daemon.config import REPO_ROOT, EnvSettings, load_config
from daemon.main import build_runtime, create_app

HA_DIR = REPO_ROOT / "homeassistant"
COMPONENT_DIR = HA_DIR / "custom_components" / "surface_knowledge"


@dataclass(frozen=True)
class _HaTag:
    """Placeholder representing a Home Assistant YAML tag (!include, !secret, etc.)."""

    tag: str
    value: Any


class _HaYamlLoader(yaml.SafeLoader):
    """YAML SafeLoader supporting Home Assistant custom tags."""


def _ha_tag_constructor(loader: yaml.SafeLoader, node: yaml.Node) -> _HaTag:
    if isinstance(node, yaml.ScalarNode):
        return _HaTag(node.tag, loader.construct_scalar(node))
    if isinstance(node, yaml.SequenceNode):
        return _HaTag(node.tag, loader.construct_sequence(node))
    if isinstance(node, yaml.MappingNode):
        return _HaTag(node.tag, loader.construct_mapping(node))
    return _HaTag(node.tag, None)


for _tag in (
    "!include",
    "!secret",
    "!env_var",
    "!include_dir_list",
    "!include_dir_named",
    "!include_dir_merge_list",
    "!include_dir_merge_named",
):
    _HaYamlLoader.add_constructor(_tag, _ha_tag_constructor)


def _load_ha_yaml(path: Path) -> Any:
    return yaml.load(path.read_text(encoding="utf-8"), Loader=_HaYamlLoader)


def _install_ha_stubs(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Install minimal in-memory stubs for homeassistant.* and aiohttp in sys.modules."""
    state: dict[str, Any] = {"default_agent": None, "session": None}

    aiohttp_mod = types.ModuleType("aiohttp")

    class ClientError(Exception):
        pass

    class ClientTimeout:
        def __init__(self, total: float | None = None) -> None:
            self.total = total

    aiohttp_mod.ClientError = ClientError  # type: ignore[attr-defined]
    aiohttp_mod.ClientTimeout = ClientTimeout  # type: ignore[attr-defined]

    ha_const = types.ModuleType("homeassistant.const")

    class Platform(StrEnum):
        CONVERSATION = "conversation"

    ha_const.Platform = Platform  # type: ignore[attr-defined]

    ha_core = types.ModuleType("homeassistant.core")

    class HomeAssistant:
        def __init__(self) -> None:
            self.forwarded: list[tuple[Any, list[Any]]] = []
            self.unloaded: list[tuple[Any, list[Any]]] = []
            self.config_entries = self

        async def async_forward_entry_setups(self, entry: Any, platforms: list[Any]) -> None:
            self.forwarded.append((entry, list(platforms)))

        async def async_unload_platforms(self, entry: Any, platforms: list[Any]) -> bool:
            self.unloaded.append((entry, list(platforms)))
            return True

    ha_core.HomeAssistant = HomeAssistant  # type: ignore[attr-defined]

    ha_config_entries = types.ModuleType("homeassistant.config_entries")

    class ConfigEntry:
        def __init__(self, entry_id: str = "entry-1") -> None:
            self.entry_id = entry_id

    class ConfigFlow:
        domain: str = ""
        _entries: list[Any] = []

        def __init_subclass__(cls, domain: str = "", **kwargs: Any) -> None:
            super().__init_subclass__(**kwargs)
            cls.domain = domain

        def _async_current_entries(self) -> list[Any]:
            return list(self._entries)

        def async_abort(self, *, reason: str) -> dict[str, Any]:
            return {"type": "abort", "reason": reason}

        def async_create_entry(self, *, title: str, data: dict[str, Any]) -> dict[str, Any]:
            return {"type": "create_entry", "title": title, "data": data}

        def async_show_form(self, *, step_id: str) -> dict[str, Any]:
            return {"type": "form", "step_id": step_id}

    ha_config_entries.ConfigEntry = ConfigEntry  # type: ignore[attr-defined]
    ha_config_entries.ConfigFlow = ConfigFlow  # type: ignore[attr-defined]
    ha_config_entries.ConfigFlowResult = dict  # type: ignore[attr-defined]

    ha_helpers = types.ModuleType("homeassistant.helpers")
    ha_aiohttp = types.ModuleType("homeassistant.helpers.aiohttp_client")
    ha_aiohttp.async_get_clientsession = lambda hass: state["session"]  # type: ignore[attr-defined]

    ha_entity_platform = types.ModuleType("homeassistant.helpers.entity_platform")
    ha_entity_platform.AddEntitiesCallback = Any  # type: ignore[attr-defined]

    ha_intent = types.ModuleType("homeassistant.helpers.intent")

    class IntentResponseType(StrEnum):
        ACTION_DONE = "action_done"
        ERROR = "error"

    class IntentResponseErrorCode(StrEnum):
        NO_INTENT_MATCH = "no_intent_match"

    class IntentResponse:
        def __init__(self, language: str = "en") -> None:
            self.language = language
            self.response_type = IntentResponseType.ACTION_DONE
            self.speech: dict[str, Any] = {}
            self.error_code: IntentResponseErrorCode | None = None
            self.error_message: str | None = None

        def async_set_speech(self, speech: str) -> None:
            self.speech = {"plain": {"speech": speech}}

        def async_set_error(self, code: IntentResponseErrorCode, message: str) -> None:
            self.response_type = IntentResponseType.ERROR
            self.error_code = code
            self.error_message = message

    ha_intent.IntentResponseType = IntentResponseType  # type: ignore[attr-defined]
    ha_intent.IntentResponseErrorCode = IntentResponseErrorCode  # type: ignore[attr-defined]
    ha_intent.IntentResponse = IntentResponse  # type: ignore[attr-defined]

    ha_components = types.ModuleType("homeassistant.components")
    ha_conv = types.ModuleType("homeassistant.components.conversation")

    class ConversationEntity:
        pass

    @dataclass
    class ConversationInput:
        text: str
        language: str = "en"
        conversation_id: str | None = None

    @dataclass
    class ConversationResult:
        response: Any
        conversation_id: str | None = None

    ha_conv.ConversationEntity = ConversationEntity  # type: ignore[attr-defined]
    ha_conv.ConversationInput = ConversationInput  # type: ignore[attr-defined]
    ha_conv.ConversationResult = ConversationResult  # type: ignore[attr-defined]
    ha_conv.get_agent = lambda hass: state["default_agent"]  # type: ignore[attr-defined]

    stubs: dict[str, types.ModuleType] = {
        "aiohttp": aiohttp_mod,
        "homeassistant.const": ha_const,
        "homeassistant.core": ha_core,
        "homeassistant.config_entries": ha_config_entries,
        "homeassistant.helpers": ha_helpers,
        "homeassistant.helpers.aiohttp_client": ha_aiohttp,
        "homeassistant.helpers.entity_platform": ha_entity_platform,
        "homeassistant.helpers.intent": ha_intent,
        "homeassistant.components": ha_components,
        "homeassistant.components.conversation": ha_conv,
    }
    for name, mod in stubs.items():
        monkeypatch.setitem(sys.modules, name, mod)
    for mod_name in list(sys.modules):
        if mod_name.startswith("homeassistant.custom_components.surface_knowledge"):
            monkeypatch.delitem(sys.modules, mod_name, raising=False)
    return state


def test_homeassistant_yaml_configs_and_daemon_route_alignment(tmp_path: Path) -> None:
    cfg = _load_ha_yaml(HA_DIR / "configuration.yaml")
    assert isinstance(cfg, dict)
    assert cfg["homeassistant"]["name"] == "Surface Bedside Hub"
    assert cfg["homeassistant"]["time_zone"] == "Asia/Kolkata"
    assert cfg["intent_script"] == _HaTag("!include", "intent_script.yaml")
    assert cfg["scene"] == _HaTag("!include", "scenes.yaml")
    assert (HA_DIR / "intent_script.yaml").is_file()
    assert (HA_DIR / "scenes.yaml").is_file()

    # Every rest_command points to a real daemon FastAPI route
    env = EnvSettings(hardware_backend="mock", wallpapers_dir=str(tmp_path))
    app = create_app(
        build_runtime(load_config(env_settings=env)),
        enable_background_tasks=False,
    )
    daemon_paths = {getattr(route, "path", "") for route in app.routes}
    rest_commands = cfg["rest_command"]
    assert isinstance(rest_commands, dict) and len(rest_commands) == 7
    for cmd_cfg in rest_commands.values():
        url = cmd_cfg["url"]
        assert url.startswith("http://127.0.0.1:8000")
        assert url.removeprefix("http://127.0.0.1:8000") in daemon_paths

    # Scenes reference defined helper entities
    scenes = _load_ha_yaml(HA_DIR / "scenes.yaml")
    assert isinstance(scenes, list) and len(scenes) == 3
    defined_entities = {
        f"{domain}.{entity_id}"
        for domain in ("input_boolean", "input_number", "input_select")
        for entity_id in cfg[domain]
    }
    for scene in scenes:
        assert scene["id"] and scene["name"]
        for entity_id in scene["entities"]:
            assert entity_id in defined_entities

    # Intent scripts and custom sentences match 1:1 and match configured media tiles
    intent_scripts = _load_ha_yaml(HA_DIR / "intent_script.yaml")
    sentences = _load_ha_yaml(HA_DIR / "custom_sentences" / "en" / "surface_assistant.yaml")
    assert sentences["language"] == "en"
    assert set(sentences["intents"].keys()) == set(intent_scripts.keys())

    for intent_name, spec in intent_scripts.items():
        assert sentences["intents"][intent_name]["data"]
        for action in spec["action"]:
            service = action["service"]
            assert service.startswith("rest_command.")
            assert service.removeprefix("rest_command.") in rest_commands

    example_cfg = load_config(config_path=REPO_ROOT / "config.example.yaml")
    tile_ids = {tile.id for tile in example_cfg.yaml_cfg.launcher.tiles}
    for item in sentences["lists"]["app"]["values"]:
        assert item["out"] in tile_ids


def test_surface_knowledge_manifest_json() -> None:
    manifest = json.loads((COMPONENT_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["domain"] == "surface_knowledge"
    assert manifest["config_flow"] is True
    assert "conversation" in manifest["dependencies"]
    assert isinstance(manifest["version"], str) and manifest["version"]


@pytest.mark.asyncio
async def test_surface_knowledge_init_and_config_flow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_ha_stubs(monkeypatch)
    init_mod = importlib.import_module("homeassistant.custom_components.surface_knowledge")
    flow_mod = importlib.import_module(
        "homeassistant.custom_components.surface_knowledge.config_flow"
    )
    ha_core = sys.modules["homeassistant.core"]
    ha_config_entries = sys.modules["homeassistant.config_entries"]
    ha_const = sys.modules["homeassistant.const"]

    hass = ha_core.HomeAssistant()
    entry = ha_config_entries.ConfigEntry("entry-42")
    assert await init_mod.async_setup_entry(hass, entry) is True
    assert hass.forwarded == [(entry, [ha_const.Platform.CONVERSATION])]
    assert await init_mod.async_unload_entry(hass, entry) is True
    assert hass.unloaded == [(entry, [ha_const.Platform.CONVERSATION])]

    flow = flow_mod.SurfaceKnowledgeConfigFlow()
    assert flow.domain == "surface_knowledge"
    assert (await flow.async_step_user(None))["type"] == "form"
    created = await flow.async_step_user({})
    assert created == {
        "type": "create_entry",
        "title": "Surface Knowledge Fallback",
        "data": {},
    }

    flow._entries = [entry]
    aborted = await flow.async_step_user({})
    assert aborted == {"type": "abort", "reason": "single_instance_allowed"}


@pytest.mark.asyncio
async def test_surface_knowledge_conversation_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _install_ha_stubs(monkeypatch)
    conv_mod = importlib.import_module(
        "homeassistant.custom_components.surface_knowledge.conversation"
    )
    ha_core = sys.modules["homeassistant.core"]
    ha_config_entries = sys.modules["homeassistant.config_entries"]
    ha_conv = sys.modules["homeassistant.components.conversation"]
    ha_intent = sys.modules["homeassistant.helpers.intent"]
    aiohttp_mod = sys.modules["aiohttp"]

    hass = ha_core.HomeAssistant()
    entry = ha_config_entries.ConfigEntry("entry-kb")

    registered: list[Any] = []
    await conv_mod.async_setup_entry(hass, entry, lambda entities: registered.extend(entities))
    assert len(registered) == 1
    agent = registered[0]
    assert agent.supported_languages == ["en"]

    # 1. Native HA default agent handles intent -> daemon is NOT queried
    class FakeResponseCtx:
        def __init__(self, status: int, payload: dict[str, Any]) -> None:
            self.status = status
            self._payload = payload

        async def __aenter__(self) -> FakeResponseCtx:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def json(self) -> dict[str, Any]:
            return self._payload

    class FakeSession:
        def __init__(self) -> None:
            self.posts: list[tuple[str, dict[str, Any]]] = []
            self.status = 200
            self.payload: dict[str, Any] = {"answer": "Jupiter has 95 moons."}
            self.raise_err: Exception | None = None

        def post(self, url: str, *, json: dict[str, Any], timeout: Any) -> FakeResponseCtx:
            self.posts.append((url, json))
            if self.raise_err is not None:
                raise self.raise_err
            return FakeResponseCtx(self.status, self.payload)

    session = FakeSession()
    state["session"] = session

    class NativeAgent:
        def __init__(self, succeed: bool) -> None:
            self.succeed = succeed

        async def async_process(self, user_input: Any) -> Any:
            resp = ha_intent.IntentResponse(user_input.language)
            if self.succeed:
                resp.async_set_speech("Turned on bedroom lamp.")
            else:
                resp.async_set_error(ha_intent.IntentResponseErrorCode.NO_INTENT_MATCH, "no match")
            return ha_conv.ConversationResult(
                response=resp,
                conversation_id=user_input.conversation_id,
            )

    state["default_agent"] = NativeAgent(succeed=True)
    native_res = await agent.async_process(
        ha_conv.ConversationInput(text="turn on bedside lamp", conversation_id="c1")
    )
    assert native_res.response.speech["plain"]["speech"] == "Turned on bedroom lamp."
    assert session.posts == []

    # 2. Native HA misses -> falls back to Surface daemon knowledge endpoint
    state["default_agent"] = NativeAgent(succeed=False)
    daemon_res = await agent.async_process(
        ha_conv.ConversationInput(text="How many moons does Jupiter have?", conversation_id="c2")
    )
    assert session.posts == [
        (
            "http://127.0.0.1:8000/api/knowledge/query",
            {"query": "How many moons does Jupiter have?"},
        )
    ]
    assert daemon_res.response.speech["plain"]["speech"] == "Jupiter has 95 moons."
    assert daemon_res.conversation_id == "c2"

    # 3. Daemon non-200 or ClientError / TimeoutError returns NO_INTENT_MATCH cleanly
    session.status = 500
    err_res = await agent.async_process(ha_conv.ConversationInput(text="Unknown"))
    assert err_res.response.response_type == ha_intent.IntentResponseType.ERROR
    assert err_res.response.error_code == ha_intent.IntentResponseErrorCode.NO_INTENT_MATCH

    session.status = 200
    session.raise_err = aiohttp_mod.ClientError("connection refused")
    net_res = await agent.async_process(ha_conv.ConversationInput(text="Unknown"))
    assert net_res.response.response_type == ha_intent.IntentResponseType.ERROR
    assert net_res.response.error_code == ha_intent.IntentResponseErrorCode.NO_INTENT_MATCH
