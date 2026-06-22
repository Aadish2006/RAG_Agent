import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers';

// Cache for the reranker model to prevent loading on every request
let rerankerTokenizer = null;
let rerankerModel = null;

/**
 * Load and cache the BGE Reranker model
 */
async function getReranker() {
    if (!rerankerTokenizer || !rerankerModel) {
        console.log("Loading BAAI/bge-reranker-base locally...");
        rerankerTokenizer = await AutoTokenizer.from_pretrained('Xenova/bge-reranker-base');
        rerankerModel = await AutoModelForSequenceClassification.from_pretrained('Xenova/bge-reranker-base', {
            quantized: true // Use 8-bit quantized model for speed and memory efficiency
        });
        console.log("✅ BAAI/bge-reranker-base loaded successfully");
    }
    return { tokenizer: rerankerTokenizer, model: rerankerModel };
}

/**
 * Splits text into sections based on headers/patterns
 */
export function splitIntoSections(text) {
    const lines = text.split(/\r?\n/);
    const sections = [];
    let currentSectionTitle = "Introduction";
    let currentSectionLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            currentSectionLines.push(line);
            continue;
        }

        // Header pattern matchers
        const isMarkdownHeader = trimmed.startsWith('#');
        const isNumberedHeader = /^\d+(\.\d+)*\s+[A-Z]/.test(trimmed);
        const isNamedHeader = /^(Chapter|Section|Part|Appendix|Table of Contents|References)\b/i.test(trimmed);

        if (isMarkdownHeader || isNumberedHeader || isNamedHeader) {
            // Save previous section if it has content
            if (currentSectionLines.join("\n").trim()) {
                sections.push({
                    title: currentSectionTitle,
                    content: currentSectionLines.join("\n")
                });
            }
            currentSectionTitle = trimmed.replace(/^#+\s+/, '');
            currentSectionLines = [line];
        } else {
            currentSectionLines.push(line);
        }
    }

    // Save final section
    if (currentSectionLines.join("\n").trim()) {
        sections.push({
            title: currentSectionTitle,
            content: currentSectionLines.join("\n")
        });
    }

    return sections;
}

/**
 * Splits documents into Parent (~2000 chars) and Child (~500 chars) chunks,
 * mapping child chunks back to their parent text, sections, and source pages.
 */
export async function parentChildSplit(docs, originalName) {
    // 1. Build cumulative page boundaries
    let cumulativeLength = 0;
    const pageRanges = docs.map((doc, idx) => {
        const start = cumulativeLength;
        const length = doc.pageContent.length;
        cumulativeLength += length + 1; // +1 for newline join
        return {
            pageNumber: doc.metadata.loc?.pageNumber || (idx + 1),
            start,
            end: cumulativeLength
        };
    });

    const fullText = docs.map(d => d.pageContent).join("\n");

    // 2. Identify sections
    const sections = splitIntoSections(fullText);

    // 3. Setup text splitters
    const parentSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 2000,
        chunkOverlap: 400,
    });

    const childSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 500,
        chunkOverlap: 100,
    });

    const childDocs = [];
    let parentCounter = 0;

    for (const section of sections) {
        // Split section content into parent chunks
        const parentTexts = await parentSplitter.splitText(section.content);

        for (const parentText of parentTexts) {
            const parentId = `parent-${parentCounter++}`;
            const parentStartIdx = fullText.indexOf(parentText);

            // Locate starting page for this parent chunk
            const pageObj = pageRanges.find(r => parentStartIdx >= r.start && parentStartIdx < r.end) || pageRanges[0];
            const pageNumber = pageObj ? pageObj.pageNumber : 1;

            // Split parent text into child chunks
            const childTexts = await childSplitter.splitText(parentText);

            for (const childText of childTexts) {
                childDocs.push(new Document({
                    pageContent: childText,
                    metadata: {
                        source: originalName,
                        pageNumber: pageNumber,
                        section: section.title,
                        parentText: parentText,
                        parentId: parentId
                    }
                }));
            }
        }
    }

    return childDocs;
}

/**
 * Expand user query into 3 alternative search variations using Gemini
 */
export async function queryExpansion(query, googleApiKey) {
    try {
        const model = new ChatGoogleGenerativeAI({
            apiKey: googleApiKey,
            model: "gemini-2.5-flash",
            temperature: 0.3,
        });

        const prompt = `You are a search query optimizer. Given the user's question, generate exactly 3 alternative search queries optimized for search retrieval (combination of semantic and keyword/BM25). 
Provide the queries in a raw JSON string array format. Do not include markdown tags, formatting, or extra text.

User Question: ${query}

JSON Output:`;

        const response = await model.invoke(prompt);
        let cleanedContent = response.content.trim();

        // Strip markdown backticks if present
        if (cleanedContent.startsWith("```")) {
            cleanedContent = cleanedContent.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }

        const expanded = JSON.parse(cleanedContent);
        if (Array.isArray(expanded) && expanded.length > 0) {
            return expanded;
        }
        return [];
    } catch (e) {
        console.warn("⚠️ Query expansion failed, falling back to original query:", e.message);
        return [];
    }
}

/**
 * Reranks retrieved documents against the original query using local BGE Reranker
 */
export async function rerank(query, documents, topK = 5) {
    if (documents.length === 0) return [];
    try {
        const { tokenizer, model } = await getReranker();
        const pairs = documents.map(doc => [query, doc.pageContent]);

        const inputs = await tokenizer(pairs, {
            padding: true,
            truncation: true,
            return_tensors: 'pt'
        });

        const { logits } = await model(inputs);
        const scores = logits.data;

        const scoredDocs = documents.map((doc, idx) => ({
            doc,
            score: scores[idx]
        }));

        // Sort descending
        scoredDocs.sort((a, b) => b.score - a.score);

        // Deduplicate based on parentId (if parent exists) or pageContent
        const seen = new Set();
        const deduplicated = [];
        for (const sd of scoredDocs) {
            const dupId = sd.doc.metadata.parentId || sd.doc.pageContent;
            if (!seen.has(dupId)) {
                seen.add(dupId);
                deduplicated.push(sd.doc);
            }
        }

        return deduplicated.slice(0, topK);
    } catch (err) {
        console.error("❌ Reranking failed, returning original order:", err.message);
        return documents.slice(0, topK);
    }
}

/**
 * Hybrid retrieval combining MMR vector search in Qdrant and local BM25 keyword search.
 */
export async function hybridRetrieve(qdrantConfig, embeddings, collectionName, query, expandedQueries = []) {
    const queries = [query, ...expandedQueries];
    
    // 1. Vector Search using MMR via QdrantVectorStore
    const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
        ...qdrantConfig,
        collectionName,
    });

    const vectorCandidates = [];
    for (const q of queries) {
        try {
            // Priority 1: MMR search
            const results = await vectorStore.maxMarginalRelevanceSearch(q, {
                k: 15,
                fetchK: 40,
                lambda: 0.5
            });
            vectorCandidates.push(...results);
        } catch (e) {
            console.warn(`⚠️ MMR search failed for "${q}":`, e.message);
            // Fallback to standard similarity search if MMR errors
            const results = await vectorStore.similaritySearch(q, 15);
            vectorCandidates.push(...results);
        }
    }

    // 2. Fetch all points in the collection to build a local BM25 retriever
    const qdrantClient = new QdrantClient({
        url: qdrantConfig.url,
        ...(qdrantConfig.clientConfig?.api_key && {
            apiKey: qdrantConfig.clientConfig.api_key
        })
    });

    let bm25Candidates = [];
    try {
        const scrollRes = await qdrantClient.scroll(collectionName, {
            limit: 10000,
            with_payload: true,
            with_vector: false
        });

        const allDocs = scrollRes.points.map(pt => new Document({
            pageContent: pt.payload.page_content,
            metadata: pt.payload.metadata
        }));

        if (allDocs.length > 0) {
            // Build local BM25 index
            const bm25Retriever = await BM25Retriever.fromDocuments(allDocs, { k: 15 });
            
            for (const q of queries) {
                const results = await bm25Retriever._getRelevantDocuments(q);
                bm25Candidates.push(...results);
            }
        }
    } catch (e) {
        console.error("⚠️ Local BM25 search failed:", e.message);
    }

    // 3. Merge & Deduplicate candidates
    const allCandidates = [...vectorCandidates, ...bm25Candidates];
    const seen = new Set();
    const mergedDocs = [];

    for (const doc of allCandidates) {
        const uniqueId = doc.metadata?.parentId || doc.pageContent;
        if (!seen.has(uniqueId)) {
            seen.add(uniqueId);
            mergedDocs.push(doc);
        }
    }

    return mergedDocs;
}

/**
 * Validate response to ensure it is fully grounded in the retrieved context.
 * Returns the verified/corrected answer.
 */
export async function validateAnswer(contextText, generatedAnswer, googleApiKey) {
    try {
        const model = new ChatGoogleGenerativeAI({
            apiKey: googleApiKey,
            model: "gemini-2.5-flash",
            temperature: 0.1,
        });

        const prompt = `You are a RAG Answer Verification assistant. 
Review the retrieved context and verify if the generated answer is fully grounded in and supported by it. 
The generated answer MUST NOT contain assumptions, outside knowledge, or facts not present in the retrieved context.

Retrieved Context:
${contextText}

Generated Answer:
${generatedAnswer}

Is the generated answer fully grounded in the retrieved context? Respond in the following exact format:
1. If YES, respond exactly: YES
2. If NO, respond exactly: NO: [Grounded version of the answer, fully rewritten to be 100% faithful to the retrieved context. If context cannot support answering, output: "Based on the provided document, I cannot answer this question."]

Verification Output:`;

        const verification = await model.invoke(prompt);
        const text = verification.content.trim();

        if (text.startsWith("YES")) {
            console.log("✅ Generated answer successfully passed grounding validation.");
            return generatedAnswer;
        } else if (text.startsWith("NO:")) {
            const corrected = text.substring(3).trim();
            console.log("⚠️ Grounding validation failed. Corrected answer generated.");
            return corrected;
        }
        
        return generatedAnswer;
    } catch (e) {
        console.warn("⚠️ Grounding validation encountered an error, falling back to original answer:", e.message);
        return generatedAnswer;
    }
}
