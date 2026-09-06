import { useState, useEffect, useCallback, useRef } from "react";
import type {
  CapturedRequest,
  JsHookRecord,
  StorageSnapshot,
  AnalysisReport,
  ChatMessage,
  InteractionEvent,
  AiProgressEvent,
} from "@shared/types";
import { IPC_CHANNELS } from "@shared/types";
import { formatStatusLine } from "@shared/ai-progress";
import {
  findLatestConversationTokenUsage,
  type ConversationTokenUsage,
} from "@shared/token-estimate";

export interface UseCaptureState {
  requests: CapturedRequest[];
  hooks: JsHookRecord[];
  snapshots: StorageSnapshot[];
  reports: AnalysisReport[];
  interactions: InteractionEvent[];
  isAnalyzing: boolean;
  analysisError: string | null;
  streamingContent: string;
  /** 模型思考过程的流式增量，仅在分析 / 追问进行中有值 */
  streamingReasoning: string;
  selectedRequest: CapturedRequest | null;
  chatHistory: ChatMessage[];
  latestContextUsage: ConversationTokenUsage | null;
  isChatting: boolean;
  chatError: string | null;
}

interface UseCaptureReturn extends UseCaptureState {
  loadData: (sessionId: string) => Promise<void>;
  clearData: () => void;
  clearCaptureData: (sessionId: string) => Promise<void>;
  selectRequest: (request: CapturedRequest | null) => void;
  startAnalysis: (sessionId: string, purpose?: string, selectedSeqs?: number[], model?: string) => Promise<void>;
  cancelAnalysis: (sessionId: string) => Promise<void>;
  sendFollowUp: (sessionId: string, message: string) => Promise<void>;
  /** 用主进程返回的最新报告对象替换本地同 id 的报告（如补抽 Spec 之后） */
  replaceReport: (report: AnalysisReport) => void;
}

export const INITIAL_CAPTURE_STATE: UseCaptureState = {
  requests: [],
  hooks: [],
  snapshots: [],
  reports: [],
  interactions: [],
  isAnalyzing: false,
  analysisError: null,
  streamingContent: "",
  streamingReasoning: "",
  selectedRequest: null,
  chatHistory: [],
  latestContextUsage: null,
  isChatting: false,
  chatError: null,
};

export function prepareStateForAnalysis(prev: UseCaptureState): UseCaptureState {
  return {
    ...prev,
    reports: [],
    chatHistory: [],
    latestContextUsage: null,
    isAnalyzing: true,
    isChatting: false,
    analysisError: null,
    chatError: null,
    streamingContent: "",
    streamingReasoning: "",
  };
}

/**
 * 把一条进度事件合并进流式状态：text / status 进正文，reasoning 进思考区。
 */
export function applyProgressEvent(
  prev: Pick<UseCaptureState, "streamingContent" | "streamingReasoning">,
  event: AiProgressEvent,
): Pick<UseCaptureState, "streamingContent" | "streamingReasoning"> {
  switch (event.kind) {
    case "text":
      return { ...prev, streamingContent: prev.streamingContent + event.text };
    case "status":
      return { ...prev, streamingContent: prev.streamingContent + formatStatusLine(event.text) };
    case "reasoning":
      return { ...prev, streamingReasoning: prev.streamingReasoning + event.text };
    case "reset":
      return { ...prev, streamingContent: "", streamingReasoning: "" };
    default:
      return prev;
  }
}

export function useCapture(sessionId: string | null): UseCaptureReturn {
  const [state, setState] = useState<UseCaptureState>(INITIAL_CAPTURE_STATE);
  const sessionIdRef = useRef(sessionId);
  const conversationVersionRef = useRef(0);

  // Keep ref in sync for use in callbacks
  useEffect(() => {
    sessionIdRef.current = sessionId;
    conversationVersionRef.current += 1;
  }, [sessionId]);

  // Clear all data
  const clearData = useCallback(() => {
    conversationVersionRef.current += 1;
    setState(INITIAL_CAPTURE_STATE);
  }, []);

  // Clear all capture data from DB and reset local state
  const clearCaptureData = useCallback(async (sid: string) => {
    await window.electronAPI.clearCaptureData(sid);
    conversationVersionRef.current += 1;
    setState(INITIAL_CAPTURE_STATE);
  }, []);

  // Select a request for detail view
  const selectRequest = useCallback((request: CapturedRequest | null) => {
    setState((prev) => ({ ...prev, selectedRequest: request }));
  }, []);

  // Load all data for a session from main process
  const loadData = useCallback(async (sid: string) => {
    const conversationVersion = conversationVersionRef.current;
    try {
      const [requests, hooks, snapshots, reports, interactions, aiRequestLogs] = await Promise.all([
        window.electronAPI.getRequests(sid),
        window.electronAPI.getHooks(sid),
        window.electronAPI.getStorage(sid),
        window.electronAPI.getReports(sid),
        window.electronAPI.getInteractions(sid),
        window.electronAPI.getAiRequestLogs(sid),
      ]);
      const sortedReports = [...reports].sort((a, b) => b.created_at - a.created_at);
      const latestReport = sortedReports[0] ?? null;
      const latestContextUsage = findLatestConversationTokenUsage(aiRequestLogs, latestReport);

      // Restore chat history for the latest report.
      // 主进程负责生成 / 补建初始 [system, assistant] 两条，渲染层不再自己拼 prompt
      let chatHistory: ChatMessage[] = [];
      if (latestReport) {
        chatHistory = (await window.electronAPI.getChatMessages(latestReport.id)) as ChatMessage[];
      }

      // Only update if session hasn't changed while loading
      if (sessionIdRef.current === sid && conversationVersionRef.current === conversationVersion) {
        setState((prev) => ({
          ...prev,
          requests: requests.sort((a, b) => a.sequence - b.sequence),
          hooks: hooks.sort((a, b) => b.timestamp - a.timestamp),
          snapshots,
          reports: sortedReports,
          interactions: (interactions || []).sort((a, b) => a.sequence - b.sequence),
          chatHistory,
          latestContextUsage,
        }));
      }
    } catch (err) {
      console.error("Failed to load capture data:", err);
    }
  }, []);

  // Start AI analysis for a session
  const startAnalysis = useCallback(async (sid: string, purpose?: string, selectedSeqs?: number[], model?: string) => {
    const conversationVersion = conversationVersionRef.current + 1;
    conversationVersionRef.current = conversationVersion;
    setState(prepareStateForAnalysis);

    try {
      const report = await window.electronAPI.startAnalysis(sid, purpose, selectedSeqs, model);

      // 初始对话（system prompt + 报告）已由主进程生成并落库，这里只读回来
      const chatHistory = (await window.electronAPI.getChatMessages(report.id).catch(() => [])) as ChatMessage[];

      // Only update if session hasn't changed
      if (sessionIdRef.current === sid && conversationVersionRef.current === conversationVersion) {
        setState((prev) => ({
          ...prev,
          isAnalyzing: false,
          streamingContent: "",
          streamingReasoning: "",
          reports: [report, ...prev.reports],
          chatHistory: chatHistory.length > 0
            ? chatHistory
            : [{ role: 'assistant' as const, content: report.report_content }],
          latestContextUsage: null,
          chatError: null,
        }));
      }
    } catch (err) {
      console.error("Analysis failed:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      const isCancelled = errMsg.includes("Analysis cancelled") || errMsg.includes("aborted");
      if (sessionIdRef.current === sid && conversationVersionRef.current === conversationVersion) {
        setState((prev) => ({
          ...prev,
          isAnalyzing: false,
          streamingContent: "",
          streamingReasoning: "",
          analysisError: isCancelled ? null : errMsg,
        }));
      }
    }
  }, []);

  // Cancel an in-progress analysis
  const cancelAnalysis = useCallback(async (sid: string) => {
    conversationVersionRef.current += 1;
    await window.electronAPI.cancelAnalysis(sid);
    setState((prev) => ({
      ...prev,
      isAnalyzing: false,
      streamingContent: "",
      streamingReasoning: "",
      analysisError: null,
    }));
  }, []);

  const chatHistoryRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    chatHistoryRef.current = state.chatHistory;
  }, [state.chatHistory]);

  const replaceReport = useCallback((report: AnalysisReport) => {
    setState((prev) => ({
      ...prev,
      reports: prev.reports.map((existing) => (existing.id === report.id ? report : existing)),
    }));
  }, []);

  const sendFollowUp = useCallback(async (sid: string, message: string) => {
    const conversationVersion = conversationVersionRef.current;
    // Get the latest report ID for persisting chat messages
    let currentReportId = '';
    let currentReportScope: Pick<AnalysisReport, 'id' | 'created_at'> | null = null;
    setState((prev) => {
      if (prev.reports.length > 0) {
        currentReportId = prev.reports[0].id;
        currentReportScope = {
          id: prev.reports[0].id,
          created_at: prev.reports[0].created_at,
        };
      }
      return {
        ...prev,
        isChatting: true,
        chatError: null,
        streamingContent: "",
        streamingReasoning: "",
        chatHistory: [...prev.chatHistory, { role: 'user' as const, content: message }],
      };
    });

    try {
      const reply = await window.electronAPI.sendFollowUp(sid, currentReportId, chatHistoryRef.current, message);
      const latestContextUsage = await window.electronAPI.getAiRequestLogs(sid)
        .then((logs) => findLatestConversationTokenUsage(logs, currentReportScope))
        .catch(() => null);

      if (sessionIdRef.current === sid && conversationVersionRef.current === conversationVersion) {
        setState((prev) => ({
          ...prev,
          isChatting: false,
          streamingContent: "",
          streamingReasoning: "",
          chatHistory: [...prev.chatHistory, { role: 'assistant' as const, content: reply }],
          latestContextUsage: latestContextUsage ?? prev.latestContextUsage,
        }));
      }
    } catch (err) {
      console.error("Follow-up chat failed:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (sessionIdRef.current === sid && conversationVersionRef.current === conversationVersion) {
        setState((prev) => ({
          ...prev,
          isChatting: false,
          streamingContent: "",
          streamingReasoning: "",
          chatError: errMsg,
          // Roll back the optimistically added user message on failure
          chatHistory: prev.chatHistory.length > 0 && prev.chatHistory[prev.chatHistory.length - 1]?.role === 'user'
            ? prev.chatHistory.slice(0, -1)
            : prev.chatHistory,
        }));
      }
    }
  }, []);

  // Set up IPC event listeners for real-time updates
  useEffect(() => {
    if (!sessionId) {
      clearData();
      return;
    }

    // Load initial data
    loadData(sessionId);

    // --- Batched request/hook/storage buffering for performance ---
    const requestBuffer: CapturedRequest[] = [];
    const hookBuffer: JsHookRecord[] = [];
    const storageBuffer: StorageSnapshot[] = [];
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    const flush = () => {
      if (requestBuffer.length > 0 || hookBuffer.length > 0 || storageBuffer.length > 0) {
        const reqBatch = requestBuffer.splice(0);
        const hookBatch = hookBuffer.splice(0);
        const storageBatch = storageBuffer.splice(0);
        setState((prev) => ({
          ...prev,
          requests: reqBatch.length > 0 ? [...prev.requests, ...reqBatch] : prev.requests,
          hooks: hookBatch.length > 0 ? [...hookBatch, ...prev.hooks] : prev.hooks,
          snapshots: storageBatch.length > 0 ? [...prev.snapshots, ...storageBatch] : prev.snapshots,
        }));
      }
    };

    flushTimer = setInterval(flush, 300);

    // Listen for new captured requests — buffer instead of immediate setState
    const handleRequest = (data: CapturedRequest) => {
      if (data.session_id !== sessionIdRef.current) return;
      requestBuffer.push(data);
    };

    // Listen for new hook records — buffer instead of immediate setState
    const handleHook = (data: JsHookRecord) => {
      if (data.session_id !== sessionIdRef.current) return;
      hookBuffer.push(data);
    };

    // Listen for new storage snapshots — buffer instead of immediate setState
    const handleStorage = (data: StorageSnapshot) => {
      if (data.session_id !== sessionIdRef.current) return;
      storageBuffer.push(data);
    };

    // Listen for analysis progress (typed streaming events)
    const handleAnalysisProgress = (event: AiProgressEvent) => {
      setState((prev) => {
        if (!prev.isAnalyzing && !prev.isChatting) return prev;
        return { ...prev, ...applyProgressEvent(prev, event) };
      });
    };

    window.electronAPI.onRequestCaptured(handleRequest);
    window.electronAPI.onHookCaptured(handleHook);
    window.electronAPI.onStorageCaptured(handleStorage);
    window.electronAPI.onAnalysisProgress(handleAnalysisProgress);

    // Listen for interaction recording events (debounced to avoid excessive DB queries)
    let interactionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    window.electronAPI.onInteractionRecorded(() => {
      if (interactionDebounceTimer) clearTimeout(interactionDebounceTimer);
      interactionDebounceTimer = setTimeout(() => {
        if (sessionIdRef.current) {
          window.electronAPI.getInteractions(sessionIdRef.current).then((interactions: InteractionEvent[]) => {
            setState((prev) => ({
              ...prev,
              interactions: (interactions || []).sort((a, b) => a.sequence - b.sequence),
            }));
          }).catch(() => {});
        }
      }, 500);
    });

    // Cleanup listeners on unmount or session change
    return () => {
      if (flushTimer) clearInterval(flushTimer);
      if (interactionDebounceTimer) clearTimeout(interactionDebounceTimer);
      flush(); // flush remaining buffered items
      window.electronAPI.removeAllListeners(IPC_CHANNELS.CAPTURE_REQUEST);
      window.electronAPI.removeAllListeners(IPC_CHANNELS.CAPTURE_HOOK);
      window.electronAPI.removeAllListeners(IPC_CHANNELS.CAPTURE_STORAGE);
      window.electronAPI.removeAllListeners(IPC_CHANNELS.AI_PROGRESS);
      window.electronAPI.removeAllListeners('interaction:recorded');
    };
  }, [sessionId, loadData, clearData]);

  return {
    ...state,
    loadData,
    clearData,
    clearCaptureData,
    selectRequest,
    startAnalysis,
    cancelAnalysis,
    sendFollowUp,
    replaceReport,
  };
}

export default useCapture;
