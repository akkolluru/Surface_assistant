"""Conversation agent delegating local intents to HA and trivia to the Surface daemon."""

from __future__ import annotations

import logging
from typing import Literal

import aiohttp
from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import aiohttp_client, intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DOMAIN

_LOGGER = logging.getLogger(__name__)
DAEMON_KNOWLEDGE_URL = "http://127.0.0.1:8000/api/knowledge/query"


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Register the Surface Knowledge conversation entity."""
    async_add_entities([SurfaceKnowledgeAgent(hass, config_entry)])


class SurfaceKnowledgeAgent(conversation.ConversationEntity):
    """Tries HA native intents first; falls back to Wikipedia/DDG/Open-Meteo daemon endpoint."""

    _attr_has_entity_name = True
    _attr_name = "Surface Knowledge Assistant"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        return ["en"]

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Process a voice query via HA default intents, then daemon knowledge fallback."""
        default_agent = conversation.get_agent(self.hass)
        if default_agent is not None and default_agent is not self:
            ha_result = await default_agent.async_process(user_input)
            if ha_result.response.response_type != intent.IntentResponseType.ERROR:
                return ha_result

        answer = await self._query_daemon_knowledge(user_input.text)
        response = intent.IntentResponse(language=user_input.language)
        if answer:
            response.async_set_speech(answer)
        else:
            response.async_set_error(
                intent.IntentResponseErrorCode.NO_INTENT_MATCH,
                "Sorry, I couldn't find an answer for that.",
            )
        return conversation.ConversationResult(
            response=response,
            conversation_id=user_input.conversation_id,
        )

    async def _query_daemon_knowledge(self, query: str) -> str | None:
        session = aiohttp_client.async_get_clientsession(self.hass)
        try:
            async with session.post(
                DAEMON_KNOWLEDGE_URL,
                json={"query": query},
                timeout=aiohttp.ClientTimeout(total=6),
            ) as resp:
                if resp.status != 200:
                    return None
                payload = await resp.json()
                answer = payload.get("answer")
                return answer if isinstance(answer, str) and answer.strip() else None
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.warning("Knowledge daemon fallback failed: %s", err)
            return None
