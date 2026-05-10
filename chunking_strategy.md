# Chunking Strategy: Recursive Character Text Splitting

## Overview
In this RAG application, we use the `RecursiveCharacterTextSplitter` from LangChain to process user-uploaded documents (PDFs and TXTs) before storing their embeddings into the Qdrant vector database.

## Configuration
- **Chunk Size:** 1000 characters
- **Chunk Overlap:** 200 characters
- **Separators:** `["\n\n", "\n", ".", " ", ""]`

## Rationale
1. **Context Preservation:** The recursive character splitter attempts to split the text using the largest separators first (like double newlines `\n\n` representing paragraph breaks). If a paragraph is larger than the chunk size, it moves to the next separator (`\n`, then `.`, then spaces). This ensures that semantically related text (e.g., sentences within a paragraph) stays together as much as possible, rather than being arbitrarily cut mid-sentence.
2. **Chunk Size (1000):** A chunk size of 1000 characters provides a good balance. It's large enough to capture meaningful context for a single thought or idea, but small enough to ensure the embedding captures specific details rather than becoming a diluted "average" of many unrelated topics.
3. **Overlap (200):** We use an overlap of 200 characters between consecutive chunks. This is crucial for preventing the loss of context that might occur at the boundaries of chunks. If an important concept or sentence spans across the boundary of where the text was split, the overlap ensures that both chunks contain that contextual bridge, improving retrieval accuracy.

This strategy ensures that the generated embeddings represent well-formed, coherent pieces of information, directly improving the LLM's ability to provide grounded and accurate answers.
