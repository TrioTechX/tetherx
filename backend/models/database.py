"""SQLAlchemy async engine + session factory for Supabase PostgreSQL."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from config.settings import get_settings

_engine: AsyncEngine | None = None


def _build_async_url(sync_url: str) -> str:
    """Convert a Postgres URL to SQLAlchemy async psycopg format."""
    if sync_url.startswith("postgresql://"):
        return sync_url.replace("postgresql://", "postgresql+psycopg://", 1)
    if sync_url.startswith("postgres://"):
        return sync_url.replace("postgres://", "postgresql+psycopg://", 1)
    return sync_url


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        url = _build_async_url(settings.supabase_db_url)
        _engine = create_async_engine(
            url,
            pool_size=5,
            max_overflow=10,
            pool_timeout=30,
            pool_recycle=1800,
            echo=False,
        )
    return _engine


AsyncSessionLocal = sessionmaker(  # type: ignore[call-overload]
    bind=None,  # bound lazily in get_db()
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncSession:  # type: ignore[return]
    """FastAPI dependency — yields an async DB session."""
    engine = get_engine()
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session
