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
        
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        const splits = await splitter.splitDocuments(docs);

        const embeddings = new GoogleGenerativeAIEmbeddings({
            apiKey: process.env.GOOGLE_API_KEY,
            model: "gemini-embedding-001",
        });

        console.log(`📄 Processing "${req.file.originalname}" — ${splits.length} chunks`);
        
        // Store embeddings in Qdrant (Docker)
        await QdrantVectorStore.fromDocuments(splits, embeddings, {
            url: process.env.QDRANT_URL || "http://localhost:6333",
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
        const { document_id, message } = req.body;

        if (!document_id || !message) {
            return res.status(400).json({ error: "document_id and message are required" });
        }

        const embeddings = new GoogleGenerativeAIEmbeddings({
            apiKey: process.env.GOOGLE_API_KEY,
            model: "gemini-embedding-001",
        });

        const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
            url: process.env.QDRANT_URL || "http://localhost:6333",
            collectionName: document_id,
        });

        const results = await vectorStore.similaritySearch(message, 5);
        const context = results.map(r => r.pageContent).join("\n\n");

        console.log(`🔍 Retrieved ${results.length} chunks for: "${message.substring(0, 50)}..."`);

        const prompt = `You are a highly intelligent, grounded assistant (like Google NotebookLM). 
Use the following pieces of retrieved context to answer the user's question. 
If the answer is not contained within the context, clearly state that you cannot answer based on the provided document. 
Do not use outside knowledge or hallucinate information. 
Keep the answer concise, well-formatted, and helpful.

Context:
${context}

User Question: ${message}
Answer:`;

        // Try gemini-2.5-flash first, fall back to gemini-2.0-flash-lite
        const modelsToTry = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];
        let lastError = null;

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
                
                console.log(`✅ Response generated using ${modelName}`);
                return res.json({ answer: response.content });
            } catch (err) {
                console.log(`⚠️ Model ${modelName} failed: ${err.message?.substring(0, 100)}`);
                lastError = err;
            }
        }

        // If all models failed
        throw lastError;

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
