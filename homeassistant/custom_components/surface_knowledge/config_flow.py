"""Minimal zero-option config flow for Surface Knowledge Fallback."""

from __future__ import annotations

from typing import Any

from homeassistant import config_entries

from . import DOMAIN


class SurfaceKnowledgeConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Surface Knowledge Fallback."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Create the single integration entry."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title="Surface Knowledge Fallback", data={})
        return self.async_show_form(step_id="user")
