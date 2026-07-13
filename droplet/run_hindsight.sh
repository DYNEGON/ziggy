#!/bin/bash
cd /home/hindsight
export HINDSIGHT_API_HOST=127.0.0.1
export HINDSIGHT_API_LLM_PROVIDER=litellm
export HINDSIGHT_API_LLM_MODEL="mistral/mistral-small-2506"
export MISTRAL_API_KEY="YOUR_MISTRAL_API_KEY_HERE"
export HINDSIGHT_API_EMBEDDINGS_PROVIDER=google
export HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"
export HINDSIGHT_API_RERANKER_PROVIDER=rrf
export HOME=/home/hindsight
exec setpriv --reuid=hindsight --regid=hindsight --init-groups hindsight-api
