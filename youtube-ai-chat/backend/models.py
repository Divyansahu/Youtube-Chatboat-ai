from typing import List, Optional, TypedDict
from pydantic import BaseModel

# ── Pydantic models ───────────────────────────────────────────────────────────
class ProcessVideoRequest(BaseModel):
    video_id: str

class AskRequest(BaseModel):
    video_id: str
    question: str

class ProcessVideoResponse(BaseModel):
    success: bool
    video_id: str
    message: str
    chunk_count: Optional[int] = None

class AskResponse(BaseModel):
    answer: str
    video_id: str

class PipelineRequest(BaseModel):
    video_id: str
    force_regenerate: Optional[bool] = False

class SummaryResponse(BaseModel):
    success: bool
    video_id: str
    summary: str

class QuizQuestion(BaseModel):
    question: str
    options: List[str]
    answer: int

class QuizResponse(BaseModel):
    success: bool
    video_id: str
    quiz: List[QuizQuestion]

class RoadmapStep(BaseModel):
    step: int
    title: str
    description: str
    timestamp: Optional[str] = None
    checkpoints: List[str]

class RoadmapResponse(BaseModel):
    success: bool
    video_id: str
    roadmap: List[RoadmapStep]

# ── LangGraph Pipeline State ──────────────────────────────────────────────────
class PipelineState(TypedDict):
    video_id: str
    transcript: str
    target: str
    summary: Optional[str]
    quiz: Optional[List[dict]]
    roadmap: Optional[List[dict]]
