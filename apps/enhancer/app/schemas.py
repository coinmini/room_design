from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class APIModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class ControlImages(APIModel):
    base: str = Field(min_length=32)
    reference: str | None = None
    edge: str | None = None
    depth: str | None = None
    normal: str | None = None
    semantic: str | None = None


class EnhanceRequest(APIModel):
    version: Literal["1.0"] = "1.0"
    prompt: str = Field(min_length=1, max_length=4000)
    negativePrompt: str = Field(default="", max_length=4000)
    strength: float = Field(default=0.32, ge=0.05, le=1.0)
    images: ControlImages
    seed: int | None = Field(default=None, ge=0, le=18_446_744_073_709_551_615)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0.1, le=30.0)


class EnhanceResponse(APIModel):
    imageBase64: str
    provider: str
    modelRevision: str
    seed: int
    mode: str = "sdxl-img2img"
    generationWidth: int
    generationHeight: int
    controlImage: str | None = None
    controlModel: str | None = None
    refinerCheckpoint: str | None = None
    ipAdapterModel: str | None = None
    styleReference: str | None = None
