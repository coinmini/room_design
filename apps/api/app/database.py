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


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

