from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class Plugin:
    kind: str
    name: str
    handler: Callable[..., Any]
    config_schema: dict[str, Any]


class PluginRegistry:
    def __init__(self) -> None:
        self._plugins: dict[tuple[str, str], Plugin] = {}

    def register_condition(self, name: str, handler: Callable[..., Any], config_schema: dict[str, Any] | None = None) -> Plugin:
        return self.register("condition", name, handler, config_schema or {})

    def register_action(self, name: str, handler: Callable[..., Any], config_schema: dict[str, Any] | None = None) -> Plugin:
        return self.register("action", name, handler, config_schema or {})

    def register_formula_function(self, name: str, handler: Callable[..., Any], config_schema: dict[str, Any] | None = None) -> Plugin:
        return self.register("formula_function", name, handler, config_schema or {})

    def register_connector(self, name: str, handler: Callable[..., Any], config_schema: dict[str, Any] | None = None) -> Plugin:
        return self.register("connector", name, handler, config_schema or {})

    def register(self, kind: str, name: str, handler: Callable[..., Any], config_schema: dict[str, Any]) -> Plugin:
        key = (kind, name)
        if key in self._plugins:
            raise ValueError(f"plugin already registered: {kind}.{name}")
        plugin = Plugin(kind=kind, name=name, handler=handler, config_schema=config_schema)
        self._plugins[key] = plugin
        return plugin

    def get(self, kind: str, name: str) -> Plugin:
        try:
            return self._plugins[(kind, name)]
        except KeyError as exc:
            raise LookupError(f"plugin not found: {kind}.{name}") from exc

    def list(self, kind: str | None = None) -> list[Plugin]:
        plugins = list(self._plugins.values())
        if kind:
            return [plugin for plugin in plugins if plugin.kind == kind]
        return plugins
