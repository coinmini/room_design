from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(
        String(40),
        primary_key=True,
        default=lambda: new_id("project"),
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
    )


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(
        String(40),
        primary_key=True,
        default=lambda: new_id("job"),
    )
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id"),
        nullable=True,
    )
    parent_job_id: Mapped[str | None] = mapped_column(
        ForeignKey("jobs.id"),
        nullable=True,
    )
    type: Mapped[str] = mapped_column(String(48))
    status: Mapped[str] = mapped_column(String(24), default="QUEUED")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # C5：建任务幂等键——前端每次用户提交生成一个 UUID，网络重试复用同一键；
    # 冲突时 create_job 返回既有 job，丢失的响应不会再静默启动第二个批次
    idempotency_key: Mapped[str | None] = mapped_column(
        String(64),
        unique=True,
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )


class SceneAsset(Base):
    __tablename__ = "scene_assets"

    id: Mapped[str] = mapped_column(
        String(40),
        primary_key=True,
        default=lambda: new_id("asset"),
    )
    owner_id: Mapped[str] = mapped_column(String(80), index=True)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id"),
        nullable=True,
        index=True,
    )
    job_id: Mapped[str] = mapped_column(
        ForeignKey("jobs.id"),
        unique=True,
        index=True,
    )
    parent_asset_id: Mapped[str | None] = mapped_column(
        ForeignKey("scene_assets.id"),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(160))
    generation_mode: Mapped[str] = mapped_column(String(32), index=True)
    asset_type: Mapped[str] = mapped_column(String(48))
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    deliverables: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        index=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )
