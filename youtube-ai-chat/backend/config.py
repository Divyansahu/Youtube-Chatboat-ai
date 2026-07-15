import os
import logging
from dotenv import load_dotenv
from supadata import Supadata
from langchain_huggingface import HuggingFaceEndpoint, ChatHuggingFace

# Load environment variables from .env
load_dotenv()

# Initialize logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("yt-ai-backend")

# API Keys
HF_TOKEN = os.environ.get("HF_TOKEN", "YOUR_HF_TOKEN")
SUPADATA_API_KEY = os.environ.get("SUPADATA_API_KEY", "YOUR_SUPADATA_API_KEY")

# In-memory vector/chain store
video_store: dict = {}

# Clients
supadata_client = Supadata(api_key=SUPADATA_API_KEY)

global_hf_endpoint = HuggingFaceEndpoint(
    repo_id="meta-llama/Llama-3.1-8B-Instruct",
    task="text-generation",
    huggingfacehub_api_token=HF_TOKEN,
    temperature=0.3,
    max_new_tokens=2048,
)
global_llm = ChatHuggingFace(llm=global_hf_endpoint)
