from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
from pydantic import field_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    supabase_db_url: str
    supabase_url: str
    supabase_service_role_key: str

    aes_master_key: str  # 64-char hex string → 32 bytes
    hmac_secret: str

    bloom_filter_size: int = 10_000
    bloom_hash_count: int = 7
    threat_match_threshold: int = 2

    jwt_secret: str = "change-me-in-production-sentinel-jwt-secret"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24  # 24 hours

    # Cookie settings for HttpOnly session cookie
    # Set COOKIE_SECURE=false in .env when running over plain HTTP (local dev)
    cookie_secure: bool = True
    cookie_same_site: str = "strict"  # "strict" | "lax" | "none"

    @field_validator("aes_master_key")
    @classmethod
    def validate_aes_master_key(cls, v: str) -> str:
        key = v.strip()
        if len(key) != 64:
            raise ValueError("AES_MASTER_KEY must be a 64-char hex string (32 bytes).")
        try:
            bytes.fromhex(key)
        except ValueError as exc:
            raise ValueError("AES_MASTER_KEY must contain only hexadecimal characters.") from exc
        return key

    @field_validator("hmac_secret")
    @classmethod
    def validate_hmac_secret(cls, v: str) -> str:
        secret = v.strip()
        if not secret or "replace-me" in secret.lower():
            raise ValueError("HMAC_SECRET is missing or still a placeholder.")
        return secret


@lru_cache
def get_settings() -> Settings:
    return Settings()
