"""Free ($0) Open-Meteo weather client and Wikipedia/DuckDuckGo trivia fallback."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from urllib.parse import quote

import httpx

from daemon.models import KnowledgeQueryResponse, WeatherState

_LOGGER = logging.getLogger(__name__)

_WMO_LABELS: dict[int, str] = {
    0: "Clear",
    1: "Mainly Clear",
    2: "Partly Cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime Fog",
    51: "Light Drizzle",
    53: "Drizzle",
    55: "Dense Drizzle",
    61: "Light Rain",
    63: "Rain",
    65: "Heavy Rain",
    71: "Light Snow",
    80: "Rain Showers",
    95: "Thunderstorm",
}

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def wmo_code_to_label(code: int) -> str:
    return _WMO_LABELS.get(code, "Mixed Sky")


def _trim_for_speech(text: str, max_sentences: int = 2) -> str:
    cleaned = " ".join(text.split())
    parts = _SENTENCE_SPLIT.split(cleaned)
    return " ".join(parts[:max_sentences]).strip()


class KnowledgeService:
    """Async client for Open-Meteo, Wikipedia REST API, and DuckDuckGo Instant Answer."""

    def __init__(
        self,
        lat: float,
        lon: float,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._lat = lat
        self._lon = lon
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(4.5),
            headers={"User-Agent": "SurfaceAssistant/1.0 (local bedside hub)"},
        )

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def fetch_weather(self) -> WeatherState | None:
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={self._lat}&longitude={self._lon}"
            "&current=temperature_2m,weather_code"
        )
        try:
            resp = await self._client.get(url)
            resp.raise_for_status()
            data = resp.json()
            current = data.get("current", {})
            temp_c = float(current["temperature_2m"])
            code = int(current["weather_code"])
            return WeatherState(
                temperature_c=round(temp_c, 1),
                condition_code=code,
                condition_label=wmo_code_to_label(code),
                updated_at=datetime.now(UTC).isoformat(),
            )
        except (httpx.HTTPError, KeyError, ValueError, TypeError) as err:
            _LOGGER.warning("Open-Meteo weather fetch failed: %s", err)
            return None

    async def answer_query(self, query: str) -> KnowledgeQueryResponse:
        cleaned = query.strip()
        if not cleaned:
            return KnowledgeQueryResponse(source="none", answer=None)

        if "weather" in cleaned.lower():
            weather = await self.fetch_weather()
            if weather is not None:
                return KnowledgeQueryResponse(
                    source="open_meteo",
                    answer=(
                        f"It is currently {round(weather.temperature_c)} degrees Celsius "
                        f"and {weather.condition_label.lower()}."
                    ),
                )

        wiki = await self._query_wikipedia(cleaned)
        if wiki:
            return KnowledgeQueryResponse(source="wikipedia", answer=wiki)

        ddg = await self._query_duckduckgo(cleaned)
        if ddg:
            return KnowledgeQueryResponse(source="duckduckgo", answer=ddg)

        return KnowledgeQueryResponse(source="none", answer=None)

    async def _query_wikipedia(self, query: str) -> str | None:
        try:
            search_resp = await self._client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "opensearch",
                    "search": query,
                    "limit": 1,
                    "namespace": 0,
                    "format": "json",
                },
            )
            search_resp.raise_for_status()
            payload = search_resp.json()
            titles = payload[1] if isinstance(payload, list) and len(payload) > 1 else []
            if not titles:
                return None

            title = str(titles[0]).replace(" ", "_")
            summary_resp = await self._client.get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(title)}"
            )
            if summary_resp.status_code != 200:
                return None
            summary_data = summary_resp.json()
            extract = summary_data.get("extract")
            if isinstance(extract, str) and extract.strip():
                return _trim_for_speech(extract)
        except (httpx.HTTPError, ValueError, TypeError) as err:
            _LOGGER.debug("Wikipedia lookup failed: %s", err)
        return None

    async def _query_duckduckgo(self, query: str) -> str | None:
        try:
            resp = await self._client.get(
                "https://api.duckduckgo.com/",
                params={
                    "q": query,
                    "format": "json",
                    "no_html": 1,
                    "skip_disambig": 1,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            for field in ("Answer", "AbstractText", "Definition"):
                val = data.get(field)
                if isinstance(val, str) and val.strip():
                    return _trim_for_speech(val)
        except (httpx.HTTPError, ValueError, TypeError) as err:
            _LOGGER.debug("DuckDuckGo lookup failed: %s", err)
        return None
