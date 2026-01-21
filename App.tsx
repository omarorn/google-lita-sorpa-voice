import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionState } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audio';
import { Visualizer } from './components/Visualizer';

// Types
type LogMessage = {
  type: 'user' | 'model' | 'system';
  text: string;
  timestamp: number;
};

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

export default function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [volume, setVolume] = useState(0); // For visualizer (0-1)
  
  // Refs for audio handling to avoid re-renders
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null); // Type 'any' used because Session type isn't exported easily yet

  // Scroll to bottom of logs
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (type: 'user' | 'model' | 'system', text: string) => {
    setLogs(prev => [...prev, { type, text, timestamp: Date.now() }]);
  };

  const cleanup = useCallback(() => {
    // Close session
    if (sessionRef.current) {
      // Assuming session has a close method, though API might only have disconnect on client
      // The client library handles closure via calling disconnect usually, but here we just drop ref
      sessionRef.current = null;
    }

    // Stop microphone
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Close contexts
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    // Stop playing sources
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    sourcesRef.current.clear();
    
    scriptProcessorRef.current = null;
    outputNodeRef.current = null;
    nextStartTimeRef.current = 0;
    setVolume(0);
  }, []);

  const handleConnect = async () => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      addLog('system', 'Initializing audio devices...');

      // 1. Initialize Audio Contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);
      outputNodeRef.current = outputNode;

      // 2. Get Microphone Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // 3. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      addLog('system', 'Connecting to Gemini Live API...');

      // 4. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }, // Friendly voice
          },
          systemInstruction: `You are a helpful, friendly, and concise waste management expert for 'Litla Gámaleigan'. 
          Your goal is to help users sort their garbage into the correct bins. 
          Use spoken language styles (short sentences, natural pauses).
          Valid categories are: Plastic, Paper, Metal, Glass, Organic, and General Waste.
          If unsure, ask for clarification.`,
        },
        callbacks: {
          onopen: async () => {
            addLog('system', 'Connection established! Start talking.');
            setConnectionState(ConnectionState.CONNECTED);

            // Start Audio Processing Pipeline
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Simple volume meter for visualizer
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVolume(v => Math.max(rms * 5, v * 0.9)); // Smooth decay

              const pcmBlob = createBlob(inputData);
              
              // Send data when session is ready
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputNodeRef.current) {
              const ctx = outputAudioContextRef.current;
              
              // Sync start time
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              const audioBuffer = await decodeAudioData(
                decode(base64Audio),
                ctx,
                24000,
                1
              );

              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNodeRef.current);
              
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              
              // Visualizer feedback for output
              // Note: Accurate output viz requires AnalyserNode on output, simpler strictly mapped here
              setVolume(0.5); // Pulse for AI talking
            }

            // Handle Turn Complete (Logging)
            if (message.serverContent?.turnComplete) {
              addLog('system', 'Model finished response.');
              setVolume(0); // Reset volume when done
            }
            
            // Handle Interruption
            if (message.serverContent?.interrupted) {
               addLog('system', 'Interrupted.');
               sourcesRef.current.forEach(s => s.stop());
               sourcesRef.current.clear();
               nextStartTimeRef.current = 0;
            }
          },
          onclose: () => {
            addLog('system', 'Connection closed.');
            setConnectionState(ConnectionState.DISCONNECTED);
            cleanup();
          },
          onerror: (err) => {
            console.error(err);
            addLog('system', 'Error occurred. See console.');
            setConnectionState(ConnectionState.ERROR);
            cleanup();
          }
        }
      });

      // Save session ref
      sessionRef.current = await sessionPromise;

    } catch (error) {
      console.error('Connection failed', error);
      addLog('system', 'Failed to connect.');
      setConnectionState(ConnectionState.ERROR);
      cleanup();
    }
  };

  const handleDisconnect = () => {
    // There isn't a direct "close" on the session object in the snippet, 
    // usually we just stop sending audio and rely on component unmount or 
    // closing the context to sever the flow.
    // However, cleanups call closes context which kills the websocket usually 
    // if implemented via native streams, but here we just manually cleanup.
    cleanup();
    setConnectionState(ConnectionState.DISCONNECTED);
    addLog('system', 'Session ended by user.');
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      
      {/* Background Decor */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none opacity-20">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500 rounded-full blur-3xl filter mix-blend-multiply animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-green-500 rounded-full blur-3xl filter mix-blend-multiply animate-pulse" style={{ animationDelay: '2s'}}></div>
      </div>

      <main className="relative z-10 w-full max-w-lg bg-slate-800/50 backdrop-blur-xl border border-slate-700 rounded-3xl p-8 shadow-2xl flex flex-col gap-6">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-700/50 border border-slate-600 text-xs font-medium text-slate-300">
            <span className={`w-2 h-2 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-green-400 animate-pulse' : 'bg-slate-400'}`}></span>
            {connectionState === ConnectionState.CONNECTED ? 'Live Session Active' : 'Ready to Connect'}
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Litla Sorpa</h1>
          <p className="text-slate-400">Ask me where to throw your trash.</p>
        </div>

        {/* Visualizer Area */}
        <div className="relative h-64 w-full flex items-center justify-center bg-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden shadow-inner">
          <Visualizer 
            isPlaying={connectionState === ConnectionState.CONNECTED} 
            volume={volume} 
          />
          
          {connectionState !== ConnectionState.CONNECTED && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 font-mono text-sm">
              Waiting for input...
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex justify-center gap-4">
          {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
            <button
              onClick={handleConnect}
              className="group relative inline-flex items-center justify-center px-8 py-4 font-semibold text-white transition-all duration-200 bg-blue-600 rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-600 focus:ring-offset-slate-900"
            >
              <span className="absolute inset-0 w-full h-full -mt-1 rounded-lg opacity-30 bg-gradient-to-b from-transparent via-transparent to-black"></span>
              <span className="relative flex items-center gap-3">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Start Conversation
              </span>
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              className="inline-flex items-center justify-center px-8 py-4 font-semibold text-white transition-all duration-200 bg-red-500 rounded-full hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-600 focus:ring-offset-slate-900 shadow-lg shadow-red-500/30"
            >
              <svg className="w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              End Session
            </button>
          )}
        </div>

        {/* Hints */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-700/30 p-3 rounded-xl border border-slate-700/50 text-center">
            <span className="block text-xs text-slate-500 uppercase tracking-wider mb-1">Try asking</span>
            <p className="text-sm text-slate-300">"Where does this pizza box go?"</p>
          </div>
          <div className="bg-slate-700/30 p-3 rounded-xl border border-slate-700/50 text-center">
            <span className="block text-xs text-slate-500 uppercase tracking-wider mb-1">Try asking</span>
            <p className="text-sm text-slate-300">"Is this glass bottle recyclable?"</p>
          </div>
        </div>
      </main>

      {/* Logs (Hidden mostly, but useful context) */}
      <div className="fixed bottom-4 right-4 w-64 h-32 bg-slate-900/90 border border-slate-700 rounded-lg p-2 overflow-y-auto text-xs font-mono text-slate-400 opacity-50 hover:opacity-100 transition-opacity">
        {logs.map((log, i) => (
          <div key={i} className="mb-1">
            <span className={log.type === 'system' ? 'text-blue-400' : 'text-green-400'}>[{log.type}]</span> {log.text}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}