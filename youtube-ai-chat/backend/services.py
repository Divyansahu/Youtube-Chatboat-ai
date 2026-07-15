import json
import re
from youtube_transcript_api import YouTubeTranscriptApi
from supadata import SupadataError
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_huggingface import HuggingFaceEndpoint, ChatHuggingFace
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnableParallel, RunnableLambda, RunnablePassthrough
from langchain_classic.retrievers import MultiQueryRetriever

from config import logger, supadata_client, HF_TOKEN

# ── Helper: Robust JSON Parser ────────────────────────────────────────────────
def clean_and_parse_json(text: str):
    text_to_parse = text.strip()
    
    # Try to extract content inside markdown blocks
    match = re.search(r'```(?:json)?\s*(.*?)\s*```', text_to_parse, re.DOTALL)
    if match:
        text_to_parse = match.group(1).strip()
        
    # If it still has markdown indicators, strip them
    if text_to_parse.startswith("```json"):
        text_to_parse = text_to_parse[7:]
    if text_to_parse.startswith("```"):
        text_to_parse = text_to_parse[3:]
    if text_to_parse.endswith("```"):
        text_to_parse = text_to_parse[:-3]
    text_to_parse = text_to_parse.strip()
    
    try:
        return json.loads(text_to_parse)
    except Exception as e:
        logger.warning(f"Standard JSON parsing failed: {e}. Trying bracket search...")
        # Fallback: Find first '[' and last ']'
        start = text_to_parse.find('[')
        end = text_to_parse.rfind(']')
        if start != -1 and end != -1 and end > start:
            json_substr = text_to_parse[start:end+1]
            try:
                return json.loads(json_substr)
            except Exception as e2:
                logger.error(f"Bracket JSON parsing failed: {e2}")
        raise ValueError(f"Failed to parse LLM response as JSON: {text[:200]}...")

# ── Helper: Fetch YouTube Transcript ──────────────────────────────────────────
def fetch_transcript_content(video_id: str) -> str:
    """
    Retrieves the YouTube transcript.
    Attempts to use the free youtube_transcript_api first, and falls back to Supadata if it fails.
    """
    logger.info(f"[{video_id}] Fetching transcript...")
    try:
        api = YouTubeTranscriptApi()
        transcript_list = api.list(video_id)
        try:
            # Try to find English transcript first (manual or auto-generated)
            srt = transcript_list.find_transcript(['en'])
        except Exception:
            # Fall back to the first available language transcript
            srt = next(iter(transcript_list))
        
        transcript_data = srt.fetch()
        
        grouped_lines = []
        current_interval = -1
        current_block_text = []
        
        for t in transcript_data:
            start_sec = int(t.start)
            interval_idx = start_sec // 30
            
            if interval_idx != current_interval:
                if current_block_text:
                    block_sec = current_interval * 30
                    minutes = block_sec // 60
                    seconds = block_sec % 60
                    timestamp_str = f"[{minutes:02d}:{seconds:02d}]"
                    block_content = " ".join(current_block_text)
                    grouped_lines.append(f"{timestamp_str} {block_content}")
                current_interval = interval_idx
                current_block_text = [t.text]
            else:
                current_block_text.append(t.text)
                
        if current_block_text:
            block_sec = current_interval * 30
            minutes = block_sec // 60
            seconds = block_sec % 60
            timestamp_str = f"[{minutes:02d}:{seconds:02d}]"
            block_content = " ".join(current_block_text)
            grouped_lines.append(f"{timestamp_str} {block_content}")
            
        transcript = "\n".join(grouped_lines)
        if transcript and transcript.strip():
            logger.info(f"[{video_id}] Successfully retrieved transcript with timestamps using youtube_transcript_api.")
            return transcript
    except Exception as yt_err:
        logger.warning(f"[{video_id}] youtube_transcript_api failed: {yt_err}. Trying Supadata fallback…")

    # Fallback to Supadata
    try:
        transcript = supadata_client.youtube.transcript(
            video_id=video_id,
            text=True
        ).content
        if transcript and transcript.strip():
            logger.info(f"[{video_id}] Successfully retrieved transcript using Supadata.")
            return transcript
    except SupadataError as e:
        raise ValueError(f"Supadata could not fetch transcript: {e}")
    except Exception as e:
        raise ValueError(f"Unexpected error fetching transcript from Supadata: {e}")

    raise ValueError("Transcript is empty – video may not have captions.")

# ── Core: build the RAG chain for a video ─────────────────────────────────────
def build_chain_for_video(video_id: str) -> dict:
    """
    1. Fetch transcript (youtube_transcript_api with Supadata fallback)
    2. Split into chunks (RecursiveCharacterTextSplitter)
    3. Embed with local Hugging Face Model + store in FAISS
    4. Build RAG chain powered by Serverless Hugging Face Llama 3.1
    """
    # Step 1 — Fetch transcript
    transcript = fetch_transcript_content(video_id)

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
    hf_endpoint = HuggingFaceEndpoint(
        repo_id="meta-llama/Llama-3.1-8B-Instruct",
        task="conversational",
        huggingfacehub_api_token=HF_TOKEN,
        temperature=0.3,
    )
    
    llm = ChatHuggingFace(llm=hf_endpoint)

    # Standard retriever
    multiquery_retriever = MultiQueryRetriever.from_llm(
        retriever=vector_store.as_retriever(search_kwargs={"k": 3}),
        llm=llm
    )

    # Step 5 — Prompt
    prompt = PromptTemplate(
        template="""<|begin_of_text|><|start_header_id|>system<|end_header_id|>
You are a highly capable YouTube Video Assistant.
Your task is to answer the user's question relying strictly on the provided transcript context from the video.

Rules:
1. Answer the question using ONLY the facts and details directly mentioned in the Context. Do not assume or extrapolate.
2. If the context does not contain the answer, reply with: "I'm sorry, but that information is not available in the video transcript."
3. Keep your answers concise, clear, and structured (using bullet points or bold text for readability where helpful).
4. Ignore any transcript noise like "[music]", "[laughter]", or typos; focus on the actual content and meaning.
5. Answer in the same language as the user's question, if possible, based on the context.<|eot_id|>
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
        "chunk_count": len(chunks),
        "transcript": transcript
    }
