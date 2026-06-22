import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { QdrantVectorStore } from "@langchain/qdrant";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from "@langchain/core/documents";
import { parentChildSplit, queryExpansion, rerank, hybridRetrieve, validateAnswer } from './ragHelpers.js';

dotenv.config();

if (!process.env.GOOGLE_API_KEY) {
    console.error("FATAL: GOOGLE_API_KEY is not set in .env file");
    process.exit(1);
}

console.log("✅ GOOGLE_API_KEY loaded successfully");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

const port = 8000;

// Qdrant connection config (works for both local Docker and Qdrant Cloud)
const qdrantConfig = {
    url: process.env.QDRANT_URL || "http://localhost:6333",
    ...(process.env.QDRANT_API_KEY && {
        clientConfig: {
            api_key: process.env.QDRANT_API_KEY,
        },
    }),
};

console.log(`📦 Qdrant target: ${qdrantConfig.url}`);

// Helper: retry with exponential backoff for rate limits
async function retryWithBackoff(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('Quota exceeded');
            if (isRateLimit && i < maxRetries - 1) {
                const waitTime = Math.pow(2, i + 1) * 1000; // 2s, 4s, 8s
                console.log(`⏳ Rate limited. Waiting ${waitTime / 1000}s before retry ${i + 2}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error;
            }
        }
    }
}

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file uploaded');

        const documentId = uuidv4();
        const filePath = req.file.path;
        const extension = path.extname(req.file.originalname).toLowerCase();

        let docs = [];
        if (extension === '.pdf') {
            const loader = new PDFLoader(filePath);
            docs = await loader.load();
        } else {
            const text = await fs.promises.readFile(filePath, "utf8");
            docs = [new Document({ pageContent: text, metadata: { source: req.file.originalname } })];
        }
        
        const splits = await parentChildSplit(docs, req.file.originalname);

        const embeddings = new GoogleGenerativeAIEmbeddings({
            apiKey: process.env.GOOGLE_API_KEY,
            model: "gemini-embedding-001",
        });

        console.log(`📄 Processing "${req.file.originalname}" — ${splits.length} chunks`);
        
        // Store embeddings in Qdrant
        await QdrantVectorStore.fromDocuments(splits, embeddings, {
            ...qdrantConfig,
            collectionName: documentId,
        });
        
        console.log(`✅ Document indexed in Qdrant: ${documentId}`);

        res.json({ document_id: documentId, filename: req.file.originalname, message: "Document processed successfully" });

    } catch (error) {
        console.error("❌ Error during upload:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { document_id, message, history = [] } = req.body;

        if (!document_id || !message) {
            return res.status(400).json({ error: "document_id and message are required" });
        }

        console.log(`💬 Request received for document ${document_id}: "${message.substring(0, 50)}..." with history of ${history.length} messages`);

        // 1. Query Condensation
        let searchPhrase = message;
        if (history && history.length > 0) {
            try {
                const condensationModel = new ChatGoogleGenerativeAI({
                    apiKey: process.env.GOOGLE_API_KEY,
                    model: "gemini-2.5-flash",
                    temperature: 0.1,
                });
                
                const historyText = history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join("\n");
                const condensePrompt = `Given the following conversation history and a follow-up question, rephrase the follow-up question to be a self-contained query. If the question is already self-contained, return it as-is. Do not answer it.

Conversation History:
${historyText}

Follow-up Question: ${message}
Self-contained query:`;

                const condensationRes = await condensationModel.invoke(condensePrompt);
                searchPhrase = condensationRes.content.trim();
                console.log(`🔄 Condensed query from history: "${searchPhrase}"`);
            } catch (err) {
                console.warn("⚠️ Query condensation failed, using original message:", err.message);
            }
        }

        // 2. Query Expansion
        const expandedQueries = await queryExpansion(searchPhrase, process.env.GOOGLE_API_KEY);
        if (expandedQueries.length > 0) {
            console.log(`🔍 Expanded queries:`, expandedQueries);
        }

        // 3. Hybrid Retrieval (MMR + BM25)
        const embeddings = new GoogleGenerativeAIEmbeddings({
            apiKey: process.env.GOOGLE_API_KEY,
            model: "gemini-embedding-001",
        });

        const retrievedDocs = await hybridRetrieve(
            qdrantConfig,
            embeddings,
            document_id,
            searchPhrase,
            expandedQueries
        );
        console.log(`🔍 Hybrid search retrieved ${retrievedDocs.length} candidates`);

        // 4. BGE Reranker
        const topDocs = await rerank(searchPhrase, retrievedDocs, 5);
        console.log(`✨ Reranker selected top ${topDocs.length} documents`);

        // 5. Parent Context Promotion and Citation Mapping
        const citations = [];
        const contextPieces = [];

        for (const doc of topDocs) {
            const text = doc.metadata.parentText || doc.pageContent;
            contextPieces.push(text);

            citations.push({
                fileName: doc.metadata.source || "Unknown Document",
                pageNumber: doc.metadata.pageNumber || 1,
                sectionName: doc.metadata.section || "General",
                snippet: doc.pageContent.substring(0, 150) + "..."
            });
        }

        const context = contextPieces.join("\n\n");

        // 6. Format context with citations for LLM prompt
        const historyPrompt = history.length > 0 
            ? `Conversation History:\n${history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join("\n")}\n` 
            : "";

        const contextWithCitations = topDocs.map((doc, idx) => {
            const text = doc.metadata.parentText || doc.pageContent;
            const sourceFile = doc.metadata.source || "Unknown Document";
            const pageNum = doc.metadata.pageNumber || 1;
            const section = doc.metadata.section || "General";
            return `[Document ${idx + 1}] (Source: ${sourceFile}, Page: ${pageNum}, Section: ${section})
Content: ${text}`;
        }).join("\n\n");

        const prompt = `You are a highly intelligent, grounded assistant (like Google NotebookLM).
Use the following retrieved context documents to answer the user's question. 

For each statement you make that is derived from a document, you must cite the document number (e.g. [1], [2]) at the end of the sentence or statement.
If the answer cannot be found in the context documents, state: "Based on the provided document, I cannot answer this question." Do not use outside knowledge or make assumptions.

${historyPrompt}

Retrieved Context Documents:
${contextWithCitations}

User Question: ${message}
Answer (with inline citations like [1] where applicable):`;

        // 7. Model fallback execution
        const modelsToTry = ["gemini-2.5-flash", "gemini-2.0-flash"];
        let lastError = null;
        let generatedContent = "";
        let successfulModel = "";

        for (const modelName of modelsToTry) {
            try {
                const response = await retryWithBackoff(async () => {
                    const model = new ChatGoogleGenerativeAI({
                        apiKey: process.env.GOOGLE_API_KEY,
                        model: modelName,
                        temperature: 0.2,
                    });
                    return await model.invoke(prompt);
                });
                
                generatedContent = response.content;
                successfulModel = modelName;
                console.log(`✅ Response generated using ${modelName}`);
                break;
            } catch (err) {
                console.log(`⚠️ Model ${modelName} failed: ${err.message?.substring(0, 100)}`);
                lastError = err;
            }
        }

        if (!generatedContent) {
            throw lastError || new Error("Failed to generate response from all models");
        }

        // 8. Grounding Validation
        const finalAnswer = await validateAnswer(context, generatedContent, process.env.GOOGLE_API_KEY);

        // 9. Format response payload & append fallback citations display
        let answerWithCitationsText = finalAnswer;
        if (citations.length > 0) {
            const uniqueCitations = [];
            const seenCitations = new Set();
            for (const c of citations) {
                const key = `${c.fileName}-${c.pageNumber}-${c.sectionName}`;
                if (!seenCitations.has(key)) {
                    seenCitations.add(key);
                    uniqueCitations.push(c);
                }
            }

            answerWithCitationsText += "\n\n**Sources:**\n" + uniqueCitations.map((c, idx) => {
                return `* [${idx + 1}] \`${c.fileName}\` (Page ${c.pageNumber}, Section: *${c.sectionName}*)`;
            }).join("\n");
        }

        return res.json({ 
            answer: answerWithCitationsText, 
            citations: citations,
            model: successfulModel
        });

    } catch (error) {
        console.error("❌ Error during chat:", error.message);
        
        if (error.message?.includes('Quota exceeded') || error.message?.includes('429')) {
            res.status(429).json({ 
                error: "API rate limit reached. Please wait a minute and try again.",
                retryable: true
            });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(port, () => {
    console.log(`🚀 Node.js RAG server (Qdrant + Docker) running at http://localhost:${port}`);
});
