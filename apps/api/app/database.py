from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


connect_args = (
    {"check_same_thread": False}
    if settings.database_url.startswith("sqlite")
    else {}
)
engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_job_timing_columns()
    _ensure_job_idempotency_column()
    _ensure_canvas_tables()
    _ensure_project_home_columns()


def _ensure_job_timing_columns() -> None:
    """无 alembic 的轻量迁移：为既有库补充 jobs.started_at / finished_at（C2）。"""
    if settings.database_url.startswith("sqlite"):
        with engine.begin() as conn:
            existing = {
                row[1] for row in conn.exec_driver_sql("PRAGMA table_info(jobs)")
            }
            for column in ("started_at", "finished_at"):
                if column not in existing:
                    conn.exec_driver_sql(
                        f"ALTER TABLE jobs ADD COLUMN {column} DATETIME"
                    )
    else:
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ"
            )
            conn.exec_driver_sql(
                "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ"
            )


def _ensure_job_idempotency_column() -> None:
    """无 alembic 的轻量迁移：为既有库补充 jobs.idempotency_key（C5）。"""
    if settings.database_url.startswith("sqlite"):
        with engine.begin() as conn:
            existing = {
                row[1] for row in conn.exec_driver_sql("PRAGMA table_info(jobs)")
            }
            if "idempotency_key" not in existing:
                conn.exec_driver_sql(
                    "ALTER TABLE jobs ADD COLUMN idempotency_key VARCHAR(64)"
                )
            conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ix_jobs_idempotency_key ON jobs (idempotency_key)"
            )
    else:
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "
                "idempotency_key VARCHAR(64)"
            )
            conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ix_jobs_idempotency_key ON jobs (idempotency_key)"
            )


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _ensure_project_home_columns() -> None:
    """W6-1：projects 表补充 design_prompt / cover_url / updated_at。"""
    columns = (
        ("design_prompt", "TEXT", "TEXT"),
        ("cover_url", "VARCHAR(500)", "VARCHAR(500)"),
        ("updated_at", "DATETIME", "TIMESTAMPTZ"),
    )
    if settings.database_url.startswith("sqlite"):
        with engine.begin() as conn:
            existing = {
                row[1] for row in conn.exec_driver_sql("PRAGMA table_info(projects)")
            }
            for name, sqlite_type, _pg_type in columns:
                if name not in existing:
                    conn.exec_driver_sql(
                        f"ALTER TABLE projects ADD COLUMN {name} {sqlite_type}"
                    )
    else:
        with engine.begin() as conn:
            for name, _sqlite_type, pg_type in columns:
                conn.exec_driver_sql(
                    f"ALTER TABLE projects ADD COLUMN IF NOT EXISTS {name} {pg_type}"
                )


def _ensure_canvas_tables() -> None:
    """无 alembic 的轻量迁移：为既有库补充 canvases / canvas_nodes 表（W0-d）。"""
    if settings.database_url.startswith("sqlite"):
        with engine.begin() as conn:
            existing = {
                row[1] for row in conn.exec_driver_sql("PRAGMA table_info(canvases)")
            }
            if not existing:
                conn.exec_driver_sql(
                    "CREATE TABLE canvases ("
                    "id VARCHAR(40) PRIMARY KEY, "
                    "project_id VARCHAR(40) NOT NULL, "
                    "name VARCHAR(120) NOT NULL, "
                    "viewport_json TEXT DEFAULT '{}', "
                    "updated_at DATETIME, "
                    "deleted_at DATETIME"
                    ")"
                )
                conn.exec_driver_sql(
                    "CREATE INDEX ix_canvases_project_id ON canvases (project_id)"
                )
            existing_nodes = {
                row[1] for row in conn.exec_driver_sql("PRAGMA table_info(canvas_nodes)")
            }
            if not existing_nodes:
                conn.exec_driver_sql(
                    "CREATE TABLE canvas_nodes ("
                    "id VARCHAR(40) PRIMARY KEY, "
                    "canvas_id VARCHAR(40) NOT NULL, "
                    "asset_id VARCHAR(40), "
                    "variant_id VARCHAR(160), "
                    "job_id VARCHAR(40), "
                    "x FLOAT DEFAULT 0.0, "
                    "y FLOAT DEFAULT 0.0, "
                    "w FLOAT DEFAULT 0.0, "
                    "h FLOAT DEFAULT 0.0, "
                    "z INTEGER DEFAULT 0, "
                    "source_node_id VARCHAR(40), "
                    "created_at DATETIME, "
                    "updated_at DATETIME, "
                    "deleted_at DATETIME"
                    ")"
                )
                conn.exec_driver_sql(
                    "CREATE INDEX ix_canvas_nodes_canvas_id ON canvas_nodes (canvas_id)"
                )
    else:
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS canvases ("
                "id VARCHAR(40) PRIMARY KEY, "
                "project_id VARCHAR(40) NOT NULL, "
                "name VARCHAR(120) NOT NULL, "
                "viewport_json JSONB DEFAULT '{}', "
                "updated_at TIMESTAMPTZ, "
                "deleted_at TIMESTAMPTZ"
                ")"
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_canvases_project_id ON canvases (project_id)"
            )
            conn.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS canvas_nodes ("
                "id VARCHAR(40) PRIMARY KEY, "
                "canvas_id VARCHAR(40) NOT NULL, "
                "asset_id VARCHAR(40), "
                "variant_id VARCHAR(160), "
                "job_id VARCHAR(40), "
                "x FLOAT DEFAULT 0.0, "
                "y FLOAT DEFAULT 0.0, "
                "w FLOAT DEFAULT 0.0, "
                "h FLOAT DEFAULT 0.0, "
                "z INTEGER DEFAULT 0, "
                "source_node_id VARCHAR(40), "
                "created_at TIMESTAMPTZ, "
                "updated_at TIMESTAMPTZ, "
                "deleted_at TIMESTAMPTZ"
                ")"
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_canvas_nodes_canvas_id ON canvas_nodes (canvas_id)"
            )
