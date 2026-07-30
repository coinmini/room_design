from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


API_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    app_name: str = "AI 室内设计 MVP"
    api_prefix: str = "/v1"
    database_url: str = f"sqlite:///{WORKSPACE_ROOT / '.local' / 'room_design.db'}"
    artifact_dir: Path = WORKSPACE_ROOT / ".local" / "artifacts"
    blender_bin: str = "/Applications/Blender.app/Contents/MacOS/Blender"
    blender_enabled: bool = True
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"

    model_config = SettingsConfigDict(
        env_file=API_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


settings = Settings()
settings.artifact_dir.mkdir(parents=True, exist_ok=True)
Path(settings.database_url.removeprefix("sqlite:///")).parent.mkdir(
    parents=True,
    exist_ok=True,
) if settings.database_url.startswith("sqlite:///") else None

