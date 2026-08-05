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
    floorplan_ai_endpoint: str = ""
    floorplan_ai_health_endpoint: str = ""
    floorplan_ai_token: str = ""
    floorplan_ai_timeout_seconds: int = 900
    floorplan_ai_probe_timeout_seconds: float = 1.5
    floorplan_vision_provider: str = "kuyao"
    floorplan_vision_cache_dir: Path = WORKSPACE_ROOT / ".local" / "vision-cache"
    kuyao_api_key: str = ""
    openai_api_key: str = ""
    kuyao_base_url: str = "https://www.kuyaoapi.com/v1"
    kuyao_vision_model: str = "gpt-5.6-sol"
    kuyao_vision_timeout_seconds: int = 300
    floorplan_final_image_provider: str = "auto"
    kuyao_image_model: str = "gpt-image-2"
    kuyao_image_quality: str = "high"
    kuyao_image_timeout_seconds: int = 300
    provider_concurrency: int = 4
    kuyao_style_reference_image: str = ""
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    # 公网演示鉴权：同时配置用户名+密码后启用；本地空着则不拦
    auth_username: str = ""
    auth_password: str = ""
    auth_secret: str = ""
    auth_token_ttl_hours: float = 72.0

    model_config = SettingsConfigDict(
        env_file=API_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        origins = [
            item.strip() for item in self.cors_origins.split(",") if item.strip()
        ]
        # 拒绝 *：配合 allow_credentials 会静默回显任意 Origin
        return [o for o in origins if o != "*"]

    @property
    def floorplan_vision_api_key(self) -> str:
        """Prefer the provider-specific secret while keeping OpenAI-compatible fallback."""
        return self.kuyao_api_key.strip() or self.openai_api_key.strip()

    @property
    def floorplan_vision_configured(self) -> bool:
        provider = self.floorplan_vision_provider.strip().lower()
        return bool(
            provider not in {"", "local", "none", "disabled", "off"}
            and self.kuyao_base_url.strip()
            and self.kuyao_vision_model.strip()
            and self.floorplan_vision_api_key
        )

    @property
    def kuyao_image_edit_configured(self) -> bool:
        provider = self.floorplan_final_image_provider.strip().lower()
        return bool(
            provider in {"auto", "kuyao"}
            and self.floorplan_vision_api_key
            and self.kuyao_base_url.strip()
            and self.kuyao_image_model.strip()
        )


settings = Settings()
settings.artifact_dir.mkdir(parents=True, exist_ok=True)
settings.floorplan_vision_cache_dir.mkdir(parents=True, exist_ok=True)
Path(settings.database_url.removeprefix("sqlite:///")).parent.mkdir(
    parents=True,
    exist_ok=True,
) if settings.database_url.startswith("sqlite:///") else None
