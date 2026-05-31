"""
backend.py — FastAPI server for YouTube AI Chat Chrome Extension
================================================================
Wraps your FAISS + LangChain notebook logic into REST endpoints.

UPDATES:
1. Uses Local Hugging Face Embeddings (all-MiniLM-L6-v2)
2. Uses Serverless Hugging Face LLM (Llama-3.1-8B-Instruct) for 429-free chatting
"""

from dotenv import load_dotenv
load_dotenv()

import os
import time
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# LangChain / HuggingFace imports
from supadata import Supadata, SupadataError
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings 
from langchain_huggingface import HuggingFaceEndpoint, ChatHuggingFace
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnableParallel, RunnableLambda, RunnablePassthrough
from langchain_classic.retrievers import MultiQueryRetriever

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("yt-ai-backend")

# ── API Keys ──────────────────────────────────────────────────────────────────
HF_TOKEN = os.environ.get("HF_TOKEN", "YOUR_HF_TOKEN")
SUPADATA_API_KEY = os.environ.get("SUPADATA_API_KEY", "YOUR_SUPADATA_API_KEY")

# ── In-memory store ───────────────────────────────────────────────────────────
video_store: dict = {}

# ── Supadata client ───────────────────────────────────────────────────────────
supadata_client = Supadata(api_key=SUPADATA_API_KEY)


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


# ── Core: build the RAG chain for a video ─────────────────────────────────────
def build_chain_for_video(video_id: str) -> dict:
    """
    1. Fetch transcript via Supadata
    2. Split into chunks (RecursiveCharacterTextSplitter)
    3. Embed with local Hugging Face Model + store in FAISS
    4. Build RAG chain powered by Serverless Hugging Face Llama 3.1
    """
    logger.info(f"[{video_id}] Fetching transcript…")

    # Step 1 — Fetch transcript
    try:
        transcript = supadata_client.youtube.transcript(
            video_id=video_id,
            text=True
        ).content
    except SupadataError as e:
        raise ValueError(f"Supadata could not fetch transcript: {e}")

    if not transcript or not transcript.strip():
        raise ValueError("Transcript is empty – video may not have captions.")

    logger.info(f"[{video_id}] Transcript fetched ({len(transcript)} chars). Chunking…")

    # Step 2 — Split
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=150,
        separators=["\n\n", "\n", ". ", " ", ""]
    )
    chunks = splitter.create_documents([transcript])
    logger.info(f"[{video_id}] {len(chunks)} chunks created. Building FAISS…")

    # Step 3 — Embed + FAISS (Runs 100% locally on CPU without rate limits)
    embeddings = HuggingFaceEmbeddings(
        model_name="sentence-transformers/all-MiniLM-L6-v2",
        model_kwargs={'device': 'cpu'}
    )
    
    vector_store = FAISS.from_documents(chunks, embeddings)
    logger.info(f"[{video_id}] FAISS index ready with HuggingFace embeddings.")

    # Step 4 — SWAPPED: Serverless Hugging Face LLM Client (Bypasses Gemini 429)
    # Using provider="auto" automatically selects the fastest cloud hardware cluster available
    hf_endpoint = HuggingFaceEndpoint(
        repo_id="meta-llama/Llama-3.1-8B-Instruct",
        task="text-generation",
        huggingfacehub_api_token=HF_TOKEN,
        temperature=0.3,
        # provider="auto" 
    )
    
    # Wrap it cleanly so it matches LangChain's chat structures perfectly
    llm = ChatHuggingFace(llm=hf_endpoint)

    # Standard optimized retriever (Avoids extra MultiQuery LLM calls to save requests)
    multiquery_retriever = MultiQueryRetriever.from_llm(
        retriever=vector_store.as_retriever(search_kwargs={"k": 3}),
        llm=llm
    )

    # Step 5 — Prompt
    prompt = PromptTemplate(
        template="""<|begin_of_text|><|start_header_id|>system<|end_header_id|>
        You are a helpful assistant.
        Answer ONLY from the provided transcript context.
        If the context is insufficient, just say you don't know.<|eot_id|>
        <|start_header_id|>user<|end_header_id|>
        Context:
        {context}

        Question: {question}<|eot_id|>
        <|start_header_id|>assistant<|end_header_id|>""",
        input_variables=["context", "question"]
    )

    # Step 6 — Chain assembly
    def format_docs(retrieved_docs):
        return "\n\n".join(doc.page_content for doc in retrieved_docs)

    parallel_chain = RunnableParallel({
        "context": multiquery_retriever | RunnableLambda(format_docs),
        "question": RunnablePassthrough()
    })

    parser = StrOutputParser()
    main_chain = parallel_chain | prompt | llm | parser

    return {
        "chain": main_chain,
        "chunk_count": len(chunks)
    }


# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="YouTube AI Chat Backend",
    description="Hugging Face + FAISS RAG backend for the YouTube AI Chat Chrome Extension",
    version="1.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def health():
    return {
        "status": "ok",
        "service": "YouTube AI Chat Backend",
        "indexed_videos": list(video_store.keys())
    }


@app.post("/process-video", response_model=ProcessVideoResponse)
async def process_video(body: ProcessVideoRequest):
    video_id = body.video_id.strip()

    if not video_id:
        raise HTTPException(status_code=400, detail="video_id is required")

    if video_id in video_store:
        logger.info(f"[{video_id}] Already indexed. Skipping.")
        return ProcessVideoResponse(
            success=True,
            video_id=video_id,
            message="Already processed",
            chunk_count=video_store[video_id].get("chunk_count")
        )

    try:
        result = build_chain_for_video(video_id)
        video_store[video_id] = result
        logger.info(f"[{video_id}] ✅ Ready. {result['chunk_count']} chunks indexed.")
        return ProcessVideoResponse(
            success=True,
            video_id=video_id,
            message="Video processed and indexed successfully",
            chunk_count=result["chunk_count"]
        )
    except ValueError as e:
        logger.error(f"[{video_id}] ❌ {e}")
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"[{video_id}] ❌ Unexpected error: {e}")
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")


@app.post("/ask", response_model=AskResponse)
async def ask(body: AskRequest):
    video_id = body.video_id.strip()
    question = body.question.strip()

    if not video_id:
        raise HTTPException(status_code=400, detail="video_id is required")
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    if video_id not in video_store:
        logger.info(f"[{video_id}] Not indexed yet – indexing on demand…")
        try:
            result = build_chain_for_video(video_id)
            video_store[video_id] = result
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")

    chain = video_store[video_id]["chain"]

    try:
        logger.info(f"[{video_id}] Invoking chain with: '{question}'")
        answer = chain.invoke(question)
        logger.info(f"[{video_id}] ✅ Answer generated.")
        return AskResponse(answer=answer, video_id=video_id)
    except Exception as e:
        logger.error(f"[{video_id}] Chain error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate answer: {str(e)}")


@app.delete("/video/{video_id}")
async def clear_video(video_id: str):
    if video_id in video_store:
        del video_store[video_id]
        return {"success": True, "message": f"Cleared {video_id}"}
    return {"success": False, "message": "Video not found in store"}