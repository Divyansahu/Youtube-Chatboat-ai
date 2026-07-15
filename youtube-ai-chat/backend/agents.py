from langgraph.graph import StateGraph, END

from config import logger, global_llm
from models import PipelineState
from prompts import SUMMARY_PROMPT, QUIZ_PROMPT, ROADMAP_PROMPT
from services import clean_and_parse_json

# ── LangGraph Pipeline Nodes ──────────────────────────────────────────────────
def summarizer_node(state: PipelineState) -> dict:
    video_id = state["video_id"]
    if state.get("summary"):
        logger.info(f"[{video_id}] LangGraph summarizer: Summary already exists. Skipping.")
        return {}

    transcript = state.get("transcript", "")
    if not transcript:
        raise ValueError("Transcript is missing in state.")

    logger.info(f"[{video_id}] LangGraph summarizer: Generating summary...")
    # Token Optimization: Cap grouped transcript at 40,000 characters (approx 8,500 tokens)
    prompt_content = SUMMARY_PROMPT.format(transcript=transcript[:40000])
    summary = global_llm.invoke(prompt_content).content.strip()
    return {"summary": summary}


def quiz_node(state: PipelineState) -> dict:
    video_id = state["video_id"]
    if state.get("quiz"):
        logger.info(f"[{video_id}] LangGraph quiz: Quiz already exists. Skipping.")
        return {}

    summary = state.get("summary")
    if not summary:
        raise ValueError("Summary is missing in state.")

    logger.info(f"[{video_id}] LangGraph quiz: Generating quiz...")
    prompt_content = QUIZ_PROMPT.format(summary=summary)
    raw_response = global_llm.invoke(prompt_content).content
    quiz_data = clean_and_parse_json(raw_response)
    if not isinstance(quiz_data, list):
        raise ValueError("Quiz response is not a JSON list")
    return {"quiz": quiz_data}


def roadmap_node(state: PipelineState) -> dict:
    video_id = state["video_id"]
    if state.get("roadmap"):
        logger.info(f"[{video_id}] LangGraph roadmap: Roadmap already exists. Skipping.")
        return {}

    summary = state.get("summary")
    if not summary:
        raise ValueError("Summary is missing in state.")

    logger.info(f"[{video_id}] LangGraph roadmap: Generating roadmap...")
    prompt_content = ROADMAP_PROMPT.format(summary=summary)
    raw_response = global_llm.invoke(prompt_content).content
    roadmap_data = clean_and_parse_json(raw_response)
    if not isinstance(roadmap_data, list):
        raise ValueError("Roadmap response is not a JSON list")
    return {"roadmap": roadmap_data}


# ── LangGraph Workflow Configuration ──────────────────────────────────────────
def route_after_summary(state: PipelineState):
    if state.get("target") == "summary":
        return END
    return "quiz"


def route_after_quiz(state: PipelineState):
    if state.get("target") == "quiz":
        return END
    return "roadmap"


workflow = StateGraph(PipelineState)

# Add nodes
workflow.add_node("summarizer", summarizer_node)
workflow.add_node("quiz", quiz_node)
workflow.add_node("roadmap", roadmap_node)

# Set starting point
workflow.set_entry_point("summarizer")

# Set conditional edges
workflow.add_conditional_edges(
    "summarizer",
    route_after_summary,
    {
        END: END,
        "quiz": "quiz"
    }
)
workflow.add_conditional_edges(
    "quiz",
    route_after_quiz,
    {
        END: END,
        "roadmap": "roadmap"
    }
)
workflow.add_edge("roadmap", END)

app_graph = workflow.compile()
