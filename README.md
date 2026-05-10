# 📓 NotebookLM Clone — RAG Agent

A Google NotebookLM-inspired application that lets you upload documents (PDF/TXT) and have an AI-powered conversation grounded in the document's content using **Retrieval-Augmented Generation (RAG)**.

## 🏗️ Architecture

| Layer | Technology |
|-------|-----------|
| **Frontend** | React + Vite |
| **Backend** | Node.js + Express |
| **Embeddings** | Google Gemini (`gemini-embedding-001`) |
| **LLM** | Google Gemini (`gemini-2.5-flash`) |
| **Vector DB** | Qdrant (Docker) |
| **RAG Framework** | LangChain.js |

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v20+)
- **Docker** (for Qdrant vector database)
- **Google Gemini API Key** — [Get one here](https://aistudio.google.com/apikey)

### 1. Clone the Repository
```bash
git clone https://github.com/YOUR_USERNAME/RAG_Agent.git
cd RAG_Agent
```

### 2. Start Qdrant (Docker)
```bash
docker run -d -p 6333:6333 -p 6334:6334 \
    -v $(pwd)/qdrant_storage:/qdrant/storage:z \
    qdrant/qdrant
```

### 3. Setup Backend
```bash
cd backend-node
npm install
```

Create a `.env` file:
```env
GOOGLE_API_KEY=your_gemini_api_key_here
```

Start the backend:
```bash
npm start
```

### 4. Setup Frontend
```bash
cd frontend
npm install
npm run dev
```

### 5. Open the App
Navigate to **http://localhost:5173** in your browser.

## 📖 How It Works

1. **Upload** a PDF or TXT document
2. The backend **chunks** the document (1000 chars, 200 overlap)
3. Each chunk is **embedded** using Google Gemini Embeddings
4. Embeddings are stored in **Qdrant** vector database
5. When you ask a question, the system **retrieves** the most relevant chunks
6. The LLM generates a **grounded answer** using only the retrieved context

## 📁 Project Structure
```
RAG_Agent/
├── backend-node/       # Node.js + Express backend
│   ├── server.js       # Main server with RAG pipeline
│   ├── package.json
│   └── .env            # API keys (not committed)
├── frontend/           # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx     # Main chat UI
│   │   └── App.css     # Styles
│   └── package.json
├── .gitignore
└── README.md
```

## ⚠️ Important Notes
- Never commit your `.env` file — it contains your API key
- Qdrant must be running via Docker before starting the backend
- The free tier of Gemini API has rate limits — the backend includes automatic retry logic
