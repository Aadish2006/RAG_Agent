import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { UploadCloud, MessageSquare, Send, FileText, Loader2, File } from 'lucide-react';

function App() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [documentId, setDocumentId] = useState(null);
  const [documentName, setDocumentName] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      // Assuming backend is running on localhost:8000
      const response = await axios.post('http://localhost:8000/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      setDocumentId(response.data.document_id);
      setDocumentName(response.data.filename);
      setMessages([{ role: 'assistant', content: `Document "${response.data.filename}" processed successfully. You can now ask questions about it.` }]);
    } catch (error) {
      console.error("Error uploading file:", error);
      alert(error.response?.data?.detail || "Error uploading file. Make sure GEMINI_API_KEY is set in backend.");
    } finally {
      setUploading(false);
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || !documentId) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const response = await axios.post('http://localhost:8000/chat', {
        document_id: documentId,
        message: userMessage,
      });

      setMessages((prev) => [...prev, { role: 'assistant', content: response.data.answer }]);
    } catch (error) {
      console.error("Error sending message:", error);
      setMessages((prev) => [...prev, { role: 'assistant', content: "Sorry, I encountered an error. Please try again." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center shadow-sm">
        <div className="flex items-center gap-2 text-indigo-600">
          <MessageSquare size={24} className="fill-indigo-600 text-white" />
          <h1 className="text-xl font-semibold text-slate-800 tracking-tight">NotebookLM <span className="text-indigo-600">Clone</span></h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 md:grid-cols-3 gap-6 h-[calc(100vh-73px)]">
        
        {/* Left Sidebar - Upload */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col h-full md:col-span-1">
          <h2 className="text-lg font-medium text-slate-800 mb-4 flex items-center gap-2">
            <FileText size={20} className="text-slate-500" />
            Source Document
          </h2>
          
          {!documentId ? (
            <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 p-6 text-center hover:bg-slate-100 transition-colors">
              <UploadCloud size={48} className="text-slate-400 mb-4" />
              <p className="text-sm text-slate-600 mb-4">Upload a PDF or TXT file to start asking questions.</p>
              
              <input
                type="file"
                id="file-upload"
                className="hidden"
                accept=".pdf,.txt"
                onChange={handleFileChange}
              />
              <label
                htmlFor="file-upload"
                className="cursor-pointer bg-white border border-slate-300 text-slate-700 font-medium py-2 px-4 rounded-lg hover:bg-slate-50 transition-colors mb-4"
              >
                Choose File
              </label>
              
              {file && (
                <div className="w-full flex items-center gap-2 bg-indigo-50 text-indigo-700 p-3 rounded-lg text-sm truncate mb-4">
                  <File size={16} className="shrink-0" />
                  <span className="truncate">{file.name}</span>
                </div>
              )}

              <button
                onClick={handleUpload}
                disabled={!file || uploading}
                className="w-full bg-indigo-600 text-white font-medium py-2.5 px-4 rounded-lg hover:bg-indigo-700 transition-colors disabled:bg-indigo-300 flex justify-center items-center gap-2"
              >
                {uploading ? (
                  <><Loader2 size={18} className="animate-spin" /> Uploading & Processing...</>
                ) : (
                  "Process Document"
                )}
              </button>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <div className="bg-green-50 border border-green-200 text-green-800 rounded-xl p-4 flex items-start gap-3">
                <FileText size={24} className="text-green-600 shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-medium text-green-900 line-clamp-1">{documentName}</h3>
                  <p className="text-xs text-green-700 mt-1">Ready for questions</p>
                </div>
              </div>
              
              <div className="mt-auto">
                <button
                  onClick={() => {
                    setDocumentId(null);
                    setFile(null);
                    setMessages([]);
                  }}
                  className="w-full bg-white border border-slate-300 text-slate-700 font-medium py-2 px-4 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Upload New Document
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Area - Chat */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full md:col-span-2 overflow-hidden">
          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <MessageSquare size={48} className="mb-4 opacity-50" />
                <p>Upload a document to start chatting</p>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-5 py-3.5 shadow-sm ${
                    msg.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none'
                  }`}>
                    <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                  </div>
                </div>
              ))
            )}
            
            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-none px-5 py-4 shadow-sm flex items-center gap-2">
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce"></div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Chat Input */}
          <div className="p-4 border-t border-slate-200 bg-white">
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={documentId ? "Ask a question about the document..." : "Upload a document first..."}
                disabled={!documentId || loading}
                className="flex-1 bg-slate-100 border-transparent focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 rounded-xl px-4 py-3 outline-none transition-all disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!documentId || loading || !input.trim()}
                className="bg-indigo-600 text-white p-3 rounded-xl hover:bg-indigo-700 transition-colors disabled:bg-indigo-300 disabled:cursor-not-allowed flex items-center justify-center w-12 shrink-0"
              >
                <Send size={20} className={input.trim() && !loading ? "translate-x-0.5 -translate-y-0.5 transition-transform" : ""} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
